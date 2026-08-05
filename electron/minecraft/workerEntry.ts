import { randomUUID } from 'node:crypto';
import type {
  MinecraftActionInstruction,
  MinecraftCommand,
  MinecraftRuntimeEvent,
  MinecraftStatus,
  MinecraftWorkerMessage,
} from './protocol';
import type { MinecraftBotAdapter, MinecraftConnectionOptions } from './actions/types';
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
  collect(payload: any): Promise<unknown>;
  stop(): Promise<unknown>;
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
    case 'collect':
      return controller.collect(command.payload);
    case 'stop':
      return controller.stop();
    default:
      throw new Error(`Unsupported Minecraft worker action: ${command.action}`);
  }
}

async function startWorker(): Promise<void> {
  const [{ MinecraftEmbodimentRuntime }, { createMineflayerAdapter }] =
    await Promise.all([import('./embodimentRuntime'), import('./mineflayerAdapter')]);
  const send = (message: MinecraftWorkerMessage) => process.send?.(message);
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

function createRuntimeWorkerController(
  adapter: MinecraftBotAdapter,
  runtime: MinecraftEmbodimentRuntime,
  emit: (event: MinecraftRuntimeEvent) => void,
): WorkerController {
  let foodShortageActive = false;
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
    shouldDefendAgainst: (entity) => entity.kind === 'hostile',
  });

  return {
    async connect(payload: MinecraftConnectionOptions): Promise<MinecraftStatus> {
      await adapter.connect(payload);
      return adapter.status();
    },
    async disconnect(): Promise<void> {
      await adapter.stopForeground();
      await adapter.disconnect();
    },
    status(): MinecraftStatus {
      return adapter.status();
    },
    snapshot() {
      return runtime.snapshot();
    },
    async say(message: string): Promise<void> {
      await adapter.say(message);
    },
    executeAction(payload: MinecraftActionInstruction) {
      return runtime.execute(payload);
    },
    cancelAction(actionId: string) {
      return runtime.cancel(actionId);
    },
    async follow(payload: { player: string }): Promise<{ state: 'following'; player: string }> {
      await runtime.execute({
        id: randomUUID(),
        name: 'follow_player',
        args: { player: payload.player },
      });
      return { state: 'following', player: payload.player };
    },
    async collect(payload: {
      block: string;
      quantity: number;
      radius?: number;
    }): Promise<{ state: 'running'; jobId: string; block: string; quantity: number; radius: number }> {
      const jobId = randomUUID();
      const block = payload.block;
      const quantity = clampInteger(payload.quantity, 1, 64);
      const radius = clampInteger(payload.radius ?? 32, 1, 64);
      void runtime
        .execute({
          id: jobId,
          name: 'collect_block',
          args: { block, maxCount: quantity, radius },
        })
        .then((result) => {
          const collected = Object.values(result.inventoryDelta)[0] ?? 0;
          emit({
            kind: 'collection-terminal',
            jobId,
            outcome: terminalOutcome(result.outcome, collected, quantity),
            block,
            requested: quantity,
            collected,
            message: result.error?.details.message ? String(result.error.details.message) : undefined,
          });
        });
      return { state: 'running', jobId, block, quantity, radius };
    },
    async stop(): Promise<void> {
      await adapter.stopForeground();
    },
  };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function terminalOutcome(
  outcome: 'succeeded' | 'partial' | 'failed' | 'cancelled',
  collected: number,
  requested: number,
): 'completed' | 'partial' | 'cancelled' | 'failed' {
  if (outcome === 'cancelled') return 'cancelled';
  if (outcome === 'failed') return 'failed';
  return collected >= requested ? 'completed' : 'partial';
}
