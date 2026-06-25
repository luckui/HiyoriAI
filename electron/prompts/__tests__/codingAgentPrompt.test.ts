import { describe, expect, it } from 'vitest';
import { buildAgentPrompt } from '../agent';
import { buildDeveloperPrompt } from '../developer';

describe('coding agent prompt contract', () => {
  it('teaches agent mode to route Codex requests through coding_agent', () => {
    const prompt = buildAgentPrompt();

    expect(prompt).toContain('coding_agent');
    expect(prompt).toContain('Codex');
    expect(prompt).toContain('编程代理');
    expect(prompt).toContain('进展和结果');
    expect(prompt).toContain('不要让用户提供 runtime');
  });

  it('teaches developer mode to use coding_agent instead of raw runtime tools', () => {
    const prompt = buildDeveloperPrompt();

    expect(prompt).toContain('coding_agent');
    expect(prompt).toContain('Codex');
    expect(prompt).toContain('不要向用户暴露 runtime_start');
  });
});
