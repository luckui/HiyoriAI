import { randomUUID } from 'node:crypto';
import type {
  MinecraftRawObservation,
  MinecraftBehavior,
  MinecraftRuntimeEvent,
  MinecraftStatus,
  MinecraftTerminalOutcome,
} from './protocol';

export interface MinecraftConnectionOptions {
  host: string;
  port: number;
  username: string;
  owner?: string;
}

export interface CollectionRequest {
  block: string;
  quantity: number;
  radius: number;
  signal: AbortSignal;
}

export interface MinecraftEntitySnapshot {
  kind: 'player' | 'hostile' | 'neutral';
  name: string;
}

export interface MinecraftPolicyHandlers {
  onFoodState(state: { food: number; hasInventoryFood: boolean }): void;
  shouldDefendAgainst(entity: MinecraftEntitySnapshot): boolean;
}

export interface MinecraftBotAdapter {
  connect(options: MinecraftConnectionOptions): Promise<void>;
  disconnect(): Promise<void>;
  status(): MinecraftStatus;
  getRawObservation(ownerName?: string): MinecraftRawObservation;
  say(message: string): Promise<void>;
  startFollowing(player: string): Promise<void>;
  stopForeground(): Promise<void>;
  resolveBlock(name: string): string | null;
  collect(request: CollectionRequest): Promise<number>;
  configurePolicies(handlers: MinecraftPolicyHandlers): void;
}

export interface CollectionAccepted {
  state: 'running';
  jobId: string;
  block: string;
  quantity: number;
  radius: number;
}

export class MinecraftBodyController {
  private behavior: MinecraftBehavior = { kind: 'idle' };
  private collectionAbort?: AbortController;
  private foodShortageActive = false;
  private readonly terminalJobs = new Set<string>();

  constructor(
    private readonly adapter: MinecraftBotAdapter,
    private readonly emit: (event: MinecraftRuntimeEvent) => void,
  ) {
    adapter.configurePolicies({
      onFoodState: (state) => this.handleFoodState(state),
      shouldDefendAgainst: (entity) => entity.kind === 'hostile',
    });
  }

  async connect(options: MinecraftConnectionOptions): Promise<MinecraftStatus> {
    await this.adapter.connect(options);
    return this.status();
  }

  async disconnect(): Promise<void> {
    await this.cancelForeground();
    await this.adapter.disconnect();
  }

  status(): MinecraftStatus {
    return { ...this.adapter.status(), behavior: this.behavior };
  }

  async say(message: string): Promise<void> {
    await this.adapter.say(message);
  }

  async follow(input: { player: string }): Promise<{ state: 'following'; player: string }> {
    await this.cancelForeground();
    await this.adapter.startFollowing(input.player);
    this.behavior = { kind: 'follow', player: input.player };
    return { state: 'following', player: input.player };
  }

  async collect(input: {
    block: string;
    quantity: number;
    radius?: number;
  }): Promise<CollectionAccepted> {
    const block = this.adapter.resolveBlock(input.block);
    if (!block) throw new Error(`Unknown Minecraft block: ${input.block}`);

    await this.cancelForeground();
    const quantity = clampInteger(input.quantity, 1, 64);
    const radius = clampInteger(input.radius ?? 32, 1, 64);
    const jobId = randomUUID();
    const abort = new AbortController();
    this.collectionAbort = abort;
    this.behavior = {
      kind: 'collect',
      jobId,
      block,
      requested: quantity,
      collected: 0,
    };

    void this.adapter
      .collect({ block, quantity, radius, signal: abort.signal })
      .then((collected) => {
        const outcome: MinecraftTerminalOutcome =
          collected >= quantity ? 'completed' : 'partial';
        this.finishCollection(jobId, outcome, block, quantity, collected);
      })
      .catch((error) => {
        const cancelled = abort.signal.aborted;
        this.finishCollection(
          jobId,
          cancelled ? 'cancelled' : 'failed',
          block,
          quantity,
          currentCollected(this.behavior, jobId),
          cancelled ? undefined : errorMessage(error),
        );
      });

    return { state: 'running', jobId, block, quantity, radius };
  }

  async stop(): Promise<void> {
    await this.cancelForeground();
  }

  private async cancelForeground(): Promise<void> {
    if (this.behavior.kind === 'idle') return;
    this.collectionAbort?.abort();
    this.collectionAbort = undefined;
    await this.adapter.stopForeground();
    this.behavior = { kind: 'idle' };
  }

  private finishCollection(
    jobId: string,
    outcome: MinecraftTerminalOutcome,
    block: string,
    requested: number,
    collected: number,
    message?: string,
  ): void {
    if (this.terminalJobs.has(jobId)) return;
    this.terminalJobs.add(jobId);
    if (this.behavior.kind === 'collect' && this.behavior.jobId === jobId) {
      this.behavior = { kind: 'idle' };
      this.collectionAbort = undefined;
    }
    this.emit({
      kind: 'collection-terminal',
      jobId,
      outcome,
      block,
      requested,
      collected,
      message,
    });
  }

  private handleFoodState(state: {
    food: number;
    hasInventoryFood: boolean;
  }): void {
    const shortage = state.food <= 6 && !state.hasInventoryFood;
    if (shortage && !this.foodShortageActive) {
      this.foodShortageActive = true;
      this.emit({ kind: 'food-shortage', food: state.food });
      return;
    }
    if (!shortage && this.foodShortageActive) {
      this.foodShortageActive = false;
      this.emit({ kind: 'food-recovered', food: state.food });
    }
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function currentCollected(behavior: MinecraftBehavior, jobId: string): number {
  return behavior.kind === 'collect' && behavior.jobId === jobId
    ? behavior.collected
    : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
