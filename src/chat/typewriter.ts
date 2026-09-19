/**
 * 打字机气泡：聊天区折叠时，AI 的回复以打字机效果显示在 Live2D 画布上。
 * TTS 开启时由播放器按每句真实时长驱动；关闭时按字数估算时长。
 */

import { createTypewriterPlaybackCallback, shouldShowEstimatedTypewriter } from '../typewriterPlayback';
import { isChatExpanded } from './layout';

let typingTimer: ReturnType<typeof setTimeout> | null = null;
let fadeTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
  if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
}

/** 在 Live2D 画布上显示打字机效果气泡。durationMs = 展开全部文字所需毫秒 */
export function showTypewriterBubble(text: string, durationMs: number): void {
  const overlay = document.getElementById('typewriter-overlay');
  const textEl = document.getElementById('typewriter-text');
  if (!overlay || !textEl) return;

  clearTimers();
  textEl.textContent = '';
  overlay.classList.add('visible');

  const chars = [...text]; // Unicode 安全拆分
  if (chars.length === 0) return;
  const perChar = Math.max(20, durationMs / chars.length);

  let i = 0;
  const tick = (): void => {
    if (i < chars.length) {
      textEl.textContent += chars[i++];
      typingTimer = setTimeout(tick, perChar);
    } else {
      fadeTimer = setTimeout(dismissTypewriterBubble, 3000); // 全文展示完毕，3s 后淡出
    }
  };
  typingTimer = setTimeout(tick, 0);
}

export function dismissTypewriterBubble(): void {
  document.getElementById('typewriter-overlay')?.classList.remove('visible');
  clearTimers();
}

export function shouldShowTypewriterBubble(): boolean {
  return !isChatExpanded();
}

/** 交给 TTS 播放器的回调：每句开始播放时按真实时长推进气泡 */
export function typewriterPlayback(text: string): (actualMs: number, sentenceText?: string) => void {
  return createTypewriterPlaybackCallback(text, shouldShowTypewriterBubble, showTypewriterBubble);
}

/** TTS 关闭时没有真实时长，按字数估算显示气泡 */
export async function showEstimatedTypewriterWhenTTSDisabled(text: string): Promise<void> {
  const ttsEnabled = await window.ttsAPI?.isEnabled().catch(() => false) ?? false;
  if (shouldShowEstimatedTypewriter(isChatExpanded(), ttsEnabled)) {
    showTypewriterBubble(text, text.length * 60);
  }
}
