export type TaskSlotPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'cancelling'
  | 'replacing'
  | 'paused'
  | 'stopping';

export interface TaskSlotRun<TResult> {
  executionId: string;
  settled: Promise<TResult>;
  cancel(reason: string): Promise<TResult>;
  fail?(reason: string): Promise<TResult>;
}

export interface TaskSlotDriver<TGoal, TCheckpoint, TResult> {
  start(input: {
    slotKey: string;
    generation: number;
    goal: TGoal;
    checkpoint?: TCheckpoint;
  }): Promise<TaskSlotRun<TResult>>;
  captureCheckpoint(input: {
    goal: TGoal;
    reason: 'paused' | 'replaced' | 'cancelled' | 'completed' | 'failed';
    previous?: TCheckpoint;
  }): Promise<TCheckpoint | undefined>;
  release(): Promise<void>;
}

export interface TaskSlotStatus<TGoal, TCheckpoint> {
  slotKey: string;
  phase: TaskSlotPhase;
  generation: number;
  goal?: TGoal;
  checkpoint?: TCheckpoint;
}

export interface TaskSlotTerminal<TGoal, TCheckpoint, TResult> {
  slotKey: string;
  generation: number;
  goal: TGoal;
  checkpoint?: TCheckpoint;
  result: TResult;
}

interface TaskSlotCallbacks<TGoal, TCheckpoint, TResult> {
  onTerminal?(event: TaskSlotTerminal<TGoal, TCheckpoint, TResult>): void;
  onStale?(event: TaskSlotTerminal<TGoal, TCheckpoint, TResult>): void;
  onTransition?(status: TaskSlotStatus<TGoal, TCheckpoint>): void;
}

export class TaskSlotController<TGoal, TCheckpoint, TResult> {
  private phase: TaskSlotPhase = 'idle';
  private generation = 0;
  private goal?: TGoal;
  private checkpoint?: TCheckpoint;
  private activeRun?: TaskSlotRun<TResult>;
  private mutations: Promise<void> = Promise.resolve();

  constructor(
    private readonly slotKey: string,
    private readonly driver: TaskSlotDriver<TGoal, TCheckpoint, TResult>,
    private readonly callbacks: TaskSlotCallbacks<TGoal, TCheckpoint, TResult> = {},
  ) {}

  status(): TaskSlotStatus<TGoal, TCheckpoint> {
    return {
      slotKey: this.slotKey,
      phase: this.phase,
      generation: this.generation,
      ...(this.goal === undefined ? {} : { goal: structuredClone(this.goal) }),
      ...(this.checkpoint === undefined ? {} : { checkpoint: structuredClone(this.checkpoint) }),
    };
  }

  setGoal(goal: TGoal): Promise<void> {
    return this.enqueue(async () => {
      const previousGoal = this.goal;
      const previousRun = this.activeRun;
      const replacing = previousGoal !== undefined;
      this.generation += 1;
      this.phase = replacing ? 'replacing' : 'starting';
      this.emitTransition();

      if (previousGoal) {
        if (previousRun) await previousRun.cancel('replaced');
        this.checkpoint = await this.driver.captureCheckpoint({
          goal: previousGoal,
          reason: 'replaced',
          previous: this.checkpoint,
        });
        await this.driver.release();
      }

      this.goal = structuredClone(goal);
      try {
        await this.startCurrentGeneration();
      } catch (error) {
        this.activeRun = undefined;
        this.goal = undefined;
        this.checkpoint = undefined;
        this.phase = 'idle';
        this.emitTransition();
        throw error;
      }
    });
  }

  pause(): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.goal || this.phase === 'paused') return false;
      const goal = this.goal;
      const run = this.activeRun;
      this.phase = 'cancelling';
      this.emitTransition();
      if (run) await run.cancel('paused');
      this.activeRun = undefined;
      this.checkpoint = await this.driver.captureCheckpoint({
        goal,
        reason: 'paused',
        previous: this.checkpoint,
      });
      await this.driver.release();
      this.phase = 'paused';
      this.emitTransition();
      return true;
    });
  }

  resume(): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.goal || this.phase !== 'paused') return false;
      this.generation += 1;
      this.phase = 'starting';
      this.emitTransition();
      try {
        await this.startCurrentGeneration();
      } catch (error) {
        this.activeRun = undefined;
        this.phase = 'paused';
        this.emitTransition();
        throw error;
      }
      return true;
    });
  }

  cancel(reason = 'cancelled'): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.goal) return false;
      const goal = this.goal;
      const run = this.activeRun;
      this.phase = 'cancelling';
      this.emitTransition();
      if (run) await run.cancel(reason);
      this.activeRun = undefined;
      this.checkpoint = await this.driver.captureCheckpoint({
        goal,
        reason: 'cancelled',
        previous: this.checkpoint,
      });
      await this.driver.release();
      this.goal = undefined;
      this.checkpoint = undefined;
      this.phase = 'idle';
      this.emitTransition();
      return true;
    });
  }

  fail(reason: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.goal || !this.activeRun) return false;
      const run = this.activeRun;
      if (run.fail) await run.fail(reason);
      else await run.cancel(`failed:${reason}`);
      return true;
    });
  }

  shutdown(): Promise<void> {
    return this.enqueue(async () => {
      this.phase = 'stopping';
      this.emitTransition();
      if (this.activeRun) await this.activeRun.cancel('shutdown');
      this.activeRun = undefined;
      await this.driver.release();
      this.goal = undefined;
      this.checkpoint = undefined;
      this.phase = 'idle';
      this.emitTransition();
    });
  }

  private async startCurrentGeneration(): Promise<void> {
    if (!this.goal) return;
    const generation = this.generation;
    const goal = structuredClone(this.goal);
    const run = await this.driver.start({
      slotKey: this.slotKey,
      generation,
      goal,
      checkpoint: this.checkpoint,
    });
    this.activeRun = run;
    this.phase = 'running';
    this.emitTransition();
    void run.settled.then((result) => this.handleSettlement(generation, goal, run, result));
  }

  private handleSettlement(
    generation: number,
    goal: TGoal,
    run: TaskSlotRun<TResult>,
    result: TResult,
  ): void {
    void this.enqueue(async () => {
      if (generation !== this.generation || this.activeRun !== run) {
        this.callbacks.onStale?.({ slotKey: this.slotKey, generation, goal, result });
        return;
      }
      const reason = resultOutcome(result) === 'failed' ? 'failed' : 'completed';
      this.checkpoint = await this.driver.captureCheckpoint({
        goal,
        reason,
        previous: this.checkpoint,
      });
      await this.driver.release();
      this.activeRun = undefined;
      const terminal = {
        slotKey: this.slotKey,
        generation,
        goal,
        checkpoint: this.checkpoint,
        result,
      };
      this.goal = undefined;
      this.checkpoint = undefined;
      this.phase = 'idle';
      this.emitTransition();
      this.callbacks.onTerminal?.(terminal);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation, operation);
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  private emitTransition(): void {
    this.callbacks.onTransition?.(this.status());
  }
}

function resultOutcome(result: unknown): unknown {
  return result && typeof result === 'object' && 'outcome' in result
    ? (result as { outcome?: unknown }).outcome
    : undefined;
}
