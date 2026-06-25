import { EventEmitter } from 'events';
import type { RuntimeRegistry } from './runtimeRegistry';
import type { TranscriptMirror } from './transcriptMirror';
import type {
  RuntimeEvent,
  RuntimeSession,
  RuntimeSubscription,
  RuntimeUserMessage,
  StartRuntimeSessionInput,
} from './types';

type RuntimeEventListener = (event: RuntimeEvent) => void;

export class RuntimeHost {
  private readonly emitter = new EventEmitter();
  private readonly providerSubscriptions = new Map<string, RuntimeSubscription>();

  constructor(
    private readonly registry: RuntimeRegistry,
    private readonly mirror: TranscriptMirror
  ) {}

  async startSession(input: StartRuntimeSessionInput): Promise<RuntimeSession> {
    const provider = this.registry.requireProvider(input.providerId);
    const availability = await provider.checkAvailability();
    if (!availability.available) {
      throw new Error(
        availability.reason
          ? `Runtime provider unavailable: ${input.providerId} (${availability.reason})`
          : `Runtime provider unavailable: ${input.providerId}`
      );
    }

    const session = await provider.startSession(input);
    this.mirror.recordSession(session);

    const subscription = provider.subscribe(session.id, (event) => {
      this.mirror.recordEvent(event);
      this.applyEventStatus(event);
      this.emitter.emit('runtime-event', event);
    });
    this.providerSubscriptions.set(session.id, subscription);

    return session;
  }

  async sendMessage(sessionId: string, message: RuntimeUserMessage): Promise<void> {
    const session = this.requireSession(sessionId);
    const provider = this.registry.requireProvider(session.providerId);
    await provider.sendMessage(sessionId, message);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const provider = this.registry.requireProvider(session.providerId);
    await provider.interrupt(sessionId);
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const provider = this.registry.requireProvider(session.providerId);
    await provider.stop(sessionId);
    this.providerSubscriptions.get(sessionId)?.unsubscribe();
    this.providerSubscriptions.delete(sessionId);
  }

  getSession(sessionId: string): RuntimeSession | undefined {
    return this.mirror.getSession(sessionId);
  }

  listSessions(): RuntimeSession[] {
    return this.mirror.listSessions();
  }

  listEvents(sessionId: string): RuntimeEvent[] {
    return this.mirror.listEvents(sessionId);
  }

  onRuntimeEvent(listener: RuntimeEventListener): RuntimeSubscription {
    this.emitter.on('runtime-event', listener);
    return {
      unsubscribe: () => this.emitter.off('runtime-event', listener),
    };
  }

  private requireSession(sessionId: string): RuntimeSession {
    const session = this.mirror.getSession(sessionId);
    if (!session) {
      throw new Error(`Runtime session not found: ${sessionId}`);
    }
    return session;
  }

  private applyEventStatus(event: RuntimeEvent): void {
    if (
      event.type === 'completed' ||
      event.type === 'failed' ||
      event.type === 'interrupted' ||
      event.type === 'stopped'
    ) {
      this.mirror.updateSessionStatus(event.sessionId, event.type);
    }
  }
}
