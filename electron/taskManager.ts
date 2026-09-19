/**
 * TaskManager — 异步任务管理器
 *
 * 职责：
 *   1. 创建/查询/取消/重试后台异步任务（持久化到 SQLite tasks 表）
 *   2. 调度执行：worker 任务进入固定大小的并发池；batch 编排任务与 slot 专属任务（如 Minecraft 目标）不占池位
 *   3. 失败恢复：临时故障（限流 / 网关 / 网络 / 超时）按 maxAttempts 指数退避重试；
 *      进程重启遗留的任务标记为中断，可用 retryTask 从断点继续
 *   4. 进度上报 + 事件（task:started / progress / retrying / completed / failed / cancelled）
 *
 * 调度模型：
 *   - worker 槽位在任务结束时同步移交给下一个排队任务，占用数永远不超过上限
 *   - 就绪队列按分组轮转（批量子任务按父任务分组，其余任务各自一组），
 *     一个 100 项的批量任务不会把后来提交的单个后台任务饿死
 *   - 排队中 / 等待重试的任务被取消时立即终结，不需要等槽位
 *
 * 设计原则：
 *   - 提交即返回（createAndStart / createBatch 立即返回，不阻塞主对话）
 *   - SQLite 持久化（进程重启不丢失任务记录）
 *   - 隔离上下文（子任务不继承父对话历史）
 */

import { EventEmitter } from 'events';
import {
  createTask as dbCreateTask,
  createTasks as dbCreateTasks,
  getTask as dbGetTask,
  listTasks as dbListTasks,
  updateTask as dbUpdateTask,
  parseTaskMetadata,
  runInTransaction,
  type DBTask,
  type TaskListFilter,
  type TaskType,
} from './db';
import { LLMRequestError } from './llmClient';
import { buildBatchChildRows, parseBatchMeta, runBatch } from './batchRunner';
import type { ResultSchema } from './resultSchema';
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

export interface CreateBatchOptions {
  title: string;
  conversationId?: string;
  /** 含 {{item}} 占位符的子任务指令模板 */
  promptTemplate: string;
  items: string[];
  toolsets?: string[];
  maxRounds?: number;
  /** 每个子任务遇到临时故障时的最大尝试次数（含首次） */
  maxAttempts?: number;
  /** 每个子任务单次尝试的超时时间 */
  timeoutMs?: number;
  /** 结构化结果声明（已规范化） */
  resultSchema?: ResultSchema;
  /** 额外写入父任务 metadata 的字段（如 replyTarget） */
  metadata?: Record<string, unknown>;
}

/** 子任务执行器签名（默认为 agentRunner.runChildAgent） */
export type ChildTaskRunner = (
  task: DBTask,
  signal: AbortSignal,
  onProgress: (progress: number, text: string) => void,
) => Promise<string>;

export interface TaskManagerOptions {
  /** worker 池并发上限 */
  concurrency?: number;
  /** 临时故障重试的基础退避（第 n 次重试等待 base × 2^(n-1)，封顶 60s） */
  retryBaseDelayMs?: number;
  /** 替换默认的子智能体执行器（测试或其他执行后端） */
  runChild?: ChildTaskRunner;
}

export interface RetryTaskResult {
  ok: boolean;
  message: string;
  task?: DBTask;
  /** 批量任务被重新排队的子任务数 */
  resetCount?: number;
}

/** transient=可自动重试的临时故障；fatal=鉴权/额度等，重试无意义；task=任务本身失败 */
export type TaskFailureKind = 'transient' | 'fatal' | 'task';

interface TaskFailure {
  kind: TaskFailureKind;
  message: string;
}

// ── 常量 ──────────────────────────────────────────────────

/** worker 池默认并发上限（批量编排任务与 slot 专属任务不占用） */
export const TASK_CONCURRENCY = 3;
/** 单个任务最大尝试次数的上限（含首次） */
export const MAX_TASK_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 10_000;
const MAX_RETRY_DELAY_MS = 60_000;
const INTERRUPTED_ERROR = 'Interrupted by application restart';

type TaskLane = 'worker' | 'orchestrator' | 'dedicated';
type ExecutionState = 'queued' | 'running' | 'retry_wait';

