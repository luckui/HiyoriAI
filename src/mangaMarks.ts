/**
 * 漫符：漫画里画在角色头上的符号 —— 生气的「井」字青筋、害羞的腮红斜线、惊讶的「！」、
 * 疑问的「？」、低落的阴影线、思考的「…」、兴奋的闪光。
 *
 * 画在 Live2D 画布上面的一层透明画布里，每帧按模型此刻的脸、脸颊、头顶位置定位
 * （见 LAppModel.getAnchors），所以头歪、转、低下去，漫符都跟着走。
 * 表情由灵动层决定（liveliness.expressionState），这里只负责画：
 * 换表情时弹出来，持续时轻轻跳动，换掉或淡下去时消失。
 */

import type { Expression } from '../shared/expressions';
import { LAppDelegate } from './lappdelegate';
import type { AnchorRect, ModelAnchors } from './lappmodel';
import { liveliness } from './liveliness/motor';

/** 表情强度低于这个不画：平淡的情绪配漫符太吵 */
const MIN_INTENSITY = 0.5;
const FADE_IN_SEC = 0.18;
const FADE_OUT_SEC = 0.3;

type Painter = (ctx: CanvasRenderingContext2D, a: ModelAnchors, t: number, pop: number) => void;

/** 弹出时的过冲：0 → 1.15 → 1 */
function popScale(age: number): number {
  const p = Math.min(1, age / 0.25);
  return p < 1 ? 1.15 * Math.sin((p * Math.PI) / 2) ** 0.6 : 1;
}

function outlinedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, fill: string): void {
  ctx.font = `900 ${size}px "Arial Black", "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = size * 0.16;
  ctx.strokeStyle = 'rgba(40, 30, 40, 0.9)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

/** 「井」字青筋：四段向外拱的弧，围成一个十字 */
const angerVein: Painter = (ctx, a, t, pop) => {
  const f = a.face;
  const size = f.w * 0.3 * pop * (1 + 0.08 * Math.sin(t * 9));
  const cx = f.x + f.w * 0.88;
  const cy = a.headTop + f.h * 0.22;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineCap = 'round';
  for (let k = 0; k < 4; k++) {
    ctx.save();
    ctx.rotate((k * Math.PI) / 2);
    // 每段弧：从十字中心附近出发，向外拱起再收回
    ctx.beginPath();
    ctx.moveTo(size * 0.12, -size * 0.42);
    ctx.quadraticCurveTo(size * 0.12, -size * 0.12, size * 0.42, -size * 0.12);
    ctx.lineWidth = size * 0.16;
    ctx.strokeStyle = 'rgba(60, 10, 10, 0.85)';
    ctx.stroke();
    ctx.lineWidth = size * 0.1;
    ctx.strokeStyle = '#ff3b3b';
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
};

/** 害羞：两颊各几道粉色斜线，下面垫一层淡淡的红晕 */
const blushLines: Painter = (ctx, a, _t, pop) => {
  const f = a.face;
  // 没有脸颊部件时按脸的比例估计两颊位置
  const cheeks: AnchorRect = a.cheeks ?? { x: f.x + f.w * 0.12, y: f.y + f.h * 0.55, w: f.w * 0.76, h: f.h * 0.18 };
  const lines = 4;
  const spots = [cheeks.x + cheeks.w * 0.2, cheeks.x + cheeks.w * 0.8];
  const cy = cheeks.y + cheeks.h * 0.5;
  const len = f.w * 0.08 * pop;
  for (const cx of spots) {
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, f.w * 0.13);
    glow.addColorStop(0, `rgba(255, 110, 140, ${0.35 * pop})`);
    glow.addColorStop(1, 'rgba(255, 110, 140, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(cx - f.w * 0.15, cy - f.w * 0.15, f.w * 0.3, f.w * 0.3);
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.5, f.w * 0.014);
    ctx.strokeStyle = 'rgba(235, 60, 100, 0.85)';
    for (let i = 0; i < lines; i++) {
      const x = cx + (i - (lines - 1) / 2) * f.w * 0.035;
      ctx.beginPath();
      ctx.moveTo(x + len * 0.35, cy - len * 0.5);
      ctx.lineTo(x - len * 0.35, cy + len * 0.5);
      ctx.stroke();
    }
  }
};

const exclamation: Painter = (ctx, a, _t, pop) => {
  const f = a.face;
  outlinedText(ctx, '！', f.x + f.w * 0.95, a.headTop - f.h * 0.02, f.w * 0.45 * pop, '#ffd23f');
};

const question: Painter = (ctx, a, t, pop) => {
  const f = a.face;
  ctx.save();
  ctx.translate(f.x + f.w * 1.0, a.headTop + f.h * 0.02);
  ctx.rotate(0.15 * Math.sin(t * 3));
  outlinedText(ctx, '？', 0, 0, f.w * 0.42 * pop, '#7fd3ff');
  ctx.restore();
};

/** 低落：额头上一排竖着的阴影线，越往下越淡 */
const gloomLines: Painter = (ctx, a, _t, pop) => {
  const f = a.face;
  const top = f.y + f.h * 0.02;
  const bottom = f.y + f.h * 0.42 * pop;
  const gradient = ctx.createLinearGradient(0, top, 0, bottom);
  gradient.addColorStop(0, 'rgba(80, 70, 140, 0.75)');
  gradient.addColorStop(1, 'rgba(80, 70, 140, 0)');
  ctx.strokeStyle = gradient;
  ctx.lineWidth = Math.max(1.5, f.w * 0.018);
  ctx.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    const x = f.x + f.w * (0.22 + i * 0.112);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom - (i % 2) * f.h * 0.06);
    ctx.stroke();
  }
};

/** 思考：头顶旁边的三个点，一个接一个出现 */
const thinkingDots: Painter = (ctx, a, t) => {
  const f = a.face;
  const shown = Math.floor((t * 2) % 4);
  for (let i = 0; i < Math.min(3, shown); i++) {
    ctx.beginPath();
    ctx.arc(f.x + f.w * (0.9 + i * 0.13), a.headTop - f.h * 0.02, f.w * 0.035, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(90, 90, 110, 0.85)';
    ctx.fill();
  }
};

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const radius = i % 2 === 0 ? r : r * 0.28;
    const angle = (i * Math.PI) / 4 - Math.PI / 2;
    ctx.lineTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
  }
  ctx.closePath();
  ctx.fillStyle = '#fff3a8';
  ctx.strokeStyle = 'rgba(230, 170, 30, 0.9)';
  ctx.lineWidth = Math.max(1, r * 0.15);
  ctx.fill();
  ctx.stroke();
}

/** 兴奋：头周围几颗交替闪烁的星 */
const sparkles: Painter = (ctx, a, t, pop) => {
  const f = a.face;
  const spots: Array<[number, number, number]> = [[-0.1, 0.05, 0], [1.08, 0.1, 1.3], [0.98, -0.15, 2.6]];
  for (const [dx, dy, phase] of spots) {
    const twinkle = 0.6 + 0.4 * Math.sin(t * 6 + phase);
    star(ctx, f.x + f.w * dx, a.headTop + f.h * dy, f.w * 0.08 * pop * twinkle);
  }
};

/** 得意：眼角一颗「叮」的小星 */
const smugSparkle: Painter = (ctx, a, t, pop) => {
  const f = a.face;
  star(ctx, f.x + f.w * 0.95, f.y + f.h * 0.38, f.w * 0.07 * pop * (0.8 + 0.2 * Math.sin(t * 5)));
};

const MARKS: Partial<Record<Expression, Painter>> = {
  angry: angerVein,
  shy: blushLines,
  surprised: exclamation,
  curious: question,
  sad: gloomLines,
  thinking: thinkingDots,
  excited: sparkles,
  smug: smugSparkle,
};

function currentAnchors(): ModelAnchors | null {
  try {
    return LAppDelegate.getInstance().getFirstSubdelegate()?.getLive2DManager().getFirstModel()?.getAnchors() ?? null;
  } catch {
    return null;
  }
}

/** 正在显示的漫符：换表情时旧的淡出、新的弹出 */
export interface ShownMark {
  expression: Expression;
  since: number;
  fadingFrom: number | null;
}

/**
 * 推进一帧：返回这帧要显示的漫符和透明度（null 表示不画）。
 * 纯函数，便于测试 —— 曾经出过「刚出现的第一帧透明度为 0，被当成淡出结束清掉，于是永远画不出来」的 bug
 */
export function stepMark(
  shown: ShownMark | null,
  state: { expression: Expression; intensity: number },
  now: number,
): { shown: ShownMark | null; alpha: number } {
  const wanted = state.intensity >= MIN_INTENSITY && MARKS[state.expression] !== undefined;
  let next = shown;
  if (wanted && next?.expression !== state.expression) {
    next = { expression: state.expression, since: now, fadingFrom: null };
  } else if (!wanted && next && next.fadingFrom === null) {
    next = { ...next, fadingFrom: now };
  }
  if (!next) return { shown: null, alpha: 0 };
  if (next.fadingFrom !== null) {
    const alpha = 1 - (now - next.fadingFrom) / FADE_OUT_SEC;
    return alpha > 0 ? { shown: next, alpha } : { shown: null, alpha: 0 };
  }
  return { shown: next, alpha: Math.min(1, (now - next.since) / FADE_IN_SEC) };
}

export function initMangaMarks(): void {
  const overlay = document.getElementById('manga-overlay') as HTMLCanvasElement | null;
  const live2d = document.getElementById('live2d-canvas') as HTMLCanvasElement | null;
  const ctx = overlay?.getContext('2d');
  if (!overlay || !live2d || !ctx) return;

  let shown: ShownMark | null = null;
  const start = performance.now();

  const frame = (): void => {
    requestAnimationFrame(frame);
    // 与 Live2D 画布同样的设备像素尺寸，锚点坐标可以直接用
    if (overlay.width !== live2d.width || overlay.height !== live2d.height) {
      overlay.width = live2d.width;
      overlay.height = live2d.height;
    }
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const now = (performance.now() - start) / 1000;
    const step = stepMark(shown, liveliness.expressionState, now);
    shown = step.shown;
    const anchors = shown && step.alpha > 0 ? currentAnchors() : null;
    if (!shown || !anchors) return;
    ctx.save();
    ctx.globalAlpha = step.alpha;
    MARKS[shown.expression]?.(ctx, anchors, now, popScale(now - shown.since));
    ctx.restore();
  };
  requestAnimationFrame(frame);
}
