import { getReplyTargetForConversation } from '../../bridges/asyncDelivery';
import { getMinecraftGoalController } from '../../minecraft/goalContext';
import type { MinecraftGoalPublicState } from '../../minecraft/goalController';
import type { ToolDefinition } from '../types';

interface MinecraftGoalParams {
  action: 'set' | 'pause' | 'resume' | 'cancel' | 'status';
  title?: string;
  instruction?: string;
}

const minecraftGoalTool: ToolDefinition<MinecraftGoalParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'minecraft_goal',
      description:
        'Manage Hiyori\'s one current Minecraft gameplay goal. Use set for a goal that needs multiple verified game actions; set also replaces the current goal atomically. A successful set continues the gameplay goal on its own and reports its terminal result separately, so reply to the player and end the current turn. Use pause/resume/cancel/status for that goal. This tool does not need an ID.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['set', 'pause', 'resume', 'cancel', 'status'],
            description: 'set creates or replaces the current gameplay goal; pause/resume/cancel/status address the current goal.',
          },
          title: { type: 'string', description: 'Short gameplay goal name; required for set.' },
          instruction: {
            type: 'string',
            description: 'Self-contained factual gameplay objective, including quantities and success criteria; required for set.',
          },
        },
        required: ['action'],
      },
    },
  },

  execution: {
    resources: () => [{ key: 'minecraft:control', access: 'exclusive' }],
  },

  async execute(params, context) {
    const controller = getMinecraftGoalController();
    if (params.action === 'set') {
      const title = required(params.title, 'title');
      const instruction = required(params.instruction, 'instruction');
      const conversationId = context?.conversationId || 'default';
      const state = await controller.set({
        title,
        instruction,
        conversationId,
        replyTarget: getReplyTargetForConversation(conversationId),
      });
      return formatStartedState(state);
    }
    if (params.action === 'pause') {
      const changed = await controller.pause();
      return changed ? formatState(controller.status()) : 'Minecraft goal state: no running goal to pause.';
    }
    if (params.action === 'resume') {
      const changed = await controller.resume();
      return changed ? formatState(controller.status()) : 'Minecraft goal state: no paused goal to resume.';
    }
    if (params.action === 'cancel') {
      const changed = await controller.cancel('user_cancelled');
      return changed ? 'Minecraft goal state: idle.' : 'Minecraft goal state: no current goal.';
    }
    return formatState(controller.status());
  },
};

function formatStartedState(state: MinecraftGoalPublicState): string {
  return [
    '【工具结果】',
    `状态：${state.phase}`,
    '下一步：回复用户',
    '目标已经开始持续推进，完成、失败或需要玩家介入时会另行返回结果。',
    '请用 Hiyori 的第一人称自然确认，并结束本轮；不要向玩家解释内部执行方式。',
    state.title ? `Goal: ${state.title}.` : undefined,
    state.instruction ? `Objective: ${state.instruction}` : undefined,
  ].filter(Boolean).join('\n');
}

function formatState(state: MinecraftGoalPublicState): string {
  return [
    `Minecraft goal state: ${state.phase}.`,
    state.title ? `Goal: ${state.title}.` : undefined,
    state.instruction ? `Objective: ${state.instruction}` : undefined,
  ].filter(Boolean).join('\n');
}

function required(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`Missing Minecraft goal parameter: ${name}`);
  return text;
}

export default minecraftGoalTool;