interface TaskTerminationRequest {
  status: 'cancelled' | 'failed';
  reason?: string;
  error?: string;
}

interface TaskExecution {
  taskId: string;
  lane: TaskLane;
  /** 轮转分组：批量子任务共享父任务分组，其余任务各自一组 */
  groupKey: string;
  state: ExecutionState;
  /** 当前这次尝试的中断控制器（每次尝试新建） */
  abort: AbortController;
  timedOut: boolean;
  termination?: TaskTerminationRequest;
  retryTimer?: ReturnType<typeof setTimeout>;
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

// ── TaskManager ──────────────────────────────────────────

export class TaskManager extends EventEmitter {
  /** worker 池并发上限 */
  readonly maxWorkers: number;
  private readonly retryBaseDelayMs: number;
  private readonly runChild?: ChildTaskRunner;
  /** 已排队、执行中或等待重试的执行记录；终态持久化后才移除。 */
  private readonly executions = new Map<string, TaskExecution>();
  /** 占用 worker 槽位的任务 ID */
  private readonly activeWorkers = new Set<string>();
  private readonly readyQueues = new Map<string, TaskExecution[]>();
  private readyRotation: string[] = [];

  constructor(options: TaskManagerOptions = {}) {
    super();
    this.maxWorkers = Math.max(1, options.concurrency ?? TASK_CONCURRENCY);
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.runChild = options.runChild;
  }

  /** 当前占用 worker 槽位的任务数 */
  get runningCount(): number {
    return this.activeWorkers.size;
  }

  /** 排队等待 worker 槽位的任务数 */
  get queuedCount(): number {
    let count = 0;
    for (const queue of this.readyQueues.values()) count += queue.length;
    return count;
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
    this.startExisting(task);
    return task;
  }

  /**
   * 创建批量任务：父任务与全部子任务在同一个事务中建档（要么全部创建，要么一条都不留），
   * 然后启动父任务编排。参数非法时抛错且不留下任何记录。
   */
  createBatch(opts: CreateBatchOptions): { task: DBTask; childCount: number } {
    const metadata = {
      ...opts.metadata,
      promptTemplate: opts.promptTemplate,
      items: opts.items,
      toolsets: opts.toolsets,
      maxRounds: opts.maxRounds,
      maxAttempts: opts.maxAttempts,
      timeoutMs: opts.timeoutMs,
      resultSchema: opts.resultSchema,
    };
    const { parent, children } = runInTransaction(() => {
      const parent = dbCreateTask({
        title: opts.title,
        prompt: `批量任务：对 ${opts.items.length} 个数据项执行操作`,
        conversation_id: opts.conversationId ?? null,
        type: 'batch',
        status: 'pending',
        context: null,
        parent_task_id: null,
        metadata: JSON.stringify(metadata),
      });
      const children = dbCreateTasks(buildBatchChildRows(parent, parseBatchMeta(parent)));
      return { parent, children };
    });
    this.startExisting(parent);
    return { task: parent, childCount: children.length };
  }

  /**
   * 调度一个已持久化的 pending 任务（批量子任务建档后逐个调度、retry 时复用）。
   * 返回终态 Promise；任务已在调度中时返回已有执行的 Promise。
   */
  startExisting(task: DBTask): Promise<DBTask | null> {
    const existing = this.executions.get(task.id);
    if (existing) return existing.settled;

    let resolveSettled!: (task: DBTask | null) => void;
    const execution: TaskExecution = {
      taskId: task.id,
      lane: laneOf(task),
      groupKey: task.parent_task_id ?? task.id,
      state: 'queued',
      abort: new AbortController(),
      timedOut: false,
      settled: new Promise((resolve) => { resolveSettled = resolve; }),
      resolveSettled,
    };
    this.executions.set(task.id, execution);

    if (execution.lane === 'worker') {
      this.enqueue(execution);
      this.pump();
      if (execution.state === 'queued' && !task.parent_task_id) {
        console.log(`[TaskManager] worker 已满 (${this.maxWorkers})，任务 ${task.id} 排队中`);
      }
    } else {
      void this.runExecution(execution);
    }
    return execution.settled;
  }

