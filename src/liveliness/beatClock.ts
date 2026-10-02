/**
 * 节拍时钟：从起音强度曲线推出速度和相位，然后自己按拍子走。
 *
 * 估计（每 250 ms 一次，用最近 8 秒）：
 *   1. 速度：对起音强度曲线做自相关，拍子是曲线里最强的周期。
 *      不挑离散鼓点 —— 真实歌曲里人声、和弦也会冒尖，离散点间隔很乱；
 *      连续曲线里，弱一些的规律成分也算得进去。
 *   2. 相位：按这个周期把曲线叠起来（梳状滤波），叠得最整齐的偏移就是拍点位置。
 *   3. 把握 = 速度稳定 × 声音连续：
 *      - 说话的重音也有一定节奏，偶尔会连续两三秒像有拍子，但很快就乱了；音乐能稳几十秒。
 *      - 说话在词句之间有很多停顿，音乐几乎一直有声音（视频里说话配背景音乐时，
 *        背景音乐是连续的，跟着它晃也合理）。
 *      两样单看都有重叠，但说话「像有节奏」的时候照样有停顿，相乘就分开了。
 *
 * 振荡器按估计的速度连续前进，估计只用来轻轻校正它：漏检、说话打断都不会断拍。
 * 只有新速度连续几次明显更强才换速度，切分节奏造成的次要周期偶尔冒头不会把它带偏。
 */

const STEP_MS = 10;
const WINDOW_MS = 8000;
const MIN_HISTORY_MS = 4000;
const ANALYSE_EVERY_MS = 250;
const MIN_PERIOD_MS = 375;        // 160 BPM：再快的歌，人也是按半速跟着晃
const MAX_PERIOD_MS = 1000;       // 60 BPM
const PREFERRED_PERIOD_MS = 500;  // 120 BPM：同时对得上 1 拍和 2 拍时，偏向常见速度
/** 比当前速度强这么多、并且连续出现这么多次，才换速度 */
const SWITCH_RATIO = 1.25;
const SWITCH_COUNT = 3;
/** 两个周期相差在这个比例内算同一个速度 */
const SAME_TEMPO = 0.05;
/** 用最近多少次估计判断速度稳不稳（24 次 = 6 秒）：说话的「节奏」最多稳三四秒，音乐能稳几十秒 */
const AGREEMENT_SPAN = 24;
/** 曲线断开超过这么久（比如她在说话，不往里送数据），旧数据作废，重新攒 */
const GAP_RESET_MS = 300;
/** 声音连续度：最近 6 秒里有多少帧离「响的时候」不到 20 dB */
const CONTINUITY_WINDOW_MS = 6000;
const CONTINUITY_RANGE_DB = 20;
/** 连续度换算成系数的区间：说话通常 0.55–0.73，音乐通常 0.8 以上 */
const CONTINUITY_SPEECH = 0.68;
const CONTINUITY_MUSIC = 0.82;

const frac = (x: number): number => x - Math.floor(x);
/** 把相位差折到 [-0.5, 0.5) */
const wrapHalf = (x: number): number => frac(x + 0.5) - 0.5;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export interface TempoEstimate {
  periodMs: number;
  /** 拍点所在的时刻（任一拍） */
  beatTimeMs: number;
  /** 自相关峰相对整条曲线中位数高出多少：峰越突出越像有拍子 */
  contrast: number;
  /** 打分（含速度先验），用于比较两个候选 */
  score: number;
}

/**
 * 在一段等间隔的起音强度曲线上估计速度和相位。
 * @param curve 每 STEP_MS 一个点，最后一个点对应 endMs
 * @param keepPeriodMs 当前锁定的速度：返回它的打分，用来判断要不要换
 */
