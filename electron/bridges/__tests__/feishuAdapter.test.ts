import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sentMessages: [] as Array<{ receiveId: string; content: string; msgType: string }>,
  uploadedFiles: [] as Array<{ fileType: string; fileName: string; file: Buffer; duration?: number }>,
  uploadResponse: null as null | Record<string, unknown>,
  handlers: new Map<string, Function>(),
  started: 0,
  closed: 0,
  sendChatMessage: vi.fn(),
  conversations: [{ id: 'conv-latest' }],
  pendingReplyResolve: null as null | ((value: { content: string }) => void),
  voiceDeliveries: [] as Array<{ chatId: string; text: string; voiceEnabled: boolean; hasProvider: boolean }>,
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 'self_build' },
  Domain: { Feishu: 'https://open.feishu.cn' },
  LoggerLevel: { info: 'info' },
  Client: class {
    im = {
      v1: {
        message: {
          create: vi.fn(async ({ data }: any) => {
            state.sentMessages.push({
              receiveId: data.receive_id,
              content: data.content,
              msgType: data.msg_type,
            });
            return { code: 0 };
          }),
        },
        file: {
          create: vi.fn(async ({ data }: any) => {
            state.uploadedFiles.push({
              fileType: data.file_type,
              fileName: data.file_name,
              file: Buffer.from(data.file),
              duration: data.duration,
            });
            return state.uploadResponse ?? { code: 0, data: { file_key: 'file_key_audio' } };
          }),
        },
      },
    };
  },
  WSClient: class {
    async start({ eventDispatcher }: any) {
      state.started++;
      state.handlers = eventDispatcher.handles;
    }
    close() {
      state.closed++;
    }
  },
  EventDispatcher: class {
    handles = new Map<string, Function>();
    register(handlers: Record<string, Function>) {
      for (const [key, value] of Object.entries(handlers)) this.handles.set(key, value);
      return this;
    }
  },
}));

vi.mock('../../aiService', () => ({
  sendChatMessage: (...args: unknown[]) => state.sendChatMessage(...args),
}));

vi.mock('../../db', () => ({
  listConversations: () => state.conversations,
}));

vi.mock('../voiceReplies', () => ({
  getReadyBridgeVoiceProvider: vi.fn(async () => ({
    type: 'http-tts',
    name: 'Mock TTS',
    baseUrl: 'http://127.0.0.1:9880',
    apiKey: '',
  })),
  deliverFeishuVoiceReply: vi.fn(async (deps: {
    chatId: string;
    text: string;
    voiceEnabled: boolean;
    provider?: unknown;
    sendAudio: (chatId: string, opus: Buffer, fileName: string, meta?: { durationMs?: number }) => Promise<void>;
    sendText: (chatId: string, text: string) => Promise<void>;
  }) => {
    state.voiceDeliveries.push({
      chatId: deps.chatId,
      text: deps.text,
      voiceEnabled: deps.voiceEnabled,
      hasProvider: Boolean(deps.provider),
    });
    if (deps.voiceEnabled && deps.provider) {
      await deps.sendAudio(deps.chatId, Buffer.from('opus-data'), 'reply.opus', { durationMs: 1000 });
    }
    await deps.sendText(deps.chatId, deps.text);
    return {
      voiceAttempted: Boolean(deps.voiceEnabled && deps.provider),
      voiceSent: deps.voiceEnabled && deps.provider ? 1 : 0,
    };
  }),
}));

