/**
 * B 站弹幕服务器消息（cmd）→ 统一直播事件。
 *
 * 字段含义来自 2026-10 实录（大房间约 2300 在线、小房间个位数在线各录 4 分钟）：
 * - 弹幕 DANMU_MSG 仍是 JSON；进场改为 INTERACT_WORD_V2、礼物改为 SEND_GIFT_V2，正文是 protobuf。
 *   旧的 INTERACT_WORD / SEND_GIFT 也还认，平台随时可能切回来。
 * - 金额：金瓜子 1000 = 1 元；醒目留言 price 本身就是元。
 * - SUPER_CHAT_MESSAGE_JPN、USER_TOAST_MSG 等是同一事件的重复通知，不再解析。
 */

import type { LiveEvent, LiveRoomStats, LiveUser } from '../../../../shared/types/live';
import { pbChild, pbId, pbNumber, pbString, readPb, type PbMessage } from './protobuf';

export interface BiliRoomContext {
  realRoomId: number;
  /** 主播 uid，用来判断观众的粉丝牌是不是本房间的 */
  anchorId: string;
}

export type BiliOutput =
  | { type: 'event'; event: LiveEvent }
  | { type: 'stats'; stats: Partial<LiveRoomStats> }
  | { type: 'title'; title: string };

const GUARD_NAMES: Record<number, string> = { 1: '总督', 2: '提督', 3: '舰长' };

/** INTERACT_WORD 的 msg_type */
const INTERACT_KINDS: Record<number, 'enter' | 'follow' | 'share'> = {
  1: 'enter',
  2: 'follow',
  3: 'share',
  4: 'follow', // 特别关注
  5: 'follow', // 互相关注
};

type Json = Record<string, any>;

let seq = 0;
const nextId = (prefix: string) => `bili:${prefix}:${Date.now().toString(36)}${(++seq).toString(36)}`;

function isMasked(id: string, name: string): boolean {
  return !id || name.includes('***');
}

function medalOf(
  ctx: BiliRoomContext,
  name: string | undefined,
  level: number,
  ownerId: string,
): LiveUser['medal'] {
  if (!name || !level) return undefined;
  return { name, level, ofThisRoom: ownerId === ctx.anchorId };
}

function makeUser(ctx: BiliRoomContext, fields: {
  id: unknown;
  name: unknown;
  face?: unknown;
  medalName?: string;
  medalLevel?: number;
  medalOwner?: unknown;
  guardLevel?: number;
  isAdmin?: boolean;
}): LiveUser {
  const id = fields.id && String(fields.id) !== '0' ? String(fields.id) : '';
  const name = String(fields.name ?? '');
  const user: LiveUser = { id, name };
  if (typeof fields.face === 'string' && fields.face) user.face = fields.face;
  if (isMasked(id, name)) user.masked = true;
  const medal = medalOf(ctx, fields.medalName, fields.medalLevel ?? 0, String(fields.medalOwner ?? ''));
  if (medal) user.medal = medal;
  if (fields.guardLevel) user.guardLevel = fields.guardLevel;
  if (fields.isAdmin) user.isAdmin = true;
  return user;
}

/** pb 里的 uinfo：{1 uid, 2 base{1 name, 2 face}, 3 medal{1 name, 2 level, 10 主播 uid, 11 大航海}} */
function pbUser(ctx: BiliRoomContext, uinfo: PbMessage | undefined, fallback: { id: string; name: string }): LiveUser {
  const base = pbChild(uinfo, 2);
  const medal = pbChild(uinfo, 3);
  return makeUser(ctx, {
    id: pbId(uinfo, 1) || fallback.id,
    name: pbString(base, 1) || fallback.name,
    face: pbString(base, 2),
    medalName: pbString(medal, 1),
    medalLevel: pbNumber(medal, 2),
    medalOwner: pbId(medal, 10),
    guardLevel: pbNumber(medal, 11),
  });
}

function decodePb(data: Json | undefined): PbMessage | undefined {
  if (typeof data?.pb !== 'string') return undefined;
  try {
    return readPb(Buffer.from(data.pb, 'base64'));
  } catch {
    return undefined;
  }
}

function isEmoteOnly(text: string): boolean {
  return /^(\s*\[[^\]\s]{1,12}\])+\s*$/.test(text);
}

