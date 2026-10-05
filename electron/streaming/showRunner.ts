/**
 * 一场直播的节目：节目单导演 + 指标记录，接在注意力层和发言出口之间。
 *
 *   - 导演（segments/director.ts）在她空闲时出环节拍；环节换了，画面布局跟着换；
 *   - 她每说完一句，记一行到 userData/live-logs/<开播时间>.jsonl，下播时写汇总；
 *   - 节目单存在 userData/live-rundown.json。
 *
 * ipc/live.ts 管阶段机，在开播、下播时调这里的 beginShow / endShow。
 */

import fs from 'fs';
import path from 'path';
import type {
  LiveDirectorState,
  LiveEvent,
  LiveRundownItem,
  LiveSegment,
  StagePanelState,
} from '../../shared/types/live';
import { SegmentDirector } from './segments/director';
import { jsonSegmentStorage, segmentRegistry } from './segments/registry';
import { setTopicCardDeckFile } from './segments/topicCards';
import { ShowRecorder, type ShowSummary } from './showMetrics';
import { streamerController, type SpokenLine } from './streamerController';
import { streamerSession } from './streamerSession';
import { liveHub } from './liveHub';
import type { TopicBody } from './attention/topics';

export const DEFAULT_RUNDOWN: LiveRundownItem[] = [
  { segmentId: 'topic-cards', minutes: 20 },
  { segmentId: 'free-chat', minutes: 10 },
];

export interface ShowRunnerDeps {
  dataDir: string;
  /** 环节要换画面布局 */
  applyLayout(layout: LiveSegment): void;
  broadcast(channel: string, payload: unknown): void;
}

let deps: ShowRunnerDeps | null = null;
let director: SegmentDirector | null = null;
let recorder: ShowRecorder | null = null;
let rateTimer: NodeJS.Timeout | null = null;
let lastSummary: { summary: ShowSummary; file: string | null } | null = null;

function rundownFile(): string {
  return path.join(deps!.dataDir, 'live-rundown.json');
}

function loadRundown(): LiveRundownItem[] {
  try {
    const raw = JSON.parse(fs.readFileSync(rundownFile(), 'utf8')) as unknown;
    if (Array.isArray(raw)) return sanitizeRundown(raw);
  } catch {
    // 没存过或坏了：用默认的
  }
  return DEFAULT_RUNDOWN.map((i) => ({ ...i }));
}

export function sanitizeRundown(items: unknown[]): LiveRundownItem[] {
  return items
    .filter((i): i is LiveRundownItem => !!i && typeof (i as LiveRundownItem).segmentId === 'string')
    .filter((i) => segmentRegistry.has(i.segmentId))
    .map((i) => ({
      segmentId: i.segmentId,
      minutes: Math.min(240, Math.max(1, Math.round(Number(i.minutes) || 10))),
      ...(i.params && typeof i.params === 'object' ? { params: i.params } : {}),
    }));
}

function broadcastState(): void {
  if (!deps || !director) return;
  deps.broadcast('live:director', directorState());
  deps.broadcast('live:panel', director.panel());
}

export function initShowRunner(d: ShowRunnerDeps): void {
  deps = d;
  setTopicCardDeckFile(path.join(d.dataDir, 'live-segments', 'topic-cards.deck.json'));
  recorder = new ShowRecorder(path.join(d.dataDir, 'live-logs'));
  director = new SegmentDirector(segmentRegistry, {
    storage: (id) => jsonSegmentStorage(path.join(d.dataDir, 'live-segments'), id),
    onSegment: (action, info, now) => {
      recorder?.record({ type: 'segment', t: now, action, segmentId: info.segmentId, title: info.title });
      if (action === 'start') d.applyLayout(info.layout);
    },
    onAudience: (present, now) => recorder?.record({ type: 'audience', t: now, present }),
    onChange: () => broadcastState(),
  });
  director.setRundown(loadRundown());
  streamerSession.setDirector(director);

  streamerController.on('topic-done', (topic: TopicBody, said: string) => director?.spoken(topic, said, Date.now()));
  streamerController.on('spoken', (line: SpokenLine) => recorder?.speech(line));
  liveHub.subscribe((event: LiveEvent, isUpdate: boolean) => {
    if (isUpdate || !recorder?.active) return;
    if (event.kind === 'superchat' || event.kind === 'membership' || (event.kind === 'gift' && event.valueYuan > 0)) {
      recorder.record({
        type: 'event', t: Date.now(), kind: event.kind, user: event.user.masked ? '' : event.user.name,
        valueYuan: event.valueYuan, text: event.kind === 'superchat' ? event.text : undefined,
      });
    }
  });
}

