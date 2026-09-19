/**
 * 窗口布局：聊天区折叠/展开、右下角缩放、拖动窗口、形象工坊侧栏。
 * 窗口尺寸由这里统一计算后交给主进程调整。
 */

import { refreshAvatarStudio } from '../avatarStudio';

const BASE_W = 360;            // 基础窗口宽度
const BASE_CANVAS_FULL = 360;  // canvas 区域高度（半身模式只缩放内容，不改高度）
const MIN_SCALE = 0.75;
const MAX_SCALE = 2.0;
// 与 style.css 中 #chat-body 的高度与 transition 时长保持一致
const CHAT_BODY_H = 280;
const CHAT_BODY_TRANSITION_MS = 350;
const AVATAR_STUDIO_WIDTH = 370;

let chatExpanded = false;
/** 窗口缩放比例（用户拖动右下角控制） */
let scale = 1.0;
let avatarStudio: { width: number; height: number } | null = null;

export function isChatExpanded(): boolean {
  return chatExpanded;
}

function setCanvasHeight(): void {
  document.documentElement.style.setProperty('--canvas-h', `${Math.round(BASE_CANVAS_FULL * scale)}px`);
}

/** 按当前状态计算窗口尺寸：canvas 随缩放变化，header / 聊天区 / 输入区保持原始像素 */
function windowSize(expanded: boolean): { width: number; height: number } {
  const headerH = document.getElementById('chat-header')?.offsetHeight ?? 50;
  const inputH = document.getElementById('input-area')?.offsetHeight ?? 54;
  return {
    width: Math.round(BASE_W * scale),
    height: Math.round(BASE_CANVAS_FULL * scale) + headerH + (expanded ? CHAT_BODY_H : 0) + inputH,
  };
}

/** 立即按当前状态调整窗口（缩放、输入框变高时调用） */
export function updateChatLayout(): void {
  setCanvasHeight();
  if (avatarStudio) return; // 形象工坊打开时窗口尺寸由它接管
  const { width, height } = windowSize(chatExpanded);
  window.electronAPI?.resizeWindow(width, height);
}

/**
 * 折叠/展开动画：chat-body 用 CSS transition 滑入滑出。
 * 展开时先扩大窗口给它留空间；收起时等动画结束再缩小窗口。
 */
export function setChatExpanded(expanded: boolean, onCollapse?: () => void): void {
  chatExpanded = expanded;
  const chatBody = document.getElementById('chat-body');
  const toggleIcon = document.getElementById('toggle-icon');
  if (!chatBody || !toggleIcon) return;

  setCanvasHeight();
  const { width, height } = windowSize(expanded);
  if (expanded) {
    window.electronAPI?.resizeWindow(width, height);
    requestAnimationFrame(() => {
      chatBody.classList.remove('collapsed');
      toggleIcon.textContent = '▾';
    });
  } else {
    chatBody.classList.add('collapsed');
    toggleIcon.textContent = '▴';
    onCollapse?.();
    setTimeout(() => window.electronAPI?.resizeWindow(width, height), CHAT_BODY_TRANSITION_MS);
  }
}

/** 启动时同步默认的折叠状态并修正窗口尺寸（需在 DOM layout 完成后调用） */
export function applyInitialLayout(): void {
  if (!chatExpanded) {
    document.getElementById('chat-body')?.classList.add('collapsed');
    const icon = document.getElementById('toggle-icon');
    if (icon) icon.textContent = '▴';
  }
  updateChatLayout();
}

// ── 形象工坊侧栏 ─────────────────────────────────────────

export function openAvatarStudio(): void {
  if (avatarStudio) return;
  avatarStudio = { width: window.innerWidth, height: window.innerHeight };
  document.documentElement.style.setProperty('--avatar-shell-width', `${avatarStudio.width}px`);
  document.body.classList.add('avatar-studio-open');
  window.electronAPI?.resizeWindow(avatarStudio.width + AVATAR_STUDIO_WIDTH, avatarStudio.height);
  const slot = document.getElementById('avatar-studio-slot');
  slot?.classList.add('visible');
  slot?.setAttribute('aria-hidden', 'false');
  document.getElementById('avatar-studio-btn')?.classList.add('active');
  document.getElementById('canvas-container')?.classList.add('drag-region-suspended');
  void refreshAvatarStudio();
}

export function closeAvatarStudio(): void {
  const saved = avatarStudio;
  if (!saved) return;
  avatarStudio = null;
  const slot = document.getElementById('avatar-studio-slot');
  const panel = document.getElementById('avatar-studio-panel');
  slot?.classList.remove('visible');
  slot?.setAttribute('aria-hidden', 'true');
  document.getElementById('avatar-studio-btn')?.classList.remove('active');
  document.getElementById('canvas-container')?.classList.remove('drag-region-suspended');

  // 侧栏滑出动画结束后再还原窗口宽度；transitionend 没触发时 360ms 兜底
  let finished = false;
  const finishClose = (): void => {
    if (finished) return;
    finished = true;
    panel?.removeEventListener('transitionend', onTransitionEnd);
    window.electronAPI?.resizeWindow(saved.width, saved.height);
    setTimeout(() => {
      document.body.classList.remove('avatar-studio-open');
      document.documentElement.style.removeProperty('--avatar-shell-width');
    }, 80);
  };
  const onTransitionEnd = (ev: TransitionEvent): void => {
    if (ev.propertyName === 'transform') finishClose();
  };
  if (!panel) {
    finishClose();
    return;
  }
  panel.addEventListener('transitionend', onTransitionEnd);
  setTimeout(finishClose, 360);
}

export function toggleAvatarStudio(): void {
  if (avatarStudio) closeAvatarStudio();
  else openAvatarStudio();
}

// ── 拖动窗口与缩放抓手 ───────────────────────────────────

/** 在 canvas 与形象工坊标题栏上按住拖动窗口；移动超过 4px 才算拖动，避免吞掉点击 */
export function setupWindowDrag(): void {
  let dragging = false;
  let last: { x: number; y: number } | null = null;
  let start = { x: 0, y: 0 };

  const bindDragSurface = (el: HTMLElement | null): void => {
    el?.addEventListener('mousedown', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.no-drag, button, input, select, textarea')) return;
      if (e.button !== 0) return;
      // 不调 preventDefault，否则会干扰 Live2D 的 pointer 事件链
      dragging = false;
      last = { x: e.screenX, y: e.screenY };
      start = { x: e.screenX, y: e.screenY };
    });
  };
  bindDragSurface(document.getElementById('canvas-container'));
  bindDragSurface(document.getElementById('avatar-studio-hdr'));

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!last) return;
    if (!dragging && Math.abs(e.screenX - start.x) + Math.abs(e.screenY - start.y) > 4) dragging = true;
    if (!dragging) return;
    window.electronAPI?.dragWindow(e.screenX - last.x, e.screenY - last.y);
    last = { x: e.screenX, y: e.screenY };
  });
  document.addEventListener('mouseup', () => {
    dragging = false;
    last = null;
  });
}

/** 右下角抓手横向拖动调整整体缩放；Pointer Capture 保证光标离开窗口后仍能收到事件 */
export function setupResizeGrip(): void {
  const grip = document.getElementById('resize-grip');
  if (!grip) return;
  let resizing = false;
  let startX = 0;
  let startScale = 1.0;

  grip.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    resizing = true;
    startX = e.screenX;
    startScale = scale;
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, startScale + (e.screenX - startX) / 250));
    updateChatLayout();
  });
  grip.addEventListener('pointerup', () => { resizing = false; });
  grip.addEventListener('pointercancel', () => { resizing = false; });
}
