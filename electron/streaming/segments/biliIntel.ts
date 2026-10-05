/**
 * 环节「B站情报站」：Hiyori 在直播里真的帮主人干活——研究任务（biliResearch/research.ts）在后台
 * 一条条收集、转录、分析 B 站视频，这个环节把做完的一条条展示给观众、讲她的发现，顺便陪大家聊。
 *
 * 她不假装在看、在听：她读的是字幕、弹幕、评论和数据（画面描述来自看图模型，没有就不提画面）。
 *
 * 每条视频的流程（固定，她不用自己调工具）：
 *   介绍（舞台上演示浏览器：B站首页 → 搜索 → 点进视频）→ 在弹幕最多的地方放 30 秒（不放完）
 *   → 讲分析：讲了什么、为什么火、新梗新词、弹幕在刷什么。
 * 研究还在做、没有新的可讲时，隔一会儿播报一下进度和目前的发现；任务做完、讲完就结束。
 *
 * 和研究任务的关系：任务是独立的（控制台、对话工具都能开停，下播也接着跑完出报告），这个环节只负责讲。
 *   - 环节开始时手上没任务：按控制台里选的「研究什么」开一个（没选过就是热门快照）；
 *   - 环节进行中主人换了任务：还没讲的旧任务视频不讲了（观众点的除外），她说一声换成了什么；
 *   - 主人停了任务：讲完已经做完的就结束，导演进下一个环节。
 *
 * 观众优先：
 *   - 弹幕里发 BV 号 / b23 链接就是点视频，插到研究任务最前面，做完就先讲它（每人每场最多 2 个）；
 *   - 点的视频讲完，她会问点的人想聊什么，环节停下来陪聊：一直有人说话就一直聊（最多 4 分钟），
 *     冷场 25 秒后她自己收个尾再回到任务。普通弹幕和环节拍本来就交替进行（见注意力层）。
 */

import { researchSpecProblem, type LiveChatEvent } from '../../../shared/types/live';
import type { BiliVideoClient } from '../platforms/bilibili/biliVideo';
import { BV_PATTERN, B23_PATTERN } from '../platforms/bilibili/biliVideo';
import { CLIP_SEC, MAX_PLAY_DURATION_SEC, writeComment, type AnalyzeLlm } from '../../biliResearch/analyze';
import type { ResearchItem, ResearchJob, ResearchRunner, ResearchSpec } from '../../biliResearch/research';
import { linesBetween, transcriptText, type VideoDossier } from '../../biliResearch/videoLibrary';
import type { VisionImage } from '../../biliResearch/vision';
import type { LiveSegmentPlugin, SegmentBeat, SegmentContext, SegmentDefinition } from './types';

const MAX_REQUESTS_PER_VIEWER = 2;
const MAX_COMMENTS_PER_SHOW = 3;
const COMMENT_GAP_MS = 10 * 60_000;
/** 放完以后等看图描述最多这么久 */
const LOOK_WAIT_MS = 10_000;
/** 没有新的可讲时，进度播报的间隔 */
const STATUS_GAP_MS = 90_000;
/** 陪聊：冷场多久收尾、最长聊多久 */
const DISCUSS_QUIET_MS = 25_000;
const DISCUSS_MAX_MS = 4 * 60_000;
/** 舞台文件树显示几条 */
const TREE_SIZE = 12;
/** 有人在看但一直没人说话：隔多久主动招呼一下大家（说在干嘛、怎么玩） */
const CUE_GAP_MS = 5 * 60_000;
const CUE_QUIET_MS = 2 * 60_000;
const CUE_LINES = [
  '跟直播间的大家搭句话：用一句话说说你在帮主人干什么，邀请大家发 BV 号让你研究，或者随便聊两句。',
  '招呼一下在看的朋友：说说你手上这批视频研究到哪了，有想让你看的视频就发 BV 号过来。',
  '主动cue一下观众：问问大家最近在 B 站刷到什么有意思的视频，想让你研究就发 BV 号或链接。',
];

