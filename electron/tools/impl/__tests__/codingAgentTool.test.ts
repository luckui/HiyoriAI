import { describe, expect, it } from 'vitest';
import codingAgentTool, { resolveStartSessionDecision } from '../codingAgent';

describe('coding_agent tool', () => {
  it('auto-resumes the only Codex session candidate for a project directory', async () => {
    const decision = await resolveStartSessionDecision(
      {
        action: 'start',
        task: 'continue work',
        cwd: 'D:/repo',
      },
      async () => [{ id: 'thread-one', cwd: 'D:/repo', file: 'session.jsonl', updatedAt: 1 }]
    );

    expect(decision.resumeSessionId).toBe('thread-one');
    expect(decision.resumedNotice).toContain('thread-one');
  });

  it('asks the user to choose when multiple Codex sessions match a project directory', async () => {
    const decision = await resolveStartSessionDecision(
      {
        action: 'start',
        task: 'continue work',
        cwd: 'D:/repo',
      },
      async () => [
        { id: 'thread-newer', cwd: 'D:/repo', file: 'newer.jsonl', updatedAt: 2 },
        { id: 'thread-older', cwd: 'D:/repo', file: 'older.jsonl', updatedAt: 1 },
      ]
    );

    expect(decision.userMessage).toContain('找到多个可恢复的 Codex 会话');
    expect(decision.userMessage).toContain('thread-newer');
    expect(decision.userMessage).toContain('thread-older');
    expect(decision.resumeSessionId).toBeUndefined();
  });

  it('does not search Codex sessions when a resume id is explicit', async () => {
    let called = false;
    const decision = await resolveStartSessionDecision(
      {
        action: 'start',
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

  it('starts a Codex task from user-facing parameters', async () => {
    const result = await codingAgentTool.execute(
      {
        action: 'start',
        agent: 'fake',
        task: 'fix the build',
        cwd: 'D:/repo',
      },
      { conversationId: 'coding-tool-start' }
    );

    expect(String(result)).toContain('已交给 Fake Runtime');
  });

  it('continues and reports status for the active task', async () => {
    await codingAgentTool.execute(
      {
        action: 'start',
        agent: 'fake',
        task: 'fix the build',
      },
      { conversationId: 'coding-tool-continue' }
    );

    const continued = await codingAgentTool.execute(
      {
        action: 'continue',
        message: 'continue',
      },
      { conversationId: 'coding-tool-continue' }
    );
    const status = await codingAgentTool.execute(
      {
        action: 'status',
      },
      { conversationId: 'coding-tool-continue' }
    );

    expect(String(continued)).toContain('已发送给 Fake Runtime');
    expect(String(status)).toContain('fake received: continue');
  });

  it('treats result as a user-facing status alias', async () => {
    await codingAgentTool.execute(
      {
        action: 'start',
        agent: 'fake',
        task: 'fix the build',
      },
      { conversationId: 'coding-tool-result' }
    );
    await codingAgentTool.execute(
      {
        action: 'continue',
        message: 'continue',
      },
      { conversationId: 'coding-tool-result' }
    );

    const result = await codingAgentTool.execute(
      {
        action: 'result',
      },
      { conversationId: 'coding-tool-result' }
    );

    expect(String(result)).toContain('fake received: continue');
  });


  it('does not require users to provide a runtime session id', async () => {
    const result = await codingAgentTool.execute(
      {
        action: 'continue',
        message: 'continue',
      },
      { conversationId: 'coding-tool-missing' }
    );

    expect(String(result)).toContain('当前没有正在进行');
  });
});