  // ── 查询 ────────────────────────────────────────────────

  getTask(taskId: string): DBTask | null {
    return dbGetTask(taskId);
  }

  listTasks(filter?: TaskListFilter): DBTask[] {
    return dbListTasks(filter);
  }

  // ── 取消 / 失败 / 重试 ──────────────────────────────────

  async cancelTask(taskId: string, reason?: string): Promise<boolean> {
    const execution = this.activeExecution(taskId);
    if (!execution) return false;
    execution.termination ??= { status: 'cancelled', reason };
    this.interrupt(execution);
    await execution.settled;
    return true;
  }

  async failTask(taskId: string, error: string): Promise<boolean> {
    const execution = this.activeExecution(taskId);
    if (!execution) return false;
    execution.termination = { status: 'failed', error };
    this.interrupt(execution);
    await execution.settled;
    return true;
  }

  /**
   * 重试已失败 / 已取消的任务。
   *   - 普通任务：整体重置后重新排队
   *   - 批量任务：保留已成功的子任务，只重置失败 / 未执行的子任务，父任务重新编排并汇总
   */
  retryTask(taskId: string): RetryTaskResult {
    const task = dbGetTask(taskId);
    if (!task) return { ok: false, message: `未找到任务: ${taskId}` };
    if (this.executions.has(taskId) || task.status === 'pending' || task.status === 'running') {
      return { ok: false, message: `任务「${task.title}」仍在执行中，无需重试` };
    }
    if (task.parent_task_id) {
      return {
        ok: false,
        message: `这是批量任务的子任务，请对父任务重试：async_task({"action":"retry","task_id":"${task.parent_task_id}"})（只会重跑失败/未执行的项）`,
      };
    }
    if (parseTaskMetadata(task.metadata).slotKey) {
      return { ok: false, message: '该任务由专属控制器管理（如 Minecraft 目标），请通过对应工具重新设置' };
    }

    if (task.type === 'batch') {
      const children = dbListTasks({ parentTaskId: task.id });
      const retryable = children.filter((child) => child.status === 'failed' || child.status === 'cancelled');
      const parentUnfinished = task.status === 'failed' || task.status === 'cancelled';
      if (retryable.length === 0 && !parentUnfinished) {
        return { ok: false, message: `批量任务「${task.title}」没有失败或未执行的子任务` };
      }
      runInTransaction(() => {
        for (const child of retryable) resetForRetry(child);
        resetForRetry(task);
      });
      const fresh = dbGetTask(task.id)!;
      this.startExisting(fresh);
      const kept = children.filter((child) => child.status === 'completed').length;
      return {
        ok: true,
        task: fresh,
        resetCount: retryable.length,
        message: `已重新启动批量任务「${task.title}」：${retryable.length} 个失败/未执行的子任务重新排队，已成功的 ${kept} 项保留。`,
      };
    }

    if (task.status !== 'failed' && task.status !== 'cancelled') {
      return { ok: false, message: `任务「${task.title}」已成功完成，无需重试` };
    }
    runInTransaction(() => resetForRetry(task));
    const fresh = dbGetTask(task.id)!;
    this.startExisting(fresh);
    return { ok: true, task: fresh, message: `已重新启动任务「${task.title}」。` };
  }

  async waitForTerminal(taskId: string): Promise<DBTask | null> {
    const execution = this.executions.get(taskId);
    return execution ? execution.settled : dbGetTask(taskId);
  }

  // ── 更新进度（供执行器内部调用） ────────────────────────

  updateProgress(taskId: string, progress: number, progressText?: string): void {
    dbUpdateTask(taskId, {
      progress: Math.min(1, Math.max(0, progress)),
      progress_text: progressText ?? null,
    });
    const task = dbGetTask(taskId);
    if (task) this.emit('task:progress', task);
  }

  // ── 重启恢复 ────────────────────────────────────────────

