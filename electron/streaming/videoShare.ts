import type { LiveChatEvent } from '../../shared/types/live';

const PENDING_MS = 5 * 60_000;
const FULL_VIDEO_ID = /BV[0-9A-Za-z]{10}|b23\.tv\/[0-9A-Za-z]+/i;
const BARE_CODE = /^[A-Za-z0-9]{6,16}$/;
const EXPLICIT_CODE = /^(?:短码|短链码|链接尾码|b23尾码)\s*[:：\s]\s*([A-Za-z0-9]{6,16})$/i;
const BROKEN_PREFIX = /(?:^|\s)(?:h|ht|htt|http|https)(?::\/{0,2})?$/i;
const VIDEO_INTENT = /看|视频|分享|链接|投稿|哔哩|b站/i;

/** 直播弹幕可能截断分享链接；只把同一观众短时间内补发的短码拼成 b23 链接。 */
export class ViewerVideoShare {
  private readonly pending = new Map<string, number>();

  reset(): void {
    this.pending.clear();
  }

  normalize(event: LiveChatEvent, now: number): LiveChatEvent {
    const uid = event.user.id || event.user.name;
    const text = event.text.trim();
    if (!uid || event.user.masked) return event;
    if (FULL_VIDEO_ID.test(text)) {
      this.pending.delete(uid);
      return event;
    }
    if (BROKEN_PREFIX.test(text) && VIDEO_INTENT.test(text)) {
      this.pending.set(uid, now + PENDING_MS);
      return event;
    }
    const explicit = EXPLICIT_CODE.exec(text)?.[1];
    const pendingUntil = this.pending.get(uid) ?? 0;
    if (pendingUntil && pendingUntil < now) this.pending.delete(uid);
    const code = explicit ?? (pendingUntil >= now && BARE_CODE.test(text) ? text : null);
    if (!code) return event;
    this.pending.delete(uid);
    return { ...event, text: `b23.tv/${code}` };
  }
}
