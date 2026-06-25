import type { RuntimeEvent, RuntimeSession, RuntimeSessionStatus } from './types';

export class TranscriptMirror {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly events = new Map<string, RuntimeEvent[]>();

  recordSession(session: RuntimeSession): void {
    this.sessions.set(session.id, session);
    if (!this.events.has(session.id)) {
      this.events.set(session.id, []);
    }
  }

  updateSessionStatus(sessionId: string, status: RuntimeSessionStatus): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Runtime session not found: ${sessionId}`);
    }
    this.sessions.set(sessionId, {
      ...session,
      status,
      updatedAt: Date.now(),
    });
  }

  recordEvent(event: RuntimeEvent): void {
    const list = this.events.get(event.sessionId) ?? [];
    list.push(event);
    this.events.set(event.sessionId, list);
  }

  getSession(sessionId: string): RuntimeSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): RuntimeSession[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listEvents(sessionId: string): RuntimeEvent[] {
    return [...(this.events.get(sessionId) ?? [])];
  }
}
