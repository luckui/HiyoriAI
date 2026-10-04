/**
 * 流式 PCM 播放：音频块到一块排一块，首尾相接无缝播放。
 *
 * 每块的开始时间 = max(上一块结束, 现在 + 一点缓冲)。来得及时块与块严丝合缝；
 * 合成跟不上（块到晚了）就从「现在」接着播，只在这里出现停顿。
 * 每句话真正开口时回调 onSentenceStart —— 表情、字幕按实际出声时刻切换，而不是收到数据时。
 *
 * 引擎给的句子起点常落在静音上：豆包每段音频开头都带几百毫秒静音，段里第一句的起点就是这段的开头。
 * 所以起点会往后挪到之后第一处有声音的地方（最多挪 MAX_SNAP_SEC），字幕不会比声音早。
 */

/** 第一块前留的缓冲（秒）：给解码和调度一点余量，避免开头被吞 */
const LEAD_SEC = 0.08;
/** 句子起点最多往后挪多少秒去找开口 */
const MAX_SNAP_SEC = 1.2;
const LEVEL_FRAME_SEC = 0.01;
/** 比到目前为止最响的一帧低 20 dB 以上算没声音；绝对下限防止全程很轻时把底噪当开口 */
const VOICE_RATIO = 0.1;
const VOICE_FLOOR = 0.004;

/**
 * 音频里「从这儿往后第一次开口」在哪：按 10 ms 一帧记音量，供句子起点对齐。
 * 纯计算（便于测试），时间都是本段音频中的秒数。
 */
export class VoiceOnsets {
  private readonly levels: number[] = [];
  private peak = 0;
  private sec = 0;

  /** 接上一块音频 */
  push(samples: Float32Array, sampleRate: number): void {
    const frame = Math.max(1, Math.round(sampleRate * LEVEL_FRAME_SEC));
    // 每块按自己的 10 ms 帧切；块长不是整帧时，最后一小截并进上一帧
    for (let i = 0; i < samples.length; i += frame) {
      const end = Math.min(samples.length, i + frame);
      let sum = 0;
      for (let k = i; k < end; k++) sum += samples[k] * samples[k];
      const level = Math.sqrt(sum / Math.max(1, end - i));
      this.levels.push(level);
      if (level > this.peak) this.peak = level;
    }
    this.sec += samples.length / sampleRate;
  }

  /** 已收到的音频总长 */
  get duration(): number {
    return this.sec;
  }

  /**
   * atSec 之后第一处开口；后面的音频还不够判断时返回 null（等更多音频，或音频结束后用 ended=true 再问）
   */
  find(atSec: number, ended = false): number | null {
    const threshold = Math.max(VOICE_FLOOR, this.peak * VOICE_RATIO);
    const first = Math.max(0, Math.floor(atSec / LEVEL_FRAME_SEC));
    const last = Math.ceil((atSec + MAX_SNAP_SEC) / LEVEL_FRAME_SEC);
    for (let f = first; f < Math.min(last, this.levels.length); f++) {
      if (this.levels[f] >= threshold) return Math.max(atSec, f * LEVEL_FRAME_SEC);
    }
    // 挪满了还没声音（或音频已经结束）：就用原来的起点
    if (ended || this.levels.length >= last) return atSec;
    return null;
  }
}

/** 纯调度逻辑（便于测试）：给每块音频安排开始时间 */
export class ChunkScheduler {
  private nextTime = 0;

  constructor(private readonly lead = LEAD_SEC) {}

  /** now：AudioContext.currentTime；返回这一块的开始时间 */
  place(now: number, duration: number): number {
    const start = Math.max(this.nextTime, now + this.lead);
    this.nextTime = start + duration;
    return start;
  }

  /** 最后一块的结束时间 */
  get endTime(): number {
    return this.nextTime;
  }
}

