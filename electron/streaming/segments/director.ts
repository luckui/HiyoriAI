/**
 * 导演：按节目单一个个跑环节，在她空闲时把当前环节的下一拍交给注意力层（实现 BeatSource）。
 *
 *   - 每项按时长或环节自己说「素材用完了」（isDone）结束；结束时先出一个 transition 话题让她口播过渡，
 *     说出口的那一刻才真正换环节。
 *   - 画面临时切到别的布局（主播手动切游戏回）时暂停：不出拍、不计时，切回来接着跑。
 *   - 节目单走完后不再出拍，她回到「回弹幕、冷场找话」的老样子。
 *
 * 不碰时钟：所有方法都接收 now，模拟直播时可以用虚拟时间。
 */

import type { LiveChatEvent, LiveDirectorState, LiveRundownItem, LiveSegment, StagePanelState } from '../../../shared/types/live';
import type { BeatSource } from '../attention/attention';
import type { RoomHeat, TopicBody } from '../attention/topics';
import type { LiveSegmentPlugin, SegmentBeat, SegmentContext, SegmentDefinition, SegmentStorage } from './types';

/** 每个环节记住她最近在这里说的几句，下一拍接着往下说 */
const RECAP_LINES = 3;

export interface DirectorHooks {
  /** 环节开始 / 结束（记指标、换画面布局） */
  onSegment?(action: 'start' | 'stop', info: { segmentId: string; title: string; layout: LiveSegment }, now: number): void;
  /** 直播间有没有人在看变了（记指标：没人的时间不算冷场） */
  onAudience?(present: boolean, now: number): void;
  /** 状态或面板变了 */
  onChange?(): void;
  storage(segmentId: string): SegmentStorage;
}

interface Running {
  item: LiveRundownItem;
  def: SegmentDefinition;
  plugin: LiveSegmentPlugin;
  ctx: SegmentContext;
  /** 不算暂停的已进行时长 */
  elapsedMs: number;
  /** 上次计时的时刻 */
  tickedAt: number;
  plannedMs: number;
  ready: boolean;
  /** peek 到但还没说的一拍 */
  pending: SegmentBeat | null;
  /** 已交给她、还没说完的一拍 */
  speaking: SegmentBeat | null;
  recap: string[];
}

export class SegmentDirector implements BeatSource {
  private rundown: LiveRundownItem[] = [];
  private index = -1;
  private current: Running | null = null;
  private running = false;
  /** 舞台现在的布局（null：还不知道，当作和环节一致） */
  private stageLayout: LiveSegment | null = null;
  /** 直播间没人在看 */
  private empty = false;
  /** 当前环节该结束了，过渡口播还没说 */
  private transitionDue = false;

  constructor(
    private readonly registry: Map<string, SegmentDefinition>,
    private readonly hooks: DirectorHooks,
  ) {}

  // ── 节目单 ───────────────────────────────────────────

