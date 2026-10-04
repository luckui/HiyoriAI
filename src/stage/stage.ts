/**
 * 直播间画面（主窗口）：开播时把桌宠变成 16:9 的舞台。
 *
 *   主题（themes.ts）   —— 多层动态背景 + 粒子 + PV 风文字飘带，跟着音乐和她的声音律动
 *   节目（data-stage-segment）—— 聊天回 / 歌回 / 游戏回各一套布局；游戏回直接采集游戏窗口
 *   阶段（sequences.ts）—— 准备中 / 开场动画 / 直播中 / 谢幕（感谢名单）
 *   弹幕栏、大事件特效、她的反应（兴奋、看向她在回的那条弹幕）
 *
 * 状态由主进程持有（liveAPI.onStage），这里只负责画。OBS 或 B 站直播姬采集这个窗口即可。
 */

import type { LiveEvent, LiveFocus, LiveStageState, LiveStatus, LiveUser } from '../../shared/types/live';
import { LIVE_SEGMENTS } from '../../shared/types/live';
import { LAppDelegate } from '../lappdelegate';
import * as LAppDefine from '../lappdefine';
import { liveliness } from '../liveliness/motor';
import { ParticleField } from './particles';
import { buildTheme, THEME_BURST_COLORS, type ThemeScene } from './themes';
import { clearSequence, playEnding, playOpening, showWaiting } from './sequences';
import { renderPanel } from './panels';
import './stage.css';

const MAX_CHAT = 9;
const ALERT_MS = 6000;
/** 达到这个金额的礼物弹大特效（元），与注意力层「单独感谢」的线一致 */
const BIG_GIFT_YUAN = 5;
const FOCUS_MS = 8000;

/** 各节目的半身构图（放大倍数、下移量） */
const FRAMING = {
  chat: { scale: 2.15, offsetY: -0.6 },
  sing: { scale: 1.9, offsetY: -0.5 },
  game: { scale: 2.0, offsetY: -0.62 },
  ending: { scale: 2.0, offsetY: -0.58 },
};

/** 她看向弹幕栏的方向（x 正为观众的右边，y 正为上） */
const CHAT_GAZE = { chat: { x: -0.8, y: -0.1 }, sing: { x: 0.8, y: -0.1 }, game: { x: 0.2, y: 0.7 } };

let state: LiveStageState | null = null;
let halfBodyBefore: boolean | null = null;
let scene: ThemeScene | null = null;
let sceneKey = '';
let back: ParticleField | null = null;
let fx: ParticleField | null = null;
let rafId: number | null = null;
let lastFrame = 0;
let captureStream: MediaStream | null = null;
let captureId: string | null = null;
const chatRows = new Map<string, HTMLElement>();
const alertQueue: LiveEvent[] = [];
let alertShowing = false;
let lastReactionAt = 0;

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function isStageMode(): boolean {
  return document.body.classList.contains('stage-mode');
}

function manager() {
  return LAppDelegate.getInstance().getFirstSubdelegate()?.getLive2DManager();
}

// ── 状态 ───────────────────────────────────────────────

function apply(next: LiveStageState): void {
  const prev = state;
  state = next;
  const body = document.body;
  const wasOn = prev?.on ?? false;

  body.classList.toggle('stage-mode', next.on);
  for (const p of ['waiting', 'opening', 'live', 'ending']) body.classList.toggle(`stage-phase-${p}`, next.phase === p);
  body.dataset.stageTheme = next.theme;
  body.dataset.stageSegment = next.segment;

  if (next.on && !wasOn) {
    // 直播用半身构图；记下原来的视图，退出时还原
    halfBodyBefore = document.getElementById('view-mode-icon')?.textContent === '半';
    manager()?.setHalfBodyMode(true);
    liveliness.followCursor = false;
    document.title = 'Hiyori 直播间';
    back = new ParticleField($('stage-particles') as HTMLCanvasElement);
    fx = new ParticleField($('stage-fx') as HTMLCanvasElement, 320);
    startLoop();
    void loadRecent();
  } else if (!next.on && wasOn) {
    manager()?.setHalfBodyMode(halfBodyBefore ?? LAppDefine.DefaultHalfBody);
    manager()?.setStageFraming(null);
    liveliness.followCursor = true;
    document.title = 'Hiyori - 看板喵';
    stopLoop();
    clearSequence($('stage-seq'));
    body.classList.remove('stage-revealed');
    $('stage-scene').replaceChildren();
    sceneKey = '';
    scene = null;
    back = fx = null;
  }
  if (!next.on) {
    applyCapture(null);
    applyBackground('');
    return;
  }

  const seg = LIVE_SEGMENTS[next.segment] ?? LIVE_SEGMENTS.chat;
  $('stage-seg-icon').textContent = seg.icon;
  $('stage-seg-title').textContent = next.title || seg.title;
  manager()?.setStageFraming(next.phase === 'ending' ? FRAMING.ending : FRAMING[next.segment]);
  applyTheme(next);
  applyBackground(next.background);
  applyCapture(next.segment === 'game' ? next.capture?.id ?? null : null);
  if (prev?.phase !== next.phase) applyPhase(next);
}

