import { createBot, latestSupportedVersion, type Bot } from 'mineflayer';
import { loader as autoEatPlugin } from 'mineflayer-auto-eat';
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock';
import { goals, pathfinder } from 'mineflayer-pathfinder';
import { plugin as pvpPlugin } from 'mineflayer-pvp';
import { plugin as toolPlugin } from 'mineflayer-tool';
import {
  planCraft,
  recipesSourceFor,
  smeltInputFor,
  smeltOutputFor,
  SMELT_FUEL_ITEM,
  SMELT_ITEMS_PER_FUEL,
  type CraftPlan,
  type CraftPlanStep,
} from './craftPlanner';
import { gatherWood } from './gatherWood';
import { placeBlockAt as airiPlaceBlockAt, breakBlockAt, isReplaceableForPlacement, type PlaceFace } from './placeBlock';
import { Vec3 } from 'vec3';
import { runAdaptiveCollection } from './collectionStrategy';
import type {
  CollectionRequest,
  MinecraftBotAdapter,
  MinecraftConnectionOptions,
  MinecraftEntitySnapshot,
  MinecraftPolicyHandlers,
  MinecraftSafetyRecovery,
} from './actions/types';
import type {
  MinecraftActionErrorCode,
  MinecraftActionResult,
  MinecraftObservedEntity,
  MinecraftRawObservation,
  MinecraftRuntimeEvent,
  MinecraftStatus,
} from './protocol';
import { buildMinecraftSnapshot } from './perception';
import { protectMovementsFromFluid } from './fluidSafety';
import { runAbortableOperation } from './abortableOperation';
import { patchedGoto, type PathfindResult } from './patchedGoto';
import { measurePlayerGaze, PlayerGazeTracker } from './playerGaze';
import { hasFollowRecoveryMovement } from './followRecovery';

const HOSTILE_MOBS = new Set([
  'blaze',
  'cave_spider',
  'creeper',
  'drowned',
  'elder_guardian',
  'enderman',
  'endermite',
  'evoker',
  'ghast',
  'guardian',
  'husk',
  'magma_cube',
  'phantom',
  'pillager',
  'ravager',
  'shulker',
  'silverfish',
  'skeleton',
  'slime',
  'spider',
  'stray',
  'vex',
  'vindicator',
  'witch',
  'wither',
  'wither_skeleton',
  'zombie',
  'zombie_villager',
]);

const LOG_BLOCK_NAMES = [
  'oak_log',
  'spruce_log',
  'birch_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
  'crimson_stem',
  'warped_stem',
  'log',
  'log2',
  'wood',
];

interface CraftExecutionError extends Error {
  craftCode: MinecraftActionErrorCode;
}

function createCraftError(code: MinecraftActionErrorCode, message: string): CraftExecutionError {
  const error = new Error(message) as CraftExecutionError;
  error.craftCode = code;
  return error;
}

function craftErrorCode(error: unknown): MinecraftActionErrorCode | undefined {
  return error instanceof Error && 'craftCode' in error
    ? (error as CraftExecutionError).craftCode
    : undefined;
}

const LEAF_BLOCK_NAMES = [
  'oak_leaves',
  'spruce_leaves',
  'birch_leaves',
  'jungle_leaves',
  'acacia_leaves',
  'dark_oak_leaves',
  'mangrove_leaves',
  'cherry_leaves',
  'azalea_leaves',
  'flowering_azalea_leaves',
];

const GENERIC_TREE_NAMES = new Set([
  'tree',
  'trees',
  'log',
  'logs',
  'wood',
  'woods',
  'trunk',
  'trunks',
  '树',
  '树木',
  '木头',
  '原木',
]);

const AIR_BLOCK_NAMES = new Set(['air', 'cave_air', 'void_air']);
// 可被放置替换的方块判定统一走 placeBlock.isReplaceableForPlacement（按碰撞盒判断）
const MAX_SCAN_BLOCK_POSITIONS = 1536;
const MAX_TARGET_ITEM_SWEEPS = 12;
const MAX_COLLECTION_SEARCH_RADIUS = 128;
const COMBAT_CHASE_RADIUS = 64;
const OXYGEN_EMERGENCY_LEVEL = 10;
const OXYGEN_RECOVERED_LEVEL = 18;
const SURFACE_ATTEMPT_MS = 3_000;
const LAST_AIR_ROUTE_TIMEOUT_MS = 5_000;
const FOLLOW_RECOVERY_RETRY_MS = 8_000;
const FOLLOW_WORLD_CHANGE_DEBOUNCE_MS = 300;
const FOLLOW_WORLD_CHANGE_RADIUS = 16;
const FOLLOW_USER_ASSISTANCE_DISTANCE = 8;
const GAZE_POLL_INTERVAL_MS = 200;
const GAZE_HOLD_MS = 4_000;
const GAZE_REARM_MS = 1_000;
const GAZE_MAX_DISTANCE = 8;
const KNOWN_BLOCK_DROPS: Record<string, string> = {
  tallgrass: 'wheat_seeds',
  grass: 'wheat_seeds',
  fern: 'wheat_seeds',
  double_plant: 'wheat_seeds',
  reeds: 'sugar_cane',
  sugar_cane: 'sugar_cane',
};

export interface MineflayerAdapterDependencies {
  createBot: typeof createBot | ((options: any) => any);
  plugins: Array<(bot: any) => void>;
  createFollowGoal(entity: any, range: number): any;
  gatherWood?: typeof gatherWood;
  confirmEntityDeath?: typeof confirmEntityDeath;
  collectDrops?: typeof collectNearbyDrops;
  approachTimeoutMs?: number;
}

const defaultDependencies: MineflayerAdapterDependencies = {
  createBot,
  plugins: [pathfinder, toolPlugin, collectBlockPlugin, autoEatPlugin, pvpPlugin],
  createFollowGoal: (entity, range) => new goals.GoalFollow(entity, range),
  gatherWood,
  confirmEntityDeath,
  collectDrops: collectNearbyDrops,
};

