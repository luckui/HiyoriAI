export type BridgePlatform = 'discord' | 'wechat';

export interface BridgeRoute {
  conversationId: string;
  platform: BridgePlatform;
  channelId?: string;
  userId?: string;
}

export interface BridgeDeliveryAdapter {
  sendDiscord?: (channelId: string, text: string) => Promise<void>;
}

type RouteResult = 'sent' | 'pending' | 'none' | 'failed';

const recentRoutes = new Map<string, BridgeRoute>();
const pendingMessages = new Map<string, string[]>();

function pendingKey(platform: BridgePlatform, id: string): string {
  return `${platform}:${id}`;
}

export function noteBridgeInboundMessage(route: BridgeRoute): void {
  recentRoutes.set(route.conversationId, route);
}

export function consumePendingBridgeMessages(platform: BridgePlatform, id: string): string[] {
  const key = pendingKey(platform, id);
  const messages = pendingMessages.get(key) ?? [];
  pendingMessages.delete(key);
  return messages;
}

export async function routeAsyncBridgeMessage(
  adapter: BridgeDeliveryAdapter,
  conversationId: string,
  text: string
): Promise<RouteResult> {
  const route = recentRoutes.get(conversationId);
  if (!route) return 'none';

  if (route.platform === 'discord' && route.channelId && adapter.sendDiscord) {
    try {
      await adapter.sendDiscord(route.channelId, text);
      return 'sent';
    } catch (error) {
      console.warn('[BridgeDelivery] Discord async delivery failed:', (error as Error).message);
      return 'failed';
    }
  }

  if (route.platform === 'wechat' && route.userId) {
    const key = pendingKey('wechat', route.userId);
    const messages = pendingMessages.get(key) ?? [];
    messages.push(text);
    pendingMessages.set(key, messages);
    return 'pending';
  }

  return 'none';
}
