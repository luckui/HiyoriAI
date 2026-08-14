/**
 * BatchRunner — 批量任务编排引擎
 *
 * 职责：
 *   1. 将父 batch 任务拆分为 N 个子任务
 *   2. 子任务通过 TaskManager 并行执行（受 MAX_CONCURRENT 约束）
 *   3. 监听子任务完成事件，汇总进度到父任务
 *   4. 所有子任务完成后聚合结果、更新父任务
 *
 * 流程：
 *   AI 调用 async_task batch → TaskManager.createAndStart(type='batch')
 *     → _startAsync → runBatch(parentTask)
 *       → 遍历 items，为每个 item 创建子 background 任务
 *       → 子任务各自走 agentRunner（受 MAX_CONCURRENT 限流）
 *       → 每个子任务完成时更新父进度（X/N）
 *       → 全部完成后聚合结果写入父任务
 *
 * metadata 格式（父 batch 任务）：
 *   {
 *     promptTemplate: string,   // 含 {{item}} 占位符的指令模板
 *     items: string[],          // 待处理数据列表
 *     toolsets?: string[],      // 子任务可用工具集
 *     maxRounds?: number,       // 子任务最大工具轮数
 *   }
 */

import {
  getTask as dbGetTask,
  updateTask as dbUpdateTask,
  listTasks as dbListTasks,
  type DBTask,
} from './db';
import { taskManager } from './taskManager';

// ── 类型 ──────────────────────────────────────────────────

export interface BatchMeta {
  promptTemplate: string;
  items: string[];
  toolsets?: string[];
  maxRounds?: number;
}

// ── 主函数 ────────────────────────────────────────────────

/**
 * 执行批量任务：拆分 → 并行子任务 → 聚合结果
 *
 * @param parentTask - 父 batch 任务（type='batch'）
 * @param signal     - 取消信号
 * @param onProgress - 进度回调
 * @returns 聚合后的结果文本
 */
export async function runBatch(
  parentTask: DBTask,
  signal: AbortSignal,
  onProgress: (progress: number, text: string) => void,
): Promise<string> {
  // ── 解析 metadata ──────────────────────────────────────
  const meta = parseBatchMeta(parentTask);
  const { promptTemplate, items, toolsets, maxRounds } = meta;
  const total = items.length;

  if (total === 0) {
    return '批量任务无输入项（items 为空）';
  }

  onProgress(0, `准备中，共 ${total} 项`);

  // ── 创建所有子任务（不立即启动，由 TaskManager 排队） ───
  // 每个子任务间隔 300ms 创建，错开初始 API 请求时机，避免突发流量触发 429
  const STAGGER_MS = 300;
  const childIds: string[] = [];
  for (let i = 0; i < total; i++) {
    if (signal.aborted) throw new Error('批量任务已被取消');
    if (i > 0) await new Promise(r => setTimeout(r, STAGGER_MS));

    const itemPrompt = promptTemplate.replace(/\{\{item\}\}/g, items[i]);
    const child = taskManager.createAndStart({
      title: `${parentTask.title} [${i + 1}/${total}]`,
      prompt: itemPrompt,
      conversationId: parentTask.conversation_id ?? undefined,
      type: 'background',
      parentTaskId: parentTask.id,
      metadata: {
        toolsets: toolsets ?? ['worker'],
        maxRounds: maxRounds ?? 10,
        batchIndex: i,
      },
    });
    childIds.push(child.id);
  }

  onProgress(0, `已创建 ${total} 个子任务，执行中...`);

  // ── 等待所有子任务完成 ─────────────────────────────────
  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const checkDone = () => {
      if (settled) return;

      const children = dbListTasks({ parentTaskId: parentTask.id });
      const completed = children.filter(c => c.status === 'completed').length;
      const failed = children.filter(c => c.status === 'failed').length;
      const cancelled = children.filter(c => c.status === 'cancelled').length;
      const done = completed + failed + cancelled;

      // 更新父进度
      onProgress(done / total, `${done}/${total} 完成（✅${completed} ❌${failed} 🚫${cancelled}）`);

      if (done >= total) {
        settled = true;
        cleanup();
        resolve(aggregateResults(parentTask, children));
      }
    };

    // 监听任务事件
    const onCompleted = (task: DBTask) => {
      if (childIds.includes(task.id)) checkDone();
    };
    const onFailed = (task: DBTask) => {
      if (childIds.includes(task.id)) checkDone();
    };
    const onCancelled = (task: DBTask) => {
      if (childIds.includes(task.id)) checkDone();
    };

    taskManager.on('task:completed', onCompleted);
    taskManager.on('task:failed', onFailed);
    taskManager.on('task:cancelled', onCancelled);

    // 取消信号处理
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      // 所有子任务实际退出后，父任务才算取消完成。
      void Promise.all(childIds.map((cid) => taskManager.cancelTask(cid, 'parent_cancelled')))
        .then(() => reject(new Error('批量任务已被取消')))
        .catch(reject);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    function cleanup() {
      taskManager.removeListener('task:completed', onCompleted);
      taskManager.removeListener('task:failed', onFailed);
      taskManager.removeListener('task:cancelled', onCancelled);
      signal.removeEventListener('abort', onAbort);
    }

    // 首次检查（可能子任务已经瞬间完成）
    checkDone();
  });
}

