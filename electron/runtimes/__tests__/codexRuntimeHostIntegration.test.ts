import { describe, expect, it } from 'vitest';
import { createCodexRuntimeProvider } from '../providers/codex';
import { RuntimeHost } from '../runtimeHost';
import { RuntimeRegistry } from '../runtimeRegistry';
import { TranscriptMirror } from '../transcriptMirror';

function createFakeCodexClient() {
  return {
    startThread() {
      return {
        id: 'thread-existing',
        async runStreamed() {
          return {
            events: (async function* () {
              yield { type: 'thread.started' as const, thread_id: 'thread-1' };
              yield {
                type: 'item.completed' as const,
                item: { id: 'item-1', type: 'agent_message' as const, text: 'initial response' },
              };
              yield {
                type: 'turn.completed' as const,
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  output_tokens: 1,
                  reasoning_output_tokens: 0,
                },
              };
            })(),
          };
        },
      };
    },
    resumeThread() {
      throw new Error('not used');
    },
  };
}

describe('Codex provider through RuntimeHost', () => {
  it('mirrors initial start-session events after the host subscribes', async () => {
    const registry = new RuntimeRegistry();
    registry.register(createCodexRuntimeProvider({ createClient: createFakeCodexClient }));
    const mirror = new TranscriptMirror();
    const host = new RuntimeHost(registry, mirror);

    const session = await host.startSession({
      providerId: 'codex',
      hiyoriConversationId: 'conv-1',
      title: 'Codex Work',
      initialMessage: 'hello',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(host.listEvents(session.id).map((event) => event.content)).toContain(
      'initial response'
    );
  });
});
