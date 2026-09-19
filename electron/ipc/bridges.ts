/**
 * 平台桥接设置：Discord / 飞书 / 微信的配置读写、在线状态、扫码登录，以及语音回复开关。
 */

import { ipcMain } from 'electron';
import * as lark from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';
import { applyBridgeRuntime } from '../bridges/index';
import { DiscordAdapter } from '../bridges/adapters/discord';
import { FeishuAdapter, setFeishuVoiceReplyControl } from '../bridges/adapters/feishu';
import { WeChatAdapter, qrLogin, setWeChatVoiceReplyControl } from '../bridges/adapters/wechat';
import type { BridgeAppConfig } from '../config/appConfig';
import { getBridgeConfig, persistAppConfig, setBridgeConfig } from '../config/runtimeConfig';
import { enableTTSForVoiceReplies } from '../ttsRuntime';
import { defaultConversationId } from './chat';

type VoiceBridge = 'wechat' | 'feishu';
type BridgePlatform = keyof BridgeAppConfig;

/**
 * 开关某个平台的语音回复。开启时会自动开启并拉起 TTS；TTS 起不来则保持关闭并返回原因。
 * 设置页、平台内的 /voice 命令共用这一个入口。
 */
async function setVoiceRepliesEnabled(
  platform: VoiceBridge,
  enabled: boolean,
  source: string,
): Promise<{ enabled: boolean; detail?: string }> {
  let nextEnabled = enabled;
  let detail: string | undefined;
  if (enabled) {
    const runtime = await enableTTSForVoiceReplies(source);
    if (!runtime.ok) {
      nextEnabled = false;
      detail = runtime.detail;
      console.warn(`[BridgeVoice] ${platform} voice replies disabled because TTS runtime failed:`, runtime.detail);
    }
  }
  const current = getBridgeConfig();
  setBridgeConfig({ ...current, [platform]: { ...current[platform], voiceRepliesEnabled: nextEnabled } });
  persistAppConfig();
  return { enabled: nextEnabled, detail };
}

async function restartBridge(platform: BridgePlatform): Promise<void> {
  await applyBridgeRuntime(platform, getBridgeConfig(), defaultConversationId());
}