// ── 内部工具函数 ─────────────────────────────────────────

/** 从 DBTask.metadata 解析 BatchMeta */
function parseBatchMeta(task: DBTask): BatchMeta {
  if (!task.metadata) {
    throw new Error('batch 任务缺少 metadata');
  }
  const raw = JSON.parse(task.metadata);
  if (!raw.promptTemplate || typeof raw.promptTemplate !== 'string') {
    throw new Error('batch metadata 缺少 promptTemplate');
  }
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    throw new Error('batch metadata 缺少 items 或 items 为空');
  }
  return {
    promptTemplate: raw.promptTemplate,
    items: raw.items.map(String),
    toolsets: Array.isArray(raw.toolsets) ? raw.toolsets : undefined,
    maxRounds: typeof raw.maxRounds === 'number' ? raw.maxRounds : undefined,
  };
}

/** 聚合所有子任务结果为统一报告 */
function aggregateResults(parentTask: DBTask, children: DBTask[]): string {
  // 按 batchIndex 排序
  const sorted = [...children].sort((a, b) => {
    const idxA = getBatchIndex(a);
    const idxB = getBatchIndex(b);
    return idxA - idxB;
  });

  const completed = sorted.filter(c => c.status === 'completed');
  const failed = sorted.filter(c => c.status === 'failed');
  const cancelled = sorted.filter(c => c.status === 'cancelled');
  const total = sorted.length;

  const lines: string[] = [
    `# 批量任务结果：${parentTask.title}`,
    '',
    `✅ 成功: ${completed.length}/${total}`,
  ];

  if (failed.length > 0) lines.push(`❌ 失败: ${failed.length}/${total}`);
  if (cancelled.length > 0) lines.push(`🚫 取消: ${cancelled.length}/${total}`);
  lines.push('');

  // 成功结果
  if (completed.length > 0) {
    lines.push('## 结果');
    for (const child of completed) {
      const idx = getBatchIndex(child);
      const result = child.result ?? '(无结果)';
      // 截断过长结果（2000 字足够容纳一条 JSON 摘要）
      const truncated = result.length > 2000
        ? result.slice(0, 2000) + `...(截断，原文 ${result.length} 字)`
        : result;
      lines.push(`### [${idx + 1}] ${child.title}`);
      lines.push(truncated);
      lines.push('');
    }
  }

  // 失败摘要
  if (failed.length > 0) {
    lines.push('## 失败详情');
    for (const child of failed) {
      const idx = getBatchIndex(child);
      lines.push(`- [${idx + 1}] ${child.title}: ${child.error ?? '未知错误'}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** 从子任务 metadata 提取 batchIndex */
function getBatchIndex(task: DBTask): number {
  try {
    const meta = task.metadata ? JSON.parse(task.metadata) : {};
    return typeof meta.batchIndex === 'number' ? meta.batchIndex : 0;
  } catch {
    return 0;
  }
}
