import { createBot, type Bot } from 'mineflayer';
import { loader as autoEatPlugin } from 'mineflayer-auto-eat';
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock';
import { goals, pathfinder } from 'mineflayer-pathfinder';
import { plugin as pvpPlugin } from 'mineflayer-pvp';
import { plugin as toolPlugin } from 'mineflayer-tool';
import type {
  CollectionRequest,
  MinecraftBotAdapter,
  MinecraftConnectionOptions,
  MinecraftEntitySnapshot,
  MinecraftPolicyHandlers,
} from './actions/types';
import type {
  MinecraftActionResult,
  MinecraftObservedBlock,
  MinecraftObservedEntity,
  MinecraftRawObservation,
  MinecraftRuntimeEvent,
  MinecraftStatus,
} from './protocol';
import { buildMinecraftSnapshot } from './perception';

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

export interface MineflayerAdapterDependencies {
  createBot: typeof createBot | ((options: any) => any);
  plugins: Array<(bot: any) => void>;
  createFollowGoal(entity: any, range: number): any;
}

const defaultDependencies: MineflayerAdapterDependencies = {
  createBot,
  plugins: [pathfinder, toolPlugin, collectBlockPlugin, autoEatPlugin, pvpPlugin],
  createFollowGoal: (entity, range) => new goals.GoalFollow(entity, range),
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
    shouldDefendAgainst: (entity) => entity.kind === 'hostile',
  };
  let lastHealth = 20;
  let intentionalDisconnect = false;

  return {
    async connect(options) {
      if (bot) {
        owner = options.owner ?? owner;
        return;
      }
      owner = options.owner;
      connection = options;
      intentionalDisconnect = false;
      bot = dependencies.createBot({
        host: options.host,
        port: options.port,
        username: options.username,
        auth: 'offline',
      });
      for (const plugin of dependencies.plugins) bot.loadPlugin(plugin);

      bot.on('chat', (username: string, message: string) => {
        if (username !== bot.username) {
          emit({ kind: 'chat', player: username, message });
        }
      });
      bot.on('playerJoined', () => emitPlayers(bot, emit));
      bot.on('playerLeft', () => emitPlayers(bot, emit));
      bot.on('health', () => {
        notifyFoodState(bot, policyHandlers);
        if (bot.health < lastHealth) defendFromNearbyHostile(bot, policyHandlers);
        lastHealth = bot.health;
      });
      bot.on('end', (reason: string) => {
        if (!intentionalDisconnect) {
          emit({ kind: 'disconnected', reason: reason || 'Minecraft connection ended' });
        }
        intentionalDisconnect = false;
        bot = undefined;
      });
      bot.on('kicked', (reason: unknown) => {
        emit({ kind: 'log', level: 'error', message: `Kicked: ${String(reason)}` });
      });
      bot.on('error', (error: Error) => {
        emit({ kind: 'log', level: 'error', message: error.message });
      });

      await waitForSpawn(bot);
      lastHealth = bot.health;
      bot.autoEat?.setOpts?.({ minHunger: 16, strictErrors: false });
      bot.autoEat?.enableAuto?.();
      notifyFoodState(bot, policyHandlers);
      emitPlayers(bot, emit);
    },

    async disconnect() {
      if (!bot) return;
      const current = bot;
      intentionalDisconnect = true;
      bot = undefined;
      current.autoEat?.disableAuto?.();
      await current.pvp?.stop?.();
      current.pathfinder?.stop?.();
      await current.collectBlock?.cancelTask?.();
      current.end('Hiyori disconnected');
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
      return buildMinecraftSnapshot(this.getRawObservation());
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
        return;
      }
      await current.pathfinder.goto(
        new goals.GoalNear(target.position.x, target.position.y, target.position.z, options.range),
      );
    },

    async stopNavigation() {
      if (!bot) return;
      bot.pathfinder?.stop?.();
    },

    async inspect() {
      return buildMinecraftSnapshot(this.getRawObservation());
    },

    async startFollowing(player) {
      const current = requireBot(bot);
      const target = current.players[player]?.entity;
      if (!target) throw new Error(`Minecraft player is not visible: ${player}`);
      current.pathfinder.setGoal(dependencies.createFollowGoal(target, 2), true);
    },

    async stopForeground() {
      if (!bot) return;
      bot.pathfinder?.stop?.();
      await bot.collectBlock?.cancelTask?.();
    },

    resolveBlock(name) {
      if (!bot) return null;
      const normalized = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
      if (bot.registry?.blocksByName?.[normalized]) return normalized;
      if (normalized === 'sugar_cane' && bot.registry?.blocksByName?.reeds) return 'reeds';
      return null;
    },

    async collect(request: CollectionRequest) {
      const current = requireBot(bot);
      const block = current.registry.blocksByName[request.block];
      if (!block) throw new Error(`Unknown Minecraft block: ${request.block}`);
      if (request.signal.aborted) throw abortError();

      if (request.block === 'sugar_cane' || request.block === 'reeds') {
        return collectSugarCane(current, request, block.id);
      }

      const positions = current.findBlocks({
        matching: block.id,
        maxDistance: request.radius,
        count: request.quantity,
      });
      const blocks = positions
        .map((position: any) => current.blockAt(position))
        .filter(Boolean)
        .slice(0, request.quantity);
      if (blocks.length === 0) return 0;

      const cancel = () => void current.collectBlock.cancelTask();
      request.signal.addEventListener('abort', cancel, { once: true });
      try {
        await current.collectBlock.collect(blocks);
        if (request.signal.aborted) throw abortError();
        return blocks.length;
      } finally {
        request.signal.removeEventListener('abort', cancel);
      }
    },

    async collectBlock(options): Promise<MinecraftActionResult> {
      const current = requireBot(bot);
      const block = this.resolveBlock(options.block);
      if (!block) throw new Error(`Unknown Minecraft block: ${options.block}`);
      const before = inventoryCounts(current)[block] ?? 0;
      const collected = await this.collect({
        block,
        quantity: options.maxCount,
        radius: options.radius,
        signal: new AbortController().signal,
      });
      const after = inventoryCounts(current)[block] ?? before + collected;
      return {
        actionId: '',
        outcome: collected > 0 ? 'succeeded' : 'partial',
        summary: collected > 0 ? `collected ${collected} ${block}` : `no ${block} collected`,
        durationMs: 0,
        inventoryDelta: { [block]: Math.max(collected, after - before) },
        worldChanges: collected > 0 ? [{ kind: 'block_broken', name: block, count: collected }] : [],
        observations: [],
      };
    },

    async pickupDrops(options): Promise<MinecraftActionResult> {
      return {
        actionId: '',
        outcome: 'succeeded',
        summary: `checked drops within ${options.radius} blocks`,
        durationMs: 0,
        inventoryDelta: {},
        worldChanges: [],
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
    nearbyBlocks: connected ? visibleBlocks(bot) : [],
    nearbyEntities: connected ? visibleEntities(bot) : [],
    recentEvents: [],
  };
}