/** 她讲视频的底线 */
const HONEST = '你没有眼睛和耳朵去看视频：你读的是字幕、弹幕、评论和数据，画面描述（如果有）来自截图识别。不要说「我听到」「这歌真好听」「画面很美」这类假装亲眼看、亲耳听的话，可以说「从字幕看」「弹幕都在刷」「数据显示」「从截图看」；不用提模型、接口这些技术词。';
const RESPECT = '绝对不要评价或调侃 UP 主、出镜的人、粉丝和这个圈子的爱好，不锐评。';

export interface StagePlayer {
  /** 舞台上演示打开这个视频：B站首页 → 搜索 → 点进视频页（演示用，几秒钟） */
  open(video: { bvid: string; title: string }): void;
  /** 放一段；放完（或放不了）时 resolve：played 是不是真的放了，frames 是放的时候截的画面 */
  play(req: { bvid: string; cid: number; startSec: number; clipSec: number }): Promise<{ played: boolean; frames: VisionImage[] }>;
  stop(): void;
}

export interface IntelDeps {
  runner: ResearchRunner;
  client: BiliVideoClient;
  player: StagePlayer;
  llm: AnalyzeLlm | null;
  /** 让能看图的模型描述几张图；没有视觉模型时返回 null */
  describe(images: VisionImage[], title: string): Promise<string | null>;
  /** 已经查过的档案（切到情报站时，研究早做完的那些接着讲） */
  cached(bvid: string): VideoDossier | null;
  /** 主人在控制台开的：讲过的视频点赞 / 留评论 */
  settings(): { like: boolean; comment: boolean };
  /** 环节开始 / 结束时登记「让她说一声」的入口（送礼私信发出去时用） */
  onActive?(notice: ((instruction: string) => void) | null): void;
  /** 控制台里选的研究什么：环节开始时手上没任务就按它开 */
  spec(): ResearchSpec;
}

type Stage = 'intro' | 'playing' | 'analysis';

interface Showing {
  item: ResearchItem;
  dossier: VideoDossier;
  stage: Stage;
  clip: { from: number; to: number } | null;
  played: boolean;
  /** 放的时候截的画面的描述（undefined：还在看） */
  look: string | null | undefined;
  lookWaitSince: number | null;
}

interface Discussion {
  by: string;
  title: string;
  context: string;
  since: number;
  lastChatAt: number;
}

function wan(n: number): string {
  return n >= 10_000 ? `${(n / 10_000).toFixed(1)}万` : String(n);
}

function minutes(sec: number): string {
  return sec >= 60 ? `${Math.round(sec / 60)} 分钟` : `${sec} 秒`;
}

/** 放哪一段：弹幕最多的那 30 秒；弹幕太少就从 20% 处开始；太长的不放 */
export function chooseClip(d: VideoDossier): { from: number; to: number } | null {
  const dur = d.video.duration;
  if (dur > MAX_PLAY_DURATION_SEC) return null;
  if (dur <= CLIP_SEC + 5) return { from: 0, to: dur };
  const from = d.peak ? Math.max(0, Math.min(d.peak.fromSec - 3, dur - CLIP_SEC)) : Math.round(dur * 0.2);
  return { from, to: from + CLIP_SEC };
}

class BiliIntelSegment implements LiveSegmentPlugin {
  readonly id = 'bili-intel';
  readonly title = 'B站情报站';
  readonly layout = 'watch' as const;

