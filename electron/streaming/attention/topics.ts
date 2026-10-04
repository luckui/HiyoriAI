/**
 * 注意力层的输出：一个「现在可以开口说的话题」。说话本身由 LLM 生成，这里只决定说什么、对谁说。
 */

import type {
  LiveChatEvent,
  LiveGiftEvent,
  LiveMembershipEvent,
  LiveSuperChatEvent,
  LiveUser,
} from '../../../shared/types/live';
import type { SegmentBeat } from '../segments/types';

/** 房间热度：决定她能顾得上多少，以及值不值得点名 */
export type RoomHeat = 'quiet' | 'normal' | 'busy';

export interface ChatPick {
  event: LiveChatEvent;
  /** 同一个人连发的几条合在一起 */
  text: string;
  /** 给 LLM 看的标签：问题 / 点名 / 舰长 / 新观众 / 接她的话 … */
  tags: string[];
  score: number;
}

export type TopicBody =
  /** 醒目留言：单独念、单独回 */
  | { kind: 'superchat'; event: LiveSuperChatEvent }
  /** 上舰与大额礼物：逐个点名感谢 */
  | { kind: 'thanks'; events: Array<LiveGiftEvent | LiveMembershipEvent> }
  /** 小礼物：攒一批一起谢；more 是没点名的人数 */
  | { kind: 'gifts'; events: LiveGiftEvent[]; more: number }
  | { kind: 'chat'; picks: ChatPick[] }
  /** 很多人在刷同一句 */
  | { kind: 'trend'; key: string; samples: string[]; users: number }
  | { kind: 'welcome'; users: LiveUser[]; more: number }
  | { kind: 'follow'; users: LiveUser[]; more: number }
  /** 一段时间没人说话：她自己找话说 */
  | { kind: 'idle'; silentMs: number }
  /** 开场动画放完：跟大家打招呼 */
  | { kind: 'opening'; segmentTitle: string; plan?: string[] }
  /** 谢幕：道别，可以提一下本场 */
  | { kind: 'ending'; summary: string }
  /** 环节的一拍：按素材说一件事；recap 是她在这个环节里刚说过的几句，接着往下说 */
  | { kind: 'segment'; segmentId: string; segmentTitle: string; beat: SegmentBeat; recap: string[] }
  /** 主人（搭档）开口跟她说话：interrupted 是她被打断时正在说的那句 */
  | { kind: 'owner'; text: string; interrupted?: string }
  /** 换环节的口播：to 为空表示节目单走完了，接下来自由聊 */
  | { kind: 'transition'; from?: { id: string; title: string }; to?: { id: string; title: string; description: string } };

export type Topic = TopicBody & {
  id: string;
  priority: number;
  heat: RoomHeat;
  createdAt: number;
};

export type TopicKind = Topic['kind'];
