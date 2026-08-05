import { describe, expect, it } from 'vitest';
import type { MinecraftEnvironmentSnapshot } from '../contracts';
import { MinecraftReflexEngine } from '../reflexEngine';

function snapshot(food: number): MinecraftEnvironmentSnapshot {
  return {
    capturedAt: Date.now(),
    stale: false,
    connection: { connected: true },
    body: { position: { x: 0, y: 64, z: 0 }, health: 20, food, inventory: { bread: 1 } },
    follow: { phase: 'inactive' },
    nearby: { blocks: [], entities: [] },
    recentEvents: [],
  };
}

describe('MinecraftReflexEngine', () => {
  it('requests eating once when hunger is low and food is available', () => {
    const engine = new MinecraftReflexEngine();

    expect(engine.update(snapshot(5))[0]).toMatchObject({ name: 'eat' });
    expect(engine.update(snapshot(5))).toEqual([]);
    expect(engine.update(snapshot(18))).toEqual([]);
    expect(engine.update(snapshot(5))[0]).toMatchObject({ name: 'eat' });
  });
});