describe('FeishuAdapter', () => {
  beforeEach(() => {
    state.sentMessages = [];
    state.uploadedFiles = [];
    state.uploadResponse = null;
    state.handlers = new Map();
    state.started = 0;
    state.closed = 0;
    state.sendChatMessage = vi.fn(async () => ({ content: 'Hiyori reply' }));
    state.conversations = [{ id: 'conv-latest' }];
    state.pendingReplyResolve = null;
    state.voiceDeliveries = [];
  });

  it('receives a Feishu p2p text event and replies to the same chat', async () => {
    const { FeishuAdapter } = await import('../adapters/feishu');
    const adapter = new FeishuAdapter({
      enabled: true,
      appId: 'cli_xxx',
      appSecret: 'secret',
      allowedChatIds: [],
      conversationId: '',
      voiceRepliesEnabled: false,
    });

    await adapter.start();
    const handler = state.handlers.get('im.message.receive_v1');
    expect(handler).toBeTypeOf('function');

    await handler?.({
      sender: { sender_id: { open_id: 'ou_user' } },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello from Feishu' }),
      },
    });
    await vi.waitFor(() => expect(state.sentMessages).toHaveLength(1));

    expect(state.sendChatMessage).toHaveBeenCalledWith(
      'conv-latest',
      '[来源：Lark / Feishu | 聊天：oc_chat | 用户：ou_user]\nhello from Feishu',
    );
    expect(state.sentMessages).toEqual([{
      receiveId: 'oc_chat',
      content: JSON.stringify({ text: 'Hiyori reply' }),
      msgType: 'text',
    }]);
  });

  it('ignores non-p2p messages in the first version', async () => {
    const { FeishuAdapter } = await import('../adapters/feishu');
    const adapter = new FeishuAdapter({
      enabled: true,
      appId: 'cli_xxx',
      appSecret: 'secret',
      allowedChatIds: [],
      conversationId: 'conv-bound',
      voiceRepliesEnabled: false,
    });

    await adapter.start();
    await state.handlers.get('im.message.receive_v1')?.({
      sender: { sender_id: { open_id: 'ou_user' } },
      message: {
        message_id: 'om_group',
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'group hello' }),
      },
    });

    expect(state.sendChatMessage).not.toHaveBeenCalled();
    expect(state.sentMessages).toEqual([]);
  });

  it('acks Feishu events quickly and deduplicates retried message ids', async () => {
    const { FeishuAdapter } = await import('../adapters/feishu');
    state.sendChatMessage = vi.fn(() => new Promise(resolve => {
      state.pendingReplyResolve = resolve;
    }));
    const adapter = new FeishuAdapter({
      enabled: true,
      appId: 'cli_xxx',
      appSecret: 'secret',
      allowedChatIds: [],
      conversationId: 'conv-bound',
      voiceRepliesEnabled: false,
    });

    await adapter.start();
    const event = {
      sender: { sender_id: { open_id: 'ou_user' } },
      message: {
        message_id: 'om_retry',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hi' }),
      },
    };

    await state.handlers.get('im.message.receive_v1')?.(event);
    await state.handlers.get('im.message.receive_v1')?.(event);

    expect(state.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(state.sentMessages).toEqual([]);

    state.pendingReplyResolve?.({ content: 'Hiyori reply once' });
    await vi.waitFor(() => expect(state.sentMessages).toHaveLength(1));
    expect(state.sentMessages[0]).toMatchObject({
      receiveId: 'oc_chat',
      content: JSON.stringify({ text: 'Hiyori reply once' }),
    });
  });

  it('uploads opus audio and sends a Feishu audio bubble with the file key', async () => {
    const { FeishuAdapter } = await import('../adapters/feishu');
    const adapter = new FeishuAdapter({
      enabled: true,
      appId: 'cli_xxx',
      appSecret: 'secret',
      allowedChatIds: [],
      conversationId: 'conv-bound',
      voiceRepliesEnabled: false,
    });

    await adapter.sendAudio('oc_chat', Buffer.from('opus-data'), 'reply.opus', { durationMs: 4200 });

    expect(state.uploadedFiles).toHaveLength(1);
    expect(state.uploadedFiles[0]).toMatchObject({
      fileType: 'opus',
      fileName: 'reply.opus',
      duration: 4200,
    });
    expect(state.sentMessages).toEqual([{
      receiveId: 'oc_chat',
      content: JSON.stringify({ file_key: 'file_key_audio' }),
      msgType: 'audio',
    }]);
  });

  it('uses the shared voice reply pipeline for outbound replies', async () => {
    const { FeishuAdapter } = await import('../adapters/feishu');
    const adapter = new FeishuAdapter({
      enabled: true,
      appId: 'cli_xxx',
      appSecret: 'secret',
      allowedChatIds: [],
      conversationId: 'conv-bound',
      voiceRepliesEnabled: true,
    });

    await adapter.sendReply('oc_chat', 'Reminder reply.');

    expect(state.voiceDeliveries).toEqual([{
      chatId: 'oc_chat',
      text: 'Reminder reply.',
      voiceEnabled: true,
      hasProvider: true,
    }]);
    expect(state.sentMessages).toEqual([
      {
        receiveId: 'oc_chat',
        content: JSON.stringify({ file_key: 'file_key_audio' }),
        msgType: 'audio',
      },
      {
        receiveId: 'oc_chat',
        content: JSON.stringify({ text: 'Reminder reply.' }),
        msgType: 'text',
      },
    ]);
  });

  it('handles /startvoice without sending the command to the LLM', async () => {
    const { FeishuAdapter, setFeishuVoiceReplyControl } = await import('../adapters/feishu');
    setFeishuVoiceReplyControl({
      getVoiceRepliesEnabled: () => false,
      setVoiceRepliesEnabled: vi.fn(async () => ({ enabled: true })),
    });
    const adapter = new FeishuAdapter({
      enabled: true,
      appId: 'cli_xxx',
      appSecret: 'secret',
      allowedChatIds: [],
      conversationId: 'conv-bound',
      voiceRepliesEnabled: false,
    });

    await adapter.start();
    await state.handlers.get('im.message.receive_v1')?.({
      sender: { sender_id: { open_id: 'ou_user' } },
      message: {
        message_id: 'om_startvoice',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'text',
        create_time: String(Date.now()),
        content: JSON.stringify({ text: '/startvoice' }),
      },
    });

    expect(state.sendChatMessage).not.toHaveBeenCalled();
    expect(state.sentMessages[0]).toMatchObject({
      receiveId: 'oc_chat',
      content: JSON.stringify({ text: 'Voice bubble replies are now on.' }),
      msgType: 'text',
    });
    setFeishuVoiceReplyControl(null);
  });

  it('accepts a top-level file_key from Feishu upload responses', async () => {
    const { FeishuAdapter } = await import('../adapters/feishu');
    state.uploadResponse = { file_key: 'file_key_top_level' };
    const adapter = new FeishuAdapter({
      enabled: true,
      appId: 'cli_xxx',
      appSecret: 'secret',
      allowedChatIds: [],
      conversationId: 'conv-bound',
      voiceRepliesEnabled: false,
    });

    await adapter.sendAudio('oc_chat', Buffer.from('opus-data'), 'reply.opus', { durationMs: 1200 });

    expect(state.sentMessages).toEqual([{
      receiveId: 'oc_chat',
      content: JSON.stringify({ file_key: 'file_key_top_level' }),
      msgType: 'audio',
    }]);
  });

  it('deduplicates retried Feishu message ids across adapter restarts in one app process', async () => {
    const { FeishuAdapter } = await import('../adapters/feishu');
    const first = new FeishuAdapter({
      enabled: true,
      appId: 'cli_xxx',
      appSecret: 'secret',
      allowedChatIds: [],
      conversationId: 'conv-bound',
      voiceRepliesEnabled: false,
    });
    await first.start();
    const event = {
      sender: { sender_id: { open_id: 'ou_user' } },
      message: {
        message_id: 'om_cross_restart',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'text',
        create_time: String(Date.now()),
        content: JSON.stringify({ text: 'hi' }),
      },
    };
    await state.handlers.get('im.message.receive_v1')?.(event);
    await vi.waitFor(() => expect(state.sendChatMessage).toHaveBeenCalledTimes(1));

    const second = new FeishuAdapter({
      enabled: true,
      appId: 'cli_xxx',
      appSecret: 'secret',
      allowedChatIds: [],
      conversationId: 'conv-bound',
      voiceRepliesEnabled: false,
    });
    await second.start();
    await state.handlers.get('im.message.receive_v1')?.(event);

    expect(state.sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it('drops stale Feishu messages replayed after startup', async () => {
    const { FeishuAdapter } = await import('../adapters/feishu');
    const adapter = new FeishuAdapter({
      enabled: true,
      appId: 'cli_xxx',
      appSecret: 'secret',
      allowedChatIds: [],
      conversationId: 'conv-bound',
      voiceRepliesEnabled: false,
    });

    await adapter.start();
    await state.handlers.get('im.message.receive_v1')?.({
      sender: { sender_id: { open_id: 'ou_user' } },
      message: {
        message_id: 'om_old',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'text',
        create_time: String(Date.now() - 10 * 60 * 1000),
        content: JSON.stringify({ text: 'old hi' }),
      },
    });

    expect(state.sendChatMessage).not.toHaveBeenCalled();
    expect(state.sentMessages).toEqual([]);
  });
});
