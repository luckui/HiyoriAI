import { loadBridgeConfig } from './bridge.config';
import type { BridgeConfig } from './bridge.config';
import { DiscordAdapter } from './adapters/discord';
import { WeChatAdapter } from './adapters/wechat';
import { FeishuAdapter } from './adapters/feishu';
import type { BridgeAppConfig } from '../config/appConfig';

export type BridgePlatform = 'discord' | 'wechat' | 'feishu';

interface Adapter {
  name: BridgePlatform;
  stop(): Promise<void>;
}

const activeAdapters = new Map<BridgePlatform, Adapter>();

function normalizeBridgeConfig(config: BridgeConfig | BridgeAppConfig): BridgeConfig {
  const discordAllowedChannels = (config as BridgeConfig).discord.allowedChannels;
  return {
    discord: {
      enabled: config.discord.enabled,
      token: config.discord.token,
      allowedChannels: Array.isArray(discordAllowedChannels)
        ? discordAllowedChannels
        : String(discordAllowedChannels ?? '').split(',').map(s => s.trim()).filter(Boolean),
      conversationId: (config as BridgeConfig).discord.conversationId ?? '',
      proxyUrl: config.discord.proxyUrl,
    },
    wechat: {
      enabled: config.wechat.enabled,
      token: config.wechat.token,
      accountId: config.wechat.accountId,
      baseUrl: config.wechat.baseUrl,
      conversationId: (config as BridgeConfig).wechat.conversationId ?? '',
      sendChunkDelay: config.wechat.sendChunkDelay,
      voiceRepliesEnabled: Boolean(config.wechat.voiceRepliesEnabled),
      voiceReplyDelivery: config.wechat.voiceReplyDelivery === 'native_voice' ? 'native_voice' : 'audio_file',
    },
    feishu: {
      enabled: Boolean(config.feishu?.enabled),
      appId: config.feishu?.appId ?? '',
      appSecret: config.feishu?.appSecret ?? '',
      allowedChatIds: Array.isArray((config as BridgeConfig).feishu?.allowedChatIds)
        ? (config as BridgeConfig).feishu.allowedChatIds
        : String(config.feishu?.allowedChatIds ?? '').split(',').map(s => s.trim()).filter(Boolean),
      conversationId: (config as BridgeConfig).feishu?.conversationId ?? '',
      voiceRepliesEnabled: Boolean(config.feishu?.voiceRepliesEnabled),
    },
  };
}

export async function stopBridge(platform: BridgePlatform): Promise<void> {
  const adapter = activeAdapters.get(platform);
  if (!adapter) return;
  await adapter.stop().catch(e =>
    console.error(`[Bridges] ${platform} stop failed:`, (e as Error).message)
  );
  activeAdapters.delete(platform);
}

export async function applyBridgeRuntime(
  platform: BridgePlatform,
  config: BridgeConfig | BridgeAppConfig,
  conversationId: string,
): Promise<void> {
  const bridgeConfig = normalizeBridgeConfig(config);
  await stopBridge(platform);

  if (platform === 'discord') {
    const cfg = bridgeConfig.discord;
    if (!cfg.enabled) return;
    if (!cfg.token) {
      console.warn('[Bridges] Discord is enabled but token is missing; skipped startup.');
      return;
    }
    if (!cfg.conversationId) cfg.conversationId = conversationId;
    const adapter = new DiscordAdapter(cfg);
    try {
      await adapter.start();
      activeAdapters.set('discord', { name: 'discord', stop: () => adapter.stop() });
    } catch (e) {
      console.error('[Bridges] Discord startup failed:', (e as Error).message);
    }
    return;
  }

  const cfg = bridgeConfig.wechat;
  if (platform === 'wechat') {
    if (!cfg.enabled) return;
    if (!cfg.token || !cfg.accountId) {
      console.warn('[Bridges] WeChat is enabled but token/accountId is missing; scan QR code first.');
      return;
    }
    if (!cfg.conversationId) cfg.conversationId = conversationId;
    const adapter = new WeChatAdapter(cfg);
    try {
      await adapter.start();
      activeAdapters.set('wechat', { name: 'wechat', stop: () => adapter.stop() });
    } catch (e) {
      console.error('[Bridges] WeChat startup failed:', (e as Error).message);
    }
    return;
  }

  const feishu = bridgeConfig.feishu;
  if (!feishu.enabled) return;
  if (!feishu.appId || !feishu.appSecret) {
    console.warn('[Bridges] Feishu is enabled but appId/appSecret is missing.');
    return;
  }
  if (!feishu.conversationId) feishu.conversationId = conversationId;
  const adapter = new FeishuAdapter(feishu);
  try {
    await adapter.start();
    activeAdapters.set('feishu', { name: 'feishu', stop: () => adapter.stop() });
  } catch (e) {
    console.error('[Bridges] Feishu startup failed:', (e as Error).message);
  }
}

export async function startBridges(
  conversationId: string,
  config: BridgeConfig | BridgeAppConfig = loadBridgeConfig(),
): Promise<void> {
  await applyBridgeRuntime('discord', config, conversationId);
  await applyBridgeRuntime('wechat', config, conversationId);
  await applyBridgeRuntime('feishu', config, conversationId);
}

export async function stopBridges(): Promise<void> {
  await Promise.allSettled(
    Array.from(activeAdapters.keys()).map(platform => stopBridge(platform)),
  );
  activeAdapters.clear();
}
