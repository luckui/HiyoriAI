import type { MinecraftEnvironmentSnapshot, MinecraftFact } from './contracts';

export class MinecraftFollowController {
  private target?: string;
  private phase: MinecraftEnvironmentSnapshot['follow'] = { phase: 'inactive' };

  constructor(private readonly options: { nearbyDistance: number } = { nearbyDistance: 4 }) {}

  start(target: string): void {
    this.target = target;
    this.phase = { phase: 'approaching', target };
  }

  stop(): void {
    this.target = undefined;
    this.phase = { phase: 'inactive' };
  }

  update(snapshot: MinecraftEnvironmentSnapshot): MinecraftFact[] {
    if (!this.target) {
      this.phase = { phase: 'inactive' };
      return [];
    }

    const owner = snapshot.owner;
    const at = snapshot.capturedAt;
    if (!owner?.visible) {
      this.phase = { phase: 'target-lost', target: this.target };
      return [fact(at, 'follow.target-lost', `I lost sight of ${this.target}.`, 'warning')];
    }

    if (typeof owner.distance === 'number' && owner.distance <= this.options.nearbyDistance) {
      this.phase = { phase: 'nearby', target: this.target, distance: owner.distance };
      return [fact(at, 'follow.nearby', `I am near ${this.target}.`, 'info')];
    }

    this.phase = { phase: 'approaching', target: this.target, distance: owner.distance };
    return [fact(at, 'follow.approaching', `I am coming to ${this.target}.`, 'notice')];
  }

  getPhase(): MinecraftEnvironmentSnapshot['follow'] {
    return this.phase;
  }
}

function fact(
  at: number,
  kind: string,
  text: string,
  severity: MinecraftFact['severity'],
): MinecraftFact {
  return { id: `${kind}:${at}`, at, kind, text, severity };
}