  /** 研究做完、等着讲的（观众点的排在前面） */
  private ready: Array<{ item: ResearchItem; dossier: VideoDossier }> = [];
  private showing: Showing | null = null;
  private discussion: Discussion | null = null;
  /** 收尾后保留一小段时间，让点播者迟到的回复仍能接回原视频。 */
  private recentDiscussion: Discussion | null = null;
  private wrapUpDue: Discussion | null = null;
  private notices: SegmentBeat[] = [];
  private offered: { key: string; beat: SegmentBeat } | null = null;
  private presented: ResearchItem[] = [];
  private requestsBy = new Map<string, number>();
  private comments = 0;
  private lastCommentAt = -Infinity;
  private lastStatusAt = -Infinity;
  private ctx: SegmentContext | null = null;
  private unsubscribe: (() => void) | null = null;
  /** 现在讲的是哪个任务的（认对象：id 只精确到秒）；任务换了，旧的没讲的就不讲了 */
  private job: ResearchJob | null = null;
  /** 主人中途换了任务：开始跑了就让她说一声 */
  private announceJob = false;
  /** 环节自己在开任务（开场、观众点播）：不算主人换任务 */
  private selfStarting = 0;
  /** 最近一条弹幕、最近一次主动招呼观众 */
  private lastChatAt = -Infinity;
  private lastCueAt = -Infinity;
  private cues = 0;

  constructor(private readonly deps: IntelDeps) {}

  async start(ctx: SegmentContext, now = Date.now()): Promise<void> {
    this.ctx = ctx;
    // 刚开始不急着招呼、也不急着播进度（开场、过渡刚说过；研究刚开始也没什么可播）
    this.lastCueAt = now;
    this.lastStatusAt = now - STATUS_GAP_MS + 45_000;
    this.deps.onActive?.((instruction) => this.notice(instruction));
    const runner = this.deps.runner;
    const onItem = (_job: ResearchJob, item: ResearchItem, dossier: VideoDossier) => {
      if (!item.stageSafe) return;
      const entry = { item, dossier };
      // 观众点的先讲
      if (item.by) this.ready.unshift(entry);
      else this.ready.push(entry);
      ctx.changed();
    };
    const onChanged = () => {
      this.followJob();
      ctx.changed();
    };
    runner.on('item', onItem);
    runner.on('changed', onChanged);
    this.unsubscribe = () => {
      runner.off('item', onItem);
      runner.off('changed', onChanged);
    };
    // 研究早就在跑（主人先在控制台开了任务）：做完的那些也接着讲
    for (const item of runner.current?.items ?? []) {
      if (item.status !== 'done' || !item.stageSafe) continue;
      const dossier = this.deps.cached(item.bvid);
      if (dossier) onItem(runner.current!, item, dossier);
    }
    this.job = runner.current;
    // 没有在跑的研究、也没有做完待讲的（或者有观众点的视频在等），就按控制台里选的开一个
    if (!runner.running && (!this.ready.length || runner.pendingRequests > 0)) {
      const job = await this.selfStart(() => runner.start(this.startSpec(ctx)));
      if (job.status === 'failed') throw new Error(job.error ?? '研究任务开不了');
    }
  }

  /** 自己开任务时研究什么：节目单里写了就照节目单，不然照控制台里选的；填得不全就退回热门 */
  private startSpec(ctx: SegmentContext): ResearchSpec {
    const p = ctx.params as Partial<ResearchSpec>;
    const spec: ResearchSpec = p.kind ? { kind: p.kind, target: p.target, limit: p.limit, transcribe: p.transcribe } : this.deps.spec();
    const problem = researchSpecProblem(spec);
    if (!problem) return spec;
    console.warn(`[BiliIntel] 研究设置不全（${problem}），先做热门快照`);
    return { kind: 'hot' };
  }

  private async selfStart<T>(run: () => Promise<T>): Promise<T> {
    this.selfStarting += 1;
    try {
      return await run();
    } finally {
      this.selfStarting -= 1;
    }
  }

  /** 主人中途换了研究任务：没讲的旧视频丢掉（观众点的留着），等新任务跑起来让她说一声 */
  private followJob(): void {
    const job = this.deps.runner.current;
    if (!job) return;
    if (job !== this.job) {
      this.job = job;
      // 环节自己开的、或者为观众点播临时开的（比如送礼私信）：都不算主人换任务
      if (this.selfStarting || job.spec.fromRequest) return;
      this.ready = this.ready.filter((r) => r.item.by);
      this.announceJob = true;
    }
    if (this.announceJob && job.status === 'running') {
      this.announceJob = false;
      this.notice(`主人把研究任务换成了「${job.title}」（${job.items.length} 个视频），告诉大家接下来研究这个`);
    }
  }

