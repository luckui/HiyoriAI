/**
 * 豆包语音（火山引擎）双向流式合成。
 *
 * 一条 WebSocket 长连接上依次跑多个会话（官方不支持同一连接并发会话）：
 *   连接：StartConnection → ConnectionStarted（只在第一次或断线后）
 *   每段话：StartSession → SessionStarted → TaskRequest×N（每句一个）→ FinishSession
 *           期间陆续收到 TTSSentenceStart / TTSResponse（PCM 音频）/ TTSSentenceEnd，最后 SessionFinished
 * 复用连接省掉每段话 300ms 左右的建连时间；空闲一段时间后主动断开。
 */

import { randomUUID } from 'crypto';
import { gunzipSync } from 'zlib';
import WebSocket from 'ws';
import type { SpeechEngine, SpeechHealth, SpeechStream, SpeechStreamHandlers } from './engine';
import { decodeFrame, DoubaoEvent, encodeRequest, SentenceAligner, type DoubaoFrame } from './doubaoProtocol';

export const DOUBAO_BIDIRECTIONAL_URL = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';

export interface DoubaoEngineOptions {
  url: string;
  /** 新版控制台：API Key；旧版控制台：Access Token（配合 appId） */
  apiKey: string;
  appId: string;
  resourceId: string;
  speaker: string;
  speechRate?: number;
  pitch?: number;
  /** 合并进 req_params 的额外参数 */
  extraParams?: Record<string, unknown>;
  /** 会话里这么久没有收到任何帧就判为失败（默认 10 秒；测试用） */
  stallTimeoutMs?: number;
}

const SAMPLE_RATE = 24000;
const CONNECT_TIMEOUT_MS = 10_000;
/** 会话里这么久没有收到任何帧就判为失败（交给降级方案） */
const STALL_TIMEOUT_MS = 10_000;
/** 连接空闲这么久后主动断开，下次用时再连 */
const IDLE_CLOSE_MS = 180_000;

/** 常见错误补一句怎么处理 */
const ERROR_HINTS: Array<[RegExp, string]> = [
  [/mismatched with speaker/i, '音色和资源 ID 不匹配：复刻音色（S_ 开头）用 seed-icl-2.0 或 seed-icl-1.0；还要确认音色属于这组凭证（新版控制台创建的音色要用新版控制台的 API Key，APP ID 留空）'],
  [/not granted/i, '这组凭证没有开通该资源：在控制台开通对应模型，或换成已开通的资源 ID'],
  [/Invalid X-Api-Key/i, 'API Key 无效：新版控制台「API Key 管理」里的语音 API Key，不是火山方舟大模型的 Key'],
];

function errorMessage(frame: DoubaoFrame): string {
  const json = frame.json as { error?: string; message?: string; status_code?: number } | string | undefined;
  const message = typeof json === 'string' ? json : json?.error ?? json?.message ?? JSON.stringify(json ?? {});
  return withHint(message);
}

function withHint(message: string): string {
  const hint = ERROR_HINTS.find(([pattern]) => pattern.test(message))?.[1];
  return hint ? `${message}（${hint}）` : message;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key] as Record<string, unknown>, value) : value;
  }
  return out;
}

export class DoubaoSpeechEngine implements SpeechEngine {
  readonly name: string;
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private active: DoubaoSession | null = null;
  private readonly queue: DoubaoSession[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly options: DoubaoEngineOptions) {
    this.name = `doubao(${options.resourceId}/${options.speaker})`;
  }

  /** StartSession / TaskRequest 共用的请求参数 */
  requestParams(): Record<string, unknown> {
    const { speaker, speechRate, pitch, extraParams } = this.options;
    const additions: Record<string, unknown> = {};
    if (pitch) additions.post_process = { pitch };
    let params: Record<string, unknown> = {
      speaker,
      audio_params: { format: 'pcm', sample_rate: SAMPLE_RATE, ...(speechRate ? { speech_rate: speechRate } : {}) },
    };
    if (extraParams) {
      const { additions: extraAdditions, ...rest } = extraParams;
      params = deepMerge(params, rest);
      if (isPlainObject(extraAdditions)) Object.assign(additions, extraAdditions);
    }
    if (Object.keys(additions).length) params.additions = JSON.stringify(additions);
    return params;
  }

  get stallTimeoutMs(): number {
    return this.options.stallTimeoutMs ?? STALL_TIMEOUT_MS;
  }

  open(handlers: SpeechStreamHandlers): SpeechStream {
    const session = new DoubaoSession(this, handlers);
    this.queue.push(session);
    void this.runNext();
    return session;
  }

  async health(): Promise<SpeechHealth> {
    try {
      await this.connect();
      this.scheduleIdleClose();
      return { ok: true, body: '已连接豆包语音' };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const session of [...this.queue, ...(this.active ? [this.active] : [])]) session.cancel();
    this.queue.length = 0;
    this.closeConnection();
  }

