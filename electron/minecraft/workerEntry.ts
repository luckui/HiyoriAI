import { randomUUID } from 'node:crypto';
import type {
  MinecraftActionInstruction,
  MinecraftActionResult,
  MinecraftCommand,
  MinecraftEnvironmentSnapshot,
  MinecraftRuntimeEvent,
  MinecraftStatus,
  MinecraftWorkerMessage,
} from './protocol';
import type {
  MinecraftBotAdapter,
  MinecraftConnectionOptions,
  MinecraftDeathEvent,
  MinecraftOxygenEmergency,
  MinecraftSafetyRecovery,
} from './actions/types';
import type { MinecraftEmbodimentRuntime } from './embodimentRuntime';

export interface WorkerController {
  connect(payload: any): Promise<unknown>;
  disconnect(): Promise<unknown>;
  status(): unknown;
  snapshot(): Promise<unknown>;
  say(payload: any): Promise<unknown>;
  executeAction(payload: MinecraftActionInstruction): Promise<unknown>;
  cancelAction(actionId: string): Promise<unknown>;
  follow(payload: any): Promise<unknown>;
  stop(): Promise<unknown>;
  taskRelease(): Promise<unknown>;
}

export type WorkerDispatch = ((command: MinecraftCommand) => Promise<void>) & {
  parentDisconnected(): Promise<void>;
};