  nextBeat(_ctx: SegmentContext, now: number): SegmentBeat | null {
    const notice = this.notices[0];
    if (notice) return this.offer(`notice:${this.notices.length}`, notice);

    // 陪点视频的观众聊：有人说话就一直聊，冷场了她收个尾
    if (this.discussion) {
      const d = this.discussion;
      if (now - d.since < DISCUSS_MAX_MS && now - Math.max(d.since, d.lastChatAt) < DISCUSS_QUIET_MS) return null;
      this.discussion = null;
      this.wrapUpDue = d;
    }
    if (this.wrapUpDue) {
      return this.offer(`wrap:${this.wrapUpDue.title}`, {
        instruction: `和观众聊《${this.wrapUpDue.title}》的这段告一段落：一两句话收个尾（可以谢谢${this.wrapUpDue.by}），自然地回到研究任务上。`,
        material: {},
        length: 'short',
      });
    }

    if (!this.showing) {
      const next = this.ready.shift();
      if (next) {
        this.showing = { ...next, stage: 'intro', clip: chooseClip(next.dossier), played: false, look: undefined, lookWaitSince: null };
        this.ctx?.changed();
      }
    }
    // 有人在看、好一阵没人说话：两条视频之间主动招呼一下
    if (!this.showing && now - this.lastCueAt >= CUE_GAP_MS && now - this.lastChatAt >= CUE_QUIET_MS) {
      return this.offer(`cue:${this.cues}`, { instruction: CUE_LINES[this.cues % CUE_LINES.length], material: {}, length: 'short' });
    }
    const s = this.showing;
    if (!s) return this.statusBeat(now);
    switch (s.stage) {
      case 'intro': return this.offer(`intro:${s.item.bvid}`, this.introBeat(s));
      case 'playing': return null;
      case 'analysis':
        if (s.look === undefined) {
          s.lookWaitSince ??= now;
          if (now - s.lookWaitSince < LOOK_WAIT_MS) return null;
        }
        return this.offer(`analysis:${s.item.bvid}`, this.analysisBeat(s));
    }
  }

  onSpoken(beat: SegmentBeat, _text: string, _ctx: SegmentContext, now: number): void {
    const offered = this.offered;
    if (!offered || offered.beat !== beat) return;
    this.offered = null;
    const [kind] = offered.key.split(':');
    if (kind === 'notice') {
      this.notices.shift();
      return;
    }
    if (kind === 'wrap') {
      this.wrapUpDue = null;
      return;
    }
    if (kind === 'status') {
      this.lastStatusAt = now;
      return;
    }
    if (kind === 'cue') {
      this.lastCueAt = now;
      this.cues += 1;
      return;
    }
    const s = this.showing;
    if (!s) return;
    if (kind === 'intro') {
      if (s.clip) {
        s.stage = 'playing';
        const { bvid, cid, title } = s.dossier.video;
        void this.deps.player.play({ bvid, cid, startSec: s.clip.from, clipSec: s.clip.to - s.clip.from }).then(async ({ played, frames }) => {
          s.played = played;
          if (s.stage === 'playing') s.stage = 'analysis';
          s.look = frames.length ? await this.deps.describe(frames, title).catch(() => null) : null;
        });
      } else {
        s.stage = 'analysis';
        s.look = null;
      }
    } else if (kind === 'analysis') {
      this.finish(s, now);
      this.showing = null;
      this.ctx?.changed();
    }
  }

