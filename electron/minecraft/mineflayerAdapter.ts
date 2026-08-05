import { createBot, type Bot } from 'mineflayer';
import { loader as autoEatPlugin } from 'mineflayer-auto-eat';
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock';
import { goals, pathfinder } from 'mineflayer-pathfinder';
import { plugin as pvpPlugin } from 'mineflayer-pvp';
import type {
  CollectionRequest,
  MinecraftBotAdapter,
  MinecraftConnectionOptions,
  MinecraftEntitySnapshot,
  MinecraftPolicyHandlers,
} from './bodyController';
import type { MinecraftRuntimeEvent, MinecraftStatus } from './protocol';

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
  plugins: [pathfinder, collectBlockPlugin, autoEatPlugin, pvpPlugin],
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

  return {
    async connect(options) {
      if (bot) return;
      owner = options.owner;
      connection = options;
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
        emit({ kind: 'disconnected', reason: reason || 'Minecraft connection ended' });
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
      bot = undefined;
      current.autoEat?.disableAuto?.();
      await current.pvp?.stop?.();
      current.pathfinder?.stop?.();
      await current.collectBlock?.cancelTask?.();
      current.end('Hiyori disconnected');
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

    async say(message) {
      requireBot(bot).chat(message);
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
      return bot.registry?.blocksByName?.[normalized] ? normalized : null;
    },

    async collect(request: CollectionRequest) {
      const current = requireBot(bot);
      const block = current.registry.blocksByName[request.block];
      if (!block) throw new Error(`Unknown Minecraft block: ${request.block}`);
      if (request.signal.aborted) throw abortError();

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

    configurePolicies(handlers) {
      policyHandlers = handlers;
    },
  };
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