function applyTheme(s: LiveStageState): void {
  const seg = LIVE_SEGMENTS[s.segment];
  const key = `${s.theme}|${s.title}|${s.segment}`;
  if (key === sceneKey) return;
  sceneKey = key;
  scene = buildTheme(s.theme, $('stage-scene'), `${seg.icon} ${s.title || seg.title}`);
  back?.clear();
  back?.setEmitters(scene.emitters);
}

function applyPhase(s: LiveStageState): void {
  const seq = $('stage-seq');
  document.body.classList.remove('stage-revealed');
  switch (s.phase) {
    case 'waiting':
      showWaiting(seq, s);
      break;
    case 'opening':
      playOpening(seq, s, {
        onReveal: () => {
          document.body.classList.add('stage-revealed');
          const { x, y } = heroPoint();
          fx?.burst(x, y, 70, ['confetti', 'heart', 'sparkle'], THEME_BURST_COLORS[s.theme], 620);
          liveliness.setExpression({ expression: 'excited', intensity: 0.9 }, 4000);
        },
        onDone: () => void window.liveAPI.setPhase('live'),
      });
      break;
    case 'ending':
      void window.liveAPI.getCredits().then((credits) => {
        if (state?.phase !== 'ending') return;
        playEnding(seq, credits);
        liveliness.setExpression({ expression: 'happy', intensity: 0.8 }, 8000);
      });
      break;
    default:
      clearSequence(seq);
  }
}

function fileUrl(path: string): string {
  if (/^(https?|file):/i.test(path)) return path;
  return `file:///${encodeURI(path.replace(/\\/g, '/')).replace(/#/g, '%23')}`;
}

function applyBackground(path: string): void {
  const video = $('stage-video') as HTMLVideoElement;
  const image = $('stage-image');
  const isVideo = /\.(mp4|webm|mov)$/i.test(path);
  const isImage = !!path && !isVideo;
  document.body.classList.toggle('stage-has-video', isVideo);
  document.body.classList.toggle('stage-has-image', isImage);
  if (isVideo) {
    const url = fileUrl(path);
    if (video.dataset.src !== url) {
      video.dataset.src = url;
      video.src = url;
    }
    void video.play().catch(() => {});
  } else if (video.dataset.src) {
    video.pause();
    video.removeAttribute('src');
    delete video.dataset.src;
  }
  image.style.backgroundImage = isImage ? `url("${fileUrl(path)}")` : '';
}

/** 游戏回：直接采集选中的窗口，画进游戏框 */
function applyCapture(id: string | null): void {
  if (id === captureId) return;
  captureId = id;
  captureStream?.getTracks().forEach((t) => t.stop());
  captureStream = null;
  const frame = $('stage-game');
  const video = $('stage-game-video') as HTMLVideoElement;
  frame.classList.remove('has-video');
  video.srcObject = null;
  if (!id) return;
  const constraints = {
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } },
  } as unknown as MediaStreamConstraints;
  navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
    if (captureId !== id) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    captureStream = stream;
    video.srcObject = stream;
    void video.play().catch(() => {});
    frame.classList.add('has-video');
    // 被采集的窗口关掉了
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (captureId === id) applyCapture(null);
    });
  }).catch((err) => console.warn('[Stage] 采集游戏窗口失败：', (err as Error).message));
}

