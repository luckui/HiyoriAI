/**
 * async_task — 异步后台任务工具
 *
 * 让 AI 能够创建/查询/取消/重试后台异步任务。
 * 创建的任务会在后台由子智能体执行，不阻塞当前对话。
 *
 * 场景示例：
 *   - 用户："去批改这100份作业并打分"
 *     AI 调用 async_task batch → 后台限流并发处理 → 完成后通知用户
 *   - 用户："改完了吗？"
 *     AI 调用 async_task status → 返回进度 / 失败项
 *   - 有几份失败了：AI 调用 async_task retry → 只重跑失败的项
 */

import type { ToolDefinition } from '../types';
import { taskManager, MAX_TASK_ATTEMPTS } from '../../taskManager';
import type { DBTask, TaskStatus } from '../../db';
import { getReplyTargetForConversation } from '../../bridges/asyncDelivery';
import {
  BATCH_DEFAULT_MAX_ATTEMPTS,
  BATCH_DEFAULT_MAX_ROUNDS,
  BATCH_DEFAULT_TOOLSETS,
  BATCH_MAX_ITEMS,
  findMissingPaths,
  formatBatchResultPage,
  formatBatchStatus,
  resolveItemSource,
} from '../../batchRunner';
import { validateToolset } from '../../toolsets';
import { describeResultSchema, normalizeResultSchema, type ResultSchema } from '../../resultSchema';

interface AsyncTaskParams {
  action: 'create' | 'batch' | 'status' | 'list' | 'cancel' | 'retry' | 'result';
  title?: string;
  prompt?: string;
  toolsets?: string[];
  max_rounds?: number;
  max_attempts?: number;
  task_id?: string;
  status_filter?: TaskStatus;
  // batch 专用：数据项来源三选一
  prompt_template?: string;
  items?: string[];
  items_dir?: string;
  items_pattern?: string;
  items_recursive?: boolean;
  items_file?: string;
  result_schema?: unknown;
  // result 分页（batch）
  offset?: number;
  limit?: number;
}

const LIST_LIMIT = 20;

const MINECRAFT_UNSUPPORTED = [
  '【工具结果】',
  '状态：unsupported_domain',
  'Minecraft 游戏目标由 minecraft_goal 管理。请使用 minecraft_goal(action="set") 设置或替换当前目标。',
].join('\n');

function formatTask(task: DBTask): string {
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

  let info = `📋 ${task.title}${task.type === 'batch' ? '（批量）' : ''}\n   ID: ${task.id}\n   状态: ${statusText}${progress}${progressDetail}\n   创建: ${created}`;
  if (completed) info += `\n   完成: ${completed}`;
  if (task.error) info += `\n   错误: ${task.error.length > 300 ? `${task.error.slice(0, 300)}…` : task.error}`;
  return info;
}

function clampAttempts(value: unknown, fallback: number): number {
  const attempts = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(MAX_TASK_ATTEMPTS, Math.max(1, attempts));
}

/** 开头 3 项 + 结尾 2 项，供 LLM / 用户核对清单是否符合预期 */
function sampleItems(items: string[]): string {
  if (items.length <= 5) return items.join('、');
  return `${items.slice(0, 3).join('、')} … ${items.slice(-2).join('、')}`;
}

/** 工具集校验：Minecraft 走专属工具；未知工具集会让每个子任务都拿不到工具，提前拒绝 */
function checkToolsets(toolsets: string[]): string | undefined {
  if (toolsets.includes('minecraft')) return MINECRAFT_UNSUPPORTED;
  const unknown = toolsets.filter((name) => !validateToolset(name));
  return unknown.length > 0 ? `❌ 未知工具集：${unknown.join(', ')}` : undefined;
}

