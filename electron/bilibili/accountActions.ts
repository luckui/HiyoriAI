/** B 站登录账号的操作：视频互动、关注关系与私信。业务配额和发送时机由调用方决定。 */

import { randomUUID } from 'crypto';
import { signWbi, type BiliSession } from '../streaming/platforms/bilibili/biliApi';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT_MS = 12_000;

interface ApiResponse<T> {
  code: number;
  message?: string;
  data?: T;
}

function cookieValue(cookie: string, name: string): string | undefined {
  return new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie)?.[1];
}

/** 私信接口的错误（带 B 站返回码）。 */
export class DmError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/** 复用调用方的登录会话，不持有直播、研究或送礼私信的业务状态。 */
export class BiliAccountActions {
  constructor(private readonly session: () => Promise<BiliSession>) {}

  private async post(url: string, form: Record<string, string | number>): Promise<void> {
    const s = await this.session();
    const csrf = cookieValue(s.cookie, 'bili_jct');
    if (!s.loggedIn || !csrf) throw new Error('没有登录 Cookie（或缺 bili_jct），不能点赞评论');
    const body = new URLSearchParams(Object.entries({ ...form, csrf }).map(([k, v]) => [k, String(v)]));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: s.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json()) as ApiResponse<unknown>;
    // 65006：已经赞过
    if (json.code !== 0 && json.code !== 65006) throw new Error(`B 站返回 ${json.code} ${json.message ?? ''}`);
  }

  like(aid: number): Promise<void> {
    return this.post('https://api.bilibili.com/x/web-interface/archive/like', { aid, like: 1 });
  }

  comment(aid: number, message: string): Promise<void> {
    return this.post('https://api.bilibili.com/x/v2/reply/add', { type: 1, oid: aid, message, plat: 1 });
  }

  /** 查询观众是否关注了当前登录账号；无法确认时由调用方保守处理。 */
  async followsMe(viewerId: string): Promise<boolean | null> {
    if (!/^\d+$/.test(viewerId)) return null;
    const s = await this.session();
    if (!s.loggedIn || !s.uid) return null;
    const res = await fetch(`https://api.bilibili.com/x/web-interface/relation?mid=${viewerId}`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: s.cookie },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} /x/web-interface/relation`);
    const body = (await res.json()) as ApiResponse<{ be_relation?: { attribute?: number } }>;
    if (body.code !== 0 || body.data === undefined) throw new Error(`B 站接口 /x/web-interface/relation 返回 ${body.code} ${body.message ?? ''}`);
    const attribute = body.data.be_relation?.attribute;
    return typeof attribute === 'number' ? attribute === 2 || attribute === 6 : null;
  }

  /** 发一条文字私信；频率和重试由业务调用方控制。 */
  async sendMessage(receiverId: string, text: string): Promise<void> {
    const s = await this.session();
    const csrf = cookieValue(s.cookie, 'bili_jct');
    if (!s.loggedIn || !csrf || !s.uid) throw new DmError(-101, '没有登录 Cookie（或缺 bili_jct），不能发私信');
    const devId = randomUUID().toUpperCase();
    const url = `https://api.vc.bilibili.com/web_im/v1/web_im/send_msg?${signWbi({ w_sender_uid: s.uid, w_receiver_id: receiverId, w_dev_id: devId }, s.mixinKey)}`;
    const form: Record<string, string | number> = {
      'msg[sender_uid]': s.uid,
      'msg[receiver_id]': receiverId,
      'msg[receiver_type]': 1,
      'msg[msg_type]': 1,
      'msg[msg_status]': 0,
      'msg[dev_id]': devId,
      'msg[timestamp]': Math.floor(Date.now() / 1000),
      'msg[new_face_version]': 1,
      'msg[content]': JSON.stringify({ content: text }),
      csrf,
      csrf_token: csrf,
      build: 0,
      mobi_app: 'web',
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, Referer: 'https://message.bilibili.com/', Origin: 'https://message.bilibili.com', Cookie: s.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json()) as ApiResponse<unknown>;
    if (json.code !== 0) throw new DmError(json.code, json.message ?? '');
  }
}
