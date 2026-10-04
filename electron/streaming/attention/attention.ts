/**
 * 直播注意力：看着直播间发生的一切，在她能开口时挑出「现在最值得说的一件事」。
 *
 * 她一次只能说一句（一句 4–8 秒），一分钟最多顾得上七八件事；2000 人在线的房间一分钟有六十多条弹幕、
 * 九十次进场。所以这里做的是取舍，按房间热度换策略：
 *   - 冷清（弹幕 < 8 条/分）：几乎每条都接，新来的人点名欢迎，小礼物也谢。
 *   - 一般：挑有内容的接，进场和小礼物攒一批再说。
 *   - 热闹（≥ 30 条/分）：只接问题、点她名的、舰长和老粉；刷屏合成一句「大家都在刷 xx」；进场只欢迎舰长。
 * 醒目留言和上舰无论多忙都要说到；弹幕会随时间「凉掉」，过一会儿再回就不自然了。
 *
 * 这里没有时钟、没有 IO：所有方法都接收 now，方便拿录下来的直播回放测试。
 */

import type {
  LiveChatEvent,
  LiveEvent,
  LiveGiftEvent,
  LiveMembershipEvent,
  LiveSuperChatEvent,
  LiveUser,
} from '../../../shared/types/live';
import { sanitizeChat } from '../danmuSafety';
import { chatFeatures, type ChatFeatures } from './features';
import type { ChatPick, RoomHeat, Topic, TopicBody } from './topics';

/** 可调参数集中在这里 */
export const TUNING = {
  heat: { quietBelowPerMin: 8, busyFromPerMin: 30 },
  /** 弹幕「凉掉」的时间常数（秒）：分数按 e^(-age/τ) 衰减，超过 3τ 丢弃 */
  chatTauSec: { quiet: 90, normal: 40, busy: 20 } as Record<RoomHeat, number>,
  /** 低于这个分数的弹幕不值得专门开口 */
  chatThreshold: { quiet: 0.1, normal: 0.35, busy: 0.6 } as Record<RoomHeat, number>,
  /** 一次最多接几位观众 */
  chatPicks: { quiet: 1, normal: 2, busy: 3 } as Record<RoomHeat, number>,
  /** 同一个人的连发合并的时间窗 */
  burstMs: 10_000,
  /** 刚回过的人，再回他要降分 */
  answeredCooldownMs: 120_000,
  trend: { windowMs: 20_000, minUsers: { quiet: 3, normal: 3, busy: 5 } as Record<RoomHeat, number>, cooldownMs: 120_000 },
  /** 达到这个金额的礼物单独点名感谢（元） */
  bigGiftYuan: 5,
  /** 礼物连击停下这么久才算送完，免得谢的时候数量还在涨 */
  comboSettleMs: 3_000,
  /** 两次感谢小礼物之间至少间隔 */
  giftsIntervalMs: { quiet: 0, normal: 20_000, busy: 45_000 } as Record<RoomHeat, number>,
  welcomeIntervalMs: { quiet: 0, normal: 60_000, busy: 90_000 } as Record<RoomHeat, number>,
  followIntervalMs: { quiet: 0, normal: 20_000, busy: 60_000 } as Record<RoomHeat, number>,
  /** 进场后等一小会儿，把前后脚进来的人一起欢迎 */
  welcomeGatherMs: 2_500,
  welcomeTtlMs: 90_000,
  /** 没话题时多久开始自己找话说 */
  idleAfterMs: 45_000,
  maxPendingChats: 200,
};

interface ChatCandidate {
  event: LiveChatEvent;
  /** 收到的时间（不用平台时间戳，免得两边时钟不一致） */
  at: number;
  text: string;
  uid: string;
  features: ChatFeatures;
  /** 不随时间变的部分 */
  base: number;
  tags: string[];
}

interface UserMemory {
  firstSeenAt: number;
  chats: number;
  answeredAt?: number;
}