// ── 每帧：粒子与律动 ───────────────────────────────────

function startLoop(): void {
  if (rafId !== null) return;
  lastFrame = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    const p = liveliness.stagePulse;
    const pulse = {
      beat: p.beatPhase === null ? 0 : Math.exp(-p.beatPhase * 6),
      groove: p.groove,
      voice: Math.min(1, p.voice * 4),
    };
    if (back) {
      back.intensity = 1 + 0.8 * pulse.groove + 0.6 * pulse.voice;
      back.frame(dt);
    }
    fx?.frame(dt);
    scene?.frame?.(pulse, now / 1000);
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

function stopLoop(): void {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
}

/** 她脸附近（前景特效从这里炸开） */
function heroPoint(): { x: number; y: number } {
  const rect = $('canvas-container').getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.32 };
}

// ── 弹幕栏 ─────────────────────────────────────────────

function hue(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

function avatar(user: LiveUser): HTMLElement {
  const h = hue(user.name || user.id);
  if (user.face && !user.masked) {
    const img = document.createElement('img');
    img.className = 'sc-avatar';
    img.referrerPolicy = 'no-referrer';
    img.src = user.face;
    img.onerror = () => img.replaceWith(initialAvatar(user, h));
    return img;
  }
  return initialAvatar(user, h);
}

function initialAvatar(user: LiveUser, h: number): HTMLElement {
  const div = el('div', 'sc-avatar', [...(user.name || '?')][0]);
  div.style.setProperty('--avatar-bg', `hsl(${h} 80% 76%)`);
  return div;
}

const GUARD_ICON: Record<number, string> = { 1: '👑', 2: '💎', 3: '⚓' };

function nameLine(user: LiveUser): HTMLElement {
  const line = el('div', 'sc-name');
  line.style.setProperty('--name-color', `hsl(${hue(user.name || user.id)} 60% var(--st-name-l, 48%))`);
  if (user.guardLevel && GUARD_ICON[user.guardLevel]) line.append(el('span', 'sc-guard', GUARD_ICON[user.guardLevel]));
  line.append(el('span', '', user.name || '神秘观众'));
  if (user.medal?.ofThisRoom) line.append(el('span', 'sc-medal', `${user.medal.name} ${user.medal.level}`));
  return line;
}

/** 弹幕文字：表情包显示成图片，「[大笑]」这类小表情换成图 */
function chatBubble(event: Extract<LiveEvent, { kind: 'chat' }>): HTMLElement {
  const bubble = el('div', 'sc-bubble');
  const image = (src: string, alt: string, cls?: string) => {
    const img = document.createElement('img');
    if (cls) img.className = cls;
    img.referrerPolicy = 'no-referrer';
    img.src = src;
    img.alt = alt;
    img.onerror = () => img.replaceWith(alt);
    return img;
  };
  if (event.stickerUrl) {
    bubble.classList.add('sticker');
    bubble.append(image(event.stickerUrl, event.text));
    return bubble;
  }
  const emotes = event.emotes ?? {};
  for (const part of event.text.split(/(\[[^\]]+\])/)) {
    if (!part) continue;
    bubble.append(emotes[part] ? image(emotes[part], part, 'sc-emo') : part);
  }
  return bubble;
}

function yuan(v: number): string {
  return `¥${Math.round(v * 10) / 10}`;
}

/** 弹幕栏里的一行；进场、点赞、关注不进弹幕栏 */
function chatRow(event: LiveEvent): HTMLElement | null {
  const row = el('div', 'sc-item');
  const body = el('div', 'sc-body');
  let bubble: HTMLElement;
  switch (event.kind) {
    case 'chat':
      if (event.emoteOnly && !event.stickerUrl && !event.emotes) row.classList.add('emote');
      bubble = chatBubble(event);
      break;
    case 'gift':
      row.classList.add('gift');
      bubble = el('div', 'sc-bubble', `🎁 送出 ${event.giftName} ×${event.count}`);
      break;
    case 'superchat':
      row.classList.add('paid');
      bubble = el('div', 'sc-bubble');
      bubble.append(el('span', 'sc-price', `醒目留言 ${yuan(event.valueYuan)}`), document.createTextNode(event.text));
      break;
    case 'membership':
      row.classList.add('paid');
      row.style.setProperty('--paid-a', '#a98bff');
      row.style.setProperty('--paid-b', '#ff8fc8');
      bubble = el('div', 'sc-bubble', `${GUARD_ICON[event.level] ?? '⚓'} 开通了${event.levelName}`);
      break;
    default:
      return null;
  }
  body.append(nameLine(event.user), bubble);
  row.append(avatar(event.user), body);
  return row;
}

