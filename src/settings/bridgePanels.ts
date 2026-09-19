/** 平台桥接设置：Discord / 飞书 / 微信 */

import type { DiscordConfig, FeishuConfig } from '../../shared/types/config';
import type { WeChatAPI } from '../../shared/preloadApi';
import { clearSettingsDirty, markSettingsDirty, registerSection, type SettingsSection } from './sections';
import { bindPasswordToggle, button, input, renderBridgeStatus, runWithButton } from './dom';

/** 保存桥接配置：保存后给 bot 2 秒启动时间再刷新在线状态 */
async function saveBridge(
  section: SettingsSection,
  saveButtonId: string,
  persist: () => Promise<void>,
  refreshStatus: () => Promise<void>,
): Promise<void> {
  const ok = await runWithButton(
    button(saveButtonId),
    { busy: '保存中…', done: '✓ 已保存', failed: '保存失败' },
    async () => {
      await persist();
      clearSettingsDirty(section);
    },
    2000,
  );
  if (ok) setTimeout(() => void refreshStatus(), 2000);
}

// ── Discord ──────────────────────────────────────────────

async function refreshDiscordStatus(): Promise<void> {
  if (window.discordAPI) renderBridgeStatus('dc', await window.discordAPI.getStatus());
}

async function loadDiscord(): Promise<void> {
  if (!window.discordAPI) return;
  const dc = await window.discordAPI.get();
  input('dc-enabled').checked = dc.enabled;
  input('dc-token').value = dc.token;
  input('dc-channels').value = dc.allowedChannels;
  input('dc-proxy').value = dc.proxyUrl;
  await refreshDiscordStatus();
}

async function saveDiscord(): Promise<void> {
  const api = window.discordAPI;
  if (!api) return;
  const cfg: DiscordConfig = {
    enabled: input('dc-enabled').checked,
    token: input('dc-token').value.trim(),
    allowedChannels: input('dc-channels').value.trim(),
    proxyUrl: input('dc-proxy').value.trim(),
  };
  await saveBridge('discord', 'dc-save-btn', () => api.save(cfg), refreshDiscordStatus);
}

// ── 飞书 ────────────────────────────────────────────────

async function refreshFeishuStatus(): Promise<void> {
  if (window.feishuAPI) renderBridgeStatus('fs', await window.feishuAPI.getStatus());
}

async function loadFeishu(): Promise<void> {
  if (!window.feishuAPI) return;
  const fs = await window.feishuAPI.get();
  input('fs-enabled').checked = fs.enabled;
  input('fs-app-id').value = fs.appId;
  input('fs-app-secret').value = fs.appSecret;
  input('fs-chat-ids').value = fs.allowedChatIds;
  input('fs-voice-replies-enabled').checked = Boolean(fs.voiceRepliesEnabled);
  await refreshFeishuStatus();
}

async function saveFeishu(): Promise<void> {
  const api = window.feishuAPI;
  if (!api) return;
  const cfg: FeishuConfig = {
    enabled: input('fs-enabled').checked,
    appId: input('fs-app-id').value.trim(),
    appSecret: input('fs-app-secret').value.trim(),
    allowedChatIds: input('fs-chat-ids').value.trim(),
    voiceRepliesEnabled: input('fs-voice-replies-enabled').checked,
  };
  await saveBridge('feishu', 'fs-save-btn', () => api.save(cfg), refreshFeishuStatus);
}

/** 扫码创建飞书应用，成功后把凭据填入表单（需用户再点保存） */
async function startFeishuRegisterApp(): Promise<void> {
  if (!window.feishuAPI) return;
  const btn = button('fs-register-btn');
  const display = document.getElementById('fs-register-display') as HTMLElement;
  const statusText = document.getElementById('fs-register-status') as HTMLElement;
  const img = document.getElementById('fs-register-img') as HTMLImageElement;
  const link = document.getElementById('fs-register-link') as HTMLAnchorElement;

  btn.disabled = true;
  btn.textContent = '创建中...';
  display.style.display = 'block';
  statusText.textContent = '正在生成飞书授权二维码...';

  window.feishuAPI.onRegisterAppUpdate((state: any) => {
    if (state.qrcodeUrl) img.src = state.qrcodeUrl;
    if (state.url) {
      link.href = state.url;
      link.textContent = '打不开二维码时点这里';
      link.style.display = 'inline';
    }
    if (state.status === 'pending') statusText.textContent = '请使用飞书扫码确认创建应用。';
    else if (state.status === 'confirmed') statusText.textContent = '应用创建成功，已填入凭据，请保存设置。';
    else if (state.status === 'error') statusText.textContent = `创建失败：${state.error ?? '未知错误'}`;
    else if (state.status) statusText.textContent = `飞书授权状态：${state.status}`;
  });

  const result = await window.feishuAPI.registerApp();
  btn.disabled = false;
  btn.textContent = '二维码创建应用';
  if (result.success && result.appId && result.appSecret) {
    input('fs-enabled').checked = true;
    input('fs-app-id').value = result.appId;
    input('fs-app-secret').value = result.appSecret;
    markSettingsDirty('feishu');
    return;
  }
  statusText.textContent = `创建失败：${result.error ?? '未知错误'}`;
}

