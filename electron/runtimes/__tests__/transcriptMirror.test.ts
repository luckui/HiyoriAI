import { describe, expect, it } from 'vitest';
import { TranscriptMirror } from '../transcriptMirror';
import type { RuntimeEvent, RuntimeSession } from '../types';

function session(id: string): RuntimeSession {
  return {
    id,
    providerId: 'fake',
    providerSessionRef: `native-${id}`,
    hiyoriConversationId: 'conv-1',
    title: 'Test Session',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
  };
}

function event(sessionId: string, content: string): RuntimeEvent {
  return {
    id: `event-${content}`,
    sessionId,
    providerId: 'fake',
    type: 'assistant_message',
    content,
    createdAt: Date.now(),
  };
}

describe('TranscriptMirror', () => {
  it('stores sessions and events separately', () => {
    const mirror = new TranscriptMirror();

    mirror.recordSession(session('s1'));
    mirror.recordEvent(event('s1', 'hello'));
    mirror.recordEvent(event('s1', 'world'));

    expect(mirror.getSession('s1')?.title).toBe('Test Session');
    expect(mirror.listEvents('s1').map((item) => item.content)).toEqual(['hello', 'world']);
  });

  it('updates session status without removing events', () => {
    const mirror = new TranscriptMirror();

    mirror.recordSession(session('s1'));
    mirror.recordEvent(event('s1', 'hello'));
    mirror.updateSessionStatus('s1', 'completed');

    expect(mirror.getSession('s1')?.status).toBe('completed');
    expect(mirror.listEvents('s1')).toHaveLength(1);
  });
});
