/**
 * 打字机气泡：聊天区折叠时，AI 的回复以打字机效果显示在 Live2D 画布上。
 * TTS 开启时由播放器按每句真实时长驱动；关闭时按字数估算时长。
 */

import {
  createTypewriterPlaybackCallback,
  shouldShowEstimatedTypewriter,
  type TypewriterPlaybackCallback,
  type TypewriterPoint,
} from '../typewriterPlayback';
import { isChatExpanded } from './layout';

let typingTimer: ReturnType<typeof setInterval> | null = null;
let fadeTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * 正在打的这句。按时间推进而不是一个字一个定时器：定时器每次都会晚一点，一句下来累计晚一两百毫秒，
 * 句尾就被下一句截掉了。从 fromIndex 个字、fromAt 时刻起，到 endAt 时刻打完全部
 */
let typing: {
  text: string;
  chars: string[];
  shown: number;
  startedAt: number;
  fromIndex: number;
  fromAt: number;
  endAt: number;
  /** 逐词时间换算出的节奏点（按 UTF-16 下标）：有它就按它，不再匀速 */
  timeline?: TypewriterPoint[];
} | null = null;
const TICK_MS = 30;

function clearTimers(): void {
  if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
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
  const now = performance.now();
  typing = { text, chars, shown: 0, startedAt: now, fromIndex: 0, fromAt: now, endAt: now + Math.max(chars.length * 15, durationMs) };
  advance(textEl);
  typingTimer = setInterval(() => advance(textEl), TICK_MS);
}

/** 按逐词节奏点，现在该显示到第几个字（码点个数） */
function timelineTarget(t: NonNullable<typeof typing>, now: number): number {
  const points = t.timeline!;
  let units = 0;
  const last = points[points.length - 1];
  if (now >= last.atMs) {
    const total = t.text.length;
    // 逐词时间已经覆盖到句尾：最后一个词念完再过一会儿，句尾的标点也显示
    if (total - last.chars <= 2) return now >= last.atMs + 250 ? t.chars.length : Math.min(t.chars.length, codePoints(t, last.chars));
    // 后面的词的时间还没到（服务端分批发）：剩下的按估计的时长接着打，等它们到了再校正
    const left = Math.max(300, t.endAt - last.atMs);
    units = last.chars + (total - last.chars) * Math.min(1, (now - last.atMs) / left);
  } else {
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (now < p.atMs) {
        const prev = points[i - 1];
        units = prev ? prev.chars + (p.chars - prev.chars) * ((now - prev.atMs) / Math.max(1, p.atMs - prev.atMs)) : 0;
        break;
      }
    }
  }
  return codePoints(t, units);
}

/** UTF-16 下标 → 码点个数 */
function codePoints(t: NonNullable<typeof typing>, units: number): number {
  let count = 0;
  let index = 0;
  while (count < t.chars.length && index + t.chars[count].length <= Math.floor(units)) {
    index += t.chars[count].length;
    count++;
  }
  return count;
}

function advance(textEl: HTMLElement): void {
  if (!typing) return;
  const { chars, fromIndex, fromAt, endAt } = typing;
  const now = performance.now();
  const progress = Math.min(1, (now - fromAt) / Math.max(1, endAt - fromAt));
  // 第一个字立刻出来；有逐词节奏就按她念到的位置
  const target = typing.timeline?.length
    ? Math.max(typing.shown, 1, timelineTarget(typing, now))
    : Math.max(fromIndex + 1, Math.ceil(fromIndex + (chars.length - fromIndex) * progress));
  if (target > typing.shown) {
    textEl.textContent += chars.slice(typing.shown, target).join('');
    typing.shown = Math.min(chars.length, target);
  }
  if (typing.shown >= chars.length) {
    typing = null;
    if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
    fadeTimer = setTimeout(dismissTypewriterBubble, 3000); // 全文展示完毕，3s 后淡出
  }
}

/** 这句的真实时长刚知道（开始时只能估）：剩下的字改成在 durationMs 内打完 */
export function retimeTypewriterBubble(text: string, durationMs: number, timeline?: TypewriterPoint[]): void {
  if (!typing || typing.text !== text) return;
  if (timeline?.length) typing.timeline = timeline;
  // 从这一刻已显示的字接着打，在这句开始后 durationMs 时打完
  const now = performance.now();
  typing.fromIndex = typing.shown;
  typing.fromAt = now;
  typing.endAt = Math.max(now + 80, typing.startedAt + durationMs);
}

export function dismissTypewriterBubble(): void {
  document.getElementById('typewriter-overlay')?.classList.remove('visible');
  clearTimers();
  typing = null;
}

export function shouldShowTypewriterBubble(): boolean {
  // 直播间画面里气泡就是字幕，一直显示
  return document.body.classList.contains('stage-mode') || !isChatExpanded();
}

/** 交给 TTS 播放器的回调：每句开始播放时按真实时长推进气泡 */
export function typewriterPlayback(text: string): TypewriterPlaybackCallback {
  return createTypewriterPlaybackCallback(text, shouldShowTypewriterBubble, showTypewriterBubble, retimeTypewriterBubble);
}

/** TTS 关闭时没有真实时长，按字数估算显示气泡 */
export async function showEstimatedTypewriterWhenTTSDisabled(text: string): Promise<void> {
  const ttsEnabled = await window.ttsAPI?.isEnabled().catch(() => false) ?? false;
  if (shouldShowEstimatedTypewriter(isChatExpanded(), ttsEnabled)) {
    showTypewriterBubble(text, text.length * 60);
  }
}
