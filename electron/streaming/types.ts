import type { LiveChatEvent, LivePlatform, LiveStatus } from '../../shared/types/live';
import type { AttentionSnapshot } from './attention/attention';
import type { TopicKind } from './attention/topics';

/** 清洗后的弹幕：只有这种形态会进入 AI 的提示词 */
export interface SanitizedChat {
  id: string;
  ts: number;
  uid: string;
  uname: string;
  text: string;
  fingerprint: string;
  riskFlags: string[];
  source: LiveChatEvent;
}

export interface StreamerSessionConfig {
  platform: LivePlatform;
  roomId: number;
  topic?: string;
  conversationId?: string;
  autoReply?: boolean;
}

/** 她在直播里说过的一句话，以及为什么说 */
export interface StreamerReply {
  id: string;
  createdAt: number;
  kind: TopicKind;
  prompt: string;
  reply?: string;
}

export interface StreamerStatus {
  running: boolean;
  platform?: LivePlatform;
  roomId?: number;
  topic?: string;
  startedAt?: number;
  autoReply?: boolean;
  live: LiveStatus;
  attention?: AttentionSnapshot;
  replies: number;
  lastError?: string;
}
