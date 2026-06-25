import { describe, expect, it } from 'vitest';
import { createFakeRuntimeProvider } from '../providers/fake';

describe('createFakeRuntimeProvider', () => {
  it('starts a running session', async () => {
    const provider = createFakeRuntimeProvider();

    const session = await provider.startSession({
      providerId: 'fake',
      hiyoriConversationId: 'conv-1',
      title: 'Fake Work',
      initialMessage: 'hello',
      cwd: 'D:/repo',
    });

    expect(session.providerId).toBe('fake');
    expect(session.hiyoriConversationId).toBe('conv-1');
    expect(session.cwd).toBe('D:/repo');
    expect(session.status).toBe('running');
  });

  it('emits assistant messages after sendMessage', async () => {
    const provider = createFakeRuntimeProvider();
    const session = await provider.startSession({
      providerId: 'fake',
      hiyoriConversationId: 'conv-1',
      title: 'Fake Work',
      initialMessage: 'hello',
    });
    const events: string[] = [];

    provider.subscribe(session.id, (event) => events.push(`${event.type}:${event.content}`));
    await provider.sendMessage(session.id, { content: 'continue' });

    expect(events).toContain('assistant_message:fake received: continue');
  });
});