  onChat(event: LiveChatEvent, _ctx: SegmentContext, now: number): boolean {
    this.lastChatAt = now;
    if (!BV_PATTERN.test(event.text) && !B23_PATTERN.test(event.text)) {
      // 陪聊中：有人说话就接着聊（这条照常交给注意力层去回）
      if (this.discussion) this.discussion.lastChatAt = now;
      else if (this.recentDiscussion && event.user.name === this.recentDiscussion.by
        && now - this.recentDiscussion.since < DISCUSS_MAX_MS) {
        this.discussion = { ...this.recentDiscussion, lastChatAt: now };
        this.wrapUpDue = null;
      }
      return false;
    }
    const who = event.user.masked ? '' : event.user.name;
    const key = event.user.id || event.user.name;
    const used = this.requestsBy.get(key) ?? 0;
    if (used >= MAX_REQUESTS_PER_VIEWER) {
      this.notice(`${who || '这位观众'}这场已经点过 ${MAX_REQUESTS_PER_VIEWER} 个视频了，告诉他每人每场最多点 ${MAX_REQUESTS_PER_VIEWER} 个，下次再来`);
      return true;
    }
    this.requestsBy.set(key, used + 1);
    void this.acceptRequest(event.text, who);
    return true;
  }

  panel() {
    const job = this.deps.runner.current;
    const s = this.showing;
    const v = s?.dossier.video;
    return {
      nowDoing: 'B站情报站',
      kind: 'bili-intel',
      data: {
        stage: s?.stage ?? (this.discussion ? 'discuss' : 'idle'),
        job: job ? { title: job.title, done: job.items.filter((i) => i.status === 'done').length, total: job.items.length, status: job.status } : null,
        video: v ? {
          title: v.title, up: v.upName, cover: v.cover, duration: minutes(v.duration),
          view: wan(v.stat.view), like: wan(v.stat.like), coin: wan(v.stat.coin), favorite: wan(v.stat.favorite),
          danmaku: wan(v.stat.danmaku), source: s!.item.by ? `${s!.item.by} 点的` : s!.item.source,
        } : null,
        tree: this.tree(job),
      },
    };
  }

  isDone(): boolean {
    const job = this.deps.runner.current;
    const researching = !!job && (job.status === 'running' || job.status === 'preparing');
    return !researching && !this.showing && !this.ready.length && !this.discussion && !this.wrapUpDue && !this.notices.length;
  }

  /** 回观众时参考：她手上在做什么 */
  activity(): string | null {
    const job = this.deps.runner.current;
    const s = this.showing;
    const progress = job ? `研究任务「${job.title}」做了 ${job.items.filter((i) => i.status === 'done').length}/${job.items.length}` : '';
    if (this.discussion) return `在和${this.discussion.by}聊刚讲完的《${this.discussion.title}》${this.discussion.context ? `；研究要点：${this.discussion.context}` : ''}`;
    if (s) return `在情报站给大家讲《${s.dossier.video.title.slice(0, 30)}》（${progress}）`;
    const working = job?.items.find((i) => i.status === 'working');
    if (job && (job.status === 'running' || job.status === 'preparing')) return `在帮主人研究 B 站视频：${progress}${working ? `，正在处理《${working.title.slice(0, 24)}》` : ''}`;
    return '在情报站，手上这批视频做完了';
  }

  async stop(): Promise<void> {
    this.deps.onActive?.(null);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.deps.player.stop();
    // 研究任务不停：下播后接着做完，报告照样出
  }

  // ── 内部 ─────────────────────────────────────────────

  private offer(key: string, beat: SegmentBeat): SegmentBeat {
    // 同一拍再问一次要给同一个对象，onSpoken 靠它认
    if (this.offered?.key === key) return this.offered.beat;
    this.offered = { key, beat };
    // 要介绍了：舞台上开始演示打开这个视频
    if (key.startsWith('intro:') && this.showing) this.deps.player.open({ bvid: this.showing.item.bvid, title: this.showing.dossier.video.title });
    return beat;
  }

  private notice(instruction: string): void {
    this.notices.push({ instruction: `${instruction}。一两句话，语气轻松。`, material: {}, length: 'short' });
    this.ctx?.changed();
  }

