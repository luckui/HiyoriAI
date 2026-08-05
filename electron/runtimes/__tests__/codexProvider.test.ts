import { describe, expect, it } from 'vitest';
import { createCodexAppServerEnv, createCodexRuntimeProvider } from '../providers/codex';
import type { RuntimeEvent } from '../types';
import type { CodexJsonRpcNotification } from '../providers/codexAppServerClient';

function createFakeAppServer() {
  const requests: Array<{ method: string; params: any }> = [];
  const listeners = new Set<(notification: CodexJsonRpcNotification) => void>();
  const thread = {
    id: 'thread-existing',
    cwd: 'D:/repo',
    name: 'Codex Work',
    status: { type: 'idle' },
  };
  return {
    appServer: {
      async start() {},
      async request(method: string, params?: any) {
        requests.push({ method, params });
        if (method === 'thread/start') return { thread };
        if (method === 'thread/resume') return { thread: { ...thread, id: params.threadId } };
        if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'running', items: [] } };
        if (method === 'turn/interrupt') return {};
        throw new Error(`Unexpected method: ${method}`);
      },
      onNotification(listener: (notification: CodexJsonRpcNotification) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    requests,
    emit(notification: CodexJsonRpcNotification) {
      for (const listener of listeners) listener(notification);
    },
  };
}

async function waitForEvents(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createCodexRuntimeProvider', () => {
  it('is unavailable when the app-server cannot be created', async () => {
    const provider = createCodexRuntimeProvider({
      createClient() {
        throw new Error('missing codex');
      },
    });

    await expect(provider.checkAvailability()).resolves.toEqual({
      available: false,
      reason: 'missing codex',
    });
  });

  it('starts a Codex thread through app-server and maps notifications', async () => {
    const fake = createFakeAppServer();
    const provider = createCodexRuntimeProvider({ createClient: () => fake.appServer });
    const seen: RuntimeEvent[] = [];

    const session = await provider.startSession({
      providerId: 'codex',
      hiyoriConversationId: 'conv-1',
      title: 'Fallback Title',
      initialMessage: 'fix tests',
      cwd: 'D:/repo',
      metadata: {
        model: 'gpt-5.1-codex',
        modelReasoningEffort: 'high',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
      },
    });
    provider.subscribe(session.id, (event) => seen.push(event));
    await waitForEvents();
    fake.emit({
      method: 'turn/started',
      params: { threadId: 'thread-existing', turn: { id: 'turn-1' } },
    });
    fake.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-existing',
        turnId: 'turn-1',
        item: { id: 'item-1', type: 'agentMessage', text: 'done' },
      },
    });
    fake.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-existing', turn: { id: 'turn-1', status: 'completed' } },
    });

    expect(session.providerId).toBe('codex');
    expect(session.providerSessionRef).toBe('thread-existing');
    expect(session.title).toBe('Codex Work');
    expect(fake.requests[0]).toMatchObject({
      method: 'thread/start',
      params: {
        cwd: 'D:/repo',
        model: 'gpt-5.1-codex',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        serviceName: 'Hiyori',
        threadSource: 'hiyori',
      },
    });
    expect(fake.requests[1]).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: 'thread-existing',
        effort: 'high',
        input: [{ type: 'text', text: 'fix tests', text_elements: [] }],
      },
    });
    expect(seen.map((event) => `${event.type}:${event.content}`)).toContain('assistant_message:done');
    expect(seen.map((event) => event.type)).toContain('completed');
  });

  it('normalizes unsupported minimal reasoning effort before starting a turn', async () => {
    const fake = createFakeAppServer();
    const provider = createCodexRuntimeProvider({ createClient: () => fake.appServer });

    await provider.startSession({
      providerId: 'codex',
      hiyoriConversationId: 'conv-minimal',
      title: 'Minimal effort',
      initialMessage: 'say hi',
      metadata: {
        modelReasoningEffort: 'minimal',
      },
    });
    await waitForEvents();

    const turnStart = fake.requests.find((request) => request.method === 'turn/start');
    expect(turnStart?.params.effort).toBe('low');
  });

  it('extracts nested app-server error messages from error notifications', async () => {
    const fake = createFakeAppServer();
    const provider = createCodexRuntimeProvider({ createClient: () => fake.appServer });
    const seen: RuntimeEvent[] = [];

    const session = await provider.startSession({
      providerId: 'codex',
      hiyoriConversationId: 'conv-error',
      title: 'Error',
      initialMessage: 'say hi',
    });
    provider.subscribe(session.id, (event) => seen.push(event));
    await waitForEvents();

    fake.emit({
      method: 'error',
      params: {
        threadId: 'thread-existing',
        type: 'error',
        status: 400,
        error: {
          type: 'invalid_request_error',
          message: "The 'gpt-5.6-sol' model requires a newer version of Codex.",
        },
      },
    });

    expect(seen.map((event) => `${event.type}:${event.content}`)).toContain(
      "failed:The 'gpt-5.6-sol' model requires a newer version of Codex."
    );
  });

  it('resumes existing Codex threads through app-server', async () => {
    const fake = createFakeAppServer();
    const provider = createCodexRuntimeProvider({ createClient: () => fake.appServer });

    const session = await provider.resumeSession({
      providerId: 'codex',
      runtimeSessionId: 'session-1',
      hiyoriConversationId: 'conv-1',
      title: 'Existing',
      metadata: {
        providerSessionRef: 'thread-existing',
      },
    });

    expect(session.id).toBe('session-1');
    expect(session.providerSessionRef).toBe('thread-existing');
    expect(fake.requests[0]).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'thread-existing' },
    });
  });

  it('schedules follow-up turns without blocking the caller', async () => {
    const fake = createFakeAppServer();
    const provider = createCodexRuntimeProvider({ createClient: () => fake.appServer });
    const session = await provider.startSession({
      providerId: 'codex',
      hiyoriConversationId: 'conv-async',
      title: 'Async',
      initialMessage: 'first',
    });
    await waitForEvents();

    const startedAt = Date.now();
    await provider.sendMessage(session.id, { content: 'continue' });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(30);
    await delay(10);
    expect(fake.requests.filter((request) => request.method === 'turn/start').map((request) => request.params.input[0].text)).toEqual([
      'first',
      'continue',
    ]);
  });

  it('passes proxy environment to the app-server process when CODEX_PROXY is configured', () => {
    const originalProxy = process.env.CODEX_PROXY;
    process.env.CODEX_PROXY = 'http://127.0.0.1:7897';
    try {
      const env = createCodexAppServerEnv();

      expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7897');
      expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7897');
    } finally {
      if (originalProxy === undefined) delete process.env.CODEX_PROXY;
      else process.env.CODEX_PROXY = originalProxy;
    }
  });
});
