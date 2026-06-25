import { describe, expect, it } from 'vitest';
import codingAgentTool from '../codingAgent';

describe('coding_agent tool', () => {
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