const asyncTaskTool: ToolDefinition<AsyncTaskParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'async_task',
      description:
        '创建/查询/取消/重试异步后台任务。创建的任务由后台子智能体执行，不阻塞当前对话。\n' +
        '适用场景：耗时操作（批量文件处理、大量网页抓取、复杂分析等）。\n' +
        '创建后立即返回 task_id，终态产生后系统会自动把结果交回当前对话，无需轮询。\n\n' +
        '【batch 批量模式】\n' +
        '适用：每一项都需要阅读理解或判断（批改、摘要、分类、提取信息等），系统为每一项起一个子智能体。\n' +
        '不适用：格式转换、批量改名、压缩、统计行数等机械性处理——直接写脚本用 run_command 一次处理，不要用 batch。\n' +
        `提供 prompt_template（含 {{item}} 占位符）和数据项清单（最多 ${BATCH_MAX_ITEMS} 项），清单来源三选一：\n` +
        '  - items_dir（+ items_pattern / items_recursive）：处理某个文件夹里的文件，由系统列举，不要自己把文件名抄进 items；\n' +
        '  - items_file：清单文件，每个非空行是一项；\n' +
        '  - items：用户直接给出的少量数据项（如几个网址）。\n' +
        '系统会一次性登记全部子任务并限流并发执行；临时故障自动重试，连续失败自动熔断。\n' +
        '完成后用 result 分页读取各项结果（按页脚提示的 offset 翻页）；失败或未执行的项可用 retry 重跑，已成功的项保留。\n' +
        '示例：批改文件夹里的作业 → prompt_template="读取作业文件 {{item}}，按评分标准打分并输出JSON", items_dir="D:\\\\作业", items_pattern="*.docx"',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: '操作类型：create=创建单个任务 | batch=批量任务（并行处理多项） | status=查询状态 | list=列出任务 | cancel=取消 | retry=重试失败的任务（批量任务只重跑失败/未执行的项） | result=获取结果（批量任务分页）',
            enum: ['create', 'batch', 'status', 'list', 'cancel', 'retry', 'result'],
          },
          title: {
            type: 'string',
            description: '【create/batch 必填】任务标题（简短描述，如"作业打分"）',
          },
          prompt: {
            type: 'string',
            description: '【create 必填】自包含的任务指令。子智能体只能看到这段指令，看不到当前对话历史，所以必须包含完成任务所需的全部信息（文件路径、操作步骤、输出要求等）',
          },
          toolsets: {
            type: 'array',
            description: '【create/batch 可选】任务可用的工具集。create 默认 ["agent"]，batch 默认 ["worker"]（文件读写 + 命令执行）。',
            items: { type: 'string' },
          },
          max_rounds: {
            type: 'integer',
            description: `【create/batch 可选】每个任务最大工具调用轮数（create 默认 15，batch 默认 ${BATCH_DEFAULT_MAX_ROUNDS}，上限 50）`,
          },
          max_attempts: {
            type: 'integer',
            description: `【create/batch 可选】遇到限流、网络、超时等临时故障时的最大尝试次数（create 默认 1，batch 默认 ${BATCH_DEFAULT_MAX_ATTEMPTS}，上限 ${MAX_TASK_ATTEMPTS}）`,
          },
          task_id: {
            type: 'string',
            description: '【status/cancel/retry/result 必填】任务 ID',
          },
          status_filter: {
            type: 'string',
            description: '【list 可选】按状态过滤：pending/running/completed/failed/cancelled',
            enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
          },
          prompt_template: {
            type: 'string',
            description: '【batch 必填】含 {{item}} 占位符的指令模板。每个 item 会替换 {{item}} 后作为独立子任务执行，因此模板必须自包含（评分标准、输出格式等都写进去）。\n示例："读取文件 {{item}}，提取关键信息并输出JSON格式摘要"',
          },
          items_dir: {
            type: 'string',
            description: '【batch，清单来源三选一】文件夹绝对路径：系统列举其中匹配 items_pattern 的文件，每个文件的绝对路径作为一项（自然排序，跳过隐藏文件与 ~$ 临时文件）',
          },
          items_pattern: {
            type: 'string',
            description: '【batch，配合 items_dir】文件名通配符，如 "*.docx"；多个用 ; 分隔，如 "*.doc;*.docx"。默认 "*"',
          },
          items_recursive: {
            type: 'boolean',
            description: '【batch，配合 items_dir】是否包含子文件夹，默认 false',
          },
          items_file: {
            type: 'string',
            description: '【batch，清单来源三选一】清单文件绝对路径：每个非空行作为一项',
          },
          result_schema: {
            type: 'object',
            description:
              '【batch 可选】声明每一项结果的字段：系统会校验每个子任务的输出（不合格要求改正，仍不合格判失败），完成后生成 CSV 结果表并统计。\n' +
              '需要汇总、统计、比较各项结果时使用；不声明则各项结果为自由文本。字段按任务自行定义，只支持扁平字段，默认必填；\n' +
              '类型：string / number / integer / boolean / array（文本列表）；可加 minimum / maximum（数字）、enum（可选值）、description、optional。\n' +
              '简写：{"score": "integer", "reason": "string"}\n' +
              '完整：{"score": {"type": "integer", "minimum": 0, "maximum": 100}, "类别": {"type": "string", "enum": ["新闻", "广告"]}, "备注": {"type": "string", "optional": true}}',
          },
          items: {
            type: 'array',
            description: `【batch，清单来源三选一】用户直接给出的少量数据项（1–${BATCH_MAX_ITEMS} 项，不能有空项）。处理文件夹中的文件请用 items_dir。每个元素会替换 prompt_template 中的 {{item}}`,
            items: { type: 'string' },
          },
          offset: {
            type: 'integer',
            description: '【result 可选，批量任务】从第几项开始读取（0 起，默认 0）；按上一页页脚提示的 offset 翻页',
          },
          limit: {
            type: 'integer',
            description: '【result 可选，批量任务】本页最多读取几项（默认 20，上限 100；页面过长时会提前分页）',
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
        const toolsetError = checkToolsets(toolsets);
        if (toolsetError) return toolsetError;

        const task = taskManager.createAndStart({
          title: params.title.trim(),
          prompt: params.prompt.trim(),
          conversationId: context?.conversationId,
          type: 'background',
          metadata: {
            toolsets,
            maxRounds: params.max_rounds,
            maxAttempts: clampAttempts(params.max_attempts, 1),
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
        const template = params.prompt_template?.trim();
        if (!template) return '❌ 缺少 prompt_template 参数（含 {{item}} 占位符的指令模板）';
        if (!template.includes('{{item}}')) return '❌ prompt_template 必须包含 {{item}} 占位符';

        let resultSchema: ResultSchema | undefined;
        if (params.result_schema !== undefined && params.result_schema !== null && params.result_schema !== '') {
          const normalized = normalizeResultSchema(params.result_schema);
          if (normalized.errors) {
            return [
              '❌ result_schema 有误，未创建任何子任务：',
              ...normalized.errors.map((error) => `  - ${error}`),
              '示例：{"score": {"type": "integer", "minimum": 0, "maximum": 100}, "reason": "string"}',
            ].join('\n');
          }
          resultSchema = normalized.schema;
        }

        const given = [
          Array.isArray(params.items) && params.items.length > 0 ? 'items' : '',
          params.items_dir?.trim() ? 'items_dir' : '',
          params.items_file?.trim() ? 'items_file' : '',
        ].filter(Boolean);
        if (given.length === 0) {
          return '❌ 缺少数据项清单：请提供 items_dir（文件夹）、items_file（清单文件）或 items（少量数据项）之一';
        }
        if (given.length > 1) return `❌ ${given.join('、')} 只能提供一个`;

        let items: string[];
        let sourceDescription: string;
        if (given[0] === 'items') {
          items = params.items!.map((item) => String(item ?? '').trim());
          const blank = items.findIndex((item) => !item);
          if (blank >= 0) return `❌ items 第 ${blank + 1} 项为空，请去掉空项后重试`;
          if (items.length > BATCH_MAX_ITEMS) {
            return `❌ items 共 ${items.length} 项，超过单个批量任务上限 ${BATCH_MAX_ITEMS} 项。请拆成多个批量任务依次创建（它们共享并发池并公平轮转执行）。`;
          }
          const missing = findMissingPaths(items);
          if (missing.length > 0) {
            return [
              `❌ items 中有 ${missing.length} 个路径不存在，未创建任何子任务：`,
              ...missing.slice(0, 10).map((path) => `  - ${path}`),
              ...(missing.length > 10 ? [`  …等共 ${missing.length} 个`] : []),
              '处理文件夹中的文件时，请改用 items_dir 让系统列举。',
            ].join('\n');
          }
          sourceDescription = `items 参数，共 ${items.length} 项`;
        } else {
          try {
            ({ items, description: sourceDescription } = resolveItemSource({
              dir: params.items_dir?.trim(),
              pattern: params.items_pattern,
              recursive: params.items_recursive,
              file: params.items_file?.trim(),
            }));
          } catch (error) {
            return `❌ ${error instanceof Error ? error.message : String(error)}（未创建任何子任务）`;
          }
        }

        const toolsets = params.toolsets?.length ? params.toolsets : [...BATCH_DEFAULT_TOOLSETS];
        const toolsetError = checkToolsets(toolsets);
        if (toolsetError) return toolsetError;
        const maxAttempts = clampAttempts(params.max_attempts, BATCH_DEFAULT_MAX_ATTEMPTS);

        let created: { task: DBTask; childCount: number };
        try {
          created = taskManager.createBatch({
            title: params.title.trim(),
            conversationId: context?.conversationId,
            promptTemplate: template,
            items,
            toolsets,
            maxRounds: params.max_rounds ?? BATCH_DEFAULT_MAX_ROUNDS,
            maxAttempts,
            resultSchema,
            metadata: { replyTarget },
          });
        } catch (error) {
          return `❌ 批量任务创建失败，未创建任何子任务：${error instanceof Error ? error.message : String(error)}`;
        }

        return [
          '【工具结果】',
          '状态：accepted',
          `批量任务：${created.task.title}`,
          `任务 ID：${created.task.id}`,
          `已登记子任务：${created.childCount}/${items.length}`,
          `清单来源：${sourceDescription}`,
          `清单样例：${sampleItems(items)}`,
          ...(resultSchema
            ? [`结果格式（逐项校验，完成后生成 CSV 结果表与统计）：\n${describeResultSchema(resultSchema)}`]
            : []),
          `执行方式：后台最多 ${taskManager.maxWorkers} 个并发；限流、网络、超时等临时故障每项最多自动尝试 ${maxAttempts} 次；连续失败会自动熔断，避免浪费调用。`,
          '结果可用性：none',
          '全部结束后系统会把汇总交回来源对话，无需轮询；可用 async_task status 查询进度，失败项可用 async_task retry 重跑。',
        ].join('\n');
      }

      case 'status': {
        if (!params.task_id) return '❌ 缺少 task_id 参数';
        const task = taskManager.getTask(params.task_id);
        if (!task) return `❌ 未找到任务: ${params.task_id}`;
        if (task.type !== 'batch') return formatTask(task);
        const detail = formatBatchStatus(task).split('\n').map((line) => `   ${line}`).join('\n');
        return `${formatTask(task)}\n${detail}`;
      }

      case 'list': {
        // 只列顶层任务：批量子任务通过 status / result 查看，避免一个批量任务刷屏
        const tasks = taskManager.listTasks({
          status: params.status_filter,
          conversationId: context?.conversationId,
          topLevelOnly: true,
        });
        if (tasks.length === 0) return '📭 当前没有任务';
        const header = tasks.length > LIST_LIMIT
          ? `共 ${tasks.length} 个任务，显示最近 ${LIST_LIMIT} 个：\n\n`
          : `共 ${tasks.length} 个任务：\n\n`;
        return header + tasks.slice(0, LIST_LIMIT).map(formatTask).join('\n\n');
      }

      case 'cancel': {
        if (!params.task_id) return '❌ 缺少 task_id 参数';
        return taskManager.cancelTask(params.task_id, 'user_cancelled').then((ok) => (
          ok ? `✅ 已取消任务: ${params.task_id}` : `❌ 无法取消（任务不存在或已结束）`
        ));
      }

      case 'retry': {
        if (!params.task_id) return '❌ 缺少 task_id 参数';
        const retried = taskManager.retryTask(params.task_id);
        if (!retried.ok) return `❌ ${retried.message}`;
        return [
          '【工具结果】',
          '状态：accepted',
          retried.message,
          `任务 ID：${params.task_id}`,
          '结果可用性：none',
          '终态产生后，系统会把结果交回来源对话。',
        ].join('\n');
      }

      case 'result': {
        if (!params.task_id) return '❌ 缺少 task_id 参数';
        const task = taskManager.getTask(params.task_id);
        if (!task) return `❌ 未找到任务: ${params.task_id}`;
        if (task.type === 'batch') {
          return formatBatchResultPage(task, { offset: params.offset, limit: params.limit });
        }
        if (task.status === 'completed') {
          const resultText = task.result?.trim();
          if (resultText) {
            return `✅ 任务「${task.title}」已完成\n\n--- 结果 ---\n${resultText}`;
          }
          return `✅ 任务「${task.title}」已完成，但未返回结果文本。\n请结合当前环境确认实际产出，或让用户决定是否重试。`;
        }
        if (task.status === 'failed') {
          return `❌ 任务「${task.title}」失败: ${task.error ?? '未知错误'}\n可调用 async_task retry 重试。`;
        }
        if (task.status === 'cancelled') {
          return `🚫 任务「${task.title}」已取消。如需继续，可调用 async_task retry 重新执行。`;
        }
        return `⏳ 任务「${task.title}」尚未完成（当前状态: ${task.status}，进度: ${Math.round(task.progress * 100)}%${task.progress_text ? `，${task.progress_text}` : ''}）`;
      }

      default:
        return `❌ 未知操作: ${action}`;
    }
  },
};

export default asyncTaskTool;
