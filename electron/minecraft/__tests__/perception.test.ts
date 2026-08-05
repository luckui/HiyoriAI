import { describe, expect, it } from 'vitest';
import { buildMinecraftSnapshot } from '../perception';

describe('buildMinecraftSnapshot', () => {
  it('keeps only visible nearby facts and marks connected snapshots fresh', () => {
    const snapshot = buildMinecraftSnapshot({
      capturedAt: 1784440000000,
      connection: { connected: true, username: 'Hiyori' },
      world: { dimension: 'overworld', biome: 'forest' },
      body: { position: { x: 0, y: 68, z: 0 }, health: 20, food: 19, inventory: { apple: 2 } },
      owner: { name: 'Player', visible: true, distance: 6, relativeDirection: 'behind' },
      follow: { phase: 'approaching', target: 'Player', distance: 6 },
      nearbyBlocks: [{ name: 'sugar_cane', position: { x: 3, y: 64, z: 1 }, distance: 3.2 }],
      nearbyEntities: [{ name: 'zombie', type: 'mob', position: { x: 8, y: 64, z: 0 }, distance: 8, hostile: true }],
      recentEvents: [],
    });

    expect(snapshot.stale).toBe(false);
    expect(snapshot.nearby.blocks[0].name).toBe('sugar_cane');
    expect(snapshot.follow.phase).toBe('approaching');
  });

  it('marks disconnected snapshots stale and leaves body undefined', () => {
    const snapshot = buildMinecraftSnapshot({
      capturedAt: 1784440000000,
      connection: { connected: false },
      nearbyBlocks: [],
      nearbyEntities: [],
      recentEvents: [],
    });

    expect(snapshot.stale).toBe(true);
    expect(snapshot.body).toBeUndefined();
  });
});
