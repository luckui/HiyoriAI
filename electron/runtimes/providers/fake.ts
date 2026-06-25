import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  AgentRuntimeProvider,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSubscription,
} from '../types';

export function createFakeRuntimeProvider(): AgentRuntimeProvider {
  const emitter = new EventEmitter();
  const sessions = new Map<string, RuntimeSession>();

  function emit(session: RuntimeSession, type: RuntimeEvent['type'], content: string): void {
    const event: RuntimeEvent = {
      id: randomUUID(),
      sessionId: session.id,
      providerId: session.providerId,
      type,
      content,
      createdAt: Date.now(),
    };
    emitter.emit(session.id, event);
  }

  return {
    id: 'fake',
    displayName: 'Fake Runtime',

    async checkAvailability() {
      return { available: true };
    },

    async startSession(input) {
      const now = Date.now();
      const session: RuntimeSession = {
        id: randomUUID(),
        providerId: 'fake',
        providerSessionRef: randomUUID(),
        hiyoriConversationId: input.hiyoriConversationId,
        cwd: input.cwd,
        title: input.title,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        metadata: input.metadata ?? {},
      };
      sessions.set(session.id, session);
      queueMicrotask(() => {
        emit(session, 'session_started', `fake started: ${input.initialMessage}`);
      });
      return session;
    },

    async resumeSession(input) {
      const existing = sessions.get(input.runtimeSessionId);
      if (existing) return existing;
      const now = Date.now();
      const session: RuntimeSession = {
        id: input.runtimeSessionId,
        providerId: 'fake',
        providerSessionRef: randomUUID(),
        hiyoriConversationId: input.hiyoriConversationId,
        cwd: input.cwd,
        title: input.title,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        metadata: input.metadata ?? {},
      };
      sessions.set(session.id, session);
      return session;
    },

    async sendMessage(sessionId, message) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Fake runtime session not found: ${sessionId}`);
      emit(session, 'assistant_message', `fake received: ${message.content}`);
    },

    async interrupt(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Fake runtime session not found: ${sessionId}`);
      session.status = 'interrupted';
      session.updatedAt = Date.now();
      emit(session, 'interrupted', 'fake interrupted');
    },

    async stop(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Fake runtime session not found: ${sessionId}`);
      session.status = 'stopped';
      session.updatedAt = Date.now();
      emit(session, 'stopped', 'fake stopped');
    },

    subscribe(sessionId, onEvent): RuntimeSubscription {
      emitter.on(sessionId, onEvent);
      return {
        unsubscribe() {
          emitter.off(sessionId, onEvent);
        },
      };
    },
  };
}