const GUARD_TAG: Record<number, string> = { 1: '总督', 2: '提督', 3: '舰长' };

export interface AttentionSnapshot {
  heat: RoomHeat;
  chatsPerMin: number;
  pending: {
    chats: number;
    superchats: number;
    thanks: number;
    gifts: number;
    welcome: number;
    follow: number;
    trends: number;
  };
}

export class LiveAttention {
  private chats: ChatCandidate[] = [];
  private superchats: LiveSuperChatEvent[] = [];
  private bigThanks = new Map<string, LiveGiftEvent | LiveMembershipEvent>();
  private smallGifts = new Map<string, LiveGiftEvent>();
  private enters: Array<{ user: LiveUser; at: number }> = [];
  private follows: Array<{ user: LiveUser; at: number }> = [];
  private trendHits = new Map<string, Array<{ uid: string; text: string; at: number }>>();
  private trendCooldown = new Map<string, number>();

  private users = new Map<string, UserMemory>();
  private chatTimes: number[] = [];
  /** 没话题时多久开始自己找话说；可在直播中调整 */
  idleAfterMs = TUNING.idleAfterMs;

  private lastSpeechEndAt: number;
  private speaking = false;
  private lastSaid: Partial<Record<TopicBody['kind'], number>> = {};
  private seq = 0;

  constructor(now: number) {
    this.lastSpeechEndAt = now;
  }

  // ── 输入 ─────────────────────────────────────────────

  observe(event: LiveEvent, isUpdate: boolean, now: number): void {
    switch (event.kind) {
      case 'chat': if (!isUpdate) this.observeChat(event, now); break;
      case 'superchat': if (!isUpdate) this.superchats.push(event); break;
      case 'membership': this.bigThanks.set(event.id, event); break;
      case 'gift':
        if (event.valueYuan >= TUNING.bigGiftYuan) {
          this.smallGifts.delete(event.id); // 连击累计到了大额
          this.bigThanks.set(event.id, event);
        } else {
          this.smallGifts.set(event.id, event);
        }
        break;
      case 'enter': this.observeEnter(event.user, now); break;
      case 'follow': if (!isUpdate) this.follows.push({ user: event.user, at: now }); break;
      default: break;
    }
  }

  speechStarted(): void {
    this.speaking = true;
  }

  speechEnded(now: number): void {
    this.speaking = false;
    this.lastSpeechEndAt = now;
  }

  // ── 输出 ─────────────────────────────────────────────

  heat(now: number): RoomHeat {
    const perMin = this.chatsPerMin(now);
    if (perMin >= TUNING.heat.busyFromPerMin) return 'busy';
    if (perMin < TUNING.heat.quietBelowPerMin) return 'quiet';
    return 'normal';
  }

  /** 挑出现在最该说的话题，并把它用掉；没有值得说的返回 null */
  next(now: number): Topic | null {
    this.prune(now);
    const heat = this.heat(now);
    const candidates: Array<{ priority: number; build: () => TopicBody }> = [];

    const sc = this.superchats[0];
    if (sc) candidates.push({ priority: 100, build: () => ({ kind: 'superchat', event: this.superchats.shift()! }) });

    const thanks = [...this.bigThanks.values()].filter((e) => this.settled(e, now));
    if (thanks.length) {
      candidates.push({
        priority: 90,
        build: () => {
          const picked = thanks.sort((a, b) => b.valueYuan - a.valueYuan).slice(0, 3);
          for (const e of picked) this.bigThanks.delete(e.id);
          return { kind: 'thanks', events: picked };
        },
      });
    }

    const chat = this.chatCandidate(heat, now);
    if (chat) candidates.push(chat);

    const trend = this.trendCandidate(heat, now);
    if (trend) candidates.push(trend);

    const gifts = this.giftsCandidate(heat, now);
    if (gifts) candidates.push(gifts);

    const follow = this.followCandidate(heat, now);
    if (follow) candidates.push(follow);

    const welcome = this.welcomeCandidate(heat, now);
    if (welcome) candidates.push(welcome);

    if (!candidates.length) {
      const silentMs = now - this.lastSpeechEndAt;
      if (this.speaking || silentMs < this.idleAfterMs) return null;
      candidates.push({ priority: 1, build: () => ({ kind: 'idle', silentMs }) });
    }

    candidates.sort((a, b) => b.priority - a.priority);
    const best = candidates[0];
    const body = best.build();
    this.lastSaid[body.kind] = now;
    return { ...body, id: `topic-${++this.seq}`, priority: best.priority, heat, createdAt: now };
  }

