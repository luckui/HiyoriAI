/**
 * schedule_task — 调度管理工具
 *
 * 让 AI 能够创建/管理定时提醒和定时后台任务。
 *
 * 场景示例：
 *   - 用户："每天早上9点检查B站关注列表有没有新视频"
 *     AI 调用 schedule_task create → 定时调度 → 到期自动执行
 *   - 用户："30分钟后提醒我开会"
 *     AI 调用 schedule_task create → 一次性调度 → 到期通知
 */

import type { ToolDefinition } from '../types';
import { taskScheduler } from '../../taskScheduler';
import type { DBSchedule } from '../../db';
import { getReplyTargetForConversation } from '../../bridges/asyncDelivery';

interface ScheduleTaskParams {
  action: 'create' | 'list' | 'pause' | 'resume' | 'remove' | 'trigger';
  kind?: 'reminder' | 'agent_task';
  title?: string;
  message?: string;
  instruction?: string;
  prompt?: string;
  schedule?: string;
  repeat_limit?: number;
  toolsets?: string[];
  schedule_id?: string;
}

function formatSchedule(s: DBSchedule): string {
  let kind = 'agent_task';
  try {
    const meta = s.metadata ? JSON.parse(s.metadata) : {};
    if (meta?.kind === 'reminder') kind = 'reminder';
    else if (meta?.kind === 'agent_task') kind = 'agent_task';
    else if (!meta?.kind) kind = 'legacy agent_task';
  } catch {
    kind = 'legacy agent_task';
  }
  const enabledText = s.enabled ? '✅ 启用' : '⏸️ 暂停';
  const typeMap: Record<string, string> = {
    once: '⏰ 一次性',
    interval: '🔁 循环',
    cron: '📅 Cron',
  };
  const typeText = typeMap[s.schedule_type] ?? s.schedule_type;

  let scheduleDesc = '';
  if (s.schedule_type === 'once' && s.run_at) {
    scheduleDesc = `执行于 ${new Date(s.run_at).toLocaleString('zh-CN')}`;
  } else if (s.schedule_type === 'interval' && s.interval_ms) {
    const minutes = Math.round(s.interval_ms / 60_000);
    scheduleDesc = minutes >= 60
      ? `每 ${Math.round(minutes / 60)} 小时`
      : `每 ${minutes} 分钟`;
  } else if (s.schedule_type === 'cron' && s.cron_expr) {
    scheduleDesc = `cron: ${s.cron_expr}`;
  }

  const nextRun = s.next_run_at ? `\n   下次执行: ${new Date(s.next_run_at).toLocaleString('zh-CN')}` : '';
  const lastRun = s.last_run_at ? `\n   上次执行: ${new Date(s.last_run_at).toLocaleString('zh-CN')}` : '';
  const repeatInfo = s.repeat_limit !== null ? `\n   已执行: ${s.repeat_count}/${s.repeat_limit} 次` : `\n   已执行: ${s.repeat_count} 次`;

  return `📋 ${s.task_title}\n   ID: ${s.id}\n   语义: ${kind}\n   状态: ${enabledText} | ${typeText}\n   调度: ${scheduleDesc}${nextRun}${lastRun}${repeatInfo}`;
}

