/**
 * 直播间主题：一整套场景（多层动态背景 + 粒子 + PV 风的文字飘带）和配色。
 * 场景是 DOM + CSS 动画，粒子画在背景层的 canvas 上；每帧拿音乐节拍和她的声音做一点律动。
 * 新主题：在 THEMES 里加一项，在 themes.css 里写 [data-stage-theme="xxx"] 的样式。
 */

import type { LiveTheme } from '../../shared/types/live';
import type { EmitterSpec } from './particles';

export interface StagePulse {
  /** 拍点刚过时接近 1，随后衰减到 0；没有音乐时为 0 */
  beat: number;
  /** 音乐律动强度 0–1 */
  groove: number;
  /** 她说话的音量 0–1 */
  voice: number;
}

export interface ThemeScene {
  emitters: EmitterSpec[];
  /** 每帧调用（律动） */
  frame?(pulse: StagePulse, timeSec: number): void;
}

interface ThemeDef {
  /** 场景 DOM；tapeText 是飘带上滚动的文字 */
  build(root: HTMLElement, tapeText: string): ThemeScene;
}

function html(root: HTMLElement, markup: string): void {
  root.innerHTML = markup;
}

/** PV 风的斜向文字飘带：一段文字重复铺满，CSS 让它无限滚动 */
function tape(cls: string, text: string): string {
  const unit = `<span>${escapeHtml(text)}</span>`;
  return `<div class="pv-tape ${cls}"><div class="pv-tape-track">${unit.repeat(8)}</div></div>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** 樱花枝：左上角伸进画面，随风轻轻摆 */
const SAKURA_BRANCH = `
<svg class="sk-branch" viewBox="0 0 420 300" aria-hidden="true">
  <path d="M-10 40 C 80 60, 140 50, 210 90 S 330 140, 400 130" stroke="#8a5a64" stroke-width="9" fill="none" stroke-linecap="round"/>
  <path d="M150 62 C 170 20, 200 10, 230 5" stroke="#8a5a64" stroke-width="5" fill="none" stroke-linecap="round"/>
  <path d="M260 108 C 270 160, 300 190, 330 210" stroke="#8a5a64" stroke-width="5" fill="none" stroke-linecap="round"/>
  ${[[60, 48], [110, 70], [175, 40], [230, 8], [215, 95], [270, 118], [300, 190], [335, 212], [360, 128], [395, 132], [140, 30], [250, 150]]
    .map(([x, y], i) => `<g class="sk-flower" style="--d:${(i * 0.37) % 3}s" transform="translate(${x} ${y})">${
      [0, 72, 144, 216, 288].map((r) => `<ellipse rx="9" ry="14" cy="-11" transform="rotate(${r})" fill="${i % 3 ? '#ffd1e3' : '#ffb7d2'}"/>`).join('')
    }<circle r="5" fill="#ff8fb8"/></g>`).join('')}
</svg>`;

const THEMES: Record<LiveTheme, ThemeDef> = {
  sakura: {
    build(root, text) {
      html(root, `
        <div class="sk-sky"></div>
        <div class="sk-sun"><div class="sk-rays"></div></div>
        <div class="sk-cloud c1"></div><div class="sk-cloud c2"></div><div class="sk-cloud c3"></div>
        <div class="pv-bigtext">Hiyori</div>
        ${tape('t1', `${text} ✦ HIYORI LIVE ✦ いらっしゃい ✦ `)}
        ${tape('t2', `♡ 今天也要开心哦 ♡ STREAMING NOW ♡ `)}
        <div class="sk-hill h1"></div><div class="sk-hill h2"></div>
        ${SAKURA_BRANCH}
      `);
      return {
        emitters: [
          { kind: 'petal', rate: 3.2, colors: ['#ffc4dc', '#ffb0cf', '#ffe0ec', '#ff9ec4'], size: [9, 17], from: 'top', speed: [40, 80], life: [10, 18], sway: 60, drift: 25 },
          { kind: 'bokeh', rate: 0.5, colors: ['rgba(255,255,255,0.7)', 'rgba(255,214,234,0.7)'], size: [18, 46], from: 'anywhere', speed: [6, 14], life: [6, 10], alpha: [0.3, 0.6] },
          { kind: 'sparkle', rate: 0.8, colors: ['#ffffff', '#fff2a8'], size: [4, 8], from: 'anywhere', speed: [4, 10], life: [1.5, 3], alpha: [0.7, 1] },
        ],
      };
    },
  },

  starlight: {
    build(root, text) {
      html(root, `
        <div class="st-sky"></div>
        <div class="st-ring r1"></div><div class="st-ring r2"></div>
        <div class="st-beam b1"></div><div class="st-beam b2"></div><div class="st-beam b3"></div><div class="st-beam b4"></div>
        <div class="pv-bigtext">LIVE</div>
        ${tape('t1', `♪ ${text} ♪ HIYORI ON STAGE ♪ `)}
        <div class="st-floor"></div>
        <div class="st-eq">${'<i></i>'.repeat(48)}</div>
      `);
      const bars = [...root.querySelectorAll<HTMLElement>('.st-eq i')];
      const beams = [...root.querySelectorAll<HTMLElement>('.st-beam')];
      const seeds = bars.map(() => Math.random() * Math.PI * 2);
      return {
        emitters: [
          { kind: 'star', rate: 2.5, colors: ['#ffffff', '#cfe3ff', '#ffe9a8'], size: [2, 5], from: 'anywhere', speed: [0, 3], life: [3, 7], alpha: [0.5, 1] },
          { kind: 'note', rate: 0.9, colors: ['#ff9be0', '#9fd8ff', '#ffe08a'], size: [12, 20], from: 'bottom', speed: [30, 60], life: [8, 12], sway: 30 },
          { kind: 'sparkle', rate: 0.6, colors: ['#ffffff', '#ff9be0'], size: [5, 10], from: 'anywhere', speed: [4, 10], life: [1.2, 2.4] },
        ],
        frame(pulse, t) {
          // 均衡器：有音乐跟音乐，她说话跟她的声音，都没有时轻轻起伏
          const drive = Math.max(pulse.groove * (0.4 + 0.6 * pulse.beat), pulse.voice * 2.2, 0.12);
          bars.forEach((bar, i) => {
            const wave = 0.5 + 0.5 * Math.sin(t * (2.2 + (i % 7) * 0.35) + seeds[i]);
            bar.style.transform = `scaleY(${(0.08 + drive * (0.35 + 0.65 * wave)).toFixed(3)})`;
          });
          const glow = (0.55 + 0.45 * Math.max(pulse.beat * pulse.groove, pulse.voice * 1.5)).toFixed(3);
          for (const beam of beams) beam.style.opacity = glow;
        },
      };
    },
  },

  arcade: {
    build(root, text) {
      html(root, `
        <div class="ar-sky"></div>
        <div class="ar-sun"></div>
        <div class="ar-mountains"></div>
        <div class="ar-grid-wrap"><div class="ar-grid"></div></div>
        <div class="pv-bigtext">GAME</div>
        ${tape('t1', `▶ ${text} ▶ PRESS START ▶ HIYORI PLAYS ▶ `)}
        <div class="ar-scan"></div>
      `);
      const grid = root.querySelector<HTMLElement>('.ar-grid')!;
      return {
        emitters: [
          { kind: 'pixel', rate: 1.6, colors: ['#ff5fd2', '#5ff4ff', '#ffe35f', '#a77bff'], size: [5, 10], from: 'bottom', speed: [30, 70], life: [7, 11], sway: 10 },
          { kind: 'star', rate: 1.2, colors: ['#ffffff', '#ffd6ff'], size: [2, 4], from: 'anywhere', speed: [0, 2], life: [2, 5] },
        ],
        frame(pulse) {
          grid.style.setProperty('--grid-boost', (1 + pulse.groove * pulse.beat * 0.6).toFixed(3));
        },
      };
    },
  },
};

export function buildTheme(theme: LiveTheme, root: HTMLElement, tapeText: string): ThemeScene {
  return (THEMES[theme] ?? THEMES.sakura).build(root, tapeText);
}

/** 弹大事件时前景炸开的颜色 */
export const THEME_BURST_COLORS: Record<LiveTheme, string[]> = {
  sakura: ['#ff8fbf', '#ffc2dc', '#ffe08a', '#b79cff', '#ffffff'],
  starlight: ['#ff9be0', '#9fd8ff', '#ffe08a', '#ffffff', '#c6a2ff'],
  arcade: ['#ff5fd2', '#5ff4ff', '#ffe35f', '#a77bff', '#ffffff'],
};
