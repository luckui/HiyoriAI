import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRuntimeContext, resetRuntimeContextProvidersForTest } from '../../runtimeContext';
import { configureMinecraftMainIntegration } from '../mainIntegration';
import type { MinecraftRuntimeEvent, MinecraftStatus } from '../protocol';

function createRuntime() {
  let eventListener: ((event: MinecraftRuntimeEvent) => void) | undefined;
  let notifier: ((origin: any, event: MinecraftRuntimeEvent) => void) | undefined;
  const status: MinecraftStatus = {
    connected: true,
    username: 'Hiyori',
    players: ['GeoLingua'],
    owner: 'GeoLingua',
    health: 20,
    food: 20,
    behavior: { kind: 'idle' },
  };
  return {
    runtime: {
      onEvent: vi.fn((listener) => {
        eventListener = listener;
        return () => {
          eventListener = undefined;
        };
      }),
      command: vi.fn(async (action: string) => {
        if (action === 'status') return status;
        if (action === 'snapshot') {
          return {
            capturedAt: 1,
            stale: false,
            connection: { connected: true, username: 'Hiyori', host: '127.0.0.1', port: 60131 },
            body: { position: { x: 1, y: 64, z: 2 }, health: 20, food: 20, inventory: {} },
            owner: { name: 'GeoLingua', visible: true, distance: 3 },
            follow: { phase: 'nearby', target: 'GeoLingua', distance: 3 },
            nearby: { blocks: [], entities: [] },
            recentEvents: [],
          };
        }
        return undefined;
      }),
      setNotifier: vi.fn((next) => {
        notifier = next;
      }),
      currentOrigin: vi.fn(() => ({
        conversationId: 'conversation-1',
        replyTarget: { kind: 'minecraft', player: 'GeoLingua' },
      })),
      shutdown: vi.fn(async () => undefined),
    },
    emit: (event: MinecraftRuntimeEvent) => eventListener?.(event),
    notify: (origin: any, event: MinecraftRuntimeEvent) => notifier?.(origin, event),
  };
}

describe('Minecraft main integration', () => {
  afterEach(() => resetRuntimeContextProvidersForTest());

  it('routes chat, mirrors clean text, and requests local TTS once', async () => {
    const fake = createRuntime();
    const sendChatMessage = vi.fn(async () => ({ content: '你好', created_at: 12 }));
    const playTTS = vi.fn();
    const mirror = vi.fn();
    const integration = configureMinecraftMainIntegration({
      runtime: fake.runtime as any,
      sendChatMessage,
      playTTS,
      mirror,
      sendWakeup: vi.fn(),
      getFallbackConversationId: () => 'fallback',
    });

    fake.emit({ kind: 'chat', player: 'GeoLingua', message: '嗨' });
    await integration.whenIdle();

    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(fake.runtime.command).toHaveBeenCalledWith('say', { message: '你好' });
    expect(playTTS).toHaveBeenCalledTimes(1);
    expect(mirror).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      user: '嗨',
      assistant: '你好',
      createdAt: 12,
    });
  });

  it('turns terminal and food events into targeted Hiyori wakeups', () => {
    const fake = createRuntime();
    const sendWakeup = vi.fn();
    configureMinecraftMainIntegration({
      runtime: fake.runtime as any,
      sendChatMessage: vi.fn(),
      playTTS: vi.fn(),
      sendWakeup,
      getFallbackConversationId: () => 'fallback',
    });
    const origin = {
      conversationId: 'conversation-1',
      replyTarget: { kind: 'minecraft' as const, player: 'GeoLingua' },
    };

    fake.notify(origin, {
      kind: 'collection-terminal',
      jobId: 'job-1',
      outcome: 'completed',
      block: 'oak_log',
      requested: 4,
      collected: 4,
    });
    fake.notify(origin, { kind: 'food-shortage', food: 5 });

    expect(sendWakeup).toHaveBeenCalledTimes(2);
    expect(sendWakeup).toHaveBeenNthCalledWith(
      1,
      'conversation-1',
      expect.stringContaining('oak_log'),
      origin.replyTarget,
    );
    expect(sendWakeup).toHaveBeenNthCalledWith(
      2,
      'conversation-1',
      expect.stringContaining('没有可食用物品'),
      origin.replyTarget,
    );
  });

  it('stops the channel and worker on shutdown', async () => {
    const fake = createRuntime();
    const integration = configureMinecraftMainIntegration({
      runtime: fake.runtime as any,
      sendChatMessage: vi.fn(),
      playTTS: vi.fn(),
      sendWakeup: vi.fn(),
      getFallbackConversationId: () => 'fallback',
    });

    await integration.shutdown();

    expect(fake.runtime.shutdown).toHaveBeenCalledOnce();
  });

  it('registers minecraft runtime context and removes it on shutdown', async () => {
    const fake = createRuntime();
    const integration = configureMinecraftMainIntegration({
      runtime: fake.runtime as any,
      sendChatMessage: vi.fn(),
      playTTS: vi.fn(),
      sendWakeup: vi.fn(),
      getFallbackConversationId: () => 'fallback',
    });

    expect(await buildRuntimeContext()).toContain('GeoLingua visible at 3.0 blocks');

    await integration.shutdown();

    expect(await buildRuntimeContext()).toBe('');
  });

  it('does not request minecraft snapshots while the worker is inactive', async () => {
    const fake = createRuntime();
    (fake.runtime as any).hasActiveWorker = vi.fn(() => false);
    const integration = configureMinecraftMainIntegration({
      runtime: fake.runtime as any,
      sendChatMessage: vi.fn(),
      playTTS: vi.fn(),
      sendWakeup: vi.fn(),
      getFallbackConversationId: () => 'fallback',
    });

    expect(await buildRuntimeContext()).toBe('');
    expect(fake.runtime.command).not.toHaveBeenCalledWith('snapshot', {});

    await integration.shutdown();
  });
});
