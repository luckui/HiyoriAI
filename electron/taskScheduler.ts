/**
 * TaskScheduler — 定时任务调度器
 *
 * 职责：
 *   1. 每 60 秒 tick 一次，检查到期的调度任务
 *   2. 到期时通过 TaskManager 创建并启动后台任务
 *   3. 更新调度记录（last_run_at、next_run_at、repeat_count）
 *   4. 一次性任务执行后自动禁用
 *
 * 调度表达式：
 *   - "30m"           → 30 分钟后一次性执行
 *   - "2h"            → 2 小时后一次性执行
 *   - "every 30m"     → 每 30 分钟循环
 *   - "every 2h"      → 每 2 小时循环
 *   - "cron:0 9 * * *" → cron 表达式（需 cron-parser 或手动解析）
 *   - 时间戳           → 指定时间一次性执行
 *
 * 设计原则：
 *   - 简洁：不引入第三方 cron 库，用 setInterval 60s 轮询
 *   - 持久化：调度记录存 SQLite schedules 表，重启后自动恢复
 *   - 安全：tick 内部 try-catch，单个任务失败不影响其他
 */

import {
  getDueSchedules,
  updateSchedule,
  getSchedule,
  listSchedules,
  createSchedule as dbCreateSchedule,
  deleteSchedule as dbDeleteSchedule,
  type DBSchedule,
  type ScheduleType,
} from './db';
import { taskManager } from './taskManager';
import type { ReplyTarget } from './bridges/asyncDelivery';

export type ScheduleKind = 'reminder' | 'agent_task';

export interface ScheduleReminderNotification {
  conversationId: string;
  title: string;
  message: string;
  replyTarget?: ReplyTarget;
}

let scheduleReminderNotifier: ((notification: ScheduleReminderNotification) => void | Promise<void>) | undefined;

export function setScheduleReminderNotifier(
  notifier: ((notification: ScheduleReminderNotification) => void | Promise<void>) | undefined,
): void {
  scheduleReminderNotifier = notifier;
}

function parseScheduleMetadata(metadata: string | null): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function getScheduleKind(meta: Record<string, unknown>): ScheduleKind {
  return meta.kind === 'reminder' ? 'reminder' : 'agent_task';
}

// ── 调度表达式解析 ───────────────────────────────────────

interface ParsedSchedule {
  type: ScheduleType;
  intervalMs?: number;    // interval 类型
  runAt?: number;         // once 类型（时间戳）
  cronExpr?: string;      // cron 类型
}

// ── 轻量 Cron 解析（5 字段：分 时 日 月 周） ────────────

/**
 * 解析单个 cron 字段为数值集合
 *
 * 支持：
 *   *       → 全范围
 *   N       → 单值
 *   N-M     → 范围
 *   N,M,P   → 列表
 *   * /S     → 步长（slash 前可为 * 或范围）
 */
function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    let rangeStr = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;

    let lo: number, hi: number;
    if (rangeStr === '*') {
      lo = min;
      hi = max;
    } else if (rangeStr.includes('-')) {
      const [a, b] = rangeStr.split('-').map(Number);
      lo = a;
      hi = b;
    } else {
      lo = hi = parseInt(rangeStr, 10);
    }

    for (let v = lo; v <= hi; v += step) {
      if (v >= min && v <= max) values.add(v);
    }
  }

  return values;
}

/**
 * 计算 cron 表达式在 after 之后的下一个匹配时间
 *
 * @param cronExpr 5 字段 cron 表达式（分 时 日 月 周）
 * @param after    从此时间戳之后开始搜索（毫秒）
 * @returns 下次匹配的时间戳（毫秒），找不到返回 null
 */
function cronNextRun(cronExpr: string, after: number): number | null {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) {
    console.error(`[TaskScheduler] cron 表达式格式错误（需要5个字段）: "${cronExpr}"`);
    return null;
  }

  const minutes = parseCronField(fields[0], 0, 59);
  const hours   = parseCronField(fields[1], 0, 23);
  const days    = parseCronField(fields[2], 1, 31);
  const months  = parseCronField(fields[3], 1, 12);
  const weekdays = parseCronField(fields[4], 0, 6); // 0=周日

  // 从 after + 1 分钟开始逐分钟搜索（最多搜索 400 天）
  const startDate = new Date(after);
  startDate.setSeconds(0, 0);
  startDate.setMinutes(startDate.getMinutes() + 1); // 下一分钟开始

  const limit = 400 * 24 * 60; // 最多搜索 ~400 天的分钟数
  for (let i = 0; i < limit; i++) {
    const candidate = new Date(startDate.getTime() + i * 60_000);
    const m = candidate.getMinutes();
    const h = candidate.getHours();
    const d = candidate.getDate();
    const mon = candidate.getMonth() + 1; // JS month 0-indexed
    const w = candidate.getDay();          // 0=周日

    if (minutes.has(m) && hours.has(h) && days.has(d) && months.has(mon) && weekdays.has(w)) {
      return candidate.getTime();
    }
  }

  console.warn(`[TaskScheduler] cron 表达式 "${cronExpr}" 在 400 天内无匹配`);
  return null;
}

