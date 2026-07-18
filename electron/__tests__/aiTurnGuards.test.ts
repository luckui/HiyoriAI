import { describe, expect, it } from 'vitest';
import {
  isAsyncResultNotification,
  shouldApplyActionCorrection,
  shouldApplyTaskIntentNudge,
} from '../aiTurnGuards';

describe('AI turn guard rules', () => {
  const codingAgentWakeup = [
    '【异步结果通知】',
    '来源：Codex 编程代理',
    '状态：已完成',
    '下一步：回复用户',
    '任务：连通性测试',
    '',
    '结果：',
    'Hi',
  ].join('\n');

  it('recognizes async result notifications', () => {
    expect(isAsyncResultNotification(codingAgentWakeup)).toBe(true);
    expect(isAsyncResultNotification('请帮我打开浏览器')).toBe(false);
  });

  it('does not apply task intent nudges to async result notifications', () => {
    expect(shouldApplyTaskIntentNudge(codingAgentWakeup)).toBe(false);
    expect(shouldApplyTaskIntentNudge('请帮我打开浏览器')).toBe(true);
  });

  it('does not apply no-tool action correction to async result notifications', () => {
    expect(shouldApplyActionCorrection(codingAgentWakeup)).toBe(false);
    expect(shouldApplyActionCorrection('请帮我打开浏览器')).toBe(true);
  });
});
