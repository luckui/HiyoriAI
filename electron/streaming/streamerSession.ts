import aiConfig from '../ai.config';
import { fetchCompletion } from '../llmClient';
import type { StreamerReply, StreamerSessionConfig, StreamerStatus } from './types';
import { LiveAttention, type BeatSource } from './attention/attention';
import type { Topic } from './attention/topics';
import type { LiveChatEvent, LiveEvent } from '../../shared/types/live';
import { liveHub } from './liveHub';
import { SESSION_SYSTEM_PROMPT, topicPrompt } from './streamerPrompts';
import type { LiveMemory } from './memory/liveMemory';
import { distillStream } from './memory/liveMemoryDistill';

/**
 * 直播幕后的一次 LLM 调用（不进对话、不朗读）：下播提炼记忆、巡逻打分。用当前对话模型，关掉深度思考。
 */
export async function backstageLlm(system: string, user: string): Promise<string> {
  const provider = aiConfig.providers[aiConfig.activeProvider];
  if (!provider) throw new Error(`missing provider: ${aiConfig.activeProvider}`);
  const data = await fetchCompletion(provider, [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
    // 研究报告的总结 JSON 比较长：给够，免得截断后解析失败
  ], undefined, undefined, { disableThinking: true, maxTokens: 2000 });
  return data.choices[0]?.message.content ?? '';
}

const VIDEO_LINK = /BV[0-9A-Za-z]{10}|b23\.tv\//;

