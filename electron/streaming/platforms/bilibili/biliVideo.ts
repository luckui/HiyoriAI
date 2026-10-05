/**
 * B 站视频接口：热门 / 每周必看 / 排行榜 / UP 主新投稿、视频详情、热评、字幕、音频地址，以及点赞和评论。
 *
 * 实测（2026-10，登录 Cookie）：
 * - 热门 x/web-interface/popular、每周必看 popular/series/one、排行 ranking/v2 不用签名；
 * - 字幕 x/player/wbi/v2、音频 x/player/wbi/playurl、UP 主投稿 x/space/wbi/arc/search 要 WBI 签名；
 *   AI 字幕（ai-zh 等）登录后才给，大部分热门视频都有；
 * - 热评用老接口 x/v2/reply?sort=1 就行。
 * 点赞、评论要 Cookie 里的 bili_jct 当 csrf。
 */

import { randomUUID } from 'crypto';
import zlib from 'zlib';
import { createBiliSession, signWbi, type BiliSession } from './biliApi';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT_MS = 12_000;
/** 签名密钥、buvid 一小时内复用 */
const SESSION_TTL_MS = 3600_000;

export interface BiliVideo {
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  desc: string;
  cover: string;
  upName: string;
  upMid: number;
  /** 秒 */
  duration: number;
  /** 秒级时间戳 */
  pubdate: number;
  tid: number;
  tname: string;
  stat: { view: number; like: number; coin: number; favorite: number; reply: number; danmaku: number };
}

/** 列表里的一项（还没查详情） */
export interface BiliVideoBrief {
  bvid: string;
  title: string;
  upName: string;
  upMid: number;
  duration: number;
  tid?: number;
  tname?: string;
  /** 从哪来的：热门 / 每周必看 / 关注的 UP … */
  source: string;
}

export interface BiliComment {
  user: string;
  text: string;
  likes: number;
}

/** 视频里的一条弹幕：t 是视频里的秒数 */
export interface VideoDanmaku {
  t: number;
  text: string;
}

/** 视频快照（进度条预览图）：雪碧图，每张 x_len × y_len 帧 */
export interface VideoShots {
  images: string[];
  /** 第 i 帧对应视频里的秒数 */
  times: number[];
  cols: number;
  rows: number;
  width: number;
  height: number;
}

export interface TranscriptLine {
  /** 秒 */
  from: number;
  to: number;
  text: string;
}

interface ApiResponse<T> {
  code: number;
  message?: string;
  data?: T;
}

interface RawVideo {
  bvid: string; aid: number; cid: number; title: string; desc?: string; pic?: string; duration: number; pubdate?: number;
  tid?: number; tname?: string; tid_v2?: number; tname_v2?: string; owner?: { mid: number; name: string };
  stat?: Partial<BiliVideo['stat']>;
}

function brief(v: RawVideo, source: string): BiliVideoBrief {
  return { bvid: v.bvid, title: v.title, upName: v.owner?.name ?? '', upMid: v.owner?.mid ?? 0, duration: v.duration, tid: v.tid, tname: v.tname, source };
}

/** 弹幕里的 BV 号或 b23 短链 */
export const BV_PATTERN = /BV[0-9A-Za-z]{10}/;
export const B23_PATTERN = /b23\.tv\/[0-9A-Za-z]+/;

function cookieValue(cookie: string, name: string): string | undefined {
  return new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie)?.[1];
}

/** 私信接口的错误（带 B 站返回码） */
export class DmError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export class BiliVideoClient {
  private session: Promise<BiliSession> | null = null;
  private sessionAt = 0;

  constructor(private readonly cookie: () => string) {}

  private async auth(): Promise<BiliSession> {
    if (!this.session || Date.now() - this.sessionAt > SESSION_TTL_MS) {
      this.sessionAt = Date.now();
      this.session = createBiliSession(this.cookie());
      this.session.catch(() => { this.session = null; });
    }
    return this.session;
  }

