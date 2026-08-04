import { beforeEach, describe, expect, it, vi } from 'vitest';

const createSchedule = vi.fn();

vi.mock('../../../taskScheduler', () => ({
  taskScheduler: {
    createSchedule,
    listSchedules: vi.fn(() => []),
    pauseSchedule: vi.fn(),
    resumeSchedule: vi.fn(),
    removeSchedule: vi.fn(),
    triggerNow: vi.fn(),
  },
}));

vi.mock('../../../bridges/asyncDelivery', () => ({
  getReplyTargetForConversation: vi.fn(() => ({ kind: 'desktop' })),
}));

const { default: scheduleTaskTool } = await import('../scheduleTask');

describe('schedule_task tool contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createSchedule.mockReturnValue({
      id: 'schedule-1',
      task_title: '提醒工作',
      next_run_at: new Date('2026-07-20T20:26:00+08:00').getTime(),
      schedule_type: 'once',
    });
  });

  it('requires reminder schedules to use an instruction for Hiyori', () => {
    const result = scheduleTaskTool.execute({
      action: 'create',
      kind: 'reminder',
      title: '提醒工作',
      message: '20:26 到啦，该开始工作了。',
      schedule: '20:26',
    }, { conversationId: 'conv-1' });

    expect(String(result)).toContain('缺少 instruction');
    expect(createSchedule).not.toHaveBeenCalled();
  });

  it('stores reminder instruction as the scheduled wakeup prompt', () => {
    const result = scheduleTaskTool.execute({
      action: 'create',
      kind: 'reminder',
      title: '提醒工作',
      instruction: '请提醒用户该开始工作了。',
      schedule: '20:26',
    }, { conversationId: 'conv-1' });

    expect(createSchedule).toHaveBeenCalledWith(expect.objectContaining({
      title: '提醒工作',
      prompt: '请提醒用户该开始工作了。',
      schedule: '20:26',
      metadata: expect.objectContaining({
        kind: 'reminder',
        conversationId: 'conv-1',
      }),
    }));
    expect(String(result)).toContain('定时提醒已创建');
  });

  it('rejects prompt/toolsets for reminder schedules', () => {
    const result = scheduleTaskTool.execute({
      action: 'create',
      kind: 'reminder',
      title: '提醒工作',
      instruction: '请提醒用户该开始工作了。',
      prompt: '后台执行提醒任务',
      schedule: '20:26',
    }, { conversationId: 'conv-1' });

    expect(String(result)).toContain('kind="reminder" 不使用 prompt');
    expect(createSchedule).not.toHaveBeenCalled();
  });

  it('requires agent task schedules to use prompt instead of message', () => {
    const result = scheduleTaskTool.execute({
      action: 'create',
      kind: 'agent_task',
      title: '检查数据',
      message: '检查一下数据',
      schedule: '20:26',
    }, { conversationId: 'conv-1' });

    expect(String(result)).toContain('缺少 prompt');
    expect(createSchedule).not.toHaveBeenCalled();
  });
});
