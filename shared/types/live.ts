/**
 * 直播事件的统一格式：各平台适配器把自己的协议翻译成这里的类型，
 * 下游（弹幕姬窗口、AI 互动）只认这一套，不关心来自哪个平台。
 */

export type LivePlatform = 'bilibili';

export interface LiveUser {
  /** 平台内的用户 id；平台隐藏身份时为空串 */
  id: string;
  name: string;
  face?: string;
  /** 平台把名字打了码（如 B 站未登录时的「小***」） */
  masked?: boolean;
  /** 粉丝牌：ofThisRoom 表示是本直播间主播的牌子 */
  medal?: { name: string; level: number; ofThisRoom: boolean };
  /** 大航海等级：1 总督、2 提督、3 舰长；0/缺省为无 */
  guardLevel?: number;
  /** 本房间房管 */
  isAdmin?: boolean;
}

interface LiveEventBase {
  /** 同一条事件的稳定 id：礼物连击合并后仍沿用第一条的 id */
  id: string;
  platform: LivePlatform;
  /** 毫秒时间戳 */
  ts: number;
  user: LiveUser;
}

export interface LiveChatEvent extends LiveEventBase {
  kind: 'chat';
  text: string;
  /** 整条都是表情（表情包弹幕或纯 [表情] 文字） */
  emoteOnly?: boolean;
  /** 表情包弹幕的图片 */
  stickerUrl?: string;
  /** 文字里的小表情：「[大笑]」→ 图片地址 */
  emotes?: Record<string, string>;
}

export interface LiveGiftEvent extends LiveEventBase {
  kind: 'gift';
  giftName: string;
  count: number;
  /** 折合人民币（元）；免费礼物为 0 */
  valueYuan: number;
}

export interface LiveSuperChatEvent extends LiveEventBase {
  kind: 'superchat';
  text: string;
  valueYuan: number;
}

export interface LiveMembershipEvent extends LiveEventBase {
  kind: 'membership';
  /** 平台的会员等级名（舰长 / 提督 / 总督） */
  levelName: string;
  level: number;
  count: number;
  valueYuan: number;
}

/** 进场、关注、分享、点赞：量大、单条价值低，弹幕姬里按计数展示 */
export interface LiveActionEvent extends LiveEventBase {
  kind: 'enter' | 'follow' | 'share' | 'like';
}

export type LiveEvent =
  | LiveChatEvent
  | LiveGiftEvent
  | LiveSuperChatEvent
  | LiveMembershipEvent
  | LiveActionEvent;

export type LiveEventKind = LiveEvent['kind'];

/** 直播间的整体状态，平台推送时更新 */
export interface LiveRoomStats {
  /** 当前在线（B 站为高能榜在线人数） */
  online?: number;
  /** 本场累计看过 */
  watched?: number;
  /** 本场累计点赞 */
  likes?: number;
  /** 正在开播 */
  live?: boolean;
}

export type LiveConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface LiveRoomInfo {
  platform: LivePlatform;
  /** 用户填写的房间号（可能是短号） */
  roomId: number;
  /** 平台的真实房间号 */
  realRoomId?: number;
  title?: string;
  anchorId?: string;
  anchorName?: string;
}

export interface LiveStatus {
  state: LiveConnectionState;
  room?: LiveRoomInfo;
  /** 以登录身份连接；未登录时平台会给部分观众名字打码 */
  loggedIn: boolean;
  stats: LiveRoomStats;
  /** 最近一分钟各类事件的数量 */
  perMinute: Partial<Record<LiveEventKind, number>>;
  connectedAt?: number;
  lastError?: string;
}

/** 推给弹幕姬窗口的增量：同 id 的事件再次出现表示更新（礼物连击累加） */
export interface LiveUpdate {
  events: LiveEvent[];
  status: LiveStatus;
}

export interface LiveConfig {
  platform: LivePlatform;
  roomId: number;
  /** B 站登录 Cookie；不填则匿名连接 */
  cookie: string;
  /** 直播间画面的背景：本地视频或图片的路径；空串用内置动态背景 */
  background: string;
  /** B 站巡逻时用主人的账号点赞 / 留评论（默认都关） */
  patrol?: LivePatrolSettings & { visionProvider?: string };
  /** 控制台「B站研究」里选的研究什么：情报站环节开始、手上又没任务时按它开 */
  research?: ResearchSpecInput;
  /** 直播间公告板（情报站画面左上角；她回观众时也参考它） */
  board?: LiveBoard;
}

/** 情报站的互动开关 */
export interface LivePatrolSettings {
  /** 讲过的视频用主人的账号点赞 */
  like: boolean;
  /** 讲过的视频留评论（每场最多 3 条） */
  comment: boolean;
  /** 观众送任意礼物、再发 BV 号：把这个视频的字幕和分析私信给他 */
  giftDm?: boolean;
}

