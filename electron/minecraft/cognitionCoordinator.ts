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

export interface MinecraftGoalDebugEvent {
  goalId: string;
  title: string;
  line?: string;
  status?: 'running' | 'idle' | 'done' | 'error';
}

export class MinecraftCognitionCoordinator {
  private readonly maxPlannerTurns: number;
  private readonly activeGoals = new Set<string>();

  constructor(private readonly options: {
    planner: MinecraftPlannerModel;
    runtime: MinecraftRuntimeManager | MinecraftGoalRuntime;
    notify: (origin: MinecraftGoalOrigin, message: string) => Promise<void>;
    debug?: (event: MinecraftGoalDebugEvent) => void;
    maxPlannerTurns?: number;
  }) {
    this.maxPlannerTurns = options.maxPlannerTurns ?? 6;
  }

  async startGoal(request: MinecraftGoalRequest): Promise<void> {
    this.activeGoals.add(request.id);
    this.debug(request, { status: 'running', line: `目标：${request.instruction}` });
    await this.options.runtime.startGoal({
      id: request.id,
      title: request.title,
      origin: request.origin,
    });

    const recentResults: MinecraftActionResult[] = [];
    for (let turn = 0; turn < this.maxPlannerTurns && this.activeGoals.has(request.id); turn++) {
      const snapshot = await this.options.runtime.command<MinecraftEnvironmentSnapshot>('snapshot', {});
      this.debug(request, { line: `快照：${summarizeSnapshot(snapshot)}` });
      const decision = await this.options.planner.decide({
        userInstruction: request.instruction,
        snapshot,
        recentResults,
      });

      if (decision.kind === 'act') {
        this.debug(request, {
          status: 'running',
          line: `动作：${decision.action.name} ${JSON.stringify(decision.action.args)}`,
        });
        const result = await this.options.runtime.command<MinecraftActionResult>(
          'execute-action',
          decision.action,
        );
        recentResults.push(result);
        this.debug(request, {
          status: result.outcome === 'failed' ? 'error' : 'running',
          line: `结果：${result.summary}${result.error ? ` (${result.error.code})` : ''}`,
        });
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
        this.debug(request, { status: 'done', line: `完成：${decision.result}` });
        await this.options.notify(request.origin, decision.result);
        this.activeGoals.delete(request.id);
        return;
      }

      if (decision.kind === 'ask-user') {
        this.options.runtime.recordSignificantEvent(request.id, {
          kind: 'waiting',
          text: decision.question,
        });
        this.debug(request, { status: 'idle', line: `需要用户决定：${decision.question}` });
        await this.options.notify(request.origin, decision.question);
        this.activeGoals.delete(request.id);
        return;
      }

      if (decision.kind === 'wait') {
        this.options.runtime.recordSignificantEvent(request.id, {
          kind: 'waiting',
          text: `${decision.condition.kind}: ${decision.condition.value}`,
        });
        this.debug(request, {
          status: 'idle',
          line: `等待：${decision.condition.kind} ${decision.condition.value}`,
        });
        this.activeGoals.delete(request.id);
        return;
      }

      this.options.runtime.recordSignificantEvent(request.id, {
        kind: 'plan',
        text: decision.plan.map((step) => `${step.title}: ${step.expected}`).join('; '),
      });
      this.debug(request, {
        line: `计划：${decision.plan.map((step) => `${step.title} -> ${step.expected}`).join('；')}`,
      });
    }

    if (this.activeGoals.has(request.id)) {
      const message = 'Minecraft 目标还没有完成，我需要先停下来确认下一步。';
      this.options.runtime.recordSignificantEvent(request.id, { kind: 'waiting', text: message });
      this.debug(request, { status: 'idle', line: message });
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

  private debug(request: MinecraftGoalRequest, event: Omit<MinecraftGoalDebugEvent, 'goalId' | 'title'>): void {
    this.options.debug?.({
      goalId: request.id,
      title: request.title,
      ...event,
    });
  }
}

function summarizeSnapshot(snapshot: MinecraftEnvironmentSnapshot): string {
  if (!snapshot.connection.connected) return '未连接';
  const owner = snapshot.owner?.visible
    ? `主人 ${snapshot.owner.name} 距离 ${formatNumber(snapshot.owner.distance)}`
    : snapshot.owner?.name
      ? `看不到主人 ${snapshot.owner.name}`
      : '未绑定主人';
  const blocks = snapshot.nearby.blocks
    .slice(0, 6)
    .map((block) => `${block.name}@${formatNumber(block.distance)}`)
    .join(', ') || '没有识别到可见方块';
  return `${owner}；方块：${blocks}`;
}

function formatNumber(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : 'unknown';
}
