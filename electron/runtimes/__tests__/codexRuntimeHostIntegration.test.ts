import { describe, expect, it } from 'vitest';
import { createCodexRuntimeProvider } from '../providers/codex';
import { RuntimeHost } from '../runtimeHost';
import { RuntimeRegistry } from '../runtimeRegistry';
import { TranscriptMirror } from '../transcriptMirror';
import type { CodexJsonRpcNotification } from '../providers/codexAppServerClient';

function createFakeAppServer() {
  const listeners = new Set<(notification: CodexJsonRpcNotification) => void>();
  return {
    appServer: {
      async start() {},
      async request(method: string, params?: any) {
        if (method === 'thread/start') {
          return {
            thread: {
              id: 'thread-1',
              cwd: params?.cwd,
              name: 'Codex Work',
              status: { type: 'idle' },
            },
          };
        }
        if (method === 'turn/start') {
          setTimeout(() => {
            for (const listener of listeners) {
              listener({
                method: 'turn/started',
                params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
              });
              listener({
                method: 'item/completed',
                params: {
                  threadId: 'thread-1',
                  turnId: 'turn-1',
                  item: { id: 'item-1', type: 'agentMessage', text: 'initial response' },
                },
              });
              listener({
                method: 'turn/completed',
                params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
              });
            }
          }, 0);
          return { turn: { id: 'turn-1', status: 'running', items: [] } };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
      onNotification(listener: (notification: CodexJsonRpcNotification) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

describe('Codex provider through RuntimeHost', () => {
  it('mirrors initial start-session events after the host subscribes', async () => {
    const registry = new RuntimeRegistry();
    const fake = createFakeAppServer();
    registry.register(createCodexRuntimeProvider({ createClient: () => fake.appServer }));
    const mirror = new TranscriptMirror();
    const host = new RuntimeHost(registry, mirror);

    const session = await host.startSession({
      providerId: 'codex',
      hiyoriConversationId: 'conv-1',
      title: 'Codex Work',
      initialMessage: 'hello',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(host.listEvents(session.id).map((event) => event.content)).toContain(
      'initial response'
    );
    expect(host.listEvents(session.id).map((event) => event.content)).toContain(
      'codex turn started'
    );
  });
});
