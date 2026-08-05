import { describe, expect, it, vi } from 'vitest';
import type { MinecraftEnvironmentSnapshot } from '../contracts';
import { MinecraftEmbodimentRuntime } from '../embodimentRuntime';
import type { MinecraftBodyAdapter } from '../actions/types';

function baseSnapshot(): MinecraftEnvironmentSnapshot {
  return {
    capturedAt: 1,
    stale: false,
    connection: { connected: true },
    follow: { phase: 'inactive' },
    nearby: { blocks: [], entities: [] },
    recentEvents: [],
  };
}

function fakeAdapter(overrides: Partial<MinecraftBodyAdapter> = {}): MinecraftBodyAdapter {
  return {
    isConnected: () => true,
    getSnapshot: vi.fn(async () => baseSnapshot()),
    say: vi.fn(async () => undefined),
    navigateToPlayer: vi.fn(async () => undefined),
    stopNavigation: vi.fn(async () => undefined),
    inspect: vi.fn(async () => baseSnapshot()),
    collectBlock: vi.fn(async (options) => ({
      actionId: 'act-1',
      outcome: 'succeeded',
      summary: `collected ${options.block}`,
      durationMs: 10,
      inventoryDelta: { [options.block]: 3 },
      worldChanges: [{ kind: 'block_broken', name: options.block, count: 3 }],
      observations: [],
    })),
    pickupDrops: vi.fn(async () => ({
      actionId: 'act-2',
      outcome: 'succeeded',
      summary: 'picked up drops',
      durationMs: 10,
      inventoryDelta: {},
      worldChanges: [],
      observations: [],
    })),
    ...overrides,
  };
}

describe('MinecraftEmbodimentRuntime', () => {
  it('executes collect_block through the registry and verifies whole sugar cane collection', async () => {
    const adapter = fakeAdapter();
    const runtime = new MinecraftEmbodimentRuntime({ adapter, now: () => 100 });

    const result = await runtime.execute({
      id: 'act-1',
      name: 'collect_block',
      args: { block: 'sugar_cane', scope: 'nearby' },
    });

    expect(adapter.collectBlock).toHaveBeenCalledWith({
      block: 'sugar_cane',
      radius: 16,
      maxCount: 64,
      preserveRoot: false,
    });
    expect(result.outcome).toBe('succeeded');
  });

  it('returns a recoverable not_connected result instead of throwing', async () => {
    const runtime = new MinecraftEmbodimentRuntime({ adapter: fakeAdapter({ isConnected: () => false }) });

    const result = await runtime.execute({ id: 'act-3', name: 'inspect', args: { radius: 12 } });

    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('not_connected');
    expect(result.error?.recoverable).toBe(true);
  });
});
