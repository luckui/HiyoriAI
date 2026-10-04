/**
 * 直播间事件中枢（弹幕姬的核心）：持有当前平台连接，把事件整理后分发给
 *   - 弹幕姬窗口（批量推送，见 onUpdate）
 *   - 主进程内的消费者（AI 互动等，见 subscribe）
 *
 * 整理规则：
 * - 同 id 只处理一次（重连后平台可能重发）；礼物连击共用 id，后到的累加到第一条上并以同 id 再推一次。
 * - 进场 / 点赞量大（2000 在线的房间约每分钟 90 次进场），推给窗口时每批只留最后几条，总量看 perMinute。
 */

import type {
  LiveConnection,
  LiveConnectionState,
  LiveEvent,
  LiveEventKind,
  LiveGiftEvent,
  LiveRoomInfo,
  LiveRoomStats,
  LiveStatus,
  LiveUpdate,
} from '../../shared/types/live';
import { createLiveSource, type LiveSource } from './platforms';

const RECENT_LIMIT = 300;
const SEEN_LIMIT = 4000;
const RATE_WINDOW_MS = 60_000;
/** 连击超过这么久没有新的一下，就算一次新的送礼 */
const GIFT_COMBO_MS = 30_000;
const FLUSH_MS = 150;
const AMBIENT_PER_FLUSH = 5;

const AMBIENT_KINDS: ReadonlySet<LiveEventKind> = new Set(['enter', 'like']);

export type LiveEventListener = (event: LiveEvent, isUpdate: boolean) => void;

export class LiveHub {
  private source: LiveSource | null = null;
  private config: LiveConnection | null = null;
  private state: LiveConnectionState = 'idle';
  private room: LiveRoomInfo | undefined;
  private stats: LiveRoomStats = {};
  private loggedIn = false;
  private connectedAt: number | undefined;
  private lastError: string | undefined;

  private recent: LiveEvent[] = [];
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private gifts = new Map<string, LiveGiftEvent>();
  private timestamps = new Map<LiveEventKind, number[]>();

