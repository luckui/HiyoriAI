import aiConfig from '../ai.config';
import { fetchCompletion } from '../llmClient';
import type { StreamerReply, StreamerSessionConfig, StreamerStatus } from './types';
import { LiveAttention } from './attention/attention';
import type { Topic } from './attention/topics';
import { liveHub } from './liveHub';
import { SESSION_SYSTEM_PROMPT, topicPrompt } from './streamerPrompts';

/** 提示词里带上她最近说过的几句，免得翻来覆去一个开头 */
const RECENT_LINES = 4;

/**
 * AI 互动会话：把弹幕姬（liveHub）的事件交给注意力层，按需挑话题、请 LLM 写成要说的话。
 * 什么时候开口由 streamerController 决定；连接本身归 liveHub 管，停掉 AI 互动不会断开弹幕姬。
 */
class StreamerSessionManager {
  private config: StreamerSessionConfig | null = null;
  private startedAt = 0;
  private attention = new LiveAttention(Date.now());
  private replies: StreamerReply[] = [];
  private lastError: string | undefined;
  private unsubscribe: (() => void) | null = null;

  get running(): boolean {
    return !!this.config;
  }

  get autoReply(): boolean {
    return !!this.config?.autoReply;
  }

  start(config: StreamerSessionConfig, cookie: string): StreamerStatus {
    this.stop();
    const idleAfterMs = this.attention.idleAfterMs;
    this.config = { ...config, autoReply: config.autoReply ?? false };
    this.startedAt = Date.now();
    this.attention = new LiveAttention(this.startedAt);
    this.attention.idleAfterMs = idleAfterMs;
    this.replies = [];
    this.lastError = undefined;

    liveHub.connect({ platform: config.platform, roomId: config.roomId, cookie });
    this.unsubscribe = liveHub.subscribe((event, isUpdate) => this.attention.observe(event, isUpdate, Date.now()));
    return this.status();
  }

  stop(): StreamerStatus {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.config = null;
    this.startedAt = 0;
    return this.status();
  }

  status(): StreamerStatus {
    return {
      running: !!this.config,
      platform: this.config?.platform,
      roomId: this.config?.roomId,
      topic: this.config?.topic,
      startedAt: this.startedAt || undefined,
      autoReply: this.config?.autoReply,
      live: liveHub.status(),
      attention: this.config ? this.attention.snapshot(Date.now()) : undefined,
      replies: this.replies.length,
      lastError: this.lastError,
    };
  }

  /** 现在最该说的话题；没开会话或没什么可说时为 null */
  nextTopic(now = Date.now()): Topic | null {
    return this.config ? this.attention.next(now) : null;
  }

  speechStarted(): void {
    this.attention.speechStarted();
  }

  speechEnded(now = Date.now()): void {
    this.attention.speechEnded(now);
  }

  set idleAfterMs(ms: number) {
    this.attention.idleAfterMs = ms;
  }

  /** 请 LLM 把话题写成一段要说的话；失败时 reply 为空 */
  async compose(topic: Topic): Promise<StreamerReply> {
    const recentLines = this.replies.filter((r) => r.reply).slice(-RECENT_LINES).map((r) => r.reply!);
    const reply: StreamerReply = {
      id: topic.id,
      createdAt: Date.now(),
      kind: topic.kind,
      prompt: topicPrompt(topic, { streamTopic: this.config?.topic, recentLines }),
    };
    try {
      const provider = aiConfig.providers[aiConfig.activeProvider];
      if (!provider) throw new Error(`missing provider: ${aiConfig.activeProvider}`);
      const messages = [
        { role: 'system' as const, content: SESSION_SYSTEM_PROMPT },
        { role: 'user' as const, content: reply.prompt },
      ];
      // 直播要快：不开深度思考；偶尔回空就再要一次
      for (let attempt = 0; attempt < 2 && !reply.reply; attempt++) {
        const data = await fetchCompletion(provider, messages, undefined, undefined, { disableThinking: true });
        reply.reply = data.choices[0]?.message.content?.trim() ?? '';
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error('[StreamerSession] AI generation failed:', this.lastError);
    }
    this.replies.push(reply);
    if (this.replies.length > 200) this.replies.splice(0, 50);
    return reply;
  }

  /** 调试用：注入一条测试弹幕（走和真实弹幕一样的路径） */
  ingestTest(uname: string, text: string): StreamerStatus {
    if (this.config) {
      liveHub.ingest({
        id: `test:${Date.now()}:${Math.random().toString(16).slice(2)}`,
        platform: this.config.platform,
        kind: 'chat',
        ts: Date.now(),
        user: { id: `test-${uname}`, name: uname },
        text,
      });
    }
    return this.status();
  }

  setAutoReply(enabled: boolean): boolean {
    if (!this.config) return false;
    this.config.autoReply = enabled;
    return true;
  }

  setTopic(topic: string): boolean {
    if (!this.config) return false;
    this.config.topic = topic;
    return true;
  }

  listReplies(limit = 10): StreamerReply[] {
    return this.replies.slice(-limit);
  }
}

export const streamerSession = new StreamerSessionManager();