  private async acceptRequest(text: string, who: string): Promise<void> {
    try {
      const bvid = await this.deps.client.resolveLink(text);
      if (!bvid) return this.notice(`${who || '有观众'}发的链接打不开，请他发 BV 号试试`);
      const item = await this.selfStart(() => this.deps.runner.request(bvid, who || undefined, { startNow: true }));
      if (!item.stageSafe) return this.notice(`${who || '有观众'}点的《${item.title.slice(0, 30)}》不适合在直播间展示，礼貌地说明（可以私下研究），别评价视频本身`);
      if (this.presented.some((p) => p.bvid === bvid)) return this.notice(`${who || '有观众'}点的视频这场已经讲过了，告诉他一声，可以接着聊`);
      // 早就研究完、在等着讲（热门里本来就有它）：直接提到最前面
      const waiting = this.ready.findIndex((r) => r.item.bvid === bvid);
      if (waiting > 0) this.ready.unshift(...this.ready.splice(waiting, 1));
      this.notice(`${who || '有观众'}点了《${item.title.slice(0, 30)}》，告诉他收到了，排到研究任务最前面，做完马上讲`);
    } catch (err) {
      console.warn('[BiliIntel] 点播处理失败:', (err as Error).message);
      this.notice(`${who || '有观众'}点的视频没查到，请他再发一次`);
    }
  }

  private introBeat(s: Showing): SegmentBeat {
    const v = s.dossier.video;
    const job = this.deps.runner.current;
    return {
      instruction: [
        '介绍你正在研究的这条视频：一两句话说它是什么、为什么在这次任务里（数据亮点、话题），',
        s.clip ? '最后说一句「先看一眼弹幕最热闹的那段」之类的话。' : '这条太长了不放，只看数据聊。',
        s.item.by ? `这是观众「${s.item.by}」点的，点名谢谢他。` : '',
        '不要念数据表，挑一两个数字说。', HONEST, RESPECT,
      ].join(''),
      material: {
        研究任务: job?.title ?? '',
        标题: v.title,
        UP主: v.upName,
        分区: v.tname,
        时长: minutes(v.duration),
        数据: `播放 ${wan(v.stat.view)}，点赞 ${wan(v.stat.like)}，投币 ${wan(v.stat.coin)}，收藏 ${wan(v.stat.favorite)}，弹幕 ${wan(v.stat.danmaku)}`,
        简介: v.desc.slice(0, 80),
        来源: s.item.by ? `观众「${s.item.by}」点的` : s.item.source,
      },
      length: 'normal',
    };
  }

  private analysisBeat(s: Showing): SegmentBeat {
    const d = s.dossier;
    const a = s.item.analysis;
    const lines = d.transcript.lines;
    const watched = s.played && s.clip ? transcriptText(linesBetween(lines, s.clip.from, s.clip.to), 200) : '';
    const material: Record<string, unknown> = {
      标题: d.video.title,
      ...(a?.summary ? { '讲了什么（从字幕看）': a.summary } : {}),
      ...(a?.whyHot ? { 为什么火: a.whyHot } : {}),
      ...(a?.memes.length ? { 梗和新词: a.memes.map((m) => `${m.term}：${m.meaning}`).join('；') } : {}),
      ...(a?.audience ? { 弹幕和评论在聊: a.audience } : {}),
      ...(d.peak ? { '弹幕最多的地方大家在刷': d.peak.samples.join(' / ') } : {}),
      ...(watched ? { '刚放的那一段的字幕（机器识别）': watched } : {}),
      ...(s.look ? { '刚放的画面（从截图看）': s.look } : {}),
      ...(d.transcript.source === 'none' ? { 字幕: '这个视频没有字幕，只能从数据、弹幕和评论看' } : {}),
    };
    return {
      instruction: [
        '讲你研究这条视频的发现：它讲了什么、为什么火，挑一两个梗或新词解释给大家听，说说弹幕在刷什么。像在跟大家分享情报，有自己的理解。',
        '标题、UP 主、时长和播放数据刚才介绍时说过了，别再重复，直接讲发现。',
        s.item.by ? `最后问问点这个视频的「${s.item.by}」：为什么想让你研究它，或者他怎么看。` : '',
        HONEST, RESPECT,
      ].join(''),
      material,
      length: 'normal',
    };
  }

