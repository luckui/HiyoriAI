import type { ReplyTarget } from '../bridges/asyncDelivery';
import type { DBTask } from '../db';
import {
  TaskSlotController,
  type TaskSlotDriver,
  type TaskSlotPhase,
  type TaskSlotRun,
  type TaskSlotTerminal,
} from '../taskSlot';
import type { MinecraftEnvironmentSnapshot } from './contracts';

export interface MinecraftGoal {
  title: string;
  instruction: string;
  conversationId: string;
  replyTarget?: ReplyTarget;
}

export interface MinecraftGoalCheckpoint {
  capturedAt: number;
  endReason: 'paused' | 'replaced' | 'cancelled' | 'completed' | 'failed';
  position?: { x: number; y: number; z: number };
  health?: number;
  food?: number;
  inventory: Record<string, number>;
  inventoryDelta: Record<string, number>;
  lastAction?: MinecraftEnvironmentSnapshot['action'];
}

export interface MinecraftGoalResult {
  outcome: 'completed' | 'failed' | 'cancelled';
  report: string;
  task: DBTask | null;
}

export interface MinecraftGoalTerminalNotice {
  generation: number;
  goal: MinecraftGoal;
  outcome: 'completed' | 'failed';
  report: string;
  checkpoint?: MinecraftGoalCheckpoint;
}

export interface MinecraftGoalPublicState {
  phase: TaskSlotPhase;
  generation: number;
  title?: string;
  instruction?: string;
  checkpoint?: MinecraftGoalCheckpoint;
}

interface GoalTaskManager {
  createAndStart(options: {
    title: string;
    prompt: string;
    conversationId?: string;
    type?: 'background';
    context?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): DBTask;
  waitForTerminal(taskId: string): Promise<DBTask | null>;
  cancelTask(taskId: string, reason?: string): Promise<boolean>;
  failTask(taskId: string, error: string): Promise<boolean>;
}

interface GoalRuntime {
  command<T = unknown>(action: string, payload: unknown, timeoutMs?: number): Promise<T>;
  hasActiveWorker?(): boolean;
}

interface MinecraftGoalControllerOptions {
  taskManager: GoalTaskManager;
  runtime: GoalRuntime;
  onTerminal?(notice: MinecraftGoalTerminalNotice): void;
  onTrace?(event: Record<string, unknown>): void;
}

export class MinecraftGoalController {
  private baselineInventory: Record<string, number> = {};
  private readonly slot: TaskSlotController<MinecraftGoal, MinecraftGoalCheckpoint, MinecraftGoalResult>;

  constructor(private readonly options: MinecraftGoalControllerOptions) {
    const driver: TaskSlotDriver<MinecraftGoal, MinecraftGoalCheckpoint, MinecraftGoalResult> = {
      start: (input) => this.startExecution(input),
      captureCheckpoint: (input) => this.captureCheckpoint(input.reason),
      release: async () => {
        if (this.options.runtime.hasActiveWorker?.() === false) return;
        await this.options.runtime.command('task-release', {}, 5_000);
      },
    };
    this.slot = new TaskSlotController('minecraft', driver, {
      onTerminal: (event) => this.publishTerminal(event),
      onStale: (event) => this.options.onTrace?.({
        type: 'minecraft-slot-stale-result',
        generation: event.generation,
        executionId: event.result.task?.id,
        title: event.goal.title,
      }),
      onTransition: (status) => this.options.onTrace?.({
        type: 'minecraft-slot-transition',
        phase: status.phase,
        generation: status.generation,
        title: status.goal?.title,
      }),
    });
  }

  async set(goal: MinecraftGoal): Promise<MinecraftGoalPublicState> {
    await this.slot.setGoal(goal);
    return this.status();
  }

  async pause(): Promise<boolean> {
    return this.slot.pause();
  }

  async resume(): Promise<boolean> {
    return this.slot.resume();
  }

  async cancel(reason = 'cancelled'): Promise<boolean> {
    return this.slot.cancel(reason);
  }

  async fail(reason: string): Promise<boolean> {
    return this.slot.fail(reason);
  }

  async shutdown(): Promise<void> {
    await this.slot.shutdown();
  }