  snapshot(now: number): AttentionSnapshot {
    this.prune(now);
    return {
      heat: this.heat(now),
      chatsPerMin: this.chatsPerMin(now),
      pending: {
        chats: this.chats.length,
        superchats: this.superchats.length,
        thanks: this.bigThanks.size,
        gifts: this.smallGifts.size,
        welcome: this.enters.length,
        follow: this.follows.length,
        trends: [...this.trendHits.values()].filter((hits) => hits.length > 1).length,
      },
    };
  }

  // ── 弹幕 ─────────────────────────────────────────────

  private observeChat(event: LiveChatEvent, now: number): void {
    this.chatTimes.push(now);
    const clean = sanitizeChat(event);
    const uid = clean.uid;
    const memory = this.remember(uid, now);
    memory.chats += 1;

    const features = chatFeatures(clean.text);
    // 刷屏统计算上表情和「哈哈哈」：它们单条没内容，但很多人一起刷就是氛围
    if (features.trendKey) {
      const hits = this.trendHits.get(features.trendKey) ?? [];
      hits.push({ uid, text: clean.text, at: now });
      this.trendHits.set(features.trendKey, hits);
    }
    // 先接了这个人的话，就不用再单独欢迎他
    this.enters = this.enters.filter((e) => (e.user.id || e.user.name) !== uid);

    if (event.emoteOnly || clean.riskFlags.length || !clean.text) return;

    // 内容分：有没有话可接
    const tags: string[] = [];
    let base = features.lowContent ? 0.15 : 0.5;
    if (features.question) { base += 0.5; tags.push('问题'); }
    if (features.mentionsHer) { base += 0.7; tags.push('点名'); }
    else if (features.addressesHer) { base += 0.15; }
    if (!features.lowContent) {
      if (features.length >= 8) base += 0.15;
      else if (features.length <= 3) base -= 0.15;
    }
    if (features.greeting) tags.push('打招呼');
    // 身份只放大内容分：舰长刷「哈哈哈」也还是没话可接（有的房间几乎人人是舰长）
    const guard = event.user.guardLevel ?? 0;
    if (GUARD_TAG[guard]) { base *= 1.25; tags.push(GUARD_TAG[guard]); }
    const medal = event.user.medal?.ofThisRoom ? event.user.medal.level : 0;
    if (medal >= 20) { base *= 1.1; tags.push(`粉丝牌${medal}级`); }
    if (event.user.isAdmin) { base *= 1.05; tags.push('房管'); }

    this.chats.push({ event, at: now, text: clean.text, uid, features, base, tags });
    if (this.chats.length > TUNING.maxPendingChats) this.chats.shift();
  }

  private chatScore(c: ChatCandidate, heat: RoomHeat, now: number): number {
    const ageSec = Math.max(0, now - c.at) / 1000;
    let score = c.base * Math.exp(-ageSec / TUNING.chatTauSec[heat]);
    const answeredAt = this.users.get(c.uid)?.answeredAt;
    if (answeredAt !== undefined && now - answeredAt < TUNING.answeredCooldownMs) score *= 0.4;
    return score;
  }

