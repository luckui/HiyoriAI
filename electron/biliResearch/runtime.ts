/**
 * B 站研究接到应用上：
 *   - 研究任务执行器（单例）：控制台、对话里的 bili_research 工具、直播环节都用它；
 *   - 直播环节「B站情报站」和舞台上的播放器（主窗口里的 <webview>，会话里有主人的 B 站 Cookie）；
 *   - 研究过程的输出推给舞台的终端，任务进度推给控制台。
 */

import { ipcMain, nativeImage, session } from 'electron';
import path from 'path';
import { LIVE_PLAYER_PARTITION, type ResearchJobSummary } from '../../shared/types/live';
import { BiliVideoClient } from '../streaming/platforms/bilibili/biliVideo';
import { biliIntelSegment, type StagePlayer } from '../streaming/segments/biliIntel';
import { registerSegment } from '../streaming/segments/registry';
import { backstageLlm, streamerSession } from '../streaming/streamerSession';
import { fileAsrCommand } from '../sttServerManager';
import aiConfig from '../ai.config';
import { ResearchRunner, type ResearchJob, type ResearchSpec } from './research';
import { GiftDm } from './giftDm';
import { VideoLibrary } from './videoLibrary';
import { describeImages, type VisionImage } from './vision';

export interface BiliResearchDeps {
  dataDir: string;
  cookie(): string;
  settings(): { like: boolean; comment: boolean; visionProvider?: string };
  /** 控制台里选的研究什么（情报站自己开任务时用） */
  spec(): ResearchSpec;
  /** 开了送礼私信解析 */
  giftDm(): boolean;
  /** 发给主窗口（舞台） */
  sendToStage(channel: string, payload: unknown): boolean;
  broadcast(channel: string, payload: unknown): void;
}

let runner: ResearchRunner | null = null;
let library: VideoLibrary | null = null;
let giftDm: GiftDm | null = null;

/** 送礼私信解析（新的一场开始时 reset） */
export function giftDmService(): GiftDm | null {
  return giftDm;
}

export function researchRunner(): ResearchRunner | null {
  return runner;
}

export function researchFolders(): { reports: string; videos: string } | null {
  return runner && library ? { reports: path.join(path.dirname(library.folder), 'bili-research', 'reports'), videos: library.folder } : null;
}

export function summarizeJob(job: ResearchJob | null): ResearchJobSummary | null {
  if (!job) return null;
  const working = job.items.find((i) => i.status === 'working');
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    kind: job.spec.kind,
    spec: { kind: job.spec.kind, target: job.spec.target, limit: job.spec.limit, transcribe: job.spec.transcribe },
    done: job.items.filter((i) => i.status === 'done').length,
    skipped: job.items.filter((i) => i.status === 'skipped' || i.status === 'failed').length,
    total: job.items.length,
    working: working ? working.title.slice(0, 40) : undefined,
    reportFile: job.reportFile,
    error: job.error,
  };
}

/** 把主人的 B 站 Cookie 写进播放器会话（登录态播放，清晰度更高） */
export async function syncPlayerCookies(cookie: string): Promise<void> {
  const ses = session.fromPartition(LIVE_PLAYER_PARTITION);
  const pairs = cookie.split(';').map((p) => p.trim()).filter((p) => p.includes('='));
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (!name) continue;
    await ses.cookies.set({ url: 'https://www.bilibili.com', domain: '.bilibili.com', path: '/', name, value, secure: true })
      .catch((err) => console.warn(`[BiliResearch] 写 Cookie ${name} 失败:`, (err as Error).message));
  }
}

type PlayResult = { played: boolean; frames: VisionImage[] };

/** 舞台截的画面（PNG data URL）压成小 JPEG 再交给看图模型 */
function shrink(dataUrl: string): string | null {
  const img = nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) return null;
  const small = img.getSize().width > 640 ? img.resize({ width: 640 }) : img;
  return `data:image/jpeg;base64,${small.toJPEG(75).toString('base64')}`;
}

