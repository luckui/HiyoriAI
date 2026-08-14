/**
 * TaskManager — 异步任务管理器
 *
 * 职责：
 *   1. 创建/查询/取消后台异步任务（持久化到 SQLite tasks 表）
 *   2. 通过 AgentRunner 在后台执行子智能体（非阻塞）
 *   3. 进度上报 + 完成通知（通过事件系统推送到 renderer）
 *
 * 设计原则：
 *   - 提交即返回（createAndStart 立即返回 taskId，不阻塞主对话）
 *   - SQLite 持久化（进程重启不丢失任务记录）
 *   - 并发控制（最多 MAX_CONCURRENT 个后台任务同时运行）
 *   - 隔离上下文（子任务不继承父对话历史）
 */

import { EventEmitter } from 'events';
import {
  createTask as dbCreateTask,
  getTask as dbGetTask,
  listTasks as dbListTasks,
  updateTask as dbUpdateTask,
  type DBTask,
  type TaskStatus,
  type TaskType,
} from './db';
import { traceTurnEvent } from './turnTrace';

// ── 类型 ──────────────────────────────────────────────────

export interface CreateTaskOptions {
  title: string;
  prompt: string;
  conversationId?: string;
  type?: TaskType;
  context?: Record<string, unknown>;
  parentTaskId?: string;
  metadata?: Record<string, unknown>;
}

// ── 常量 ──────────────────────────────────────────────────

const MAX_CONCURRENT = 3;

interface TaskTerminationRequest {
  status: 'cancelled' | 'failed';
  reason?: string;
  error?: string;
}

interface TaskExecution {
  abort: AbortController;
  started: boolean;
  termination?: TaskTerminationRequest;
  settled: Promise<DBTask | null>;
  resolveSettled(task: DBTask | null): void;
}

// ── 子智能体禁止工具 ─────────────────────────────────────

export const CHILD_BLOCKED_TOOLS = new Set([
  'async_task',          // 禁止递归创建异步任务
  'schedule_task',       // 禁止创建定时任务
  'switch_agent_mode',   // 禁止切换模式
  'memory',              // 禁止写共享记忆
]);

// ── TaskManager 单例 ─────────────────────────────────────

export class TaskManager extends EventEmitter {
  /** 已排队或正在运行的执行记录；终态持久化后才移除。 */
  private executions = new Map<string, TaskExecution>();

  /** 当前并行运行数 */
  get runningCount(): number {
    return [...this.executions.values()].filter((execution) => execution.started).length;
  }

  // ── 创建并启动 ──────────────────────────────────────────

  createAndStart(opts: CreateTaskOptions): DBTask {
    const task = dbCreateTask({
      title: opts.title,
      prompt: opts.prompt,
      conversation_id: opts.conversationId ?? null,
      type: opts.type ?? 'background',
      status: 'pending',
      context: opts.context ? JSON.stringify(opts.context) : null,
      parent_task_id: opts.parentTaskId ?? null,
      metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
    });

    let resolveSettled!: (task: DBTask | null) => void;
    const execution: TaskExecution = {
      abort: new AbortController(),
      started: false,
      settled: new Promise((resolve) => { resolveSettled = resolve; }),
      resolveSettled,
    };
    this.executions.set(task.id, execution);

    // 异步启动，不阻塞
    void this._startAsync(task, execution);
    return task;
  }

  // ── 查询 ────────────────────────────────────────────────

  getTask(taskId: string): DBTask | null {
    return dbGetTask(taskId);
  }

  listTasks(filter?: { status?: TaskStatus; conversationId?: string; parentTaskId?: string }): DBTask[] {
    return dbListTasks(filter);
  }

  // ── 取消 ────────────────────────────────────────────────

  async cancelTask(taskId: string, reason?: string): Promise<boolean> {
    const task = dbGetTask(taskId);
    if (!task || (task.status !== 'pending' && task.status !== 'running')) return false;
    const execution = this.executions.get(taskId);
    if (!execution) return false;
    execution.termination ??= { status: 'cancelled', reason };
    execution.abort.abort();
    await execution.settled;
    return true;
  }

  async failTask(taskId: string, error: string): Promise<boolean> {
    const task = dbGetTask(taskId);
    if (!task || (task.status !== 'pending' && task.status !== 'running')) return false;
    const execution = this.executions.get(taskId);
    if (!execution) return false;
    execution.termination = { status: 'failed', error };
    execution.abort.abort();
    await execution.settled;
    return true;
  }

  async waitForTerminal(taskId: string): Promise<DBTask | null> {
    const execution = this.executions.get(taskId);
    return execution ? execution.settled : dbGetTask(taskId);
  }

  // ── 更新进度（供 AgentRunner 内部调用） ─────────────────

  updateProgress(taskId: string, progress: number, progressText?: string): void {
    dbUpdateTask(taskId, {
      progress: Math.min(1, Math.max(0, progress)),
      progress_text: progressText ?? null,
    });
    const task = dbGetTask(taskId);
    if (task) this.emit('task:progress', task);
  }

  // ── 内部：异步启动任务 ──────────────────────────────────