// ── 开播 / 下播 ─────────────────────────────────────────

/** 开始记录这一场（开场动画开始，或没开画面时手动开始节目单） */
/** 这一场正在记录（开场后、谢幕前） */
export function isRecording(): boolean {
  return !!recorder?.active;
}

export function beginRecording(now = Date.now()): void {
  if (!recorder || recorder.active) return;
  recorder.begin(now);
  rateTimer = setInterval(() => {
    recorder?.record({ type: 'rate', t: Date.now(), chatsPerMin: liveHub.status().perMinute.chat ?? 0 });
  }, 60_000);
}

/** 结束记录，写汇总 */
export function finishRecording(): { summary: ShowSummary; file: string | null } | null {
  if (rateTimer) clearInterval(rateTimer);
  rateTimer = null;
  const result = recorder?.finish() ?? null;
  if (result) {
    lastSummary = result;
    deps?.broadcast('live:show-summary', result);
  }
  return result;
}

export function startRundown(now = Date.now()): void {
  beginRecording(now);
  director?.start(now);
}

export function stopRundown(now = Date.now()): void {
  director?.stop(now);
}

/** 画面布局变了（主播手动切环节）：和当前环节布局不同就暂停出拍 */
export function layoutChanged(layout: LiveSegment): void {
  director?.setLayout(layout, Date.now());
}

/** 开场白里提一句今天的节目 */
export function rundownTitles(): string[] {
  return (director?.state(Date.now()).rundown ?? []).map((i) => segmentRegistry.get(i.segmentId)?.title ?? i.segmentId);
}

// ── 控制台 ───────────────────────────────────────────────

export function directorState(): LiveDirectorState | null {
  return director ? { ...director.state(Date.now()), rehearsal: streamerSession.running && streamerSession.rehearsal } : null;
}

/** 主播在控制台选「现在的环节」（直播中说一句过渡就切过去；开播前就是第一个环节） */
export function switchSegment(item: LiveRundownItem, immediate = false): LiveDirectorState | null {
  director?.jumpTo(item, Date.now(), { immediate });
  return directorState();
}

/** 她手上正在做什么（写进回观众的提示词） */
export function currentActivity(): string | null {
  return director?.activity() ?? null;
}

export function currentPanel(): StagePanelState | null {
  return director?.panel() ?? null;
}

export function saveRundown(items: unknown[]): LiveDirectorState | null {
  if (!director || !deps) return null;
  const rundown = sanitizeRundown(items);
  try {
    fs.mkdirSync(deps.dataDir, { recursive: true });
    fs.writeFileSync(rundownFile(), JSON.stringify(rundown, null, 2), 'utf8');
  } catch (err) {
    console.warn('[ShowRunner] 保存节目单失败:', (err as Error).message);
  }
  // 节目单正在跑时不打断：存下的新节目单下一场才用
  if (!director.isRunning) director.setRundown(rundown);
  return directorState();
}

export function nextSegment(): void {
  director?.next();
}

export function extendSegment(minutes: number): void {
  director?.extend(minutes);
}

export function skipUpcoming(): void {
  director?.skipUpcoming();
}

export function lastShowSummary(): { summary: ShowSummary; file: string | null } | null {
  return lastSummary;
}

export function logsDir(): string | null {
  return deps ? path.join(deps.dataDir, 'live-logs') : null;
}