/**
 * 解析调度表达式
 *
 * 格式：
 *   "30m" / "2h" / "1d"         → 一次性（从现在起）
 *   "every 30m" / "every 2h"    → 循环间隔
 *   "cron:0 9 * * *"            → cron 表达式
 *   数字时间戳                   → 指定时间一次性
 *   ISO 日期字符串               → 指定时间一次性
 */
export function parseScheduleExpr(expr: string): ParsedSchedule {
  const trimmed = expr.trim();
  const lower = trimmed.toLowerCase();

  // "every Xm/Xh/Xd" → interval
  const everyMatch = lower.match(/^every\s+(\d+)\s*(m|min|h|hr|hour|d|day)s?$/);
  if (everyMatch) {
    const value = parseInt(everyMatch[1], 10);
    const unit = everyMatch[2][0]; // m, h, d
    const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
    return { type: 'interval', intervalMs: value * multipliers[unit] };
  }

  // "cron:..." → cron 表达式
  if (lower.startsWith('cron:')) {
    return { type: 'cron', cronExpr: trimmed.slice(5).trim() };
  }

  // 纯数字 → 时间戳
  if (/^\d{13,}$/.test(trimmed)) {
    return { type: 'once', runAt: parseInt(trimmed, 10) };
  }

  // ISO 日期 → 时间戳
  if (/^\d{4}-\d{2}/.test(trimmed)) {
    const ts = new Date(trimmed).getTime();
    if (!isNaN(ts)) return { type: 'once', runAt: ts };
  }

  // "Xm/Xh/Xd" → 一次性（从现在起）
  const durationMatch = lower.match(/^(\d+)\s*(m|min|h|hr|hour|d|day)s?$/);
  if (durationMatch) {
    const value = parseInt(durationMatch[1], 10);
    const unit = durationMatch[2][0];
    const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
    return { type: 'once', runAt: Date.now() + value * multipliers[unit] };
  }

  // "HH:mm" / "HH:MM" → 今天或明天该时刻一次性执行
  const timeMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const h = parseInt(timeMatch[1], 10);
    const m = parseInt(timeMatch[2], 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      const target = new Date();
      target.setHours(h, m, 0, 0);
      // 如果目标时刻已过，推到明天
      if (target.getTime() <= Date.now()) {
        target.setDate(target.getDate() + 1);
      }
      return { type: 'once', runAt: target.getTime() };
    }
  }

  throw new Error(
    `无效的调度表达式: "${expr}"\n` +
    `支持格式：23:20（指定时刻）| 30m, 2h, 1d（延迟）| every 30m（循环）| cron:20 23 * * *（cron）| 2025-07-10T09:00（日期）`
  );
}

/** 计算下次运行时间 */
function computeNextRun(schedule: DBSchedule): number | null {
  const now = Date.now();

  switch (schedule.schedule_type) {
    case 'once':
      // 一次性：已执行过则不再运行
      if (schedule.last_run_at) return null;
      return schedule.run_at;

    case 'interval':
      if (!schedule.interval_ms) return null;
      if (schedule.last_run_at) {
        return schedule.last_run_at + schedule.interval_ms;
      }
      // 首次运行：从创建时间 + 间隔
      return schedule.created_at + schedule.interval_ms;

    case 'cron':
      if (!schedule.cron_expr) return null;
      return cronNextRun(schedule.cron_expr, schedule.last_run_at ?? now);

    default:
      return null;
  }
}

// ── TaskScheduler ────────────────────────────────────────

