/**
 * async_task — 异步后台任务工具
 *
 * 让 AI 能够创建/查询/取消后台异步任务。
 * 创建的任务会在后台由子智能体执行，不阻塞当前对话。
 *
 * 场景示例：
 *   - 用户："去读这100份简历，告诉我专业和年龄分布"
 *     AI 调用 async_task batch → 后台并行处理 → 完成后通知用户
 *   - 用户："简历分析完了吗？"
 *     AI 调用 async_task status → 返回进度/结果
 */

import type { ToolDefinition } from '../types';
import { taskManager } from '../../taskManager';
import type { TaskStatus } from '../../db';
import { getReplyTargetForConversation } from '../../bridges/asyncDelivery';

interface AsyncTaskParams {
  action: 'create' | 'batch' | 'status' | 'list' | 'cancel' | 'result';
  title?: string;
  prompt?: string;
  toolsets?: string[];
  max_rounds?: number;
  task_id?: string;
  status_filter?: TaskStatus;
  // batch 专用
  prompt_template?: string;
  items?: string[];
}

function formatTask(task: { id: string; title: string; status: string; progress: number; progress_text: string | null; created_at: number; completed_at: number | null; result: string | null; error: string | null }): string {
  const statusMap: Record<string, string> = {
    pending: '⏳ 等待中',
    running: '🔄 执行中',
    completed: '✅ 已完成',
    failed: '❌ 失败',
    cancelled: '🚫 已取消',
  };
  const statusText = statusMap[task.status] ?? task.status;
  const progress = task.status === 'running' ? ` (${Math.round(task.progress * 100)}%)` : '';
  const progressDetail = task.progress_text ? ` — ${task.progress_text}` : '';
  const created = new Date(task.created_at).toLocaleString('zh-CN');
  const completed = task.completed_at ? new Date(task.completed_at).toLocaleString('zh-CN') : '';

  let info = `📋 ${task.title}\n   ID: ${task.id}\n   状态: ${statusText}${progress}${progressDetail}\n   创建: ${created}`;
  if (completed) info += `\n   完成: ${completed}`;
  if (task.error) info += `\n   错误: ${task.error}`;
  return info;
}

