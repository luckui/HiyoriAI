/**
 * B 站直播弹幕 WebSocket 的封包格式。
 *
 * 每个包：16 字节头 [总长度(4) | 头长度(2) | 协议版本(2) | 操作码(4) | 序号(4)] + 正文。
 * 操作码：2 心跳、3 心跳回复（旧人气值）、5 服务器消息、7 认证、8 认证回复。
 * 协议版本：0 JSON、1 心跳、2 zlib、3 brotli；压缩包解开后里面还是若干个完整的包。
 */

import zlib from 'zlib';

export const OP = {
  HEARTBEAT: 2,
  HEARTBEAT_REPLY: 3,
  MESSAGE: 5,
  AUTH: 7,
  AUTH_REPLY: 8,
} as const;

const HEADER_LEN = 16;
const PROTO_HEARTBEAT = 1;
const PROTO_ZLIB = 2;
const PROTO_BROTLI = 3;

export interface AuthParams {
  roomId: number;
  /** 登录用户的 uid；匿名为 0 */
  uid: number;
  buvid: string;
  token: string;
}

function packet(op: number, body: Buffer, protoVer: number): Buffer {
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt32BE(HEADER_LEN + body.length, 0);
  header.writeUInt16BE(HEADER_LEN, 4);
  header.writeUInt16BE(protoVer, 6);
  header.writeUInt32BE(op, 8);
  header.writeUInt32BE(1, 12);
  return Buffer.concat([header, body]);
}

export function makeAuthPacket(params: AuthParams): Buffer {
  const body = JSON.stringify({
    uid: params.uid,
    roomid: params.roomId,
    protover: PROTO_BROTLI,
    buvid: params.buvid,
    platform: 'web',
    type: 2,
    key: params.token,
  });
  return packet(OP.AUTH, Buffer.from(body, 'utf8'), PROTO_HEARTBEAT);
}

export function makeHeartbeatPacket(): Buffer {
  return packet(OP.HEARTBEAT, Buffer.alloc(0), PROTO_HEARTBEAT);
}

export type ServerPacket =
  | { op: typeof OP.AUTH_REPLY; ok: boolean; code: unknown }
  | { op: typeof OP.HEARTBEAT_REPLY }
  | { op: typeof OP.MESSAGE; message: Record<string, unknown> };

/** 拆开一帧 WebSocket 数据（可能粘了多个包、可能是压缩包） */
export function readFrame(data: Buffer): ServerPacket[] {
  const out: ServerPacket[] = [];
  split(data, out);
  return out;
}

function split(buf: Buffer, out: ServerPacket[]): void {
  let offset = 0;
  while (offset + HEADER_LEN <= buf.length) {
    const total = buf.readUInt32BE(offset);
    if (total < HEADER_LEN || offset + total > buf.length) break;
    const headerLen = buf.readUInt16BE(offset + 4);
    const protoVer = buf.readUInt16BE(offset + 6);
    const op = buf.readUInt32BE(offset + 8);
    const body = buf.subarray(offset + headerLen, offset + total);
    offset += total;

    if (op === OP.MESSAGE && protoVer === PROTO_BROTLI) {
      split(zlib.brotliDecompressSync(body), out);
    } else if (op === OP.MESSAGE && protoVer === PROTO_ZLIB) {
      split(zlib.inflateSync(body), out);
    } else if (op === OP.MESSAGE) {
      try {
        out.push({ op, message: JSON.parse(body.toString('utf8')) });
      } catch {
        // 个别消息不是合法 JSON，丢弃这一条，不影响同帧其他消息
      }
    } else if (op === OP.AUTH_REPLY) {
      let code: unknown;
      try {
        code = (JSON.parse(body.toString('utf8')) as { code?: unknown }).code;
      } catch {
        code = undefined;
      }
      out.push({ op, ok: code === 0, code });
    } else if (op === OP.HEARTBEAT_REPLY) {
      out.push({ op });
    }
  }
}