/** 16-bit 小端 PCM → [-1, 1] 浮点 */
export function pcm16ToFloat(pcm: Uint8Array): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Float32Array(Math.floor(pcm.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

export class PcmStreamPlayer {
  private readonly scheduler = new ChunkScheduler();
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** 已排上的音频块：在本段音频中的位置（秒）→ 实际开始时间（AudioContext 时间） */
  private readonly timeline: Array<{ at: number; ctxStart: number; duration: number }> = [];
  /** 本段音频已收到的总时长 */
  private streamSec = 0;
  /** 每句的起点（本段音频中的秒数，已挪到开口处） */
  private readonly marks = new Map<number, number>();
  /** 起点所在的音频还没到、或还不够判断哪里开口的句子：句号 → 引擎给的起点 */
  private readonly waiting = new Map<number, number>();
  private readonly voice = new VoiceOnsets();
  private inputEnded = false;
  private stopped = false;
  private resolveDrained: (() => void) | null = null;
  private readonly drained: Promise<void>;

  constructor(
    private readonly ctx: AudioContext,
    private readonly output: AudioNode,
    private readonly onSentenceStart: (sentence: number) => void,
  ) {
    this.drained = new Promise((resolve) => { this.resolveDrained = resolve; });
  }

  enqueue(sampleRate: number, pcm: Uint8Array): void {
    if (this.stopped || pcm.byteLength < 2) return;
    const samples = pcm16ToFloat(pcm);
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    const ctxStart = this.scheduler.place(this.ctx.currentTime, buffer.duration);
    source.onended = () => {
      this.sources.delete(source);
      this.checkDrained();
    };
    this.sources.add(source);
    source.start(ctxStart);
    this.timeline.push({ at: this.streamSec, ctxStart, duration: buffer.duration });
    this.streamSec += buffer.duration;
    this.voice.push(samples, sampleRate);

    for (const [sentence, at] of this.waiting) this.tryPlace(sentence, at);
  }

  /**
   * 第 sentence 句从本段音频的第 atSec 秒开始。引擎估计的起点会挪到之后第一处开口；
   * exact（引擎的逐词时间戳）就是开口时刻，不挪 —— 轻辅音开头（f、s、h）音量低，找开口反而会挪晚
   */
  mark(sentence: number, atSec: number, exact = false): void {
    if (this.stopped) return;
    if (exact) {
      this.waiting.delete(sentence);
      this.exact.set(sentence, atSec);
    }
    this.tryPlace(sentence, atSec);
  }

  /** 逐词时间戳给出的准确起点 */
  private readonly exact = new Map<number, number>();

  /** 音频够判断开口在哪时定下起点并排上回调，否则先挂着 */
  private tryPlace(sentence: number, atSec: number, ended = false): void {
    const start = this.exact.has(sentence) ? atSec : this.voice.find(atSec, ended);
    if (start === null || (!ended && start >= this.streamSec)) {
      this.waiting.set(sentence, atSec);
      return;
    }
    this.waiting.delete(sentence);
    this.marks.set(sentence, start);
    this.onSentenceTimed?.();
    this.schedule(sentence, start);
  }

  /** 有句子的起点定下来了（之前不知道时长的句子可能因此知道了） */
  onSentenceTimed: (() => void) | null = null;

  /** 第 sentence 句的起点（本段音频中的秒数，已挪到开口处）；还没定下来为 null */
  sentenceStart(sentence: number): number | null {
    return this.marks.get(sentence) ?? null;
  }

  /** 本段音频中的第 sec 秒在 performance.now() 时间轴上是哪一刻；那段音频还没到为 null */
  streamToPerfMs(sec: number): number | null {
    const chunk = this.timeline.find((c) => sec < c.at + c.duration) ?? this.timeline[this.timeline.length - 1];
    if (!chunk) return null;
    const ctxTime = chunk.ctxStart + Math.max(0, sec - chunk.at);
    return performance.now() + (ctxTime - this.ctx.currentTime) * 1000;
  }

  /** 这一句的时长（毫秒）：下一句的起点已知时才知道 */
  sentenceDurationMs(sentence: number): number | null {
    const start = this.marks.get(sentence);
    const next = this.marks.get(sentence + 1);
    if (start === undefined) return null;
    if (next !== undefined) return Math.round((next - start) * 1000);
    return this.inputEnded ? Math.round((this.streamSec - start) * 1000) : null;
  }

  get anyAudio(): boolean {
    return this.timeline.length > 0;
  }

  /** 不会再有新的块：等已排上的都播完 */
  finish(): Promise<void> {
    this.inputEnded = true;
    for (const [sentence, at] of [...this.waiting]) {
      if (at < this.streamSec) {
        // 音频到头了还没找到开口：就近定下
        this.tryPlace(sentence, at, true);
      } else {
        // 起点落在音频之后的句子（合成失败的尾句）：在结尾处触发，表情和字幕不会卡住
        this.waiting.delete(sentence);
        this.fireAt(sentence, this.scheduler.endTime);
      }
    }
    this.onSentenceTimed?.();
    this.checkDrained();
    return this.drained;
  }

  /** 立刻停（被打断） */
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const source of this.sources) {
      try { source.stop(); } catch { /* 还没开始或已结束 */ }
    }
    this.sources.clear();
    this.resolveDrained?.();
  }

  private schedule(sentence: number, atSec: number): void {
    const chunk = this.timeline.find((c) => atSec < c.at + c.duration) ?? this.timeline[this.timeline.length - 1];
    if (!chunk) return;
    this.fireAt(sentence, chunk.ctxStart + Math.max(0, atSec - chunk.at));
  }

  private fireAt(sentence: number, ctxTime: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) this.onSentenceStart(sentence);
      this.checkDrained();
    }, Math.max(0, (ctxTime - this.ctx.currentTime) * 1000));
    this.timers.add(timer);
  }

  private checkDrained(): void {
    // 最后一句的出声回调可能还没触发（定时器未到）：等它也走完
    if ((this.inputEnded || this.stopped) && this.sources.size === 0 && this.timers.size === 0) this.resolveDrained?.();
  }
}
