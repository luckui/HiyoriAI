/**
 * 直播平台适配器接口：每个平台一个实现，负责连接、保活、重连，并把协议翻译成统一的 LiveEvent。
 * 新增平台只需实现 LiveSource 并在 platforms/index.ts 的工厂里登记。
 */

import type { LiveConnectionState, LiveEvent, LivePlatform, LiveRoomInfo, LiveRoomStats } from '../../../shared/types/live';

export interface LiveSourceListener {
  event(event: LiveEvent): void;
  stats(stats: Partial<LiveRoomStats>): void;
  room(info: LiveRoomInfo): void;
  state(state: LiveConnectionState, detail?: { loggedIn?: boolean; error?: string }): void;
}

export interface LiveSource {
  readonly platform: LivePlatform;
  start(listener: LiveSourceListener): void;
  stop(): void;
}
