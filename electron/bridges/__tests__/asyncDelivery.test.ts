import { describe, expect, it, vi } from 'vitest';
import {
  consumePendingBridgeMessages,
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
});
