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

// ── 子智能体禁止工具 ─────────────────────────────────────

export const CHILD_BLOCKED_TOOLS = new Set([
  'async_task',          // 禁止递归创建异步任务
  'schedule_task',       // 禁止创建定时任务
  'switch_agent_mode',   // 禁止切换模式
  'memory',              // 禁止写共享记忆
]);

// ── TaskManager 单例 ─────────────────────────────────────

class TaskManager extends EventEmitter {
  /** 正在运行的任务 AbortController 映射 */
  private runningAborts = new Map<string, AbortController>();

  /** 当前并行运行数 */
  get runningCount(): number {
    return this.runningAborts.size;
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

    // 异步启动，不阻塞
    this._startAsync(task);
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

  cancelTask(taskId: string): boolean {
    const ctrl = this.runningAborts.get(taskId);
    if (ctrl) {
      ctrl.abort();
      this.runningAborts.delete(taskId);
      dbUpdateTask(taskId, { status: 'cancelled', completed_at: Date.now() });
      this.emit('task:cancelled', dbGetTask(taskId));
      return true;
    }
    // 如果还在 pending 但未运行
    const task = dbGetTask(taskId);
    if (task && task.status === 'pending') {
      dbUpdateTask(taskId, { status: 'cancelled', completed_at: Date.now() });
      return true;
    }
    return false;
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

  private async _startAsync(task: DBTask): Promise<void> {
    // 并发控制：等待空位
    if (this.runningCount >= MAX_CONCURRENT) {
      console.log(`[TaskManager] 并发已满 (${MAX_CONCURRENT})，任务 ${task.id} 等待中`);
      await this._waitForSlot();
    }

    // 等待期间可能已被取消
    const freshTask = dbGetTask(task.id);
    if (!freshTask || freshTask.status === 'cancelled') {
      console.log(`[TaskManager] 任务 ${task.id} 在等待队列中被取消`);
      return;
    }

    const abort = new AbortController();
    this.runningAborts.set(task.id, abort);

    // 标记 running
    dbUpdateTask(task.id, { status: 'running', started_at: Date.now() });
    this.emit('task:started', dbGetTask(task.id));

    try {
      // 按任务类型分发到不同执行器（动态导入避免循环依赖）
      let result: string;
      if (task.type === 'batch') {
        // 批量任务：拆分 → 并行子任务 → 聚合结果
        const { runBatch } = await import('./batchRunner');
        result = await runBatch(task, abort.signal, (progress, text) => {
          this.updateProgress(task.id, progress, text);
        });
      } else {
        // 通用子智能体：多轮 ReAct 循环
        const { runChildAgent } = await import('./agentRunner');
        result = await runChildAgent(task, abort.signal, (progress, text) => {
          this.updateProgress(task.id, progress, text);
        });
      }

      if (abort.signal.aborted) return; // 已取消，不覆盖状态

      dbUpdateTask(task.id, {
        status: 'completed',
        result,
        progress: 1,
        progress_text: '已完成',
        completed_at: Date.now(),
      });
      const completedTask = dbGetTask(task.id)!;
      this.emit('task:completed', completedTask);
      console.log(`[TaskManager] 任务完成: ${task.title} (${task.id})`);
    } catch (err) {
      if (abort.signal.aborted) return;
      const errorMsg = err instanceof Error ? err.message : String(err);
      dbUpdateTask(task.id, {
        status: 'failed',
        error: errorMsg,
        completed_at: Date.now(),
      });
      const failedTask = dbGetTask(task.id)!;
      this.emit('task:failed', failedTask);
      console.error(`[TaskManager] 任务失败: ${task.title} — ${errorMsg}`);
    } finally {
      this.runningAborts.delete(task.id);
    }
  }

  /** 等待并发槽位释放 */
  private _waitForSlot(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.runningCount < MAX_CONCURRENT) {
          resolve();
        } else {
          // 监听一次完成/失败/取消事件后重试
          const handler = () => {
            this.removeListener('task:completed', handler);
            this.removeListener('task:failed', handler);
            this.removeListener('task:cancelled', handler);
            check();
          };
          this.once('task:completed', handler);
          this.once('task:failed', handler);
          this.once('task:cancelled', handler);
        }
      };
      check();
    });
  }
}

// ── 单例导出 ──────────────────────────────────────────────

export const taskManager = new TaskManager();
