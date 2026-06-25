import { describe, expect, it } from 'vitest';
import { createCodexRuntimeProvider, createCodexSdkOptions } from '../providers/codex';
import type { RuntimeEvent } from '../types';

type FakeThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'item.completed'; item: { id: string; type: 'agent_message'; text: string } }
  | { type: 'item.completed'; item: { id: string; type: 'command_execution'; command: string; aggregated_output: string; status: string; exit_code?: number } }
  | { type: 'turn.completed'; usage: Record<string, number> };

function createFakeCodexClient(events: FakeThreadEvent[]) {
  const started: Array<Record<string, unknown> | undefined> = [];
  const resumed: string[] = [];
  const resumedOptions: Array<Record<string, unknown> | undefined> = [];
  const prompts: unknown[] = [];
  const thread = {
    id: 'thread-existing',
    async runStreamed(input: unknown) {
      prompts.push(input);
      return {
        events: (async function* () {
          for (const event of events) yield event;
        })(),
      };
    },
  };

  return {
    client: {
      startThread(options?: Record<string, unknown>) {
        started.push(options);
        return thread;
      },
      resumeThread(id: string, options?: Record<string, unknown>) {
        resumed.push(id);
        resumedOptions.push(options);
        return thread;
      },
    },
    started,
    resumed,
    resumedOptions,
    prompts,
  };
}

async function waitForEvents(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createCodexRuntimeProvider', () => {
  it('is unavailable when the sdk cannot be created', async () => {
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

  it('starts a Codex thread through the SDK and maps streamed events', async () => {
    const fake = createFakeCodexClient([
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const provider = createCodexRuntimeProvider({ createClient: () => fake.client });
    const seen: RuntimeEvent[] = [];

    const session = await provider.startSession({
      providerId: 'codex',
      hiyoriConversationId: 'conv-1',
      title: 'Codex Work',
      initialMessage: 'fix tests',
      cwd: 'D:/repo',
      metadata: {
        providerSessionRef: 'thread-existing',
        model: 'gpt-5.1-codex',
        modelReasoningEffort: 'high',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        networkAccessEnabled: true,
      },
    });
    provider.subscribe(session.id, (event) => seen.push(event));
    await waitForEvents();
    await provider.sendMessage(session.id, { content: 'continue' });

    expect(session.providerId).toBe('codex');
    expect(session.providerSessionRef).toBe('thread-1');
    expect(fake.resumed).toEqual(['thread-existing']);
    expect(fake.resumedOptions[0]).toMatchObject({
      workingDirectory: 'D:/repo',
      model: 'gpt-5.1-codex',
      modelReasoningEffort: 'high',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccessEnabled: true,
    });
    await waitForEvents();
    expect(fake.prompts).toEqual(['fix tests', 'continue']);
    expect(seen.map((event) => `${event.type}:${event.content}`)).toContain(
      'assistant_message:done'
    );
    expect(seen.map((event) => event.type)).toContain('completed');
  });

  it('resumes existing Codex threads', async () => {
    const fake = createFakeCodexClient([]);
    const provider = createCodexRuntimeProvider({ createClient: () => fake.client });

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
    expect(fake.resumed).toEqual(['thread-existing']);
  });

  it('schedules follow-up turns without blocking the caller', async () => {
    const prompts: unknown[] = [];
    const provider = createCodexRuntimeProvider({
      createClient: () => ({
        startThread() {
          return {
            id: 'thread-async',
            async runStreamed(input: unknown) {
              prompts.push(input);
              return {
                events: (async function* () {
                  await delay(50);
                  yield { type: 'turn.completed', usage: {} } as FakeThreadEvent;
                })(),
              };
            },
          };
        },
        resumeThread() {
          throw new Error('not used');
        },
      }),
    });

    const session = await provider.startSession({
      providerId: 'codex',
      hiyoriConversationId: 'conv-async',
      title: 'Async',
      initialMessage: 'first',
    });
    await delay(0);

    const startedAt = Date.now();
    await provider.sendMessage(session.id, { content: 'continue' });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(30);
    await delay(80);
    expect(prompts).toContain('continue');
  });

  it('passes proxy environment to the SDK client when CODEX_PROXY is configured', async () => {
    const originalProxy = process.env.CODEX_PROXY;
    process.env.CODEX_PROXY = 'http://127.0.0.1:7897';
    try {
      const options = createCodexSdkOptions();

      expect(options?.env?.HTTPS_PROXY).toBe('http://127.0.0.1:7897');
      expect(options?.env?.HTTP_PROXY).toBe('http://127.0.0.1:7897');
    } finally {
      if (originalProxy === undefined) delete process.env.CODEX_PROXY;
      else process.env.CODEX_PROXY = originalProxy;
    }
  });
});
