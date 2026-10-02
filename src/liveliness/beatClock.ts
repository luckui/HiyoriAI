/**
 * 节拍时钟：从零散的 onset（鼓点）推出速度和相位，然后自己按拍子走。
 *
 * 旧做法是「检测到一个鼓点就动一下」，动作永远落后半拍，而且漏检就停。
 * 跳舞的人是预判拍子、在拍点上落下的，所以这里做成一个锁相环：
 *   1. 用最近几秒的 onset 估计周期：候选周期里，onset 在哪个周期的网格上最整齐
 *   2. 振荡器按周期连续前进；新 onset 落在预测拍点附近时，轻轻把相位拉过去
 *   3. 没有新 onset 时继续按原速走一会儿（漏检、说话打断都不会断），再慢慢淡出
 *
 * 一致度（coherence）同时用来区分音乐和说话：说话的 onset 不规律，对不上任何网格。
 */

const MIN_PERIOD_MS = 300;        // 200 BPM
const MAX_PERIOD_MS = 1000;       // 60 BPM
const PREFERRED_PERIOD_MS = 500;  // 120 BPM：同时对得上 1 拍和 2 拍网格时，偏向常见速度
const WINDOW_MS = 8000;
const MIN_ONSETS = 6;

interface Onset { t: number; w: number }

interface PeriodEstimate {
  periodMs: number;
  /** onset 落在网格上的整齐程度 [0, 1] */
  coherence: number;
  /**
   * 扣掉随机也能凑出来的一致度后的显著性 [0, 1]。
   * onset 少时，随便哪组时间点都能在一百多个候选周期里挑出一个看着整齐的，
   * 期望值约 2/√n，所以只有明显高于这条线才算真的有拍子。
   */
  significance: number;
  /** 网格偏移：拍点满足 t / periodMs - offset ∈ ℤ */
  offset: number;
}

const frac = (x: number): number => x - Math.floor(x);
/** 把相位差折到 [-0.5, 0.5) */
const wrapHalf = (x: number): number => frac(x + 0.5) - 0.5;

export function estimatePeriod(onsets: Onset[]): PeriodEstimate {
  const latest = onsets[onsets.length - 1].t;
  let best = { periodMs: PREFERRED_PERIOD_MS, coherence: 0, offset: 0, score: -1 };
  let sumW = 0;
  let sumW2 = 0;
  for (const onset of onsets) {
    const w = onset.w * Math.exp(-(latest - onset.t) / 4000);
    sumW += w;
    sumW2 += w * w;
  }
  const chance = Math.min(0.95, 2 / Math.sqrt((sumW * sumW) / sumW2));
  for (let period = MIN_PERIOD_MS; period <= MAX_PERIOD_MS; period *= 1.01) {
    let re = 0;
    let im = 0;
    let total = 0;
    for (const onset of onsets) {
      // 越新的 onset 权重越大，换歌后几秒内就能跟上新速度
      const w = onset.w * Math.exp(-(latest - onset.t) / 4000);
      const angle = 2 * Math.PI * (onset.t / period);
      re += w * Math.cos(angle);
      im += w * Math.sin(angle);
      total += w;
    }
    const coherence = Math.hypot(re, im) / total;
    const octaves = Math.log2(period / PREFERRED_PERIOD_MS);
    const prior = Math.exp(-0.5 * (octaves / 0.6) ** 2);
    const score = coherence * (0.6 + 0.4 * prior);
    if (score > best.score) {
      best = { periodMs: period, coherence, offset: frac(Math.atan2(im, re) / (2 * Math.PI)), score };
    }
  }
  const significance = Math.max(0, (best.coherence - chance) / (1 - chance));
  return { periodMs: best.periodMs, coherence: best.coherence, significance, offset: best.offset };
}

export class BeatClock {
  private onsets: Onset[] = [];
  private periodMs: number | null = null;
  private significance = 0;
  private lastOnsetMs = -Infinity;
  /** 连续节拍位置：整数部分是第几拍，小数部分是拍内相位 */
  private positionValue = 0;
  private clockMs: number | null = null;

  onOnset(tMs: number, strength = 1): void {
    this.lastOnsetMs = tMs;
    this.onsets.push({ t: tMs, w: Math.max(0.1, strength) });
    this.onsets = this.onsets.filter(onset => tMs - onset.t <= WINDOW_MS);
    if (this.onsets.length < MIN_ONSETS) return;

    const estimate = estimatePeriod(this.onsets);
    this.significance = estimate.significance;
    const gridPhase = frac(tMs / estimate.periodMs - estimate.offset);

    if (this.periodMs === null || Math.abs(estimate.periodMs - this.periodMs) / this.periodMs > 0.12) {
      // 第一次锁定或换了速度：直接采用新周期，相位对齐网格
      this.syncClock(tMs);
      this.periodMs = estimate.periodMs;
      this.positionValue = Math.floor(this.positionValue) + gridPhase;
      return;
    }

    this.syncClock(tMs);
    this.periodMs += (estimate.periodMs - this.periodMs) * 0.25;
    const error = wrapHalf(gridPhase - this.phaseAt(tMs));
    // 只校正落在预测拍点附近的 onset：大幅偏离的多半是反拍或误检
    if (Math.abs(error) < 0.25) this.positionValue += error * 0.35;
  }

  /** 每帧调用，让时钟走到 nowMs */
  advance(nowMs: number): void {
    this.syncClock(nowMs);
  }

  get bpm(): number | null {
    return this.periodMs ? 60000 / this.periodMs : null;
  }

  /** 拍内相位 [0, 1)，0 是拍点 */
  get phase(): number {
    return frac(this.positionValue);
  }

  /** 连续节拍位置，用来做跨多拍的摆动（比如两拍一个来回） */
  get position(): number {
    return this.positionValue;
  }

  /** 是在放有规律的音乐的把握 [0, 1]：网格显著性 × 最近是否还有 onset */
  confidence(nowMs: number): number {
    if (!this.periodMs) return 0;
    const recent = this.onsets.filter(onset => nowMs - onset.t <= WINDOW_MS).length;
    const silence = nowMs - this.lastOnsetMs;
    const grace = 2 * this.periodMs;
    const fade = silence <= grace ? 1 : Math.exp(-(silence - grace) / 1500);
    return recent < MIN_ONSETS ? 0 : this.significance * fade;
  }

  reset(): void {
    this.onsets = [];
    this.periodMs = null;
    this.significance = 0;
    this.lastOnsetMs = -Infinity;
    this.positionValue = 0;
    this.clockMs = null;
  }

  private phaseAt(tMs: number): number {
    return frac(this.positionValue + (this.periodMs ? (tMs - (this.clockMs ?? tMs)) / this.periodMs : 0));
  }

  /** onset 事件可能比上一帧时间还早一点，所以只往前走，不倒退 */
  private syncClock(nowMs: number): void {
    if (this.clockMs !== null && this.periodMs && nowMs > this.clockMs) {
      this.positionValue += (nowMs - this.clockMs) / this.periodMs;
    }
    if (this.clockMs === null || nowMs > this.clockMs) this.clockMs = nowMs;
  }
}