export function createMineflayerAdapter(
  emit: (event: MinecraftRuntimeEvent) => void,
  dependencies: MineflayerAdapterDependencies = defaultDependencies,
): MinecraftBotAdapter {
  let bot: Bot | any;
  let owner: string | undefined;
  let connection: MinecraftConnectionOptions | undefined;
  let policyHandlers: MinecraftPolicyHandlers = {
    onFoodState: () => undefined,
    onOxygenEmergency: () => undefined,
    onDeath: () => undefined,
    onFollowBlocked: () => undefined,
    shouldDefendAgainst: (entity) => entity.kind === 'hostile',
  };
  let lastHealth = 20;
  let intentionalDisconnect = false;
  let everSpawned = false;
  let knownCraftingTable: Vec3 | undefined;
  let lastBreathablePosition: { x: number; y: number; z: number } | undefined;
  let oxygenEmergencyActive = false;
  let followWatchdog: ReturnType<typeof setInterval> | undefined;
  let gazePoller: ReturnType<typeof setInterval> | undefined;
  const gazeTracker = new PlayerGazeTracker({
    holdMs: GAZE_HOLD_MS,
    rearmMs: GAZE_REARM_MS,
  });
  let followWatchdogGeneration = 0;
  let followSession: {
    bot: any;
    player: string;
    blocked: boolean;
    retryInProgress: boolean;
    blockedNotified: boolean;
    pathStuckResets: number;
    blockedPosition?: { x: number; y: number; z: number };
    retryTimer?: ReturnType<typeof setTimeout>;
    retryAt?: number;
  } | undefined;

  function clearFollowRetry(): void {
    if (followSession?.retryTimer) clearTimeout(followSession.retryTimer);
    if (followSession) {
      followSession.retryTimer = undefined;
      followSession.retryAt = undefined;
    }
  }

  function stopFollowSession(): void {
    clearFollowRetry();
    followSession = undefined;
    stopFollowWatchdog();
  }

  function stopGazeTracking(): void {
    if (gazePoller) clearInterval(gazePoller);
    gazePoller = undefined;
    gazeTracker.reset();
  }

  function startGazeTracking(current: any): void {
    stopGazeTracking();
    gazePoller = setInterval(() => {
      if (bot !== current || !owner || !current.entity) {
        gazeTracker.update(null, Date.now());
        return;
      }
      const playerEntry = Object.entries(current.players ?? {}).find(
        ([name]) => name.toLocaleLowerCase() === owner!.toLocaleLowerCase(),
      )?.[1] as any;
      const playerEntity = playerEntry?.entity;
      const distance = playerEntity
        ? measurePlayerGaze(playerEntity, current.entity, current.world, GAZE_MAX_DISTANCE)
        : null;
      const trigger = gazeTracker.update(
        distance === null ? null : { player: playerEntry.username ?? owner, distance },
        Date.now(),
      );
      if (!trigger) return;
      emit({
        kind: 'log',
        level: 'info',
        message: `[gaze] triggered player=${trigger.player} duration=${trigger.durationMs}ms distance=${trigger.distance.toFixed(1)}`,
      });
      emit({ kind: 'player-gaze', ...trigger });
    }, GAZE_POLL_INTERVAL_MS);
    gazePoller.unref?.();
  }

  function scheduleFollowRetry(delayMs: number, reason: string): void {
    const session = followSession;
    if (!session?.blocked || bot !== session.bot) return;
    const retryAt = Date.now() + delayMs;
    if (session.retryTimer && session.retryAt !== undefined && session.retryAt <= retryAt) return;
    clearFollowRetry();
    session.retryTimer = setTimeout(() => retryBlockedFollow(session, reason), delayMs);
    session.retryAt = retryAt;
    session.retryTimer.unref?.();
    emit({
      kind: 'log',
      level: 'info',
      message: `[follow-recovery] waiting target=${session.player} reason=${reason} retryIn=${delayMs}ms`,
    });
  }

  function retryBlockedFollow(
    session: NonNullable<typeof followSession>,
    reason: string,
  ): void {
    if (followSession !== session || bot !== session.bot || !session.blocked) return;
    session.retryTimer = undefined;
    session.retryAt = undefined;
    const target = session.bot.players[session.player]?.entity;
    if (!target) {
      scheduleFollowRetry(FOLLOW_RECOVERY_RETRY_MS, 'target-not-visible');
      return;
    }
    const goal = dependencies.createFollowGoal(target, 2);
    emit({
      kind: 'log',
      level: 'info',
      message: `[follow-recovery] retry target=${session.player} reason=${reason} distance=${distanceToBot(session.bot, target.position).toFixed(1)}`,
    });
    session.blocked = false;
    session.retryInProgress = true;
    session.pathStuckResets = 0;
    session.bot.pathfinder.setGoal(goal, true);
    startFollowWatchdog(session.bot, session.player);
  }

  function markFollowBlocked(current: any, reason: string): void {
    const session = followSession;
    if (!session || session.bot !== current || session.blocked || !current.entity?.position) return;
    const target = current.players[session.player]?.entity;
    if (!target) return;
    const position = vector(current.entity.position);
    const distance = distanceToBot(current, target.position);
    if (distance <= 2.5) {
      session.pathStuckResets = 0;
      return;
    }
    session.blocked = true;
    session.retryInProgress = false;
    session.blockedPosition = position;
    stopFollowWatchdog();
    clearPathfinderGoal(current);
    emit({
      kind: 'log',
      level: 'warn',
      message: `[follow-runtime] blocked target=${session.player} reason=${reason} distance=${distance.toFixed(1)} position=${formatPosition(position)}`,
    });
    const needsUserAssistance = distance > FOLLOW_USER_ASSISTANCE_DISTANCE;
    if (!needsUserAssistance) {
      emit({
        kind: 'log',
        level: 'info',
        message: `[follow-runtime] nearby path interruption kept internal target=${session.player} distance=${distance.toFixed(1)}`,
      });
    } else if (!session.blockedNotified) {
      session.blockedNotified = true;
      Promise.resolve(policyHandlers.onFollowBlocked?.({ player: session.player, position, distance })).catch((error) => emit({
        kind: 'log',
        level: 'error',
        message: `[follow-runtime] blocked handler failed: ${error instanceof Error ? error.message : String(error)}`,
      }));
    }
    scheduleFollowRetry(FOLLOW_RECOVERY_RETRY_MS, reason);
  }

  function observeFollowPathReset(current: any, reason: string): void {
    const session = followSession;
    if (!session || session.bot !== current || session.blocked) return;
    session.pathStuckResets = reason === 'stuck' ? session.pathStuckResets + 1 : 0;
  }

  function observeFollowPathStop(current: any): void {
    const session = followSession;
    if (!session || session.bot !== current || session.blocked) return;
    // mineflayer-pathfinder emits two stuck resets, then path_stop when its
    // third no-progress check gives up. Other path stops are interruptions.
    if (session.pathStuckResets >= 2) markFollowBlocked(current, 'pathfinder-stuck');
  }

  function observeFollowPathUpdate(current: any, result: any): void {
    if (!result?.status) return;
    const noUsablePath = !Array.isArray(result.path) || result.path.length === 0;
    if (noUsablePath && result.status === 'noPath') {
      markFollowBlocked(current, 'pathfinder-noPath');
    }
  }

  function recoverFollowAfterWorldChange(current: any, position: any): void {
    const session = followSession;
    if (!session?.blocked || session.retryInProgress || session.bot !== current || !position) return;
    const changed = vector(position);
    const nearBot = current.entity?.position
      ? distanceBetween(vector(current.entity.position), changed) <= FOLLOW_WORLD_CHANGE_RADIUS
      : false;
    const nearBlockedPosition = session.blockedPosition
      ? distanceBetween(session.blockedPosition, changed) <= FOLLOW_WORLD_CHANGE_RADIUS
      : false;
    if (!nearBot && !nearBlockedPosition) return;
    scheduleFollowRetry(FOLLOW_WORLD_CHANGE_DEBOUNCE_MS, 'nearby-block-update');
  }

  function recoverFollowAfterEntitySpawn(current: any, entity: any): void {
    const session = followSession;
    if (!session?.blocked || session.retryInProgress || session.bot !== current) return;
    if (String(entity?.username ?? '').toLocaleLowerCase() !== session.player.toLocaleLowerCase()) return;
    scheduleFollowRetry(FOLLOW_WORLD_CHANGE_DEBOUNCE_MS, 'owner-entity-spawned');
  }

  function stopFollowWatchdog(): void {
    followWatchdogGeneration += 1;
    if (followWatchdog) clearInterval(followWatchdog);
    followWatchdog = undefined;
  }

  function startFollowWatchdog(current: any, player: string): void {
    stopFollowWatchdog();
    const generation = followWatchdogGeneration;
    let previousPosition = vector(current.entity?.position);
    const initialTarget = current.players[player]?.entity;
    let previousDistance = initialTarget
      ? distanceToBot(current, initialTarget.position)
      : Number.POSITIVE_INFINITY;
    followWatchdog = setInterval(() => {
      if (bot !== current || generation !== followWatchdogGeneration) return;
      const target = current.players[player]?.entity;
      if (!target || !current.entity?.position) {
        return;
      }
      const position = vector(current.entity.position);
      const distance = distanceToBot(current, target.position);
      const moved = distanceBetween(previousPosition, position);
      const improved = previousDistance - distance;
      const madeProgress = hasFollowRecoveryMovement({
        previousBotPosition: previousPosition,
        currentBotPosition: position,
        minimumBotMovement: 1.5,
      });
      if (madeProgress && followSession?.bot === current && followSession.player === player) {
        followSession.pathStuckResets = 0;
      }
      if (followSession?.bot === current
        && followSession.player === player
        && (followSession.blocked || followSession.retryInProgress)
        && madeProgress) {
        const recovered = followSession;
        recovered.blocked = false;
        recovered.retryInProgress = false;
        recovered.blockedNotified = false;
        recovered.blockedPosition = undefined;
        clearFollowRetry();
        emit({
          kind: 'log',
          level: 'info',
          message: `[follow-recovery] resumed target=${player} distance=${distance.toFixed(1)}`,
        });
        Promise.resolve(policyHandlers.onFollowRecovered?.({ player, position, distance })).catch((error) => emit({
          kind: 'log',
          level: 'error',
          message: `[follow-recovery] recovered handler failed: ${error instanceof Error ? error.message : String(error)}`,
        }));
      }
      emit({
        kind: 'log',
        level: 'info',
        message: `[follow-watchdog] target=${player} position=${formatPosition(position)} distance=${distance.toFixed(1)} moved=${moved.toFixed(1)} improved=${improved.toFixed(1)} moving=${Boolean(current.pathfinder?.isMoving?.())} pathStuckResets=${followSession?.pathStuckResets ?? 0}`,
      });
      previousPosition = position;
      previousDistance = distance;
    }, 5_000);
    followWatchdog.unref?.();
  }

  async function connectOnce(options: MinecraftConnectionOptions, version?: string): Promise<void> {
    const current = dependencies.createBot({
      host: options.host,
      port: options.port,
      username: options.username,
      auth: 'offline',
      ...(version ? { version } : {}),
    });
    bot = current;
    stopFollowSession();
    lastBreathablePosition = undefined;
    oxygenEmergencyActive = false;
    for (const plugin of dependencies.plugins) current.loadPlugin(plugin);
    if (current.pathfinder?.movements) {
      protectMovementsFromFluid(current, current.pathfinder.movements);
    }
    if (current.collectBlock?.movements) {
      protectMovementsFromFluid(current, current.collectBlock.movements);
    }
    if (current.pathfinder) {
      current.pathfinder.searchRadius = 64;
      current.pathfinder.thinkTimeout = Math.min(current.pathfinder.thinkTimeout ?? 5_000, 5_000);
      current.pathfinder.tickTimeout = Math.min(current.pathfinder.tickTimeout ?? 20, 20);
    }

    // ---- move-debug: 捕获 "Invalid move player packet received" 踢出前的移动现场 ----
    const sentMoves: Array<{ t: number; x: number; y: number; z: number; onGround: boolean; delta: number }> = [];
    const MAX_MOVE_HISTORY = 120;
    let moveDumpSent = false;
    const dumpMoveDebug = (reason: string): void => {
      if (moveDumpSent) return;
      moveDumpSent = true;
      const pos = current?.entity?.position;
      const latest = sentMoves[sentMoves.length - 1];
      const maxDelta = sentMoves.reduce((max, m) => Math.max(max, m.delta), 0);
      emit({
        kind: 'log',
        level: 'warn',
        message: `[move-debug] connection ${reason}; entity=${pos ? formatPosition(pos) : 'none'}; move packets=${sentMoves.length}; max single-packet delta=${maxDelta.toFixed(1)}; latest=${latest
          ? `(${latest.x.toFixed(1)}, ${latest.y.toFixed(1)}, ${latest.z.toFixed(1)}) onGround=${latest.onGround} delta=${latest.delta.toFixed(1)}`
          : 'none'}`,
      });
      for (const m of sentMoves.slice(-12)) {
        emit({
          kind: 'log',
          level: 'info',
          message: `[move-debug] sent ${new Date(m.t).toISOString().slice(11, 19)} (${m.x.toFixed(1)}, ${m.y.toFixed(1)}, ${m.z.toFixed(1)}) delta=${m.delta.toFixed(2)} onGround=${m.onGround}`,
        });
      }
    };
    if (current._client?.write) {
      const origWrite = current._client.write.bind(current._client);
      current._client.write = (name: string, params: any) => {
        if (name === 'position' || name === 'position_look') {
          const x = Number(params?.x);
          const y = Number(params?.y);
          const z = Number(params?.z);
          if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
            const last = sentMoves[sentMoves.length - 1];
            const delta = last ? Math.sqrt((x - last.x) ** 2 + (y - last.y) ** 2 + (z - last.z) ** 2) : 0;
            sentMoves.push({ t: Date.now(), x, y, z, onGround: Boolean(params?.onGround), delta });
            if (sentMoves.length > MAX_MOVE_HISTORY) sentMoves.shift();
            if (delta > 8) {
              emit({
                kind: 'log',
                level: 'warn',
                message: `[move-debug] large move packet delta=${delta.toFixed(1)} -> (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) onGround=${Boolean(params?.onGround)}`,
              });
            }
          }
        }
        if (name === 'window_click') {
          const window = current.currentWindow;
          if (window && String(window.type ?? '').includes('furnace')) {
            emit({
              kind: 'log',
              level: 'info',
              message: `[window-debug] click window=${params?.windowId} slot=${params?.slot} button=${params?.mouseButton} mode=${params?.mode} item=${JSON.stringify(params?.item)}`,
            });
          }
        }
        return origWrite(name, params);
      };
      current._client.on('transaction', (packet: any) => {
        const window = current.currentWindow;
        if (window && String(window.type ?? '').includes('furnace')) {
          emit({
            kind: 'log',
            level: packet?.accepted ? 'info' : 'warn',
            message: `[window-debug] transaction window=${packet?.windowId} action=${packet?.action} accepted=${packet?.accepted}`,
          });
        }
      });
    }

    // NaN 自愈：受击（击退 velocity）或坠落可能把客户端物理位置算成 NaN，
    // 服务器校验到非法坐标会直接踢人。physicsTick 在位置更新后、发送移动包前触发，
    // 发现 NaN 就回滚到最近有效位置并清零速度，避免 NaN 包发出去。
    let lastValidPosition: { x: number; y: number; z: number } | undefined;
    current.on('physicsTick', () => {
      const pos = current.entity?.position;
      if (!pos) return;
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
        const fallback = lastValidPosition ?? sentMoves[sentMoves.length - 1];
        if (fallback) {
          pos.set(fallback.x, fallback.y, fallback.z);
        }
        current.entity?.velocity?.set?.(0, 0, 0);
        emit({
          kind: 'log',
          level: 'warn',
          message: `[move-debug] NaN position detected; restored to ${
            fallback
              ? `${fallback.x.toFixed(1)}, ${fallback.y.toFixed(1)}, ${fallback.z.toFixed(1)}`
              : 'spawn'
          }`,
        });
      } else {
        lastValidPosition = { x: pos.x, y: pos.y, z: pos.z };
        if (isBreathingSafely(current)) lastBreathablePosition = vector(pos);
      }
    });

    current.on('chat', (username: string, message: string) => {
      if (username !== current.username) {
        emit({ kind: 'chat', player: username, message });
      }
    });
    current.on('playerJoined', () => notifyPlayers(current, emit, policyHandlers));
    current.on('playerLeft', () => notifyPlayers(current, emit, policyHandlers));
    current.on('entitySpawn', (entity: any) => recoverFollowAfterEntitySpawn(current, entity));
    current.on('blockUpdate', (oldBlock: any, newBlock: any) => {
      if (!oldBlock || !newBlock) return;
      recoverFollowAfterWorldChange(current, newBlock.position ?? oldBlock.position);
    });
    let lastFollowPathLogAt = 0;
    let lastFollowPathSignature = '';
    current.on('goal_reached', (goal: any) => {
      emit({
        kind: 'log',
        level: 'info',
        message: `[pathfinder] goal_reached goal=${goal?.constructor?.name ?? 'unknown'} position=${formatPosition(current?.entity?.position)}`,
      });
    });
    current.on('goal_updated', (goal: any, dynamic: boolean) => {
      emit({
        kind: 'log',
        level: 'info',
        message: `[pathfinder] goal_updated goal=${goal?.constructor?.name ?? 'none'} dynamic=${Boolean(dynamic)}`,
      });
    });
    current.on('path_reset', (reason: string) => {
      observeFollowPathReset(current, reason);
      const controlState = current?.controlState ?? {};
      emit({
        kind: 'log',
        level: 'warn',
        message: `[pathfinder] path_reset reason=${reason || 'unknown'} position=${formatPrecisePosition(current?.entity?.position)} controls=forward:${Boolean(controlState.forward)},jump:${Boolean(controlState.jump)},sprint:${Boolean(controlState.sprint)} moving=${Boolean(current?.pathfinder?.isMoving?.())}`,
      });
    });
    current.on('path_stop', () => {
      observeFollowPathStop(current);
      emit({ kind: 'log', level: 'info', message: '[pathfinder] path_stop' });
    });
    current.on('path_update', (result: any) => {
      observeFollowPathUpdate(current, result);
      if (!result?.status) return;
      const session = followSession;
      if (session?.bot === current && Array.isArray(result.path) && result.path.length > 0) {
        const first = result.path[0];
        const signature = `${result.status}:${result.path.length}:${formatPrecisePosition(first)}:${first?.toBreak?.length ?? 0}:${first?.toPlace?.length ?? 0}`;
        const now = Date.now();
        if (result.status !== 'success'
          || (signature !== lastFollowPathSignature && now - lastFollowPathLogAt >= 1_000)
          || now - lastFollowPathLogAt >= 5_000) {
          lastFollowPathSignature = signature;
          lastFollowPathLogAt = now;
          emit({
            kind: 'log',
            level: result.status === 'success' ? 'info' : 'warn',
            message: `[pathfinder] follow_path status=${result.status} length=${result.path.length} first=${formatPrecisePosition(first)} delta=${formatPositionDelta(current?.entity?.position, first)} break=${first?.toBreak?.length ?? 0} place=${first?.toPlace?.length ?? 0}`,
          });
        }
      }
      if (result.status === 'success') return;
      emit({
        kind: 'log',
        level: 'warn',
        message: `[pathfinder] path_update status=${result.status} visited=${result.visitedNodes ?? 'unknown'} cost=${result.cost ?? 'unknown'}`,
      });
    });
    current.on('health', () => {
      if (current.health !== lastHealth) {
        const pos = current?.entity?.position;
        emit({
          kind: 'log',
          level: current.health < lastHealth ? 'warn' : 'info',
          message: `[move-debug] health ${lastHealth} -> ${current.health} at ${pos ? formatPosition(pos) : 'unknown'}`,
        });
      }
      notifyFoodState(current, policyHandlers);
      if (current.health < lastHealth) defendFromNearbyHostile(current, policyHandlers);
      lastHealth = current.health;
    });
    current.on('death', () => {
      const position = current.entity?.position ? vector(current.entity.position) : undefined;
      emit({
        kind: 'log',
        level: 'error',
        message: `[survival] died position=${position ? formatPosition(position) : 'unknown'}`,
      });
      Promise.resolve(policyHandlers.onDeath({ position })).catch((error) => emit({
        kind: 'log',
        level: 'error',
        message: `[survival] death handler failed: ${error instanceof Error ? error.message : String(error)}`,
      }));
    });
    current.on('breath', () => {
      const oxygen = Number(current.oxygenLevel ?? 20);
      const position = current.entity?.position;
      if (oxygen >= OXYGEN_RECOVERED_LEVEL && isBreathingSafely(current)) {
        if (position) lastBreathablePosition = vector(position);
        if (oxygenEmergencyActive) {
          emit({
            kind: 'log',
            level: 'info',
            message: `[survival] oxygen recovered=${oxygen} position=${position ? formatPosition(position) : 'unknown'}`,
          });
        }
        oxygenEmergencyActive = false;
        return;
      }
      if (
        oxygen > OXYGEN_EMERGENCY_LEVEL
        || oxygenEmergencyActive
        || !position
      ) return;
      oxygenEmergencyActive = true;
      emit({
        kind: 'log',
        level: 'warn',
        message: `[survival] oxygen emergency=${oxygen} position=${formatPosition(position)}`,
      });
      Promise.resolve(policyHandlers.onOxygenEmergency({
        oxygen,
        position: vector(position),
      })).catch((error) => emit({
        kind: 'log',
        level: 'error',
        message: `[survival] oxygen emergency handler failed: ${error instanceof Error ? error.message : String(error)}`,
      }));
    });
    current.on('end', (reason: string) => {
      if (bot !== current) return;
      stopGazeTracking();
      emit({
        kind: 'log',
        level: intentionalDisconnect ? 'info' : 'warn',
        message: `Connection ended: ${reason || 'Minecraft connection ended'}`,
      });
      dumpMoveDebug(reason || 'end');
      if (!intentionalDisconnect && everSpawned) {
        emit({ kind: 'disconnected', reason: reason || 'Minecraft connection ended' });
      }
      intentionalDisconnect = false;
      bot = undefined;
    });
    current.on('kicked', (reason: unknown) => {
      dumpMoveDebug('kicked');
      emit({ kind: 'log', level: 'error', message: `Kicked: ${String(reason)}` });
    });
    current.on('error', (error: Error) => {
      if (bot !== current) return;
      emit({ kind: 'log', level: 'error', message: error.message });
    });

    await waitForSpawn(current);
    everSpawned = true;
    lastHealth = current.health;
    if (current.entity?.position) lastBreathablePosition = vector(current.entity.position);
    current.autoEat?.setOpts?.({ minHunger: 16, strictErrors: false });
    current.autoEat?.enableAuto?.();
    notifyFoodState(current, policyHandlers);
    notifyPlayers(current, emit, policyHandlers);
    startGazeTracking(current);
  }

  async function collectBlocks(request: CollectionRequest): Promise<{
    total: number;
    byName: Record<string, number>;
    skipped?: number;
    missingTool?: number;
  }> {
    const current = requireBot(bot);
    const ids = new Map<string, number>();
    for (const name of request.blocks) {
      const block = current.registry.blocksByName?.[name];
      if (block?.id !== undefined) ids.set(name, block.id);
    }
    if (ids.size === 0) throw new Error(`Unknown Minecraft block: ${request.blocks.join(', ')}`);
    if (request.signal.aborted) throw abortError();

    const sugarCaneName = request.blocks.find((name) => name === 'sugar_cane' || name === 'reeds');
    if (sugarCaneName) {
      const collected = await collectSugarCane(current, request, ids.get(sugarCaneName)!);
      return { total: collected, byName: { [sugarCaneName]: collected } };
    }

    if (typeof current.collectBlock?.collect !== 'function') {
      throw new Error('collect_block plugin is not loaded; cannot collect blocks');
    }

    const idSet = new Set(ids.values());
    const nameById = new Map<number, string>();
    for (const [name, id] of ids) nameById.set(id, name);
    const positions: any[] = [];
    for (const blockId of idSet) {
      positions.push(...(current.findBlocks({
        matching: blockId,
        maxDistance: request.radius,
        count: Math.min(64, Math.max(16, request.quantity * 4)),
      }) ?? []));
    }
    const blocks = positions
      .map((position: any) => current.blockAt(position))
      .filter((block: any) => block && idSet.has(block.type))
      .sort((left: any, right: any) => distanceToBot(current, left.position) - distanceToBot(current, right.position))
      .slice(0, request.quantity);
    if (blocks.length === 0) return { total: 0, byName: {} };

    // 复用 mineflayer-collectblock 的 collect()：自带寻路、清障（打穿挡路的方块）
    // 与掉落拾取；逐块调用，单块不可达/无法收获时跳过，不拖垮整批。
    let total = 0;
    let skipped = 0;
    let missingTool = 0;
    const byName: Record<string, number> = {};
    for (const candidate of blocks) {
      if (request.signal.aborted) throw abortError();
      if (!canHarvestWithInventory(current, candidate)) {
        missingTool += 1;
        emit({
          kind: 'log',
          level: 'warn',
          message: `[collect] skipped ${candidate.name} at ${candidate.position.x},${candidate.position.y},${candidate.position.z}: no harvestable tool in inventory (missing_tool)`,
        });
        continue;
      }
      const blockStart = Date.now();
      emit({
        kind: 'log',
        level: 'info',
        message: `[collect] mining ${candidate.name} at ${candidate.position.x},${candidate.position.y},${candidate.position.z}`,
      });
      try {
        await collectSingleBlock(current, candidate, request.signal);
        total += 1;
        const name = nameById.get(candidate.type) ?? candidate.name;
        byName[name] = (byName[name] ?? 0) + 1;
        emit({
          kind: 'log',
          level: 'info',
          message: `[collect] mined ${candidate.name} in ${Date.now() - blockStart}ms`,
        });
      } catch (error) {
        if (request.signal.aborted) throw abortError();
        skipped += 1;
        emit({
          kind: 'log',
          level: 'warn',
          message: `[collect] skipped ${candidate.name} after ${Date.now() - blockStart}ms: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { total, byName, skipped, missingTool };
  }

  async function collectItemDrops(
    radius: number,
    signal?: AbortSignal,
  ): Promise<{ found: number; picked: number; inventoryDelta: Record<string, number> }> {
    return walkPickupDrops(requireBot(bot), radius, signal);
  }

  async function runCollectItem(options: {
    actionId: string;
    block?: string;
    item?: string;
    radius: number;
    maxCount: number;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult> {
    const current = requireBot(bot);
    const requestedBlock = options.block ? normalizeMinecraftLookupName(options.block) : undefined;
    const requestedItem = options.item ? normalizeMinecraftLookupName(options.item) : undefined;
    const woodName = (requestedItem && (GENERIC_TREE_NAMES.has(requestedItem) || isLogLikeName(requestedItem)))
      ? requestedItem
      : (requestedBlock && (GENERIC_TREE_NAMES.has(requestedBlock) || isLogLikeName(requestedBlock)))
        ? requestedBlock
        : undefined;

    if (woodName) {
      const started = Date.now();
      const result = await (dependencies.gatherWood ?? gatherWood)(
        current,
        options.maxCount,
        options.radius,
        options.signal,
        (progress) => emit({
          kind: 'log',
          level: progress.level ?? 'info',
          message: `[${options.actionId}] gather_wood ${progress.phase}: ${progress.message}`,
        }),
      );
      return {
        actionId: '',
        outcome: result.collected >= options.maxCount ? 'succeeded' : 'partial',
        summary: `collected ${result.collected} logs (requested at least ${options.maxCount})`,
        durationMs: Date.now() - started,
        inventoryDelta: Object.keys(result.broken).length
          ? result.broken
          : { log: result.collected },
        worldChanges: Object.entries(result.broken).map(([name, count]) => ({
          kind: 'block_broken' as const,
          name,
          count,
        })),
        observations: result.navigationFailures.map((failure, index) => ({
          id: `gather-wood.navigation.${index}`,
          at: Date.now(),
          severity: 'warning' as const,
          kind: 'navigation.failure',
          text: `${failure.reason}: ${failure.message}`,
          data: failure,
        })),
      };
    }

    const targetItem = requestedItem
      ?? (requestedBlock ? deriveDropItemForBlock(current, requestedBlock) : undefined);
    if (!targetItem) throw new Error('Missing Minecraft parameter: block or item');
    let sourceBlocks: string[];
    if (requestedBlock) {
      const resolved = resolveCollectBlock(current, requestedBlock, options.radius);
      if (!resolved) throw new Error(`Unknown Minecraft block: ${options.block}`);
      sourceBlocks = [resolved];
    } else {
      sourceBlocks = sourceBlocksForItem(current, targetItem);
      if (sourceBlocks.length === 0) {
        return actionFailure('', `cannot resolve source blocks for item ${targetItem}`, 'adapter_error');
      }
    }

    const started = Date.now();
    const before = inventoryCounts(current);

    let brokenTotal = 0;
    const brokenByName: Record<string, number> = {};
    let skippedTotal = 0;
    let missingToolTotal = 0;
    let observedTargetCount = before[targetItem] ?? 0;
    let sweepNumber = 0;
    const collection = await runAdaptiveCollection({
      targetCount: options.maxCount,
      initialRadius: options.radius,
      maxRadius: MAX_COLLECTION_SEARCH_RADIUS,
      maxSweeps: MAX_TARGET_ITEM_SWEEPS,
      collect: async ({ radius, quantity }) => {
        throwIfAborted(options.signal);
        sweepNumber += 1;
        const swept = await collectBlocks({
          blocks: sourceBlocks,
          quantity,
          radius,
          signal: options.signal,
        });
        brokenTotal += swept.total;
        skippedTotal += swept.skipped ?? 0;
        missingToolTotal += swept.missingTool ?? 0;
        for (const [name, count] of Object.entries(swept.byName)) {
          brokenByName[name] = (brokenByName[name] ?? 0) + count;
        }
        await collectItemDrops(radius, options.signal);
        const afterSweep = inventoryCounts(current);
        const currentTargetCount = afterSweep[targetItem] ?? 0;
        const gainedThisSweep = Math.max(0, currentTargetCount - observedTargetCount);
        observedTargetCount = currentTargetCount;
        const gainedTotal = Math.max(0, currentTargetCount - (before[targetItem] ?? 0));
        emit({
          kind: 'log',
          level: 'info',
          message: `[${options.actionId}] collect_item sweep=${sweepNumber} radius=${radius} requested=${quantity} broken=${brokenTotal} ${targetItem}=${gainedTotal}/${options.maxCount}`,
        });
        return {
          collectedBlocks: swept.total,
          gainedItems: gainedThisSweep,
          stop: (swept.missingTool ?? 0) > 0,
        };
      },
    });
    const reached = collection.reached;

    const after = inventoryCounts(current);
    const gained = Math.max(0, (after[targetItem] ?? 0) - (before[targetItem] ?? 0));
    const sourceText = sourceBlocks.join(', ');
    const worldChanges: MinecraftActionResult['worldChanges'] = Object.entries(brokenByName).map(([name, count]) => ({
      kind: 'block_broken',
      name,
      count,
    }));
    const skippedText = skippedTotal > 0 ? `（另有 ${skippedTotal} 块存在但无法到达）` : '';
    const missingToolText = missingToolTotal > 0
      ? `；另有 ${missingToolTotal} 块因缺少可开采工具无法采集，请先用 craft_item 制作所需工具（如 stone_pickaxe）再重试`
      : '';
    const observations: MinecraftActionResult['observations'] = reached ? [] : [{
      id: `collect.exhausted:${started}`,
      at: Date.now(),
      severity: 'warning',
      kind: 'collect.exhausted',
      text: `No more ${sourceText} within ${collection.finalRadius} blocks${skippedText}${missingToolText}.`,
      data: { sourceBlocks, radius: collection.finalRadius, skipped: skippedTotal, missingTool: missingToolTotal },
    }];
    if (missingToolTotal > 0) {
      observations.push({
        id: `collect.missing-tool:${started}`,
        at: Date.now(),
        severity: 'warning',
        kind: 'collect.missing-tool',
        text: `缺少可开采工具：${missingToolTotal} 块因无合适工具未采集，请先用 craft_item 制作所需工具（如 stone_pickaxe）再重试。`,
        data: { missingTool: missingToolTotal },
      });
    }
    return {
      actionId: '',
      outcome: reached ? 'succeeded' : 'partial',
      summary: reached
        ? `collected ${gained} ${targetItem} by breaking ${brokenTotal} ${sourceText}`
        : `collected ${gained}/${options.maxCount} ${targetItem} by breaking ${brokenTotal} ${sourceText}${missingToolText}${skippedText}${missingToolTotal === 0 && skippedTotal === 0 ? `; no more ${sourceText} nearby, consider searching another area` : ''}`,
      durationMs: Date.now() - started,
      inventoryDelta: inventoryDifference(before, after),
      worldChanges,
      observations,
    };
  }

  async function runCraftItem(options: {
    actionId: string;
    item: string;
    quantity?: number;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult> {
    const current = requireBot(bot);
    const quantity = Math.max(1, Math.trunc(options.quantity ?? 1));
    const started = Date.now();
    const before = inventoryCounts(current);
    let plan = planCraft(current, options.item, quantity);
    if (!plan.recipeAvailable) {
      return {
        actionId: '',
        outcome: 'failed',
        summary: `cannot craft ${options.item}: unknown item`,
        durationMs: Date.now() - started,
        inventoryDelta: {},
        worldChanges: [],
        observations: [],
        error: { code: 'unknown_item', recoverable: false, details: { item: options.item } },
      };
    }
    if (!plan.canCraftNow) {
      let missing = plan.missing;
      let sources = plan.sources;
      let furnaceChecked = false;
      if (furnaceCanHelp(plan)) {
        try {
          const furnaceState = await readNearbyFurnaceState(current, options.signal);
          const adjusted = deductMissingFromFurnace(plan, furnaceState);
          if (Object.keys(adjusted.offsetByFurnace).length > 0) {
            const offsetText = Object.entries(adjusted.offsetByFurnace)
              .map(([name, count]) => `${count}x ${name}`)
              .join('、');
            emit({
              kind: 'log',
              level: 'info',
              message: `[craft] ${plan.targetItem}: 附近熔炉抵扣 ${offsetText}，继续按计划执行`,
            });
          }
          missing = adjusted.missing;
          sources = adjusted.sources;
          furnaceChecked = furnaceState !== undefined;
        } catch (error) {
          if (options.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
            return craftFailure('cancelled', 'craft cancelled', started);
          }
        }
      }
      if (Object.keys(missing).length > 0) {
        const missingText = Object.entries(missing)
          .map(([name, count]) => `${count}x ${name}${sources[name] ? `（${sources[name]}）` : ''}`)
          .join('，');
        return {
          actionId: '',
          outcome: 'failed',
          summary: `cannot craft ${plan.targetItem}: missing ${missingText}`,
          durationMs: Date.now() - started,
          inventoryDelta: {},
          worldChanges: [],
          observations: [{
            id: `craft.missing:${started}`,
            at: Date.now(),
            severity: 'warning',
            kind: 'craft.missing',
            text: `缺少材料：${missingText}。${furnaceChecked ? '已检查附近熔炉，仍不足以补齐缺口，' : ''}请先收集后再重试 craft_item。`,
            data: { missing, sources },
          }],
          error: { code: 'missing_item', recoverable: true, details: { missing, sources } },
        };
      }
    }

    let placedTable = false;
    try {
      if (plan.requiresCraftingTable) {
        const ensured = await ensureCraftingTableFor(current, options.signal);
        placedTable ||= ensured.placed;
        plan = planCraft(current, options.item, quantity);
        if (!plan.canCraftNow) {
          const missingText = Object.entries(plan.missing)
            .map(([name, count]) => `${count}x ${name}`)
            .join(', ');
          throw createCraftError(
            'missing_item',
            `cannot craft ${plan.targetItem} after preparing a crafting table: missing ${missingText || 'materials'}`,
          );
        }
      }
      await executeCraftPlanSteps(current, plan, options.signal, plan.targetItem, (placed) => {
        if (placed) placedTable = true;
      });
    } catch (error) {
      const cancelled = options.signal.aborted
        || (error instanceof Error && error.name === 'AbortError');
      const code = error instanceof Error && error.name === 'InventoryFullError'
        ? 'inventory_full'
        : cancelled
          ? 'cancelled'
          : craftErrorCode(error) ?? 'adapter_error';
      return craftFailure(
        code,
        cancelled ? 'craft cancelled' : `craft failed: ${error instanceof Error ? error.message : String(error)}`,
        started,
        { originalError: error instanceof Error ? error.message : String(error) },
      );
    }

    const after = inventoryCounts(current);
    const gained = Math.max(0, (after[plan.targetItem] ?? 0) - (before[plan.targetItem] ?? 0));
    const reached = gained >= quantity;
    return {
      actionId: '',
      outcome: reached ? 'succeeded' : 'partial',
      summary: reached
        ? `crafted ${gained} ${plan.targetItem}`
        : `crafted ${gained}/${quantity} ${plan.targetItem}`,
      durationMs: Date.now() - started,
      inventoryDelta: inventoryDifference(before, after),
      worldChanges: placedTable ? [{ kind: 'block_placed', name: 'crafting_table', count: 1 }] : [],
      observations: [],
    };
  }

  async function executeCraftPlanSteps(
    current: any,
    plan: CraftPlan,
    signal?: AbortSignal,
    targetItem?: string,
    onPlaced?: (placed: boolean) => void,
  ): Promise<void> {
    for (const step of plan.steps) {
      throwIfAborted(signal);
      const have = inventoryCounts(current)[step.item] ?? 0;
      const need = step.item === targetItem
        ? step.amount
        : Math.max(0, step.amount - have);
      if (need <= 0) continue;
      if ((current.inventory?.emptySlotCount?.() ?? 1) === 0) {
        const error = new Error(`inventory is full; cannot craft ${step.item}`);
        error.name = 'InventoryFullError';
        throw error;
      }
      if (step.kind === 'smelt') {
        const smeltInput = Object.keys(step.ingredients).find((name) => name !== SMELT_FUEL_ITEM);
        if (!smeltInput) throw new Error(`cannot smelt ${step.item}: unknown input`);
        const smeltCount = step.craftCount ?? Math.ceil(need / step.outputPerCraft);
        const expectedOutput = smeltCount * step.outputPerCraft;
        emit({
          kind: 'log',
          level: 'info',
          message: `[craft] step ${step.item} x${expectedOutput} (smelt ${smeltCount}x ${smeltInput} + ${step.ingredients[SMELT_FUEL_ITEM] ?? 0}x ${SMELT_FUEL_ITEM})`,
        });
        await smeltItems(current, smeltInput, step.item, smeltCount, signal);
        const produced = Math.max(0, (inventoryCounts(current)[step.item] ?? 0) - have);
        if (produced < expectedOutput) {
          throw new Error(`smelt output mismatch for ${step.item}: expected ${expectedOutput}, got ${produced}`);
        }
        emit({
          kind: 'log',
          level: 'info',
          message: `[craft] verified ${step.item} +${produced} (needed ${step.amount})`,
        });
        continue;
      }
      const craftCount = step.craftCount ?? Math.ceil(need / step.outputPerCraft);
      const expectedOutput = craftCount * step.outputPerCraft;
      let table: any;
      if (step.requiresCraftingTable) {
        const ensured = await ensureCraftingTableFor(current, signal);
        table = ensured.table;
        onPlaced?.(ensured.placed);
        await moveNearBlock(current, table.position, signal);
      }
      const firstRecipe = pickCraftRecipe(current, step, table, 1);
      if (!firstRecipe) {
        const missingText = Object.entries(step.ingredients)
          .filter(([name, count]) => availableIngredientCount(current, name) < count)
          .map(([name, count]) => `${count}x ${name}`)
          .join('，');
          throw createCraftError(
            'recipe_unavailable',
            `cannot craft ${step.item}: missing ${missingText || 'materials'}`,
          );
      }
      emit({
        kind: 'log',
        level: 'info',
        message: `[craft] step ${step.item} x${craftCount}${table ? ' (crafting table)' : ''}`,
      });
      for (let index = 0; index < craftCount; index += 1) {
        throwIfAborted(signal);
        const recipe = index === 0
          ? firstRecipe
          : pickCraftRecipe(current, step, table, 1);
        if (!recipe) {
          throw createCraftError(
            'recipe_unavailable',
            `cannot craft ${step.item}: materials changed during crafting`,
          );
        }
        const beforeRecipe = inventoryCounts(current);
        const beforeOutput = beforeRecipe[step.item] ?? 0;
        const expectedRecipeOutput = Math.max(
          1,
          Number(recipe.result?.count ?? step.outputPerCraft),
        );
        try {
          await current.craft(recipe, 1, table ?? null);
        } catch (error) {
          throw createCraftError(
            'craft_rejected',
            `craft rejected for ${step.item}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const optimisticOutput = inventoryCounts(current)[step.item] ?? 0;
        await waitForServerInventoryBarrier(current, signal);
        const confirmedOutput = inventoryCounts(current)[step.item] ?? 0;
        const confirmedGain = confirmedOutput - beforeOutput;
        if (confirmedGain < expectedRecipeOutput) {
          const optimisticGain = optimisticOutput - beforeOutput;
          const rolledBack = optimisticGain >= expectedRecipeOutput;
          throw createCraftError(
            rolledBack ? 'inventory_desync' : 'craft_rejected',
            rolledBack
              ? `craft inventory rolled back for ${step.item}: expected +${expectedRecipeOutput}, got +${Math.max(0, confirmedGain)}`
              : `craft server confirmation did not produce ${step.item}: expected +${expectedRecipeOutput}, got +${Math.max(0, confirmedGain)}`,
          );
        }
        emit({
          kind: 'log',
          level: 'info',
          message: `[craft] server confirmed ${step.item} recipe ${index + 1}/${craftCount} (+${confirmedGain})`,
        });
      }
      const confirmed = inventoryCounts(current);
      const gained = Math.max(0, (confirmed[step.item] ?? 0) - have);
      emit({
        kind: 'log',
        level: 'info',
        message: `[craft] verified ${step.item} +${gained} (needed ${step.amount})`,
      });
    }
  }

  async function ensureCraftingTableFor(
    current: any,
    signal?: AbortSignal,
  ): Promise<{ table: any; placed: boolean }> {
    if (knownCraftingTable) {
      const cached = current.blockAt(knownCraftingTable);
      if (
        cached?.name === 'crafting_table'
        && await canReachWorkstation(current, cached, 'crafting_table', signal)
      ) {
        return { table: cached, placed: false };
      }
      knownCraftingTable = undefined;
    }
    const found = findCraftingTable(current, 32);
    if (found && await canReachWorkstation(current, found, 'crafting_table', signal)) {
      knownCraftingTable = found.position;
      return { table: found, placed: false };
    }
    // 背包里已有工作台：直接复用放置，不再重复合成
    const carried = current.inventory?.items?.().find((item: any) => item.name === 'crafting_table');
    if (carried) {
      const placed = await placeBlockAt(current, carried, undefined, 'auto', signal);
      knownCraftingTable = placed.position;
      emit({ kind: 'log', level: 'info', message: '[craft] placed a carried crafting table for crafting' });
      return { table: placed, placed: true };
    }

    const tablePlan = planCraft(current, 'crafting_table', 1);
    if (!tablePlan.recipeAvailable || !tablePlan.canCraftNow) {
      const missingText = Object.entries(tablePlan.missing)
        .map(([name, count]) => `${count}x ${name}`)
        .join('，');
      throw new Error(`cannot craft crafting table: missing ${missingText}`);
    }
    await executeCraftPlanSteps(current, tablePlan, signal, 'crafting_table');
    const tableItem = current.inventory?.items?.().find((item: any) => item.name === 'crafting_table');
    if (!tableItem) throw new Error('crafted crafting table but it is not in inventory');
    const placed = await placeBlockAt(current, tableItem, undefined, 'auto', signal);
    knownCraftingTable = placed.position;
    emit({ kind: 'log', level: 'info', message: '[craft] placed a crafting table for crafting' });
    return { table: placed, placed: true };
  }

  async function ensureFurnaceFor(
    current: any,
    signal?: AbortSignal,
  ): Promise<{ furnace: any; placed: boolean }> {
    const found = findFurnaceBlock(current, 32);
    if (found && await canReachWorkstation(current, found, 'furnace', signal)) {
      return { furnace: found, placed: false };
    }
    // 背包里已有熔炉：直接复用放置，不再重复合成
    const carried = current.inventory?.items?.().find((item: any) => item.name === 'furnace');
    if (carried) {
      const placed = await placeBlockAt(current, carried, undefined, 'auto', signal);
      emit({ kind: 'log', level: 'info', message: '[smelt] placed a carried furnace for smelting' });
      return { furnace: placed, placed: true };
    }
    const furnacePlan = planCraft(current, 'furnace', 1);
    if (!furnacePlan.recipeAvailable || !furnacePlan.canCraftNow) {
      const missingText = Object.entries(furnacePlan.missing)
        .map(([name, count]) => `${count}x ${name}`)
        .join('，');
      throw new Error(`cannot craft furnace: missing ${missingText}`);
    }
    await executeCraftPlanSteps(current, furnacePlan, signal, 'furnace');
    const furnaceItem = current.inventory?.items?.().find((item: any) => item.name === 'furnace');
    if (!furnaceItem) throw new Error('crafted furnace but it is not in inventory');
    const placed = await placeBlockAt(current, furnaceItem, undefined, 'auto', signal);
    emit({ kind: 'log', level: 'info', message: '[smelt] placed a furnace for smelting' });
    return { furnace: placed, placed: true };
  }

  async function canReachWorkstation(
    current: any,
    block: any,
    workstation: 'crafting_table' | 'furnace',
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      await moveNearBlock(current, block.position, signal);
      return true;
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      emit({
        kind: 'log',
        level: 'warn',
        message: `[craft] ignoring unreachable ${workstation} at ${formatPosition(block.position)}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  }

  interface NearbyFurnaceState {
    input?: { name: string; count: number };
    fuel?: { name: string; count: number };
    output?: { name: string; count: number };
  }

  // 计划期抵扣：只有缺口与熔炼相关时才值得去读附近熔炉（避免为无关缺口白跑一趟）
  function furnaceCanHelp(plan: CraftPlan): boolean {
    const smeltSteps = plan.steps.filter((step) => step.kind === 'smelt');
    if (smeltSteps.length === 0) return false;
    const related = new Set<string>([SMELT_FUEL_ITEM]);
    for (const step of smeltSteps) {
      related.add(step.item);
      for (const ingredient of Object.keys(step.ingredients)) related.add(ingredient);
    }
    return Object.keys(plan.missing).some((name) => related.has(name));
  }

  // 读取附近熔炉（32 格，与附近工作台/熔炉的判定一致）的输入、燃料、输出槽状态；只读不改。
  async function readNearbyFurnaceState(
    current: any,
    signal?: AbortSignal,
  ): Promise<NearbyFurnaceState | undefined> {
    const furnace = findFurnaceBlock(current, 32);
    if (!furnace) return undefined;
    try {
      await moveNearBlock(current, furnace.position, signal);
      const window = await current.openFurnace(furnace);
      try {
        const nameById = new Map<number, string>();
        for (const [name, item] of Object.entries(current.registry?.itemsByName ?? {})) {
          if (typeof (item as any)?.id === 'number') nameById.set((item as any).id, name);
        }
        const readSlot = (item: any): { name: string; count: number } | undefined => {
          if (!item) return undefined;
          const name = typeof item.name === 'string'
            ? item.name
            : typeof item.type === 'number'
              ? nameById.get(item.type)
              : undefined;
          if (!name) return undefined;
          return { name, count: item.count ?? 0 };
        };
        return {
          input: readSlot(window.inputItem?.()),
          fuel: readSlot(window.fuelItem?.()),
          output: readSlot(window.outputItem?.()),
        };
      } finally {
        window.close?.();
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      emit({
        kind: 'log',
        level: 'warn',
        message: `[smelt] could not read nearby furnace state: ${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
  }

  // 用熔炉槽位抵扣计划缺口：
  // - 熔炼步骤的输入缺口由「输入槽已有原料 + 已烧好的成品数」覆盖（成品说明原料已被消耗）；
  // - 燃料缺口由「燃料槽已有燃料 + 成品对应的燃料份额」覆盖；
  // - 缺口本身是熔炼成品名时，直接由输出槽覆盖（兜底）。
  function deductMissingFromFurnace(
    plan: CraftPlan,
    state: NearbyFurnaceState | undefined,
  ): { missing: Record<string, number>; sources: Record<string, string>; offsetByFurnace: Record<string, number> } {
    const missing: Record<string, number> = { ...plan.missing };
    const offsetByFurnace: Record<string, number> = {};
    if (state) {
      const offset = (name: string, amount: number) => {
        const need = missing[name] ?? 0;
        if (amount <= 0 || need <= 0) return;
        const used = Math.min(need, amount);
        missing[name] = need - used;
        offsetByFurnace[name] = (offsetByFurnace[name] ?? 0) + used;
        if (missing[name] <= 0) delete missing[name];
      };
      for (const step of plan.steps) {
        if (step.kind !== 'smelt') continue;
        const stepInput = Object.keys(step.ingredients).find((name) => name !== SMELT_FUEL_ITEM);
        if (!stepInput) continue;
        const finished = state.output?.name === step.item ? Math.min(state.output.count, step.amount) : 0;
        const inputInSlot = state.input?.name === stepInput ? state.input.count : 0;
        const fuelInSlot = state.fuel?.name === SMELT_FUEL_ITEM ? state.fuel.count : 0;
        offset(stepInput, inputInSlot + finished);
        offset(SMELT_FUEL_ITEM, fuelInSlot + Math.ceil(finished / SMELT_ITEMS_PER_FUEL));
      }
      if (state.output) offset(state.output.name, state.output.count);
    }
    const sources: Record<string, string> = {};
    for (const name of Object.keys(missing)) {
      if (plan.sources[name]) sources[name] = plan.sources[name];
    }
    return { missing, sources, offsetByFurnace };
  }

  async function smeltItems(
    current: any,
    inputName: string,
    outputName: string,
    quantity: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const inputId = current.registry?.itemsByName?.[inputName]?.id;
    const outputId = current.registry?.itemsByName?.[outputName]?.id;
    if (inputId === undefined || outputId === undefined) {
      throw new Error(`unknown smelt items: ${inputName} -> ${outputName}`);
    }
    const { furnace } = await ensureFurnaceFor(current, signal);
    await moveNearBlock(current, furnace.position, signal);
    const window = await current.openFurnace(furnace);
    try {
      let gained = 0;
      while (gained < quantity) {
        throwIfAborted(signal);
        const batch = Math.min(64, quantity - gained);
        const fuelItemId = current.registry?.itemsByName?.[SMELT_FUEL_ITEM]?.id;
        // 先读熔炉槽位，只补差额（上一次失败可能已把料放进炉子）
        const currentInput = window.inputItem?.();
        const currentFuel = window.fuelItem?.();
        const currentOutput = window.outputItem?.();
        const inputPresent = currentInput && currentInput.type === inputId ? currentInput.count : 0;
        const fuelPresent = currentFuel && currentFuel.type === fuelItemId ? currentFuel.count : 0;
        const outputPresent = currentOutput && currentOutput.type === outputId ? currentOutput.count : 0;
        const inputShortfall = Math.max(0, batch - inputPresent - outputPresent);
        const fuelNeededCoal = Math.ceil(Math.max(0, batch - outputPresent) / SMELT_ITEMS_PER_FUEL);
        const fuelShortfall = Math.max(0, fuelNeededCoal - fuelPresent);
        const haveInput = inventoryCounts(current)[inputName] ?? 0;
        const haveFuel = inventoryCounts(current)[SMELT_FUEL_ITEM] ?? 0;
        if (haveInput < inputShortfall) {
          throw new Error(`cannot smelt ${outputName}: missing ${inputShortfall}x ${inputName}`);
        }
        if (haveFuel < fuelShortfall) {
          throw new Error(`cannot smelt ${outputName}: missing ${fuelShortfall}x ${SMELT_FUEL_ITEM}`);
        }
        emit({
          kind: 'log',
          level: 'info',
          message: `[smelt] batch ${batch}x ${inputName} -> ${outputName} (fuel ${fuelNeededCoal}x ${SMELT_FUEL_ITEM})`,
        });
        const inputItem = current.inventory?.items?.().find((item: any) => item.name === inputName);
        const fuelItem = current.inventory?.items?.().find((item: any) => item.name === SMELT_FUEL_ITEM);
        if (inputShortfall > 0 && inputItem) {
          await reconcileFurnaceSlot(
            () => window.putInput(inputItem.type, inputItem.metadata, inputShortfall),
            () => window.inputItem?.(),
            inputId,
            inputItem.metadata,
            batch,
            signal,
          );
        }
        if (fuelShortfall > 0 && fuelItem) {
          await delay(400, signal);
          await reconcileFurnaceSlot(
            () => window.putFuel(fuelItem.type, fuelItem.metadata, fuelShortfall),
            () => window.fuelItem?.(),
            fuelItem.type,
            fuelItem.metadata,
            fuelNeededCoal,
            signal,
          );
        }
        await waitForSmeltBatch(window, batch, signal);
        const output = window.outputItem();
        if (output) await window.takeOutput();
        gained += batch;
        emit({
          kind: 'log',
          level: 'info',
          message: `[smelt] verified ${outputName} +${gained}/${quantity}`,
        });
      }
    } finally {
      window.close?.();
    }
  }

  // 对账式放料：报错后重读熔炉槽位，若点击实际已生效（1.11.2 窗口失步误报）则视为成功；
  // 否则重试一次差额，仍失败才抛出。绝不盲目重试（避免重复放入）也不取回（避免抽走正在烧的料）。
  async function reconcileFurnaceSlot(
    operation: () => Promise<void>,
    readSlot: () => any,
    itemType: number,
    metadata: number,
    targetCount: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const slotHasEnough = () => {
      const slot = readSlot();
      return slot && slot.type === itemType && slot.metadata === metadata && slot.count >= targetCount;
    };
    if (slotHasEnough()) return;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      throwIfAborted(signal);
      try {
        await operation();
      } catch (error) {
        lastError = error;
        emit({
          kind: 'log',
          level: 'warn',
          message: `[smelt] window click reported error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (slotHasEnough()) return; // 点击实际生效（被误报），对账通过
      await delay(400 * attempt, signal);
    }
    throw lastError ?? new Error('furnace slot reconciliation failed');
  }

  async function waitForSmeltBatch(
    window: any,
    batch: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const started = Date.now();
    const timeoutMs = batch * 12_000 + 15_000;
    while (Date.now() - started < timeoutMs) {
      throwIfAborted(signal);
      const output = window.outputItem?.();
      if (output && (output.count ?? 0) >= batch) return;
      await delay(500, signal);
    }
    throw new Error(`smelting timed out after ${Math.round((Date.now() - started) / 1000)}s`);
  }

  async function runSmeltItem(options: {
    actionId: string;
    item?: string;
    block?: string;
    quantity: number;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult> {
    const current = requireBot(bot);
    const started = Date.now();
    const before = inventoryCounts(current);
    const quantity = Math.max(1, Math.min(64, Math.trunc(options.quantity ?? 1)));
    const nameById = new Map<number, string>();
    for (const [name, item] of Object.entries(current.registry?.itemsByName ?? {})) {
      if (typeof (item as any)?.id === 'number') nameById.set((item as any).id, name);
    }
    let inputName: string | undefined;
    let outputName: string | undefined;
    if (options.item) {
      outputName = normalizeMinecraftLookupName(options.item);
      const outputId = current.registry?.itemsByName?.[outputName]?.id;
      const availableItems = new Map<string, number>();
      for (const inventoryItem of current.inventory?.items?.() ?? []) {
        availableItems.set(
          inventoryItem.name,
          (availableItems.get(inventoryItem.name) ?? 0) + Math.max(0, Number(inventoryItem.count ?? 1)),
        );
      }
      const inputId = outputId !== undefined
        ? smeltInputFor(current.registry, outputId, recipesSourceFor(current), availableItems, quantity)
        : undefined;
      if (inputId === undefined) {
        return craftFailure('unknown_item', `cannot smelt ${options.item}: not a furnace product`, started);
      }
      inputName = nameById.get(inputId);
    } else if (options.block) {
      inputName = normalizeMinecraftLookupName(options.block);
      const inputId = current.registry?.itemsByName?.[inputName]?.id;
      const outputId = inputId !== undefined
        ? smeltOutputFor(current.registry, inputId, recipesSourceFor(current))
        : undefined;
      if (outputId === undefined) {
        return craftFailure('unknown_item', `cannot smelt ${options.block}: not a smeltable input`, started);
      }
      outputName = nameById.get(outputId);
    } else {
      return craftFailure('adapter_error', 'Missing Minecraft parameter: block or item', started);
    }
    if (!inputName || !outputName) {
      return craftFailure('unknown_item', 'cannot resolve smelt items', started);
    }
    try {
      await smeltItems(current, inputName, outputName, quantity, options.signal);
    } catch (error) {
      const cancelled = options.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      return craftFailure(
        cancelled ? 'cancelled' : 'adapter_error',
        cancelled ? 'smelt cancelled' : `smelt failed: ${error instanceof Error ? error.message : String(error)}`,
        started,
        { originalError: error instanceof Error ? error.message : String(error) },
      );
    }
    const after = inventoryCounts(current);
    const gained = Math.max(0, (after[outputName] ?? 0) - (before[outputName] ?? 0));
    return {
      actionId: '',
      outcome: gained >= quantity ? 'succeeded' : 'partial',
      summary: gained >= quantity
        ? `smelted ${gained} ${outputName}`
        : `smelted ${gained}/${quantity} ${outputName}`,
      durationMs: Date.now() - started,
      inventoryDelta: inventoryDifference(before, after),
      worldChanges: [],
      observations: [],
    };
  }

  async function placeBlockAt(
    current: any,
    item: any,
    explicitTarget: Vec3 | undefined,
    face: string,
    signal?: AbortSignal,
  ): Promise<any> {
    const normalizedFace = face || 'auto';
    let target: Vec3;
    let placeOn: PlaceFace;
    let preferredDir: Vec3 | undefined;
    if (explicitTarget) {
      target = explicitTarget;
      const spec = resolveExplicitPlacement(current, target, normalizedFace);
      if (!spec) throw new Error(`cannot place ${item.name} at ${target.toString()} with face ${normalizedFace}`);
      preferredDir = spec.faceVector;
      placeOn = placementFaceFor(spec.faceVector);
    } else {
      let auto = findAutoPlacement(current);
      if (!auto) {
        // 没有现成空间：自动清障创造放置空间（挖掉身边可挖方块）
        const cleared = await clearSpaceForPlacement(current, signal);
        auto = cleared.ok ? findAutoPlacement(current) : undefined;
        if (!auto) {
          emit({
            kind: 'log',
            level: 'warn',
            message: `[place-debug] no free space for ${item.name} and auto clearance failed: ${cleared.details}`,
          });
          throw new Error(
            `no free space to place ${item.name}${cleared.clearedCount > 0 ? ` after clearing ${cleared.clearedCount} block(s)` : ''}; consider moving to an open area`,
          );
        }
      }
      target = auto.target;
      preferredDir = auto.spec.faceVector;
      placeOn = placementFaceFor(auto.spec.faceVector);
    }

    // 清空占用、过近躲避、走近、装备、放置、状态处理：全部交给 AIRI 移植的 placeBlockAt
    const referenceBlock = preferredDir ? current.blockAt(target.minus(preferredDir)) : undefined;
    emit({
      kind: 'log',
      level: 'info',
      message: `[place-debug] select ${item.name} target=${target.toString()} face=(${preferredDir?.x ?? 0},${preferredDir?.y ?? 0},${preferredDir?.z ?? 0}) ref=${referenceBlock?.name ?? 'none'} bot=${current.entity?.position ? formatPosition(current.entity.position) : 'none'} dist=${distanceToBot(current, target).toFixed(1)}`,
    });
    let placementError: unknown;
    try {
      await airiPlaceBlockAt(current, item, target, placeOn, { preferredDir, signal });
    } catch (error) {
      placementError = error;
      emit({
        kind: 'log',
        level: 'warn',
        message: `[place-debug] placeBlock error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    // 放置结果以世界实况为准：在期望点周边找实际落下的方块，找不到才视为真实失败
    let placed: any;
    for (let attempt = 0; attempt < 8 && !placed; attempt += 1) {
      placed = locatePlacedBlock(current, target, item.name);
      if (!placed) await delay(250, signal);
    }
    if (!placed) {
      emit({
        kind: 'log',
        level: 'warn',
        message: `[place-debug] not placed around ${target.toString()} after 8 polls; error=${placementError instanceof Error ? placementError.message : String(placementError)}; bot now=${current.entity?.position ? formatPosition(current.entity.position) : 'none'}`,
      });
      if (placementError) throw placementError;
      throw new Error(`${item.name} placement failed`);
    }
    if (placementError) {
      emit({ kind: 'log', level: 'warn', message: `[place] placeBlock reported an error but the ${item.name} was placed` });
    }
    return placed;
  }

  function placementFaceFor(faceVector: Vec3): PlaceFace {
    if (faceVector.y > 0) return 'bottom'; // 放地面：参考在下方、面向上
    if (faceVector.y < 0) return 'top'; // 贴天花板
    return 'side'; // 贴墙
  }

  function faceVectorFor(face: string): Vec3 {
    switch (face) {
      case 'bottom': return new Vec3(0, -1, 0);
      case 'north': return new Vec3(0, 0, -1);
      case 'south': return new Vec3(0, 0, 1);
      case 'west': return new Vec3(-1, 0, 0);
      case 'east': return new Vec3(1, 0, 0);
      case 'top':
      default: return new Vec3(0, 1, 0);
    }
  }

  function resolvePlacementSpec(
    current: any,
    target: Vec3,
    face: string,
  ): { reference: any; faceVector: Vec3 } | null {
    const faceVector = faceVectorFor(face);
    const reference = current.blockAt(target.minus(faceVector));
    if (!reference || isReplaceableForPlacement(reference)) {
      return null;
    }
    const spot = current.blockAt(target);
    if (!spot || !isReplaceableForPlacement(spot)) return null;
    return { reference, faceVector };
  }

  function resolveAutoPlacementSpec(
    current: any,
    target: Vec3,
  ): { reference: any; faceVector: Vec3 } | null {
    for (const face of ['top', 'north', 'south', 'east', 'west', 'bottom']) {
      const spec = resolvePlacementSpec(current, target, face);
      if (spec) return spec;
    }
    return null;
  }

  function resolveExplicitPlacement(
    current: any,
    target: Vec3,
    face: string,
  ): { reference: any; faceVector: Vec3 } | null {
    const faces = face === 'auto' ? ['top', 'north', 'south', 'east', 'west', 'bottom'] : [face];
    for (const candidate of faces) {
      const faceVector = faceVectorFor(candidate);
      const reference = current.blockAt(target.minus(faceVector));
      if (!reference || isReplaceableForPlacement(reference)) {
        continue;
      }
      return { reference, faceVector };
    }
    return null;
  }

  function findAutoPlacement(current: any): { target: Vec3; spec: { reference: any; faceVector: Vec3 } } | undefined {
    const ground = findFreePlacePosition(current, 6);
    if (ground) {
      const spec = resolvePlacementSpec(current, ground, 'top');
      if (spec) return { target: ground, spec };
    }
    // 墙面兜底（对齐 AIRI findPlacementSpot）：找"落点可放置且至少一侧有实心参考"的最近点
    const own = current.entity?.position;
    if (!own || typeof current.blockAt !== 'function') return undefined;
    const baseX = Math.floor(Number(own.x ?? 0));
    const baseY = Math.floor(Number(own.y ?? 0));
    const baseZ = Math.floor(Number(own.z ?? 0));
    const candidates: Array<{ target: Vec3; spec: { reference: any; faceVector: Vec3 }; distance: number }> = [];
    for (let dx = -4; dx <= 4; dx += 1) {
      for (let dz = -4; dz <= 4; dz += 1) {
        if (Math.abs(dx) + Math.abs(dz) < 1) continue;
        for (let dy = -1; dy <= 1; dy += 1) {
          const target = new Vec3(baseX + dx, baseY + dy, baseZ + dz);
          const spec = resolveAutoPlacementSpec(current, target);
          if (!spec) continue;
          candidates.push({ target, spec, distance: distanceToBot(current, target) });
        }
      }
    }
    candidates.sort((left, right) => left.distance - right.distance);
    return candidates[0];
  }

  interface ClearSpaceResult {
    ok: boolean;
    clearedCount: number;
    details: string;
  }

  const UNBREAKABLE_BLOCK_NAMES = new Set([
    'bedrock', 'barrier', 'command_block', 'end_portal', 'end_portal_frame',
    'nether_portal', 'obsidian',
  ]);
  const HAZARD_FLUID_NAMES = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
  const FALLING_BLOCK_NAMES = new Set(['sand', 'red_sand', 'gravel', 'anvil', 'dragon_egg']);

  function isHazardousNeighbor(current: any, target: Vec3): boolean {
    const neighbors: Array<[number, number, number]> = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    ];
    for (const [dx, dy, dz] of neighbors) {
      const neighbor = current.blockAt(target.offset(dx, dy, dz));
      if (neighbor && HAZARD_FLUID_NAMES.has(neighbor.name)) return true;
    }
    return false;
  }

  // 挖掉目标后，上方易下落的方块（沙子/沙砾/铁砧）会掉下来重新占位，跳过
  function willCollapseInto(current: any, target: Vec3): boolean {
    const above = current.blockAt(target.offset(0, 1, 0));
    return Boolean(above && FALLING_BLOCK_NAMES.has(above.name));
  }

  // 没有现成放置点时：在 bot 身边找可挖方块，挖掉 1 块创造放置平台（AIRI clearBlockSpace 扩展）。
  // 挖完立刻重查放置点；所有候选都失败才返回失败详情，方便调试。
  async function clearSpaceForPlacement(current: any, signal?: AbortSignal): Promise<ClearSpaceResult> {
    const own = current.entity?.position;
    if (!own || typeof current.blockAt !== 'function') {
      return { ok: false, clearedCount: 0, details: 'bot position or blockAt unavailable' };
    }
    const baseX = Math.floor(Number(own.x ?? 0));
    const baseY = Math.floor(Number(own.y ?? 0));
    const baseZ = Math.floor(Number(own.z ?? 0));
    const candidates: Array<{ target: Vec3; name: string; distance: number }> = [];
    for (let dx = -3; dx <= 3; dx += 1) {
      for (let dz = -3; dz <= 3; dz += 1) {
        if (Math.abs(dx) + Math.abs(dz) < 1) continue;
        for (let dy = 0; dy <= 2; dy += 1) {
          const target = new Vec3(baseX + dx, baseY + dy, baseZ + dz);
          const below = current.blockAt(target.offset(0, -1, 0));
          if (!below || isReplaceableForPlacement(below)) continue; // 下方必须实心
          const block = current.blockAt(target);
          if (!block || isReplaceableForPlacement(block)) continue; // 目标位必须可挖（非空气/植物）
          if (UNBREAKABLE_BLOCK_NAMES.has(block.name)) continue;
          if (isHazardousNeighbor(current, target) || willCollapseInto(current, target)) continue;
          candidates.push({ target, name: block.name, distance: distanceToBot(current, target) });
        }
      }
    }
    candidates.sort((left, right) => left.distance - right.distance);
    const failures: string[] = [];
    let clearedCount = 0;
    for (const candidate of candidates) {
      throwIfAborted(signal);
      const block = current.blockAt(candidate.target);
      if (!block || isReplaceableForPlacement(block)) continue; // 已被其他动作清掉
      try {
        try {
          await current.tool?.equipForBlock?.(block);
        } catch {
          // 没有合适工具也允许继续（手挖更慢但不阻塞清障）
        }
        await breakBlockAt(current, candidate.target, signal);
        clearedCount += 1;
        // 等待方块更新后重查放置点
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await delay(250, signal);
          if (findAutoPlacement(current)) return { ok: true, clearedCount, details: 'ok' };
        }
        failures.push(`${candidate.target.toString()} (${candidate.name}): cleared but no placement spot formed`);
      } catch (error) {
        failures.push(`${candidate.target.toString()} (${candidate.name}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      ok: false,
      clearedCount,
      details: failures.length > 0 ? failures.join('; ') : 'no clearable candidates nearby',
    };
  }

  function locatePlacedBlock(current: any, around: Vec3, blockName: string): any | undefined {
    if (typeof current.blockAt !== 'function') return undefined;
    let best: any;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -2; dz <= 2; dz += 1) {
          const block = current.blockAt(around.offset(dx, dy, dz));
          if (block?.name !== blockName) continue;
          const distance = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = block;
          }
        }
      }
    }
    return best;
  }

  async function runPlaceBlock(options: {
    actionId: string;
    block: string;
    position?: { x: number; y: number; z: number };
    face?: string;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult> {
    const current = requireBot(bot);
    const started = Date.now();
    const blockName = normalizeMinecraftLookupName(options.block);
    const item = current.inventory?.items?.().find((entry: any) => entry.name === blockName);
    if (!item) {
      return craftFailure('missing_item', `no ${blockName} in inventory to place`, started);
    }
    try {
      const target = options.position
        ? new Vec3(Math.floor(options.position.x), Math.floor(options.position.y), Math.floor(options.position.z))
        : undefined;
      const placed = await placeBlockAt(current, item, target, options.face ?? 'auto', options.signal);
      return {
        actionId: '',
        outcome: 'succeeded',
        summary: `placed ${blockName}`,
        durationMs: Date.now() - started,
        inventoryDelta: {},
        worldChanges: [{ kind: 'block_placed', name: blockName, count: 1 }],
        observations: [],
      };
    } catch (error) {
      const cancelled = options.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      return craftFailure(
        cancelled ? 'cancelled' : 'blocked',
        cancelled ? 'place cancelled' : `place failed: ${error instanceof Error ? error.message : String(error)}`,
        started,
        { originalError: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  function pickCraftRecipe(
    current: any,
    step: CraftPlanStep,
    table: any,
    requestedCraftCount = step.craftCount ?? Math.ceil(step.amount / step.outputPerCraft),
  ): any | null {
    const id = current.registry?.itemsByName?.[step.item]?.id;
    if (id === undefined) return null;

    const craftCount = Math.max(1, requestedCraftCount);
    const expectedOutput = craftCount * step.outputPerCraft;
    const plannedIngredients = ingredientsForCraftCount(step, craftCount);
    const available = current.recipesFor?.(id, null, expectedOutput, table ?? null) ?? [];
    const selected = available.find((recipe: any) => (
      recipeMatchesPlan(current, recipe, craftCount, plannedIngredients)
    ));
    if (selected) {
      return relaxInterchangeableMetadata(current, selected);
    }

    // Registry tag expansion can expose only concrete variants even when the
    // vanilla recipe accepts a material family such as any planks.
    const all = current.recipesAll?.(id, null, table ?? null) ?? [];
    const legacy = all.find((recipe: any) => (
      recipeMatchesPlan(current, recipe, craftCount, plannedIngredients)
      && hasNamedIngredients(current, plannedIngredients)
    ));
    if (!legacy) return null;
    return relaxInterchangeableMetadata(current, legacy);
  }

  function recipeMatchesPlan(
    current: any,
    recipe: any,
    craftCount: number,
    plannedIngredients: Record<string, number>,
  ): boolean {
    const nameById = new Map<number, string>();
    for (const [name, item] of Object.entries(current.registry?.itemsByName ?? {})) {
      if (typeof (item as any)?.id === 'number') nameById.set((item as any).id, name);
    }

    const entries = Array.isArray(recipe.inShape)
      ? recipe.inShape.flat()
      : (recipe.ingredients ?? []);
    const actual: Record<string, number> = {};
    for (const entry of entries) {
      const id = typeof entry === 'number' ? entry : entry?.id;
      if (id === undefined || id === null || id === -1) continue;
      const name = nameById.get(id);
      if (!name) continue;
      const perCraft = Math.max(1, Math.abs(Number(entry?.count ?? 1)));
      actual[name] = (actual[name] ?? 0) + perCraft * craftCount;
    }

    return ingredientSignature(actual) === ingredientSignature(plannedIngredients);
  }

  function ingredientSignature(ingredients: Record<string, number>): string {
    return Object.entries(ingredients)
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => `${name}=${count}`)
      .join('|');
  }

  function hasNamedIngredients(current: any, ingredients: Record<string, number>): boolean {
    return Object.entries(ingredients)
      .every(([name, count]) => availableIngredientCount(current, name) >= count);
  }

  function ingredientsForCraftCount(
    step: CraftPlanStep,
    requestedCraftCount: number,
  ): Record<string, number> {
    const totalCraftCount = Math.max(1, step.craftCount ?? Math.ceil(step.amount / step.outputPerCraft));
    return Object.fromEntries(Object.entries(step.ingredients).map(([name, count]) => [
      name,
      Math.round((count / totalCraftCount) * requestedCraftCount),
    ]));
  }

  function availableIngredientCount(current: any, ingredientName: string): number {
    return (current.inventory?.items?.() ?? []).reduce((total: number, item: any) => {
      const name = String(item?.name ?? '');
      return name === ingredientName ? total + Math.max(0, Number(item?.count ?? 1)) : total;
    }, 0);
  }

  function relaxInterchangeableMetadata(current: any, recipe: any): any {
    // 1.12 老服数据里 plank/log 配方只给了单个 metadata 变体；
    // 这些物品在游戏里可互换，放宽为任意 metadata 后交给 bot.craft 匹配。
    const interchangeableIds = new Set<number>();
    for (const name of ['planks', 'log', 'log2']) {
      const id = current.registry?.itemsByName?.[name]?.id;
      if (typeof id === 'number') interchangeableIds.add(id);
    }
    const clone = JSON.parse(JSON.stringify(recipe));
    for (const row of clone.inShape ?? []) {
      for (const entry of row) {
        if (entry && typeof entry === 'object' && interchangeableIds.has(entry.id)) entry.metadata = null;
      }
    }
    for (const entry of clone.ingredients ?? []) {
      if (entry && typeof entry === 'object' && interchangeableIds.has(entry.id)) entry.metadata = null;
    }
    return clone;
  }

  function findCraftingTable(current: any, radius: number): any | undefined {
    const block = current.registry?.blocksByName?.crafting_table;
    if (!block || typeof current.findBlocks !== 'function') return undefined;
    const positions = current.findBlocks({ matching: block.id, maxDistance: radius, count: 1 }) ?? [];
    if (!positions.length) return undefined;
    return current.blockAt(positions[0]);
  }

  function findFurnaceBlock(current: any, radius: number): any | undefined {
    const block = current.registry?.blocksByName?.furnace;
    if (!block || typeof current.findBlocks !== 'function') return undefined;
    const positions = current.findBlocks({ matching: block.id, maxDistance: radius, count: 1 }) ?? [];
    if (!positions.length) return undefined;
    return current.blockAt(positions[0]);
  }

  async function moveNearBlock(current: any, position: any, signal?: AbortSignal): Promise<void> {
    await current.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 3));
    throwIfAborted(signal);
    if (distanceToBot(current, position) > 4.5) {
      throw new Error('could not get close enough to the crafting table');
    }
  }

  function findFreePlacePosition(current: any, radius: number): Vec3 | undefined {
    const own = current.entity?.position;
    if (!own || typeof current.blockAt !== 'function') return undefined;
    const baseX = Math.floor(Number(own.x ?? 0));
    const baseY = Math.floor(Number(own.y ?? 0));
    const baseZ = Math.floor(Number(own.z ?? 0));
    const candidates: Vec3[] = [];
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        if (Math.abs(dx) + Math.abs(dz) < 2) continue;
        const ground = new Vec3(baseX + dx, baseY, baseZ + dz);
        const below = current.blockAt(ground);
        const above = current.blockAt(ground.offset(0, 1, 0));
        // 下方必须是实心方块（不能被放置顶掉，也不能是水/岩浆）
        if (!below || isReplaceableForPlacement(below)) continue;
        // 落点可以是空气或草丛/植物（放置会替换它们）
        if (!above || !isReplaceableForPlacement(above)) continue;
        candidates.push(ground.offset(0, 1, 0));
      }
    }
    candidates.sort((left, right) => distanceToBot(current, left) - distanceToBot(current, right));
    return candidates[0];
  }

  function craftFailure(
    code: MinecraftActionErrorCode,
    message: string,
    started: number,
    details: Record<string, unknown> = {},
  ): MinecraftActionResult {
    return {
      actionId: '',
      outcome: 'failed',
      summary: message,
      durationMs: Date.now() - started,
      inventoryDelta: {},
      worldChanges: [],
      observations: [],
      error: { code, recoverable: code !== 'unknown_item', details: { message, ...details } },
    };
  }

  async function runEquipItem(options: { item: string }): Promise<MinecraftActionResult> {
    const current = requireBot(bot);
    const started = Date.now();
    const itemName = normalizeMinecraftLookupName(options.item);
    const item = current.inventory?.items?.().find(
      (entry: any) => normalizeMinecraftLookupName(entry.name) === itemName,
    );
    if (!item) return craftFailure('missing_item', `no ${options.item} in inventory to hold or wear`, started);
    const destination = equipDestinationFor(itemName);
    await current.equip(item, destination);
    const wearing = destination !== 'hand';
    return {
      actionId: '',
      outcome: 'succeeded',
      summary: wearing ? `wearing ${item.name} on ${destination}` : `holding ${item.name}`,
      durationMs: Date.now() - started,
      inventoryDelta: {},
      worldChanges: [],
      observations: [],
    };
  }

  async function runDropItem(options: {
    item: string;
    count: number;
    player?: string;
  }): Promise<MinecraftActionResult> {
    const current = requireBot(bot);
    const started = Date.now();
    const itemName = normalizeMinecraftLookupName(options.item);
    const item = current.inventory?.items?.().find(
      (entry: any) => normalizeMinecraftLookupName(entry.name) === itemName,
    );
    if (!item) return craftFailure('missing_item', `no ${options.item} in inventory to drop`, started);
    const count = Math.max(1, Math.min(Math.trunc(options.count) || 1, item.count ?? 1));
    const playerName = options.player?.trim() || owner;
    if (playerName) {
      const player = Object.values(current.players ?? {}).find(
        (entry: any) => entry.username === playerName,
      );
      const entity = player?.entity;
      if (entity) {
        try {
          await current.pathfinder.goto(
            new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2.5),
          );
        } catch {
          // 靠近失败也照常丢弃，不阻塞动作
        }
      }
    }
    await current.toss(item.type, item.metadata, count);
    const where = playerName ? `near ${playerName}` : 'at current position';
    return {
      actionId: '',
      outcome: 'succeeded',
      summary: `dropped ${count} ${item.name} ${where}`,
      durationMs: Date.now() - started,
      inventoryDelta: { [item.name]: -count },
      worldChanges: [],
      observations: [],
    };
  }

  return {
    async connect(options) {
      if (bot) {
        owner = options.owner ?? owner;
        return;
      }
      owner = options.owner;
      connection = options;
      intentionalDisconnect = false;
      everSpawned = false;
      knownCraftingTable = undefined;
      let fallbackVersion: string | undefined;
      for (let attempt = 0; ; attempt += 1) {
        try {
          await connectOnce(options, attempt === 0 ? undefined : fallbackVersion);
          return;
        } catch (error) {
          if (attempt === 0 && isVersionDataMissingError(error)) {
            const missing = extractMissingVersion(error);
            fallbackVersion = missing ? fallbackSupportedVersion(missing) : undefined;
            if (fallbackVersion) {
              emit({
                kind: 'log',
                level: 'warn',
                message: `[connect] server version ${missing} unsupported; retrying with ${fallbackVersion}`,
              });
              continue;
            }
            if (missing && numericVersionParts(missing) && latestSupportedVersion) {
              throw new Error(
                `Minecraft 服务器版本 ${missing} 超出当前支持的版本范围（最高 ${latestSupportedVersion}）。`
                + `请把游戏切换到受支持版本（如 ${latestSupportedVersion}），或等待 minecraft-data / mineflayer 更新。`,
              );
            }
          }
          throw error;
        }
      }
    },

    async disconnect() {
      if (!bot) return;
      stopFollowSession();
      stopGazeTracking();
      const current = bot;
      intentionalDisconnect = true;
      everSpawned = false;
      knownCraftingTable = undefined;
      bot = undefined;
      current.autoEat?.disableAuto?.();
      await current.pvp?.stop?.();
      current.pathfinder?.stop?.();
      await current.collectBlock?.cancelTask?.();
      current.end('Hiyori disconnected');
    },

    setOwner(player) {
      const normalized = player?.trim() || undefined;
      if (normalized && normalized.toLocaleLowerCase() === bot?.username?.toLocaleLowerCase()) {
        throw new Error('Hiyori cannot follow itself');
      }
      owner = normalized;
      gazeTracker.reset();
    },

    isConnected(): boolean {
      return Boolean(bot);
    },

    status(): MinecraftStatus {
      return {
        connected: Boolean(bot),
        username: bot?.username,
        host: connection?.host,
        port: connection?.port,
        players: bot ? humanPlayerNames(bot) : [],
        owner,
        health: bot?.health,
        food: bot?.food,
        behavior: { kind: 'idle' },
      };
    },

    getRawObservation(ownerName?: string): MinecraftRawObservation {
      return getRawObservation(bot, connection, ownerName ?? owner);
    },

    async getSnapshot() {
      const started = Date.now();
      const snapshot = buildMinecraftSnapshot(this.getRawObservation());
      emit({
        kind: 'log',
        level: 'info',
        message: `snapshot completed in ${Date.now() - started}ms (${snapshot.nearby.blocks.length} blocks, ${snapshot.nearby.entities.length} entities)`,
      });
      return snapshot;
    },

    async say(message) {
      requireBot(bot).chat(message);
    },

    async navigateToPlayer(playerName, options) {
      const current = requireBot(bot);
      const target = current.players[playerName]?.entity;
      if (!target) throw new Error(`Minecraft player is not visible: ${playerName}`);
      if (options.dynamic) {
        current.pathfinder.setGoal(dependencies.createFollowGoal(target, options.range), true);
        return immediateNavigationResult(current, target, 'Persistent following started');
      }
      return patchedGoto(
        current,
        new goals.GoalNear(target.position.x, target.position.y, target.position.z, options.range),
        {
          signal: options.signal,
          onProgress: (progress) => emit({
            kind: 'log',
            level: 'info',
            message: `[navigate] elapsed=${progress.elapsedMs}ms position=${formatPosition(progress.currentPos)} remaining=${progress.distanceToTarget.toFixed(1)} moved=${progress.distanceTraveled.toFixed(1)} stagnant=${progress.stagnantTicks}`,
          }),
        },
      );
    },

    async stopNavigation() {
      if (!bot) return;
      clearPathfinderGoal(bot);
      await bot.pvp?.stop?.();
    },

    async escapeToAir(): Promise<MinecraftSafetyRecovery> {
      const current = requireBot(bot);
      const fallback = lastBreathablePosition ? vector(lastBreathablePosition) : undefined;
      clearPathfinderGoal(current);
      await current.pvp?.stop?.();
      current.clearControlStates?.();

      emit({
        kind: 'log',
        level: 'warn',
        message: `[survival] surfacing from ${formatPosition(current.entity?.position)} oxygen=${Number(current.oxygenLevel ?? 0)}`,
      });
      current.setControlState?.('jump', true);
      let recovered = await waitForOxygen(current, OXYGEN_RECOVERED_LEVEL, SURFACE_ATTEMPT_MS);
      current.setControlState?.('jump', false);
      let method: MinecraftSafetyRecovery['method'] = recovered ? 'surface' : 'failed';

      if (
        !recovered
        && fallback
        && current.entity?.position
        && distanceToBot(current, fallback) <= 32
      ) {
        try {
          await withTimeout(
            current.pathfinder.goto(new goals.GoalNear(fallback.x, fallback.y, fallback.z, 1)),
            LAST_AIR_ROUTE_TIMEOUT_MS,
            () => clearPathfinderGoal(current),
          );
          current.setControlState?.('jump', true);
          recovered = await waitForOxygen(current, OXYGEN_RECOVERED_LEVEL, 2_000);
          current.setControlState?.('jump', false);
          if (recovered) method = 'last-breathable-position';
        } catch (error) {
          emit({
            kind: 'log',
            level: 'warn',
            message: `[survival] route to last breathable position failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      current.clearControlStates?.();
      const oxygen = Number(current.oxygenLevel ?? 0);
      if (recovered) oxygenEmergencyActive = false;
      return { recovered, oxygen, method };
    },

    async inspect() {
      return buildMinecraftSnapshot(this.getRawObservation());
    },

    async scanBlocks(options): Promise<MinecraftActionResult> {
      const current = requireBot(bot);
      const started = Date.now();
      const own = current.entity?.position;
      if (!own || typeof current.blockAt !== 'function') {
        return actionFailure('scan_blocks', 'cannot scan blocks without bot position', 'adapter_error');
      }
      const scanned = scanNearbyBlocks(current, options.radius, options.verticalRadius, options.limit);
      emit({
        kind: 'log',
        level: 'info',
        message: `scan_blocks completed in ${Date.now() - started}ms (${scanned.scannedPositions} positions, ${scanned.blocks.length} block types)`,
      });
      return {
        actionId: '',
        outcome: scanned.blocks.length ? 'succeeded' : 'partial',
        summary: scanned.blocks.length
          ? `nearby blocks: ${scanned.blocks.map((block) => `${block.name} x${block.count}`).join(', ')}`
          : `no notable blocks found within ${options.radius} blocks`,
        durationMs: Date.now() - started,
        inventoryDelta: {},
        worldChanges: [],
        observations: scanned.blocks.map((block, index) => ({
          id: `scan.block.${index}`,
          at: Date.now(),
          severity: 'info',
          kind: 'scan.block',
          text: `${block.name} x${block.count}, nearest ${formatPosition(block.nearest.position)}, distance ${block.nearest.distance.toFixed(1)}`,
          data: {
            name: block.name,
            displayName: block.displayName,
            count: block.count,
            nearest: block.nearest,
          },
        })),
      };
    },

    async searchBlock(options): Promise<MinecraftActionResult> {
      const current = requireBot(bot);
      const blockName = resolveCollectBlock(current, options.block, options.radius);
      if (!blockName) {
        return actionFailure('search_block', `unknown block ${options.block}`, 'adapter_error');
      }
      const block = current.registry.blocksByName[blockName];
      const positions = current.findBlocks({
        matching: block.id,
        maxDistance: options.radius,
        count: options.count,
      }) ?? [];
      const found = positions
        .map((position: any) => current.blockAt(position))
        .filter((candidate: any) => candidate?.type === block.id || candidate?.name === blockName)
        .sort((left: any, right: any) =>
          distanceToBot(current, left.position) - distanceToBot(current, right.position),
        );
      return {
        actionId: '',
        outcome: found.length ? 'succeeded' : 'partial',
        summary: found.length
          ? `found ${found.length} ${blockName}`
          : `no ${blockName} found within ${options.radius} blocks`,
        durationMs: 0,
        inventoryDelta: {},
        worldChanges: [],
        observations: found.slice(0, 8).map((candidate: any, index: number) => ({
          id: `search.block.${index}`,
          at: Date.now(),
          severity: 'info',
          kind: 'search.block',
          text: `${candidate.name ?? blockName} at ${formatPosition(candidate.position)}, distance ${distanceToBot(current, candidate.position).toFixed(1)}`,
          data: {
            name: candidate.name ?? blockName,
            position: vector(candidate.position),
            distance: distanceToBot(current, candidate.position),
          },
        })),
      };
    },

    async searchEntity(options): Promise<MinecraftActionResult> {
      const current = requireBot(bot);
      const found = matchingEntities(current, options.entity, options.radius);
      return {
        actionId: '',
        outcome: found.length ? 'succeeded' : 'partial',
        summary: found.length
          ? `found ${found[0].name ?? options.entity} at distance ${distanceToBot(current, found[0].position).toFixed(1)}`
          : `no ${options.entity} found within ${options.radius} blocks`,
        durationMs: 0,
        inventoryDelta: {},
        worldChanges: [],
        observations: found.slice(0, 8).map((entity: any, index: number) => ({
          id: `search.entity.${index}`,
          at: Date.now(),
          severity: 'info',
          kind: 'search.entity',
          text: `${entity.name ?? options.entity} at ${formatPosition(entity.position)}, distance ${distanceToBot(current, entity.position).toFixed(1)}`,
          data: {
            name: entity.name ?? entity.displayName ?? options.entity,
            position: vector(entity.position),
            distance: distanceToBot(current, entity.position),
          },
        })),
      };
    },

    async approachEntity(options): Promise<MinecraftActionResult> {
      const current = requireBot(bot);
      const entity = nearestMatchingEntity(current, options.entity, options.radius);
      if (!entity) return actionFailure('approach_entity', `no ${options.entity} found within ${options.radius} blocks`, 'target_not_found');
      const started = Date.now();
      const deadline = started + (dependencies.approachTimeoutMs ?? 30_000);
      current.pathfinder.setGoal(
        new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, options.range),
      );
      while (Date.now() < deadline) {
        if (!entityStillPresent(current, entity)) {
          return actionFailure('approach_entity', `lost sight of ${options.entity} while approaching`, 'target_not_found');
        }
        const distance = distanceToBot(current, entity.position);
        if (distance <= options.range + 0.5) {
          return {
            actionId: '',
            outcome: 'succeeded',
            summary: `approached ${entity.name ?? options.entity} to ${distance.toFixed(1)} blocks`,
            durationMs: Date.now() - started,
            inventoryDelta: {},
            worldChanges: [],
            observations: [],
          };
        }
        await delay(500);
      }
      const distance = distanceToBot(current, entity.position);
      return {
        actionId: '',
        outcome: 'partial',
        summary: `could not reach ${entity.name ?? options.entity} within ${Math.round((Date.now() - started) / 1000)}s; distance ${distance.toFixed(1)}`,
        durationMs: Date.now() - started,
        inventoryDelta: {},
        worldChanges: [],
        observations: [{
          id: `approach.timeout:${started}`,
          at: Date.now(),
          severity: 'warning',
          kind: 'approach.timeout',
          text: `Could not reach ${entity.name ?? options.entity}; distance ${distance.toFixed(1)} blocks`,
        }],
      };
    },

    async attackEntity(options): Promise<MinecraftActionResult> {
      const current = requireBot(bot);
      const started = Date.now();
      const before = inventoryCounts(current);
      const processedTargets = new Set<string>();
      const observations: MinecraftActionResult['observations'] = [];
      let confirmed = 0;
      let attacked = 0;
      const report = (level: 'info' | 'warn' | 'error', message: string) => emit({
        kind: 'log',
        level,
        message: `[${options.actionId}] combat: ${message}`,
      });

      if (options.kill && current.pvp?.attack) {
        while (confirmed < options.quantity) {
          throwIfAborted(options.signal);
          let entity = matchingEntities(current, options.entity, options.radius)
            .find((candidate: any) => !processedTargets.has(entityKey(candidate)));
          if (!entity) {
            const fallback = matchingEntities(current, options.entity, COMBAT_CHASE_RADIUS)
              .find((candidate: any) => !processedTargets.has(entityKey(candidate)));
            if (fallback) {
              report('warn', `no ${options.entity} within ${options.radius} blocks; chasing nearest at ${distanceToBot(current, fallback.position).toFixed(1)}`);
              entity = fallback;
            }
          }
          if (!entity) {
            report('warn', `no remaining ${options.entity} within ${options.radius} blocks (${confirmed}/${options.quantity} confirmed)`);
            break;
          }
          processedTargets.add(entityKey(entity));
          attacked += 1;
          report('info', `target ${attacked}: ${options.entity}#${entity.id ?? 'unknown'} at distance ${distanceToBot(current, entity.position).toFixed(1)}`);
          await current.pvp.attack(entity);
          const killed = await (dependencies.confirmEntityDeath ?? confirmEntityDeath)(
            current,
            entity,
            30_000,
            options.signal,
          );
          await current.pvp.stop?.();
          if (killed) {
            confirmed += 1;
            report('info', `confirmed ${options.entity}#${entity.id ?? 'unknown'} dead (${confirmed}/${options.quantity})`);
            continue;
          }
          report('warn', `could not confirm ${options.entity}#${entity.id ?? 'unknown'} dead; excluding target`);
          observations.push({
            id: `combat.unconfirmed.${entity.id ?? attacked}`,
            at: Date.now(),
            severity: 'warning',
            kind: 'combat.target-unconfirmed',
            text: `Could not confirm ${options.entity} target ${entity.id ?? attacked} was defeated`,
            data: { entity: options.entity, entityId: entity.id },
          });
        }
      } else {
        const entity = nearestMatchingEntity(current, options.entity, options.radius);
        if (!entity) return actionFailure('attack_entity', `no ${options.entity} found within ${options.radius} blocks`, 'target_not_found');
        await current.attack?.(entity);
        attacked = 1;
      }

      throwIfAborted(options.signal);
      report('info', `collecting drops after ${confirmed} confirmed kills`);
      const pickedDrops = await (dependencies.collectDrops ?? collectNearbyDrops)(current, 10, options.signal);
      const inventoryDelta = inventoryDifference(before, inventoryCounts(current));
      const complete = options.kill ? confirmed >= options.quantity : attacked > 0;
      return {
        actionId: '',
        outcome: complete ? 'succeeded' : 'partial',
        summary: options.kill
          ? `killed ${confirmed}/${options.quantity} ${options.entity}; picked up ${pickedDrops} drops`
          : `attacked ${options.entity}`,
        durationMs: Date.now() - started,
        inventoryDelta,
        worldChanges: confirmed > 0 || attacked > 0
          ? [{ kind: 'entity_hit', name: options.entity, count: options.kill ? confirmed : attacked }]
          : [],
        observations,
      };
    },

    async startFollowing(player) {
      const current = requireBot(bot);
      const target = current.players[player]?.entity;
      stopFollowSession();
      followSession = {
        bot: current,
        player,
        blocked: !target,
        retryInProgress: false,
        blockedNotified: false,
        pathStuckResets: 0,
      };
      if (!target) {
        emit({
          kind: 'log',
          level: 'info',
          message: `[follow-runtime] target=${player} entity=pending; follow intent retained`,
        });
        scheduleFollowRetry(FOLLOW_RECOVERY_RETRY_MS, 'owner-entity-pending');
        return;
      }
      const distance = distanceToBot(current, target.position);
      const goal = dependencies.createFollowGoal(target, 2);
      emit({
        kind: 'log',
        level: 'info',
        message: `[follow-runtime] setting goal target=${player} distance=${distance.toFixed(2)} bot=${formatPosition(current.entity?.position)} targetPos=${formatPosition(target.position)} goal=${goal?.constructor?.name ?? 'unknown'} dynamic=true`,
      });
      current.pathfinder.setGoal(goal, true);
      startFollowWatchdog(current, player);
      emit({
        kind: 'log',
        level: 'info',
        message: `[follow-runtime] goal requested target=${player} moving=${Boolean(current.pathfinder?.isMoving?.())}`,
      });
      const startPosition = vector(current.entity?.position);
      for (const delayMs of [1_000, 5_000]) {
        const timer = setTimeout(() => {
          if (bot !== current) return;
          const liveTarget = current.players[player]?.entity;
          emit({
            kind: 'log',
            level: liveTarget ? 'info' : 'warn',
            message: liveTarget
              ? `[follow-runtime] probe=${delayMs}ms target=${player} distance=${distanceToBot(current, liveTarget.position).toFixed(2)} moved=${distanceBetween(startPosition, vector(current.entity?.position)).toFixed(2)} moving=${Boolean(current.pathfinder?.isMoving?.())}`
              : `[follow-runtime] probe=${delayMs}ms target=${player} visible=false moving=${Boolean(current.pathfinder?.isMoving?.())}`,
          });
        }, delayMs);
        timer.unref?.();
      }
    },

    async stopForeground() {
      if (!bot) return;
      stopFollowSession();
      clearPathfinderGoal(bot);
      await bot.collectBlock?.cancelTask?.();
      await bot.pvp?.stop?.();
    },

    resolveBlock(name) {
      if (!bot) return null;
      const normalized = normalizeMinecraftLookupName(name);
      if (GENERIC_TREE_NAMES.has(normalized)) return nearestVisibleLogName(bot, 16);
      if (bot.registry?.blocksByName?.[normalized]) return normalized;
      if (normalized === 'sugar_cane' && bot.registry?.blocksByName?.reeds) return 'reeds';
      return null;
    },

    async collect(request: CollectionRequest) {
      const result = await collectBlocks(request);
      return result.total;
    },

    async collectItem(options): Promise<MinecraftActionResult> {
      return runCollectItem(options);
    },

    async craftItem(options): Promise<MinecraftActionResult> {
      return runCraftItem(options);
    },

    async smeltItem(options): Promise<MinecraftActionResult> {
      return runSmeltItem(options);
    },

    async equipItem(options): Promise<MinecraftActionResult> {
      return runEquipItem(options);
    },

    async dropItem(options): Promise<MinecraftActionResult> {
      return runDropItem(options);
    },

    async placeBlockItem(options): Promise<MinecraftActionResult> {
      return runPlaceBlock(options);
    },

    async pickupDrops(options): Promise<MinecraftActionResult> {
      const started = Date.now();
      const { found, picked, inventoryDelta } = await collectItemDrops(options.radius);
      return {
        actionId: '',
        outcome: found === 0 || picked > 0 ? 'succeeded' : 'partial',
        summary: picked > 0
          ? `picked up ${picked} dropped item${picked === 1 ? '' : 's'}`
          : found === 0
            ? `no dropped items within ${options.radius} blocks`
            : `could not pick up ${found} dropped item${found === 1 ? '' : 's'}`,
        durationMs: Date.now() - started,
        inventoryDelta,
        worldChanges: picked > 0 ? [{ kind: 'item_picked_up', name: 'item', count: picked }] : [],
        observations: [],
      };
    },

    configurePolicies(handlers) {
      policyHandlers = handlers;
    },
  };
}

function getRawObservation(
  bot: any,
  connection: MinecraftConnectionOptions | undefined,
  owner: string | undefined,
): MinecraftRawObservation {
  const connected = Boolean(bot);
  const ownerEntity = connected && owner ? bot.players?.[owner]?.entity : undefined;
  return {
    capturedAt: Date.now(),
    connection: {
      connected,
      username: bot?.username,
      host: connection?.host,
      port: connection?.port,
    },
    world: connected ? worldSnapshot(bot) : undefined,
    body: connected ? bodySnapshot(bot) : undefined,
    owner: owner
      ? {
          name: owner,
          visible: Boolean(ownerEntity),
          distance: ownerEntity ? distanceToBot(bot, ownerEntity.position) : undefined,
          relativeDirection: ownerEntity ? relativeDirection(bot, ownerEntity.position) : undefined,
        }
      : undefined,
    follow: { phase: 'inactive' },
    nearbyBlocks: [],
    nearbyEntities: connected ? visibleEntities(bot) : [],
    recentEvents: [],
  };
}

function worldSnapshot(bot: any): MinecraftRawObservation['world'] {
  return {
    dimension: bot.game?.dimension ?? bot.dimension ?? 'unknown',
    timeOfDay: typeof bot.time?.timeOfDay === 'number' ? bot.time.timeOfDay : undefined,
    weather: bot.isRaining ? 'rain' : 'clear',
  };
}

function bodySnapshot(bot: any): MinecraftRawObservation['body'] {
  return {
    position: vector(bot.entity?.position),
    health: bot.health ?? 0,
    food: bot.food ?? 0,
    oxygen: typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : undefined,
    inventory: inventoryCounts(bot),
  };
}

function inventoryCounts(bot: any): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of bot.inventory?.items?.() ?? []) {
    const name = item.name ?? String(item.type);
    counts[name] = (counts[name] ?? 0) + (item.count ?? 1);
  }
  return counts;
}

function resolveCollectBlock(bot: any, name: string, radius: number): string | null {
  const normalized = normalizeMinecraftLookupName(name);
  if (bot.registry?.blocksByName?.[normalized]) return normalized;
  if (GENERIC_TREE_NAMES.has(normalized) || isLogLikeName(normalized)) return nearestVisibleLogName(bot, radius);
  if (normalized === 'sugar_cane' && bot.registry?.blocksByName?.reeds) return 'reeds';
  return null;
}

function normalizeMinecraftLookupName(name: string): string {
  return name.trim().toLowerCase().replace(/^minecraft\s*[: ]\s*/, '').replace(/[\s-]+/g, '_');
}

async function waitForServerInventoryBarrier(
  bot: any,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const client = bot?._client;
  if (!client?.write || !client?.once || !client?.off) {
    throw createCraftError('inventory_desync', 'Minecraft client cannot confirm server inventory state');
  }
  await new Promise<void>((resolve, reject) => {
    const onStatistics = () => finish(resolve);
    const onAbort = () => finish(() => reject(abortError()));
    const timeout = setTimeout(() => finish(() => reject(createCraftError(
      'inventory_desync',
      'Minecraft server did not confirm the inventory transaction',
    ))), 5_000);
    const finish = (done: () => void): void => {
      clearTimeout(timeout);
      client.off('statistics', onStatistics);
      signal?.removeEventListener('abort', onAbort);
      done();
    };
    client.once('statistics', onStatistics);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // REQUEST_STATS is handled on the server's main thread. Its response is
      // the causal boundary for all earlier inventory clicks on this connection.
      client.write('client_command', { actionId: 1 });
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

function immediateNavigationResult(current: any, target: any, message: string): PathfindResult {
  const position = current.entity.position;
  return {
    ok: true,
    reason: 'success',
    message,
    startPos: vector(position),
    endPos: vector(position),
    distanceTraveled: 0,
    distanceToTarget: distanceToBot(current, target.position),
    elapsedMs: 0,
    estimatedTimeMs: 0,
    pathCost: 0,
    environment: {
      inWater: false,
      oxygen: Number(current.oxygenLevel ?? 20),
      nearbyLiquids: [],
    },
  };
}

// equip 自动判断落点：盔甲按部位穿到对应护甲槽，其余物品切换手持。
// 规则基于物品名后缀，跨版本通用（不依赖具体版本的物品注册表）。
function equipDestinationFor(itemName: string): 'hand' | 'head' | 'torso' | 'legs' | 'feet' {
  const name = normalizeMinecraftLookupName(itemName);
  if (name.endsWith('_helmet') || name === 'pumpkin' || name === 'carved_pumpkin') return 'head';
  if (name.endsWith('_chestplate') || name === 'elytra') return 'torso';
  if (name.endsWith('_leggings')) return 'legs';
  if (name.endsWith('_boots')) return 'feet';
  return 'hand';
}

function isVersionDataMissingError(error: unknown): boolean {
  return error instanceof Error && /No data available for version/.test(error.message);
}

function extractMissingVersion(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = /No data available for version (\S+)/.exec(error.message);
  return match?.[1];
}

function fallbackSupportedVersion(target: string): string | undefined {
  const targetParts = numericVersionParts(target);
  const latestParts = numericVersionParts(latestSupportedVersion ?? '');
  if (!targetParts || !latestParts) return undefined;
  // 只有同主版本（如 1.21.9 → 1.21.8）的次版本升级才值得回退；
  // 跨大版本（如 26.x → 1.21.x）协议必然不兼容，不要猜测。
  if (compareVersionParts(targetParts, latestParts) <= 0) return undefined;
  if (targetParts[0] !== latestParts[0]) return undefined;
  return latestSupportedVersion;
}

function numericVersionParts(version: string): number[] | undefined {
  if (!/^\d+(\.\d+)*$/.test(version)) return undefined;
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  return parts.every((part) => Number.isFinite(part)) ? parts : undefined;
}

function compareVersionParts(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function deriveDropItemForBlock(bot: any, blockName: string): string | undefined {
  const block = bot.registry?.blocksByName?.[blockName];
  if (!block) return undefined;
  const drops = blockDropIds(block);
  if (drops.length === 0) return KNOWN_BLOCK_DROPS[blockName] ?? blockName;
  const nameById = new Map<number, string>();
  for (const [name, item] of Object.entries(bot.registry?.itemsByName ?? {})) {
    if (typeof (item as any)?.id === 'number') nameById.set((item as any).id, name);
  }
  const names = drops.map((id) => nameById.get(id)).filter(Boolean) as string[];
  return names.find((name) => name === blockName)
    ?? names[0]
    ?? KNOWN_BLOCK_DROPS[blockName]
    ?? blockName;
}

/**
 * 把方块掉落表统一归一化成物品 id 数组。
 *
 * minecraft-data 的 drops 格式随版本不同：
 *   - 1.8-1.12（扁平化前）：[{ drop: <id | {id, metadata}> }, ...]
 *   - 1.13+（扁平化后）：[id, ...]
 * 只取“掉落物物品 id”这一语义，与版本表示无关，因此不会因改名/改格式失效。
 */
function blockDropIds(block: any): number[] {
  const drops = Array.isArray(block?.drops) ? block.drops : [];
  const ids: number[] = [];
  for (const entry of drops) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      ids.push(entry);
    } else if (entry && typeof entry === 'object') {
      const drop = (entry as any).drop;
      if (typeof drop === 'number' && Number.isFinite(drop)) {
        ids.push(drop);
      } else if (drop && typeof drop === 'object' && typeof drop.id === 'number') {
        ids.push(drop.id);
      } else if (typeof (entry as any).id === 'number') {
        ids.push((entry as any).id);
      }
    }
  }
  return ids;
}

function sourceBlocksForItem(bot: any, itemName: string): string[] {
  const registry = bot.registry;
  const item = registry?.itemsByName?.[itemName];
  const blocks = item
    ? Object.entries(registry?.blocksByName ?? {})
        .filter(([, block]) => blockDropIds(block as any).includes(item.id))
        .map(([name]) => name)
        .filter((name) => name !== 'air' && name !== 'cave_air' && name !== 'void_air')
    : [];
  if (blocks.length > 0) return blocks;
  if (itemName === 'wheat_seeds') {
    // 老版本（1.11.2）里 'grass' 是实心草方块，不产种子；只有非实心草株才可能是种子来源
    return ['tallgrass', 'grass', 'tall_grass', 'short_grass', 'fern', 'double_plant']
      .filter((name) => {
        const block = registry?.blocksByName?.[name];
        return block && block.boundingBox !== 'block';
      });
  }
  return [];
}

function nearestVisibleLogName(bot: any, radius: number): string | null {
  const blocksByName = bot.registry?.blocksByName ?? {};
  let best: { name: string; distance: number } | undefined;
  for (const name of availableLogBlockNames(blocksByName)) {
    const block = blocksByName[name];
    if (!block || typeof bot.findBlocks !== 'function') continue;
    const positions = bot.findBlocks({ matching: block.id, maxDistance: radius, count: 8 }) ?? [];
    for (const position of positions) {
      const liveBlock = typeof bot.blockAt === 'function' ? bot.blockAt(position) : undefined;
      if (liveBlock?.type !== undefined && liveBlock.type !== block.id) continue;
      const distance = distanceToBot(bot, position);
      if (!best || distance < best.distance) best = { name, distance };
    }
  }
  return best?.name ?? firstAvailableLogName(blocksByName);
}

function firstAvailableLogName(blocksByName: Record<string, unknown>): string | null {
  return availableLogBlockNames(blocksByName)[0] ?? null;
}

interface ScannedBlockGroup {
  name: string;
  displayName?: string;
  count: number;
  nearest: {
    position: { x: number; y: number; z: number };
    distance: number;
  };
}

function scanNearbyBlocks(
  bot: any,
  radius: number,
  verticalRadius: number,
  limit: number,
): { scannedPositions: number; blocks: ScannedBlockGroup[] } {
  const own = bot.entity.position;
  const groups = new Map<string, ScannedBlockGroup>();
  let scannedPositions = 0;

  for (const [dx, dy, dz] of scanOffsets(radius, verticalRadius)) {
    if (scannedPositions >= MAX_SCAN_BLOCK_POSITIONS) break;
    scannedPositions += 1;
    const position = offset(own, dx, dy, dz);
    const block = bot.blockAt(position);
    if (!isNotableScannedBlock(block)) continue;
    const name = String(block.name ?? block.type);
    const distance = distanceToBot(bot, block.position ?? position);
    const existing = groups.get(name);
    if (!existing) {
      groups.set(name, {
        name,
        displayName: block.displayName,
        count: 1,
        nearest: {
          position: vector(block.position ?? position),
          distance,
        },
      });
      continue;
    }
    existing.count += 1;
    if (distance < existing.nearest.distance) {
      existing.nearest = {
        position: vector(block.position ?? position),
        distance,
      };
    }
  }

  return {
    scannedPositions,
    blocks: [...groups.values()]
      .sort((left, right) => blockScanPriority(left.name) - blockScanPriority(right.name) ||
        left.nearest.distance - right.nearest.distance ||
        right.count - left.count ||
        left.name.localeCompare(right.name))
      .slice(0, limit),
  };
}

function scanOffsets(radius: number, verticalRadius: number): Array<[number, number, number]> {
  const offsets: Array<[number, number, number]> = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -verticalRadius; dy <= verticalRadius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if ((dx * dx) + (dz * dz) > radius * radius) continue;
        offsets.push([dx, dy, dz]);
      }
    }
  }
  return offsets.sort((left, right) => offsetDistanceSquared(left) - offsetDistanceSquared(right));
}

function offsetDistanceSquared([x, y, z]: [number, number, number]): number {
  return x * x + y * y + z * z;
}

function isNotableScannedBlock(block: any): boolean {
  if (!block) return false;
  const name = String(block.name ?? '');
  if (!name || AIR_BLOCK_NAMES.has(name)) return false;
  if (typeof block.type === 'number' && block.type === 0) return false;
  return true;
}

function blockScanPriority(name: string): number {
  if (isLogLikeName(name)) return 0;
  if (name.includes('leaves')) return 1;
  if (name.includes('ore')) return 2;
  if (name.includes('reeds') || name.includes('sugar_cane')) return 3;
  if (name.includes('crop') || name.includes('wheat') || name.includes('carrot') || name.includes('potato')) return 4;
  if (name.includes('chest') || name.includes('crafting') || name.includes('furnace')) return 5;
  return 10;
}

function availableLogBlockNames(blocksByName: Record<string, unknown>): string[] {
  const known = LOG_BLOCK_NAMES.filter((name) => blocksByName[name]);
  const dynamic = Object.keys(blocksByName)
    .filter((name) => isLogLikeName(name))
    .sort((left, right) => logNamePriority(left) - logNamePriority(right) || left.localeCompare(right));
  return [...new Set([...known, ...dynamic])];
}

function isLogLikeName(name: string): boolean {
  return (
    name === 'log' ||
    name === 'log2' ||
    name.endsWith('_log') ||
    name.endsWith('_stem') ||
    name.endsWith('_wood') ||
    name.endsWith('_hyphae')
  );
}

function logNamePriority(name: string): number {
  if (name === 'oak_log') return 0;
  if (name.endsWith('_log')) return 1;
  if (name === 'log' || name === 'log2') return 2;
  if (name.endsWith('_stem')) return 3;
  return 4;
}

function visibleEntities(bot: any): MinecraftObservedEntity[] {
  return Object.values(bot.entities ?? {})
    .filter((entity: any) => entity !== bot.entity && entity?.position)
    .map((entity: any) => {
      const entityName = observedEntityName(entity);
      const type = observedEntityType(entity);
      return {
        name: entityName,
        type,
        position: vector(entity.position),
        distance: distanceToBot(bot, entity.position),
        hostile: HOSTILE_MOBS.has(normalizeEntityName(entity.name ?? entity.displayName ?? entityName)),
      };
    });
}

function matchingEntities(bot: any, name: string, radius: number): any[] {
  const normalized = normalizeEntityName(name);
  return Object.values(bot.entities ?? {})
    .filter((entity: any) => entity !== bot.entity && entity?.position)
    .filter((entity: any) => entityMatches(entity, normalized))
    .filter((entity: any) => distanceToBot(bot, entity.position) <= radius)
    .sort((left: any, right: any) => distanceToBot(bot, left.position) - distanceToBot(bot, right.position));
}

function nearestMatchingEntity(bot: any, name: string, radius: number): any | undefined {
  return matchingEntities(bot, name, radius)[0];
}

function entityMatches(entity: any, normalized: string | undefined): boolean {
  if (!normalized) return false;
  return [
    entity.name,
    entity.displayName,
    entity.username,
    entity.type,
  ]
    .map(normalizeEntityName)
    .some((value) => value === normalized);
}

function actionFailure(
  actionId: string,
  message: string,
  code: MinecraftActionErrorCode,
): MinecraftActionResult {
  return {
    actionId,
    outcome: 'failed',
    summary: message,
    durationMs: 0,
    inventoryDelta: {},
    worldChanges: [],
    observations: [],
    error: { code, recoverable: true, details: { message } },
  };
}

function observedEntityName(entity: any): string {
  if (entity.item?.name) return entity.item.name;
  if (entity.metadata?.item?.name) return entity.metadata.item.name;
  if (entity.displayName && entity.name === 'item') return entity.displayName;
  return entity.username ?? normalizeEntityName(entity.name ?? entity.displayName) ?? entity.type ?? 'unknown';
}

function observedEntityType(entity: any): string {
  const name = normalizeEntityName(entity.name);
  const displayName = normalizeEntityName(entity.displayName);
  if (entity.item || entity.metadata?.item || name === 'item' || name === 'item_stack' || displayName === 'item') {
    return 'item';
  }
  return entity.type ?? 'unknown';
}

function normalizeEntityName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function vector(position: any): { x: number; y: number; z: number } {
  return {
    x: Number(position?.x ?? 0),
    y: Number(position?.y ?? 0),
    z: Number(position?.z ?? 0),
  };
}

function formatPosition(position: any): string {
  const value = vector(position);
  return `${value.x.toFixed(0)},${value.y.toFixed(0)},${value.z.toFixed(0)}`;
}

function formatPrecisePosition(position: any): string {
  const value = vector(position);
  return `${value.x.toFixed(2)},${value.y.toFixed(2)},${value.z.toFixed(2)}`;
}

function formatPositionDelta(from: any, to: any): string {
  const start = vector(from);
  const end = vector(to);
  return `${(end.x - start.x).toFixed(2)},${(end.y - start.y).toFixed(2)},${(end.z - start.z).toFixed(2)}`;
}

async function confirmEntityDeath(
  bot: any,
  entity: any,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!entityStillPresent(bot, entity)) return true;
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const poll = setInterval(() => {
      if (!entityStillPresent(bot, entity)) finish(true);
    }, 200);
    const onTerminal = (candidate: any) => {
      if (sameEntity(candidate, entity)) finish(true);
    };
    const onAbort = () => finish(abortError());
    const finish = (value: boolean | Error) => {
      clearTimeout(timer);
      clearInterval(poll);
      bot.removeListener('entityDead', onTerminal);
      bot.removeListener('entityGone', onTerminal);
      signal?.removeEventListener('abort', onAbort);
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    bot.on('entityDead', onTerminal);
    bot.on('entityGone', onTerminal);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function collectNearbyDrops(bot: any, radius: number, signal?: AbortSignal): Promise<number> {
  const { picked } = await walkPickupDrops(bot, radius, signal);
  return picked;
}

async function walkPickupDrops(
  bot: any,
  radius: number,
  signal?: AbortSignal,
): Promise<{ found: number; picked: number; inventoryDelta: Record<string, number> }> {
  const before = inventoryCounts(bot);
  const attempted = new Set<string>();
  let picked = 0;
  let found = 0;
  for (let index = 0; index < 32; index += 1) {
    throwIfAborted(signal);
    const item = matchingEntities(bot, 'item', radius).find(
      (candidate) => !attempted.has(entityKey(candidate)),
    );
    if (!item) break;
    found += 1;
    attempted.add(entityKey(item));
    try {
      await bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0.8));
    } catch {
      continue;
    }
    if (await waitForItemPickup(bot, item, signal)) picked += 1;
  }
  return { found, picked, inventoryDelta: inventoryDifference(before, inventoryCounts(bot)) };
}

async function waitForItemPickup(bot: any, item: any, signal?: AbortSignal): Promise<boolean> {
  for (let index = 0; index < 10; index += 1) {
    throwIfAborted(signal);
    if (!entityStillPresent(bot, item)) return true;
    await delay(200, signal);
  }
  return !entityStillPresent(bot, item);
}

function inventoryDifference(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const difference: Record<string, number> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const delta = (after[name] ?? 0) - (before[name] ?? 0);
    if (delta !== 0) difference[name] = delta;
  }
  return difference;
}

function entityStillPresent(bot: any, entity: any): boolean {
  return Object.values(bot.entities ?? {}).some((candidate: any) => sameEntity(candidate, entity));
}

function sameEntity(left: any, right: any): boolean {
  return left === right || (left?.id !== undefined && left.id === right?.id);
}

function entityKey(entity: any): string {
  return entity?.id !== undefined ? `id:${entity.id}` : `pos:${formatPosition(entity?.position)}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function distanceToBot(bot: any, position: any): number {
  const own = bot.entity?.position;
  if (!own || !position) return Number.POSITIVE_INFINITY;
  if (typeof own.distanceTo === 'function') return own.distanceTo(position);
  const x = Number(own.x ?? 0) - Number(position.x ?? 0);
  const y = Number(own.y ?? 0) - Number(position.y ?? 0);
  const z = Number(own.z ?? 0) - Number(position.z ?? 0);
  return Math.sqrt(x * x + y * y + z * z);
}

function distanceBetween(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): number {
  const x = left.x - right.x;
  const y = left.y - right.y;
  const z = left.z - right.z;
  return Math.sqrt(x * x + y * y + z * z);
}

function clearPathfinderGoal(bot: any): void {
  if (typeof bot?.pathfinder?.setGoal === 'function') {
    bot.pathfinder.setGoal(null);
    return;
  }
  bot?.pathfinder?.stop?.();
}

function relativeDirection(bot: any, position: any): string {
  const own = bot.entity?.position;
  if (!own || !position) return 'unknown';
  const dx = Number(position.x ?? 0) - Number(own.x ?? 0);
  const dz = Number(position.z ?? 0) - Number(own.z ?? 0);
  const eastWest = Math.abs(dx) < 1 ? '' : dx > 0 ? 'east' : 'west';
  const northSouth = Math.abs(dz) < 1 ? '' : dz > 0 ? 'south' : 'north';
  return [northSouth, eastWest].filter(Boolean).join('-') || 'nearby';
}

async function collectSugarCane(
  bot: any,
  request: CollectionRequest,
  blockId: number,
): Promise<number> {
  const positions = bot.findBlocks({
    matching: blockId,
    maxDistance: request.radius,
    count: Math.min(request.quantity * 3, 192),
  });
  const candidates = positions
    .map((position: any) => bot.blockAt(position))
    .filter((block: any) => block?.type === blockId)
    .sort((left: any, right: any) => {
      const distance = horizontalDistanceSquared(left.position, bot.entity.position) -
        horizontalDistanceSquared(right.position, bot.entity.position);
      return distance || right.position.y - left.position.y;
    });

  let collected = 0;
  const cancel = () => clearPathfinderGoal(bot);
  request.signal.addEventListener('abort', cancel, { once: true });
  try {
    for (const candidate of candidates) {
      if (collected >= request.quantity) break;
      if (request.signal.aborted) throw abortError();

      let liveBlock = bot.blockAt(candidate.position);
      if (liveBlock?.type !== blockId) continue;
      if (!bot.canDigBlock(liveBlock)) {
        await bot.pathfinder.goto(
          new goals.GoalNear(candidate.position.x, candidate.position.y, candidate.position.z, 3),
        );
        liveBlock = bot.blockAt(candidate.position);
      }
      if (liveBlock?.type !== blockId || !bot.canDigBlock(liveBlock)) continue;

      await bot.dig(liveBlock, true);
      collected += 1;
    }
    return collected;
  } finally {
    request.signal.removeEventListener('abort', cancel);
  }
}

async function collectSingleBlock(current: any, block: any, signal?: AbortSignal): Promise<void> {
  const task = current.collectBlock.collect(block, { ignoreNoPath: true });
  await runAbortableOperation(
    task,
    signal,
    () => current.collectBlock?.cancelTask?.(),
  );
}

function canHarvestWithInventory(current: any, block: any): boolean {
  if (!block || typeof block.canHarvest !== 'function') return true;
  if (block.canHarvest(null)) return true; // 空手可采（泥土、草等）
  return (current.inventory?.items?.() ?? []).some(
    (item: any) => block.canHarvest(item.type) === true,
  );
}

function offset(position: any, x: number, y: number, z: number): any {
  return new Vec3(position.x + x, position.y + y, position.z + z);
}

function horizontalDistanceSquared(left: any, right: any): number {
  const x = left.x - right.x;
  const z = left.z - right.z;
  return x * x + z * z;
}

function isBreathingSafely(bot: any): boolean {
  const oxygen = Number(bot?.oxygenLevel ?? 20);
  const position = bot?.entity?.position;
  if (!position || oxygen < OXYGEN_RECOVERED_LEVEL) return false;
  const head = bot.blockAt?.(new Vec3(position.x, position.y + 1, position.z));
  return !head || (head.name !== 'water' && head.name !== 'flowing_water');
}

function waitForOxygen(bot: any, minimum: number, timeoutMs: number): Promise<boolean> {
  if (Number(bot?.oxygenLevel ?? 0) >= minimum && isBreathingSafely(bot)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onBreath = () => {
      if (Number(bot?.oxygenLevel ?? 0) >= minimum && isBreathingSafely(bot)) finish(true);
    };
    const onEnd = () => finish(false);
    const finish = (recovered: boolean) => {
      clearTimeout(timer);
      bot.off?.('breath', onBreath);
      bot.off?.('end', onEnd);
      resolve(recovered);
    };
    bot.on?.('breath', onBreath);
    bot.once?.('end', onEnd);
  });
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`Minecraft survival route timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function waitForSpawn(bot: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => finish(resolve);
    const onError = (error: Error) => finish(() => reject(error));
    const onEnd = (reason: string) =>
      finish(() => reject(new Error(reason || 'Minecraft connection ended before spawn')));
    const finish = (callback: () => void) => {
      bot.off('spawn', onSpawn);
      bot.off('error', onError);
      bot.off('end', onEnd);
      callback();
    };
    bot.once('spawn', onSpawn);
    bot.once('error', onError);
    bot.once('end', onEnd);
  });
}

