/**
 * 舞台浏览器（B站情报站）：中间那块像浏览器的画面。
 *
 *   open  她介绍一个视频时，演示打开它：B站首页 → 光标点搜索框、打字 → 搜索结果 → 点进视频页
 *         （标题搜不到改搜 BV 号，还不行就直接打开，不假装点）。
 *         地址早就知道，直接跳也行；这一段是做给观众看的，让大家看到她在操作浏览器。
 *   play  在弹幕最多的地方放一小段（只留播放器铺满），放的时候截几张图给看图模型，放完回报。
 *
 * 用 <webview>（会话里有主人的 B 站 Cookie，等于登录着看），它就是画面的一部分，OBS 采集主窗口就行。
 * 她开口时视频音量压低，说完再拉回来。
 */

import { LIVE_PLAYER_PARTITION } from '../../shared/types/live';
import { liveliness } from '../liveliness/motor';

type Webview = HTMLElement & {
  src: string;
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(): Promise<{ toDataURL(): string; isEmpty(): boolean }>;
  setZoomFactor(factor: number): void;
};

const VOLUME = 0.6;
/** 她说话时视频的音量 */
const DUCKED = 0.12;
/** 等不到视频开始播就算放不了 */
const START_TIMEOUT_MS = 15_000;
const HOME = 'https://www.bilibili.com/';
/**
 * 页面按这个宽度排版再缩进框里：B 站首页、搜索页窄于 1100 左右就会被截断，
 * 框只有 600 多像素宽，不缩放只能看到左半边。
 */
const PAGE_WIDTH = 1180;

let view: Webview | null = null;
/** 当前这一次操作；换了就说明有新的 open / play，旧的停下 */
let token = 0;
/** 页面上现在是哪个视频 */
let onVideo: string | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function frame(): HTMLElement | null {
  return document.getElementById('stage-watch');
}

function setAddress(url: string): void {
  const bar = document.getElementById('ide-url');
  if (bar) bar.textContent = url;
}

/** 第一次直接带着地址建（刚建好的 webview 立刻改 src 会被忽略），之后换 src */
function load(url: string): Webview | null {
  setAddress(url);
  if (view) {
    view.src = url;
    return view;
  }
  const box = frame();
  if (!box) return null;
  const el = document.createElement('webview') as Webview;
  el.setAttribute('partition', LIVE_PLAYER_PARTITION);
  el.setAttribute('src', url);
  el.id = 'stage-watch-view';
  const follow = (e: Event) => setAddress((e as Event & { url: string }).url);
  // 缩放是按域名记的（www / search 各一份），每次换页都要重设；提交导航时就设，少闪一下
  const fit = () => {
    try { el.setZoomFactor(Math.min(1, box.clientWidth / PAGE_WIDTH)); } catch { /* 还没 attach */ }
  };
  el.addEventListener('did-navigate', fit);
  el.addEventListener('dom-ready', fit);
  el.addEventListener('did-navigate', follow);
  el.addEventListener('did-navigate-in-page', follow);
  el.addEventListener('page-title-updated', (e) => {
    const tab = document.getElementById('ide-tab');
    if (tab) tab.textContent = (e as Event & { title: string }).title.replace(/_哔哩哔哩_bilibili$/, '').slice(0, 24);
  });
  box.append(el);
  view = el;
  return el;
}

function exec<T>(code: string): Promise<T | null> {
  return view ? (view.executeJavaScript(code) as Promise<T>).catch(() => null) : Promise.resolve(null);
}

function waitLoaded(el: Webview, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { el.removeEventListener('dom-ready', done); resolve(); };
    el.addEventListener('dom-ready', done);
    setTimeout(done, timeoutMs);
  });
}

// ── 光标（画在框上面，不是真的鼠标）────────────────────────

function cursor(): HTMLElement | null {
  const box = frame();
  if (!box) return null;
  let c = document.getElementById('ide-cursor');
  if (!c) {
    c = document.createElement('div');
    c.id = 'ide-cursor';
    c.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2l15 11-7 1 4 8-3 1-4-8-5 5z" fill="#fff" stroke="#222" stroke-width="1.4"/></svg>';
    box.append(c);
  }
  return c;
}

/** 把光标挪到页面里某个元素的中心（selector 依次试） */
async function moveTo(selectors: string[], fallback: { x: number; y: number }): Promise<void> {
  const box = frame();
  const c = cursor();
  if (!box || !c) return;
  const at = await exec<{ x: number; y: number; w: number; h: number }>(`(() => {
    for (const s of ${JSON.stringify(selectors)}) {
      const el = document.querySelector(s);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height && r.top < innerHeight) return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: innerWidth, h: innerHeight };
    }
    return null;
  })()`);
  const x = at ? (at.x / at.w) * box.clientWidth : fallback.x * box.clientWidth;
  const y = at ? (at.y / at.h) * box.clientHeight : fallback.y * box.clientHeight;
  c.classList.add('show');
  c.style.transform = `translate(${x}px, ${y}px)`;
  await sleep(700);
}

