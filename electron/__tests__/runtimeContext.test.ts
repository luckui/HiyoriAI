import { afterEach, describe, expect, it } from 'vitest';
import type { MinecraftEnvironmentSnapshot } from '../minecraft/contracts';
import {
  buildRuntimeContext,
  formatMinecraftRuntimeContext,
  registerRuntimeContextProvider,
  resetRuntimeContextProvidersForTest,
} from '../runtimeContext';

afterEach(() => resetRuntimeContextProvidersForTest());

describe('runtime context registry', () => {
  it('builds fresh context and omits empty providers', async () => {
    let count = 0;
    registerRuntimeContextProvider('minecraft', async () => `Minecraft context ${++count}`);
    registerRuntimeContextProvider('empty', async () => null);

    expect(await buildRuntimeContext()).toContain('Minecraft context 1');
    expect(await buildRuntimeContext()).toContain('Minecraft context 2');
    expect(await buildRuntimeContext()).not.toContain('empty');
  });

  it('formats minecraft snapshots into compact turn context', () => {
    const snapshot: MinecraftEnvironmentSnapshot = {
      capturedAt: 1784440000000,
      stale: false,
      connection: { connected: true, username: 'Hiyori', host: '127.0.0.1', port: 60131 },
      world: { dimension: 'overworld', biome: 'forest' },
      body: {
        position: { x: 12, y: 67, z: -4 },
        health: 18,
        food: 11,
        inventory: { sugar_cane: 3 },
      },
      owner: { name: 'GeoLingua', visible: true, distance: 5.2, relativeDirection: 'north' },
      follow: { phase: 'approaching', target: 'GeoLingua', distance: 5.2 },
      nearby: {
        blocks: [{ name: 'sugar_cane', position: { x: 15, y: 64, z: -2 }, distance: 4 }],
        entities: [{ name: 'zombie', type: 'mob', position: { x: 20, y: 64, z: -2 }, distance: 9, hostile: true }],
      },
      recentEvents: [{ id: 'e1', at: 1784440000000, severity: 'warning', kind: 'movement.blocked', text: 'blocked' }],
    };

    const text = formatMinecraftRuntimeContext(snapshot);

    expect(text).toContain('Minecraft');
    expect(text).toContain('GeoLingua visible at 5.2 blocks');
    expect(text).toContain('sugar_cane at 4.0 blocks');
    expect(text).toContain('zombie hostile at 9.0 blocks');
    expect(text).toContain('movement.blocked: blocked');
  });
});
