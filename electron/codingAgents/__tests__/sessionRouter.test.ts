import { describe, expect, it } from 'vitest';
import { CodingAgentSessionRouter } from '../sessionRouter';
import { createFakeRuntimeProvider } from '../../runtimes/providers/fake';
import { RuntimeHost } from '../../runtimes/runtimeHost';
import { RuntimeRegistry } from '../../runtimes/runtimeRegistry';
import { TranscriptMirror } from '../../runtimes/transcriptMirror';

function createRouter() {
  const registry = new RuntimeRegistry();
  registry.register(createFakeRuntimeProvider());
  const mirror = new TranscriptMirror();
  const host = new RuntimeHost(registry, mirror);
  return { router: new CodingAgentSessionRouter(host), host };
}

describe('CodingAgentSessionRouter', () => {
  it('starts a coding agent session and binds it to the conversation', async () => {
    const { router, host } = createRouter();

    const result = await router.start({
      conversationId: 'conv-1',
      agent: 'fake',
      task: 'fix the build',
      cwd: 'D:/repo',
    });

    expect(result.kind).toBe('started');
    expect(result.userMessage).toContain('Fake Runtime');
    expect(result.sessionId).toBeTruthy();
    expect(host.getSession(result.sessionId)?.hiyoriConversationId).toBe('conv-1');
  });

  it('continues the active session without exposing runtime ids to the caller', async () => {
    const { router } = createRouter();
    await router.start({
      conversationId: 'conv-1',
      agent: 'fake',
      task: 'fix the build',
    });

    const result = await router.continue({
      conversationId: 'conv-1',
      message: 'continue',
    });

    expect(result.kind).toBe('continued');
    expect(result.userMessage).toContain('已发送');
  });

  it('pushes assistant responses to the configured notifier', async () => {
    const { router } = createRouter();
    const delivered: string[] = [];
    router.setNotifier((_conversationId, content) => {
      delivered.push(content);
    });
    await router.start({
      conversationId: 'conv-push',
      agent: 'fake',
      task: 'fix the build',
    });

    await router.continue({
      conversationId: 'conv-push',
      message: 'continue',
    });

    expect(delivered.some((message) => message.includes('fake received: continue'))).toBe(true);
  });

  it('does not push low-level command details to the chat notifier', async () => {
    const registry = new RuntimeRegistry();
    registry.register({
      id: 'detail',
      displayName: 'Detail Runtime',
      async checkAvailability() {
        return { available: true };
      },
      async startSession(input) {
        const session = {
          id: 'detail-session',
          providerId: 'detail',
          providerSessionRef: 'detail-native',
          hiyoriConversationId: input.hiyoriConversationId,
          title: input.title,
          status: 'running' as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          metadata: {},
        };
        return session;
      },
      async resumeSession() {
        throw new Error('not used');
      },
      async sendMessage() {},
      async interrupt() {},
      async stop() {},
      subscribe(_sessionId, onEvent) {
        setTimeout(() => {
          onEvent({
            id: 'tool-call-1',
            sessionId: 'detail-session',
            providerId: 'detail',
            type: 'tool_call',
            content: 'powershell.exe -Command Get-Content secret-command',
            createdAt: Date.now(),
          });
        }, 0);
        return { unsubscribe() {} };
      },
    });
    const host = new RuntimeHost(registry, new TranscriptMirror());
    const router = new CodingAgentSessionRouter(host);
    const delivered: string[] = [];
    router.setNotifier((_conversationId, content) => delivered.push(content));

    await router.start({
      conversationId: 'conv-detail',
      agent: 'detail',
      task: 'inspect',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(delivered.join('\n')).not.toContain('powershell.exe');

    const status = await router.status({ conversationId: 'conv-detail' });
    expect(status.userMessage).not.toContain('powershell.exe');
  });

  it('reports visible status from the active session transcript', async () => {
    const { router } = createRouter();
    await router.start({
      conversationId: 'conv-1',
      agent: 'fake',
      task: 'fix the build',
    });
    await router.continue({ conversationId: 'conv-1', message: 'continue' });

    const result = await router.status({ conversationId: 'conv-1' });

    expect(result.kind).toBe('status');
    expect(result.userMessage).toContain('Fake Runtime');
    expect(result.userMessage).toContain('fake received: continue');
  });

  it('explains when the coding agent has not produced a visible response yet', async () => {
    const { router, host } = createRouter();
    const started = await router.start({
      conversationId: 'conv-waiting',
      agent: 'fake',
      task: 'fix the build',
    });
    const session = host.getSession(started.sessionId);
    if (!session) throw new Error('missing session');

    const result = await router.status({ conversationId: 'conv-waiting' });

    expect(result.userMessage).toContain('尚未收到');
  });

  it('stops the active session', async () => {
    const { router } = createRouter();
    await router.start({
      conversationId: 'conv-1',
      agent: 'fake',
      task: 'fix the build',
    });

    const result = await router.stop({ conversationId: 'conv-1' });

    expect(result.kind).toBe('stopped');
    expect(result.userMessage).toContain('已停止');
  });

  it('asks for context when no active session exists', async () => {
    const { router } = createRouter();

    const result = await router.continue({
      conversationId: 'conv-1',
      message: 'continue',
    });

    expect(result.kind).toBe('missing_session');
    expect(result.userMessage).toContain('没有正在进行');
  });
});