export function estimateTempo(curve: Float32Array, endMs: number, keepPeriodMs?: number): { best: TempoEstimate; kept?: TempoEstimate } | null {
  const n = curve.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += curve[i];
  mean /= n;
  // 只保留高出平均的部分：起音是「冒尖」，平稳段不该参与
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = Math.max(0, curve[i] - mean);

  const ac = (lag: number): number => {
    let sum = 0;
    for (let i = lag; i < n; i++) sum += y[i] * y[i - lag];
    return sum / (n - lag);
  };
  const energy = ac(0);
  if (energy <= 1e-9) return null;

  const minLag = Math.round(MIN_PERIOD_MS / STEP_MS);
  const maxLag = Math.round(MAX_PERIOD_MS / STEP_MS);
  const norm = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) norm[lag] = ac(lag) / energy;
  const sorted = Array.from(norm.slice(minLag, maxLag + 1)).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];

  const prior = (periodMs: number) => Math.exp(-0.5 * (Math.log2(periodMs / PREFERRED_PERIOD_MS) / 0.9) ** 2);
  const evaluate = (lag: number): TempoEstimate => {
    // 抛物线插值：10 ms 一格太粗（120 BPM 时约 2%），用相邻两点把峰位置算准
    const a = norm[lag - 1], b = norm[lag], c = norm[lag + 1];
    const denominator = a - 2 * b + c;
    const offset = denominator < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / denominator)) : 0;
    const periodMs = (lag + offset) * STEP_MS;
    return { periodMs, beatTimeMs: beatTime(y, periodMs, endMs), contrast: b - median, score: b * prior(periodMs) };
  };

  let bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (norm[lag] * prior(lag * STEP_MS) > norm[bestLag] * prior(bestLag * STEP_MS)) bestLag = lag;
  }
  const best = evaluate(bestLag);
  if (keepPeriodMs === undefined) return { best };
  // 当前速度附近（±SAME_TEMPO）的局部峰
  const lo = Math.max(minLag, Math.floor(keepPeriodMs * (1 - SAME_TEMPO) / STEP_MS));
  const hi = Math.min(maxLag, Math.ceil(keepPeriodMs * (1 + SAME_TEMPO) / STEP_MS));
  let keptLag = lo;
  for (let lag = lo; lag <= hi; lag++) if (norm[lag] > norm[keptLag]) keptLag = lag;
  return { best, kept: evaluate(keptLag) };
}

/** 梳状叠加：按周期把最近 4 秒叠起来，最整齐的偏移就是拍点 */
function beatTime(y: Float32Array, periodMs: number, endMs: number): number {
  const period = periodMs / STEP_MS;
  const beats = Math.max(1, Math.floor(4000 / periodMs));
  let bestOffset = 0;
  let bestSum = -1;
  for (let offset = 0; offset < period; offset++) {
    let sum = 0;
    for (let k = 0; k < beats; k++) {
      const i = Math.round(y.length - 1 - offset - k * period);
      if (i < 0) break;
      // 相邻一格也算上，容忍几毫秒的抖动
      sum += y[i] + 0.5 * ((y[i - 1] ?? 0) + (y[i + 1] ?? 0));
    }
    if (sum > bestSum) { bestSum = sum; bestOffset = offset; }
  }
  return endMs - bestOffset * STEP_MS;
}

export class BeatClock {
  private readonly curve = new Float32Array(WINDOW_MS / STEP_MS);
  /** 与 curve 对齐的音量（dB） */
  private readonly levels = new Float32Array(WINDOW_MS / STEP_MS);
  /** curve 里已有多少有效点（攒够 MIN_HISTORY_MS 才开始估计） */
  private filled = 0;
  private lastSample: { t: number; v: number; db: number } | null = null;
  private nextAnalysisMs = 0;

  private periodMs: number | null = null;
  private candidate: { periodMs: number; count: number } | null = null;
  private readonly recentPeriods: number[] = [];
  private contrast = 0;
  private continuity = 0;
  private confidenceValue = 0;
  private lastAnalysisMs = -Infinity;

  /** 连续节拍位置：整数部分是第几拍，小数部分是拍内相位 */
  private positionValue = 0;
  private clockMs: number | null = null;

