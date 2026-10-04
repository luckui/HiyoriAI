/**
 * 环节注册表：新环节写一个插件文件，在 SEGMENTS 里加一行。
 */

import fs from 'fs';
import path from 'path';
import type { LiveSegmentInfo } from '../../../shared/types/live';
import { topicCardsSegment } from './topicCards';
import type { LiveSegmentPlugin, SegmentDefinition, SegmentStorage } from './types';

/** 自由聊天：不出拍，专心回弹幕，没人说话时她自己找话（就是没有环节时的老样子） */
class FreeChatSegment implements LiveSegmentPlugin {
  readonly id = 'free-chat';
  readonly title = '自由聊天';
  readonly layout = 'chat' as const;
  start(): void {}
  nextBeat(): null {
    return null;
  }
  async stop(): Promise<void> {}
}

const SEGMENTS: SegmentDefinition[] = [
  topicCardsSegment,
  { id: 'free-chat', title: '自由聊天', description: '不安排内容，专心回弹幕', create: () => new FreeChatSegment() },
];

export const segmentRegistry = new Map(SEGMENTS.map((s) => [s.id, s]));

export function listSegments(): LiveSegmentInfo[] {
  return SEGMENTS.map(({ id, title, description }) => ({ id, title, description }));
}

/** 每个环节一个 JSON 文件；读写失败只打日志，不影响直播 */
export function jsonSegmentStorage(dir: string, segmentId: string): SegmentStorage {
  const file = path.join(dir, `${segmentId}.json`);
  let cache: Record<string, unknown> | null = null;
  const load = (): Record<string, unknown> => {
    if (cache) return cache;
    try {
      cache = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    } catch (err) {
      console.warn(`[Segments] 读取 ${file} 失败:`, (err as Error).message);
      cache = {};
    }
    return cache!;
  };
  return {
    get: <T>(key: string, fallback: T) => (key in load() ? load()[key] as T : fallback),
    set: (key, value) => {
      const data = load();
      data[key] = value;
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data), 'utf8');
      } catch (err) {
        console.warn(`[Segments] 写入 ${file} 失败:`, (err as Error).message);
      }
    },
  };
}

/** 内存版（模拟、测试用） */
export function memorySegmentStorage(): SegmentStorage {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback: T) => (data.has(key) ? data.get(key) as T : fallback),
    set: (key, value) => { data.set(key, value); },
  };
}