/** 公告板：第一行是标题，其余一行一条 */
export interface LiveBoard {
  text: string;
  show: boolean;
}

export const DEFAULT_BOARD_TEXT = [
  '📡 B站情报站 · Hiyori 打工中',
  '她在帮主人搜集 B 站视频、转录文案、研究流行文化',
  '💬 随便和她聊天都行，她边干活边回',
  '🎬 点播视频：发 BV 号；短链被吞就发「短码 + 链接末尾那串」',
].join('\n');

/** 开了送礼私信时公告板自动加的一行 */
export const BOARD_GIFT_LINE = '🎁 任意礼物 + BV 号/短码：私信发送视频分析';
export const BOARD_FOLLOW_LINE = '💌 关注 Hiyori：继续收到完整视频字幕';

/** 画面上、提示词里实际用的公告：开了送礼私信就补上那一行 */
export function boardLines(board: LiveBoard | undefined, giftDm: boolean): string[] {
  const lines = (board?.text ?? DEFAULT_BOARD_TEXT).split('\n').map((l) => l.trim()).filter(Boolean);
  if (giftDm && !lines.some((l) => l.includes('礼物'))) lines.push(BOARD_GIFT_LINE);
  if (giftDm && !lines.some((l) => l.includes('完整') && l.includes('字幕'))) lines.push(BOARD_FOLLOW_LINE);
  return lines;
}

/** 连接直播间只需要这几项 */
export type LiveConnection = Pick<LiveConfig, 'platform' | 'roomId' | 'cookie'>;

/** 舞台上放 B 站视频（巡逻环节）的 webview 会话：和主窗口分开，只放 B 站 Cookie */
export const LIVE_PLAYER_PARTITION = 'persist:bili-player';

/** 画面主题：一整套背景场景、配色和弹幕风格 */
export type LiveTheme = 'sakura' | 'starlight' | 'arcade';

export const LIVE_THEMES: Record<LiveTheme, { name: string; icon: string }> = {
  sakura: { name: '樱花午后', icon: '🌸' },
  starlight: { name: '星光演唱会', icon: '✨' },
  arcade: { name: '像素游戏厅', icon: '👾' },
};

/** 节目形式：决定画面布局、默认主题和她聊天的方向 */
export type LiveSegment = 'chat' | 'sing' | 'game' | 'watch';

export const LIVE_SEGMENTS: Record<LiveSegment, { icon: string; title: string; topic: string; theme: LiveTheme }> = {
  chat: { icon: '💬', title: '聊天回', topic: '和观众闲聊', theme: 'sakura' },
  sing: { icon: '🎤', title: '歌回', topic: '歌回：聊音乐、聊想唱的歌', theme: 'starlight' },
  game: { icon: '🎮', title: '游戏回', topic: '游戏回：边玩游戏边和观众聊', theme: 'arcade' },
  watch: { icon: '📡', title: 'B站情报站', topic: 'B站情报站：帮主人收集、转录、分析 B 站视频，边干活边陪大家聊', theme: 'starlight' },
};

/**
 * 直播间画面的阶段：
 *   off 桌宠 → waiting 准备中（待机画面）→ opening 开场动画 → live 直播中 → ending 谢幕
 */
export type LiveStagePhase = 'off' | 'waiting' | 'opening' | 'live' | 'ending';

/** 游戏回采集的窗口 */
export interface LiveCaptureSource {
  id: string;
  name: string;
  /** 缩略图（data URL），只在选择列表里用 */
  thumbnail?: string;
}

/** 直播间画面与 AI 互动的当前状态（主进程持有，广播给所有窗口） */
export interface LiveStageState {
  /** 主窗口正以直播间画面显示（phase 不是 off） */
  on: boolean;
  phase: LiveStagePhase;
  segment: LiveSegment;
  theme: LiveTheme;
  /** 画面上的节目标题，可自定义 */
  title: string;
  background: string;
  /** 游戏回要显示的窗口 */
  capture: LiveCaptureSource | null;
  /** AI 正在自动回应直播间 */
  aiRunning: boolean;
}

/** 一场直播的记录：谢幕时的数据和感谢名单 */
export interface LiveCredits {
  startedAt: number;
  durationMs: number;
  chats: number;
  peakOnline: number;
  /** 发过醒目留言的人 */
  superchats: string[];
  /** 本场上舰的人 */
  members: string[];
  /** 送过礼物的人（按金额排） */
  gifters: string[];
  /** 新关注 */
  followers: string[];
  /** 一起聊天的人（按发言数排） */
  chatters: string[];
}

/** 她正在回应的事件：画面上把对应的弹幕卡片点亮、她看向弹幕栏 */
export interface LiveFocus {
  kind: string;
  eventIds: string[];
}

