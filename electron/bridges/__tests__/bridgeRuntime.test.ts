import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapterState = vi.hoisted(() => ({
  discordStarts: 0,
  discordStops: 0,
  wechatStarts: 0,
  wechatStops: 0,
  discordConfigs: [] as unknown[],
  wechatConfigs: [] as unknown[],
}));

vi.mock('../adapters/discord', () => ({
  DiscordAdapter: class {
    static activeClient: unknown = null;
    constructor(cfg: unknown) {
      adapterState.discordConfigs.push(cfg);
    }
    async start() {
      adapterState.discordStarts++;
    }
    async stop() {
      adapterState.discordStops++;
    }
  },
}));

vi.mock('../adapters/wechat', () => ({
  WeChatAdapter: class {
    static activeAdapter: unknown = null;
    constructor(cfg: unknown) {
      adapterState.wechatConfigs.push(cfg);
    }
    async start() {
      adapterState.wechatStarts++;
    }
    async stop() {
      adapterState.wechatStops++;
    }
  },
}));

vi.mock('../bridge.config', () => ({
  loadBridgeConfig: () => ({
    discord: { enabled: false, token: '', allowedChannels: [], conversationId: '', proxyUrl: '' },
    wechat: { enabled: false, token: '', accountId: '', baseUrl: '', conversationId: '', sendChunkDelay: 0.35 },
  }),
}));

function config(overrides: {
  discord?: Partial<{
    enabled: boolean;
    token: string;
    allowedChannels: string;
    proxyUrl: string;
  }>;
  wechat?: Partial<{
    enabled: boolean;
    token: string;
    accountId: string;
    baseUrl: string;
    sendChunkDelay: number;
  }>;
} = {}) {
  return {
    discord: {
      enabled: true,
      token: 'discord-token',
      allowedChannels: '1, 2',
      proxyUrl: '',
      ...overrides.discord,
    },
    wechat: {
      enabled: true,
      token: 'wechat-token',
      accountId: 'wechat-account',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      sendChunkDelay: 0.35,
      ...overrides.wechat,
    },
  };
}

describe('bridge runtime', () => {
  beforeEach(async () => {
    const runtime = await import('../index');
    await runtime.stopBridges();
    adapterState.discordStarts = 0;
    adapterState.discordStops = 0;
    adapterState.wechatStarts = 0;
    adapterState.wechatStops = 0;
    adapterState.discordConfigs = [];
    adapterState.wechatConfigs = [];
  });

  it('applies one platform without restarting the other platform', async () => {
    const runtime = await import('../index');
    await runtime.applyBridgeRuntime('discord', config(), 'conv-1');
    await runtime.applyBridgeRuntime('wechat', config(), 'conv-1');

    await runtime.applyBridgeRuntime('discord', { ...config(), discord: { ...config().discord, enabled: false } }, 'conv-1');

    expect(adapterState.discordStarts).toBe(1);
    expect(adapterState.discordStops).toBe(1);
    expect(adapterState.wechatStarts).toBe(1);
    expect(adapterState.wechatStops).toBe(0);
  });

  it('normalizes comma-separated Discord channel ids from app config', async () => {
    const runtime = await import('../index');

    await runtime.applyBridgeRuntime('discord', config(), 'conv-1');

    expect(adapterState.discordConfigs[0]).toMatchObject({
      allowedChannels: ['1', '2'],
      conversationId: 'conv-1',
    });
  });

  it('switches WeChat accounts without restarting Discord', async () => {
    const runtime = await import('../index');

    await runtime.applyBridgeRuntime('discord', config(), 'conv-1');
    await runtime.applyBridgeRuntime('wechat', config({ wechat: { accountId: 'wechat-account-1' } }), 'conv-1');
    await runtime.applyBridgeRuntime('wechat', config({ wechat: { accountId: 'wechat-account-2' } }), 'conv-1');

    expect(adapterState.discordStarts).toBe(1);
    expect(adapterState.discordStops).toBe(0);
    expect(adapterState.wechatStarts).toBe(2);
    expect(adapterState.wechatStops).toBe(1);
    expect(adapterState.wechatConfigs.at(-1)).toMatchObject({
      accountId: 'wechat-account-2',
      conversationId: 'conv-1',
    });
  });
});
