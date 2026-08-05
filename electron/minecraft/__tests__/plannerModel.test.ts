import { describe, expect, it } from 'vitest';
import type { MinecraftEnvironmentSnapshot } from '../contracts';
import { createMinecraftPlannerModel } from '../plannerModel';

function disconnectedSnapshot(): MinecraftEnvironmentSnapshot {
  return {
    capturedAt: 1,
    stale: true,
    connection: { connected: false },
    follow: { phase: 'inactive' },
    nearby: { blocks: [], entities: [] },
    recentEvents: [],
  };
}

describe('createMinecraftPlannerModel', () => {
  it('parses a typed action decision from the LLM response', async () => {
    const model = createMinecraftPlannerModel({
      complete: async () =>
        JSON.stringify({
          kind: 'act',
          rationale: 'visible sugar cane is nearby',
          action: {
            id: 'act-1',
            name: 'collect_block',
            args: { block: 'sugar_cane', scope: 'nearby' },
          },
        }),
    });

    const decision = await model.decide({
      userInstruction: 'collect the sugar cane nearby',
      snapshot: disconnectedSnapshot(),
      recentResults: [],
    });

    expect(decision.kind).toBe('act');
    expect(decision.kind === 'act' && decision.action.name).toBe('collect_block');
  });

  it('turns malformed model output into an ask-user decision', async () => {
    const model = createMinecraftPlannerModel({ complete: async () => 'not json' });

    const decision = await model.decide({
      userInstruction: 'do something',
      snapshot: disconnectedSnapshot(),
      recentResults: [],
    });

    expect(decision).toEqual({
      kind: 'ask-user',
      question: '我需要确认一下 Minecraft 里的下一步要做什么。',
      reason: 'planner-output-invalid',
    });
  });

  it('rejects unknown action names instead of passing them to the runtime', async () => {
    const model = createMinecraftPlannerModel({
      complete: async () =>
        JSON.stringify({
          kind: 'act',
          rationale: 'invented action',
          action: { id: 'act-2', name: 'teleport_to_diamond', args: {} },
        }),
    });

    const decision = await model.decide({
      userInstruction: 'find diamonds',
      snapshot: disconnectedSnapshot(),
      recentResults: [],
    });

    expect(decision.kind).toBe('ask-user');
  });
});