  get loggedIn(): Promise<boolean> {
    return this.auth().then((s) => s.loggedIn, () => false);
  }

  private async get<T>(url: string): Promise<T> {
    const s = await this.auth();
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: s.cookie },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).pathname}`);
    const body = (await res.json()) as ApiResponse<T>;
    if (body.code !== 0 || body.data === undefined) throw new Error(`B 站接口 ${new URL(url).pathname} 返回 ${body.code} ${body.message ?? ''}`);
    return body.data;
  }

  private async signed(base: string, params: Record<string, string | number>): Promise<string> {
    const s = await this.auth();
    return `${base}?${signWbi(params, s.mixinKey)}`;
  }

  // ── 列表 ─────────────────────────────────────────────

  async popular(page = 1): Promise<BiliVideoBrief[]> {
    const data = await this.get<{ list: RawVideo[] }>(`https://api.bilibili.com/x/web-interface/popular?ps=20&pn=${page}`);
    return data.list.map((v) => brief(v, '热门'));
  }

  async weekly(): Promise<BiliVideoBrief[]> {
    const series = await this.get<{ list: Array<{ number: number }> }>('https://api.bilibili.com/x/web-interface/popular/series/list');
    const latest = series.list[0]?.number;
    if (!latest) return [];
    const data = await this.get<{ list: RawVideo[] }>(`https://api.bilibili.com/x/web-interface/popular/series/one?number=${latest}`);
    return data.list.map((v) => brief(v, '每周必看'));
  }

  async ranking(): Promise<BiliVideoBrief[]> {
    const data = await this.get<{ list: RawVideo[] }>('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all');
    return data.list.map((v) => brief(v, '排行榜'));
  }

  /** UP 主最新投稿 */
  async upLatest(mid: number, count = 3): Promise<BiliVideoBrief[]> {
    const url = await this.signed('https://api.bilibili.com/x/space/wbi/arc/search', { mid, ps: count, pn: 1, order: 'pubdate' });
    const data = await this.get<{ list?: { vlist?: Array<{ bvid: string; title: string; author: string; mid: number; length: string; typeid?: number }> } }>(url);
    return (data.list?.vlist ?? []).map((v) => ({
      bvid: v.bvid, title: v.title, upName: v.author, upMid: v.mid, duration: parseLength(v.length), tid: v.typeid, source: '关注的 UP 主',
    }));
  }

  /** UP 主的投稿，按发布时间从新到旧翻页，最多 limit 个 */
  async upAll(mid: number, limit: number): Promise<BiliVideoBrief[]> {
    const out: BiliVideoBrief[] = [];
    for (let pn = 1; out.length < limit; pn++) {
      const url = await this.signed('https://api.bilibili.com/x/space/wbi/arc/search', { mid, ps: 30, pn, order: 'pubdate' });
      const data = await this.get<{ page?: { count: number }; list?: { vlist?: Array<{ bvid: string; title: string; author: string; mid: number; length: string; typeid?: number }> } }>(url);
      const page = data.list?.vlist ?? [];
      out.push(...page.map((v) => ({
        bvid: v.bvid, title: v.title, upName: v.author, upMid: v.mid, duration: parseLength(v.length), tid: v.typeid, source: 'UP 主投稿',
      })));
      if (!page.length || out.length >= (data.page?.count ?? 0)) break;
      // 翻页慢一点，免得被风控
      await new Promise((r) => setTimeout(r, 800));
    }
    return out.slice(0, limit);
  }

  /** 按名字找 UP 主：名字完全一样的优先，其次粉丝最多的 */
  async findUp(name: string): Promise<{ mid: number; name: string; fans: number; videos: number } | null> {
    const url = await this.signed('https://api.bilibili.com/x/web-interface/wbi/search/type', { search_type: 'bili_user', keyword: name });
    const data = await this.get<{ result?: Array<{ mid: number; uname: string; fans: number; videos: number }> }>(url);
    const list = data.result ?? [];
    const pick = list.find((u) => u.uname === name) ?? [...list].sort((a, b) => b.fans - a.fans)[0];
    return pick ? { mid: pick.mid, name: pick.uname, fans: pick.fans, videos: pick.videos } : null;
  }

  /** 按关键词搜视频（默认按播放量排） */
  async search(keyword: string, limit: number, order: 'click' | 'pubdate' | 'totalrank' = 'click'): Promise<BiliVideoBrief[]> {
    const out: BiliVideoBrief[] = [];
    for (let page = 1; out.length < limit && page <= 10; page++) {
      const url = await this.signed('https://api.bilibili.com/x/web-interface/wbi/search/type', { search_type: 'video', keyword, order, page });
      const data = await this.get<{ result?: Array<{ bvid: string; title: string; author: string; mid: number; duration: string; typeid?: string; typename?: string }> }>(url);
      const list = data.result ?? [];
      out.push(...list.map((v) => ({
        // 搜索结果的标题带 <em class="keyword"> 高亮
        bvid: v.bvid, title: unescapeXml(v.title.replace(/<[^>]+>/g, '')), upName: v.author, upMid: v.mid,
        duration: parseLength(v.duration), tid: Number(v.typeid) || undefined, tname: v.typename, source: `搜索「${keyword}」`,
      })));
      if (!list.length) break;
      await new Promise((r) => setTimeout(r, 800));
    }
    return out.slice(0, limit);
  }

  // ── 单个视频 ─────────────────────────────────────────

  async video(bvid: string): Promise<BiliVideo> {
    const v = await this.get<RawVideo>(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
    const stat = v.stat ?? {};
    return {
      bvid: v.bvid, aid: v.aid, cid: v.cid, title: v.title, desc: v.desc ?? '', cover: v.pic ?? '',
      upName: v.owner?.name ?? '', upMid: v.owner?.mid ?? 0, duration: v.duration, pubdate: v.pubdate ?? 0,
      // 详情接口的老分区字段有时是空的，新的在 *_v2
      tid: v.tid || v.tid_v2 || 0, tname: v.tname || v.tname_v2 || '',
      stat: {
        view: stat.view ?? 0, like: stat.like ?? 0, coin: stat.coin ?? 0,
        favorite: stat.favorite ?? 0, reply: stat.reply ?? 0, danmaku: stat.danmaku ?? 0,
      },
    };
  }

  async hotComments(aid: number, count = 5): Promise<BiliComment[]> {
    const data = await this.get<{ replies?: Array<{ like: number; member?: { uname?: string }; content?: { message?: string } }> }>(
      `https://api.bilibili.com/x/v2/reply?oid=${aid}&type=1&sort=1&ps=${count}&pn=1`,
    );
    return (data.replies ?? []).map((r) => ({ user: r.member?.uname ?? '', text: r.content?.message ?? '', likes: r.like }));
  }

  /** 字幕（优先中文，AI 字幕也算）；没有返回 null */
  async subtitles(bvid: string, cid: number): Promise<TranscriptLine[] | null> {
    const url = await this.signed('https://api.bilibili.com/x/player/wbi/v2', { bvid, cid });
    const data = await this.get<{ subtitle?: { subtitles?: Array<{ lan: string; subtitle_url: string }> } }>(url);
    const subs = (data.subtitle?.subtitles ?? []).filter((s) => s.subtitle_url);
    const pick = subs.find((s) => /^(ai-)?zh/.test(s.lan)) ?? subs[0];
    if (!pick) return null;
    const subUrl = pick.subtitle_url.startsWith('//') ? `https:${pick.subtitle_url}` : pick.subtitle_url;
    const res = await fetch(subUrl, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await res.json()) as { body?: Array<{ from: number; to: number; content: string }> };
    return (body.body ?? []).map((l) => ({ from: l.from, to: l.to, text: l.content }));
  }

  /** 视频的弹幕（接口给的是抽样，热门视频几百到几千条） */
  async danmaku(cid: number): Promise<VideoDanmaku[]> {
    const s = await this.auth();
    const res = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: s.cookie },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let xml: string;
    try {
      xml = zlib.inflateRawSync(buf).toString('utf8');
    } catch {
      xml = buf.toString('utf8');
    }
    return [...xml.matchAll(/<d p="([\d.]+),[^"]*">([^<]*)<\/d>/g)].map((m) => ({ t: Number(m[1]), text: unescapeXml(m[2]) }));
  }

  /** 进度条预览图：不用播放就能看到某个时刻的画面（480×270） */
  async videoshots(bvid: string, cid: number): Promise<VideoShots | null> {
    const data = await this.get<{ image?: string[]; index?: number[]; img_x_len: number; img_y_len: number; img_x_size: number; img_y_size: number }>(
      `https://api.bilibili.com/x/player/videoshot?bvid=${bvid}&cid=${cid}&index=1`,
    );
    if (!data.image?.length || !data.index?.length) return null;
    return {
      images: data.image.map((u) => (u.startsWith('//') ? `https:${u}` : u)),
      // index 的第一项是占位，从第二项起才是每帧的时间
      times: data.index.slice(1),
      cols: data.img_x_len,
      rows: data.img_y_len,
      width: data.img_x_size,
      height: data.img_y_size,
    };
  }

  /** 音频流地址（转写用）：选码率最低的一条 */
  async audioUrl(bvid: string, cid: number): Promise<string | null> {
    const url = await this.signed('https://api.bilibili.com/x/player/wbi/playurl', { bvid, cid, fnval: 16, fnver: 0, fourk: 0 });
    const data = await this.get<{ dash?: { audio?: Array<{ bandwidth: number; baseUrl?: string; base_url?: string }> } }>(url);
    const audio = [...(data.dash?.audio ?? [])].sort((a, b) => a.bandwidth - b.bandwidth)[0];
    return audio?.baseUrl ?? audio?.base_url ?? null;
  }

  /** 下载音频流、封面、预览图（要带 Referer） */
  async download(url: string): Promise<Buffer> {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** 弹幕里的 BV 号或 b23 短链 → BV 号 */
  async resolveLink(text: string): Promise<string | null> {
    const bv = BV_PATTERN.exec(text)?.[0];
    if (bv) return bv;
    const short = B23_PATTERN.exec(text)?.[0];
    if (!short) return null;
    const res = await fetch(`https://${short}`, { redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return BV_PATTERN.exec(res.headers.get('location') ?? '')?.[0] ?? null;
  }

  // ── 互动（用登录 Cookie）────────────────────────────

  private async post(url: string, form: Record<string, string | number>): Promise<void> {
    const s = await this.auth();
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

  /** 查询观众是否关注了当前登录的主播；无法确认时由调用方保守处理。 */
  async followsMe(viewerId: string): Promise<boolean | null> {
    if (!/^\d+$/.test(viewerId)) return null;
    const s = await this.auth();
    if (!s.loggedIn || !s.uid) return null;
    const data = await this.get<{ be_relation?: { attribute?: number } }>(`https://api.bilibili.com/x/web-interface/relation?mid=${viewerId}`);
    const attribute = data.be_relation?.attribute;
    return typeof attribute === 'number' ? attribute === 2 || attribute === 6 : null;
  }

  /**
   * 发一条文字私信（web 端接口，要 Wbi 签名）。失败抛 DmError，常见的：
   * 21047 对方回复或关注之前只能发 1 条，25003 对方隐私设置不收，21020 / 21046 发太快。
   */
  async sendMessage(receiverId: string, text: string): Promise<void> {
    const s = await this.auth();
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

function unescapeXml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** 「12:34」「1:02:03」→ 秒 */
function parseLength(text: string): number {
  return text.split(':').reduce((sum, part) => sum * 60 + (Number(part) || 0), 0);
}
