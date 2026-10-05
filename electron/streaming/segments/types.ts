/**
 * 直播环节插件：一个环节就是一个「素材源」，在她空闲、又没有更要紧的弹幕时，给她下一件可说的事（一拍）。
 *
 * 语义约定：
 *   - 导演（director.ts）按节目单启停环节；同一时间只有一个环节在跑。
 *   - nextBeat 是「问一下有没有」：导演可能问了却没用上（被弹幕抢先），所以同一拍会再问一次，
 *     插件要在 onSpoken 里才把这拍算作用掉。没有素材时返回 null，她就照常回弹幕或冷场找话。
 *   - 说什么由插件定（instruction + material），怎么说由 LLM 定；话题从注意力层统一出去，
 *     发言只有 streamerController 一个出口。
 *   - onChat 只在环节关心的弹幕上返回 true（作答、点视频），这条就不再进普通聊天打分。
 *   - 插件不碰时钟，时间都从参数传进来，方便虚拟时钟模拟。
 */

import type { LiveChatEvent, LiveSegment, StagePanelState } from '../../../shared/types/live';
import type { RoomHeat } from '../attention/topics';

export interface SegmentBeat {
  /** 这一拍要她做什么：介绍这个视频 / 读这封信 / 公布答案 … */
  instruction: string;
  /** 这一拍的素材（结构化，已截断到合理长度） */
  material: Record<string, unknown>;
  /** 期望说多长：short 约 40 字，normal 约 90 字 */
  length?: 'short' | 'normal';
}

/** 插件自己的小存储（跨场次）：用过的话题卡、看过的视频 … 存在 userData/live-segments/<id>.json */
export interface SegmentStorage {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

export interface SegmentContext {
  params: Record<string, unknown>;
  storage: SegmentStorage;
  /** 环节开始的时间 */
  startedAt: number;
  /** 本环节已经说了几拍 */
  beats: number;
  heat: RoomHeat;
  /** 素材在后台准备好了（档案查完、点播排上）：让舞台面板刷新一下 */
  changed(): void;
}

export interface LiveSegmentPlugin {
  id: string;
  title: string;
  /** 环节用哪套画面布局 */
  layout: LiveSegment;
  /** 准备素材；要联网的返回 Promise，准备好之前不出拍 */
  start(ctx: SegmentContext, now: number): Promise<void> | void;
  nextBeat(ctx: SegmentContext, now: number): SegmentBeat | null;
  /** 这一拍她说完了（text 是她实际说的话） */
  onSpoken?(beat: SegmentBeat, text: string, ctx: SegmentContext, now: number): void;
  onChat?(event: LiveChatEvent, ctx: SegmentContext, now: number): boolean;
  panel?(): Omit<StagePanelState, 'segmentId'> | null;
  /** 她手上正在做什么（一句话，回观众时参考，比如「在讲第 3 个视频《xx》」） */
  activity?(): string | null;
  /** 环节觉得可以结束了，比如素材用完 */
  isDone?(ctx: SegmentContext, now: number): boolean;
  stop(): Promise<void>;
}

export interface SegmentDefinition {
  id: string;
  title: string;
  description: string;
  create(): LiveSegmentPlugin;
}
