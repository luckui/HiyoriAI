/**
 * 直播平台适配器工厂
 * 支持多平台扩展
 */

import { EventEmitter } from 'events';
import type { LiveEvent, StreamerSessionConfig } from '../types';
import { BiliClient } from './bilibili/biliClient';

export interface PlatformAdapter extends EventEmitter {
  start(): Promise<void>;
  stop(): void;
  on(event: 'event', listener: (event: LiveEvent) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'connected' | 'authenticated' | 'disconnected', listener: () => void): this;
}

/**
 * 创建平台适配器
 */
export function createPlatformAdapter(
  config: StreamerSessionConfig,
  cookie?: string
): PlatformAdapter {
  switch (config.platform) {
    case 'bilibili': {
      // 从 Cookie 提取 uid（如果有）
      let uid: number | undefined;
      if (cookie) {
        const match = /DedeUserID=(\d+)/.exec(cookie);
        if (match) {
          uid = parseInt(match[1], 10);
        }
      }

      return new BiliClient({
        roomId: config.roomId,
        uid,
        cookie,
      });
    }

    default:
      throw new Error(`Unsupported platform: ${config.platform}`);
  }
}