function addToChat(event: LiveEvent): void {
  const list = $('stage-chat-list');
  const row = chatRow(event);
  const existing = chatRows.get(event.id);
  if (existing) {
    // 礼物连击：原位更新数量，不再弹一次
    if (row) {
      row.style.animation = 'none';
      row.classList.toggle('focused', existing.classList.contains('focused'));
      existing.replaceWith(row);
      chatRows.set(event.id, row);
    }
    return;
  }
  if (!row) return;
  chatRows.set(event.id, row);
  list.append(row);
  while (chatRows.size > MAX_CHAT) {
    const [id, node] = chatRows.entries().next().value as [string, HTMLElement];
    node.remove();
    chatRows.delete(id);
  }
}

function tick(event: LiveEvent): void {
  if (event.user.masked) return;
  const text = event.kind === 'enter' ? '👋 来了' : event.kind === 'follow' ? '💗 关注了直播间' : event.kind === 'share' ? '📣 分享了直播间' : '';
  if (!text) return;
  $('stage-ticker').replaceChildren(el('span', 'tick', `${event.user.name} ${text}`));
}

// ── 大事件：特效卡片 + 她的反应 ─────────────────────────

function isBig(event: LiveEvent): boolean {
  return event.kind === 'superchat' || event.kind === 'membership' || (event.kind === 'gift' && event.valueYuan >= BIG_GIFT_YUAN);
}

function showNextAlert(): void {
  const event = alertQueue.shift();
  if (!event) {
    alertShowing = false;
    return;
  }
  alertShowing = true;
  const card = el('div', `stage-alert ${event.kind}`);
  const icon = event.kind === 'superchat' ? '💌' : event.kind === 'membership' ? '⚓' : '🎁';
  const main = el('div');
  const name = event.user.name || '神秘观众';
  if (event.kind === 'superchat') {
    main.append(`${name} 的醒目留言`, el('span', 'alert-sub', event.text.slice(0, 40)));
  } else if (event.kind === 'membership') {
    main.append(`感谢 ${name} 开通${event.levelName}！`, el('span', 'alert-sub', '欢迎上船～'));
  } else if (event.kind === 'gift') {
    main.append(`感谢 ${name} 的 ${event.giftName} ×${event.count}`, el('span', 'alert-sub', yuan(event.valueYuan)));
  }
  card.append(el('span', 'alert-icon', icon), main);
  $('stage-alerts').replaceChildren(card);
  window.setTimeout(() => {
    card.classList.add('leaving');
    card.addEventListener('animationend', () => {
      card.remove();
      showNextAlert();
    }, { once: true });
  }, ALERT_MS);
}

/** 她对直播间里发生的事的即时反应（不说话，只是表情和特效） */
function react(event: LiveEvent): void {
  const now = performance.now();
  const colors = THEME_BURST_COLORS[state?.theme ?? 'sakura'];
  if (isBig(event)) {
    if (!alertQueue.some((e) => e.id === event.id)) {
      alertQueue.push(event);
      if (!alertShowing) showNextAlert();
    }
    const { x, y } = heroPoint();
    fx?.burst(x, y, 46, ['heart', 'sparkle', 'confetti'], colors, 520);
    liveliness.setExpression({ expression: 'excited', intensity: 0.9 }, 3000);
    lastReactionAt = now;
    return;
  }
  // 小礼物、关注：开心一下；热闹时别一直挂着笑
  if ((event.kind === 'gift' && event.valueYuan > 0) || event.kind === 'follow') {
    if (now - lastReactionAt < 6000) return;
    lastReactionAt = now;
    const { x, y } = heroPoint();
    fx?.burst(x, y, 10, ['heart'], colors, 300);
    liveliness.setExpression({ expression: 'happy', intensity: 0.55 }, 1600);
  }
}

