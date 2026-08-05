import { describe, expect, it, vi } from 'vitest';
import type {
  MinecraftActionInstruction,
  MinecraftActionResult,
  MinecraftEnvironmentSnapshot,
  MinecraftPlannerDecision,
} from '../contracts';
import { MinecraftCognitionCoordinator } from '../cognitionCoordinator';
import type { MinecraftGoalOrigin } from '../runtimeManager';

function snapshot(): MinecraftEnvironmentSnapshot {
  return {
    capturedAt: 1,
    stale: false,
    connection: { connected: true },
    follow: { phase: 'inactive' },
    nearby: { blocks: [], entities: [] },
    recentEvents: [],
  };
}

function actionResult(overrides: Partial<MinecraftActionResult> = {}): MinecraftActionResult {
  return {
    actionId: 'act-1',
    outcome: 'succeeded',
    summary: 'collected sugar cane',
    durationMs: 10,
    inventoryDelta: { sugar_cane: 3 },
    worldChanges: [{ kind: 'block_broken', name: 'sugar_cane', count: 3 }],
    observations: [],
    ...overrides,
  };
}

function fakePlanner(decisions: MinecraftPlannerDecision[]) {
  return {
    decide: vi.fn(async () => {
      const decision = decisions.shift();
      if (!decision) throw new Error('planner called too many times');
      return decision;
    }),
  };
}

function fakeRuntime(result: MinecraftActionResult = actionResult()) {
  return {
    startGoal: vi.fn(async (input: { id: string; title: string; origin: MinecraftGoalOrigin }) => ({
      ...input,
      status: 'running' as const,
    })),
    getGoal: vi.fn(),
    recordSignificantEvent: vi.fn(),
    command: vi.fn(async (action: string, payload: unknown) => {
      if (action === 'snapshot') return snapshot();
      if (action === 'execute-action') return result;
      if (action === 'cancel-action') return true;
      throw new Error(`unexpected command ${action}`);
    }),
  };
}

describe('MinecraftCognitionCoordinator', () => {
  it('executes act decisions and completes after verified result', async () => {
    const runtime = fakeRuntime();
    const planner = fakePlanner([
      {
        kind: 'act',
        rationale: 'nearby',
        action: { id: 'act-1', name: 'collect_block', args: { block: 'sugar_cane' } },
      },
      { kind: 'complete', result: '甘蔗已经采好了，拿到了 3 个。' },
    ]);
    const notify = vi.fn(async () => undefined);

    const coordinator = new MinecraftCognitionCoordinator({
      planner,
      runtime,
      notify,
      maxPlannerTurns: 4,
    });
    await coordinator.startGoal({
      id: 'goal-1',
      title: 'collect cane',
      instruction: '帮我采附近甘蔗',
      origin: { source: 'minecraft', conversationId: 'conv-1' },
    });

    expect(runtime.command).toHaveBeenCalledWith('execute-action', {
      id: 'act-1',
      name: 'collect_block',
      args: { block: 'sugar_cane' },
    } satisfies MinecraftActionInstruction);
    expect(notify).toHaveBeenCalledWith(
      { source: 'minecraft', conversationId: 'conv-1' },
      '甘蔗已经采好了，拿到了 3 个。',
    );
  });

  it('stops after repeated recoverable failures and asks the user', async () => {
    const runtime = fakeRuntime(
      actionResult({
        outcome: 'failed',
        inventoryDelta: {},
        worldChanges: [],
        error: { code: 'path_unreachable', recoverable: true, details: {} },
      }),
    );
    const planner = fakePlanner([
      {
        kind: 'act',
        rationale: 'try path',
        action: { id: 'act-1', name: 'collect_block', args: { block: 'sugar_cane' } },
      },
      {
        kind: 'act',
        rationale: 'try path again',
        action: { id: 'act-2', name: 'collect_block', args: { block: 'sugar_cane' } },
      },
      { kind: 'ask-user', question: '我走不过去，能带我靠近一点吗？', reason: 'path-unreachable' },
    ]);
    const notify = vi.fn(async () => undefined);

    const coordinator = new MinecraftCognitionCoordinator({
      planner,
      runtime,
      notify,
      maxPlannerTurns: 4,
    });
    await coordinator.startGoal({
      id: 'goal-1',
      title: 'collect cane',
      instruction: '采甘蔗',
      origin: { source: 'desktop' },
    });

    expect(notify).toHaveBeenCalledWith(
      { source: 'desktop' },
      '我走不过去，能带我靠近一点吗？',
    );
  });

  it('emits goal progress debug lines for the terminal block', async () => {
    const runtime = fakeRuntime();
    const planner = fakePlanner([
      {
        kind: 'act',
        rationale: 'nearby tree',
        action: { id: 'act-1', name: 'collect_block', args: { block: 'oak_log' } },
      },
      { kind: 'complete', result: '砍到木头了。' },
    ]);
    const debug = vi.fn();
    const coordinator = new MinecraftCognitionCoordinator({
      planner,
      runtime,
      notify: vi.fn(async () => undefined),
      debug,
      maxPlannerTurns: 3,
    });

    await coordinator.startGoal({
      id: 'goal-1',
      title: 'Minecraft 目标',
      instruction: '帮我砍树',
      origin: { source: 'desktop', conversationId: 'conv-1' },
    });

    expect(debug).toHaveBeenCalledWith(expect.objectContaining({
      goalId: 'goal-1',
      status: 'running',
      line: expect.stringContaining('目标：帮我砍树'),
    }));
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({
      goalId: 'goal-1',
      line: expect.stringContaining('动作：collect_block'),
    }));
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({
      goalId: 'goal-1',
      line: expect.stringContaining('结果：collected sugar cane'),
    }));
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({
      goalId: 'goal-1',
      status: 'done',
      line: expect.stringContaining('完成：砍到木头了。'),
    }));
  });
});
