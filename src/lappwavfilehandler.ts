/**
 * Live2D Desktop Pet - 音频处理器
 *
 * 支持两种音频来源：
 *   1. start(path)         兼容旧接口（模型内置 WAV），当前 no-op
 *   2. startFromBuffer()   TTS 返回的 WAV ArrayBuffer，
 *                          通过 Web Audio API 播放并驱动口型同步
 */

export class LAppWavFileHandler {
  private _ctx:          AudioContext           | null = null;
  private _analyser:     AnalyserNode           | null = null;
  private _source:       AudioBufferSourceNode  | null = null;
  private _timeDomain:   Float32Array<ArrayBuffer> | null = null;
  private _lastRms     = 0;
  private _isPlaying   = false;
  private _endedResolve: (() => void) | null = null;

  constructor() {}

  // ── Live2D 主循环每帧调用 ──────────────────────────────────────

  public update(_deltaTimeSeconds: number): boolean {
    if (!this._analyser || !this._isPlaying) {
      this._lastRms = 0;
      return this._isPlaying;
    }
    const buf = this._timeDomain!;
    this._analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    // 放大系数让口型更明显，上限 1.0
    this._lastRms = Math.min(Math.sqrt(sum / buf.length) * 5, 1.0);
    return true;
  }

  /** 兼容旧接口：模型内置 WAV 文件路径（no-op，不影响现有流程） */
  public start(_filePath: string): void { /* no-op */ }

  /** 播放 TTS 返回的 WAV ArrayBuffer，同时驱动口型同步 */
  public async startFromBuffer(buffer: ArrayBuffer): Promise<void> {
    this.stop();

    if (!this._ctx) {
      this._ctx = new AudioContext();
    }
    if (this._ctx.state === 'suspended') {
      await this._ctx.resume();
    }

    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await this._ctx.decodeAudioData(buffer.slice(0));
    } catch (e) {
      console.error('[LAppWavFileHandler] decodeAudioData 失败:', e);
      return;
    }

    this._analyser   = this._ctx.createAnalyser();
    this._analyser.fftSize = 256;
    this._timeDomain = new Float32Array(this._analyser.fftSize);

    this._source        = this._ctx.createBufferSource();
    this._source.buffer = audioBuffer;
    this._source.connect(this._analyser);
    this._analyser.connect(this._ctx.destination);
    this._source.onended = () => {
      this._isPlaying = false;
      this._lastRms   = 0;
      this._endedResolve?.();
      this._endedResolve = null;
    };
    this._source.start();
    this._isPlaying = true;
  }

  /** 停止当前播放 */
  public stop(): void {
    try { this._source?.stop(); } catch { /* 已停止 */ }
    this._source?.disconnect();
    this._analyser?.disconnect();
    this._source    = null;
    this._analyser  = null;
    this._isPlaying = false;
    this._lastRms   = 0;
    this._endedResolve?.();
    this._endedResolve = null;
  }

  /**
   * 等待当前句子播放完毕后 resolve。
   * 若当前没有正在播放的音频，立即 resolve。
   */
  public waitUntilEnd(): Promise<void> {
    if (!this._isPlaying || !this._source) return Promise.resolve();
    return new Promise<void>(resolve => {
      this._endedResolve = resolve;
    });
  }

  public getRms(): number { return this._lastRms; }

  public get isPlaying(): boolean { return this._isPlaying; }
}
