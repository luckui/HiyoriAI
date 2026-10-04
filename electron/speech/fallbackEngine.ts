/**
 * 降级：主引擎（一般是云端）连不上或中途失败时，从第一句没读完的句子起改用备用引擎（一般是本地 TTS）。
 * 读到一半的那句会从头再读一遍 —— 重复半句比漏掉半句好。直播时语音不能断。
 */

import { pcmSeconds, type SpeechEngine, type SpeechHealth, type SpeechStream, type SpeechStreamHandlers } from './engine';

export class FallbackSpeechEngine implements SpeechEngine {
  readonly name: string;

  constructor(
    private readonly primary: SpeechEngine,
    private readonly fallback: SpeechEngine,
  ) {
    this.name = `${primary.name}（备用 ${fallback.name}）`;
  }

  open(handlers: SpeechStreamHandlers): SpeechStream {
    const sentences: string[] = [];
    const done = new Set<number>();
    let ended = false;
    let canceled = false;
    /** 已经交出的音频时长：备用引擎的时间轴接在它后面 */
    let emittedSec = 0;

    const switchToFallback = (error: Error): SpeechStream => {
      const from = sentences.findIndex((_, i) => !done.has(i));
      const offset = from < 0 ? sentences.length : from;
      const baseSec = emittedSec;
      console.warn(`[TTS] ${this.primary.name} 失败（${error.message}），从第 ${offset + 1} 句起改用 ${this.fallback.name}`);
      const stream = this.fallback.open({
        onAudio: (chunk) => handlers.onAudio(chunk),
        onSentenceStart: (i, atSec, exact) => handlers.onSentenceStart?.(i + offset, baseSec + atSec, exact),
        onWords: (words) => handlers.onWords?.(words.map((w) => ({
          ...w,
          atSec: baseSec + w.atSec,
          endSec: baseSec + w.endSec,
          ...(w.sentence === undefined ? {} : { sentence: w.sentence + offset }),
        }))),
        onSentenceDone: (i) => handlers.onSentenceDone?.(i + offset),
        onEnd: (e) => handlers.onEnd(e),
      });
      for (const sentence of sentences.slice(offset)) stream.push(sentence);
      if (ended) stream.end();
      return stream;
    };

    let current: SpeechStream = this.primary.open({
      onAudio: (chunk) => {
        emittedSec += pcmSeconds(chunk);
        handlers.onAudio(chunk);
      },
      onSentenceStart: (i, atSec, exact) => handlers.onSentenceStart?.(i, atSec, exact),
      onWords: (words) => handlers.onWords?.(words),
      onSentenceDone: (i) => {
        done.add(i);
        handlers.onSentenceDone?.(i);
      },
      onEnd: (error) => {
        if (!error) handlers.onEnd();
        else if (!canceled) current = switchToFallback(error);
      },
    });

    return {
      push(sentence) {
        sentences.push(sentence);
        current.push(sentence);
      },
      end() {
        ended = true;
        current.end();
      },
      cancel() {
        canceled = true;
        current.cancel();
      },
    };
  }

  health(): Promise<SpeechHealth> {
    return this.primary.health();
  }

  dispose(): void {
    this.primary.dispose?.();
    this.fallback.dispose?.();
  }
}