  status(): MinecraftGoalPublicState {
    const status = this.slot.status();
    return {
      phase: status.phase,
      generation: status.generation,
      ...(status.goal ? {
        title: status.goal.title,
        instruction: status.goal.instruction,
      } : {}),
      ...(status.checkpoint ? { checkpoint: status.checkpoint } : {}),
    };
  }

  private async startExecution(input: {
    slotKey: string;
    generation: number;
    goal: MinecraftGoal;
    checkpoint?: MinecraftGoalCheckpoint;
  }): Promise<TaskSlotRun<MinecraftGoalResult>> {
    const before = await this.options.runtime.command<MinecraftEnvironmentSnapshot>('snapshot', {});
    if (!before.connection.connected) {
      throw new Error('Minecraft is not connected. Connect Hiyori to the world before setting a gameplay goal.');
    }
    this.baselineInventory = { ...(before.body?.inventory ?? {}) };
    const task = this.options.taskManager.createAndStart({
      title: input.goal.title,
      prompt: input.goal.instruction,
      conversationId: input.goal.conversationId,
      type: 'background',
      context: input.checkpoint ? {
        additionalContext: formatCheckpointContext(input.goal, input.checkpoint),
      } : undefined,
      metadata: {
        slotKey: input.slotKey,
        slotGeneration: input.generation,
        toolsets: ['minecraft'],
        replyTarget: input.goal.replyTarget,
      },
    });
    const settled = this.options.taskManager.waitForTerminal(task.id).then(taskToResult);
    return {
      executionId: task.id,
      settled,
      cancel: async (reason) => {
        await this.options.taskManager.cancelTask(task.id, reason);
        return settled;
      },
      fail: async (reason) => {
        await this.options.taskManager.failTask(task.id, reason);
        return settled;
      },
    };
  }

  private async captureCheckpoint(
    reason: MinecraftGoalCheckpoint['endReason'],
  ): Promise<MinecraftGoalCheckpoint | undefined> {
    if (this.options.runtime.hasActiveWorker?.() === false) return undefined;
    let snapshot: MinecraftEnvironmentSnapshot;
    try {
      snapshot = await this.options.runtime.command<MinecraftEnvironmentSnapshot>('snapshot', {});
    } catch {
      return undefined;
    }
    const inventory = { ...(snapshot.body?.inventory ?? {}) };
    return {
      capturedAt: snapshot.capturedAt,
      endReason: reason,
      position: snapshot.body?.position,
      health: snapshot.body?.health,
      food: snapshot.body?.food,
      inventory,
      inventoryDelta: inventoryDelta(this.baselineInventory, inventory),
      lastAction: snapshot.action,
    };
  }

  private publishTerminal(
    event: TaskSlotTerminal<MinecraftGoal, MinecraftGoalCheckpoint, MinecraftGoalResult>,
  ): void {
    if (event.result.outcome === 'cancelled') return;
    const notice: MinecraftGoalTerminalNotice = {
      generation: event.generation,
      goal: event.goal,
      outcome: event.result.outcome,
      report: event.result.report,
      checkpoint: event.checkpoint,
    };
    this.options.onTrace?.({
      type: 'minecraft-slot-terminal',
      generation: event.generation,
      outcome: event.result.outcome,
      executionId: event.result.task?.id,
      title: event.goal.title,
    });
    this.options.onTerminal?.(notice);
  }
}

function taskToResult(task: DBTask | null): MinecraftGoalResult {
  if (!task) return { outcome: 'failed', report: 'Minecraft goal execution record is unavailable.', task };
  if (task.status === 'completed') {
    return { outcome: 'completed', report: task.result?.trim() || 'Minecraft goal completed.', task };
  }
  if (task.status === 'cancelled') {
    return { outcome: 'cancelled', report: task.progress_text?.trim() || 'Minecraft goal cancelled.', task };
  }
  return { outcome: 'failed', report: task.error?.trim() || 'Minecraft goal failed.', task };
}

function inventoryDelta(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const delta = (after[key] ?? 0) - (before[key] ?? 0);
    if (delta !== 0) result[key] = delta;
  }
  return result;
}

function formatCheckpointContext(goal: MinecraftGoal, checkpoint: MinecraftGoalCheckpoint): string {
  return [
    'Verified Minecraft handoff:',
    JSON.stringify({
      goal: { title: goal.title, instruction: goal.instruction },
      checkpoint,
    }),
    'Treat this as observed state, then inspect the current world before choosing the next action.',
  ].join('\n');
}
