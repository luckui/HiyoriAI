/** 直播设置：B 站房间号与登录 Cookie、连接开关、打开弹幕姬 */

import type { LiveConfig, LiveStatus } from '../../shared/types/live';
import { clearSettingsDirty, registerSection } from './sections';
import { bindPasswordToggle, button, input, runWithButton } from './dom';

const STATE_TEXT: Record<LiveStatus['state'], string> = {
  idle: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  reconnecting: '重连中…',
  error: '连接失败',
};

function renderStatus(status: LiveStatus): void {
  const connected = status.state === 'connected';
  const dot = document.getElementById('live-status-dot');
  const text = document.getElementById('live-status-text');
  if (dot) dot.className = `s-status-dot ${connected ? 's-status-on' : 's-status-off'}`;
  if (text) {
    const parts = [STATE_TEXT[status.state]];
    if (status.room?.anchorName) parts.push(status.room.anchorName);
    if (connected && !status.loggedIn) parts.push('未登录，观众名会被打码');
    if (status.lastError && status.state !== 'idle') parts.push(status.lastError);
    text.textContent = parts.join(' · ');
  }
  const btn = button('live-connect-btn');
  if (!btn.disabled) btn.textContent = status.state === 'idle' ? '连接' : '断开';
}

function formConfig(saved: LiveConfig): LiveConfig {
  return {
    ...saved,
    platform: 'bilibili',
    roomId: parseInt(input('live-room-id').value.replace(/\D/g, ''), 10) || 0,
    cookie: input('live-cookie').value.trim(),
  };
}

function renderMemory(stats: { viewers: number; streams: number; memes: number; tastes: number } | null): void {
  const el = document.getElementById('live-memory-stats');
  if (el) el.textContent = stats ? `记得 ${stats.viewers} 位观众、${stats.streams} 场直播、${stats.memes} 个梗、${stats.tastes} 条喜好` : '直播记忆不可用';
}

async function clearMemory(): Promise<void> {
  const api = window.liveAPI;
  if (!api || !confirm('清空直播记忆？观众档案、每场回顾、梗和她的喜好都会删掉，不能恢复。')) return;
  renderMemory(await api.clearMemory());
}

async function load(): Promise<void> {
  if (!window.liveAPI) return;
  void window.liveAPI.getMemoryStats().then(renderMemory);
  const cfg = await window.liveAPI.getConfig();
  input('live-room-id').value = cfg.roomId ? String(cfg.roomId) : '';
  input('live-cookie').value = cfg.cookie;
  renderStatus(await window.liveAPI.getStatus());
}

async function save(): Promise<void> {
  const api = window.liveAPI;
  if (!api) return;
  await runWithButton(button('live-save-btn'), { busy: '保存中…', done: '✓ 已保存', failed: '保存失败' }, async () => {
    renderStatus(await api.saveConfig(formConfig(await api.getConfig())));
    clearSettingsDirty('live');
  });
}

async function toggleConnection(): Promise<void> {
  const api = window.liveAPI;
  if (!api) return;
  const status = await api.getStatus();
  if (status.state !== 'idle') {
    renderStatus(await api.disconnect());
    return;
  }
  // 先保存表单，保证按眼前填的连
  renderStatus(await api.saveConfig(formConfig(await api.getConfig())));
  clearSettingsDirty('live');
  const result = await api.connect();
  renderStatus(result.status);
  if (!result.ok && result.detail) {
    const text = document.getElementById('live-status-text');
    if (text) text.textContent = result.detail;
  }
}

export function initLivePanel(): void {
  registerSection('live', { load, save });
  bindPasswordToggle('live-cookie', 'live-eye-btn');
  document.getElementById('live-save-btn')?.addEventListener('click', () => void save());
  document.getElementById('live-connect-btn')?.addEventListener('click', () => void toggleConnection());
  document.getElementById('live-window-btn')?.addEventListener('click', () => void window.liveAPI?.openWindow());
  document.getElementById('live-memory-clear')?.addEventListener('click', () => void clearMemory());
  window.liveAPI?.onUpdate((update) => renderStatus(update.status));
}