async function click(): Promise<void> {
  const c = cursor();
  if (!c) return;
  c.classList.remove('click');
  void c.offsetWidth;
  c.classList.add('click');
  await sleep(250);
}

function hideCursor(): void {
  document.getElementById('ide-cursor')?.classList.remove('show');
}

/** 搜索框里打的字：标题去掉括号、表情，取前 16 个字 */
function query(title: string): string {
  return [...title.replace(/【[^】]*】|\[[^\]]*\]|[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, 16).join('') || title.slice(0, 16);
}

/** 搜索框（首页顶栏、搜索结果页各一个） */
const SEARCH_INPUTS = ['.nav-search-input', '#nav-searchform input', '.search-input-el', 'input[type="search"]'];

/** 光标点进搜索框，一个字一个字打进去 */
async function typeSearch(text: string, my: number): Promise<void> {
  await moveTo(SEARCH_INPUTS, { x: 0.5, y: 0.08 });
  await click();
  const chars = [...text];
  for (let i = 1; i <= chars.length && my === token; i++) {
    const part = JSON.stringify(chars.slice(0, i).join(''));
    await exec(`(() => {
      for (const s of ${JSON.stringify(SEARCH_INPUTS)}) {
        const input = document.querySelector(s);
        if (!input || !input.getBoundingClientRect().width) continue;
        input.value = ${part};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
    })()`);
    await sleep(90);
  }
}

/**
 * 搜索结果里找这个视频：结果是页面脚本渲染的，等它出来；找到了滚到看得见的地方。
 * B 站是模糊搜索，几乎总有结果，但目标不一定在里面——结果出来了还没有它，就算没找到。
 */
async function findResult(bvid: string, my: number): Promise<boolean> {
  const began = performance.now();
  while (my === token && performance.now() - began < 7000) {
    const r = await exec<{ found: boolean; cards: number }>(`(() => {
      const link = document.querySelector('a[href*="${bvid}"]');
      if (link) link.scrollIntoView({ block: 'center' });
      return { found: !!link, cards: document.querySelectorAll('.bili-video-card, .video-list-item').length };
    })()`);
    if (r?.found) {
      await sleep(400);
      return true;
    }
    if (r && r.cards > 0 && performance.now() - began > 2000) return false;
    await sleep(300);
  }
  return false;
}

/** 搜一个词，结果里有这个视频就返回 true */
async function searchFor(el: Webview, keyword: string, bvid: string, my: number): Promise<boolean> {
  await typeSearch(keyword, my);
  if (my !== token) return false;
  await sleep(400);
  load(`https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`);
  await waitLoaded(el, 8000);
  return my === token && findResult(bvid, my);
}

/**
 * 演示打开一个视频：首页 → 搜标题 → 点进去。标题搜不到就在结果页改搜 BV 号；
 * 还搜不到就直接打开，不假装点（点空白处进视频很假）。中途有新的操作就停下。
 */
async function open(bvid: string, title: string): Promise<void> {
  const my = ++token;
  const box = frame();
  box?.classList.add('browsing');
  const el = load(HOME);
  if (!el) return;
  await waitLoaded(el, 8000);
  if (my !== token) return;
  await sleep(600);
  const byTitle = await searchFor(el, query(title), bvid, my);
  const found = byTitle || (my === token && await searchFor(el, bvid, bvid, my));
  if (my !== token) return;
  console.info(`[WatchPlayer] 打开 ${bvid}：${byTitle ? '标题搜到了' : found ? '标题搜不到，BV 号搜到了' : '都搜不到，直接打开'}`);
  if (found) {
    await moveTo([`a[href*="${bvid}"]`], { x: 0.22, y: 0.42 });
    await click();
  } else {
    hideCursor();
  }
  if (my !== token) return;
  load(`https://www.bilibili.com/video/${bvid}/`);
  onVideo = bvid;
  await waitLoaded(el, 8000);
  hideCursor();
  // 视频页会自动播放：她还在介绍，先停着、静音
  for (let i = 0; i < 12 && my === token; i++) {
    const paused = await exec<boolean>(`(() => { const v = document.querySelector('video'); if (!v) return false; v.muted = true; v.pause(); return true; })()`);
    if (paused) break;
    await sleep(400);
  }
  box?.classList.remove('browsing');
}

// ── 放一段 ─────────────────────────────────────────────

interface VideoState { t: number; paused: boolean; ready: number }

/** 视频页里只留播放器，铺满整个框；弹幕、控制条、推荐都藏起来 */
const PLAYER_ONLY = `(() => {
  const css = \`
    html, body { overflow: hidden !important; background: #000 !important; }
    #bilibili-player, .bpx-player-container {
      position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
      z-index: 2147483646 !important; max-width: none !important; max-height: none !important;
    }
    .bpx-player-video-wrap, .bpx-player-video-area { width: 100% !important; height: 100% !important; }
    .bpx-player-control-wrap, .bpx-player-row-dm-wrap, .bpx-player-sending-area, .bpx-player-top-wrap,
    .bpx-player-toast-wrap, .bpx-player-ending-panel, .bili-mini-mask, .login-tip, .vip-login-tip,
    .bpx-player-dialog-wrap, .bpx-player-cmd-dm-wrap, .bpx-player-adv-dm-wrap, .bpx-player-state-wrap,
    #biliMainHeader, .bili-header, .fixed-header, .bili-header__bar, header { display: none !important; }
    /* 播放器的祖先不能有 transform，不然 fixed 铺不满 */
    #app, .video-container-v1, .left-container, #playerWrap, .player-wrap { transform: none !important; filter: none !important; }
  \`;
  let style = document.getElementById('hiyori-player-only');
  if (!style) { style = document.createElement('style'); style.id = 'hiyori-player-only'; document.documentElement.append(style); }
  style.textContent = css;
})()`;

/** 截一张正在放的画面（给看图模型） */
async function snapshot(): Promise<string | null> {
  try {
    const img = await view?.capturePage();
    return img && !img.isEmpty() ? img.toDataURL() : null;
  } catch {
    return null;
  }
}

/** 放 [startSec, startSec + clipSec)，放完暂停在最后一帧；返回是不是真的放了，以及放的时候截的画面 */
async function play(bvid: string, startSec: number, clipSec: number): Promise<{ played: boolean; frames: string[] }> {
  const my = ++token;
  hideCursor();
  frame()?.classList.remove('browsing');
  // 演示打开时已经停在这个视频页上了：直接放；不然直接打开
  let el = view;
  if (onVideo !== bvid || !el) {
    el = load(`https://www.bilibili.com/video/${bvid}/?t=${Math.floor(startSec)}`);
    onVideo = bvid;
    if (!el) return { played: false, frames: [] };
    await waitLoaded(el);
  }
  await exec(PLAYER_ONLY);
  frame()?.classList.add('playing');
  const frames: string[] = [];
  // 截图的时刻：片段的 1/4、1/2、3/4（片段就是弹幕最多的那段）
  const shotAt = [0.25, 0.5, 0.75].map((f) => startSec + clipSec * f);
  await exec(`(() => { const v = document.querySelector('video'); if (v) v.currentTime = ${startSec}; })()`);

  const begun = performance.now();
  let started = false;
  let volume = -1;
  const state = () => exec<VideoState>(`(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    if (v.paused) v.play().catch(() => {});
    return { t: v.currentTime, paused: v.paused, ready: v.readyState };
  })()`);

  while (my === token) {
    await sleep(250);
    const s = await state();
    const elapsed = performance.now() - begun;
    if (s && !s.paused && s.ready >= 2) {
      if (!started) {
        started = true;
        // 页面还没认 currentTime（刚加载完）：再跳一次
        if (Math.abs(s.t - startSec) > 3) await exec(`(() => { const v = document.querySelector('video'); if (v) v.currentTime = ${startSec}; })()`);
      }
      const target = liveliness.isSpeaking ? DUCKED : VOLUME;
      if (target !== volume) {
        volume = target;
        await exec(`(() => { const v = document.querySelector('video'); if (v) { v.muted = false; v.volume = ${target}; } })()`);
      }
      if (shotAt.length && s.t >= shotAt[0]) {
        shotAt.shift();
        const shot = await snapshot();
        if (shot) frames.push(shot);
      }
      if (s.t >= startSec + clipSec) break;
    }
    if (!started && elapsed > START_TIMEOUT_MS) break;
    // 卡住了也别一直等
    if (started && elapsed > (clipSec + 20) * 1000) break;
  }
  await exec(`(() => { const v = document.querySelector('video'); if (v) v.pause(); })()`);
  frame()?.classList.remove('playing');
  return { played: started, frames };
}

export function stopWatchPlayer(): void {
  token += 1;
  onVideo = null;
  hideCursor();
  frame()?.classList.remove('playing', 'browsing');
  if (view && view.src !== HOME) {
    view.src = HOME;
    setAddress(HOME);
  }
}

export function initWatchPlayer(): void {
  const api = window.liveAPI;
  if (!api?.onPlayer) return;
  api.onPlayer((cmd) => {
    if (cmd.action === 'stop') stopWatchPlayer();
    else if (cmd.action === 'open') void open(cmd.bvid, cmd.title);
    else void play(cmd.bvid, cmd.startSec, cmd.clipSec).then((r) => api.playerDone(cmd.id, r.played, r.frames));
  });
}
