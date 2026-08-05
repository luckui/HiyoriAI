import { describe, expect, it, vi } from 'vitest';
import {
  MinecraftBodyController,
  type CollectionRequest,
  type MinecraftBotAdapter,
  type MinecraftPolicyHandlers,
} from '../bodyController';
import type { MinecraftRuntimeEvent } from '../protocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createFakeAdapter() {
  let policyHandlers: MinecraftPolicyHandlers | undefined;
  const collection = deferred<number>();
  const adapter: MinecraftBotAdapter = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    status: vi.fn(() => ({
      connected: true,
      username: 'Hiyori',
      players: ['GeoLingua'],
      behavior: { kind: 'idle' as const },
    })),
    say: vi.fn(async () => undefined),
    startFollowing: vi.fn(async () => undefined),
    stopForeground: vi.fn(async () => undefined),
    resolveBlock: vi.fn((name: string) => (name === 'oak_log' ? name : null)),
    collect: vi.fn(async (_request: CollectionRequest) => collection.promise),
    configurePolicies: vi.fn((handlers: MinecraftPolicyHandlers) => {
      policyHandlers = handlers;
    }),
  };
  return {
    adapter,
    collection,
    getPolicyHandlers: () => policyHandlers!,
  };
}

describe('MinecraftBodyController', () => {
  it('changes persistent foreground behavior without polling', async () => {
    const fake = createFakeAdapter();
    const controller = new MinecraftBodyController(fake.adapter, vi.fn());

    await controller.follow({ player: 'GeoLingua' });
    expect(controller.status().behavior).toEqual({
      kind: 'follow',
      player: 'GeoLingua',
    });

    const accepted = await controller.collect({
      block: 'oak_log',
      quantity: 10,
      radius: 32,
    });
    expect(accepted.state).toBe('running');
    expect(fake.adapter.stopForeground).toHaveBeenCalledOnce();
    expect(controller.status().behavior).toMatchObject({
      kind: 'collect',
      block: 'oak_log',
      requested: 10,
    });
  });

  it('caps collection input and emits exactly one terminal event', async () => {
    const fake = createFakeAdapter();
    const events: MinecraftRuntimeEvent[] = [];
    const controller = new MinecraftBodyController(fake.adapter, (event) =>
      events.push(event),
    );

    await controller.collect({ block: 'oak_log', quantity: 999, radius: 999 });
    expect(fake.adapter.collect).toHaveBeenCalledWith(
      expect.objectContaining({
        block: 'oak_log',
        quantity: 64,
        radius: 64,
      }),
    );
    fake.collection.resolve(12);
    await vi.waitFor(() => {
      expect(events.filter((event) => event.kind === 'collection-terminal')).toHaveLength(1);
    });
    expect(events[0]).toMatchObject({
      kind: 'collection-terminal',
      outcome: 'partial',
      requested: 64,
      collected: 12,
    });
    expect(controller.status().behavior).toEqual({ kind: 'idle' });
  });

  it('rejects unknown blocks and makes stop idempotent', async () => {
    const fake = createFakeAdapter();
    const controller = new MinecraftBodyController(fake.adapter, vi.fn());

    await expect(
      controller.collect({ block: 'diamond_that_does_not_exist', quantity: 1 }),
    ).rejects.toThrow('Unknown Minecraft block');
    await controller.stop();
    await controller.stop();
    expect(controller.status().behavior).toEqual({ kind: 'idle' });
  });

  it('never defends against players or neutral entities', () => {
    const fake = createFakeAdapter();
    new MinecraftBodyController(fake.adapter, vi.fn());
    const policy = fake.getPolicyHandlers();

    expect(policy.shouldDefendAgainst({ kind: 'player', name: 'Alex' })).toBe(false);
    expect(policy.shouldDefendAgainst({ kind: 'neutral', name: 'cow' })).toBe(false);
    expect(policy.shouldDefendAgainst({ kind: 'hostile', name: 'zombie' })).toBe(true);
  });

  it('emits one food shortage event until food recovers', () => {
    const fake = createFakeAdapter();
    const events: MinecraftRuntimeEvent[] = [];
    new MinecraftBodyController(fake.adapter, (event) => events.push(event));
    const policy = fake.getPolicyHandlers();

    policy.onFoodState({ food: 5, hasInventoryFood: false });
    policy.onFoodState({ food: 4, hasInventoryFood: false });
    policy.onFoodState({ food: 12, hasInventoryFood: true });
    policy.onFoodState({ food: 5, hasInventoryFood: false });

    expect(events.filter((event) => event.kind === 'food-shortage')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'food-recovered')).toHaveLength(1);
  });
});
