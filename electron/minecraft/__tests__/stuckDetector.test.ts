import { describe, expect, it } from 'vitest';
import { StuckDetector } from '../stuckDetector';

describe('StuckDetector', () => {
  it('emits one blocked fact when position barely changes across samples', () => {
    const detector = new StuckDetector({ minDistance: 0.4, windowMs: 4000 });
    detector.add({ at: 0, position: { x: 1, y: 64, z: 1 }, pathStatus: 'moving' });
    detector.add({ at: 2000, position: { x: 1.1, y: 64, z: 1.05 }, pathStatus: 'moving' });
    const fact = detector.add({ at: 4500, position: { x: 1.15, y: 64, z: 1.1 }, pathStatus: 'moving' });

    expect(fact?.kind).toBe('movement.blocked');
    expect(detector.add({ at: 4600, position: { x: 1.16, y: 64, z: 1.1 }, pathStatus: 'moving' })).toBeNull();
  });
});