  /** 每帧送入这一帧的起音强度和音量（RMS） */
  pushFrame(flux: number, rms: number, timeMs: number): void {
    const db = 20 * Math.log10(rms + 1e-6);
    if (this.lastSample && timeMs - this.lastSample.t > GAP_RESET_MS) this.clearHistory();
    if (!this.lastSample) {
      this.lastSample = { t: timeMs, v: flux, db };
      return;
    }
    // 帧间隔不固定（掉帧、远程桌面），线性插值到 10 ms 的等间隔网格上
    const { t: t0, v: v0, db: db0 } = this.lastSample;
    for (let t = Math.floor(t0 / STEP_MS) * STEP_MS + STEP_MS; t <= timeMs; t += STEP_MS) {
      const k = (t - t0) / Math.max(1e-6, timeMs - t0);
      this.curve.copyWithin(0, 1);
      this.curve[this.curve.length - 1] = v0 + (flux - v0) * k;
      this.levels.copyWithin(0, 1);
      this.levels[this.levels.length - 1] = db0 + (db - db0) * k;
      this.filled = Math.min(this.curve.length, this.filled + 1);
    }
    this.lastSample = { t: timeMs, v: flux, db };
    if (this.filled * STEP_MS >= MIN_HISTORY_MS && timeMs >= this.nextAnalysisMs) {
      this.nextAnalysisMs = timeMs + ANALYSE_EVERY_MS;
      this.analyse(timeMs);
    }
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

  /** 是在放有规律的音乐的把握 [0, 1]；几秒没有新估计（比如她一直在说话）就慢慢降下去 */
  confidence(nowMs: number): number {
    const stale = nowMs - this.lastAnalysisMs;
    return stale <= 2000 ? this.confidenceValue : this.confidenceValue * Math.exp(-(stale - 2000) / 3000);
  }

  /** 诊断用 */
  diagnostics() {
    return {
      contrast: Number(this.contrast.toFixed(3)),
      agreement: Number(this.agreement().toFixed(2)),
      continuity: Number(this.continuity.toFixed(2)),
    };
  }

  reset(): void {
    this.clearHistory();
    this.periodMs = null;
    this.candidate = null;
    this.recentPeriods.length = 0;
    this.contrast = 0;
    this.continuity = 0;
    this.confidenceValue = 0;
    this.lastAnalysisMs = -Infinity;
    this.positionValue = 0;
    this.clockMs = null;
  }

  private clearHistory(): void {
    this.curve.fill(0);
    this.levels.fill(-120);
    this.filled = 0;
    this.lastSample = null;
  }

  /** 最近 6 秒里有多少帧离「响的时候」（90 分位）不到 20 dB */
  private measureContinuity(): number {
    const count = Math.min(this.filled, CONTINUITY_WINDOW_MS / STEP_MS);
    const recent = Array.from(this.levels.subarray(this.levels.length - count));
    const reference = [...recent].sort((a, b) => a - b)[Math.floor(count * 0.9)];
    return recent.filter(db => db > reference - CONTINUITY_RANGE_DB).length / count;
  }

  private agreement(): number {
    if (!this.periodMs || !this.recentPeriods.length) return 0;
    const same = this.recentPeriods.filter(p => Math.abs(p - this.periodMs!) / this.periodMs! <= SAME_TEMPO).length;
    return same / AGREEMENT_SPAN;
  }

  private analyse(nowMs: number): void {
    const result = estimateTempo(this.curve, nowMs, this.periodMs ?? undefined);
    this.lastAnalysisMs = nowMs;
    if (!result) {
      this.contrast = 0;
      this.confidenceValue *= 0.7;
      return;
    }
    const { best, kept } = result;
    this.recentPeriods.push(best.periodMs);
    if (this.recentPeriods.length > AGREEMENT_SPAN) this.recentPeriods.shift();

    let chosen = kept ?? best;
    if (!this.periodMs) {
      this.syncClock(nowMs);
      this.periodMs = best.periodMs;
      chosen = best;
      this.positionValue = Math.floor(this.positionValue) + frac((nowMs - best.beatTimeMs) / best.periodMs);
    } else if (kept && Math.abs(best.periodMs - kept.periodMs) / kept.periodMs > SAME_TEMPO && best.score > kept.score * SWITCH_RATIO) {
      // 另一个速度明显更强：连续出现几次才换，偶尔冒头的次要周期不理
      const same = this.candidate && Math.abs(this.candidate.periodMs - best.periodMs) / best.periodMs <= SAME_TEMPO;
      this.candidate = { periodMs: best.periodMs, count: same ? this.candidate!.count + 1 : 1 };
      if (this.candidate.count >= SWITCH_COUNT) {
        this.syncClock(nowMs);
        this.periodMs = best.periodMs;
        chosen = best;
        this.candidate = null;
        this.recentPeriods.length = 0;
        this.positionValue = Math.floor(this.positionValue) + frac((nowMs - best.beatTimeMs) / best.periodMs);
      }
    } else {
      this.candidate = null;
    }

    // 周期慢慢靠过去，相位轻轻拉过去（画面层还会再平滑一次）。刚锁定或刚换速度时这里是空操作
    this.syncClock(nowMs);
    this.periodMs += (chosen.periodMs - this.periodMs) * 0.3;
    const gridPhase = frac((nowMs - chosen.beatTimeMs) / chosen.periodMs);
    this.positionValue += 0.3 * wrapHalf(gridPhase - this.phase);

    this.contrast = chosen.contrast;
    this.continuity = this.measureContinuity();
    const continuous = clamp01((this.continuity - CONTINUITY_SPEECH) / (CONTINUITY_MUSIC - CONTINUITY_SPEECH));
    // 速度稳定 × 声音连续；峰太平（几乎没起伏）时再打个折
    const target = this.agreement() * continuous * clamp01(chosen.contrast / 0.06);
    // 升得快、降得慢：歌里短暂的安静段落不该让她停下来；说话时把握本来就升不起来
    this.confidenceValue += (target - this.confidenceValue) * (target > this.confidenceValue ? 0.35 : 0.12);
  }

  /** 只往前走，不倒退 */
  private syncClock(nowMs: number): void {
    if (this.clockMs !== null && this.periodMs && nowMs > this.clockMs) {
      this.positionValue += (nowMs - this.clockMs) / this.periodMs;
    }
    if (this.clockMs === null || nowMs > this.clockMs) this.clockMs = nowMs;
  }
}
