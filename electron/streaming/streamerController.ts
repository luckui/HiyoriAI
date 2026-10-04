/**
 * 直播发言节奏：她空着的时候向注意力层要下一个话题 → LLM 写成一段话 → 朗读并等她说完 → 再要下一个。
 *
 * 一次只说一件事、说完才挑下一件：挑的时候能看到说话期间新来的弹幕，回应总是最新最要紧的。
 * 主播在聊天框里跟她说话、定时任务播报，也走同一个「她在说话」的计数，注意力层不会抢话。
 */

import { EventEmitter } from 'events';
import { streamerSession } from './streamerSession';
import { interruptPlayback, speakAndWait } from '../ttsRuntime';
import type { StreamerReply } from './types';
import type { Topic, TopicBody } from './attention/topics';

export interface StreamerControllerConfig {
  /** 没有话题时多久开始自己找话说（毫秒） */
  idleThresholdMs?: number;
  /** 是否朗读（关掉时只生成文字，按字数估计说话时长来控制节奏） */
  autoTTS?: boolean;
}

/** 她说完的一段话（直播指标记录用） */
export interface SpokenLine {
  kind: string;
  segment?: string;
  text: string;
  startedAt: number;
  endedAt: number;
}

/** 没开 TTS 时按这个语速估计「说完」的时间 */
const MS_PER_CHAR = 220;
const TICK_MS = 250;

function envInt(key: string, fallback: number): number {
  const n = parseInt(process.env[key] ?? '', 10);
  return Number.isNaN(n) ? fallback : n;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v !== 'false' && v !== '0';
}

class StreamerControllerManager extends EventEmitter {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  /** 正在想或正在说一个话题 */
  private busy = false;
  /** 正在播的朗读段数（话题、主播对话、定时播报都算） */
  private speaking = 0;
  /** 主人按着说话键：她不开新话题 */
  private floorHeld = false;
  /** 打断计数：话题想完回来发现变了，就不说了 */
  private epoch = 0;
  /** 她正在说的那句（被打断时告诉 LLM 她说到哪了） */
  private currentLine = '';
  private interruptedLine = '';
  private config: Required<StreamerControllerConfig> = {
    idleThresholdMs: envInt('STREAMER_IDLE_THRESHOLD_MS', 45_000),
    autoTTS: envBool('STREAMER_AUTO_TTS', true),
  };

  start(config?: StreamerControllerConfig): void {
    this.config = { ...this.config, ...config };
    streamerSession.idleAfterMs = this.config.idleThresholdMs;
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    console.log('[StreamerController] started', this.config);
    this.emit('state', true);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    console.log('[StreamerController] stopped');
    this.emit('state', false);
  }

  get isRunning(): boolean {
    return this.running;
  }

  getStatus() {
    return { running: this.running, busy: this.busy, speaking: this.speaking > 0, config: this.config };
  }

  /** 直播中运行时调整（不用重启） */
  updateConfig(patch: StreamerControllerConfig): void {
    this.config = { ...this.config, ...patch };
    streamerSession.idleAfterMs = this.config.idleThresholdMs;
  }

  /** 直播中别的来源（主播对话、定时任务）要她说的话；kind 只用于记录 */
  async speak(text: string, kind = 'aside'): Promise<void> {
    if (!this.running || !text.trim()) return;
    await this.say(text, { kind });
  }

  /**
   * 开场、谢幕这类由画面阶段触发的发言：等她手上这句说完再说，并且插在下一个弹幕话题之前。
   */
  async announce(body: Extract<TopicBody, { kind: 'opening' | 'ending' }>): Promise<void> {
    if (!this.running) return;
    while (this.busy || this.speaking > 0) await new Promise((r) => setTimeout(r, 200));
    const topic: Topic = { ...body, id: `announce-${Date.now()}`, priority: 200, heat: 'quiet', createdAt: Date.now() };
    await this.handle(topic);
  }

  /**
   * 主人开口（按下说话键）：立刻停下她正在说的、扔掉排队和正在想的，在主人说完之前不开新话题。
   */
  ownerStarted(): void {
    this.floorHeld = true;
    this.epoch += 1;
    if (this.speaking > 0 || this.busy) this.interruptedLine = this.currentLine;
    interruptPlayback();
  }

  /** 主人说完：text 是转写结果，空的就当没说（把话筒还给她） */
  async ownerFinished(text: string): Promise<void> {
    const said = text.trim();
    if (!said || !this.running) {
      this.floorHeld = false;
      this.interruptedLine = '';
      return;
    }
    // 被打断的那个话题收尾很快（朗读已经停了）
    while (this.busy) await new Promise((r) => setTimeout(r, 30));
    const topic: Topic = {
      kind: 'owner', text: said, interrupted: this.interruptedLine || undefined,
      id: `owner-${Date.now()}`, priority: 300, heat: 'quiet', createdAt: Date.now(),
    };
    this.interruptedLine = '';
    this.floorHeld = false;
    await this.handle(topic);
  }

  /** 手动触发一次：不管自动回复开没开，挑一个话题说出来 */
  async flushOnce(): Promise<StreamerReply | null> {
    const topic = streamerSession.nextTopic();
    return topic ? this.handle(topic) : null;
  }

  private async tick(): Promise<void> {
    if (!this.running || this.busy || this.speaking > 0 || this.floorHeld) return;
    if (!streamerSession.running || !streamerSession.autoReply) return;
    const topic = streamerSession.nextTopic();
    if (topic) await this.handle(topic);
  }

  private async handle(topic: Topic): Promise<StreamerReply> {
    this.busy = true;
    const epoch = this.epoch;
    this.emit('topic', topic);
    try {
      console.log(`[StreamerController] 话题 ${topic.kind}（${topic.heat}，优先级 ${topic.priority.toFixed(0)}）`);
      const reply = await streamerSession.compose(topic);
      let said = '';
      // 想的时候主人开口了：这句不说了
      if (epoch !== this.epoch) console.log(`[StreamerController] 话题 ${topic.kind} 被主人打断，不说了`);
      else if (reply.reply) {
        this.emit('reply', reply);
        said = await this.say(reply.reply, { kind: topic.kind, segment: topic.kind === 'segment' ? topic.segmentId : undefined });
      }
      // 环节要知道这拍说没说出来
      this.emit('topic-done', topic, said);
      return reply;
    } finally {
      this.busy = false;
    }
  }

  /** 朗读并等她说完；返回实际说出的文字。说完发 spoken 事件（直播指标记录用） */
  private async say(raw: string, meta: { kind: string; segment?: string }): Promise<string> {
    const text = raw.replace(/【.*?】/g, '').replace(/\[.*?\]/g, '').trim();
    if (!text) return '';
    if (this.speaking++ === 0) streamerSession.speechStarted();
    const startedAt = Date.now();
    this.currentLine = text;
    try {
      if (!this.config.autoTTS || !(await speakAndWait(text))) {
        await new Promise((r) => setTimeout(r, text.length * MS_PER_CHAR));
      }
    } catch (err) {
      console.error('[StreamerController] TTS error:', err);
    } finally {
      if (--this.speaking === 0) {
        streamerSession.speechEnded();
        this.currentLine = '';
      }
      this.emit('spoken', { ...meta, text, startedAt, endedAt: Date.now() } satisfies SpokenLine);
    }
    return text;
  }
}

export const streamerController = new StreamerControllerManager();