  /** 没有新的可讲：隔一会儿播报一下研究进度和目前的发现 */
  private statusBeat(now: number): SegmentBeat | null {
    const job = this.deps.runner.current;
    if (!job || now - this.lastStatusAt < STATUS_GAP_MS) return null;
    if (job.status !== 'running' && job.status !== 'preparing') return null;
    const done = job.items.filter((i) => i.status === 'done');
    const working = job.items.find((i) => i.status === 'working');
    const memes = [...new Set(done.flatMap((i) => i.analysis?.memes.map((m) => m.term) ?? []))].slice(0, 6);
    return this.offer(`status:${done.length}`, {
      instruction: `播报一下研究进度：现在在处理哪个、做完了多少，再说一个目前为止的发现。${HONEST}${RESPECT}`,
      material: {
        研究任务: job.title,
        进度: `做完 ${done.length} 个，一共 ${job.items.length} 个`,
        ...(working ? { 正在处理: `${working.title.slice(0, 30)}（${working.upName}）` } : {}),
        ...(memes.length ? { 目前发现的梗: memes.join('、') } : {}),
      },
      length: 'short',
    });
  }

  /** 讲完一条：点的观众就开始陪聊；按设置点赞留评论 */
  private finish(s: Showing, now: number): void {
    this.presented.push(s.item);
    if (s.item.by) {
      const a = s.item.analysis;
      const context = [a?.summary, a?.whyHot, a?.audience].filter(Boolean).join('；').slice(0, 150);
      this.discussion = { by: s.item.by, title: s.dossier.video.title.slice(0, 30), context, since: now, lastChatAt: 0 };
      this.recentDiscussion = this.discussion;
    }
    const settings = this.deps.settings();
    const v = s.dossier.video;
    if (settings.like) {
      this.deps.client.like(v.aid).catch((err) => console.warn('[BiliIntel] 点赞失败:', (err as Error).message));
    }
    if (settings.comment && this.deps.llm && this.comments < MAX_COMMENTS_PER_SHOW && now - this.lastCommentAt >= COMMENT_GAP_MS) {
      this.comments += 1;
      this.lastCommentAt = now;
      void writeComment(this.deps.llm, v, s.item.analysis)
        .then((text) => (text ? this.deps.client.comment(v.aid, text) : undefined))
        .catch((err) => console.warn('[BiliIntel] 评论失败:', (err as Error).message));
    }
  }

  /** 舞台右边的文件树：研究任务的视频，正在讲的在中间 */
  private tree(job: ResearchJob | null): Array<{ title: string; by: string; state: string }> {
    if (!job) return [];
    const showingId = this.showing?.item.bvid;
    const rows = job.items.map((i) => ({
      title: i.title.slice(0, 28),
      by: i.by ?? '',
      state: i.bvid === showingId ? 'now' : i.status === 'done' ? (this.presented.includes(i) ? 'told' : 'done') : i.status,
    }));
    const at = Math.max(0, rows.findIndex((r) => r.state === 'now' || r.state === 'working'));
    const start = Math.max(0, Math.min(at - 3, rows.length - TREE_SIZE));
    return rows.slice(start, start + TREE_SIZE);
  }
}

export function biliIntelSegment(deps: IntelDeps): SegmentDefinition {
  return {
    id: 'bili-intel',
    title: 'B站情报站',
    description: 'Hiyori 帮你收集、转录、分析 B 站视频（研究什么在控制台「B站研究」里选：热门 / 某个 UP 主 / 关键词），边干活边讲发现；观众发 BV 号或视频链接可以点',
    create: () => new BiliIntelSegment(deps),
  };
}
