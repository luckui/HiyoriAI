import { describe, expect, it } from 'vitest';
import type { MinecraftEnvironmentSnapshot } from '../contracts';
import { MinecraftFollowController } from '../followController';

function snapshot(distance?: number, visible = true): MinecraftEnvironmentSnapshot {
  return {
    capturedAt: Date.now(),
    stale: false,
    connection: { connected: true },
    owner: { name: 'Player', visible, distance },
    follow: { phase: 'inactive' },
    nearby: { blocks: [], entities: [] },
    recentEvents: [],
  };
}

describe('MinecraftFollowController', () => {
  it('reports approaching before nearby and target-lost when player disappears', () => {
    const follow = new MinecraftFollowController({ nearbyDistance: 4 });
    follow.start('Player');

    expect(follow.update(snapshot(12))[0].text).toContain('coming');
    expect(follow.getPhase().phase).toBe('approaching');
    follow.update(snapshot(3));
    expect(follow.getPhase().phase).toBe('nearby');
    follow.update(snapshot(undefined, false));
    expect(follow.getPhase().phase).toBe('target-lost');
  });
});
