/** 直播平台适配器工厂：新增平台在这里登记 */

import type { LiveConnection } from '../../../shared/types/live';
import type { LiveSource } from './source';
import { BiliLiveSource } from './bilibili/biliSource';

export type { LiveSource, LiveSourceListener } from './source';

export function createLiveSource(config: LiveConnection): LiveSource {
  switch (config.platform) {
    case 'bilibili':
      return new BiliLiveSource(config.roomId, config.cookie);
    default:
      throw new Error(`不支持的直播平台：${String(config.platform)}`);
  }
}
