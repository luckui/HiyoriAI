import { beforeEach, describe, expect, it, vi } from 'vitest';

const getDueSchedules = vi.fn();
const updateSchedule = vi.fn();
const createAndStart = vi.fn();

vi.mock('../db', () => ({
  getDueSchedules,
  updateSchedule,
  getSchedule: vi.fn(),
  listSchedules: vi.fn(() => []),
  createSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
}));

vi.mock('../taskManager', () => ({
  taskManager: {
    createAndStart,
  },
}));

const { taskScheduler, setScheduleReminderNotifier } = await import('../taskScheduler');

function dueSchedule(metadata: Record<string, unknown>, prompt = '请提醒用户该开始工作了。') {
  return {
    id: 'schedule-1',
    task_title: '20:26工作提醒',
    prompt,
    schedule_type: 'once',
    cron_expr: null,
    interval_ms: null,
    run_at: Date.now() - 1000,
    enabled: 1,
    last_run_at: null,
    next_run_at: Date.now() - 1000,
    repeat_limit: 1,
    repeat_count: 0,
    created_at: Date.now() - 60_000,
    metadata: JSON.stringify(metadata),
  };
}

describe('task scheduler reminders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setScheduleReminderNotifier(undefined);
  });

  it('wakes the main conversation for reminder schedules without starting a child agent', async () => {
    const notify = vi.fn();
    setScheduleReminderNotifier(notify);
    getDueSchedules.mockReturnValue([
      dueSchedule({
        kind: 'reminder',
        conversationId: 'conv-1',
        replyTarget: { kind: 'discord', channelId: 'channel-1' },
      }),
    ]);

    await taskScheduler.tick();

    expect(createAndStart).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      title: '20:26工作提醒',
      instruction: '请提醒用户该开始工作了。',
      replyTarget: { kind: 'discord', channelId: 'channel-1' },
    });
    expect(updateSchedule).toHaveBeenCalledWith('schedule-1', expect.objectContaining({
      repeat_count: 1,
      enabled: 0,
    }));
  });

  it('starts a child agent for agent task schedules', async () => {
    getDueSchedules.mockReturnValue([
      dueSchedule({
        kind: 'agent_task',
        conversationId: 'conv-2',
        toolsets: ['agent-debug'],
      }, '运行粉丝数统计脚本并记录结果。'),
    ]);

    await taskScheduler.tick();

    expect(createAndStart).toHaveBeenCalledWith(expect.objectContaining({
      title: '20:26工作提醒',
      prompt: '运行粉丝数统计脚本并记录结果。',
      conversationId: 'conv-2',
      type: 'cron',
      metadata: expect.objectContaining({ kind: 'agent_task' }),
    }));
  });
});