  /**
   * 进程重启后内存中的执行记录已丢失：把遗留的 pending / running 任务标记为中断失败，
   * 之后可通过 retryTask 从断点继续（批量任务只重跑未完成的项）。
   */
  reconcileInterruptedTasks(filter: (task: DBTask) => boolean = () => true): number {
    return runInTransaction(() => {
      let count = 0;
      for (const task of dbListTasks()) {
        if (task.status !== 'pending' && task.status !== 'running') continue;
        if (this.executions.has(task.id) || !filter(task)) continue;
        dbUpdateTask(task.id, {
          status: 'failed',
          error: INTERRUPTED_ERROR,
          completed_at: Date.now(),
        });
        const failedTask = dbGetTask(task.id);
        if (failedTask) traceTaskTerminal(failedTask, 'child-task-error', INTERRUPTED_ERROR);
        count += 1;
      }
      return count;
    });
  }

  reconcileInterruptedSlotTasks(slotKey: string): number {
    return this.reconcileInterruptedTasks((task) => parseTaskMetadata(task.metadata).slotKey === slotKey);
  }

  // ── 内部：执行 ──────────────────────────────────────────

  private async runExecution(execution: TaskExecution): Promise<void> {
    try {
      await this.runAttempt(execution);
    } catch (error) {
      // runAttempt 已处理任务自身的错误；到这里说明是 DB 等基础设施异常，兜底保证等待方不会永远挂起
      console.error(`[TaskManager] 任务 ${execution.taskId} 执行器异常:`, error);
      if (this.executions.get(execution.taskId) === execution) {
        try {
          this.recordFailure(execution, { kind: 'task', message: errorMessage(error) });
        } catch {
          this.settleExecution(execution, null);
        }
      }
    } finally {
      if (execution.lane === 'worker' && this.activeWorkers.delete(execution.taskId)) this.pump();
    }
  }

