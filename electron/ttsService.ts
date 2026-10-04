/// <reference types="node" />
/**
 * TTS 服务（主进程）：持有当前方案的语音引擎，对外提供
 *   - openStream：流式朗读（渲染进程播放用，见 electron/speech/）
 *   - speak：一段文字合成为 WAV（旧接口与非实时场景用）
 * 由 ttsRuntime.activateTTSProvider 调用 configure 注入方案；方案带备用时自动降级。
 */

import type { TTSProviderConfig } from './tts.config';
import type { SpeechEngine, SpeechHealth, SpeechStream, SpeechStreamHandlers } from './speech/engine';
import { synthesizeAll } from './speech/engine';
import { createSpeechEngine } from './speech/createEngine';
import { FallbackSpeechEngine } from './speech/fallbackEngine';
import { HttpSpeechEngine } from './speech/httpEngine';
import { encodeWav } from './speech/wav';

class TTSService {
  private engine: SpeechEngine | null = null;
  private primary: SpeechEngine | null = null;
  private _currentUrl = '';
  private readonly streams = new Set<SpeechStream>();
  private readonly pendingControllers = new Set<AbortController>();

  /** 配置当前方案（null 则禁用）；fallback 为连不上时改用的方案 */
  configure(provider: TTSProviderConfig | null, fallback?: TTSProviderConfig | null): void {
    this.abortAll();
    this.engine?.dispose?.();
    this.engine = null;
    this.primary = null;
    this._currentUrl = '';
    if (!provider) {
      console.info('[TTS] 已禁用');
      return;
    }
    this.primary = createSpeechEngine(provider);
    this.engine = fallback ? new FallbackSpeechEngine(this.primary, createSpeechEngine(fallback)) : this.primary;
    this._currentUrl = provider.baseUrl.replace(/\/$/, '');
    console.info(`[TTS] 已配置: ${this.engine.name} speaker=${provider.speaker}`);
  }

  get isEnabled(): boolean {
    return this.engine !== null;
  }

  get currentUrl(): string {
    return this._currentUrl;
  }

  /** 取消所有进行中的朗读和合成（新一轮播放开始、或用户打断时） */
  abortAll(): void {
    for (const stream of this.streams) stream.cancel();
    this.streams.clear();
    for (const ctrl of this.pendingControllers) ctrl.abort();
    this.pendingControllers.clear();
  }

  openStream(handlers: SpeechStreamHandlers): SpeechStream {
    if (!this.engine) throw new Error('TTS 未启用');
    let stream: SpeechStream | null = null;
    const forget = () => { if (stream) this.streams.delete(stream); };
    stream = this.engine.open({
      onAudio: handlers.onAudio,
      onSentenceStart: handlers.onSentenceStart,
      onSentenceDone: handlers.onSentenceDone,
      onEnd: (error) => {
        forget();
        handlers.onEnd(error);
      },
    });
    this.streams.add(stream);
    const opened = stream;
    return {
      push: (sentence) => opened.push(sentence),
      end: () => opened.end(),
      cancel: () => {
        forget();
        opened.cancel();
      },
    };
  }

  /** 一段文字合成为 WAV */
  async speak(text: string): Promise<ArrayBuffer> {
    if (!this.engine || !this.primary) throw new Error('TTS 未启用');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), 180_000);
    this.pendingControllers.add(ctrl);
    try {
      // HTTP 服务本来就返回 WAV，不必绕一圈
      const wav = this.primary instanceof HttpSpeechEngine && this.engine === this.primary
        ? await this.primary.synthesizeWav(text, ctrl.signal)
        : await synthesizeAll(this.engine, [text], ctrl.signal).then(({ pcm, sampleRate }) => encodeWav(pcm, sampleRate));
      return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
    } finally {
      clearTimeout(timer);
      this.pendingControllers.delete(ctrl);
    }
  }

  async health(): Promise<SpeechHealth> {
    if (!this.engine) return { ok: false, error: 'TTS 未配置' };
    return this.engine.health();
  }
}

export const ttsService = new TTSService();