/** 她挑了哪几条来回应：点亮卡片，看一眼弹幕栏 */
function onFocus(focus: LiveFocus): void {
  if (!isStageMode() || !state) return;
  let any = false;
  for (const id of focus.eventIds) {
    const row = chatRows.get(id);
    if (!row) continue;
    any = true;
    row.classList.add('focused');
    window.setTimeout(() => chatRows.get(id)?.classList.remove('focused'), FOCUS_MS);
  }
  if (any) {
    const gaze = CHAT_GAZE[state.segment];
    liveliness.lookAt(gaze.x, gaze.y, 1800);
  }
}

// ── 数据 ───────────────────────────────────────────────

function formatCount(n: number | undefined): string {
  if (n === undefined) return '–';
  return n >= 10_000 ? `${(n / 10_000).toFixed(1)}万` : String(n);
}

function renderStats(status: LiveStatus): void {
  const pills: HTMLElement[] = [];
  const pill = (cls: string, label: string, value?: string) => {
    const p = el('span', `stage-pill ${cls}`, label);
    if (value !== undefined) p.append(el('b', '', value));
    pills.push(p);
  };
  if (status.state === 'connected') {
    pill('live', 'LIVE');
    pill('', '👥 在线', formatCount(status.stats.online));
    if (status.stats.likes !== undefined) pill('', '❤', formatCount(status.stats.likes));
  } else if (status.state !== 'idle') {
    pill('', '连接中…');
  }
  $('stage-stats').replaceChildren(...pills);
  if (status.room?.anchorName) $('stage-room').textContent = `${status.room.anchorName} 的直播间`;
}

function onEvents(events: LiveEvent[], live: boolean): void {
  for (const e of events) {
    if (e.kind === 'enter' || e.kind === 'follow' || e.kind === 'share' || e.kind === 'like') {
      tick(e);
      if (live && state?.phase === 'live') react(e);
      continue;
    }
    addToChat(e);
    if (live && state?.phase === 'live') react(e);
  }
}

async function loadRecent(): Promise<void> {
  chatRows.clear();
  $('stage-chat-list').replaceChildren();
  const recent = await window.liveAPI.getRecent();
  onEvents(recent.slice(-MAX_CHAT * 2), false);
  renderStats(await window.liveAPI.getStatus());
}

/** 调试：往直播间画面里塞几条假事件（看特效和样式） */
export function injectStageEvents(events: LiveEvent[]): void {
  onEvents(events, true);
}

/** 调试：模拟她挑中了某几条 */
export function injectStageFocus(eventIds: string[]): void {
  onFocus({ kind: 'chat', eventIds });
}

// ── 主人语音：舞台上方的「主人」字幕条 ──────────────────

let ownerTimer: number | null = null;

function onOwnerVoice(voice: { state: 'listening' | 'heard' | 'idle'; text: string }): void {
  const bar = $('stage-owner');
  if (ownerTimer !== null) clearTimeout(ownerTimer);
  ownerTimer = null;
  if (voice.state === 'idle') {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.replaceChildren(el('span', 'so-tag', '🎙 主人'), el('span', voice.state === 'listening' ? 'so-text so-listening' : 'so-text', voice.state === 'listening' ? '说话中…' : voice.text));
  if (voice.state === 'listening') {
    // 她稍微侧过头听（主人在镜头外）
    liveliness.lookAt(0.4, 0.1, 2500);
  } else {
    ownerTimer = window.setTimeout(() => { bar.hidden = true; }, 7000);
  }
}

export function initStage(): void {
  const api = window.liveAPI;
  if (!api) return;
  api.onStage(apply);
  api.onFocus(onFocus);
  api.onPanel(renderPanel);
  api.onOwnerVoice(onOwnerVoice);
  void api.getPanel().then(renderPanel);
  api.onUpdate((update) => {
    if (!isStageMode()) return;
    onEvents(update.events, true);
    renderStats(update.status);
  });
  // Esc 退出直播间画面
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isStageMode()) void api.setPhase('off');
  });
  void api.getStage().then(apply);
}