export function createWorkerDispatcher(
  controller: WorkerController,
  send: (message: MinecraftWorkerMessage) => void,
): WorkerDispatch {
  let parentClosed = false;

  const dispatch = async (command: MinecraftCommand): Promise<void> => {
    try {
      const data = await runCommand(controller, command);
      send({ type: 'response', id: command.id, ok: true, data });
    } catch (error) {
      send({
        type: 'response',
        id: command.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return Object.assign(dispatch, {
    async parentDisconnected(): Promise<void> {
      if (parentClosed) return;
      parentClosed = true;
      await controller.disconnect();
    },
  });
}

async function runCommand(
  controller: WorkerController,
  command: MinecraftCommand,
): Promise<unknown> {
  switch (command.action) {
    case 'connect':
      return controller.connect(command.payload);
    case 'disconnect':
      return controller.disconnect();
    case 'status':
      return controller.status();
    case 'snapshot':
      return controller.snapshot();
    case 'say':
      return controller.say((command.payload as { message: string }).message);
    case 'execute-action':
      return controller.executeAction(command.payload as MinecraftActionInstruction);
    case 'cancel-action':
      return controller.cancelAction((command.payload as { actionId: string }).actionId);
    case 'follow':
      return controller.follow(command.payload);
    case 'stop':
      return controller.stop();
    case 'task-release':
      return controller.taskRelease();
    default:
      throw new Error(`Unsupported Minecraft worker action: ${command.action}`);
  }
}

async function startWorker(): Promise<void> {
  const [{ MinecraftEmbodimentRuntime }, { createMineflayerAdapter }] =
    await Promise.all([import('./embodimentRuntime'), import('./mineflayerAdapter')]);
  const send = (message: MinecraftWorkerMessage) => process.send?.(message);
  const emitLog = (level: 'info' | 'warn' | 'error', message: string): void => {
    send({ type: 'event', event: { kind: 'log', level, message } });
  };
  const memoryStats = (): string => {
    const mem = process.memoryUsage();
    return `rss=${Math.round(mem.rss / 1048576)}MB heapUsed=${Math.round(mem.heapUsed / 1048576)}MB heapTotal=${Math.round(mem.heapTotal / 1048576)}MB external=${Math.round(mem.external / 1048576)}MB uptime=${Math.round(process.uptime())}s`;
  };
  process.on('uncaughtException', (error) => {
    emitLog('error', `[worker] uncaughtException: ${error?.stack ?? error}`);
    setTimeout(() => process.exit(1), 100);
  });
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    emitLog('warn', `[worker] unhandledRejection: ${detail}`);
  });
  setInterval(() => {
    emitLog('info', `[worker] heartbeat mem ${memoryStats()}`);
  }, 60_000);
  emitLog('info', `[worker] started pid=${process.pid} mem ${memoryStats()}`);
  const adapter = createMineflayerAdapter((event) =>
    send({ type: 'event', event }),
  );
  const runtime = new MinecraftEmbodimentRuntime({ adapter });
  const controller = createRuntimeWorkerController(adapter, runtime, (event) => {
    send({ type: 'event', event });
  });
  const dispatch = createWorkerDispatcher(controller, send);

  process.on('message', (message: MinecraftCommand) => void dispatch(message));
  process.once('disconnect', () => {
    void dispatch.parentDisconnected().finally(() => process.exit(0));
  });
}

if (process.env.HIYORI_MINECRAFT_WORKER === '1') {
  void startWorker();
}

export function createRuntimeWorkerController(
  adapter: MinecraftBotAdapter,
  runtime: MinecraftEmbodimentRuntime,
  emit: (event: MinecraftRuntimeEvent) => void,
): WorkerController {
  let foodShortageActive = false;
  let ownerPlayer: string | undefined;
  let followEnabled = true;
  let currentAction: MinecraftEnvironmentSnapshot['action'];
  let taskActive = false;
  let followBlocked = false;
  let oxygenRecovery: {
    actionId?: string;
    promise: Promise<MinecraftSafetyRecovery>;
  } | undefined;

  const setCurrentAction = (instruction: MinecraftActionInstruction): void => {
    currentAction = {
      id: instruction.id,
      name: instruction.name,
      state: 'running',
      args: { ...instruction.args },
    };
    emit({
      kind: 'log',
      level: 'info',
      message: `[action-state] current=${instruction.name} id=${instruction.id} args=${JSON.stringify(instruction.args)}`,
    });
  };

  const hasForegroundAction = (): boolean => Boolean(
    currentAction && currentAction.name !== 'follow_player',
  );

  const resumeFollowing = async (): Promise<void> => {
    if (taskActive) {
      currentAction = undefined;
      emit({ kind: 'log', level: 'info', message: '[follow-state] task owns body; follow suspended' });
      return;
    }
    if (!followEnabled || !ownerPlayer) {
      currentAction = undefined;
      emit({
        kind: 'log',
        level: 'info',
        message: `[action-state] current=none; default follow ${followEnabled ? 'has no owner' : 'disabled'}`,
      });
      return;
    }
    if (currentAction?.name === 'follow_player' && currentAction.args.player === ownerPlayer) {
      return;
    }
    try {
      const before = safeOwnerObservation(adapter, ownerPlayer);
      emit({
        kind: 'log',
        level: 'info',
        message: `[follow-state] restoring player=${ownerPlayer} visible=${before.owner?.visible ?? false} distance=${formatDebugDistance(before.owner?.distance)}`,
      });
      await adapter.startFollowing(ownerPlayer);
      followBlocked = false;
      currentAction = {
        id: randomUUID(),
        name: 'follow_player',
        state: 'running',
        args: { player: ownerPlayer },
      };
      const after = safeOwnerObservation(adapter, ownerPlayer);
      emit({
        kind: 'log',
        level: 'info',
        message: `[action-state] current=follow_player id=${currentAction.id} player=${ownerPlayer} visible=${after.owner?.visible ?? false} distance=${formatDebugDistance(after.owner?.distance)}`,
      });
    } catch (error) {
      currentAction = undefined;
      emit({
        kind: 'log',
        level: 'warn',
        message: `Could not start default following: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  const statusWithAction = (): MinecraftStatus => {
    const status = adapter.status();
    if (currentAction?.name === 'follow_player' && ownerPlayer) {
      return { ...status, owner: ownerPlayer, behavior: { kind: 'follow', player: ownerPlayer } };
    }
    if (currentAction?.name === 'collect_item') {
      return {
        ...status,
        owner: ownerPlayer,
        behavior: {
          kind: 'collect',
          jobId: currentAction.id,
          block: String(currentAction.args.block ?? 'unknown'),
          requested: Number(currentAction.args.maxCount ?? 0),
          collected: 0,
        },
      };
    }
    return { ...status, owner: ownerPlayer, behavior: { kind: 'idle' } };
  };
  adapter.configurePolicies({
    onFoodState(state) {
      const shortage = state.food <= 6 && !state.hasInventoryFood;
      if (shortage && !foodShortageActive) {
        foodShortageActive = true;
        emit({ kind: 'food-shortage', food: state.food });
      } else if (!shortage && foodShortageActive) {
        foodShortageActive = false;
        emit({ kind: 'food-recovered', food: state.food });
      }
    },
    onOxygenEmergency(state) {
      if (oxygenRecovery) return;
      const actionId = hasForegroundAction() ? currentAction?.id : undefined;
      const promise = recoverFromLowOxygen(state, actionId);
      oxygenRecovery = { actionId, promise };
      if (!actionId) {
        void promise.then(async (recovery) => {
          if (oxygenRecovery?.promise === promise) oxygenRecovery = undefined;
          if (taskActive) return;
          currentAction = undefined;
          emit({
            kind: 'oxygen-danger',
            recovered: recovery.recovered,
            oxygen: recovery.oxygen,
            method: recovery.method,
            position: state.position,
          });
          if (recovery.recovered) await resumeFollowing();
        });
      }
    },
    onDeath(state) {
      void stopForDeath(state);
    },
    onFollowBlocked(state) {
      followBlocked = true;
      emit({
        kind: 'movement-blocked',
        mode: 'follow',
        player: state.player,
        position: state.position,
        distance: state.distance,
      });
    },
    onFollowRecovered(state) {
      followBlocked = false;
      emit({
        kind: 'log',
        level: 'info',
        message: `[follow-state] recovered player=${state.player} distance=${state.distance.toFixed(1)}`,
      });
    },
    async onPlayersChanged(players) {
      const status = adapter.status();
      const humanPlayers = players.filter((player) => !samePlayer(player, status.username));
      if (!ownerPlayer && humanPlayers.length === 1) {
        ownerPlayer = humanPlayers[0];
        adapter.setOwner(ownerPlayer);
        emit({ kind: 'log', level: 'info', message: `[follow-state] owner inferred player=${ownerPlayer}` });
      }
      if (ownerPlayer
        && currentAction?.name === 'follow_player'
        && !humanPlayers.some((player) => samePlayer(player, ownerPlayer))) {
        await adapter.stopForeground();
        currentAction = undefined;
        emit({
          kind: 'log',
          level: 'info',
          message: `[follow-state] owner unavailable player=${ownerPlayer}; binding retained`,
        });
        return;
      }
      if (ownerPlayer && humanPlayers.some((player) => samePlayer(player, ownerPlayer))) {
        await resumeFollowing();
      }
    },
    shouldDefendAgainst: (entity) => entity.kind === 'hostile',
  });

  async function stopForDeath(state: MinecraftDeathEvent): Promise<void> {
    const actionId = hasForegroundAction() ? currentAction?.id : undefined;
    emit({ kind: 'death', position: state.position });
    emit({
      kind: 'log',
      level: 'error',
      message: `[survival] death action=${actionId ?? 'none'} position=${state.position ? `${state.position.x.toFixed(1)},${state.position.y.toFixed(1)},${state.position.z.toFixed(1)}` : 'unknown'}`,
    });
    if (actionId) {
      await runtime.cancel(actionId, {
        code: 'died',
        recoverable: false,
        summary: 'Minecraft task stopped because Hiyori died',
        details: { reason: 'death', position: state.position },
      });
      return;
    }
    await adapter.stopForeground();
  }

  async function recoverFromLowOxygen(
    state: MinecraftOxygenEmergency,
    actionId?: string,
  ): Promise<MinecraftSafetyRecovery> {
    emit({
      kind: 'log',
      level: 'warn',
      message: `[survival] oxygen emergency oxygen=${state.oxygen} position=${state.position.x.toFixed(1)},${state.position.y.toFixed(1)},${state.position.z.toFixed(1)} action=${actionId ?? 'none'}`,
    });
    if (actionId) {
      await runtime.cancel(actionId, {
        code: 'unsafe',
        summary: 'Minecraft action interrupted because oxygen became unsafe',
        details: { reason: 'oxygen_low', oxygen: state.oxygen, position: state.position },
      });
    } else {
      await adapter.stopForeground();
    }
    let recovery: MinecraftSafetyRecovery;
    try {
      recovery = await adapter.escapeToAir();
    } catch (error) {
      recovery = { recovered: false, oxygen: state.oxygen, method: 'failed' };
      emit({
        kind: 'log',
        level: 'error',
        message: `[survival] oxygen recovery threw: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    emit({
      kind: 'log',
      level: recovery.recovered ? 'info' : 'error',
      message: `[survival] oxygen recovery recovered=${recovery.recovered} oxygen=${recovery.oxygen} method=${recovery.method}`,
    });
    return recovery;
  }

  return {
    async connect(payload: MinecraftConnectionOptions): Promise<MinecraftStatus> {
      if (samePlayer(payload.owner, payload.username)) {
        throw new Error('Hiyori cannot follow itself');
      }
      const wasConnected = adapter.status().connected;
      await adapter.connect(payload);
      const status = adapter.status();
      const humanPlayers = status.players.filter((player) => !samePlayer(player, status.username));
      ownerPlayer = payload.owner?.trim()
        || ownerPlayer
        || (samePlayer(status.owner, status.username) ? undefined : status.owner)
        || (humanPlayers.length === 1 ? humanPlayers[0] : undefined);
      adapter.setOwner(ownerPlayer);
      if (!wasConnected) {
        followEnabled = true;
        taskActive = false;
        followBlocked = false;
      }
      await resumeFollowing();
      return statusWithAction();
    },
    async disconnect(): Promise<void> {
      ownerPlayer = undefined;
      followEnabled = true;
      currentAction = undefined;
      taskActive = false;
      followBlocked = false;
      await adapter.stopForeground();
      await adapter.disconnect();
    },
    status(): MinecraftStatus {
      return statusWithAction();
    },
    async snapshot() {
      const started = Date.now();
      emit({ kind: 'log', level: 'info', message: 'snapshot started' });
      try {
        const snapshot = await runtime.snapshot();
        emit({
          kind: 'log',
          level: 'info',
          message: `[snapshot-state] action=${currentAction?.name ?? 'none'} id=${currentAction?.id ?? 'none'} task=${taskActive} owner=${snapshot.owner?.name ?? 'none'} visible=${snapshot.owner?.visible ?? false} distance=${formatDebugDistance(snapshot.owner?.distance)}`,
        });
        if (!currentAction) return { ...snapshot, follow: { phase: 'inactive' } };
        const follow = currentAction.name === 'follow_player'
          ? {
            phase: followBlocked
              ? 'blocked' as const
              : snapshot.owner?.visible
              ? (snapshot.owner.distance ?? Number.POSITIVE_INFINITY) <= 2 ? 'nearby' as const : 'approaching' as const
              : 'target-lost' as const,
            target: String(currentAction.args.player ?? ownerPlayer ?? ''),
            distance: snapshot.owner?.distance,
          }
          : { phase: 'inactive' as const };
        return {
          ...snapshot,
          follow,
          action: { ...currentAction, args: { ...currentAction.args } },
        };
      } finally {
        emit({ kind: 'log', level: 'info', message: `snapshot finished in ${Date.now() - started}ms` });
      }
    },
    async say(message: string): Promise<void> {
      await adapter.say(message);
    },
    async executeAction(payload: MinecraftActionInstruction) {
      if (payload.task) taskActive = true;
      if (hasForegroundAction()) {
        throw new Error(`Minecraft action already running: ${currentAction?.name} (${currentAction?.id})`);
      }
      await adapter.stopForeground();
      setCurrentAction(payload);
      let result: MinecraftActionResult | undefined;
      try {
        result = await runtime.execute(payload);
        const recovery = oxygenRecovery?.actionId === payload.id
          ? oxygenRecovery
          : undefined;
        if (!recovery) return result;
        const recovered = await recovery.promise;
        if (oxygenRecovery?.promise === recovery.promise) oxygenRecovery = undefined;
        return withOxygenRecovery(result, recovered);
      } finally {
        if (taskActive) {
          currentAction = undefined;
          emit({ kind: 'log', level: 'info', message: '[follow-state] task owns body; follow suspended' });
        } else if (result?.error?.code === 'blocked'
          || result?.error?.code === 'path_unreachable'
          || result?.error?.code === 'timeout'
          || result?.error?.code === 'unsafe') {
          currentAction = undefined;
          emit({
            kind: 'log',
            level: 'warn',
            message: `[follow-state] suspended after ${result.error.code}; waiting for player assistance or a new movement command`,
          });
        } else {
          await resumeFollowing();
        }
      }
    },
    cancelAction(actionId: string) {
      return runtime.cancel(actionId);
    },
    async follow(payload: { player: string }): Promise<{ state: 'following'; player: string }> {
      const username = adapter.status().username;
      if (samePlayer(payload.player, username)) {
        throw new Error('Hiyori cannot follow itself');
      }
      taskActive = false;
      followBlocked = false;
      if (hasForegroundAction() && currentAction) await runtime.cancel(currentAction.id);
      await adapter.stopForeground();
      ownerPlayer = payload.player.trim();
      followEnabled = true;
      adapter.setOwner(ownerPlayer);
      await resumeFollowing();
      return { state: 'following', player: ownerPlayer };
    },
    async stop(): Promise<void> {
      followEnabled = false;
      taskActive = false;
      followBlocked = false;
      if (hasForegroundAction() && currentAction) await runtime.cancel(currentAction.id);
      await adapter.stopForeground();
      currentAction = undefined;
    },
    async taskRelease(): Promise<MinecraftStatus> {
      taskActive = false;
      await resumeFollowing();
      return statusWithAction();
    },
  };
}

function withOxygenRecovery(
  result: MinecraftActionResult,
  recovery: MinecraftSafetyRecovery,
): MinecraftActionResult {
  const text = recovery.recovered
    ? 'Oxygen became unsafe, so the action stopped and Hiyori returned to air. Re-observe the surroundings and choose a safer route before retrying.'
    : 'Oxygen became unsafe and Hiyori could not confirm a return to air. Stop this task and report the danger.';
  return {
    ...result,
    outcome: recovery.recovered ? 'partial' : 'failed',
    summary: text,
    observations: [
      ...(result.observations ?? []),
      {
        id: `survival.oxygen:${Date.now()}`,
        at: Date.now(),
        severity: recovery.recovered ? 'warning' : 'error',
        kind: 'survival.oxygen',
        text,
        data: { ...recovery },
      },
    ],
    error: {
      code: 'unsafe',
      recoverable: recovery.recovered,
      details: {
        ...(result.error?.details ?? {}),
        reason: 'oxygen_low',
        recovered: recovery.recovered,
        oxygen: recovery.oxygen,
        recoveryMethod: recovery.method,
        message: text,
      },
    },
  };
}

function formatDebugDistance(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : 'unknown';
}

function samePlayer(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase());
}

function safeOwnerObservation(
  adapter: MinecraftBotAdapter,
  player: string,
): { owner?: { visible: boolean; distance?: number } } {
  try {
    return adapter.getRawObservation(player);
  } catch {
    return {};
  }
}
