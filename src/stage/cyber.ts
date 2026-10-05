/**
 * 情报站的赛博外壳：背景（霓虹网格、光环、竖排大字）和两组跟着她声音跳的音量柱——
 * 底部一排大的，顶栏里一个 cava 式的小的；顶栏右边的时钟也在这里走。
 * 只在 watch 布局显示，每帧由 stage.ts 的循环调 cyberFrame。
 */

import type { StagePulse } from './themes';

let bigBars: HTMLElement[] = [];
let miniBars: HTMLElement[] = [];
let seeds: number[] = [];

function bars(id: string, count: number): HTMLElement[] {
  const box = document.getElementById(id);
  if (!box) return [];
  box.innerHTML = '<i></i>'.repeat(count);
  return [...box.querySelectorAll<HTMLElement>('i')];
}

function tickClock(): void {
  const clock = document.getElementById('ide-clock');
  if (!clock) return;
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  clock.textContent = `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 公告板：第一行做标题，其余一行一条 */
function renderBoard(state: { board: { show: boolean }; lines: string[] }): void {
  const box = document.getElementById('ide-board');
  const title = document.getElementById('board-title');
  const list = document.getElementById('board-lines');
  if (!box || !title || !list) return;
  const [head, ...rest] = state.lines;
  const show = state.board.show && !!head;
  box.hidden = !show;
  document.body.classList.toggle('stage-board', show);
  title.textContent = head ?? '';
  list.replaceChildren(...rest.map((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    return li;
  }));
}

/** 弹幕栏接在公告板下面（公告行数不定；切到情报站布局时才有高度） */
function followBoardHeight(): void {
  const box = document.getElementById('ide-board');
  if (!box) return;
  new ResizeObserver(() => {
    if (box.offsetHeight) document.body.style.setProperty('--board-bottom', `${36 + box.offsetHeight + 8}px`);
  }).observe(box);
}

export function initCyber(): void {
  const api = window.liveAPI;
  followBoardHeight();
  if (api?.getBoard) {
    void api.getBoard().then(renderBoard);
    api.onBoard(renderBoard);
  }
  bigBars = bars('cy-eq', 56);
  miniBars = bars('ide-cava', 18);
  seeds = Array.from({ length: Math.max(bigBars.length, miniBars.length) }, () => Math.random() * Math.PI * 2);
  tickClock();
  setInterval(tickClock, 15_000);
}

/** 和星光主题的均衡器一个算法：有音乐跟音乐，她说话跟她的声音，都没有时轻轻起伏 */
export function cyberFrame(pulse: StagePulse, t: number): void {
  if (document.body.dataset.stageSegment !== 'watch') return;
  const drive = Math.max(pulse.groove * (0.4 + 0.6 * pulse.beat), pulse.voice * 2.2, 0.12);
  const level = (i: number) => {
    const wave = 0.5 + 0.5 * Math.sin(t * (2.2 + (i % 7) * 0.35) + seeds[i]);
    return Math.min(1, 0.08 + drive * (0.35 + 0.65 * wave));
  };
  bigBars.forEach((bar, i) => { bar.style.transform = `scaleY(${level(i).toFixed(3)})`; });
  miniBars.forEach((bar, i) => { bar.style.transform = `scaleY(${level(i + 3).toFixed(3)})`; });
}
