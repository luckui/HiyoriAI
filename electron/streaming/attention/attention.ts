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
 * 直播间没人在看时什么都不做（省 LLM 和 TTS）：不出环节拍、不冷场找话，等有人来了再说。
 * 直播间没开播时是排练（主人在测试）：不管有没有人都照常演。
 *
 * 有环节在跑时（见 segments/），没人说话也不用硬聊：环节的「一拍」和普通弹幕交替着说，
 * 房间越安静环节拍越多；醒目留言、上舰、点名提问仍然排在环节前面。
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
  audience: {
    /** 最近这么久有观众动静（进场、弹幕、礼物、点赞……）就算有人在看 */
    activityMs: 5 * 60_000,
    /** 在线人数到这个数也算有人：B 站的在线人数把我们自己的弹幕连接也算进去了，1 就是没人 */
    minOnline: 2,
  },
  beat: {
    /** 上一句说完后至少歇这么久再出环节拍，给观众插话的空 */
    gapMs: { quiet: 1500, normal: 2500, busy: 4000 } as Record<RoomHeat, number>,
    /** 刚说完一拍：让位给任何过了门槛的弹幕和进场欢迎（弹幕的优先级 = 50 × 分数，门槛见 chatThreshold） */
    afterBeat: { quiet: 1, normal: 1, busy: 1 } as Record<RoomHeat, number>,
    /** 刚回完弹幕或别的事：回到环节，压过普通弹幕，但让着点名提问（≥ 60） */
    afterOther: { quiet: 55, normal: 50, busy: 35 } as Record<RoomHeat, number>,
    transition: 70,
  },
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

/** 环节导演对注意力层的接口：现在有没有一拍（或一次换环节口播）可以说 */
export interface BeatSource {
  /** 直播间有没有人在看（没人时导演暂停计时） */
  setAudience?(present: boolean, now: number): void;
  /** 只看不拿 */
  peek(now: number, heat: RoomHeat): 'segment' | 'transition' | null;
  /** 真的要说了：拿走这一拍 */
  take(now: number, heat: RoomHeat): TopicBody | null;
}

export interface AttentionSnapshot {
  heat: RoomHeat;
  /** 有没有人在看 */
  audience: boolean;
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
  /** 这场已经打过招呼的人（欢迎过或回过他的话） */
  private greeted = new Set<string>();
  private chatTimes: number[] = [];
  /** 没话题时多久开始自己找话说；可在直播中调整 */
  idleAfterMs = TUNING.idleAfterMs;

  private lastSpeechEndAt: number;
  private speaking = false;
  private lastSaid: Partial<Record<TopicBody['kind'], number>> = {};
  private lastKind: TopicBody['kind'] | null = null;
  private beats: BeatSource | null = null;
  /** 最近一次有观众动静的时间 */
  private lastAudienceAt = -Infinity;
  private online: number | undefined;
  private anchorId = '';
  private rehearsal = false;
  /** 上次看时有没有人：从没人到有人，先回应来的人，再接着说环节 */
  private hadAudience = true;
  private justWoke = false;
  private seq = 0;

  constructor(now: number) {
    this.lastSpeechEndAt = now;
  }

  // ── 输入 ─────────────────────────────────────────────

  /** 有观众动静（主播自己，比如开着自己直播间的页面，不算） */
  noteAudience(event: LiveEvent, now: number): void {
    if (!this.anchorId || event.user.id !== this.anchorId) this.lastAudienceAt = now;
  }

