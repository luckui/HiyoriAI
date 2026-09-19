/**
 * 聊天窗口入口：把各部分接起来。
 *
 *   layout          窗口尺寸、折叠/展开、拖动、缩放、形象工坊侧栏
 *   conversations   当前对话与对话列表
 *   turns           发出一轮对话（手动 / 语音 / 异步唤醒）
 *   messages        消息流渲染
 *   typewriter      折叠时画布上的打字机气泡
 *   toolActivity    工具调用气泡、终端块、Todo 清单
 *   hearingUi       听觉指示条与转写气泡
 *   agentModeSwitch 模式切换按钮
 */

import { initLive2DController } from '../live2dController';
import { LAppDelegate } from '../lappdelegate';
import { initAvatarStudio } from '../avatarStudio';
import {
  applyInitialLayout,
  closeAvatarStudio,
  isChatExpanded,
  setChatExpanded,
  setupResizeGrip,
  setupWindowDrag,
  toggleAvatarStudio,
  updateChatLayout,
} from './layout';
import { closeConvPanel, getCurrentConversationId, initConversationControls, openInitialConversation, refreshConvTitle } from './conversations';
import { initTurns } from './turns';
import { addMessage } from './messages';
import { dismissTypewriterBubble, showEstimatedTypewriterWhenTTSDisabled } from './typewriter';
import { initToolActivity } from './toolActivity';
import { initHearingUi } from './hearingUi';
import { initAgentModeSwitch } from './agentModeSwitch';

function initHeaderButtons(): void {
  document.getElementById('toggle-chat-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const expanding = !isChatExpanded();
    if (expanding) dismissTypewriterBubble();
    setChatExpanded(expanding, closeConvPanel);
  });

  // 半身/全身切换：只改变 Live2D 渲染，窗口与 canvas 尺寸不变
  let halfBody = false;
  document.getElementById('view-mode-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    halfBody = !halfBody;
    const icon = document.getElementById('view-mode-icon');
    if (icon) icon.textContent = halfBody ? '半' : '全';
    LAppDelegate.getInstance().getFirstSubdelegate()?.getLive2DManager().setHalfBodyMode(halfBody);
  });

  document.getElementById('close-btn')?.addEventListener('click', () => window.electronAPI?.closeWindow());

  document.getElementById('avatar-studio-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAvatarStudio();
  });
  document.getElementById('avatar-studio-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAvatarStudio();
  });
}

/** 输入框多行时窗口向下扩展，不影响 canvas 位置也不破坏折叠动画 */
function followInputAreaHeight(): void {
  const inputArea = document.getElementById('input-area');
  if (!inputArea || typeof ResizeObserver === 'undefined') return;
  let previous = inputArea.offsetHeight;
  new ResizeObserver(() => {
    if (inputArea.offsetHeight === previous) return;
    previous = inputArea.offsetHeight;
    updateChatLayout();
  }).observe(inputArea);
}

/** 退出时主进程在保存记忆，显示遮罩；保存完成后换成告别语 */
function initQuitOverlay(): void {
  const overlay = document.getElementById('quit-overlay');
  window.appLifecycleAPI?.onQuitting(() => overlay?.classList.add('visible'));
  window.appLifecycleAPI?.onQuitReady(() => {
    const title = overlay?.querySelector<HTMLElement>('.quit-title');
    const hint = overlay?.querySelector<HTMLElement>('.quit-hint');
    if (title) title.textContent = '记忆已保存 ✓';
    if (hint) hint.textContent = '再见，下次见到你要更厉害哦 ✨';
  });
}

/** Minecraft 等外部渠道完成的一轮对话，同步显示到当前窗口 */
function mirrorExternalTurns(): void {
  window.chatAPI?.onExternalTurn?.((payload) => {
    if (payload.conversationId !== getCurrentConversationId()) return;
    addMessage('user', payload.user, true, payload.createdAt);
    addMessage('ai', payload.assistant, true, payload.createdAt);
    void showEstimatedTypewriterWhenTTSDisabled(payload.assistant);
    void refreshConvTitle(payload.conversationId);
  });
}

export async function initChat(): Promise<void> {
  setupWindowDrag();
  setupResizeGrip();
  initAvatarStudio();
  // 等 DOM layout 完成后再修正窗口尺寸，确保 offsetHeight 可读
  requestAnimationFrame(applyInitialLayout);
  initLive2DController();

  initHeaderButtons();
  initConversationControls();
  initTurns();
  followInputAreaHeight();
  await initAgentModeSwitch();
  await openInitialConversation();

  initQuitOverlay();
  initToolActivity();
  initHearingUi();
  mirrorExternalTurns();
}
