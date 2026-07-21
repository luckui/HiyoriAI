export interface DiscordBridgeConfig {
  enabled: boolean;
  token: string;
  allowedChannels: string[];
  conversationId: string;
  proxyUrl: string;
}

export interface WeChatBridgeConfig {
  enabled: boolean;
  token: string;
  accountId: string;
  baseUrl: string;
  conversationId: string;
  sendChunkDelay: number;
  voiceRepliesEnabled: boolean;
  voiceReplyDelivery: 'audio_file' | 'native_voice';
}

export interface FeishuBridgeConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  allowedChatIds: string[];
  conversationId: string;
  voiceRepliesEnabled: boolean;
}

export interface BridgeConfig {
  discord: DiscordBridgeConfig;
  wechat: WeChatBridgeConfig;
  feishu: FeishuBridgeConfig;
}

function parseBool(val: string | undefined, def = false): boolean {
  if (!val) return def;
  return val.toLowerCase() === 'true' || val === '1';
}

function parseList(val: string | undefined): string[] {
  if (!val) return [];
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

export function loadBridgeConfig(): BridgeConfig {
  const cfg: BridgeConfig = {
    discord: {
      enabled: parseBool(process.env['DISCORD_ENABLED']),
      token: process.env['DISCORD_TOKEN'] ?? '',
      allowedChannels: parseList(process.env['DISCORD_ALLOWED_CHANNELS']),
      conversationId: process.env['DISCORD_CONVERSATION_ID'] ?? '',
      proxyUrl: process.env['DISCORD_PROXY'] ?? '',
    },
    wechat: {
      enabled: parseBool(process.env['WECHAT_ENABLED']),
      token: process.env['WECHAT_TOKEN'] ?? '',
      accountId: process.env['WECHAT_ACCOUNT_ID'] ?? '',
      baseUrl: process.env['WECHAT_BASE_URL'] ?? 'https://ilinkai.weixin.qq.com',
      conversationId: process.env['WECHAT_CONVERSATION_ID'] ?? '',
      sendChunkDelay: parseFloat(process.env['WECHAT_SEND_CHUNK_DELAY'] ?? '0.35'),
      voiceRepliesEnabled: parseBool(process.env['WECHAT_VOICE_REPLIES_ENABLED']),
      voiceReplyDelivery: process.env['WECHAT_VOICE_REPLY_DELIVERY'] === 'native_voice' ? 'native_voice' : 'audio_file',
    },
    feishu: {
      enabled: parseBool(process.env['FEISHU_ENABLED']),
      appId: process.env['FEISHU_APP_ID'] ?? '',
      appSecret: process.env['FEISHU_APP_SECRET'] ?? '',
      allowedChatIds: parseList(process.env['FEISHU_ALLOWED_CHAT_IDS']),
      conversationId: process.env['FEISHU_CONVERSATION_ID'] ?? '',
      voiceRepliesEnabled: parseBool(process.env['FEISHU_VOICE_REPLIES_ENABLED']),
    },
  };

  console.log('[Bridges] config loaded:', {
    discordEnabled: cfg.discord.enabled,
    hasDiscordToken: !!cfg.discord.token,
    discordProxy: cfg.discord.proxyUrl || '(none)',
    wechatEnabled: cfg.wechat.enabled,
    hasWeChatToken: !!cfg.wechat.token,
    feishuEnabled: cfg.feishu.enabled,
    feishuAppId: cfg.feishu.appId ? `${cfg.feishu.appId.slice(0, 8)}***` : '(not configured)',
  });
  return cfg;
}