  observe(event: LiveEvent, isUpdate: boolean, now: number): void {
    this.noteAudience(event, now);
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

  /** 平台推来的在线人数（没开播时平台不推，为 undefined） */
  setOnline(online: number | undefined): void {
    this.online = online;
  }

  setAnchorId(id: string | undefined): void {
    this.anchorId = id ?? '';
  }

  /** 直播间没开播（测试、排练）：没人在看也照常演 */
  setRehearsal(on: boolean): void {
    this.rehearsal = on;
  }

  get isRehearsal(): boolean {
    return this.rehearsal;
  }

  audiencePresent(now: number): boolean {
    if (this.rehearsal) return true;
    return now - this.lastAudienceAt < TUNING.audience.activityMs || (this.online ?? 0) >= TUNING.audience.minOnline;
  }

  /** 接上（或断开）环节导演 */
  setBeatSource(source: BeatSource | null): void {
    this.beats = source;
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
    const audience = this.audiencePresent(now);
    if (audience && !this.hadAudience) this.justWoke = true;
    this.hadAudience = audience;
    this.beats?.setAudience?.(audience, now);
    const candidates: Array<{ priority: number; build: () => TopicBody; waitUntil?: number }> = [];

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

    // 没人在看：只回应真的发生了的事（其实也不会有），不自己找话
    const beat = audience ? this.beatCandidate(heat, now) : null;
    if (beat) candidates.push(beat);

    if (!candidates.length) {
      const silentMs = now - this.lastSpeechEndAt;
      if (!audience || this.speaking || silentMs < this.idleAfterMs) return null;
      candidates.push({ priority: 1, build: () => ({ kind: 'idle', silentMs }) });
    }

    candidates.sort((a, b) => b.priority - a.priority);
    const best = candidates[0];
    // 该说环节拍了，但刚说完话：先歇一口气（这时来的普通弹幕不插队）
    if (best.waitUntil !== undefined && now < best.waitUntil) return null;
    const body = best.build();
    this.lastSaid[body.kind] = now;
    this.lastKind = body.kind;
    this.justWoke = false;
    return { ...body, id: `topic-${++this.seq}`, priority: best.priority, heat, createdAt: now };
  }

  snapshot(now: number): AttentionSnapshot {
    this.prune(now);
    return {
      heat: this.heat(now),
      audience: this.audiencePresent(now),
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
    if (this.greeted.has(uid)) tags.push('这场已经打过招呼了：别再欢迎，也别问是不是第一次来');
    // 情报站以外的环节收到视频：研究队列已经接了（streamerSession），这里让她如实回一句
    if (features.videoLink) { base += 0.3; tags.push('发了B站视频，已排进研究队列，情报站环节里会讲'); }
    // 想让她看视频却只给了关键词：引导他发 BV 号（关键词搜索以后会支持）
    else if (features.videoAsk) { base += 0.25; tags.push('想让你看某个视频但没给BV号：请他发BV号，或把b23.tv/后面的短码写成「短码 xxx」；关键词搜索以后会支持'); }
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
        for (const uid of taken) {
          this.remember(uid, now).answeredAt = now;
          this.greeted.add(uid);
        }
        this.chats = this.chats.filter((o) => !taken.has(o.uid));
        return { kind: 'chat', picks };
      },
    };
  }

  // ── 环节 ─────────────────────────────────────────────

  private beatCandidate(heat: RoomHeat, now: number): { priority: number; build: () => TopicBody; waitUntil: number } | null {
    if (!this.beats || this.speaking) return null;
    const kind = this.beats.peek(now, heat);
    if (!kind) return null;
    const source = this.beats;
    const priority = kind === 'transition'
      ? TUNING.beat.transition
      : this.lastKind === 'segment' || this.justWoke ? TUNING.beat.afterBeat[heat] : TUNING.beat.afterOther[heat];
    // 偶尔 peek 到了却拿不到（素材刚好用完）：退回冷场找话
    // 冷清的房间有人刚进来：先等他们凑齐、欢迎完再接着说环节
    const greetFirst = heat === 'quiet' && this.enters.length
      ? Math.min(...this.enters.map((e) => e.at)) + TUNING.welcomeGatherMs
      : -Infinity;
    return {
      priority,
      waitUntil: Math.max(this.lastSpeechEndAt + TUNING.beat.gapMs[heat], greetFirst),
      build: () => source.take(now, heat) ?? { kind: 'idle', silentMs: now - this.lastSpeechEndAt },
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
      // 冷清时欢迎排在环节拍前面（环节拍最高 55）
      priority: heat === 'quiet' ? 60 : 20,
      build: () => {
        const ranked = eligible.sort((a, b) => notability(b.user) - notability(a.user));
        this.enters = [];
        for (const e of ranked) this.greeted.add(e.user.id || e.user.name);
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
