import type {
  MinecraftActionResult,
  MinecraftEnvironmentSnapshot,
} from './contracts';
import type { MinecraftPlannerModel } from './plannerModel';
import type {
  MinecraftGoalOrigin,
  MinecraftGoalState,
  MinecraftRuntimeManager,
} from './runtimeManager';

export interface MinecraftGoalRequest {
  id: string;
  title: string;
  instruction: string;
  origin: MinecraftGoalOrigin;
}

export interface MinecraftGoalRuntime {
  startGoal(input: { id: string; title: string; origin: MinecraftGoalOrigin }): Promise<MinecraftGoalState>;
  command<T = unknown>(action: string, payload: unknown): Promise<T>;
  recordSignificantEvent(goalId: string, event: { kind: string; text: string }): void;
}

export class MinecraftCognitionCoordinator {
  private readonly maxPlannerTurns: number;
  private readonly activeGoals = new Set<string>();

  constructor(private readonly options: {
    planner: MinecraftPlannerModel;
    runtime: MinecraftRuntimeManager | MinecraftGoalRuntime;
    notify: (origin: MinecraftGoalOrigin, message: string) => Promise<void>;
    maxPlannerTurns?: number;
  }) {
    this.maxPlannerTurns = options.maxPlannerTurns ?? 6;
  }

  async startGoal(request: MinecraftGoalRequest): Promise<void> {
    this.activeGoals.add(request.id);
    await this.options.runtime.startGoal({
      id: request.id,
      title: request.title,
      origin: request.origin,
    });

    const recentResults: MinecraftActionResult[] = [];
    for (let turn = 0; turn < this.maxPlannerTurns && this.activeGoals.has(request.id); turn++) {
      const snapshot = await this.options.runtime.command<MinecraftEnvironmentSnapshot>('snapshot', {});
      const decision = await this.options.planner.decide({
        userInstruction: request.instruction,
        snapshot,
        recentResults,
      });

      if (decision.kind === 'act') {
        const result = await this.options.runtime.command<MinecraftActionResult>(
          'execute-action',
          decision.action,
        );
        recentResults.push(result);
        this.options.runtime.recordSignificantEvent(request.id, {
          kind: result.outcome,
          text: result.summary,
        });
        continue;
      }

      if (decision.kind === 'complete') {
        this.options.runtime.recordSignificantEvent(request.id, {
          kind: 'completed',
          text: decision.result,
        });
        await this.options.notify(request.origin, decision.result);
        this.activeGoals.delete(request.id);
        return;
      }

      if (decision.kind === 'ask-user') {
        this.options.runtime.recordSignificantEvent(request.id, {
          kind: 'waiting',
          text: decision.question,
        });
        await this.options.notify(request.origin, decision.question);
        this.activeGoals.delete(request.id);
        return;
      }

      if (decision.kind === 'wait') {
        this.options.runtime.recordSignificantEvent(request.id, {
          kind: 'waiting',
          text: `${decision.condition.kind}: ${decision.condition.value}`,
        });
        this.activeGoals.delete(request.id);
        return;
      }

      this.options.runtime.recordSignificantEvent(request.id, {
        kind: 'plan',
        text: decision.plan.map((step) => `${step.title}: ${step.expected}`).join('; '),
      });
    }

    if (this.activeGoals.has(request.id)) {
      const message = 'Minecraft 目标还没有完成，我需要先停下来确认下一步。';
      this.options.runtime.recordSignificantEvent(request.id, { kind: 'waiting', text: message });
      await this.options.notify(request.origin, message);
      this.activeGoals.delete(request.id);
    }
  }

  async stopGoal(goalId: string): Promise<boolean> {
    if (!this.activeGoals.delete(goalId)) return false;
    return this.options.runtime.command<boolean>('cancel-action', { actionId: goalId });
  }

  async handleRuntimeEvent(goalId: string): Promise<void> {
    if (!this.activeGoals.has(goalId)) return;
    this.options.runtime.recordSignificantEvent(goalId, {
      kind: 'runtime-event',
      text: 'Minecraft runtime event received.',
    });
  }
}