  private chatCandidate(heat: RoomHeat, now: number): { priority: number; build: () => TopicBody } | null {
    const threshold = TUNING.chatThreshold[heat];
    const scored = this.chats
      .map((c) => ({ c, score: this.chatScore(c, heat, now) }))
      .filter((s) => s.score >= threshold)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) return null;

    return {
      priority: Math.min(85, 50 * scored[0].score),
      build: () => {
        const picks: ChatPick[] = [];
        const taken = new Set<string>();
        for (const { c, score } of scored) {
          if (picks.length >= TUNING.chatPicks[heat]) break;
          if (taken.has(c.uid)) continue;
          taken.add(c.uid);
          // 同一个人前后脚连发的几条合成一句
          const burst = this.chats.filter((o) => o.uid === c.uid && Math.abs(o.at - c.at) <= TUNING.burstMs);
          const text = burst.sort((a, b) => a.at - b.at).map((o) => o.text).join(' ');
          picks.push({ event: c.event, text, tags: [...new Set(burst.flatMap((o) => o.tags))], score });
        }
        for (const uid of taken) this.remember(uid, now).answeredAt = now;
        this.chats = this.chats.filter((o) => !taken.has(o.uid));
        return { kind: 'chat', picks };
      },
    };
  }

  // ── 刷屏 ─────────────────────────────────────────────

  private trendCandidate(heat: RoomHeat, now: number): { priority: number; build: () => TopicBody } | null {
    let best: { key: string; users: number } | null = null;
    for (const [key, hits] of this.trendHits) {
      if ((this.trendCooldown.get(key) ?? 0) > now) continue;
      const users = new Set(hits.map((h) => h.uid)).size;
      if (users >= TUNING.trend.minUsers[heat] && (!best || users > best.users)) best = { key, users };
    }
    if (!best) return null;
    const { key, users } = best;
    return {
      priority: 45 + Math.min(20, users * 2),
      build: () => {
        const hits = this.trendHits.get(key) ?? [];
        this.trendHits.delete(key);
        this.trendCooldown.set(key, now + TUNING.trend.cooldownMs);
        const uids = new Set(hits.map((h) => h.uid));
        // 刷屏的那几条不再单独回
        this.chats = this.chats.filter((c) => !(uids.has(c.uid) && c.features.trendKey === key));
        return { kind: 'trend', key, samples: [...new Set(hits.map((h) => h.text))].slice(0, 3), users };
      },
    };
  }

  // ── 礼物 ─────────────────────────────────────────────

  private settled(e: LiveGiftEvent | LiveMembershipEvent, now: number): boolean {
    return e.kind === 'membership' || now - e.ts >= TUNING.comboSettleMs;
  }

  private giftsCandidate(heat: RoomHeat, now: number): { priority: number; build: () => TopicBody } | null {
    // 免费礼物只在冷清的时候谢
    const ready = [...this.smallGifts.values()].filter((g) => this.settled(g, now) && (g.valueYuan > 0 || heat === 'quiet'));
    if (!ready.length) return null;
    if (now - (this.lastSaid.gifts ?? -Infinity) < TUNING.giftsIntervalMs[heat]) return null;
    const oldest = Math.min(...ready.map((g) => g.ts));
    return {
      priority: Math.min(75, 35 + (now - oldest) / 2000),
      build: () => {
        // 同一个人的礼物合在一起，按金额排
        const byUser = new Map<string, LiveGiftEvent[]>();
        for (const g of ready) {
          this.smallGifts.delete(g.id);
          const key = g.user.id || g.user.name;
          byUser.set(key, [...(byUser.get(key) ?? []), g]);
        }
        const ranked = [...byUser.values()].sort((a, b) => sum(b) - sum(a));
        return { kind: 'gifts', events: ranked.slice(0, 3).flat(), more: Math.max(0, ranked.length - 3) };
      },
    };
  }

  // ── 进场与关注 ───────────────────────────────────────

  private observeEnter(user: LiveUser, now: number): void {
    const uid = user.id || user.name;
    if (!uid || user.masked) return;
    const known = this.users.has(uid);
    this.remember(uid, now);
    if (known) return; // 本场来过的不再欢迎
    this.enters.push({ user, at: now });
  }

  private welcomeCandidate(heat: RoomHeat, now: number): { priority: number; build: () => TopicBody } | null {
    // 热闹时只欢迎舰长和老粉
    const eligible = this.enters.filter((e) => heat !== 'busy' || (e.user.guardLevel ?? 0) > 0 || (e.user.medal?.ofThisRoom && e.user.medal.level >= 20));
    if (!eligible.length) return null;
    if (now - (this.lastSaid.welcome ?? -Infinity) < TUNING.welcomeIntervalMs[heat]) return null;
    if (now - Math.min(...eligible.map((e) => e.at)) < TUNING.welcomeGatherMs) return null;
    return {
      priority: heat === 'quiet' ? 40 : 20,
      build: () => {
        const ranked = eligible.sort((a, b) => notability(b.user) - notability(a.user));
        this.enters = [];
        return { kind: 'welcome', users: ranked.slice(0, 3).map((e) => e.user), more: Math.max(0, ranked.length - 3) };
      },
    };
  }

  private followCandidate(heat: RoomHeat, now: number): { priority: number; build: () => TopicBody } | null {
    if (!this.follows.length) return null;
    if (now - (this.lastSaid.follow ?? -Infinity) < TUNING.followIntervalMs[heat]) return null;
    const oldest = this.follows[0].at;
    return {
      priority: Math.min(60, 30 + (now - oldest) / 2000),
      build: () => {
        const users = uniqueUsers(this.follows.map((f) => f.user));
        this.follows = [];
        return { kind: 'follow', users: users.slice(0, 3), more: Math.max(0, users.length - 3) };
      },
    };
  }

  // ── 维护 ─────────────────────────────────────────────

  private remember(uid: string, now: number): UserMemory {
    let memory = this.users.get(uid);
    if (!memory) {
      memory = { firstSeenAt: now, chats: 0 };
      this.users.set(uid, memory);
    }
    return memory;
  }

  private chatsPerMin(now: number): number {
    while (this.chatTimes.length && now - this.chatTimes[0] > 60_000) this.chatTimes.shift();
    return this.chatTimes.length;
  }

  private prune(now: number): void {
    const heat = this.heat(now);
    const maxAge = TUNING.chatTauSec[heat] * 3000;
    this.chats = this.chats.filter((c) => now - c.at <= maxAge);
    this.enters = this.enters.filter((e) => now - e.at <= TUNING.welcomeTtlMs);
    this.follows = this.follows.filter((f) => now - f.at <= 5 * 60_000);
    for (const [key, hits] of this.trendHits) {
      const fresh = hits.filter((h) => now - h.at <= TUNING.trend.windowMs);
      if (fresh.length) this.trendHits.set(key, fresh);
      else this.trendHits.delete(key);
    }
    for (const [key, until] of this.trendCooldown) if (until <= now) this.trendCooldown.delete(key);
    // 小礼物等太久就不谢了（热闹时会被更要紧的事挤掉）
    for (const [id, g] of this.smallGifts) if (now - g.ts > 3 * 60_000) this.smallGifts.delete(id);
  }
}

function sum(gifts: LiveGiftEvent[]): number {
  return gifts.reduce((total, g) => total + g.valueYuan, 0);
}

function notability(user: LiveUser): number {
  const guard = user.guardLevel ? 100 - user.guardLevel : 0;
  return guard + (user.medal?.ofThisRoom ? user.medal.level : 0);
}

function uniqueUsers(users: LiveUser[]): LiveUser[] {
  const seen = new Set<string>();
  return users.filter((u) => {
    const key = u.id || u.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
