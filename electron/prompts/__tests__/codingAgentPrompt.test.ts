import { describe, expect, it } from 'vitest';
import { buildAgentPrompt } from '../agent';
import { buildDeveloperPrompt } from '../developer';

describe('coding agent prompt contract', () => {
  it('teaches agent mode the generic tool-result next-step contract', () => {
    const prompt = buildAgentPrompt();

    expect(prompt).toContain('【工具结果规范】');
    expect(prompt).toContain('下一步：回复用户');
    expect(prompt).toContain('下一步：询问用户');
    expect(prompt).toContain('下一步：继续执行');
    expect(prompt).toContain('然后结束本轮');
    expect(prompt).toContain('不要自行选择，也不要继续调用工具');
    expect(prompt).toContain('coding_agent(action="send"');
    expect(prompt).toContain('send 是异步提交');
    expect(prompt).toContain('异步结果通知');
    expect(prompt).toContain('terminal block');
    expect(prompt).toContain('unattended with high autonomy');
    expect(prompt).toContain('Windows sandbox popups must be avoided');
    expect(prompt).not.toContain('action="start"');
    expect(prompt).not.toContain('action="continue"');
    expect(prompt).not.toContain('status/result');
    expect(prompt).not.toContain('Skill 暂停');
    expect(prompt).not.toContain('Skill 继续');
    expect(prompt).not.toContain('必须立刻调用');
  });

  it('teaches developer mode the same tool-result contract', () => {
    const prompt = buildDeveloperPrompt();

    expect(prompt).toContain('【工具结果规范】');
    expect(prompt).toContain('下一步：回复用户');
    expect(prompt).toContain('下一步：询问用户');
    expect(prompt).toContain('下一步：继续执行');
    expect(prompt).toContain('然后结束本轮');
    expect(prompt).toContain('不要自行选择，也不要继续调用工具');
    expect(prompt).toContain('coding_agent(action="send"');
    expect(prompt).toContain('send 是异步提交');
    expect(prompt).toContain('异步结果通知');
    expect(prompt).toContain('runtime_start');
    expect(prompt).toContain('unattended with high autonomy');
    expect(prompt).toContain('Windows sandbox popups must be avoided');
    expect(prompt).not.toContain('action="start"');
    expect(prompt).not.toContain('action="continue"');
    expect(prompt).not.toContain('status/result');
    expect(prompt).not.toContain('Skill 暂停');
    expect(prompt).not.toContain('Skill 继续');
    expect(prompt).not.toContain('必须立刻调用');
  });
});
