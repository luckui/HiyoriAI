/**
 * 一场直播的记录：从开场到谢幕收到了什么。谢幕动画的感谢名单和她的告别语都用它。
 */

import type { LiveCredits, LiveEvent } from '../../shared/types/live';

const MAX_NAMES = 60;

export class ShowLog {
  private startedAt = Date.now();
  private chats = 0;
  private peakOnline = 0;
  private readonly superchats = new Set<string>();
  private readonly members = new Set<string>();
  private readonly gifts = new Map<string, number>();
  /** 每个礼物事件（连击）已计入的金额 */
  private readonly giftSeen = new Map<string, number>();
  private readonly followers = new Set<string>();
  private readonly chatters = new Map<string, number>();

  reset(now = Date.now()): void {
    this.startedAt = now;
    this.chats = 0;
    this.peakOnline = 0;
    for (const set of [this.superchats, this.members, this.followers]) set.clear();
    this.gifts.clear();
    this.giftSeen.clear();
    this.chatters.clear();
  }

  observe(event: LiveEvent, isUpdate: boolean): void {
    const name = event.user.masked ? '' : event.user.name;
    switch (event.kind) {
      case 'chat':
        if (isUpdate) return;
        this.chats += 1;
        if (name) this.chatters.set(name, (this.chatters.get(name) ?? 0) + 1);
        break;
      case 'superchat':
        if (name) this.superchats.add(name);
        break;
      case 'membership':
        if (name) this.members.add(name);
        break;
      case 'gift':
        // 连击合并后同 id 会带着累计值再来，只在第一次加上，更新时补差
        if (name && event.valueYuan > 0) this.giftTotals(name, event.id, event.valueYuan);
        break;
      case 'follow':
        if (name) this.followers.add(name);
        break;
      default:
        break;
    }
  }

  private giftTotals(name: string, id: string, total: number): void {
    const counted = this.giftSeen.get(id) ?? 0;
    this.giftSeen.set(id, total);
    this.gifts.set(name, (this.gifts.get(name) ?? 0) + total - counted);
  }

  observeOnline(online: number | undefined): void {
    if (online && online > this.peakOnline) this.peakOnline = online;
  }

  credits(now = Date.now()): LiveCredits {
    const ranked = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n).slice(0, MAX_NAMES);
    return {
      startedAt: this.startedAt,
      durationMs: now - this.startedAt,
      chats: this.chats,
      peakOnline: this.peakOnline,
      superchats: [...this.superchats].slice(0, MAX_NAMES),
      members: [...this.members].slice(0, MAX_NAMES),
      gifters: ranked(this.gifts),
      followers: [...this.followers].slice(0, MAX_NAMES),
      chatters: ranked(this.chatters),
    };
  }

  /** 给她告别时参考的一段话 */
  summary(now = Date.now()): string {
    const c = this.credits(now);
    const minutes = Math.max(1, Math.round(c.durationMs / 60_000));
    const parts = [`今天播了大约 ${minutes} 分钟，收到 ${c.chats} 条弹幕。`];
    if (c.members.length) parts.push(`新上舰：${c.members.slice(0, 3).join('、')}。`);
    if (c.superchats.length) parts.push(`发了醒目留言：${c.superchats.slice(0, 3).join('、')}。`);
    if (c.gifters.length) parts.push(`送礼物的有 ${c.gifters.length} 位，比如 ${c.gifters.slice(0, 3).join('、')}。`);
    if (c.chatters.length) parts.push(`聊得最多的：${c.chatters.slice(0, 3).join('、')}。`);
    return parts.join('');
  }
}
