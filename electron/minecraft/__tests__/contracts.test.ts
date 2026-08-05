import { describe, expect, it } from 'vitest';
import type {
  MinecraftActionInstruction,
  MinecraftEnvironmentSnapshot,
  MinecraftWorkerCommand,
} from '../contracts';

describe('minecraft contracts', () => {
  it('models a portable snapshot and action command without adapter objects', async () => {
    await expect(import('../contracts')).resolves.toBeTruthy();

    const snapshot: MinecraftEnvironmentSnapshot = {
      capturedAt: 1784440000000,
      stale: false,
      connection: { connected: true, host: '127.0.0.1', port: 60131, username: 'Hiyori' },
      world: { dimension: 'overworld', biome: 'forest' },
      body: { position: { x: 1, y: 64, z: 2 }, health: 20, food: 18, inventory: { dirt: 3 } },
      owner: { name: 'Player', visible: true, distance: 4.2, relativeDirection: 'front-left' },
      follow: { phase: 'nearby', target: 'Player', distance: 4.2 },
      nearby: { blocks: [], entities: [] },
      recentEvents: [],
    };
    const instruction: MinecraftActionInstruction = {
      id: 'act-1',
      name: 'collect_block',
      args: { block: 'sugar_cane', scope: 'nearby' },
    };
    const command: MinecraftWorkerCommand = { type: 'execute-action', requestId: 'req-1', instruction };

    expect(snapshot.connection.connected).toBe(true);
    expect(command.type).toBe('execute-action');
  });
});
