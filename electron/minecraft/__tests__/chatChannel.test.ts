import { describe, expect, it, vi } from 'vitest';
import { MinecraftChatChannel, type MinecraftChatRuntime } from '../chatChannel';
import type { MinecraftRuntimeEvent, MinecraftStatus } from '../protocol';

function createRuntime(status: Partial<MinecraftStatus> = {}) {
  let listener: ((event: MinecraftRuntimeEvent) => void) | undefined;
  const runtime: MinecraftChatRuntime = {
    onEvent: vi.fn((next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    }),
    status: vi.fn(async () => ({
      connected: true,
      username: 'Hiyori',
      players: ['GeoLingua'],
      owner: 'GeoLingua',
      health: 18,
      food: 12,
      behavior: { kind: 'idle' as const },
      ...status,
    })),
    say: vi.fn(async () => undefined),
  };
  return {
    runtime,
    emit: (event: MinecraftRuntimeEvent) => listener?.(event),
  };
}

describe('MinecraftChatChannel', () => {
  it('routes one-human chat through one clean Hiyori turn and local TTS', async () => {
    const fake = createRuntime();
    const sendChatMessage = vi.fn(async () => ({ content: '你好呀', created_at: 1 }));
    const playTTS = vi.fn();
    const mirror = vi.fn();
    const channel = new MinecraftChatChannel({
      runtime: fake.runtime,
      getConversationId: () => 'conversation-1',
      sendChatMessage,
      playTTS,
      mirror,
    });
    channel.start();

    fake.emit({ kind: 'chat', player: 'GeoLingua', message: '你好' });
    await channel.whenIdle();

    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(sendChatMessage).toHaveBeenCalledWith('conversation-1', '你好', {
      sourceContext: expect.stringContaining('Minecraft 玩家 GeoLingua'),
    });
    expect(fake.runtime.say).toHaveBeenCalledWith('你好呀');
    expect(playTTS).toHaveBeenCalledWith('你好呀');
    expect(mirror).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      user: '你好',
      assistant: '你好呀',
      createdAt: 1,
    });
  });

  it('requires non-owner mentions only when another human is present', async () => {
    const fake = createRuntime({ players: ['GeoLingua', 'Alex'], owner: 'GeoLingua' });
    const sendChatMessage = vi.fn(async () => ({ content: '收到', created_at: 1 }));
    const channel = new MinecraftChatChannel({
      runtime: fake.runtime,
      getConversationId: () => 'conversation-1',
      sendChatMessage,
      playTTS: vi.fn(),
    });
    channel.start();

    fake.emit({ kind: 'chat', player: 'Alex', message: '大家好' });
    fake.emit({ kind: 'chat', player: 'Alex', message: 'Hiyori 跟我来' });
    fake.emit({ kind: 'chat', player: 'GeoLingua', message: '继续跟着我' });
    await channel.whenIdle();

    expect(sendChatMessage).toHaveBeenCalledTimes(2);
    expect(sendChatMessage.mock.calls.map((call) => call[1])).toEqual([
      'Hiyori 跟我来',
      '继续跟着我',
    ]);
  });

  it('serializes LLM turns without changing game behavior', async () => {
    const fake = createRuntime({ behavior: { kind: 'follow', player: 'GeoLingua' } });
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sendChatMessage = vi
      .fn()
      .mockImplementationOnce(async () => {
        await first;
        return { content: '第一条', created_at: 1 };
      })
      .mockResolvedValueOnce({ content: '第二条', created_at: 2 });
    const channel = new MinecraftChatChannel({
      runtime: fake.runtime,
      getConversationId: () => 'conversation-1',
      sendChatMessage,
      playTTS: vi.fn(),
    });
    channel.start();

    fake.emit({ kind: 'chat', player: 'GeoLingua', message: '一' });
    fake.emit({ kind: 'chat', player: 'GeoLingua', message: '二' });
    await vi.waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(1));
    releaseFirst();
    await channel.whenIdle();
    expect(sendChatMessage).toHaveBeenCalledTimes(2);
    expect(fake.runtime.status).toHaveReturned();
  });
});