function worldSnapshot(bot: any): MinecraftRawObservation['world'] {
  return {
    dimension: bot.game?.dimension ?? bot.dimension ?? 'unknown',
    biome: currentBiome(bot),
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

function currentBiome(bot: any): string | undefined {
  const position = bot.entity?.position;
  if (!position || typeof bot.blockAt !== 'function') return undefined;
  const block = bot.blockAt(position);
  return block?.biome?.name ?? block?.biome?.displayName;
}

function inventoryCounts(bot: any): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of bot.inventory?.items?.() ?? []) {
    const name = item.name ?? String(item.type);
    counts[name] = (counts[name] ?? 0) + (item.count ?? 1);
  }
  return counts;
}

function visibleBlocks(bot: any): MinecraftObservedBlock[] {
  const blocksByName = bot.registry?.blocksByName ?? {};
  const names = ['sugar_cane', 'reeds', 'oak_log', 'birch_log', 'stone', 'iron_ore', 'coal_ore'];
  const seen = new Map<string, MinecraftObservedBlock>();
  for (const name of names) {
    const block = blocksByName[name];
    if (!block || typeof bot.findBlocks !== 'function') continue;
    const positions = bot.findBlocks({ matching: block.id, maxDistance: 16, count: 16 }) ?? [];
    for (const position of positions) {
      const liveBlock = typeof bot.blockAt === 'function' ? bot.blockAt(position) : undefined;
      const blockName = liveBlock?.name ?? name;
      const observed: MinecraftObservedBlock = {
        name: blockName,
        displayName: liveBlock?.displayName,
        position: vector(position),
        distance: distanceToBot(bot, position),
      };
      seen.set(`${observed.name}:${observed.position.x}:${observed.position.y}:${observed.position.z}`, observed);
    }
  }
  return [...seen.values()];
}

function visibleEntities(bot: any): MinecraftObservedEntity[] {
  return Object.values(bot.entities ?? {})
    .filter((entity: any) => entity !== bot.entity && entity?.position)
    .map((entity: any) => {
      const name = entity.username ?? entity.name ?? entity.mobType ?? entity.type ?? 'unknown';
      return {
        name,
        type: entity.type ?? 'unknown',
        position: vector(entity.position),
        distance: distanceToBot(bot, entity.position),
        hostile: HOSTILE_MOBS.has(entity.name ?? entity.mobType ?? ''),
      };
    });
}

function vector(position: any): { x: number; y: number; z: number } {
  return {
    x: Number(position?.x ?? 0),
    y: Number(position?.y ?? 0),
    z: Number(position?.z ?? 0),
  };
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
  const cancel = () => bot.pathfinder?.stop?.();
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

function offset(position: any, x: number, y: number, z: number): any {
  return typeof position.offset === 'function'
    ? position.offset(x, y, z)
    : { x: position.x + x, y: position.y + y, z: position.z + z };
}

function horizontalDistanceSquared(left: any, right: any): number {
  const x = left.x - right.x;
  const z = left.z - right.z;
  return x * x + z * z;
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

function emitPlayers(bot: any, emit: (event: MinecraftRuntimeEvent) => void): void {
  emit({ kind: 'players', players: humanPlayerNames(bot) });
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
  const name = entity.name ?? entity.mobType ?? 'unknown';
  return { kind: HOSTILE_MOBS.has(name) ? 'hostile' : 'neutral', name };
}

function abortError(): Error {
  const error = new Error('Minecraft collection cancelled');
  error.name = 'AbortError';
  return error;
}