  private listeners = new Set<LiveEventListener>();
  private updateSink: ((update: LiveUpdate) => void) | null = null;
  private pending: LiveEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly makeSource: (config: LiveConnection) => LiveSource = createLiveSource) {}

  get isConnected(): boolean {
    return this.state === 'connected';
  }

  get currentConfig(): LiveConnection | null {
    return this.config;
  }

  /** 连接直播间；已连着同一个房间且参数没变时不重连 */
  connect(config: LiveConnection): LiveStatus {
    const same = this.source && this.config
      && this.config.platform === config.platform
      && this.config.roomId === config.roomId
      && this.config.cookie === config.cookie;
    if (same) return this.status();

    this.disconnect();
    this.config = { platform: config.platform, roomId: config.roomId, cookie: config.cookie };
    this.room = { platform: config.platform, roomId: config.roomId };
    this.stats = {};
    this.recent = [];
    this.seen.clear();
    this.seenOrder = [];
    this.gifts.clear();
    this.timestamps.clear();
    this.lastError = undefined;

    const source = this.makeSource(config);
    this.source = source;
    source.start({
      event: (event) => this.source === source && this.ingest(event),
      stats: (stats) => {
        if (this.source !== source) return;
        this.stats = { ...this.stats, ...stats };
        this.scheduleFlush();
      },
      room: (info) => {
        if (this.source !== source) return;
        this.room = { ...this.room, ...info, title: info.title ?? this.room?.title, anchorName: info.anchorName ?? this.room?.anchorName };
        this.scheduleFlush();
      },
      state: (state, detail) => {
        if (this.source !== source) return;
        this.state = state;
        if (detail?.loggedIn !== undefined) this.loggedIn = detail.loggedIn;
        if (state === 'connected') {
          this.connectedAt ??= Date.now();
          this.lastError = detail?.error;
        } else if (detail?.error) {
          this.lastError = detail.error;
        }
        this.scheduleFlush();
      },
    });
    return this.status();
  }

  disconnect(): LiveStatus {
    const source = this.source;
    this.source = null;
    source?.stop();
    this.config = null;
    this.state = 'idle';
    this.connectedAt = undefined;
    this.loggedIn = false;
    this.scheduleFlush();
    return this.status();
  }

  status(now = Date.now()): LiveStatus {
    const perMinute: LiveStatus['perMinute'] = {};
    for (const [kind, list] of this.timestamps) {
      const count = list.filter((ts) => now - ts <= RATE_WINDOW_MS).length;
      if (count) perMinute[kind] = count;
    }
    return {
      state: this.state,
      room: this.room,
      loggedIn: this.loggedIn,
      stats: { ...this.stats },
      perMinute,
      connectedAt: this.connectedAt,
      lastError: this.lastError,
    };
  }

  /** 最近的事件（旧 → 新） */
  recentEvents(limit = RECENT_LIMIT): LiveEvent[] {
    return this.recent.slice(-limit);
  }

  subscribe(listener: LiveEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 弹幕姬窗口的推送出口（由 IPC 层设置） */
  onUpdate(sink: ((update: LiveUpdate) => void) | null): void {
    this.updateSink = sink;
  }

  /** 平台事件入口；测试和调试注入也走这里 */
  ingest(event: LiveEvent, now = Date.now()): void {
    let isUpdate = false;
    let out: LiveEvent = event;

    if (event.kind === 'gift') {
      const prev = this.gifts.get(event.id);
      if (prev && now - prev.ts <= GIFT_COMBO_MS) {
        prev.count += event.count;
        prev.valueYuan = Math.round((prev.valueYuan + event.valueYuan) * 1000) / 1000;
        prev.ts = event.ts;
        out = prev;
        isUpdate = true;
      } else {
        out = { ...event, id: prev ? `${event.id}:${now}` : event.id };
        this.gifts.set(event.id, out as LiveGiftEvent);
      }
      this.pruneGifts(now);
    } else {
      if (this.seen.has(event.id)) return;
      this.remember(event.id);
    }

    this.count(event.kind, now);
    if (!isUpdate) {
      this.recent.push(out);
      if (this.recent.length > RECENT_LIMIT * 1.2) this.recent = this.recent.slice(-RECENT_LIMIT);
    }
    this.pending.push(out);
    this.scheduleFlush();
    for (const listener of this.listeners) {
      try {
        listener(out, isUpdate);
      } catch (err) {
        console.error('[LiveHub] 事件消费者出错：', err);
      }
    }
  }

  private remember(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > SEEN_LIMIT) {
      for (const old of this.seenOrder.splice(0, SEEN_LIMIT / 4)) this.seen.delete(old);
    }
  }

  private count(kind: LiveEventKind, now: number): void {
    const list = this.timestamps.get(kind) ?? [];
    list.push(now);
    while (list.length && now - list[0] > RATE_WINDOW_MS) list.shift();
    this.timestamps.set(kind, list);
  }

  private pruneGifts(now: number): void {
    for (const [id, gift] of this.gifts) {
      if (now - gift.ts > GIFT_COMBO_MS) this.gifts.delete(id);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || !this.updateSink) return;
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    this.flushTimer = null;
    const batch = this.pending;
    this.pending = [];
    // 进场 / 点赞每批只推最后几条，其余的只体现在计数里
    let ambientLeft = AMBIENT_PER_FLUSH;
    const events: LiveEvent[] = [];
    const seenIds = new Set<string>();
    for (let i = batch.length - 1; i >= 0; i--) {
      const e = batch[i];
      if (seenIds.has(e.id)) continue; // 同一批里礼物连击只推最新的累计值
      seenIds.add(e.id);
      if (AMBIENT_KINDS.has(e.kind) && ambientLeft-- <= 0) continue;
      events.push({ ...e, user: { ...e.user } });
    }
    events.reverse();
    this.updateSink?.({ events, status: this.status() });
  }
}

export const liveHub = new LiveHub();