function requireBot(bot: any): any {
  if (!bot) throw new Error('Hiyori is not connected to Minecraft');
  return bot;
}

function humanPlayerNames(bot: any): string[] {
  return Object.keys(bot.players ?? {}).filter((name) => name !== bot.username);
}

function notifyPlayers(
  bot: any,
  emit: (event: MinecraftRuntimeEvent) => void,
  handlers: MinecraftPolicyHandlers,
): void {
  const players = humanPlayerNames(bot);
  emit({ kind: 'players', players });
  Promise.resolve(handlers.onPlayersChanged?.(players)).catch((error) => emit({
    kind: 'log',
    level: 'error',
    message: `[players] change handler failed: ${error instanceof Error ? error.message : String(error)}`,
  }));
}

function notifyFoodState(bot: any, handlers: MinecraftPolicyHandlers): void {
  const foodIds = new Set(
    Object.values(bot.registry?.foodsByName ?? {}).map((food: any) => food.id),
  );
  const hasInventoryFood = bot.inventory
    .items()
    .some((item: any) => foodIds.has(item.type));
  handlers.onFoodState({ food: bot.food, hasInventoryFood });
}

function defendFromNearbyHostile(bot: any, handlers: MinecraftPolicyHandlers): void {
  const entity = bot.nearestEntity?.((candidate: any) => {
    const snapshot = classifyEntity(candidate);
    return (
      handlers.shouldDefendAgainst(snapshot) &&
      candidate.position?.distanceTo(bot.entity.position) <= 6
    );
  });
  if (entity) void bot.pvp?.attack?.(entity);
}

function classifyEntity(entity: any): MinecraftEntitySnapshot {
  if (entity.type === 'player') return { kind: 'player', name: entity.username ?? 'player' };
  const name = entity.name ?? entity.displayName ?? 'unknown';
  return { kind: HOSTILE_MOBS.has(name) ? 'hostile' : 'neutral', name };
}

function abortError(): Error {
  const error = new Error('Minecraft collection cancelled');
  error.name = 'AbortError';
  return error;
}