  private async _startAsync(task: DBTask, execution: TaskExecution): Promise<void> {
    // 并发控制：等待空位
    if (this.runningCount >= MAX_CONCURRENT) {
      console.log(`[TaskManager] 并发已满 (${MAX_CONCURRENT})，任务 ${task.id} 等待中`);
      await this._waitForSlot(execution.abort.signal);
    }

    // 等待期间可能已被取消
    const freshTask = dbGetTask(task.id);
    if (!freshTask || execution.termination || execution.abort.signal.aborted) {
      console.log(`[TaskManager] 任务 ${task.id} 在等待队列中被取消`);
      this.finalizeExecution(task.id, execution, execution.termination ?? { status: 'cancelled' });
      return;
    }

    execution.started = true;

    // 标记 running
    dbUpdateTask(task.id, { status: 'running', started_at: Date.now() });
    this.emit('task:started', dbGetTask(task.id));

    try {
      // 按任务类型分发到不同执行器（动态导入避免循环依赖）
      let result: string;
      if (task.type === 'batch') {
        // 批量任务：拆分 → 并行子任务 → 聚合结果
        const { runBatch } = await import('./batchRunner');
        result = await runBatch(task, execution.abort.signal, (progress, text) => {
          this.updateProgress(task.id, progress, text);
        });
      } else {
        // 通用子智能体：多轮 ReAct 循环
        const { runChildAgent } = await import('./agentRunner');
        result = await runChildAgent(task, execution.abort.signal, (progress, text) => {
          this.updateProgress(task.id, progress, text);
        });
      }

      if (execution.termination || execution.abort.signal.aborted) {
        this.finalizeExecution(task.id, execution, execution.termination ?? { status: 'cancelled' });
        return;
      }

      dbUpdateTask(task.id, {
        status: 'completed',
        result,
        progress: 1,
        progress_text: '已完成',
        completed_at: Date.now(),
      });
      const completedTask = dbGetTask(task.id)!;
      this.settleExecution(task.id, execution, completedTask);
      this.emit('task:completed', completedTask);
      console.log(`[TaskManager] 任务完成: ${task.title} (${task.id})`);
    } catch (err) {
      if (execution.termination || execution.abort.signal.aborted) {
        this.finalizeExecution(task.id, execution, execution.termination ?? { status: 'cancelled' });
        return;
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      dbUpdateTask(task.id, {
        status: 'failed',
        error: errorMsg,
        completed_at: Date.now(),
      });
      const failedTask = dbGetTask(task.id)!;
      this.settleExecution(task.id, execution, failedTask);
      traceTaskTerminal(failedTask, 'child-task-error', errorMsg);
      this.emit('task:failed', failedTask);
      console.error(`[TaskManager] 任务失败: ${task.title} — ${errorMsg}`);
    }
  }

  reconcileInterruptedSlotTasks(slotKey: string): number {
    let count = 0;
    for (const task of dbListTasks()) {
      if (task.status !== 'pending' && task.status !== 'running') continue;
      if (!taskMetadataMatches(task, 'slotKey', slotKey)) continue;
      dbUpdateTask(task.id, {
        status: 'failed',
        error: 'Interrupted by application restart',
        completed_at: Date.now(),
      });
      const failedTask = dbGetTask(task.id);
      if (failedTask) traceTaskTerminal(failedTask, 'child-task-error', failedTask.error ?? undefined);
      count += 1;
    }
    return count;
  }

  private finalizeExecution(
    taskId: string,
    execution: TaskExecution,
    termination: TaskTerminationRequest,
  ): void {
    const completedAt = Date.now();
    if (termination.status === 'failed') {
      const error = termination.error ?? 'Task failed';
      dbUpdateTask(taskId, { status: 'failed', error, completed_at: completedAt });
      const failedTask = dbGetTask(taskId);
      if (failedTask) {
        this.settleExecution(taskId, execution, failedTask);
        traceTaskTerminal(failedTask, 'child-task-error', error);
        this.emit('task:failed', failedTask);
      } else {
        this.settleExecution(taskId, execution, null);
      }
      return;
    }

    dbUpdateTask(taskId, {
      status: 'cancelled',
      progress_text: termination.reason ?? null,
      completed_at: completedAt,
    });
    const cancelledTask = dbGetTask(taskId);
    if (cancelledTask) {
      this.settleExecution(taskId, execution, cancelledTask);
      traceTaskTerminal(cancelledTask, 'child-task-cancelled');
      this.emit('task:cancelled', cancelledTask);
    } else {
      this.settleExecution(taskId, execution, null);
    }
  }

  private settleExecution(taskId: string, execution: TaskExecution, task: DBTask | null): void {
    execution.started = false;
    if (this.executions.get(taskId) === execution) this.executions.delete(taskId);
    execution.resolveSettled(task);
  }

  /** 等待并发槽位释放 */
  private _waitForSlot(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.removeListener('task:completed', check);
        this.removeListener('task:failed', check);
        this.removeListener('task:cancelled', check);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const check = () => {
        if (signal.aborted || this.runningCount < MAX_CONCURRENT) finish();
      };
      this.on('task:completed', check);
      this.on('task:failed', check);
      this.on('task:cancelled', check);
      signal.addEventListener('abort', finish, { once: true });
      check();
    });
  }
}

// ── 单例导出 ──────────────────────────────────────────────

function traceTaskTerminal(
  task: DBTask,
  type: 'child-task-cancelled' | 'child-task-error',
  error?: string,
): void {
  traceTurnEvent({
    type,
    turnId: task.id,
    taskId: task.id,
    conversationId: task.conversation_id ?? `task-${task.id}`,
    title: task.title,
    ...(error ? { error } : {}),
  });
}

export const taskManager = new TaskManager();

function taskMetadataMatches(task: DBTask, key: string, value: unknown): boolean {
  if (!task.metadata) return false;
  try {
    return JSON.parse(task.metadata)[key] === value;
  } catch {
    return false;
  }
}