class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  /** 启动调度器（每 60 秒 tick 一次） */
  start(): void {
    if (this.timer) return;
    console.log('[TaskScheduler] 调度器已启动（60s 轮询）');
    this.timer = setInterval(() => this.tick(), 60_000);
    // 启动时立即检查一次
    this.tick();
  }

  /** 停止调度器 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[TaskScheduler] 调度器已停止');
    }
  }

  /** 手动触发一次检查 */
  async tick(): Promise<void> {
    if (this.ticking) return; // 防止重入
    this.ticking = true;

    try {
      const now = Date.now();
      const dueSchedules = getDueSchedules(now);

      for (const schedule of dueSchedules) {
        try {
          // 检查重复限制
          if (schedule.repeat_limit !== null && schedule.repeat_count >= schedule.repeat_limit) {
            updateSchedule(schedule.id, { enabled: 0 });
            continue;
          }

          const meta = parseScheduleMetadata(schedule.metadata);
          const kind = getScheduleKind(meta);
          const toolsets: string[] = kind === 'agent_task'
            ? (Array.isArray(meta?.toolsets) ? meta.toolsets : ['agent'])
            : [];
          console.log(
            `[TaskScheduler] ▶ 触发定时任务: "${schedule.task_title}" (${schedule.id})\n` +
            `  kind: ${kind}\n` +
            (kind === 'agent_task' ? `  toolsets: [${toolsets.join(', ')}]\n` : '') +
            `  prompt: ${schedule.prompt.length > 120 ? schedule.prompt.slice(0, 120) + '…' : schedule.prompt}`,
          );

          if (kind === 'reminder') {
            const conversationId = typeof meta.conversationId === 'string' ? meta.conversationId : undefined;
            if (conversationId && scheduleReminderNotifier) {
              await scheduleReminderNotifier({
                conversationId,
                title: schedule.task_title,
                message: schedule.prompt,
                replyTarget: meta.replyTarget as ReplyTarget | undefined,
              });
            } else {
              console.warn(`[TaskScheduler] reminder "${schedule.task_title}" has no conversationId or notifier; skipped delivery.`);
            }
          } else {
            taskManager.createAndStart({
              title: schedule.task_title,
              prompt: schedule.prompt,
              conversationId: typeof meta?.conversationId === 'string' ? meta.conversationId : undefined,
              type: 'cron',
              metadata: meta,
            });
          }

          // 更新调度记录
          const newCount = schedule.repeat_count + 1;
          const isLastRun = schedule.repeat_limit !== null && newCount >= schedule.repeat_limit;

          const nextRun = isLastRun ? null : computeNextRun({
            ...schedule,
            last_run_at: now,
            repeat_count: newCount,
          });

          updateSchedule(schedule.id, {
            last_run_at: now,
            repeat_count: newCount,
            next_run_at: nextRun,
            enabled: isLastRun ? 0 : 1,
          });

          if (!isLastRun && nextRun) {
            console.log(`[TaskScheduler] ✔ 已入队，下次执行: ${new Date(nextRun).toLocaleString('zh-CN')}`);
          } else if (isLastRun) {
            console.log(`[TaskScheduler] ✔ 已入队（最后一次，执行后自动禁用）`);
          }
        } catch (err) {
          console.error(`[TaskScheduler] 执行调度任务失败: ${schedule.id}`, err);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  // ── 对外 API（供 schedule_task 工具调用） ───────────────

  /** 创建调度任务 */
  createSchedule(opts: {
    title: string;
    prompt: string;
    schedule: string;
    repeatLimit?: number;
    metadata?: Record<string, unknown>;
  }): DBSchedule {
    const parsed = parseScheduleExpr(opts.schedule);

    const sched = dbCreateSchedule({
      task_title: opts.title,
      prompt: opts.prompt,
      schedule_type: parsed.type,
      cron_expr: parsed.cronExpr ?? null,
      interval_ms: parsed.intervalMs ?? null,
      run_at: parsed.runAt ?? null,
      enabled: 1,
      next_run_at: parsed.type === 'once'
        ? parsed.runAt ?? null
        : parsed.type === 'interval'
          ? Date.now() + (parsed.intervalMs ?? 0)
          : parsed.type === 'cron' && parsed.cronExpr
            ? cronNextRun(parsed.cronExpr, Date.now())
            : null,
      repeat_limit: opts.repeatLimit ?? (parsed.type === 'once' ? 1 : null),
      metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
    });

    return sched;
  }

  /** 列出所有调度 */
  listSchedules(enabledOnly = false): DBSchedule[] {
    return listSchedules(enabledOnly);
  }

  /** 暂停调度 */
  pauseSchedule(scheduleId: string): boolean {
    const s = getSchedule(scheduleId);
    if (!s) return false;
    updateSchedule(scheduleId, { enabled: 0 });
    return true;
  }

  /** 恢复调度 */
  resumeSchedule(scheduleId: string): boolean {
    const s = getSchedule(scheduleId);
    if (!s) return false;

    // 重新计算下次运行时间
    const nextRun = computeNextRun({ ...s, enabled: 1 });
    updateSchedule(scheduleId, { enabled: 1, next_run_at: nextRun });
    return true;
  }

  /** 删除调度 */
  removeSchedule(scheduleId: string): boolean {
    const s = getSchedule(scheduleId);
    if (!s) return false;
    dbDeleteSchedule(scheduleId);
    return true;
  }

  /** 立即触发一次 */
  triggerNow(scheduleId: string): boolean {
    const s = getSchedule(scheduleId);
    if (!s) return false;

    const triggerMeta = parseScheduleMetadata(s.metadata);
    if (getScheduleKind(triggerMeta) === 'reminder') {
      const conversationId = typeof triggerMeta.conversationId === 'string' ? triggerMeta.conversationId : undefined;
      if (conversationId && scheduleReminderNotifier) {
        void scheduleReminderNotifier({
          conversationId,
          title: s.task_title,
          message: s.prompt,
          replyTarget: triggerMeta.replyTarget as ReplyTarget | undefined,
        });
      }
    } else {
      taskManager.createAndStart({
        title: s.task_title,
        prompt: s.prompt,
        conversationId: typeof triggerMeta?.conversationId === 'string' ? triggerMeta.conversationId : undefined,
        type: 'cron',
        metadata: triggerMeta,
      });
    }

    updateSchedule(scheduleId, { last_run_at: Date.now() });
    return true;
  }
}

// ── 单例导出 ──────────────────────────────────────────────

export const taskScheduler = new TaskScheduler();
