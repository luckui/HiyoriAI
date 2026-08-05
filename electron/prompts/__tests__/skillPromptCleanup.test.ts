import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../base-rules';
import { buildAgentPrompt } from '../agent';
import { buildDeveloperPrompt } from '../developer';
import { buildStreamerPrompt } from '../streamer';

describe('skill prompt cleanup', () => {
  it('does not expose legacy manual workflow in user-facing prompts', () => {
    const prompts = [
      buildSystemPrompt(),
      buildAgentPrompt(),
      buildDeveloperPrompt(),
      buildStreamerPrompt(),
    ];

    for (const prompt of prompts) {
      expect(prompt).not.toContain('read_manual');
      expect(prompt).not.toContain('manual_manage');
      expect(prompt).not.toContain('说明书');
      expect(prompt).not.toContain('硬性门槛');
      expect(prompt).not.toContain('前两个工具调用');
      expect(prompt).not.toContain('plan → manual');
    }
  });

  it('describes skills as optional progressive guidance, not a forced repair path', () => {
    const prompt = buildDeveloperPrompt();

    expect(prompt).toContain('read_skill');
    expect(prompt).toContain('需要特定工作流或用户明确要求按技能执行时');
    expect(prompt).toContain('不要把读取技能当作每个任务的固定前置步骤');
    expect(prompt).not.toContain('必须 read');
    expect(prompt).not.toContain('宁多查不少查');
  });
});
