import { describe, expect, it } from 'vitest';
import { createFakeRuntimeProvider } from '../providers/fake';
import { RuntimeHost } from '../runtimeHost';
import { RuntimeRegistry } from '../runtimeRegistry';
import { TranscriptMirror } from '../transcriptMirror';

function createHost() {
  const registry = new RuntimeRegistry();
  registry.register(createFakeRuntimeProvider());
  const mirror = new TranscriptMirror();
  return { host: new RuntimeHost(registry, mirror), mirror };
}

describe('RuntimeHost', () => {
  it('starts sessions through a provider and mirrors them', async () => {
    const { host, mirror } = createHost();

    const session = await host.startSession({
      providerId: 'fake',
      hiyoriConversationId: 'conv-1',
      title: 'Fake Session',
      initialMessage: 'hello',
    });

    expect(session.status).toBe('running');
    expect(mirror.getSession(session.id)?.title).toBe('Fake Session');
  });

  it('mirrors provider events and emits them to subscribers', async () => {
    const { host, mirror } = createHost();
    const session = await host.startSession({
      providerId: 'fake',
      hiyoriConversationId: 'conv-1',
      title: 'Fake Session',
      initialMessage: 'hello',
    });
    const seen: string[] = [];

    host.onRuntimeEvent((event) => {
      if (event.sessionId === session.id) seen.push(event.content);
    });
    await host.sendMessage(session.id, { content: 'continue' });

    expect(seen).toContain('fake received: continue');
    expect(mirror.listEvents(session.id).map((event) => event.content)).toContain(
      'fake received: continue'
    );
  });

  it('lists mirrored sessions', async () => {
    const { host } = createHost();

    await host.startSession({
      providerId: 'fake',
      hiyoriConversationId: 'conv-1',
      title: 'Fake Session',
      initialMessage: 'hello',
    });

    expect(host.listSessions()).toHaveLength(1);
  });

  it('marks sessions stopped when the provider stops', async () => {
    const { host } = createHost();
    const session = await host.startSession({
      providerId: 'fake',
      hiyoriConversationId: 'conv-1',
      title: 'Fake Session',
      initialMessage: 'hello',
    });

    await host.stop(session.id);

    expect(host.getSession(session.id)?.status).toBe('stopped');
  });
});
