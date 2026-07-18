import { describe, expect, it } from 'vitest';
import codingAgentTool, { resolveSendSessionDecision } from '../codingAgent';

describe('coding_agent tool', () => {
  it('auto-resumes the only Codex session candidate for a project directory', async () => {
    const decision = await resolveSendSessionDecision(
      {
        action: 'send',
        task: 'continue work',
        cwd: 'D:/repo',
      },
      async () => [{ id: 'thread-one', cwd: 'D:/repo', file: 'session.jsonl', updatedAt: 1 }]
    );

    expect(decision.resumeSessionId).toBe('thread-one');
    expect(decision.resumedNotice).toContain('thread-one');
  });

  it('returns a user-choice contract when multiple Codex sessions match a project directory', async () => {
    const decision = await resolveSendSessionDecision(
      {
        action: 'send',
        task: 'continue work',
        cwd: 'D:/repo',
      },
      async () => [
        { id: 'thread-newer', cwd: 'D:/repo', file: 'newer.jsonl', updatedAt: 2 },
        { id: 'thread-older', cwd: 'D:/repo', file: 'older.jsonl', updatedAt: 1 },
      ]
    );

    expect(decision.userMessage).toContain('【工具结果】');
    expect(decision.userMessage).toContain('状态：需要用户选择');
    expect(decision.userMessage).toContain('下一步：询问用户');
    expect(decision.userMessage).toContain('建议回复：');
    expect(decision.userMessage).toContain('thread-newer');
    expect(decision.userMessage).toContain('thread-older');
    expect(decision.userMessage).not.toContain('coding_agent(');
    expect(decision.userMessage).not.toContain('action="start"');
    expect(decision.resumeSessionId).toBeUndefined();
  });

  it('does not search Codex sessions when a resume id is explicit', async () => {
    let called = false;
    const decision = await resolveSendSessionDecision(
      {
        action: 'send',
        task: 'continue work',
        cwd: 'D:/repo',
        resume_session_id: 'explicit-thread',
      },
      async () => {
        called = true;
        return [];
      }
    );

    expect(called).toBe(false);
    expect(decision).toEqual({});
  });

  it('returns a reply contract after sending a coding-agent task', async () => {
    const result = await codingAgentTool.execute(
      {
        action: 'send',
        agent: 'fake',
        task: 'fix the build',
        cwd: 'D:/repo',
      },
      { conversationId: 'coding-tool-send' }
    );

    expect(String(result)).toContain('【工具结果】');
    expect(String(result)).toContain('状态：已提交');
    expect(String(result)).toContain('下一步：回复用户');
    expect(String(result)).toContain('建议回复：');
    expect(String(result)).toContain('已交给 Fake Runtime');
    expect(String(result)).toContain('完成后系统会通知我');
  });

  it('send reuses the active project session and status returns a reply contract', async () => {
    await codingAgentTool.execute(
      {
        action: 'send',
        agent: 'fake',
        task: 'fix the build',
        cwd: 'D:/repo',
      },
      { conversationId: 'coding-tool-continue' }
    );

    const continued = await codingAgentTool.execute(
      {
        action: 'send',
        agent: 'fake',
        task: 'continue',
        cwd: 'D:/repo',
      },
      { conversationId: 'coding-tool-continue' }
    );
    const status = await codingAgentTool.execute(
      {
        action: 'status',
        cwd: 'D:/repo',
      },
      { conversationId: 'coding-tool-continue' }
    );

    expect(String(continued)).toContain('状态：已提交');
    expect(String(continued)).toContain('已发送给 Fake Runtime');
    expect(String(status)).toContain('状态：已查询');
    expect(String(status)).toContain('下一步：回复用户');
    expect(String(status)).toContain('fake received: continue');
  });

  it('does not expose legacy start continue or result actions to the model schema', () => {
    const action = codingAgentTool.schema.function.parameters.properties.action;
    expect(action.enum).toEqual(['send', 'status', 'sessions', 'stop']);
  });

  it('does not expose Codex minimal reasoning effort because hosted tools reject it', () => {
    const reasoningEffort = codingAgentTool.schema.function.parameters.properties.reasoning_effort;
    expect(reasoningEffort.enum).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('starts a new session through send without requiring a runtime session id', async () => {
    const result = await codingAgentTool.execute(
      {
        action: 'send',
        agent: 'fake',
        task: 'continue',
      },
      { conversationId: 'coding-tool-missing' }
    );

    expect(String(result)).toContain('已交给 Fake Runtime');
  });
});
