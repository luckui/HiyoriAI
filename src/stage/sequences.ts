/**
 * 直播间的开场与谢幕：
 *   准备中 —— 待机画面：大字 Logo 波浪跳动、时钟、轮播小提示（她先不出场）
 *   开场   —— 约 5 秒：斜向色块扫入 → HIYORI 逐字砸下 + 节目标题 → 闪光 → 色块退场、她弹出来
 *   谢幕   —— THANK YOU → 本场数据 → 感谢名单像片尾字幕一样滚动 → 「下次见」
 * 都画在 #stage-seq 里（在 Live2D 之上）；节奏用 CSS 动画，这里负责搭 DOM 和计时。
 */

import type { LiveCredits, LiveStageState } from '../../shared/types/live';
import { LIVE_SEGMENTS } from '../../shared/types/live';

const OPENING_REVEAL_MS = 3400;
const OPENING_DONE_MS = 5200;

const WAITING_TIPS = [
  '弹幕叫我 Hiyori 我会回你哦',
  '今天也要开开心心的 ✦',
  '新来的朋友可以先点个关注～',
  '醒目留言我会一条条念出来！',
  '准备好零食和饮料了吗？',
];

let timers: number[] = [];

function later(ms: number, fn: () => void): void {
  timers.push(window.setTimeout(fn, ms));
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 逐字拆开，每个字一个 span，用 --i 错开动画 */
function letters(text: string, cls: string): HTMLElement {
  const wrap = el('div', cls);
  [...text].forEach((ch, i) => {
    const span = el('span', '', ch === ' ' ? ' ' : ch);
    span.style.setProperty('--i', String(i));
    wrap.append(span);
  });
  return wrap;
}

function panels(cls: string): HTMLElement {
  const wrap = el('div', `seq-panels ${cls}`);
  for (let i = 0; i < 3; i++) {
    const p = el('div', `seq-panel p${i + 1}`);
    wrap.append(p);
  }
  return wrap;
}

export function clearSequence(root: HTMLElement): void {
  for (const t of timers) window.clearTimeout(t);
  timers = [];
  root.replaceChildren();
  root.className = '';
}

// ── 准备中 ─────────────────────────────────────────────

export function showWaiting(root: HTMLElement, state: LiveStageState): void {
  clearSequence(root);
  root.className = 'seq-waiting';
  const seg = LIVE_SEGMENTS[state.segment];
  const card = el('div', 'seq-wait-card');
  const clock = el('div', 'seq-wait-clock');
  const tip = el('div', 'seq-wait-tip', WAITING_TIPS[0]);
  card.append(
    letters('Hiyori', 'seq-logo'),
    el('div', 'seq-wait-chip', `${seg.icon} 今天是 · ${state.title || seg.title}`),
    el('div', 'seq-wait-title', '直播马上开始'),
    el('div', 'seq-wait-bar'),
    tip,
    clock,
  );
  root.append(card);

  const tick = () => {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };
  tick();
  let tipIndex = 0;
  const loop = () => {
    tick();
    tipIndex = (tipIndex + 1) % WAITING_TIPS.length;
    tip.classList.remove('in');
    void tip.offsetWidth;
    tip.textContent = WAITING_TIPS[tipIndex];
    tip.classList.add('in');
    later(4500, loop);
  };
  later(4500, loop);
}

// ── 开场 ───────────────────────────────────────────────

export function playOpening(
  root: HTMLElement,
  state: LiveStageState,
  hooks: { onReveal(): void; onDone(): void },
): void {
  clearSequence(root);
  root.className = 'seq-opening';
  const seg = LIVE_SEGMENTS[state.segment];
  root.append(
    panels('in-then-out'),
    letters('HIYORI', 'seq-hero'),
    el('div', 'seq-hero-sub', `LIVE START  ✦  ${seg.icon} ${state.title || seg.title}`),
    el('div', 'seq-flash'),
  );
  later(OPENING_REVEAL_MS, hooks.onReveal);
  later(OPENING_DONE_MS, () => {
    clearSequence(root);
    hooks.onDone();
  });
}

// ── 谢幕 ───────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}

function creditSection(title: string, names: string[]): HTMLElement | null {
  if (!names.length) return null;
  const section = el('section', 'seq-credit-section');
  section.append(el('h3', '', title));
  const list = el('div', 'seq-credit-names');
  for (const n of names) list.append(el('span', '', n));
  section.append(list);
  return section;
}

export function playEnding(root: HTMLElement, credits: LiveCredits): void {
  clearSequence(root);
  root.className = 'seq-ending';
  const stats = el('div', 'seq-end-stats');
  for (const [label, value] of [
    ['直播时长', formatDuration(credits.durationMs)],
    ['弹幕', String(credits.chats)],
    ['最高在线', credits.peakOnline ? String(credits.peakOnline) : '–'],
  ]) {
    const item = el('div', 'seq-end-stat');
    item.append(el('b', '', value), el('span', '', label));
    stats.append(item);
  }

  const roll = el('div', 'seq-credit-roll');
  const track = el('div', 'seq-credit-track');
  const sections = [
    creditSection('💌 醒目留言', credits.superchats),
    creditSection('⚓ 新上舰的船员', credits.members),
    creditSection('🎁 送礼物的大家', credits.gifters),
    creditSection('💗 新关注', credits.followers),
    creditSection('💬 一起聊天的大家', credits.chatters),
  ].filter((s): s is HTMLElement => s !== null);
  if (!sections.length) sections.push(el('div', 'seq-credit-empty', '今天陪我的每一位 ♡'));
  track.append(...sections, el('div', 'seq-credit-end', '感谢收看 ♡'));
  roll.append(track);

  const left = el('div', 'seq-end-left');
  left.append(letters('THANK YOU', 'seq-thanks'), el('div', 'seq-end-sub', '今天的直播就到这里啦～'), stats, roll);
  root.append(panels('end-backdrop'), left);

  // 名单越长滚得越久；滚完换成「下次见」
  const names = credits.superchats.length + credits.members.length + credits.gifters.length + credits.followers.length + credits.chatters.length;
  const rollSec = Math.min(60, Math.max(14, 8 + names * 0.45));
  track.style.animationDuration = `${rollSec}s`;
  track.style.animationDelay = '2.4s';
  later(2400 + rollSec * 1000, () => {
    const bye = el('div', 'seq-bye');
    bye.append(letters('下次见～', 'seq-bye-text'), el('div', 'seq-bye-date', new Date().toLocaleDateString('zh-CN')));
    roll.replaceWith(bye);
  });
}