/** 节目单的一项：跑哪个环节、跑多久 */
export interface LiveRundownItem {
  /** 环节插件 id（见 electron/streaming/segments/registry.ts） */
  segmentId: string;
  minutes: number;
  /** 传给环节的参数，比如话题卡用哪副牌 */
  params?: Record<string, unknown>;
}

/** 控制台能选的环节 */
export interface LiveSegmentInfo {
  id: string;
  title: string;
  description: string;
}

/** 导演的当前状态：控制台显示节目单进度用 */
export interface LiveDirectorState {
  running: boolean;
  /** 环节暂停出拍、也不计时 */
  paused: boolean;
  /** 直播间没开播：排练模式，没人在看也照常演（真开播了才省着来） */
  rehearsal?: boolean;
  /** 为什么暂停：layout 画面切到了别的布局（比如临时切到游戏回），audience 直播间没人在看 */
  pausedFor?: 'layout' | 'audience';
  rundown: LiveRundownItem[];
  /** 正在跑第几项；-1 表示还没开始或已经走完 */
  index: number;
  current?: { segmentId: string; title: string; layout: LiveSegment; elapsedMs: number; plannedMs: number; beats: number };
}

/** 舞台面板：角落里「现在在做：××」的小卡片，加上环节自己的内容（由 renderer 表里按 kind 画） */
export interface StagePanelState {
  segmentId: string;
  /** 「现在在做」后面那几个字 */
  nowDoing: string;
  /** 面板渲染器的键；没有专门内容时只显示小卡片 */
  kind?: string;
  data?: unknown;
}

/** 一场直播的指标汇总（electron/streaming/showMetrics.ts 生成） */
export interface LiveShowSummaryOptions {
  /** 超过这么久没开口算冷场（秒） */
  coldGapSec?: number;
  /** 两句话的字符三元组 Jaccard 超过它算重复 */
  repeatThreshold?: number;
}

export interface LiveShowSummary {
  startedAt: number;
  /** 有人在看的时长（下面的比例都按它算） */
  durationMs: number;
  /** 没人在看的时长 */
  emptyMs: number;
  speeches: number;
  /** 她在说话的时间占比 */
  talkRatio: number;
  /** 超过 coldGapSec 的空隙，加起来占全场的比例 */
  coldRate: number;
  longestGapMs: number;
  /** 和之前任意一句相似度超过阈值的句子占比（只抓得到换汤不换药的原话重复） */
  repeatRate: number;
  /**
   * 后半场的新鲜度：每句话里有多少字符二元组是本场第一次出现，取后半场平均。
   * 她反复绕回同几个话题（手机电量、吃了没）时，原话不同但用词一直是那些，这个值会掉下去
   */
  novelty: number;
  /** 相似度最高的几对，方便人工看是哪种重复 */
  repeatSamples: Array<{ a: string; b: string; similarity: number }>;
  /** 出现在很多句话里的短语（口头禅、固定开头） */
  stockPhrases: Array<{ phrase: string; lines: number }>;
  /** 含口头禅的句子占比 */
  stockRate: number;
  /** 开头前三个字和前 10 句里某一句相同的占比（「新卡：」「所以……」这种套路开头） */
  openingRepeatRate: number;
  byKind: Record<string, number>;
  segments: Array<{ segmentId: string; title: string; ms: number; beats: number }>;
  highlights: Array<{ t: number; why: string }>;
  options: Required<LiveShowSummaryOptions>;
}

/** 研究什么：热门快照 / 某个 UP 主的全部投稿 / 关键词搜索 / 指定视频 */
export interface ResearchSpecInput {
  kind: 'hot' | 'up' | 'search' | 'videos';
  /** UP 主名字或 mid / 关键词 / BV 号（热门不用填） */
  target?: string;
  limit?: number;
  /** 没字幕的要不要本地转写：all 都转，auto 长视频不转；不填按种类默认 */
  transcribe?: 'all' | 'auto';
}

/** 除了热门，其他种类都要填目标 */
export function researchSpecProblem(spec: ResearchSpecInput): string | null {
  if (spec.kind === 'hot' || spec.target?.trim()) return null;
  return { up: '要填 UP 主名字或 mid', search: '要填关键词', videos: '要填 BV 号' }[spec.kind];
}

/** B站研究任务的概况（控制台显示用） */
export interface ResearchJobSummary {
  id: string;
  title: string;
  status: 'preparing' | 'running' | 'done' | 'stopped' | 'failed';
  kind: 'hot' | 'up' | 'search' | 'videos';
  /** 开这个任务时的设置（控制台对比「改了没有」） */
  spec: ResearchSpecInput;
  done: number;
  skipped: number;
  total: number;
  /** 正在处理的视频 */
  working?: string;
  reportFile?: string;
  error?: string;
}

/** 研究过程的一行输出（舞台的终端）；id 相同的行原地更新（进度条） */
export interface ResearchLogLine {
  text: string;
  id?: string;
}
