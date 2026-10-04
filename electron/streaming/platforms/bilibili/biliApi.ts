/**
 * B 站直播用到的 HTTP 接口：登录态、房间信息、弹幕服务器与 token。
 *
 * 实测（2026-10）：
 * - getDanmuInfo 要 WBI 签名和 buvid3，否则返回 -352（风控）。
 * - 不登录也能连上弹幕服务器，但几分钟后大部分观众的名字会被打码成「小***」、uid 变成 0，
 *   所以弹幕姬应以登录 Cookie 连接。
 */

import crypto from 'crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT_MS = 10_000;

/** WBI 签名的混淆表（B 站前端常量） */
const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export interface BiliSession {
  /** 发请求用的完整 Cookie（补齐了 buvid3） */
  cookie: string;
  buvid: string;
  /** 登录用户 uid；匿名为 0 */
  uid: number;
  loggedIn: boolean;
  /** 填了 Cookie 但服务器认为没登录（过期或已退出） */
  cookieRejected: boolean;
  mixinKey: string;
}

export interface BiliRoom {
  realRoomId: number;
  anchorId: string;
  anchorName?: string;
  title?: string;
  live: boolean;
}

export interface DanmuServer {
  host: string;
  wss_port: number;
}

async function getJson<T>(url: string, cookie?: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://live.bilibili.com/',
      Origin: 'https://live.bilibili.com',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).pathname}`);
  return (await res.json()) as T;
}

interface ApiResponse<T> {
  code: number;
  message?: string;
  data?: T;
}

function cookieValue(cookie: string, name: string): string | undefined {
  return new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie)?.[1];
}

/** 校验 Cookie、取 WBI 密钥；没有 buvid3 时向 B 站申请一个 */
export async function createBiliSession(userCookie: string): Promise<BiliSession> {
  let cookie = userCookie.trim().replace(/;\s*$/, '');
  let buvid = cookieValue(cookie, 'buvid3');
  if (!buvid) {
    const spi = await getJson<ApiResponse<{ b_3: string }>>('https://api.bilibili.com/x/frontend/finger/spi');
    buvid = spi.data?.b_3 ?? '';
    cookie = cookie ? `${cookie}; buvid3=${buvid}` : `buvid3=${buvid}`;
  }

  // 未登录时 nav 返回 -101，但 data.wbi_img 照样给
  const nav = await getJson<ApiResponse<{ isLogin?: boolean; mid?: number; wbi_img: { img_url: string; sub_url: string } }>>(
    'https://api.bilibili.com/x/web-interface/nav',
    cookie,
  );
  if (!nav.data?.wbi_img) throw new Error(`获取 B 站签名密钥失败：${nav.code} ${nav.message ?? ''}`);
  const loggedIn = nav.data.isLogin === true;
  const key = (url: string) => url.slice(url.lastIndexOf('/') + 1).split('.')[0];
  const raw = key(nav.data.wbi_img.img_url) + key(nav.data.wbi_img.sub_url);

  return {
    cookie,
    buvid,
    uid: loggedIn ? nav.data.mid ?? 0 : 0,
    loggedIn,
    cookieRejected: !loggedIn && /SESSDATA=/.test(userCookie),
    mixinKey: MIXIN_TABLE.map((i) => raw[i]).join('').slice(0, 32),
  };
}

export function signWbi(params: Record<string, string | number>, mixinKey: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const all: Record<string, string | number> = { ...params, wts: nowSec };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

/** 房间号（可能是短号）→ 真实房间号、主播、标题、开播状态 */
export async function getRoom(session: BiliSession, roomId: number): Promise<BiliRoom> {
  const res = await getJson<ApiResponse<{
    room_info?: { room_id: number; uid: number; title?: string; live_status?: number };
    anchor_info?: { base_info?: { uname?: string } };
  }>>(`https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=${roomId}`, session.cookie);
  const info = res.data?.room_info;
  if (res.code === 0 && info) {
    return {
      realRoomId: info.room_id,
      anchorId: String(info.uid),
      anchorName: res.data?.anchor_info?.base_info?.uname,
      title: info.title,
      live: info.live_status === 1,
    };
  }
  // getInfoByRoom 偶尔被风控，退回老接口（没有主播名）
  const old = await getJson<ApiResponse<{ room_id: number; uid: number; title?: string; live_status?: number }>>(
    `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`,
    session.cookie,
  );
  if (old.code !== 0 || !old.data) throw new Error(`直播间 ${roomId} 不存在或无法访问（${old.code} ${old.message ?? ''}）`);
  return {
    realRoomId: old.data.room_id,
    anchorId: String(old.data.uid),
    title: old.data.title,
    live: old.data.live_status === 1,
  };
}

export async function getDanmuInfo(session: BiliSession, realRoomId: number): Promise<{ token: string; servers: DanmuServer[] }> {
  const query = signWbi({ id: realRoomId, type: 0, web_location: '444.8' }, session.mixinKey);
  const res = await getJson<ApiResponse<{ token: string; host_list: DanmuServer[] }>>(
    `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`,
    session.cookie,
  );
  if (res.code !== 0 || !res.data) throw new Error(`获取弹幕服务器失败：${res.code} ${res.message ?? ''}`);
  return { token: res.data.token, servers: res.data.host_list };
}