function stagePlayer(deps: BiliResearchDeps): StagePlayer {
  let seq = 0;
  const pending = new Map<number, (result: PlayResult) => void>();
  ipcMain.on('live:player:done', (_e, msg: { id: number; played: boolean; frames?: string[] }) => {
    const frames = (msg?.frames ?? []).slice(0, 3).map(shrink).filter((u): u is string => !!u)
      .map((dataUrl, i) => ({ label: `正在放的画面 ${i + 1}`, dataUrl }));
    pending.get(msg?.id)?.({ played: !!msg?.played, frames });
  });
  return {
    open(video) {
      deps.sendToStage('live:player', { action: 'open', ...video });
    },
    play(req) {
      const id = ++seq;
      return new Promise((resolve) => {
        // 舞台没回话也别卡住：片段时长再宽限 40 秒（含打开页面）
        const timer = setTimeout(() => finish({ played: false, frames: [] }), (req.clipSec + 40) * 1000);
        const finish = (result: PlayResult) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(result);
        };
        pending.set(id, finish);
        if (!deps.sendToStage('live:player', { action: 'play', id, ...req })) finish({ played: false, frames: [] });
      });
    },
    stop() {
      deps.sendToStage('live:player', { action: 'stop' });
      for (const finish of [...pending.values()]) finish({ played: false, frames: [] });
    },
  };
}

export function initBiliResearch(deps: BiliResearchDeps): ResearchRunner {
  const client = new BiliVideoClient(deps.cookie);
  library = new VideoLibrary(client, path.join(deps.dataDir, 'bili-videos'), fileAsrCommand);
  // 没配好 LLM 时只收集数据，不分析
  const llm = (system: string, user: string) => backstageLlm(system, user);
  runner = new ResearchRunner({ client, library, llm: aiConfig.providers[aiConfig.activeProvider] ? llm : null, dir: path.join(deps.dataDir, 'bili-research') });
  syncPlayerCookies(deps.cookie()).catch((err) => console.warn('[BiliResearch] 同步播放器 Cookie 失败:', (err as Error).message));

  // 终端输出、任务进度
  runner.on('log', (line) => deps.broadcast('live:terminal', line));
  let pendingChange: NodeJS.Timeout | null = null;
  runner.on('changed', (job: ResearchJob | null) => {
    // 一秒最多推一次
    if (pendingChange) return;
    pendingChange = setTimeout(() => {
      pendingChange = null;
      deps.broadcast('research:changed', summarizeJob(job));
    }, 300);
  });
  runner.on('report', (job: ResearchJob, file: string) => deps.broadcast('research:report', { id: job.id, title: job.title, file }));

  // 不在情报站环节时观众发的视频：照样排进研究队列（切到情报站时第一个讲）
  const research = runner;
  streamerSession.setVideoRequestHandler((event) => {
    const who = event.user.masked ? undefined : event.user.name;
    void client.resolveLink(event.text)
      .then((bvid) => (bvid ? research.request(bvid, who) : null))
      .catch((err) => console.warn('[BiliResearch] 点播排队失败:', (err as Error).message));
  });

  // 送礼私信解析：她能说话时（在情报站）让她说一声，不然只记在终端和控制台
  let speak: ((instruction: string) => void) | null = null;
  const dm = new GiftDm({
    enabled: deps.giftDm,
    runner,
    cached: (bvid) => library?.cached(bvid) ?? null,
    resolveLink: (text) => client.resolveLink(text),
    send: (uid, text) => client.sendMessage(uid, text),
    follows: (uid) => client.followsMe(uid),
    pendingFile: path.join(deps.dataDir, 'bili-research', 'gift-dm-pending.json'),
    log: (text) => {
      deps.broadcast('live:terminal', { text });
      console.info(`[GiftDm] ${text.replace(/^\[dm\]\s*/, '')}`);
    },
    announce: (instruction) => {
      if (speak) speak(instruction);
      else deps.broadcast('live:notice', `私信解析：${instruction.split('：')[0]}`);
    },
  });
  giftDm = dm;
  void dm.pollFollowers();
  setInterval(() => { void dm.pollFollowers(); }, 60_000).unref();
  streamerSession.setEventTap((event) => {
    if (event.kind === 'gift') dm.onGift(event.user);
    else if (event.kind === 'chat') dm.onChat(event.user, event.text);
    else if (event.kind === 'follow') dm.onFollow(event.user);
  });

  registerSegment(biliIntelSegment({
    runner,
    client,
    player: stagePlayer(deps),
    llm,
    describe: (images, title) => describeImages(images, title, deps.settings().visionProvider),
    cached: (bvid) => library?.cached(bvid) ?? null,
    settings: deps.settings,
    spec: deps.spec,
    onActive: (notice) => { speak = notice; },
  }));
  return runner;
}
