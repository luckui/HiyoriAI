import { describe, expect, it } from 'vitest';
import { RuntimeRegistry } from '../runtimeRegistry';
import type { AgentRuntimeProvider, RuntimeEvent, RuntimeSubscription } from '../types';

function makeProvider(id: string): AgentRuntimeProvider {
  return {
    id,
    displayName: `Provider ${id}`,
    async checkAvailability() {
      return { available: true };
    },
    async startSession(input) {
      return {
        id: `${id}-session`,
        providerId: id,
        providerSessionRef: `${id}-native`,
        hiyoriConversationId: input.hiyoriConversationId,
        cwd: input.cwd,
        title: input.title,
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
        metadata: {},
      };
    },
    async resumeSession(input) {
      return {
        id: input.runtimeSessionId,
        providerId: id,
        providerSessionRef: `${id}-native`,
        hiyoriConversationId: input.hiyoriConversationId,
        cwd: input.cwd,
        title: input.title,
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
        metadata: {},
      };
    },
    async sendMessage() {},
    async interrupt() {},
    async stop() {},
    subscribe(_sessionId: string, _onEvent: (event: RuntimeEvent) => void): RuntimeSubscription {
      return { unsubscribe() {} };
    },
  };
}

describe('RuntimeRegistry', () => {
  it('starts empty', () => {
    const registry = new RuntimeRegistry();
    expect(registry.listProviders()).toEqual([]);
  });

  it('registers and returns providers by id', () => {
    const registry = new RuntimeRegistry();
    const provider = makeProvider('fake');

    registry.register(provider);

    expect(registry.getProvider('fake')).toBe(provider);
    expect(registry.listProviders()).toEqual([
      { id: 'fake', displayName: 'Provider fake' },
    ]);
  });

  it('rejects duplicate provider ids', () => {
    const registry = new RuntimeRegistry();

    registry.register(makeProvider('fake'));

    expect(() => registry.register(makeProvider('fake'))).toThrow(
      'Runtime provider already registered: fake'
    );
  });
});