  setRundown(items: LiveRundownItem[]): void {
    this.rundown = items.filter((i) => this.registry.has(i.segmentId) && i.minutes > 0).map((i) => ({ ...i }));
    this.hooks.onChange?.();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 开播（阶段进入 live）：从第一项开始 */
  start(now: number): void {
    if (this.running) return;
    this.running = true;
    this.index = -1;
    this.advance(now);
  }

  /** 下播：停掉当前环节 */
  stop(now: number): void {
    if (!this.running) return;
    this.running = false;
    this.stopCurrent(now);
    this.index = -1;
    this.transitionDue = false;
    this.hooks.onChange?.();
  }

  /** 暂停时不出拍、不计时 */
  private get paused(): boolean {
    const cur = this.current;
    return !!cur && (this.empty || (this.stageLayout !== null && cur.plugin.layout !== this.stageLayout));
  }

  /** 换暂停条件：先把暂停前的时间算进去 */
  private repause(now: number, change: () => void): void {
    const before = this.paused;
    if (this.current) this.tick(now);
    change();
    if (this.current) this.current.tickedAt = now;
    if (before !== this.paused) this.hooks.onChange?.();
  }

  /** 画面切到了别的布局：暂停；切回环节的布局就继续 */
  setLayout(layout: LiveSegment, now: number): void {
    this.repause(now, () => { this.stageLayout = layout; });
  }

  /** 直播间没人在看：暂停（素材留给有人的时候） */
  setAudience(present: boolean, now: number): void {
    if (this.empty === !present) return;
    this.repause(now, () => { this.empty = !present; });
    this.hooks.onAudience?.(present, now);
  }

  /** 控制台「下一环节」：说一句过渡就换 */
  next(): void {
    if (this.running && this.current) this.transitionDue = true;
    this.hooks.onChange?.();
  }

  /** 控制台「延长」 */
  extend(minutes: number): void {
    if (this.current) this.current.plannedMs += minutes * 60_000;
    this.hooks.onChange?.();
  }

  /** 控制台「跳过下一个」：把排在后面的第一项拿掉 */
  skipUpcoming(): void {
    if (this.index + 1 < this.rundown.length) this.rundown.splice(this.index + 1, 1);
    this.hooks.onChange?.();
  }

  // ── 给注意力层 ───────────────────────────────────────

  peek(now: number, heat: RoomHeat): 'segment' | 'transition' | null {
    const cur = this.live(now);
    if (!cur) return null;
    if (this.due(cur, now)) return 'transition';
    if (!cur.ready || cur.speaking) return null;
    cur.ctx.heat = heat;
    cur.pending ??= cur.plugin.nextBeat(cur.ctx, now);
    return cur.pending ? 'segment' : null;
  }

  take(now: number, heat: RoomHeat): TopicBody | null {
    const kind = this.peek(now, heat);
    const cur = this.current;
    if (!kind || !cur) return null;
    if (kind === 'transition') {
      const from = { id: cur.def.id, title: cur.def.title };
      // 说出过渡的这一刻就换：后面的拍都是新环节的
      this.transitionDue = false;
      const nextDef = this.advance(now);
      const to = nextDef ? { id: nextDef.id, title: nextDef.title, description: nextDef.description } : undefined;
      return { kind: 'transition', from, to };
    }
    const beat = cur.pending!;
    cur.pending = null;
    cur.speaking = beat;
    return { kind: 'segment', segmentId: cur.def.id, segmentTitle: cur.def.title, beat, recap: [...cur.recap] };
  }

  /** 她把这拍说完了（或没说出来：text 为空） */
  spoken(topic: TopicBody, text: string, now: number): void {
    if (topic.kind !== 'segment') return;
    const cur = this.current;
    if (!cur || cur.def.id !== topic.segmentId || cur.speaking !== topic.beat) return;
    cur.speaking = null;
    if (!text) return;
    cur.ctx.beats += 1;
    cur.recap = [...cur.recap, text].slice(-RECAP_LINES);
    cur.plugin.onSpoken?.(topic.beat, text, cur.ctx, now);
    this.hooks.onChange?.();
  }

  /** 弹幕先给环节看；环节消费了（作答、点播）就不再当普通聊天 */
  onChat(event: LiveChatEvent, now: number): boolean {
    const cur = this.live(now);
    if (!cur?.ready || !cur.plugin.onChat) return false;
    const used = cur.plugin.onChat(event, cur.ctx, now);
    if (used) {
      cur.pending = null; // 素材可能变了（插队的视频、换了的话题卡）
      this.hooks.onChange?.();
    }
    return used;
  }

  // ── 给控制台和舞台 ───────────────────────────────────

  state(now: number): LiveDirectorState {
    const cur = this.current;
    if (cur) this.tick(now);
    return {
      running: this.running,
      paused: this.paused,
      pausedFor: !this.paused ? undefined : this.empty ? 'audience' : 'layout',
      rundown: this.rundown.map((i) => ({ ...i })),
      index: this.index,
      current: cur
        ? { segmentId: cur.def.id, title: cur.def.title, elapsedMs: cur.elapsedMs, plannedMs: cur.plannedMs, beats: cur.ctx.beats }
        : undefined,
    };
  }

  panel(): StagePanelState | null {
    const cur = this.current;
    if (!this.running || !cur) return null;
    const own = cur.ready ? cur.plugin.panel?.() : null;
    return { segmentId: cur.def.id, nowDoing: cur.def.title, ...own };
  }

  // ── 内部 ─────────────────────────────────────────────

  /** 正在跑、没暂停的当前环节 */
  private live(now: number): Running | null {
    if (!this.running || this.paused || !this.current) return null;
    this.tick(now);
    return this.current;
  }

  private tick(now: number): void {
    const cur = this.current!;
    if (!this.paused) cur.elapsedMs += Math.max(0, now - cur.tickedAt);
    cur.tickedAt = now;
  }

  private due(cur: Running, now: number): boolean {
    if (this.transitionDue) return true;
    if (!cur.ready) return false;
    // 正在说的那拍说完再换
    if (cur.speaking) return false;
    return cur.elapsedMs >= cur.plannedMs || !!cur.plugin.isDone?.(cur.ctx, now);
  }

  /** 停掉当前项，开始下一项；返回新开始的环节（没有了返回 null） */
  private advance(now: number): SegmentDefinition | null {
    this.stopCurrent(now);
    this.index += 1;
    const item = this.rundown[this.index];
    const def = item && this.registry.get(item.segmentId);
    if (!item || !def) {
      this.index = -1;
      this.hooks.onChange?.();
      return null;
    }
    const plugin = def.create();
    const ctx: SegmentContext = { params: item.params ?? {}, storage: this.hooks.storage(def.id), startedAt: now, beats: 0, heat: 'quiet' };
    const run: Running = {
      item, def, plugin, ctx,
      elapsedMs: 0, tickedAt: now, plannedMs: item.minutes * 60_000,
      ready: false, pending: null, speaking: null, recap: [],
    };
    this.current = run;
    this.hooks.onSegment?.('start', { segmentId: def.id, title: def.title, layout: plugin.layout }, now);
    const failed = (err: unknown) => {
      console.warn(`[SegmentDirector] 环节 ${def.id} 启动失败:`, (err as Error).message);
      // 起不来就直接跳到下一项（还是会口播过渡）
      if (this.current === run) { run.ready = true; this.transitionDue = true; }
    };
    try {
      const started = plugin.start(ctx, now);
      if (started) started.then(() => { run.ready = true; this.hooks.onChange?.(); }, failed);
      else run.ready = true;
    } catch (err) {
      failed(err);
    }
    this.hooks.onChange?.();
    return def;
  }

  private stopCurrent(now: number): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    this.hooks.onSegment?.('stop', { segmentId: cur.def.id, title: cur.def.title, layout: cur.plugin.layout }, now);
    cur.plugin.stop().catch((err) => console.warn(`[SegmentDirector] 环节 ${cur.def.id} 停止失败:`, (err as Error).message));
  }
}
