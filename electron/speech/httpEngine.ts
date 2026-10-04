/**
 * 本地 / 自建 HTTP TTS（POST /tts/generate → WAV）的流式朗读：Genie、edge-tts、MOSS-TTS-Nano 都走这里。
 *
 * 这类服务一次合成一整句，做不到句内流式，所以靠两件事缩短等待：
 *   - 流水线：播第 i 句时已经在合成第 i+1 句；
 *   - 快速起播（quickStart，本地引擎默认开）：第一句较长时在第一个逗号处切成两段，前半段先合成先播。
 *     Genie 在 CPU 上合成 1 秒音频约需 0.65 秒，16 字的句子要等 2.5 秒才出声，切出 6~8 字的前半段约 1 秒。
 */

import type { SpeechEngine, SpeechHealth, SpeechStream, SpeechStreamHandlers } from './engine';
import { decodeWav, type DecodedWav } from './wav';

export interface HttpEngineOptions {
  baseUrl: string;
  apiKey: string;
  speaker: string;
  language: string;
  quickStart: boolean;
}

/** 同时在合成的句子数：当前句 + 下一句 */
const LOOKAHEAD = 2;
/** 单次合成最长等待（CPU 推理慢） */
const REQUEST_TIMEOUT_MS = 180_000;
/** 快速起播：第一句至少这么长才切；切出的两段都至少这么长（太短的句子 Genie 容易读错） */
const QUICK_START_MIN_CHARS = 14;
const QUICK_START_MIN_PIECE = 6;
const CLAUSE_BREAK = /[，,、；;：:]/g;

function speakableLength(text: string): number {
  return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

/** 第一句切成「前半段 + 其余」；不适合切就原样返回 */
export function splitFirstClause(sentence: string): string[] {
  if (speakableLength(sentence) < QUICK_START_MIN_CHARS) return [sentence];
  for (const match of sentence.matchAll(CLAUSE_BREAK)) {
    const head = sentence.slice(0, match.index + 1);
    const tail = sentence.slice(match.index + 1).trim();
    if (speakableLength(head) >= QUICK_START_MIN_PIECE && speakableLength(tail) >= QUICK_START_MIN_PIECE) return [head, tail];
  }
  return [sentence];
}

export class HttpSpeechEngine implements SpeechEngine {
  readonly name: string;
  private readonly baseUrl: string;

  constructor(private readonly options: HttpEngineOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.name = `http-tts(${this.baseUrl})`;
  }

  /** 合成一段文字，返回 WAV（桥接语音回复直接要文件） */
  async synthesizeWav(text: string, signal?: AbortSignal): Promise<Buffer> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;
    const resp = await fetch(`${this.baseUrl}/tts/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, speaker: this.options.speaker, language: this.options.language || 'auto' }),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`TTS ${resp.status} [${this.baseUrl}]: ${detail.slice(0, 200)}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  open(handlers: SpeechStreamHandlers): SpeechStream {
    return new HttpSpeechStream(this, handlers, this.options.quickStart);
  }

  async health(): Promise<SpeechHealth> {
    // 任意 HTTP 响应（含 404）都说明服务进程在线：推理服务忙时 /health 可能被阻塞，HEAD / 通常仍可达
    const probes: Array<{ method: string; path: string }> = [
      { method: 'HEAD', path: '/' },
      { method: 'HEAD', path: '/health' },
      { method: 'GET', path: '/health' },
    ];
    for (const { method, path } of probes) {
      try {
        const resp = await fetch(`${this.baseUrl}${path}`, { method, signal: AbortSignal.timeout(3000) });
        const body = method === 'GET' ? await resp.text().catch(() => '') : undefined;
        return { ok: true, status: resp.status, body: body?.slice(0, 200) };
      } catch { /* 下一个探针 */ }
    }
    return { ok: false, error: '服务不可达（所有探针超时）' };
  }
}

type Piece = Promise<DecodedWav | null>;

class HttpSpeechStream implements SpeechStream {
  private readonly sentences: string[] = [];
  private readonly jobs = new Map<number, Piece[]>();
  private readonly controllers = new Set<AbortController>();
  private next = 0;
  /** 已交出的音频时长（秒） */
  private emittedSec = 0;
  private ended = false;
  private canceled = false;
  private emitting = false;

  constructor(
    private readonly engine: HttpSpeechEngine,
    private readonly handlers: SpeechStreamHandlers,
    private readonly quickStart: boolean,
  ) {}

  push(sentence: string): void {
    if (this.ended || this.canceled) return;
    this.sentences.push(sentence);
    this.pump();
  }

  end(): void {
    if (this.ended || this.canceled) return;
    this.ended = true;
    this.pump();
  }

  cancel(): void {
    this.canceled = true;
    for (const ctrl of this.controllers) ctrl.abort();
    this.controllers.clear();
  }

  private synthesize(text: string): Piece {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    this.controllers.add(ctrl);
    return this.engine.synthesizeWav(text, ctrl.signal)
      .then((wav) => decodeWav(wav))
      .catch((error) => {
        // 合成失败（读不了的句子返回 422、服务端跳过）只丢这一段，不中断整段话
        if (!this.canceled) console.warn(`[TTS] 一段合成失败，跳过: ${(error as Error).message} text="${text.slice(0, 40)}"`);
        return null;
      })
      .finally(() => {
        clearTimeout(timer);
        this.controllers.delete(ctrl);
      });
  }

  private pump(): void {
    if (this.canceled) return;
    for (let i = this.next; i < Math.min(this.sentences.length, this.next + LOOKAHEAD); i++) {
      if (this.jobs.has(i)) continue;
      const pieces = i === 0 && this.quickStart ? splitFirstClause(this.sentences[i]) : [this.sentences[i]];
      this.jobs.set(i, pieces.map((text) => this.synthesize(text)));
    }
    if (!this.emitting) void this.emit();
  }

  /** 按句子顺序交出音频：同一时间只有一个 emit 在跑 */
  private async emit(): Promise<void> {
    this.emitting = true;
    try {
      while (!this.canceled && this.next < this.sentences.length) {
        const index = this.next;
        let marked = false;
        for (const piece of this.jobs.get(index)!) {
          const audio = await piece;
          if (this.canceled) return;
          if (!marked) {
            this.handlers.onSentenceStart?.(index, this.emittedSec);
            marked = true;
          }
          if (audio && audio.pcm.length) {
            this.handlers.onAudio({ sampleRate: audio.sampleRate, pcm: audio.pcm });
            this.emittedSec += audio.pcm.length / 2 / audio.sampleRate;
          }
        }
        this.jobs.delete(index);
        this.handlers.onSentenceDone?.(index);
        this.next++;
        this.pump();
      }
      if (!this.canceled && this.ended && this.next >= this.sentences.length) this.handlers.onEnd();
    } finally {
      this.emitting = false;
    }
  }
}