/** 直播间现在的情况（回观众时参考） */
export interface StageContext {
  /** 公告板（画面上观众看得到的） */
  board?: string[];
  /** 她现在在干什么（环节给的一句话） */
  doing?: string | null;
  /** 开了送礼私信解析 */
  giftDm?: boolean;
}

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
  /** 环节导演：出环节拍，也先看一眼弹幕（作答、点播的不再当普通聊天） */
  private director: (BeatSource & { onChat(event: LiveChatEvent, now: number): boolean }) | null = null;
  /** 直播记忆（跨场次认识观众）；一次会话算一场 */
  private memory: LiveMemory | null = null;
  /** 下播提炼时附上的本场数据 */
  private showSummary: (() => string) | null = null;
  /** 弹幕里的 B 站视频（环节没接的）交给研究队列 */
  private videoRequest: ((event: LiveChatEvent) => void) | null = null;
  /** 每条新事件都先给它看一眼（送礼私信要认礼物和 BV 号），不拦截 */
  private eventTap: ((event: LiveEvent) => void) | null = null;
  /** 她现在在干什么、直播间公告：写进回观众的提示词里 */
  private stageContext: (() => StageContext) | null = null;

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
    this.attention.setBeatSource(this.director);
    this.replies = [];
    this.lastError = undefined;

    liveHub.connect({ platform: config.platform, roomId: config.roomId, cookie });
    this.memory?.begin(this.startedAt);
    this.unsubscribe = liveHub.subscribe((event, isUpdate) => {
      const now = Date.now();
      this.memory?.observe(event, isUpdate, now);
      if (!isUpdate) this.eventTap?.(event);
      // 被环节拿走的弹幕（点播、作答）也说明有人在看
      if (event.kind === 'chat' && !isUpdate && this.director?.onChat(event, now)) {
        this.attention.noteAudience(event, now);
        return;
      }
      if (event.kind === 'chat' && !isUpdate && VIDEO_LINK.test(event.text)) this.videoRequest?.(event);
      this.attention.observe(event, isUpdate, now);
    });
    return this.status();
  }

  stop(): StreamerStatus {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.memory?.end(Date.now()) != null) void this.distillMemory();
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
    if (!this.config) return null;
    const live = liveHub.status(now);
    this.attention.setOnline(live.stats.online);
    this.attention.setAnchorId(live.room?.anchorId);
    // 直播间明确没开播：主人在排练，没人也照常演
    this.attention.setRehearsal(live.stats.live === false);
    return this.attention.next(now);
  }

  setEventTap(tap: ((event: LiveEvent) => void) | null): void {
    this.eventTap = tap;
  }

  setStageContext(context: (() => StageContext) | null): void {
    this.stageContext = context;
  }

  /** 弹幕里发了 B 站视频、当前环节又没接时怎么办（交给研究队列） */
  setVideoRequestHandler(handler: ((event: LiveChatEvent) => void) | null): void {
    this.videoRequest = handler;
  }

  setMemory(memory: LiveMemory | null, showSummary?: () => string): void {
    this.memory = memory;
    this.showSummary = showSummary ?? null;
  }

  /** 下播后提炼直播记忆（包括之前提炼失败的场次）；不影响直播本身 */
  private async distillMemory(): Promise<void> {
    const memory = this.memory;
    if (!memory) return;
    const herLines = this.replies.filter((r) => r.reply).map((r) => r.reply!);
    const summary = this.showSummary?.();
    if (!aiConfig.providers[aiConfig.activeProvider]) return;
    const llm = backstageLlm;
    const pending = memory.store.pendingStreams();
    for (const id of pending) {
      try {
        // 她说过的话只有刚结束的这场还在手上
        const latest = id === pending[pending.length - 1];
        const result = await distillStream(memory.store, id, { herLines: latest ? herLines : [], showSummary: latest ? summary : undefined }, llm, Date.now());
        console.log(`[LiveMemory] 第 ${id} 场提炼完成：${result.viewers} 位观众，回顾 ${result.recap.length} 行，新梗 ${result.memes.length}，口味 ${result.tastes}`);
      } catch (err) {
        console.warn(`[LiveMemory] 第 ${id} 场提炼失败（下次下播再试）:`, (err as Error).message);
      }
    }
  }

  setDirector(director: (BeatSource & { onChat(event: LiveChatEvent, now: number): boolean }) | null): void {
    this.director = director;
    this.attention.setBeatSource(director);
  }

  /** 现在是不是排练模式（直播间没开播） */
  get rehearsal(): boolean {
    return this.attention.isRehearsal;
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
    const now = Date.now();
    const memory = this.memory;
    const room = memory?.roomContext(now);
    const stage = this.stageContext?.();
    const reply: StreamerReply = {
      id: topic.id,
      createdAt: now,
      kind: topic.kind,
      prompt: topicPrompt(topic, {
        streamTopic: this.config?.topic,
        recentLines,
        viewerCard: memory ? (user) => memory.viewerCard(user, now) : undefined,
        lastRecap: topic.kind === 'opening' ? memory?.lastRecap() : undefined,
        today: memory ? `${new Date(now).getMonth() + 1}月${new Date(now).getDate()}日` : undefined,
        tastes: room?.tastes,
        memes: room?.memes,
        board: stage?.board,
        doing: stage?.doing ?? undefined,
        giftDm: stage?.giftDm,
      }),
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
  ingestTest(uname: string, text: string, uid?: string): StreamerStatus {
    if (this.config) {
      liveHub.ingest({
        id: `test:${Date.now()}:${Math.random().toString(16).slice(2)}`,
        platform: this.config.platform,
        kind: 'chat',
        ts: Date.now(),
        user: { id: uid || `test-${uname}`, name: uname },
        text,
      });
    }
    return this.status();
  }

  /** 测试：某个测试观众进场、送礼（uid 填真实的才能测私信） */
  ingestTestEvent(kind: 'enter' | 'gift', uname: string, uid?: string, giftName = '小花花'): boolean {
    if (!this.config) return false;
    const base = { id: `test:${Date.now()}:${Math.random().toString(16).slice(2)}`, platform: this.config.platform, ts: Date.now(), user: { id: uid || `test-${uname}`, name: uname } };
    liveHub.ingest(kind === 'gift' ? { ...base, kind: 'gift', giftName, count: 1, valueYuan: 0.1 } : { ...base, kind: 'enter' });
    return true;
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