  /** 会话结束（完成、取消或失败）：放行下一个 */
  release(session: DoubaoSession): void {
    const queued = this.queue.indexOf(session);
    if (queued >= 0) this.queue.splice(queued, 1);
    if (this.active === session) this.active = null;
    void this.runNext();
  }

  send(frame: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  private async runNext(): Promise<void> {
    if (this.active || this.disposed) return;
    const session = this.queue.shift();
    if (!session) {
      this.scheduleIdleClose();
      return;
    }
    this.active = session;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      await this.connect();
      session.begin();
    } catch (error) {
      session.fail(error as Error);
    }
  }

  private connect(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    if (this.connecting) return this.connecting;
    const { url, apiKey, appId, resourceId } = this.options;
    const headers: Record<string, string> = { 'X-Api-Resource-Id': resourceId, 'X-Api-Connect-Id': randomUUID() };
    if (appId) Object.assign(headers, { 'X-Api-App-Id': appId, 'X-Api-App-Key': appId, 'X-Api-Access-Key': apiKey });
    else headers['X-Api-Key'] = apiKey;

    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url || DOUBAO_BIDIRECTIONAL_URL, { headers });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('连接豆包语音超时'));
      }, CONNECT_TIMEOUT_MS);
      const settle = (error?: Error) => {
        clearTimeout(timer);
        this.connecting = null;
        if (error) reject(error);
        else resolve(ws);
      };
      ws.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (d: Buffer) => { body += d.toString(); });
        res.on('end', () => settle(new Error(withHint(`豆包语音拒绝连接 HTTP ${res.statusCode}：${body.slice(0, 200)}`))));
      });
      ws.on('open', () => ws.send(encodeRequest(DoubaoEvent.StartConnection, null, {})));
      ws.on('message', (data: Buffer) => {
        let frame: DoubaoFrame;
        try {
          frame = decodeFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), gunzipSync);
        } catch (error) {
          console.warn('[TTS] 豆包语音：无法解析的帧', (error as Error).message);
          return;
        }
        if (frame.event === DoubaoEvent.ConnectionStarted) {
          this.ws = ws;
          settle();
        } else if (frame.event === DoubaoEvent.ConnectionFailed) {
          settle(new Error(`豆包语音建连失败：${errorMessage(frame)}`));
          ws.close();
        } else if (frame.errorCode !== undefined && this.ws !== ws) {
          settle(new Error(`豆包语音错误 ${frame.errorCode}：${errorMessage(frame)}`));
          ws.close();
        } else {
          this.active?.handle(frame);
        }
      });
      ws.on('close', () => {
        if (this.ws === ws) this.ws = null;
        settle(new Error('豆包语音连接已关闭'));
        this.active?.fail(new Error('豆包语音连接断开'));
      });
      ws.on('error', (error) => settle(new Error(`豆包语音连接出错：${error.message}`)));
    });
    return this.connecting;
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.active && this.queue.length === 0) this.closeConnection();
    }, IDLE_CLOSE_MS);
  }

  private closeConnection(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(encodeRequest(DoubaoEvent.FinishConnection, null, {}));
      setTimeout(() => ws.close(), 500);
    }
  }
}