function chat(msg: Json, ctx: BiliRoomContext, now: number): LiveEvent | null {
  const info = msg.info;
  if (!Array.isArray(info) || !Array.isArray(info[0]) || !Array.isArray(info[2])) return null;
  const meta = info[0];
  const extra = (() => {
    try {
      return typeof meta[15]?.extra === 'string' ? JSON.parse(meta[15].extra) as Json : {};
    } catch {
      return {};
    }
  })();
  const structured: Json | undefined = meta[15]?.user;
  const medalArr: unknown[] = Array.isArray(info[3]) ? info[3] : [];
  const text = String(info[1] ?? '');
  const sticker = meta[12] === 1 && typeof meta[13]?.url === 'string' ? (meta[13].url as string).replace(/^http:/, 'https:') : undefined;
  const emotes: Record<string, string> = {};
  for (const [token, emo] of Object.entries((extra.emots ?? {}) as Record<string, { url?: string }>)) {
    if (typeof emo?.url === 'string') emotes[token] = emo.url.replace(/^http:/, 'https:');
  }
  const user = makeUser(ctx, {
    id: info[2][0],
    name: structured?.base?.name ?? info[2][1],
    face: structured?.base?.face,
    medalName: structured?.medal?.name ?? (medalArr[1] as string | undefined),
    medalLevel: Number(structured?.medal?.level ?? medalArr[0] ?? 0),
    medalOwner: structured?.medal?.ruid ?? medalArr[12],
    guardLevel: Number(info[7] ?? 0),
    isAdmin: info[2][2] === 1,
  });
  return {
    id: `bili:dm:${extra.id_str || `${user.id}:${meta[4]}:${text}`}`,
    platform: 'bilibili',
    kind: 'chat',
    ts: typeof meta[4] === 'number' ? meta[4] : now,
    user,
    text,
    ...(meta[12] === 1 || isEmoteOnly(text) ? { emoteOnly: true } : {}),
    ...(sticker ? { stickerUrl: sticker } : {}),
    ...(Object.keys(emotes).length ? { emotes } : {}),
  };
}

function giftValueYuan(coinType: string, totalCoin: number): number {
  return coinType === 'gold' ? totalCoin / 1000 : 0;
}

/**
 * SEND_GIFT_V2：{1 uid, 2 uname, 3 face, 10 gift{2 名称, 3 数量, 5 单价, 6 总价, 8 币种, 9 tid, 12 连击 id}, 15 uinfo}
 * 同一次连击的多条消息共用连击 id，弹幕姬据此把它们合并成一条。
 */
function giftV2(msg: Json, ctx: BiliRoomContext, now: number): LiveEvent | null {
  const pb = decodePb(msg.data);
  const gift = pbChild(pb, 10);
  if (!pb || !gift) return null;
  const count = pbNumber(gift, 3) || 1;
  const total = pbNumber(gift, 6) || pbNumber(gift, 5) * count;
  const combo = pbString(gift, 12) || pbId(gift, 9);
  return {
    id: combo ? `bili:gift:${combo}` : nextId('gift'),
    platform: 'bilibili',
    kind: 'gift',
    ts: now,
    user: pbUser(ctx, pbChild(pb, 15), { id: pbId(pb, 1), name: pbString(pb, 2) }),
    giftName: pbString(gift, 2),
    count,
    valueYuan: giftValueYuan(pbString(gift, 8), total),
  };
}

function giftV1(msg: Json, ctx: BiliRoomContext, now: number): LiveEvent | null {
  const d = msg.data;
  if (!d) return null;
  const count = Number(d.num ?? 1);
  const combo = d.batch_combo_id || d.tid;
  return {
    id: combo ? `bili:gift:${combo}` : nextId('gift'),
    platform: 'bilibili',
    kind: 'gift',
    ts: now,
    user: makeUser(ctx, {
      id: d.uid,
      name: d.uname,
      face: d.face,
      medalName: d.medal_info?.medal_name,
      medalLevel: Number(d.medal_info?.medal_level ?? 0),
      medalOwner: d.medal_info?.target_id,
      guardLevel: Number(d.guard_level ?? 0),
    }),
    giftName: String(d.giftName ?? ''),
    count,
    valueYuan: giftValueYuan(String(d.coin_type ?? ''), Number(d.total_coin ?? Number(d.price ?? 0) * count)),
  };
}

/** INTERACT_WORD_V2：{1 uid, 2 uname, 5 类型, 9 粉丝牌{1 主播 uid, 2 等级, 3 名称}, 22 uinfo} */
function interactV2(msg: Json, ctx: BiliRoomContext, now: number): LiveEvent | null {
  const pb = decodePb(msg.data);
  if (!pb) return null;
  const kind = INTERACT_KINDS[pbNumber(pb, 5)];
  if (!kind) return null;
  const user = pbUser(ctx, pbChild(pb, 22), { id: pbId(pb, 1), name: pbString(pb, 2) });
  if (!user.medal) {
    const medal = pbChild(pb, 9);
    const fallback = medalOf(ctx, pbString(medal, 3), pbNumber(medal, 2), pbId(medal, 1));
    if (fallback) user.medal = fallback;
  }
  return { id: nextId(kind), platform: 'bilibili', kind, ts: now, user };
}

