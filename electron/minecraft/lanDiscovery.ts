import dgram from 'node:dgram';
import net from 'node:net';
import type { MinecraftRoom } from './protocol';

const LAN_MULTICAST_ADDRESS = '224.0.2.60';
const LAN_MULTICAST_PORT = 4445;

export interface LanAnnouncement {
  message: string;
  sourceAddress: string;
}

export interface ParsedLanAnnouncement {
  motd: string;
  advertisedHost: string;
  port: number;
}

export interface LanDiscoveryOptions {
  timeoutMs?: number;
  listen?: (timeoutMs: number) => Promise<LanAnnouncement[]>;
  probe?: (host: string, port: number) => Promise<boolean>;
}

export function parseLanAnnouncement(
  message: string,
  sourceAddress: string,
): ParsedLanAnnouncement | null {
  const match = /^\[MOTD\]([\s\S]*?)\[\/MOTD\]\[AD\](\d+)\[\/AD\]$/.exec(
    message.trim(),
  );
  if (!match) return null;

  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return {
    motd: match[1].trim(),
    advertisedHost: sourceAddress,
    port,
  };
}

export async function discoverLanRooms(
  options: LanDiscoveryOptions = {},
): Promise<MinecraftRoom[]> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const listen = options.listen ?? listenForLanAnnouncements;
  const probe = options.probe ?? probeTcpEndpoint;
  const announcements = await listen(timeoutMs);
  const byPort = new Map<number, ParsedLanAnnouncement>();

  for (const announcement of announcements) {
    const parsed = parseLanAnnouncement(
      announcement.message,
      announcement.sourceAddress,
    );
    if (parsed && !byPort.has(parsed.port)) byPort.set(parsed.port, parsed);
  }

  const rooms: MinecraftRoom[] = [];
  for (const parsed of byPort.values()) {
    let host = parsed.advertisedHost;
    if (await probe('127.0.0.1', parsed.port)) {
      host = '127.0.0.1';
    } else if (!(await probe(parsed.advertisedHost, parsed.port))) {
      continue;
    }
    rooms.push({ ...parsed, host });
  }
  return rooms;
}

async function listenForLanAnnouncements(
  timeoutMs: number,
): Promise<LanAnnouncement[]> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const announcements: LanAnnouncement[] = [];
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(announcements);
    };

    const timer = setTimeout(() => finish(), timeoutMs);
    socket.on('error', finish);
    socket.on('message', (buffer, remote) => {
      announcements.push({
        message: buffer.toString('utf8'),
        sourceAddress: remote.address,
      });
    });
    socket.bind(LAN_MULTICAST_PORT, () => {
      try {
        socket.addMembership(LAN_MULTICAST_ADDRESS);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function probeTcpEndpoint(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(600);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