class DoubaoSession implements SpeechStream {
  private readonly id = randomUUID().replace(/-/g, '');
  private readonly aligner = new SentenceAligner();
  private readonly pending: string[] = [];
  private begun = false;
  private started = false;
  private ended = false;
  private finishSent = false;
  private canceled = false;
  private done = false;
  private reportedDone = 0;
  /** 已交出的音频时长（秒） */
  private emittedSec = 0;
  /** 服务端当前这句从第几秒开始，以及起点在这句中间的我们的句子 */
  private serverSentenceAt = 0;
  private inServerSentence: Array<{ sentence: number; fraction: number }> = [];
  /** 这段的开始事件没带文本（复刻音色 ICL 2.0 就是这样），要等结束事件里的文本再对齐 */
  private alignAtEnd = false;
  private readonly marked = new Set<number>();
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly engine: DoubaoSpeechEngine,
    private readonly handlers: SpeechStreamHandlers,
  ) {}

  push(sentence: string): void {
    if (this.ended || this.canceled) return;
    this.aligner.add(sentence);
    if (this.started) this.sendText(sentence);
    else this.pending.push(sentence);
  }

  end(): void {
    if (this.ended || this.canceled) return;
    this.ended = true;
    if (this.started) this.sendFinish();
  }

  cancel(): void {
    if (this.canceled || this.done) return;
    this.canceled = true;
    if (this.started) this.engine.send(encodeRequest(DoubaoEvent.CancelSession, this.id, {}));
    // 还没开始的会话直接出队；已开始的等 SessionCanceled 再放行下一个，避免同一连接上两个会话重叠
    if (!this.started) this.close();
    else this.armStall();
  }

  begin(): void {
    if (this.canceled) {
      this.close();
      return;
    }
    this.begun = true;
    this.engine.send(encodeRequest(DoubaoEvent.StartSession, this.id, {
      user: { uid: 'hiyori' },
      event: DoubaoEvent.StartSession,
      namespace: 'BidirectionalTTS',
      req_params: this.engine.requestParams(),
    }));
    this.armStall();
  }

  handle(frame: DoubaoFrame): void {
    if (this.done || !this.begun || (frame.id && frame.id !== this.id && frame.errorCode === undefined)) return;
    this.armStall();
    if (frame.errorCode !== undefined) {
      this.fail(new Error(`豆包语音错误 ${frame.errorCode}：${errorMessage(frame)}`));
      return;
    }
    switch (frame.event) {
      case DoubaoEvent.SessionStarted:
        this.started = true;
        if (this.canceled) {
          this.engine.send(encodeRequest(DoubaoEvent.CancelSession, this.id, {}));
          return;
        }
        for (const sentence of this.pending.splice(0)) this.sendText(sentence);
        if (this.ended) this.sendFinish();
        break;
      case DoubaoEvent.TTSSentenceStart: {
        const text = (frame.json as { text?: string } | undefined)?.text ?? '';
        this.serverSentenceAt = this.emittedSec;
        this.inServerSentence = [];
        this.alignAtEnd = !text;
        if (this.alignAtEnd) {
          // 不知道这段多长，但它一定从下一句开头开始：先报告这一句，其余等结束事件
          if (this.aligner.next < this.aligner.size) this.markStart(this.aligner.next, this.emittedSec);
          break;
        }
        for (const { sentence, fraction } of this.aligner.start(text)) {
          // 起点就在这句开头的马上报告；在句中的要等这句结束知道时长后再换算
          if (fraction === 0) this.markStart(sentence, this.emittedSec);
          else this.inServerSentence.push({ sentence, fraction });
        }
        break;
      }
      case DoubaoEvent.TTSResponse:
        if (!this.canceled && frame.audio?.length) {
          this.handlers.onAudio({ sampleRate: SAMPLE_RATE, pcm: Buffer.from(frame.audio) });
          this.emittedSec += frame.audio.length / 2 / SAMPLE_RATE;
        }
        break;
      case DoubaoEvent.TTSSentenceEnd: {
        const duration = this.emittedSec - this.serverSentenceAt;
        if (this.alignAtEnd) {
          this.alignAtEnd = false;
          const text = (frame.json as { text?: string } | undefined)?.text ?? '';
          this.inServerSentence = this.aligner.start(text);
        }
        for (const { sentence, fraction } of this.inServerSentence.splice(0)) {
          this.markStart(sentence, this.serverSentenceAt + fraction * duration);
        }
        this.reportDone(this.aligner.completed);
        break;
      }
      case DoubaoEvent.SessionFinished:
        // 没对上的句子（服务端改写了文本）至少在结尾报告一次，播放端不会一直等
        for (let i = 0; i < this.aligner.size; i++) this.markStart(i, this.emittedSec);
        this.reportDone(Number.MAX_SAFE_INTEGER);
        if (!this.canceled) this.handlers.onEnd();
        this.close();
        break;
      case DoubaoEvent.SessionCanceled:
        this.close();
        break;
      case DoubaoEvent.SessionFailed:
        this.fail(new Error(`豆包语音会话失败：${errorMessage(frame)}`));
        break;
      default:
        break;
    }
  }

  fail(error: Error): void {
    if (this.done) return;
    if (this.started) this.engine.send(encodeRequest(DoubaoEvent.CancelSession, this.id, {}));
    if (!this.canceled) this.handlers.onEnd(error);
    this.close();
  }

  private sendText(text: string): void {
    this.engine.send(encodeRequest(DoubaoEvent.TaskRequest, this.id, {
      user: { uid: 'hiyori' },
      event: DoubaoEvent.TaskRequest,
      namespace: 'BidirectionalTTS',
      req_params: { ...this.engine.requestParams(), text },
    }));
  }

  private sendFinish(): void {
    if (this.finishSent) return;
    this.finishSent = true;
    this.engine.send(encodeRequest(DoubaoEvent.FinishSession, this.id, {}));
  }

  private markStart(sentence: number, atSec: number): void {
    if (this.marked.has(sentence) || this.canceled) return;
    this.marked.add(sentence);
    this.handlers.onSentenceStart?.(sentence, atSec);
  }

  /** 我们的前 count 句已经读完（不超过已推入的句数） */
  private reportDone(count: number): void {
    const upTo = Math.min(count, this.aligner.size);
    while (this.reportedDone < upTo) {
      if (!this.canceled) this.handlers.onSentenceDone?.(this.reportedDone);
      this.reportedDone++;
    }
  }

  private armStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      if (this.canceled) this.close();
      else this.fail(new Error(`豆包语音 ${this.engine.stallTimeoutMs / 1000} 秒没有响应`));
    }, this.engine.stallTimeoutMs);
  }

  private close(): void {
    if (this.done) return;
    this.done = true;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.engine.release(this);
  }
}
