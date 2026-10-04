/**
 * 流式朗读的统一接口：所有 TTS 引擎（本地 HTTP 服务、豆包云端…）都实现它。
 *
 *   const stream = engine.open(handlers);
 *   stream.push('第一句。'); stream.push('第二句。');   // 句子可以边生成边推（将来接 LLM 流式输出）
 *   stream.end();                                        // 不会再有新句子
 *   // handlers.onAudio 陆续收到 16-bit 单声道 PCM，onSentenceStart 报告每句从第几秒开始；全部给完后 onEnd()
 *
 * 句子编号 = push 的顺序。引擎内部怎么切分都不影响编号：豆包会把连着推进去的几句合成一句返回，
 * 本地引擎会把第一句切短先合成。所以引擎不给音频块标句号，而是报告「第 i 句从这段音频的第几秒开始」，
 * 播放端换算成实际出声时刻，到点换表情、显示字幕。
 */

export interface SpeechAudioChunk {
  sampleRate: number;
  /** 16-bit 小端单声道 PCM */
  pcm: Buffer;
}

/** 一个词（中文是一个字）在这段音频里的起止时刻（秒，从第一个采样算起），连同它后面的标点 */
export interface SpeechWord {
  text: string;
  atSec: number;
  endSec: number;
  /** 这个词属于我们的第几句（按文本位置定，不靠时间猜） */
  sentence?: number;
}

export interface SpeechStreamHandlers {
  onAudio(chunk: SpeechAudioChunk): void;
  /**
   * 第 sentence 句从本段音频的第 atSec 秒开始（从第一个采样算起）。
   * 可能在这段音频送达之前或之后报告；同一句只报告一次。
   * exact：来自引擎的逐词时间戳，是她开口的准确时刻（播放端不用再去找开口）
   */
  onSentenceStart?(sentence: number, atSec: number, exact?: boolean): void;
  /** 引擎给的逐词时间戳（豆包开了字幕时有）：字幕按她实际念到哪个词来显示 */
  onWords?(words: SpeechWord[]): void;
  /** 第 sentence 句的音频已全部给出（合成失败被跳过的句子也会回调） */
  onSentenceDone?(sentence: number): void;
  /** 结束：error 为空表示所有句子都处理完了。cancel() 之后不再回调 */
  onEnd(error?: Error): void;
}

/** PCM 时长（秒） */
export function pcmSeconds(chunk: SpeechAudioChunk): number {
  return chunk.pcm.length / 2 / chunk.sampleRate;
}

export interface SpeechStream {
  push(sentence: string): void;
  end(): void;
  cancel(): void;
}

export interface SpeechHealth {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
}

export interface SpeechEngine {
  readonly name: string;
  open(handlers: SpeechStreamHandlers): SpeechStream;
  health(): Promise<SpeechHealth>;
  /** 释放长连接等资源（换方案时调用） */
  dispose?(): void;
}

/** 把一整段文字合成为一段 PCM（桥接语音回复等非实时场景用） */
export function synthesizeAll(engine: SpeechEngine, sentences: string[], signal?: AbortSignal): Promise<{ sampleRate: number; pcm: Buffer }> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let sampleRate = 24000;
    const stream = engine.open({
      onAudio: (chunk) => {
        sampleRate = chunk.sampleRate;
        parts.push(chunk.pcm);
      },
      onEnd: (error) => {
        if (error && parts.length === 0) reject(error);
        else resolve({ sampleRate, pcm: Buffer.concat(parts) });
      },
    });
    signal?.addEventListener('abort', () => {
      stream.cancel();
      reject(new Error('aborted'));
    });
    for (const sentence of sentences) stream.push(sentence);
    stream.end();
  });
}