function interactV1(msg: Json, ctx: BiliRoomContext, now: number): LiveEvent | null {
  const d = msg.data;
  const kind = INTERACT_KINDS[Number(d?.msg_type)];
  if (!kind) return null;
  return {
    id: nextId(kind),
    platform: 'bilibili',
    kind,
    ts: now,
    user: makeUser(ctx, {
      id: d.uid,
      name: d.uname,
      medalName: d.fans_medal?.medal_name,
      medalLevel: Number(d.fans_medal?.medal_level ?? 0),
      medalOwner: d.fans_medal?.target_id,
      guardLevel: Number(d.fans_medal?.guard_level ?? 0),
    }),
  };
}

export function decodeBiliMessage(msg: Json, ctx: BiliRoomContext, now = Date.now()): BiliOutput[] {
  const cmd = String(msg.cmd ?? '');
  const event = (e: LiveEvent | null): BiliOutput[] => (e ? [{ type: 'event', event: e }] : []);
  const d: Json | undefined = msg.data;

  // 部分房间的弹幕 cmd 带后缀，如 DANMU_MSG:4:0:2:2:2:0
  if (cmd === 'DANMU_MSG' || cmd.startsWith('DANMU_MSG:')) return event(chat(msg, ctx, now));

  switch (cmd) {
    case 'SEND_GIFT_V2': return event(giftV2(msg, ctx, now));
    case 'SEND_GIFT': return event(giftV1(msg, ctx, now));
    case 'INTERACT_WORD_V2': return event(interactV2(msg, ctx, now));
    case 'INTERACT_WORD': return event(interactV1(msg, ctx, now));

    case 'SUPER_CHAT_MESSAGE':
      if (!d) return [];
      return event({
        id: `bili:sc:${d.id}`,
        platform: 'bilibili',
        kind: 'superchat',
        ts: Number(d.start_time) ? Number(d.start_time) * 1000 : now,
        user: makeUser(ctx, {
          id: d.uid,
          name: d.user_info?.uname,
          face: d.user_info?.face,
          medalName: d.medal_info?.medal_name,
          medalLevel: Number(d.medal_info?.medal_level ?? 0),
          medalOwner: d.medal_info?.target_id,
          guardLevel: Number(d.user_info?.guard_level ?? d.medal_info?.guard_level ?? 0),
        }),
        text: String(d.message ?? ''),
        valueYuan: Number(d.price ?? 0),
      });

    case 'GUARD_BUY': {
      if (!d) return [];
      const level = Number(d.guard_level ?? 0);
      return event({
        id: `bili:guard:${d.uid}:${d.start_time}`,
        platform: 'bilibili',
        kind: 'membership',
        ts: now,
        user: makeUser(ctx, { id: d.uid, name: d.username, guardLevel: level }),
        level,
        levelName: String(d.gift_name ?? GUARD_NAMES[level] ?? '大航海'),
        count: Number(d.num ?? 1),
        valueYuan: Number(d.price ?? 0) / 1000,
      });
    }

    case 'LIKE_INFO_V3_CLICK':
      if (!d) return [];
      return event({
        id: nextId('like'),
        platform: 'bilibili',
        kind: 'like',
        ts: now,
        user: makeUser(ctx, {
          id: d.uid,
          name: d.uname,
          medalName: d.fans_medal?.medal_name,
          medalLevel: Number(d.fans_medal?.medal_level ?? 0),
          medalOwner: d.fans_medal?.target_id,
          guardLevel: Number(d.fans_medal?.guard_level ?? 0),
        }),
      });

    case 'ONLINE_RANK_COUNT': {
      const online = Number(d?.online_count ?? d?.count);
      return Number.isFinite(online) ? [{ type: 'stats', stats: { online } }] : [];
    }
    case 'WATCHED_CHANGE': {
      const watched = Number(d?.num);
      return Number.isFinite(watched) ? [{ type: 'stats', stats: { watched } }] : [];
    }
    case 'LIKE_INFO_V3_UPDATE': {
      const likes = Number(d?.click_count);
      return Number.isFinite(likes) ? [{ type: 'stats', stats: { likes } }] : [];
    }
    case 'LIVE':
      return [{ type: 'stats', stats: { live: true } }];
    case 'PREPARING':
    case 'ROUND':
      return [{ type: 'stats', stats: { live: false } }];
    case 'ROOM_CHANGE':
      return typeof d?.title === 'string' ? [{ type: 'title', title: d.title }] : [];
    default:
      return [];
  }
}