  private async runAttempt(execution: TaskExecution): Promise<void> {
    const task = dbGetTask(execution.taskId);
    if (!task || execution.termination) {
      this.finalizeExecution(execution, execution.termination ?? { status: 'cancelled' });
      return;
    }

    const meta = parseTaskMetadata(task.metadata);
    const attempt = nonNegativeInt(meta.attempt) + 1;
    // 编排任务自身不重试：它的 maxAttempts 字段是给子任务用的
    const maxAttempts = execution.lane === 'orchestrator' ? 1 : normalizeMaxAttempts(meta.maxAttempts);
    const timeoutMs = execution.lane === 'orchestrator' ? undefined : positiveNumber(meta.timeoutMs);

    const abort = new AbortController();
    execution.abort = abort;
    execution.state = 'running';
    execution.timedOut = false;
    dbUpdateTask(task.id, {
      status: 'running',
      started_at: Date.now(),
      error: null,
      progress_text: attempt > 1 ? `第 ${attempt}/${maxAttempts} 次尝试` : null,
      metadata: JSON.stringify({ ...meta, attempt }),
    });
    const running = dbGetTask(task.id) ?? task;
    this.emit('task:started', running);

    const timer = timeoutMs
      ? setTimeout(() => {
          execution.timedOut = true;
          abort.abort();
        }, timeoutMs)
      : undefined;

    let result: string;
    try {
      result = await this.dispatch(running, abort.signal);
    } catch (error) {
      if (execution.termination) {
        this.finalizeExecution(execution, execution.termination);
        return;
      }
      this.handleFailure(execution, classifyFailure(error, execution.timedOut, timeoutMs), attempt, maxAttempts);
      return;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (execution.termination) {
      this.finalizeExecution(execution, execution.termination);
      return;
    }
    if (abort.signal.aborted) {
      // 只有超时会在没有 termination 的情况下中断执行
      this.handleFailure(execution, classifyFailure(undefined, execution.timedOut, timeoutMs), attempt, maxAttempts);
      return;
    }
    this.completeExecution(execution, result);
  }

  private async dispatch(task: DBTask, signal: AbortSignal): Promise<string> {
    const onProgress = (progress: number, text: string) => this.updateProgress(task.id, progress, text);
    if (task.type === 'batch') {
      // 批量任务：建档/复用子任务 → 交给本管理器调度 → 聚合结果
      return runBatch(task, signal, onProgress, this);
    }
    // 通用子智能体：多轮 ReAct 循环（动态导入：agentRunner 依赖本模块的 CHILD_BLOCKED_TOOLS）
    const runChild = this.runChild ?? (await import('./agentRunner')).runChildAgent;
    if (signal.aborted) throw new Error('任务已被取消'); // 等待导入期间被取消：不再发起任何 LLM 调用
    return runChild(task, signal, onProgress);
  }

  private completeExecution(execution: TaskExecution, result: string): void {
    const taskId = execution.taskId;
    dbUpdateTask(taskId, {
      status: 'completed',
      result,
      error: null,
      progress: 1,
      progress_text: '已完成',
      completed_at: Date.now(),
    });
    const completedTask = dbGetTask(taskId)!;
    this.settleExecution(execution, completedTask);
    this.emit('task:completed', completedTask);
    console.log(`[TaskManager] 任务完成: ${completedTask.title} (${taskId})`);
  }

  private handleFailure(
    execution: TaskExecution,
    failure: TaskFailure,
    attempt: number,
    maxAttempts: number,
  ): void {
    if (failure.kind === 'transient' && attempt < maxAttempts) {
      this.scheduleRetry(execution, failure, attempt, maxAttempts);
      return;
    }
    this.recordFailure(execution, failure);
  }

  private scheduleRetry(
    execution: TaskExecution,
    failure: TaskFailure,
    attempt: number,
    maxAttempts: number,
  ): void {
    const delayMs = Math.min(MAX_RETRY_DELAY_MS, this.retryBaseDelayMs * 2 ** (attempt - 1));
    execution.state = 'retry_wait';
    dbUpdateTask(execution.taskId, {
      status: 'pending',
      error: failure.message,
      progress_text: `第 ${attempt}/${maxAttempts} 次尝试失败（${preview(failure.message, 80)}），${Math.ceil(delayMs / 1000)}s 后重试`,
    });
    const task = dbGetTask(execution.taskId);
    if (task) this.emit('task:retrying', task);
    console.warn(`[TaskManager] 任务 ${execution.taskId} 临时故障，${delayMs}ms 后第 ${attempt + 1} 次尝试: ${failure.message}`);

    execution.retryTimer = setTimeout(() => {
      execution.retryTimer = undefined;
      if (this.executions.get(execution.taskId) !== execution || execution.termination) return;
      if (execution.lane === 'worker') {
        this.enqueue(execution);
        this.pump();
      } else {
        void this.runExecution(execution);
      }
    }, delayMs);
  }

  private recordFailure(execution: TaskExecution, failure: TaskFailure): void {
    const taskId = execution.taskId;
    const meta = parseTaskMetadata(dbGetTask(taskId)?.metadata ?? null);
    dbUpdateTask(taskId, {
      status: 'failed',
      error: failure.message,
      completed_at: Date.now(),
      metadata: JSON.stringify({ ...meta, failureKind: failure.kind }),
    });
    const failedTask = dbGetTask(taskId);
    this.settleExecution(execution, failedTask);
    if (!failedTask) return;
    traceTaskTerminal(failedTask, 'child-task-error', failure.message);
    this.emit('task:failed', failedTask);
    console.error(`[TaskManager] 任务失败: ${failedTask.title} — ${failure.message}`);
  }

  private finalizeExecution(execution: TaskExecution, termination: TaskTerminationRequest): void {
    const taskId = execution.taskId;
    const completedAt = Date.now();
    if (termination.status === 'failed') {
      const error = termination.error ?? 'Task failed';
      dbUpdateTask(taskId, { status: 'failed', error, completed_at: completedAt });
      const failedTask = dbGetTask(taskId);
      this.settleExecution(execution, failedTask);
      if (failedTask) {
        traceTaskTerminal(failedTask, 'child-task-error', error);
        this.emit('task:failed', failedTask);
      }
      return;
    }

    dbUpdateTask(taskId, {
      status: 'cancelled',
      progress_text: termination.reason ?? null,
      completed_at: completedAt,
    });
    const cancelledTask = dbGetTask(taskId);
    this.settleExecution(execution, cancelledTask);
    if (cancelledTask) {
      traceTaskTerminal(cancelledTask, 'child-task-cancelled');
      this.emit('task:cancelled', cancelledTask);
    }
  }

  private settleExecution(execution: TaskExecution, task: DBTask | null): void {
    if (execution.retryTimer) clearTimeout(execution.retryTimer);
    if (this.executions.get(execution.taskId) === execution) this.executions.delete(execution.taskId);
    execution.resolveSettled(task);
  }

  private activeExecution(taskId: string): TaskExecution | undefined {
    const task = dbGetTask(taskId);
    if (!task || (task.status !== 'pending' && task.status !== 'running')) return undefined;
    return this.executions.get(taskId);
  }

  /** 执行中的任务发中断信号；排队中 / 等待重试的任务直接终结 */
  private interrupt(execution: TaskExecution): void {
    if (execution.state === 'running') {
      execution.abort.abort();
      return;
    }
    this.removeFromQueue(execution);
    this.finalizeExecution(execution, execution.termination ?? { status: 'cancelled' });
  }

  // ── 内部：worker 池 ─────────────────────────────────────

  /** 同步把空闲槽位分配给就绪任务：先占位再启动，保证占用数不超过上限 */
  private pump(): void {
    while (this.activeWorkers.size < this.maxWorkers) {
      const next = this.dequeue();
      if (!next) return;
      this.activeWorkers.add(next.taskId);
      void this.runExecution(next);
    }
  }

  private enqueue(execution: TaskExecution): void {
    execution.state = 'queued';
    let queue = this.readyQueues.get(execution.groupKey);
    if (!queue) {
      queue = [];
      this.readyQueues.set(execution.groupKey, queue);
      this.readyRotation.push(execution.groupKey);
    }
    queue.push(execution);
  }

  /** 分组轮转出队：每次从下一个分组取一个任务 */
  private dequeue(): TaskExecution | undefined {
    while (this.readyRotation.length > 0) {
      const groupKey = this.readyRotation.shift()!;
      const queue = this.readyQueues.get(groupKey);
      const next = queue?.shift();
      if (queue && queue.length > 0) this.readyRotation.push(groupKey);
      else this.readyQueues.delete(groupKey);
      if (next) return next;
    }
    return undefined;
  }

  private removeFromQueue(execution: TaskExecution): void {
    const queue = this.readyQueues.get(execution.groupKey);
    if (!queue) return;
    const index = queue.indexOf(execution);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) {
      this.readyQueues.delete(execution.groupKey);
      this.readyRotation = this.readyRotation.filter((key) => key !== execution.groupKey);
    }
  }
}

// ── 工具函数 ──────────────────────────────────────────────

function laneOf(task: DBTask): TaskLane {
  if (task.type === 'batch') return 'orchestrator';
  // slot 专属任务（如 Minecraft 目标）由各自控制器保证单实例，不与后台任务抢槽位
  if (parseTaskMetadata(task.metadata).slotKey) return 'dedicated';
  return 'worker';
}

function classifyFailure(error: unknown, timedOut: boolean, timeoutMs?: number): TaskFailure {
  if (timedOut) {
    return { kind: 'transient', message: `单次执行超时（超过 ${Math.round((timeoutMs ?? 0) / 1000)}s）` };
  }
  if (error instanceof LLMRequestError) {
    return {
      kind: error.fatal ? 'fatal' : error.retryable ? 'transient' : 'task',
      message: error.message,
    };
  }
  return { kind: 'task', message: errorMessage(error) };
}

function resetForRetry(task: DBTask): void {
  const meta = parseTaskMetadata(task.metadata);
  delete meta.failureKind;
  dbUpdateTask(task.id, {
    status: 'pending',
    result: null,
    error: null,
    progress: 0,
    progress_text: '等待重试',
    started_at: null,
    completed_at: null,
    metadata: JSON.stringify({ ...meta, attempt: 0 }),
  });
}

function normalizeMaxAttempts(value: unknown): number {
  const attempts = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 1;
  return Math.min(MAX_TASK_ATTEMPTS, Math.max(1, attempts));
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

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

// ── 单例导出 ──────────────────────────────────────────────

export const taskManager = new TaskManager();