// ── 微信 ────────────────────────────────────────────────

async function refreshWeChatStatus(): Promise<void> {
  if (window.wechatAPI) renderBridgeStatus('wc', await window.wechatAPI.getStatus());
}

async function loadWeChat(): Promise<void> {
  if (!window.wechatAPI) return;
  const wc = await window.wechatAPI.get();
  input('wc-enabled').checked = wc.enabled;
  input('wc-voice-replies-enabled').checked = Boolean(wc.voiceRepliesEnabled);
  input('wc-chunk-delay').value = String(wc.sendChunkDelay ?? 0.35);

  // 已登录显示账号信息，否则显示扫码登录
  const loggedIn = Boolean(wc.token && wc.accountId);
  if (loggedIn) {
    input('wc-account-id').value = wc.accountId!;
    input('wc-token-preview').value = wc.token!.slice(0, 8) + '***';
  }
  (document.getElementById('wc-account-section') as HTMLElement).style.display = loggedIn ? 'block' : 'none';
  (document.getElementById('wc-qr-section') as HTMLElement).style.display = loggedIn ? 'none' : 'block';

  await refreshWeChatStatus();
}

async function saveWeChat(): Promise<void> {
  const api = window.wechatAPI;
  if (!api) return;
  const current = await api.get().catch(() => null);
  const cfg: Parameters<WeChatAPI['save']>[0] = {
    enabled: input('wc-enabled').checked,
    voiceRepliesEnabled: input('wc-voice-replies-enabled').checked,
    voiceReplyDelivery: current?.voiceReplyDelivery ?? 'audio_file',
    sendChunkDelay: parseFloat(input('wc-chunk-delay').value),
  };
  await saveBridge('wechat', 'wc-save-btn', () => api.save(cfg), refreshWeChatStatus);
}

async function startWeChatQRLogin(): Promise<void> {
  if (!window.wechatAPI) return;
  const qrSection = document.getElementById('wc-qr-section') as HTMLElement | null;
  const btn = button('wc-qr-start-btn');
  const display = document.getElementById('wc-qr-display') as HTMLElement;
  const statusText = document.getElementById('wc-qr-status') as HTMLElement;
  const img = document.getElementById('wc-qr-img') as HTMLImageElement;

  if (qrSection) qrSection.style.display = 'block';
  btn.disabled = true;
  btn.textContent = '启动中…';
  display.style.display = 'block';
  statusText.textContent = '正在获取二维码...';

  const showStatus = (text: string, color: string) => {
    statusText.textContent = text;
    statusText.style.color = color;
  };
  const enableRetry = (label: string) => {
    btn.disabled = false;
    btn.textContent = label;
  };

  window.wechatAPI.onQRLoginUpdate((state: any) => {
    console.log('[WeChat QR]', state);
    if (state.qrcodeUrl) img.src = state.qrcodeUrl;
    if (state.status === 'pending') {
      showStatus('✨ 请使用微信扫描上方二维码', '#4CAF50');
    } else if (state.status === 'scanned') {
      showStatus('✅ 已扫码，请在微信里确认授权...', '#2196F3');
    } else if (state.status === 'confirmed') {
      showStatus('🎉 登录成功！正在保存凭证...', '#4CAF50');
      setTimeout(() => {
        // 扫码登录在主进程里已经保存并启动了微信桥接，这里只需刷新表单
        void loadWeChat().then(() => clearSettingsDirty('wechat'));
        display.style.display = 'none';
        enableRetry('🔑 启动二维码登录');
      }, 2000);
    } else if (state.status === 'expired') {
      showStatus(`⚠️ 二维码已过期：${state.error || '请重试'}`, '#FF9800');
      enableRetry('🔄 重新获取二维码');
    } else if (state.status === 'error') {
      showStatus(`❌ 登录失败：${state.error || '未知错误'}`, '#F44336');
      enableRetry('🔄 重试');
    }
  });

  try {
    await window.wechatAPI.startQRLogin();
  } catch (err) {
    showStatus(`❌ 启动失败：${err}`, '#F44336');
    enableRetry('🔄 重试');
  }
}

export function initBridgePanels(): void {
  registerSection('discord', { load: loadDiscord, save: saveDiscord });
  registerSection('feishu', { load: loadFeishu, save: saveFeishu });
  registerSection('wechat', { load: loadWeChat, save: saveWeChat });

  document.getElementById('dc-save-btn')?.addEventListener('click', () => void saveDiscord());
  bindPasswordToggle('dc-token', 'dc-eye-btn');

  document.getElementById('fs-save-btn')?.addEventListener('click', () => void saveFeishu());
  document.getElementById('fs-register-btn')?.addEventListener('click', () => void startFeishuRegisterApp());
  bindPasswordToggle('fs-app-secret', 'fs-eye-btn');

  document.getElementById('wc-save-btn')?.addEventListener('click', () => void saveWeChat());
  document.getElementById('wc-qr-start-btn')?.addEventListener('click', () => void startWeChatQRLogin());
  document.getElementById('wc-switch-account-btn')?.addEventListener('click', () => void startWeChatQRLogin());
}
