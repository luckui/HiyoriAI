import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createMineflayerAdapter } from '../mineflayerAdapter';
import type { MinecraftRuntimeEvent } from '../protocol';

function createFakeBot() {
  const bot = new EventEmitter() as any;
  bot.username = 'Hiyori';
  bot.health = 20;
  bot.food = 20;
  bot.players = {
    GeoLingua: { username: 'GeoLingua', entity: { id: 7 } },
  };
  bot.entity = { position: { x: 0, y: 64, z: 0 } };
  bot.registry = {
    blocksByName: { oak_log: { id: 17 } },
    foodsByName: { bread: { id: 297 } },
  };
  bot.inventory = { items: vi.fn(() => []) };
  bot.loadPlugin = vi.fn((plugin: (value: any) => void) => plugin(bot));
  bot.chat = vi.fn();
  bot.end = vi.fn();
  bot.findBlocks = vi.fn(() => [
    { x: 1, y: 64, z: 1 },
    { x: 2, y: 64, z: 2 },
  ]);
  bot.blockAt = vi.fn((position) => ({ position, name: 'oak_log' }));
  bot.pathfinder = { setGoal: vi.fn(), stop: vi.fn() };
  bot.collectBlock = { collect: vi.fn(async () => undefined), cancelTask: vi.fn() };
  bot.autoEat = { enableAuto: vi.fn(), disableAuto: vi.fn() };
  bot.pvp = { attack: vi.fn(), stop: vi.fn(async () => undefined) };
  return bot;
}

describe('createMineflayerAdapter', () => {
  it('connects offline, forwards public chat, and follows a player dynamically', async () => {
    const events: MinecraftRuntimeEvent[] = [];
    const bot = createFakeBot();
    const createBot = vi.fn(() => bot);
    const adapter = createMineflayerAdapter((event) => events.push(event), {
      createBot,
      plugins: [vi.fn(), vi.fn(), vi.fn(), vi.fn()],
      createFollowGoal: (entity, range) => ({ entity, range }),
    });

    const connected = adapter.connect({
      host: '127.0.0.1',
      port: 60131,
      username: 'Hiyori',
      owner: 'GeoLingua',
    });
    bot.emit('spawn');
    await connected;
    bot.emit('chat', 'Hiyori', 'own reply');
    bot.emit('chat', 'GeoLingua', 'hello');
    await adapter.startFollowing('GeoLingua');

    expect(createBot).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 60131,
      username: 'Hiyori',
      auth: 'offline',
    });
    expect(bot.loadPlugin).toHaveBeenCalledTimes(4);
    expect(events).toContainEqual({ kind: 'chat', player: 'GeoLingua', message: 'hello' });
    expect(events).not.toContainEqual(expect.objectContaining({ player: 'Hiyori' }));
    expect(bot.pathfinder.setGoal).toHaveBeenCalledWith(
      { entity: { id: 7 }, range: 2 },
      true,
    );
  });

  it('collects only the requested nearby blocks', async () => {
    const bot = createFakeBot();
    const adapter = createMineflayerAdapter(vi.fn(), {
      createBot: () => bot,
      plugins: [vi.fn(), vi.fn(), vi.fn(), vi.fn()],
      createFollowGoal: vi.fn(),
    });
    const connected = adapter.connect({ host: '127.0.0.1', port: 1, username: 'Hiyori' });
    bot.emit('spawn');
    await connected;

    const collected = await adapter.collect({
      block: 'oak_log',
      quantity: 1,
      radius: 32,
      signal: new AbortController().signal,
    });

    expect(bot.findBlocks).toHaveBeenCalledWith({ matching: 17, maxDistance: 32, count: 1 });
    expect(bot.collectBlock.collect).toHaveBeenCalledWith([
      { position: { x: 1, y: 64, z: 1 }, name: 'oak_log' },
    ]);
    expect(collected).toBe(1);
  });
});
