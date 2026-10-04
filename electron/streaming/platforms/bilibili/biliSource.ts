/**
 * B 站直播弹幕连接：取房间与 token → 连 WebSocket → 认证 → 30 秒心跳。
 *
 * 保活：任何数据（含心跳回复）超过 70 秒没到就认为连接已死，主动断开重连；
 * 重连每次都重新取 token 和服务器列表，退避 1s → 2s → … → 30s，连上后归零。
 */

import WebSocket from 'ws';
import type { LiveRoomInfo } from '../../../../shared/types/live';
import type { LiveSource, LiveSourceListener } from '../source';
import { createBiliSession, getDanmuInfo, getRoom, type DanmuServer } from './biliApi';
import { decodeBiliMessage, type BiliRoomContext } from './biliDecode';
import { makeAuthPacket, makeHeartbeatPacket, OP, readFrame } from './biliProtocol';

const HEARTBEAT_MS = 30_000;
const SILENCE_LIMIT_MS = 70_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

/** API 给的服务器都连不上时的兜底 */
const FALLBACK_SERVER: DanmuServer = { host: 'broadcastlv.chat.bilibili.com', wss_port: 443 };

export class BiliLiveSource implements LiveSource {
  readonly platform = 'bilibili' as const;
  private listener: LiveSourceListener | null = null;
  private ws: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private backoffMs = 1000;
  private lastDataAt = 0;
  private stopped = true;

  constructor(private readonly roomId: number, private readonly cookie: string) {}

  start(listener: LiveSourceListener): void {
    this.listener = listener;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.closeSocket();
    this.listener?.state('idle');
    this.listener = null;
  }

  private async connect(): Promise<void> {
    const listener = this.listener;
    if (this.stopped || !listener) return;
    listener.state(this.backoffMs > 1000 ? 'reconnecting' : 'connecting');
    try {
      const session = await createBiliSession(this.cookie);
      const room = await getRoom(session, this.roomId);
      const { token, servers } = await getDanmuInfo(session, room.realRoomId);
      if (this.stopped) return;

      const info: LiveRoomInfo = {
        platform: 'bilibili',
        roomId: this.roomId,
        realRoomId: room.realRoomId,
        title: room.title,
        anchorId: room.anchorId,
        anchorName: room.anchorName,
      };
      listener.room(info);
      listener.stats({ live: room.live });

      const ctx: BiliRoomContext = { realRoomId: room.realRoomId, anchorId: room.anchorId };
      const auth = makeAuthPacket({ roomId: room.realRoomId, uid: session.uid, buvid: session.buvid, token });
      let lastError: Error | null = null;
      for (const server of [...servers, FALLBACK_SERVER]) {
        if (this.stopped) return;
        try {
          await this.open(`wss://${server.host}:${server.wss_port}/sub`, auth, ctx);
          this.backoffMs = 1000;
          listener.state('connected', {
            loggedIn: session.loggedIn,
            error: session.cookieRejected ? 'Cookie 已失效，按未登录连接（观众名字会被打码）' : undefined,
          });
          return;
        } catch (err) {
          lastError = err as Error;
          console.warn(`[BiliLive] ${server.host} 连接失败：${lastError.message}`);
        }
      }
      throw lastError ?? new Error('没有可用的弹幕服务器');
    } catch (err) {
      this.scheduleRetry((err as Error).message);
    }
  }

  /** 连上并认证成功才 resolve；认证前的任何失败都 reject，交给上层换下一台服务器 */
  private open(url: string, auth: Buffer, ctx: BiliRoomContext): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { 'User-Agent': 'Mozilla/5.0', Origin: 'https://live.bilibili.com' } });
      let authed = false;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('连接或认证超时'));
      }, CONNECT_TIMEOUT_MS);

      ws.on('open', () => ws.send(auth));
      ws.on('message', (data: Buffer) => {
        this.lastDataAt = Date.now();
        let packets;
        try {
          packets = readFrame(data);
        } catch (err) {
          console.warn('[BiliLive] 解包失败：', (err as Error).message);
          return;
        }
        for (const p of packets) {
          if (p.op === OP.AUTH_REPLY) {
            clearTimeout(timer);
            if (!p.ok) {
              ws.terminate();
              reject(new Error(`认证被拒绝（code=${String(p.code)}）`));
              return;
            }
            authed = true;
            this.ws = ws;
            this.startKeepAlive();
            resolve();
          } else if (p.op === OP.MESSAGE) {
            this.dispatch(p.message, ctx);
          }
        }
      });
      ws.on('error', (err) => {
        if (!authed) {
          clearTimeout(timer);
          reject(err);
        }
      });
      ws.on('close', (code) => {
        clearTimeout(timer);
        if (!authed) {
          reject(new Error(`认证前连接关闭（${code}）`));
        } else if (this.ws === ws) {
          this.ws = null;
          this.stopKeepAlive();
          this.scheduleRetry(`连接断开（${code}）`);
        }
      });
    });
  }

  private dispatch(message: Record<string, unknown>, ctx: BiliRoomContext): void {
    const listener = this.listener;
    if (!listener) return;
    let outputs;
    try {
      outputs = decodeBiliMessage(message, ctx);
    } catch (err) {
      console.warn(`[BiliLive] 解析 ${String(message.cmd)} 失败：`, (err as Error).message);
      return;
    }
    for (const out of outputs) {
      if (out.type === 'event') listener.event(out.event);
      else if (out.type === 'stats') listener.stats(out.stats);
      else listener.room({ platform: 'bilibili', roomId: this.roomId, realRoomId: ctx.realRoomId, anchorId: ctx.anchorId, title: out.title });
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.lastDataAt = Date.now();
    const beat = () => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(makeHeartbeatPacket());
    };
    beat();
    this.heartbeat = setInterval(beat, HEARTBEAT_MS);
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastDataAt > SILENCE_LIMIT_MS) {
        console.warn('[BiliLive] 70 秒没有收到任何数据，重连');
        this.ws?.terminate(); // 触发 close → scheduleRetry
      }
    }, 10_000);
  }

  private stopKeepAlive(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.watchdog) clearInterval(this.watchdog);
    this.heartbeat = null;
    this.watchdog = null;
  }

  private closeSocket(): void {
    this.stopKeepAlive();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
    }
  }

  private scheduleRetry(reason: string): void {
    this.closeSocket();
    if (this.stopped) return;
    console.warn(`[BiliLive] ${reason}，${this.backoffMs / 1000}s 后重连`);
    this.listener?.state('reconnecting', { error: reason });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }
}
