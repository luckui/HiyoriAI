import { describe, expect, it, vi } from 'vitest';
import {
  consumePendingBridgeMessages,
  deliverReplyToTarget,
  getReplyTargetForConversation,
  noteBridgeInboundMessage,
  routeAsyncBridgeMessage,
  type BridgeDeliveryAdapter,
} from '../asyncDelivery';

describe('async bridge delivery', () => {
  it('sends async results directly to Discord when the last source supports push', async () => {
    const sendDiscord = vi.fn(async () => {});
    const adapter: BridgeDeliveryAdapter = { sendDiscord };

    noteBridgeInboundMessage({
      conversationId: 'conv-discord',
      platform: 'discord',
      channelId: 'channel-1',
      userId: 'alice',
    });

    const routed = await routeAsyncBridgeMessage(adapter, 'conv-discord', 'Codex finished');

    expect(routed).toBe('sent');
    expect(sendDiscord).toHaveBeenCalledWith('channel-1', 'Codex finished');
  });

  it('stores async results as pending messages for WeChat', async () => {
    const adapter: BridgeDeliveryAdapter = {};

    noteBridgeInboundMessage({
      conversationId: 'conv-wechat',
      platform: 'wechat',
      userId: 'wx-user',
    });

    const routed = await routeAsyncBridgeMessage(adapter, 'conv-wechat', 'Codex finished');
    const pending = consumePendingBridgeMessages('wechat', 'wx-user');

    expect(routed).toBe('pending');
    expect(pending).toEqual(['Codex finished']);
  });

  it('sends async results directly to Feishu when the last source supports push', async () => {
    const sendFeishu = vi.fn(async () => {});
    const adapter: BridgeDeliveryAdapter = { sendFeishu };

    noteBridgeInboundMessage({
      conversationId: 'conv-feishu',
      platform: 'feishu',
      channelId: 'chat-1',
      userId: 'open-id-1',
    });

    const routed = await routeAsyncBridgeMessage(adapter, 'conv-feishu', 'Codex finished');

    expect(routed).toBe('sent');
    expect(sendFeishu).toHaveBeenCalledWith('chat-1', 'Codex finished');
  });

  it('captures a reply target from the latest bridge route', () => {
    noteBridgeInboundMessage({
      conversationId: 'conv-target',
      platform: 'discord',
      channelId: 'channel-2',
      userId: 'bob',
    });

    expect(getReplyTargetForConversation('conv-target')).toEqual({
      kind: 'discord',
      channelId: 'channel-2',
      userId: 'bob',
    });
  });

  it('captures a Feishu reply target from the latest bridge route', () => {
    noteBridgeInboundMessage({
      conversationId: 'conv-feishu-target',
      platform: 'feishu',
      channelId: 'chat-2',
      userId: 'open-id-2',
    });

    expect(getReplyTargetForConversation('conv-feishu-target')).toEqual({
      kind: 'feishu',
      chatId: 'chat-2',
      userId: 'open-id-2',
    });
  });

  it('delivers final replies to the supplied Discord target', async () => {
    const sendDiscord = vi.fn(async () => {});
    const adapter: BridgeDeliveryAdapter = { sendDiscord };

    const delivered = await deliverReplyToTarget(adapter, {
      kind: 'discord',
      channelId: 'channel-3',
      userId: 'carol',
    }, 'Final answer');

    expect(delivered).toBe('sent');
    expect(sendDiscord).toHaveBeenCalledWith('channel-3', 'Final answer');
  });

  it('delivers final replies to the supplied Feishu target', async () => {
    const sendFeishu = vi.fn(async () => {});
    const adapter: BridgeDeliveryAdapter = { sendFeishu };

    const delivered = await deliverReplyToTarget(adapter, {
      kind: 'feishu',
      chatId: 'chat-3',
      userId: 'open-id-3',
    }, 'Final answer');

    expect(delivered).toBe('sent');
    expect(sendFeishu).toHaveBeenCalledWith('chat-3', 'Final answer');
  });

  it('queues final replies for a WeChat pending target', async () => {
    const delivered = await deliverReplyToTarget({}, {
      kind: 'wechat',
      userId: 'wx-user-2',
      delivery: 'pending',
    }, 'Final answer');

    expect(delivered).toBe('pending');
    expect(consumePendingBridgeMessages('wechat', 'wx-user-2')).toEqual(['Final answer']);
  });

  it('delivers final replies to the supplied Minecraft player', async () => {
    const sendMinecraft = vi.fn(async () => {});

    const delivered = await deliverReplyToTarget({ sendMinecraft }, {
      kind: 'minecraft',
      player: 'GeoLingua',
    }, 'Final answer');

    expect(delivered).toBe('sent');
    expect(sendMinecraft).toHaveBeenCalledWith('GeoLingua', 'Final answer');
  });
});
