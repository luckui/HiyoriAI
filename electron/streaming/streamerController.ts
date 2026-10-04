/**
 * 直播发言节奏：她空着的时候向注意力层要下一个话题 → LLM 写成一段话 → 朗读并等她说完 → 再要下一个。
 *
 * 一次只说一件事、说完才挑下一件：挑的时候能看到说话期间新来的弹幕，回应总是最新最要紧的。
 * 主播在聊天框里跟她说话、定时任务播报，也走同一个「她在说话」的计数，注意力层不会抢话。
 */

import { EventEmitter } from 'events';
import { streamerSession } from './streamerSession';
import { speakAndWait } from '../ttsRuntime';
import type { StreamerReply } from './types';
import type { Topic, TopicBody } from './attention/topics';

export interface StreamerControllerConfig {
  /** 没有话题时多久开始自己找话说（毫秒） */
  idleThresholdMs?: number;
  /** 是否朗读（关掉时只生成文字，按字数估计说话时长来控制节奏） */
  autoTTS?: boolean;
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

  /** 直播中别的来源（主播对话、定时任务）要她说的话 */
  async speak(text: string): Promise<void> {
    if (!this.running || !text.trim()) return;
    await this.say(text);
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

  /** 手动触发一次：不管自动回复开没开，挑一个话题说出来 */
  async flushOnce(): Promise<StreamerReply | null> {
    const topic = streamerSession.nextTopic();
    return topic ? this.handle(topic) : null;
  }

  private async tick(): Promise<void> {
    if (!this.running || this.busy || this.speaking > 0) return;
    if (!streamerSession.running || !streamerSession.autoReply) return;
    const topic = streamerSession.nextTopic();
    if (topic) await this.handle(topic);
  }

  private async handle(topic: Topic): Promise<StreamerReply> {
    this.busy = true;
    this.emit('topic', topic);
    try {
      console.log(`[StreamerController] 话题 ${topic.kind}（${topic.heat}，优先级 ${topic.priority.toFixed(0)}）`);
      const reply = await streamerSession.compose(topic);
      if (reply.reply) {
        this.emit('reply', reply);
        await this.say(reply.reply);
      }
      return reply;
    } finally {
      this.busy = false;
    }
  }

  private async say(raw: string): Promise<void> {
    const text = raw.replace(/【.*?】/g, '').replace(/\[.*?\]/g, '').trim();
    if (!text) return;
    if (this.speaking++ === 0) streamerSession.speechStarted();
    try {
      if (!this.config.autoTTS || !(await speakAndWait(text))) {
        await new Promise((r) => setTimeout(r, text.length * MS_PER_CHAR));
      }
    } catch (err) {
      console.error('[StreamerController] TTS error:', err);
    } finally {
      if (--this.speaking === 0) streamerSession.speechEnded();
    }
  }
}

export const streamerController = new StreamerControllerManager();