const asyncTaskTool: ToolDefinition<AsyncTaskParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'async_task',
      description:
        '创建/查询/取消异步后台任务。创建的任务由后台子智能体执行，不阻塞当前对话。\n' +
        '适用场景：耗时操作（批量文件处理、大量网页抓取、复杂分析等）。\n' +
        '创建后立即返回 task_id，用户可随时用 status 查询进度，完成后自动通知。\n\n' +
        '【batch 批量模式】\n' +
        '用于对一批数据项执行相同操作。提供 prompt_template（含 {{item}} 占位符）和 items 数组，\n' +
        '系统会为每个 item 创建独立子任务并行执行，最终聚合结果。\n' +
        '示例：分析100份简历 → prompt_template="读取简历文件 {{item}}，提取姓名、专业、年龄", items=["简历1.pdf","简历2.pdf",...]',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: '操作类型：create=创建单个任务 | batch=批量任务（并行处理多项） | status=查询状态 | list=列出所有 | cancel=取消 | result=获取结果',
            enum: ['create', 'batch', 'status', 'list', 'cancel', 'result'],
          },
          title: {
            type: 'string',
            description: '【create 必填】任务标题（简短描述，如"简历分析"）',
          },
          prompt: {
            type: 'string',
            description: '【create 必填】自包含的任务指令。子智能体只能看到这段指令，看不到当前对话历史，所以必须包含完成任务所需的全部信息（文件路径、操作步骤、输出要求等）',
          },
          toolsets: {
            type: 'array',
            description: '【create 可选】任务执行所需的通用后台工具集。默认 ["agent"]。',
            items: { type: 'string' },
          },
          max_rounds: {
            type: 'integer',
            description: '【create 可选】最大工具调用轮数（默认 15，上限 50）',
          },
          task_id: {
            type: 'string',
            description: '【status/cancel/result 必填】任务 ID',
          },
          status_filter: {
            type: 'string',
            description: '【list 可选】按状态过滤：pending/running/completed/failed/cancelled',
            enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
          },
          prompt_template: {
            type: 'string',
            description: '【batch 必填】含 {{item}} 占位符的指令模板。每个 item 会替换 {{item}} 后作为独立子任务执行。\n示例："读取文件 {{item}}，提取关键信息并输出JSON格式摘要"',
          },
          items: {
            type: 'array',
            description: '【batch 必填】待处理的数据项列表。每个元素会替换 prompt_template 中的 {{item}}',
            items: { type: 'string' },
          },
        },
        required: ['action'],
      },
    },
  },

  execute(params, context) {
    const { action } = params;
    const replyTarget = context?.conversationId
      ? getReplyTargetForConversation(context.conversationId)
      : undefined;

    switch (action) {
      case 'create': {
        if (!params.title?.trim()) return '❌ 缺少 title 参数';
        if (!params.prompt?.trim()) return '❌ 缺少 prompt 参数（子智能体需要自包含的完整指令）';

        const toolsets = params.toolsets?.length ? params.toolsets : ['agent'];
        if (toolsets.includes('minecraft')) {
          return [
            '【工具结果】',
            '状态：unsupported_domain',
            'Minecraft 游戏目标由 minecraft_goal 管理。请使用 minecraft_goal(action="set") 设置或替换当前目标。',
          ].join('\n');
        }

        const task = taskManager.createAndStart({
          title: params.title.trim(),
          prompt: params.prompt.trim(),
          conversationId: context?.conversationId,
          type: 'background',
          metadata: {
            toolsets,
            maxRounds: params.max_rounds,
            replyTarget,
          },
        });

        return [
          '【工具结果】',
          '状态：accepted',
          `任务：${task.title}`,
          `任务 ID：${task.id}`,
          '结果可用性：none',
          '该状态只确认任务所有权，不代表任何具体操作发生或取得进展。终态产生后，系统会把结果交回来源对话。',
        ].join('\n');
      }

      case 'batch': {
        if (!params.title?.trim()) return '❌ 缺少 title 参数';
        if (!params.prompt_template?.trim()) return '❌ 缺少 prompt_template 参数（含 {{item}} 占位符的指令模板）';
        if (!params.items || !Array.isArray(params.items) || params.items.length === 0) {
          return '❌ 缺少 items 参数（待处理的数据项列表）';
        }
        if (!params.prompt_template.includes('{{item}}')) {
          return '❌ prompt_template 必须包含 {{item}} 占位符';
        }
        if (params.toolsets?.includes('minecraft')) {
          return [
            '【工具结果】',
            '状态：unsupported_domain',
            'Minecraft 游戏目标由 minecraft_goal 管理。请使用 minecraft_goal(action="set") 设置或替换当前目标。',
          ].join('\n');
        }

        const batchTask = taskManager.createAndStart({
          title: params.title.trim(),
          prompt: `批量任务：对 ${params.items.length} 个数据项执行操作`,
          conversationId: context?.conversationId,
          type: 'batch',
          metadata: {
            promptTemplate: params.prompt_template.trim(),
            items: params.items,
            toolsets: params.toolsets ?? ['worker'],
            maxRounds: params.max_rounds ?? 10,
            replyTarget,
          },
        });

        return `✅ 批量任务已创建\n\n` +
          `📋 ${batchTask.title}\n` +
          `🆔 ${batchTask.id}\n` +
          `📊 共 ${params.items.length} 项，将并行处理\n\n` +
          `子任务会自动创建并排队执行（并发上限 3）。\n` +
          `全部完成后会自动向当前对话推送通知消息，无需轮询；\n` +
          `也可用 async_task status task_id="${batchTask.id}" 随时查询整体进度。`;
      }

      case 'status': {
        if (!params.task_id) return '❌ 缺少 task_id 参数';
        const task = taskManager.getTask(params.task_id);
        if (!task) return `❌ 未找到任务: ${params.task_id}`;
        return formatTask(task);
      }

      case 'list': {
        const tasks = taskManager.listTasks({
          status: params.status_filter,
          conversationId: context?.conversationId,
        });
        if (tasks.length === 0) return '📭 当前没有任务';
        const header = `共 ${tasks.length} 个任务：\n\n`;
        return header + tasks.map(formatTask).join('\n\n');
      }

      case 'cancel': {
        if (!params.task_id) return '❌ 缺少 task_id 参数';
        return taskManager.cancelTask(params.task_id, 'user_cancelled').then((ok) => (
          ok ? `✅ 已取消任务: ${params.task_id}` : `❌ 无法取消（任务不存在或已结束）`
        ));
      }

      case 'result': {
        if (!params.task_id) return '❌ 缺少 task_id 参数';
        const task = taskManager.getTask(params.task_id);
        if (!task) return `❌ 未找到任务: ${params.task_id}`;
        if (task.status === 'completed') {
          const resultText = task.result?.trim();
          if (resultText) {
            return `✅ 任务「${task.title}」已完成\n\n--- 结果 ---\n${resultText}`;
          }
          return `✅ 任务「${task.title}」已完成，但未返回结果文本。\n请结合当前环境确认实际产出，或让用户决定是否重试。`;
        }
        if (task.status === 'failed') {
          return `❌ 任务「${task.title}」失败: ${task.error ?? '未知错误'}`;
        }
        return `⏳ 任务「${task.title}」尚未完成（当前状态: ${task.status}，进度: ${Math.round(task.progress * 100)}%）`;
      }

      default:
        return `❌ 未知操作: ${action}`;
    }
  },
};

export default asyncTaskTool;