const scheduleTaskTool: ToolDefinition<ScheduleTaskParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'schedule_task',
      description:
        '创建/管理调度：定时提醒或定时后台任务。\n' +
        '支持：一次性延迟（30m/2h）、循环间隔（every 30m）、指定时间。\n' +
        '提醒、问候、陪聊、关心用户 → kind="reminder"；到点检查、运行、收集、总结或操作电脑 → kind="agent_task"。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: '操作类型：create=创建 | list=列出所有 | pause=暂停 | resume=恢复 | remove=删除 | trigger=立即触发一次',
            enum: ['create', 'list', 'pause', 'resume', 'remove', 'trigger'],
          },
          kind: {
            type: 'string',
            description:
              '【create 必填】调度类型。reminder=到点唤醒 Hiyori，由 Hiyori 按 instruction 自然提醒用户；agent_task=到点启动后台子智能体执行 prompt。',
            enum: ['reminder', 'agent_task'],
          },
          title: {
            type: 'string',
            description: '【create 必填】任务标题',
          },
          instruction: {
            type: 'string',
            description:
              '【kind=reminder 必填】给 Hiyori 看的提醒指令，不是直接发给用户的固定文案。例如“请提醒用户喝水。”、“请主动和用户轻松聊一句。”',
          },
          prompt: {
            type: 'string',
            description:
              '【kind=agent_task 必填】到点交给后台子智能体执行的完整指令。只用于检查、运行、收集、总结或操作电脑等真实任务；提醒不要使用 prompt。',
          },
          schedule: {
            type: 'string',
            description: '【create 必填】调度表达式。格式：23:20（今天或明天该时刻）| 30m/2h/1d（一次性延迟）| every 30m/every 2h（循环）| cron:20 23 * * *（cron 5字段：分 时 日 月 周）| 2025-07-10T09:00（指定日期时间）',
          },
          repeat_limit: {
            type: 'integer',
            description: '【create 可选】循环任务的最大执行次数（默认无限）。一次性任务自动为 1',
          },
          toolsets: {
            type: 'array',
            description: '【kind=agent_task 可选】子智能体可用的工具集（默认 ["agent"]）。kind=reminder 不使用工具集。',
            items: { type: 'string' },
          },
          schedule_id: {
            type: 'string',
            description: '【pause/resume/remove/trigger 必填】调度 ID',
          },
        },
        required: ['action'],
      },
    },
  },

  execute(params, context) {
    const { action } = params;

    switch (action) {
      case 'create': {
        if (!params.title?.trim()) return '❌ 缺少 title 参数';
        if (!params.kind) return '❌ 缺少 kind 参数：提醒用户请选择 kind="reminder"，定时执行任务请选择 kind="agent_task"';
        if (params.kind === 'reminder') {
          if (!params.instruction?.trim()) return '❌ 缺少 instruction 参数：kind="reminder" 时 instruction 是给 Hiyori 看的提醒指令，例如“请提醒用户喝水”';
          if (params.message?.trim()) return '❌ kind="reminder" 不使用 message；请把提醒意图写到 instruction，而不是预写最终文案';
          if (params.prompt?.trim()) return '❌ kind="reminder" 不使用 prompt；需要真实执行任务时才使用 kind="agent_task"';
          if (params.toolsets && params.toolsets.length > 0) return '❌ kind="reminder" 不使用 toolsets；提醒只会唤醒 Hiyori 对用户说话';
        } else if (!params.prompt?.trim()) {
          return '❌ 缺少 prompt 参数：kind="agent_task" 时 prompt 是后台子智能体执行指令';
        } else if (params.message?.trim()) {
          return '❌ kind="agent_task" 不使用 message；请把后台执行指令放到 prompt';
        } else if (params.instruction?.trim()) {
          return '❌ kind="agent_task" 不使用 instruction；请把后台执行指令放到 prompt';
        }
        if (!params.schedule?.trim()) return '❌ 缺少 schedule 参数';

        try {
          // 将来源对话 ID 存入 metadata，供调度器触发时注入聊天通知
          const schedMeta: Record<string, unknown> = {};
          schedMeta.kind = params.kind;
          if (params.kind === 'agent_task' && params.toolsets) schedMeta.toolsets = params.toolsets;
          if (context?.conversationId) schedMeta.conversationId = context.conversationId;
          const replyTarget = context?.conversationId
            ? getReplyTargetForConversation(context.conversationId)
            : undefined;
          if (replyTarget) schedMeta.replyTarget = replyTarget;

          const sched = taskScheduler.createSchedule({
            title: params.title.trim(),
            prompt: params.kind === 'reminder' ? params.instruction!.trim() : params.prompt!.trim(),
            schedule: params.schedule.trim(),
            repeatLimit: params.repeat_limit,
            metadata: Object.keys(schedMeta).length > 0 ? schedMeta : undefined,
          });

          const nextRun = sched.next_run_at
            ? new Date(sched.next_run_at).toLocaleString('zh-CN')
            : '待计算';

          const kindText = params.kind === 'reminder' ? '提醒' : '后台任务';
          return `✅ 定时${kindText}已创建\n\n` +
            `📋 ${sched.task_title}\n` +
            `🆔 ${sched.id}\n` +
            `⏰ 下次执行: ${nextRun}\n` +
            `📅 类型: ${sched.schedule_type === 'once' ? '一次性' : sched.schedule_type === 'interval' ? '循环' : 'Cron'}\n` +
            `🔖 调度语义: ${params.kind}`;
        } catch (err) {
          return `❌ 创建失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case 'list': {
        const schedules = taskScheduler.listSchedules(false);
        if (schedules.length === 0) return '📭 当前没有定时任务';
        return `共 ${schedules.length} 个定时任务：\n\n` + schedules.map(formatSchedule).join('\n\n');
      }

      case 'pause': {
        if (!params.schedule_id) return '❌ 缺少 schedule_id 参数';
        return taskScheduler.pauseSchedule(params.schedule_id)
          ? `✅ 已暂停调度: ${params.schedule_id}`
          : `❌ 未找到调度: ${params.schedule_id}`;
      }

      case 'resume': {
        if (!params.schedule_id) return '❌ 缺少 schedule_id 参数';
        return taskScheduler.resumeSchedule(params.schedule_id)
          ? `✅ 已恢复调度: ${params.schedule_id}`
          : `❌ 未找到调度: ${params.schedule_id}`;
      }

      case 'remove': {
        if (!params.schedule_id) return '❌ 缺少 schedule_id 参数';
        return taskScheduler.removeSchedule(params.schedule_id)
          ? `✅ 已删除调度: ${params.schedule_id}`
          : `❌ 未找到调度: ${params.schedule_id}`;
      }

      case 'trigger': {
        if (!params.schedule_id) return '❌ 缺少 schedule_id 参数';
        return taskScheduler.triggerNow(params.schedule_id)
          ? `✅ 已触发立即执行: ${params.schedule_id}`
          : `❌ 未找到调度: ${params.schedule_id}`;
      }

      default:
        return `❌ 未知操作: ${action}`;
    }
  },
};

export default scheduleTaskTool;
