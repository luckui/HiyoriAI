/**
 * 直播记忆：直播中记下谁来了、说了什么；组装话题时给出这位观众的「卡片」；下播后提炼。
 *
 * 一次 AI 互动会话（streamerSession 开到停）算一场。存储见 liveMemoryStore.ts，提炼见 liveMemoryDistill.ts。
 */

import type { LiveEvent, LivePlatform, LiveUser } from '../../../shared/types/live';
import { cleanName, cleanText } from '../danmuSafety';
import { FORGET_AFTER_MS, LiveMemoryStore, type ViewerRecord } from './liveMemoryStore';

/** 「忘了我」「别记我」；排除「别忘了我」「不要忘了我」 */
const FORGET_ME = /(?<![别不要])忘(?:了|掉)我|别记(?:住)?我|不要记(?:住)?我|删(?:掉|除)?我的(?:记录|档案)/;

const DAY = 24 * 3600_000;
const GUARD = ['', '总督', '提督', '舰长'];

/** 本场第一次见到这位观众时，他之前的样子（卡片里说「上次是几天前」用） */
interface Previous {
  lastSeen: number;
  visits: number;
  isNew: boolean;
}

export class LiveMemory {
  private streamId: number | null = null;
  private previous = new Map<string, Previous>();
  /** 本场说了「忘了我」的人：卡片提醒她答应一声 */
  private forgotten = new Set<string>();

  constructor(readonly store: LiveMemoryStore) {}

  get currentStream(): number | null {
    return this.streamId;
  }

  begin(now: number): number {
    if (this.streamId !== null) return this.streamId;
    this.streamId = this.store.beginStream(now);
    this.previous.clear();
    this.forgotten.clear();
    return this.streamId;
  }

  /** 结束这一场，返回场次 id（之后交给提炼） */
  end(now: number): number | null {
    const id = this.streamId;
    if (id === null) return null;
    this.store.endStream(id, now);
    this.streamId = null;
    return id;
  }

  /** 直播事件进来：只做便宜的记录 */
  observe(event: LiveEvent, isUpdate: boolean, now: number): void {
    const id = this.streamId;
    const uid = event.user.id;
    if (id === null || !uid || event.user.masked || uid === '0') return;
    const platform = event.platform;
    const key = `${platform}:${uid}`;

    if (event.kind === 'chat' && !isUpdate && FORGET_ME.test(event.text)) {
      this.store.forgetViewer(platform, uid, now);
      this.forgotten.add(key);
      this.previous.delete(key);
      return;
    }
    if (this.store.isOptedOut(platform, uid)) return;
    if (isUpdate && event.kind !== 'gift') return;

    if (!this.previous.has(key)) {
      const before = this.store.getViewer(platform, uid);
      this.previous.set(key, { lastSeen: before?.lastSeen ?? now, visits: before?.visits ?? 0, isNew: !before });
    }
    this.store.touchViewer(platform, uid, cleanName(event.user.name), id, now);
    if (event.kind === 'chat' && !isUpdate && !event.emoteOnly) {
      const text = cleanText(event.text);
      if (text) this.store.addLine(platform, uid, id, text, now);
    } else if ((event.kind === 'gift' || event.kind === 'superchat') && !isUpdate && event.valueYuan > 0) {
      this.store.addGift(platform, uid, event.valueYuan);
    } else if (event.kind === 'membership') {
      this.store.addGift(platform, uid, event.valueYuan, event.level);
    }
  }

  /**
   * 给提示词的一小段：她记得这位观众什么。没什么可说的返回 null。
   * 例：「老观众，第 5 次来（上次是 3 天前）；你叫他「阿考」；记得：下周考研」
   */
  viewerCard(user: LiveUser, now: number, platform: LivePlatform = 'bilibili'): string | null {
    if (!user.id || user.masked) return null;
    const key = `${platform}:${user.id}`;
    if (this.forgotten.has(key)) return '他刚说不想被记住，关于他的记录已经删掉了：简单答应一声就好，别再提他以前的事';
    const prev = this.previous.get(key);
    const viewer = this.store.getViewer(platform, user.id);
    if (!viewer) return null;
    if (prev?.isNew) return '第一次来直播间';
    return describeViewer(viewer, prev, now);
  }

  /** 开场白用：上一场的一两句回顾 */
  lastRecap(): string[] {
    const stream = this.store.lastRecappedStream(this.streamId ?? undefined);
    return stream ? stream.recap.slice(0, 2) : [];
  }

  /** 她之前说过的口味（保持一致）和直播间的梗；最近的在前 */
  roomContext(now: number): { tastes: string[]; memes: string[] } {
    const tastes = this.store.tastes().slice(0, 6).map((t) =>
      `${t.kind === 'like' ? '喜欢' : t.kind === 'dislike' ? '不喜欢' : '关注'}${t.subject}${t.reason ? `（${t.reason}）` : ''}`);
    // 梗按最近提到的时间淡化：两个月没提的就不放进提示词了
    const memes = this.store.memes().filter((m) => now - m.lastMentioned < 60 * DAY).slice(0, 5).map((m) => m.text);
    return { tastes, memes };
  }
}

function ago(ms: number): string {
  const days = Math.floor(ms / DAY);
  return days < 1 ? '今天' : days < 60 ? `${days} 天前` : `${Math.floor(days / 30)} 个月前`;
}

function describeViewer(v: ViewerRecord, prev: Previous | undefined, now: number): string | null {
  const parts: string[] = [];
  const visits = v.visits;
  const lastSeen = prev?.lastSeen ?? v.lastSeen;
  const longAgo = now - lastSeen > FORGET_AFTER_MS;
  if (visits >= 2) {
    const days = Math.floor((now - lastSeen) / DAY);
    parts.push(`老观众，第 ${visits} 次来${days >= 1 ? `（上次是 ${days} 天前）` : ''}`);
  }
  if (v.names.length > 1) parts.push(`以前叫「${v.names[v.names.length - 2]}」`);
  if (GUARD[v.guardLevel]) parts.push(`上过${GUARD[v.guardLevel]}`);
  else if (v.giftYuan >= 10) parts.push('以前支持过直播间');
  if (!longAgo) {
    if (v.nickname) parts.push(`你叫他「${v.nickname}」`);
    // 最近被提到的要点在前，最多三条
    const notes = [...v.notes].sort((a, b) => b.at - a.at).filter((n) => now - n.at < FORGET_AFTER_MS).slice(0, 3);
    // 标上是什么时候聊的：「下周考试」过了十天再提就该问考得怎么样了
    if (notes.length) parts.push(`记得：${notes.map((n) => `${n.text}（${ago(now - n.at)}聊的）`).join('；')}`);
    const appraisal = v.appraisal as { summary?: string } | null;
    if (appraisal?.summary) parts.push(`看过他的主页：${appraisal.summary}`);
  }
  const text = parts.filter(Boolean).join('；');
  return text || null;
}
