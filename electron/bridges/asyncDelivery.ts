export type BridgePlatform = 'discord' | 'wechat' | 'feishu' | 'minecraft';

export interface BridgeRoute {
  conversationId: string;
  platform: BridgePlatform;
  channelId?: string;
  userId?: string;
}

export type ReplyTarget =
  | { kind: 'desktop' }
  | { kind: 'discord'; channelId: string; userId?: string }
  | { kind: 'feishu'; chatId: string; userId?: string }
  | { kind: 'wechat'; userId: string; delivery: 'pending' }
  | { kind: 'minecraft'; player: string };

export interface BridgeDeliveryAdapter {
  sendDiscord?: (channelId: string, text: string) => Promise<void>;
  sendFeishu?: (chatId: string, text: string) => Promise<void>;
  sendMinecraft?: (player: string, text: string) => Promise<void>;
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

export function getReplyTargetForConversation(conversationId: string): ReplyTarget | undefined {
  const route = recentRoutes.get(conversationId);
  if (!route) return undefined;
  if (route.platform === 'discord' && route.channelId) {
    return { kind: 'discord', channelId: route.channelId, userId: route.userId };
  }
  if (route.platform === 'wechat' && route.userId) {
    return { kind: 'wechat', userId: route.userId, delivery: 'pending' };
  }
  if (route.platform === 'feishu' && route.channelId) {
    return { kind: 'feishu', chatId: route.channelId, userId: route.userId };
  }
  if (route.platform === 'minecraft' && route.userId) {
    return { kind: 'minecraft', player: route.userId };
  }
  return undefined;
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

  if (route.platform === 'feishu' && route.channelId && adapter.sendFeishu) {
    try {
      await adapter.sendFeishu(route.channelId, text);
      return 'sent';
    } catch (error) {
      console.warn('[BridgeDelivery] Feishu async delivery failed:', (error as Error).message);
      return 'failed';
    }
  }

  if (route.platform === 'minecraft' && route.userId && adapter.sendMinecraft) {
    try {
      await adapter.sendMinecraft(route.userId, text);
      return 'sent';
    } catch (error) {
      console.warn('[BridgeDelivery] Minecraft async delivery failed:', (error as Error).message);
      return 'failed';
    }
  }

  return 'none';
}

export async function deliverReplyToTarget(
  adapter: BridgeDeliveryAdapter,
  target: ReplyTarget | undefined,
  text: string,
): Promise<RouteResult> {
  if (!target || target.kind === 'desktop') return 'none';

  if (target.kind === 'discord') {
    if (!adapter.sendDiscord) return 'none';
    try {
      await adapter.sendDiscord(target.channelId, text);
      return 'sent';
    } catch (error) {
      console.warn('[BridgeDelivery] Discord reply delivery failed:', (error as Error).message);
      return 'failed';
    }
  }

  if (target.kind === 'feishu') {
    if (!adapter.sendFeishu) return 'none';
    try {
      await adapter.sendFeishu(target.chatId, text);
      return 'sent';
    } catch (error) {
      console.warn('[BridgeDelivery] Feishu reply delivery failed:', (error as Error).message);
      return 'failed';
    }
  }

  if (target.kind === 'minecraft') {
    if (!adapter.sendMinecraft) return 'none';
    try {
      await adapter.sendMinecraft(target.player, text);
      return 'sent';
    } catch (error) {
      console.warn('[BridgeDelivery] Minecraft reply delivery failed:', (error as Error).message);
      return 'failed';
    }
  }

  const key = pendingKey('wechat', target.userId);
  const messages = pendingMessages.get(key) ?? [];
  messages.push(text);
  pendingMessages.set(key, messages);
  return 'pending';
}
