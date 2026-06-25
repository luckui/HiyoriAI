import { describe, expect, it } from 'vitest';
import { createCodexRuntimeProvider } from '../providers/codex';
import type { RuntimeEvent } from '../types';

type FakeThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'item.completed'; item: { id: string; type: 'agent_message'; text: string } }
  | { type: 'item.completed'; item: { id: string; type: 'command_execution'; command: string; aggregated_output: string; status: string; exit_code?: number } }
  | { type: 'turn.completed'; usage: Record<string, number> };

function createFakeCodexClient(events: FakeThreadEvent[]) {
  const started: Array<Record<string, unknown> | undefined> = [];
  const resumed: string[] = [];
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
      resumeThread(id: string) {
        resumed.push(id);
        return thread;
      },
    },
    started,
    resumed,
    prompts,
  };
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
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
      },
    });
    provider.subscribe(session.id, (event) => seen.push(event));
    await provider.sendMessage(session.id, { content: 'continue' });

    expect(session.providerId).toBe('codex');
    expect(session.providerSessionRef).toBe('thread-1');
    expect(fake.started[0]).toMatchObject({
      workingDirectory: 'D:/repo',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    });
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
});
