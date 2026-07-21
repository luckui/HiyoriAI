import { LAppDelegate } from './lappdelegate';
import * as LAppDefine from './lappdefine';
import { initChat } from './chat';
import { refreshAvatarStudio } from './avatarStudio';
import { initSettings } from './settings';
import { initBeatDetector } from './beatDetector';
import { registerTTSPlayListener } from './ttsPlayer';
import './style.css';

// ─── 打包后用相对路径：electron-vite 将 public/ 输出到 out/renderer/ ──
// file:// 协议下 /Resources/ 会变成 C:\Resources\，改用 ./Resources/ 相对路径
if (window.location.protocol === 'file:') {
  LAppDefine.setResourcesPath('./Resources/');
}

// ─── 等待 DOM 就绪后初始化 UI ──────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initSettings();
  initChat();
  initBeatDetector(); // 系统音频节拍检测，驱动 Live2D 随音乐弹动
  registerTTSPlayListener(); // 注册主进程推送 TTS 音频的监听器

  // ── 置顶按鈕 ──
  const pinBtn = document.getElementById('pin-btn') as HTMLButtonElement | null;
  window.electronAPI?.onPinState((pinned) => {
    if (pinBtn) {
      pinBtn.title   = pinned ? '取消置顶' : '置顶';
      pinBtn.style.opacity = pinned ? '1' : '0.4';
    }
  });
  pinBtn?.addEventListener('click', () => window.electronAPI?.togglePin());
});

// ─── 等待页面加载后初始化 Live2D ───────────────────────
window.addEventListener(
  'load',
  (): void => {
    if (!LAppDelegate.getInstance().initialize()) {
      console.error('[Live2D] 初始化失败');
      return;
    }
    LAppDelegate.getInstance().run();
    void refreshAvatarStudio();
  },
  { passive: true }
);

// ─── 页面卸载时释放 Live2D 资源 ───────────────────────
window.addEventListener(
  'beforeunload',
  (): void => {
    LAppDelegate.releaseInstance();
  },
  { passive: true }
);
