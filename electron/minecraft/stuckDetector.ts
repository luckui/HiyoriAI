import type { MinecraftFact } from './contracts';

export interface PositionSample {
  at: number;
  position: { x: number; y: number; z: number };
  pathStatus?: 'moving' | 'stuck' | 'noPath' | 'arrived';
}

export class StuckDetector {
  private readonly samples: PositionSample[] = [];
  private emitted = false;

  constructor(private readonly options: { minDistance: number; windowMs: number }) {}

  add(sample: PositionSample): MinecraftFact | null {
    if (sample.pathStatus === 'arrived') {
      this.reset();
      this.samples.push(sample);
      return null;
    }

    this.samples.push(sample);
    if (this.emitted || this.samples.length < 2) return null;

    const first = this.samples[0];
    if (sample.at - first.at < this.options.windowMs) return null;
    if (distance(first.position, sample.position) >= this.options.minDistance) {
      this.trim(sample.at);
      return null;
    }
    if (sample.pathStatus === 'noPath' || sample.pathStatus === 'stuck' || sample.pathStatus === 'moving') {
      this.emitted = true;
      return {
        id: `movement.blocked:${sample.at}`,
        at: sample.at,
        severity: 'warning',
        kind: 'movement.blocked',
        text: 'Minecraft movement appears blocked.',
        data: { windowMs: this.options.windowMs },
      };
    }
    return null;
  }

  reset(): void {
    this.samples.length = 0;
    this.emitted = false;
  }

  private trim(now: number): void {
    while (this.samples.length > 0 && now - this.samples[0].at > this.options.windowMs) {
      this.samples.shift();
    }
  }
}

function distance(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): number {
  const x = left.x - right.x;
  const y = left.y - right.y;
  const z = left.z - right.z;
  return Math.sqrt(x * x + y * y + z * z);
}