export function registerBridgeIpc(): void {
  setWeChatVoiceReplyControl({
    getVoiceRepliesEnabled: () => getBridgeConfig().wechat.voiceRepliesEnabled,
    setVoiceRepliesEnabled: (enabled) => setVoiceRepliesEnabled('wechat', enabled, 'wechat command'),
  });
  setFeishuVoiceReplyControl({
    getVoiceRepliesEnabled: () => getBridgeConfig().feishu.voiceRepliesEnabled,
    setVoiceRepliesEnabled: (enabled) => setVoiceRepliesEnabled('feishu', enabled, 'feishu command'),
  });

  // ── Discord ──────────────────────────────────────────────
  ipcMain.handle('discord:get', () => ({ ...getBridgeConfig().discord }));
  ipcMain.handle('discord:status', () => (DiscordAdapter.activeClient !== null ? 'online' : 'offline'));
  ipcMain.handle('discord:save', async (_e, cfg: BridgeAppConfig['discord']) => {
    setBridgeConfig({ ...getBridgeConfig(), discord: cfg });
    persistAppConfig();
    await restartBridge('discord').catch((e) => console.error('[Discord] apply failed:', (e as Error).message));
  });

  // ── 飞书 ────────────────────────────────────────────────
  ipcMain.handle('feishu:get', () => ({ ...getBridgeConfig().feishu }));
  ipcMain.handle('feishu:status', () => (FeishuAdapter.activeAdapter !== null ? 'online' : 'offline'));
  ipcMain.handle('feishu:save', async (_e, cfg: Omit<BridgeAppConfig['feishu'], 'voiceRepliesEnabled'> & { voiceRepliesEnabled?: boolean }) => {
    setBridgeConfig({ ...getBridgeConfig(), feishu: { ...cfg, voiceRepliesEnabled: false } });
    await setVoiceRepliesEnabled('feishu', Boolean(cfg.voiceRepliesEnabled), 'feishu save apply');
    await restartBridge('feishu').catch((e) => console.error('[Feishu] apply failed:', (e as Error).message));
  });

  ipcMain.handle('feishu:register-app', async (event) => {
    try {
      const result = await lark.registerApp({
        source: 'hiyori',
        createOnly: true,
        appPreset: {
          name: 'Hiyori',
          desc: 'Hiyori desktop assistant Feishu bridge',
        },
        addons: {
          scopes: { tenant: ['im:message:send_as_bot', 'im:resource'] },
          events: { items: { tenant: ['im.message.receive_v1'] } },
        },
        onQRCodeReady: async (info) => {
          const qrcodeUrl = await QRCode.toDataURL(info.url, { width: 256, margin: 2 });
          event.sender.send('feishu:register-app-update', {
            status: 'pending',
            url: info.url,
            qrcodeUrl,
            expireIn: info.expireIn,
          });
        },
        onStatusChange: (info) => {
          event.sender.send('feishu:register-app-update', {
            status: info.status,
            interval: info.interval,
          });
        },
      });
      event.sender.send('feishu:register-app-update', { status: 'confirmed', appId: result.client_id });
      return { success: true, appId: result.client_id, appSecret: result.client_secret };
    } catch (error) {
      const detail = (error as { description?: string })?.description ?? (error as Error).message ?? String(error);
      event.sender.send('feishu:register-app-update', { status: 'error', error: detail });
      return { success: false, error: detail };
    }
  });

  // ── 微信 ────────────────────────────────────────────────
  ipcMain.handle('wechat:get', () => ({ ...getBridgeConfig().wechat }));
  ipcMain.handle('wechat:status', () => (WeChatAdapter.activeAdapter !== null ? 'online' : 'offline'));
  ipcMain.handle('wechat:save', async (_e, cfg: Partial<BridgeAppConfig['wechat']> & { enabled: boolean }) => {
    const current = getBridgeConfig().wechat;
    setBridgeConfig({
      ...getBridgeConfig(),
      wechat: {
        ...current,
        enabled: cfg.enabled,
        token: cfg.token ?? current.token,
        accountId: cfg.accountId ?? current.accountId,
        baseUrl: cfg.baseUrl ?? current.baseUrl,
        sendChunkDelay: cfg.sendChunkDelay ?? current.sendChunkDelay,
        voiceReplyDelivery: cfg.voiceReplyDelivery === 'native_voice' || cfg.voiceReplyDelivery === 'audio_file'
          ? cfg.voiceReplyDelivery
          : current.voiceReplyDelivery,
      },
    });
    await setVoiceRepliesEnabled('wechat', cfg.voiceRepliesEnabled ?? current.voiceRepliesEnabled, 'wechat save apply');
    await restartBridge('wechat').catch((e) => console.error('[WeChat] apply failed:', (e as Error).message));
  });

  ipcMain.handle('wechat:qr-login', async (event) => {
    try {
      for await (const state of qrLogin()) {
        event.sender.send('wechat:qr-login-update', state);
        if (state.status === 'confirmed' && state.credentials) {
          const creds = state.credentials;
          setBridgeConfig({
            ...getBridgeConfig(),
            wechat: {
              ...getBridgeConfig().wechat,
              enabled: true,
              token: creds.token,
              accountId: creds.accountId,
              baseUrl: creds.baseUrl,
            },
          });
          persistAppConfig();
          // 登录成功后自动启动 adapter
          try {
            await restartBridge('wechat');
            console.log('[WeChat QR] adapter 已自动启动');
          } catch (e) {
            console.error('[WeChat QR] 自动启动 adapter 失败:', (e as Error).message);
          }
          return { success: true, credentials: creds };
        }
        if (state.status === 'error' || state.status === 'expired') {
          return { success: false, error: state.error };
        }
      }
      return { success: false, error: '登录超时' };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
