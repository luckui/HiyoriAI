/**
 * Skill: manage_live2d
 *
 * 让 AI Agent 主动控制 Live2D 模型：表情、动作、参数、状态查询。
 *
 * 说话时的表情不需要调用这个工具：表情导演会按句自动选（electron/expressionDirector.ts）。
 * 这里用于不说话时的主动表现，比如听到好消息时先露出一个表情。
 */

import type { ToolDefinition, ToolExecuteResult } from '../types';
import { sendLive2DCommand } from '../../live2dBridge';
import { EXPRESSIONS, EXPRESSION_GUIDE, isExpression } from '../../../shared/expressions';

interface ManageLive2DParams {
  action: 'set_emotion' | 'play_motion' | 'set_param' | 'query';
  /** set_emotion：情绪名 */
  emotion?: string;
  /** set_emotion：强度 0–1 */
  intensity?: number;
  /** set_emotion：持续时间 ms（0=保持到下次切换） */
  duration_ms?: number;
  /** play_motion：动作组名 */
  motion_group?: string;
  /** play_motion：组内序号（省略=随机） */
  motion_no?: number;
  /** play_motion：优先级 0-3 */
  priority?: number;
  /** set_param：参数 ID */
  parameter_id?: string;
  /** set_param：参数值 */
  value?: number;
  /** set_param：过渡时间 ms */
  transition_ms?: number;
}

const manageLive2dTool: ToolDefinition<ManageLive2DParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'manage_live2d',
      description:
        '控制桌面 Live2D 角色的表情和动作。说话时的表情会按句自动选，不需要调用；\n' +
        '这里用于不说话时的主动表现。\n\n' +
        '可用表情（emotion）：\n' +
        EXPRESSIONS.map(e => `  ${e}：${EXPRESSION_GUIDE[e]}`).join('\n') + '\n\n' +
        '可用动作组（motion_group，Hiyori_pro 模型）：\n' +
        '  Idle / Tap / TapBody / Flick / FlickUp / FlickDown / Flick@Body',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['set_emotion', 'play_motion', 'set_param', 'query'],
            description: '操作类型：set_emotion=设置情绪, play_motion=播放动作, set_param=直接设参数, query=查询状态',
          },
          emotion: {
            type: 'string',
            enum: [...EXPRESSIONS],
            description: '（set_emotion 必填）表情',
          },
          intensity: {
            type: 'number',
            description: '（set_emotion）强度 0–1，默认 0.7',
          },
          duration_ms: {
            type: 'number',
            description: '（set_emotion）持续时间（ms），省略 = 4000，0 = 保持到下次切换',
          },
          motion_group: {
            type: 'string',
            description: '（play_motion 必填）动作组名，如 "Tap"、"Flick"',
          },
          motion_no: {
            type: 'number',
            description: '（play_motion）组内序号，省略则随机',
          },
          priority: {
            type: 'number',
            description: '（play_motion）优先级：0=无/1=idle/2=normal/3=force，默认 2',
          },
          parameter_id: {
            type: 'string',
            description: '（set_param 必填）Live2D 参数 ID，如 "ParamMouthForm"',
          },
          value: {
            type: 'number',
            description: '（set_param 必填）目标参数值',
          },
          transition_ms: {
            type: 'number',
            description: '（set_param）过渡时间 ms，0=立即，默认 200',
          },
        },
        required: ['action'],
      },
    },
  },

  async execute(params): Promise<ToolExecuteResult> {
    const { action } = params;

    switch (action) {
      case 'query': {
        const ok = sendLive2DCommand({ type: 'query' });
        return ok ? '已发送查询命令到 Live2D' : 'Live2D 渲染层未就绪';
      }

      case 'set_emotion': {
        const emotion = params.emotion ?? 'neutral';
        if (!isExpression(emotion)) {
          return `错误：未知表情 "${emotion}"，可用值：${EXPRESSIONS.join(' / ')}`;
        }
        const ok = sendLive2DCommand({
          type: 'emotion',
          emotion,
          intensity: params.intensity ?? 0.7,
          durationMs: params.duration_ms ?? 4000,
        });
        return ok ? `已设置表情：${emotion}` : 'Live2D 渲染层未就绪，命令未送达';
      }

      case 'play_motion': {
        if (!params.motion_group) {
          return '错误：play_motion 需要 motion_group 参数';
        }
        const ok = sendLive2DCommand({
          type: 'motion',
          group: params.motion_group,
          no: params.motion_no,
          priority: params.priority ?? 2,
        });
        if (!ok) return 'Live2D 渲染层未就绪，命令未送达';
        return `已触发动作：${params.motion_group}[${params.motion_no ?? '随机'}]`;
      }

      case 'set_param': {
        if (!params.parameter_id) {
          return '错误：set_param 需要 parameter_id 参数';
        }
        if (params.value === undefined) {
          return '错误：set_param 需要 value 参数';
        }
        const ok = sendLive2DCommand({
          type: 'param',
          parameterId: params.parameter_id,
          value: params.value,
          transitionMs: params.transition_ms ?? 200,
        });
        if (!ok) return 'Live2D 渲染层未就绪，命令未送达';
        return `已设置参数 ${params.parameter_id} = ${params.value}`;
      }

      default:
        return `错误：未知操作：${action}`;
    }
  },
};

export default manageLive2dTool;
