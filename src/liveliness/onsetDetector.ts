/**
 * 鼓点（onset）检测：对数频谱通量 + 自适应阈值。
 *
 * 每帧送进来一份频谱（AnalyserNode 的 dB 值），算出「比上一帧突然变响了多少」，
 * 低频（底鼓、贝斯）权重大，中频（军鼓、和弦）权重小。再跟最近一秒的中位水平比，
 * 明显冒尖的局部峰值就是一个 onset。用中位数而不是均值：底鼓的大尖峰会把均值和
 * 标准差一起撑大，军鼓这种小一号的鼓点就被淹掉了。
 *
 * 用 dB 差值而不是绝对能量，所以和系统音量、歌曲响度都无关：
 * 小声放、大声放，同一首歌检测到的鼓点是一样的。
 */

const LOW_BAND_HZ = 250;
const MID_BAND_HZ = 4000;
const MID_WEIGHT = 0.4;
/** dB 下限：静音的 -Infinity 统一压到这里，避免算出无穷大的差值 */
const FLOOR_DB = -160;
const HISTORY_FRAMES = 60;
const MIN_INTERVAL_MS = 150;
/** 冒尖程度：是最近中位通量的几倍才算 */
const THRESHOLD_RATIO = 3;
/**
 * 还要达到最近峰值的这个比例。只看中位数不够：底鼓衰减完、低频重新回到底噪时，
 * 中位数很低，底噪的随机起伏就会被当成鼓点
 */
const PEAK_RATIO = 0.2;
const PEAK_DECAY_MS = 2000;
/** 绝对下限（每 bin 平均 dB 增量）：防止安静段的微小起伏被放大成 onset */
const MIN_FLUX = 0.5;

export interface Onset {
  timeMs: number;
  /**
   * 这一下的低频音量相对最近 onset 平均的倍数（线性幅度）：普通拍约 1，
   * 重拍、drop 明显大于 1。dB 通量只反映「涨了多少」，分不出谁更响，所以单独算。
   */
  strength: number;
}

export class OnsetDetector {
  private previous: Float32Array | null = null;
  private readonly history: number[] = [];
  private lastFlux = 0;
  private lastFluxTime = 0;
  private lastLowDb = FLOOR_DB;
  private onsetLowDbAvg: number | null = null;
  private recentPeak = 0;
  private rising = false;
  private lastOnsetMs = -Infinity;
  private readonly lowBins: number;
  private readonly midBins: number;

  /** @param binHz 每个频率 bin 的宽度：sampleRate / fftSize */
  constructor(binHz: number) {
    this.lowBins = Math.max(2, Math.round(LOW_BAND_HZ / binHz));
    this.midBins = Math.round(MID_BAND_HZ / binHz);
  }

  /** 送入一帧 dB 频谱。若上一帧是一个 onset 峰值则返回它（确认峰值需要看到下一帧） */
  push(spectrumDb: Float32Array, timeMs: number): Onset | null {
    const bins = Math.min(this.midBins, spectrumDb.length);
    if (!this.previous || this.previous.length !== spectrumDb.length) {
      this.previous = Float32Array.from(spectrumDb, v => Math.max(FLOOR_DB, v));
      return null;
    }

    let low = 0;
    let mid = 0;
    let lowDb = 0;
    for (let k = 1; k < bins; k++) {
      const value = Math.max(FLOOR_DB, spectrumDb[k]);
      if (k < this.lowBins) lowDb += value;
      const rise = value - this.previous[k];
      if (rise > 0) {
        if (k < this.lowBins) low += rise;
        else mid += rise;
      }
      this.previous[k] = value;
    }
    const flux = low / this.lowBins + MID_WEIGHT * mid / Math.max(1, bins - this.lowBins);
    lowDb /= this.lowBins - 1;

    // 峰值：上一帧比再上一帧高、且不低于这一帧
    let onset: Onset | null = null;
    const peaked = this.rising && flux <= this.lastFlux;
    if (peaked && this.history.length >= HISTORY_FRAMES / 2) {
      const sorted = [...this.history].sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1];
      const threshold = Math.max(MIN_FLUX, median * THRESHOLD_RATIO, this.recentPeak * PEAK_RATIO);
      if (this.lastFlux > threshold && this.lastFluxTime - this.lastOnsetMs >= MIN_INTERVAL_MS) {
        this.lastOnsetMs = this.lastFluxTime;
        const average = this.onsetLowDbAvg ?? this.lastLowDb;
        onset = { timeMs: this.lastFluxTime, strength: 10 ** ((this.lastLowDb - average) / 20) };
        this.onsetLowDbAvg = average + (this.lastLowDb - average) * 0.15;
      }
    }

    this.recentPeak = Math.max(flux, this.recentPeak * Math.exp(-(timeMs - this.lastFluxTime) / PEAK_DECAY_MS));
    this.rising = flux > this.lastFlux;
    this.lastFlux = flux;
    this.lastFluxTime = timeMs;
    this.lastLowDb = lowDb;
    this.history.push(flux);
    if (this.history.length > HISTORY_FRAMES) this.history.shift();
    return onset;
  }
}
