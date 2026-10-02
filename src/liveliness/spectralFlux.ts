/**
 * 起音强度：每帧频谱「突然变响了多少」（对数频谱通量）。
 *
 * 低频（底鼓、贝斯）权重大，中频（军鼓、和弦）权重小。用 dB 差值，
 * 所以和系统音量、歌曲响度无关。输出是一条连续曲线，交给节拍时钟做自相关 ——
 * 不在这里挑「哪一下是鼓点」：真实歌曲里人声音节、和弦变化也会冒尖，
 * 挑出来的离散点间隔很乱；而连续曲线里拍子是最强的周期，弱的规律成分也算得进去。
 */

const LOW_BAND_HZ = 250;
const MID_BAND_HZ = 4000;
const MID_WEIGHT = 0.4;
/** dB 下限：静音的 -Infinity 统一压到这里，避免算出无穷大的差值 */
const FLOOR_DB = -160;

export class SpectralFlux {
  private previous: Float32Array | null = null;
  private readonly lowBins: number;
  private readonly midBins: number;

  /** @param binHz 每个频率 bin 的宽度：sampleRate / fftSize */
  constructor(binHz: number) {
    this.lowBins = Math.max(2, Math.round(LOW_BAND_HZ / binHz));
    this.midBins = Math.round(MID_BAND_HZ / binHz);
  }

  /** 送入一帧 dB 频谱，返回这一帧的起音强度（每 bin 平均 dB 增量，≥ 0） */
  push(spectrumDb: Float32Array): number {
    const bins = Math.min(this.midBins, spectrumDb.length);
    if (!this.previous || this.previous.length !== spectrumDb.length) {
      this.previous = Float32Array.from(spectrumDb, v => Math.max(FLOOR_DB, v));
      return 0;
    }
    let low = 0;
    let mid = 0;
    for (let k = 1; k < bins; k++) {
      const value = Math.max(FLOOR_DB, spectrumDb[k]);
      const rise = value - this.previous[k];
      if (rise > 0) {
        if (k < this.lowBins) low += rise;
        else mid += rise;
      }
      this.previous[k] = value;
    }
    return low / this.lowBins + MID_WEIGHT * mid / Math.max(1, bins - this.lowBins);
  }
}
