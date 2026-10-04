/**
 * 流式 PCM 播放：音频块到一块排一块，首尾相接无缝播放。
 *
 * 每块的开始时间 = max(上一块结束, 现在 + 一点缓冲)。来得及时块与块严丝合缝；
 * 合成跟不上（块到晚了）就从「现在」接着播，只在这里出现停顿。
 * 每句话的第一块真正出声时回调 onSentenceStart —— 表情、字幕按实际出声时刻切换，而不是收到数据时。
 */

/** 第一块前留的缓冲（秒）：给解码和调度一点余量，避免开头被吞 */
const LEAD_SEC = 0.08;

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
  /** 每句的起点（本段音频中的秒数） */
  private readonly marks = new Map<number, number>();
  /** 起点所在的音频还没到的句子 */
  private readonly waiting = new Map<number, number>();
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

    for (const [sentence, at] of this.waiting) {
      if (at < this.streamSec) {
        this.waiting.delete(sentence);
        this.schedule(sentence, at);
      }
    }
  }

  /** 第 sentence 句从本段音频的第 atSec 秒开始 */
  mark(sentence: number, atSec: number): void {
    if (this.stopped) return;
    this.marks.set(sentence, atSec);
    if (atSec < this.streamSec) this.schedule(sentence, atSec);
    else this.waiting.set(sentence, atSec);
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
    // 起点落在音频之后的句子（合成失败的尾句）：在结尾处触发，表情和字幕不会卡住
    for (const sentence of this.waiting.keys()) this.fireAt(sentence, this.scheduler.endTime);
    this.waiting.clear();
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
