/**
 * B 站研究任务：Hiyori 真的在帮主人干活——把一批视频的数据、弹幕、评论、字幕（没有就转写）
 * 收集下来，逐条分析，最后写成报告。直播不直播都能跑；直播时「B站情报站」环节把进度讲给观众听。
 *
 * 任务种类：
 *   hot     热门快照（热门 + 每周必看）
 *   up      某个 UP 主的全部投稿（target 是名字或 mid）
 *   search  关键词搜索（按播放量）
 *   videos  指定视频（BV 号 / b23 链接，空格或逗号分隔）
 *
 * 转写策略：all = 没字幕就整段转写（主人指定要转录的，默认）；auto = 热门用，20 分钟以内才转写，
 * 更长又没字幕的（演唱会录屏之类）只记数据和弹幕，报告里注明。
 *
 * 一次只跑一个任务，一个视频一个视频地来；每做完一个就存盘（userData/bili-research/jobs/），
 * 风控（-352 / -412 …）退避重试，视频没了就跳过，不会因为一个视频卡住整个任务。
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type { BiliVideo, BiliVideoBrief, BiliVideoClient } from '../streaming/platforms/bilibili/biliVideo';
import { analyzeTrend, analyzeVideo, rejectReason, type AnalyzeLlm, type TrendAnalysis, type VideoAnalysis } from './analyze';
import { transcriptText, type AsrPolicy, type LibraryLog, type TranscriptSource, type VideoDossier, type VideoLibrary } from './videoLibrary';

export type ResearchKind = 'hot' | 'up' | 'search' | 'videos';

export interface ResearchSpec {
  kind: ResearchKind;
  target?: string;
  limit?: number;
  transcribe?: 'all' | 'auto';
  /** 观众点播时手上没任务、为它临时开的（不算主人换了任务） */
  fromRequest?: boolean;
}

export type ItemStatus = 'queued' | 'working' | 'done' | 'skipped' | 'failed';

export interface ResearchItem {
  bvid: string;
  title: string;
  upName: string;
  duration: number;
  source: string;
  /** 直播里点这个视频的观众 */
  by?: string;
  status: ItemStatus;
  note?: string;
  transcript?: TranscriptSource;
  /** 能不能在直播画面上展示（时政新闻之类的照样研究，只是不上画面） */
  stageSafe?: boolean;
  stats?: BiliVideo['stat'];
  analysis?: VideoAnalysis | null;
  doneAt?: number;
}

export interface ResearchJob {
  id: string;
  spec: ResearchSpec;
  title: string;
  createdAt: number;
  status: 'preparing' | 'running' | 'done' | 'stopped' | 'failed';
  items: ResearchItem[];
  error?: string;
  trend?: TrendAnalysis | null;
  reportFile?: string;
  finishedAt?: number;
}

export interface ResearchDeps {
  client: BiliVideoClient;
  library: VideoLibrary;
  /** 分析用的 LLM；没有就只收集数据 */
  llm: AnalyzeLlm | null;
  /** userData/bili-research */
  dir: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** 两个视频之间歇一下（B 站风控） */
const ITEM_GAP_MS = 1500;
/** 风控时的退避 */
const BACKOFF_MS = [30_000, 90_000];
/** 热门视频超过这么长又没字幕，就不转写了 */
const AUTO_ASR_MAX_SEC = 20 * 60;
const DEFAULT_LIMIT: Record<ResearchKind, number> = { hot: 30, up: 50, search: 30, videos: 50 };

const RISK = /-352|-412|-799|HTTP 412|风控/;
const GONE = /-404|62002|62004|62012|HTTP 404|不存在/;

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  return h ? `${h}:${mm}:${String(s % 60).padStart(2, '0')}` : `${mm}:${String(s % 60).padStart(2, '0')}`;
}

function day(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export class ResearchRunner extends EventEmitter {
  private job: ResearchJob | null = null;
  /** 没有任务在跑时观众点的视频：下一个任务开始时排在最前面 */
  private waiting: ResearchItem[] = [];
  private stopping = false;
  private loop: Promise<void> | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: ResearchDeps) {
    super();
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
  }

  get current(): ResearchJob | null {
    return this.job;
  }

  /** 等着下个任务的点播 */
  get pendingRequests(): number {
    return this.waiting.length;
  }

  get running(): boolean {
    return !!this.job && (this.job.status === 'running' || this.job.status === 'preparing');
  }

  private log(line: LibraryLog): void {
    this.emit('log', line);
  }

  private changed(): void {
    if (this.job) this.save(this.job);
    this.emit('changed', this.job);
  }

  // ── 开始 / 停止 ─────────────────────────────────────

  /** 开一个新任务（正在跑的先停下）；列表拿到后在后台一条条处理 */
  async start(spec: ResearchSpec): Promise<ResearchJob> {
    await this.stop();
    const kind = spec.kind;
    const limit = Math.max(1, Math.min(500, Math.floor(spec.limit ?? DEFAULT_LIMIT[kind])));
    const transcribe = spec.transcribe ?? (kind === 'hot' ? 'auto' : 'all');
    const job: ResearchJob = {
      id: new Date(this.now()).toISOString().replace(/[:.]/g, '-').slice(0, 23),
      spec: { ...spec, limit, transcribe },
      title: '准备中…',
      createdAt: this.now(),
      status: 'preparing',
      items: [],
    };
    this.job = job;
    this.stopping = false;
    this.changed();
    try {
      const { title, list } = await this.resolve(job.spec);
      job.title = title;
      // 之前点的视频排最前面
      const waiting = this.waiting.splice(0);
      const seen = new Set<string>(waiting.map((w) => w.bvid));
      job.items = [...waiting, ...list.filter((v) => !seen.has(v.bvid) && seen.add(v.bvid)).slice(0, limit).map((v) => ({
        bvid: v.bvid, title: v.title, upName: v.upName, duration: v.duration, source: v.source, status: 'queued' as const,
        stageSafe: !rejectReason(v),
      }))];
      this.log({ text: `[job]   ${job.title}：${job.items.length} 个视频，${transcribe === 'all' ? '没字幕的整段转写' : '20 分钟以内没字幕的才转写'}` });
      job.status = 'running';
    } catch (err) {
      job.status = 'failed';
      job.error = (err as Error).message;
      this.log({ text: `[job]   开不了：${job.error}` });
    }
    this.changed();
    if (job.status === 'running') this.loop = this.run(job);
    return job;
  }

  async stop(): Promise<void> {
    if (!this.job || !this.running) return;
    this.stopping = true;
    await this.loop?.catch(() => {});
    this.loop = null;
  }

  /**
   * 直播里观众点的视频：插到当前任务最前面。没有任务在跑就先记着，
   * 下一个任务（比如切到情报站时开的热门快照）开始时排在最前面。
   */
  async request(bvid: string, by?: string, opts: { startNow?: boolean } = {}): Promise<ResearchItem> {
    const v = await this.deps.client.video(bvid);
    const item: ResearchItem = {
      bvid, title: v.title, upName: v.upName, duration: v.duration, source: '观众点的', by, status: 'queued',
      stageSafe: !rejectReason({ title: v.title, tid: v.tid, tname: v.tname, desc: v.desc }),
    };
    if (!this.running && opts.startNow) {
      // 情报站里点的、手上又没任务：马上开一个只做它的任务
      this.waiting = this.waiting.filter((w) => w.bvid !== bvid);
      this.waiting.unshift(item);
      const job = await this.start({ kind: 'videos', target: bvid, transcribe: 'auto', fromRequest: true });
      return job.items[0] ?? item;
    }
    if (!this.running) {
      const already = this.waiting.find((w) => w.bvid === bvid);
      if (already) return already;
      this.waiting.push(item);
      this.log({ text: `[queue] 记下：${v.title.slice(0, 24)}${by ? `（${by} 点的）` : ''}，下个任务开始时先做` });
      return item;
    }
    const job = this.job!;
    const existing = job.items.find((i) => i.bvid === bvid);
    if (existing) {
      existing.by ??= by;
      // 还没轮到就提到最前面
      if (existing.status === 'queued') {
        job.items.splice(job.items.indexOf(existing), 1);
        job.items.splice(this.nextIndex(job), 0, existing);
      }
      this.changed();
      return existing;
    }
    job.items.splice(this.nextIndex(job), 0, item);
    this.log({ text: `[queue] 插队：${v.title.slice(0, 24)}${by ? `（${by} 点的）` : ''}` });
    this.changed();
    return item;
  }

  /** 第一个还没开始的位置 */
  private nextIndex(job: ResearchJob): number {
    const i = job.items.findIndex((it) => it.status === 'queued');
    return i < 0 ? job.items.length : i;
  }

  // ── 处理 ─────────────────────────────────────────────

  private async resolve(spec: ResearchSpec): Promise<{ title: string; list: BiliVideoBrief[] }> {
    const c = this.deps.client;
    const limit = spec.limit!;
    switch (spec.kind) {
      case 'hot': {
        this.log({ text: '[fetch] x/web-interface/popular + popular/series' });
        const list = [...await c.popular(1), ...await c.popular(2).catch(() => []), ...await c.weekly().catch(() => [])];
        return { title: `B站热门快照 · ${day(this.now())}`, list };
      }
      case 'up': {
        const target = (spec.target ?? '').trim();
        if (!target) throw new Error('没说是哪个 UP 主');
        let mid = /^\d+$/.test(target) ? Number(target) : 0;
        let name = target;
        /** 按名字搜到的：任务名里带上粉丝数，同名小号选错了一眼能看出来（可以改填 mid） */
        let who = '';
        if (!mid) {
          this.log({ text: `[fetch] 搜索 UP 主「${target}」` });
          const up = await c.findUp(target);
          if (!up) throw new Error(`没找到叫「${target}」的 UP 主`);
          mid = up.mid;
          name = up.name;
          who = `（${up.fans >= 10_000 ? `${(up.fans / 10_000).toFixed(1)}万` : up.fans} 粉 · mid ${up.mid}）`;
          this.log({ text: `[up]    ${up.name}（mid ${up.mid}，粉丝 ${up.fans}，投稿 ${up.videos}）` });
        }
        const list = await c.upAll(mid, limit);
        if (list[0]) name = list[0].upName;
        return { title: `UP 主「${name}」${who}的投稿`, list };
      }
      case 'search': {
        const keyword = (spec.target ?? '').trim();
        if (!keyword) throw new Error('没有关键词');
        this.log({ text: `[fetch] 搜索视频「${keyword}」` });
        return { title: `搜索「${keyword}」`, list: await c.search(keyword, limit) };
      }
      case 'videos': {
        const parts = (spec.target ?? '').split(/[\s,，、]+/).filter(Boolean);
        const list: BiliVideoBrief[] = [];
        for (const p of parts) {
          const bvid = await c.resolveLink(p).catch(() => null);
          if (!bvid) continue;
          const v = await c.video(bvid).catch(() => null);
          if (v) list.push({ bvid, title: v.title, upName: v.upName, upMid: v.upMid, duration: v.duration, tid: v.tid, tname: v.tname, source: '指定的视频' });
        }
        if (!list.length) throw new Error('一个能打开的视频都没有');
        return { title: list.length === 1 ? `《${list[0].title.slice(0, 20)}》` : `指定的 ${list.length} 个视频`, list };
      }
    }
  }

  private policy(job: ResearchJob, item: ResearchItem): AsrPolicy {
    if (job.spec.transcribe === 'all') return { mode: 'full' };
    return item.duration <= AUTO_ASR_MAX_SEC ? { mode: 'full' } : { mode: 'none' };
  }

  private async run(job: ResearchJob): Promise<void> {
    let index = 0;
    while (!this.stopping) {
      const item = job.items.find((it) => it.status === 'queued');
      if (!item) break;
      index = job.items.filter((it) => it.status !== 'queued').length + 1;
      item.status = 'working';
      this.log({ text: `──── ${index}/${job.items.length}  ${item.bvid}  ${item.title.slice(0, 28)}` });
      this.changed();
      await this.process(job, item);
      this.changed();
      if (!this.stopping) await this.sleep(ITEM_GAP_MS);
    }
    if (this.stopping) {
      job.status = 'stopped';
      // 停下时正在做的那个退回排队，下次接着做
      for (const it of job.items) if (it.status === 'working') it.status = 'queued';
      this.log({ text: '[job]   已停止' });
      this.changed();
      return;
    }
    job.status = 'done';
    job.finishedAt = this.now();
    this.changed();
    await this.report().catch((err) => this.log({ text: `[report] 生成失败：${(err as Error).message}` }));
  }

  private async process(job: ResearchJob, item: ResearchItem): Promise<void> {
    const policy = this.policy(job, item);
    let dossier: VideoDossier | null = null;
    for (let attempt = 0; attempt <= BACKOFF_MS.length && !this.stopping; attempt++) {
      try {
        dossier = await this.deps.library.dossier(item.bvid, { asr: policy, log: (l) => this.log(l) }, this.now());
        break;
      } catch (err) {
        const msg = (err as Error).message;
        if (GONE.test(msg)) {
          item.status = 'skipped';
          item.note = '视频不存在或不可见';
          this.log({ text: `[skip]  ${item.note}` });
          return;
        }
        if (RISK.test(msg) && attempt < BACKOFF_MS.length) {
          this.log({ text: `[wait]  B 站风控（${msg.slice(0, 40)}），${BACKOFF_MS[attempt] / 1000} 秒后重试` });
          await this.sleep(BACKOFF_MS[attempt]);
          continue;
        }
        item.status = 'failed';
        item.note = msg.slice(0, 80);
        this.log({ text: `[fail]  ${item.note}` });
        return;
      }
    }
    if (!dossier) {
      item.status = 'queued';
      return;
    }
    const v = dossier.video;
    item.title = v.title;
    item.upName = v.upName;
    item.duration = v.duration;
    item.stats = v.stat;
    item.transcript = dossier.transcript.source;
    item.stageSafe = !rejectReason({ title: v.title, tid: v.tid, tname: v.tname, desc: v.desc });
    if (dossier.transcript.source === 'none' && policy.mode === 'none') item.note = '超长且没有字幕，只记了数据和弹幕';
    if (this.deps.llm) {
      this.log({ text: '[llm]   分析：讲了什么、为什么火、梗…' });
      item.analysis = await analyzeVideo(this.deps.llm, {
        video: v,
        comments: dossier.comments,
        transcript: transcriptText(dossier.transcript.lines, 1500),
        peak: dossier.peak,
      }).catch((err) => {
        this.log({ text: `[llm]   分析失败：${(err as Error).message.slice(0, 60)}` });
        return null;
      });
      if (item.analysis?.memes.length) this.log({ text: `[llm]   梗：${item.analysis.memes.map((m) => m.term).join('、')}` });
    }
    item.status = 'done';
    item.doneAt = this.now();
    this.emit('item', job, item, dossier);
  }

  // ── 存盘与报告 ───────────────────────────────────────

  private save(job: ResearchJob): void {
    try {
      const dir = path.join(this.deps.dir, 'jobs');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${job.id}.json`), JSON.stringify(job, null, 1), 'utf8');
    } catch (err) {
      console.warn('[Research] 保存任务失败:', (err as Error).message);
    }
  }

  /** 之前的任务（新的在前） */
  list(): Array<Pick<ResearchJob, 'id' | 'title' | 'status' | 'createdAt' | 'reportFile'> & { done: number; total: number }> {
    const dir = path.join(this.deps.dir, 'jobs');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 20).flatMap((f) => {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as ResearchJob;
        return [{ id: job.id, title: job.title, status: job.status, createdAt: job.createdAt, reportFile: job.reportFile, done: job.items.filter((i) => i.status === 'done').length, total: job.items.length }];
      } catch {
        return [];
      }
    });
  }

  load(id: string): ResearchJob | null {
    if (this.job?.id === id) return this.job;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.deps.dir, 'jobs', `${id}.json`), 'utf8')) as ResearchJob;
    } catch {
      return null;
    }
  }

  /** 写报告（Markdown + 流量数据 CSV）；没做完的任务也能出一份中间报告 */
  async report(id?: string): Promise<{ file: string; markdown: string } | null> {
    const job = id ? this.load(id) : this.job;
    if (!job) return null;
    const done = job.items.filter((i) => i.status === 'done');
    if (this.deps.llm && done.some((i) => i.analysis)) {
      this.log({ text: '[llm]   总结流量风向…' });
      job.trend = await analyzeTrend(this.deps.llm, job.title, done.filter((i) => i.analysis).map((i) => ({
        title: i.title, upName: i.upName, view: i.stats?.view ?? 0, like: i.stats?.like ?? 0, analysis: i.analysis!,
      }))).catch((err) => {
        this.log({ text: `[llm]   总结失败：${(err as Error).message}` });
        return job.trend ?? null;
      });
    }
    const markdown = renderReport(job, this.deps.library.folder);
    const dir = path.join(this.deps.dir, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${job.id}.md`);
    fs.writeFileSync(file, markdown, 'utf8');
    fs.writeFileSync(path.join(dir, `${job.id}.csv`), renderCsv(job), 'utf8');
    job.reportFile = file;
    this.save(job);
    this.log({ text: `[report] bili-research/reports/${job.id}.md` });
    this.emit('report', job, file);
    return { file, markdown };
  }
}

function num(n: number | undefined): string {
  if (n === undefined) return '–';
  return n >= 10_000 ? `${(n / 10_000).toFixed(1)}万` : String(n);
}

export function renderReport(job: ResearchJob, videosDir: string): string {
  const done = job.items.filter((i) => i.status === 'done');
  const count = (s: ItemStatus) => job.items.filter((i) => i.status === s).length;
  const sub = (t: TranscriptSource) => done.filter((i) => i.transcript === t).length;
  const link = (i: ResearchItem) => `[${i.title.replace(/[[\]|]/g, ' ')}](https://www.bilibili.com/video/${i.bvid})`;
  const out = [
    `# B站研究报告：${job.title}`,
    '',
    `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
    `- 视频：${job.items.length} 个（完成 ${done.length}，跳过 ${count('skipped')}，失败 ${count('failed')}，还没做 ${count('queued') + count('working')}）`,
    `- 字幕：B 站字幕 ${sub('subtitle')}，本地转写 ${sub('asr')}，没有 ${sub('none')}`,
    `- 全文字幕在 \`${videosDir}\`（每个视频一份 .txt 和 .json）`,
    '',
  ];
  if (job.trend?.trends.length) out.push('## 流量风向', '', ...job.trend.trends.map((t) => `- ${t}`), '');
  if (job.trend?.memes.length) out.push('## 值得记的梗', '', '| 梗 | 意思 |', '|---|---|', ...job.trend.memes.map((m) => `| ${m.term} | ${m.meaning} |`), '');
  if (job.trend?.notes.length) out.push('## 值得继续关注', '', ...job.trend.notes.map((t) => `- ${t}`), '');
  out.push('## 视频一览', '', '| # | 标题 | UP 主 | 时长 | 播放 | 点赞 | 投币 | 收藏 | 弹幕 | 赞播比 | 字幕 |', '|---|---|---|---|---|---|---|---|---|---|---|');
  done.forEach((i, k) => {
    const s = i.stats;
    const ratio = s && s.view ? `${((s.like / s.view) * 100).toFixed(1)}%` : '–';
    const t = { subtitle: 'B站', asr: '转写', none: '无' }[i.transcript ?? 'none'];
    out.push(`| ${k + 1} | ${link(i)} | ${i.upName} | ${clock(i.duration)} | ${num(s?.view)} | ${num(s?.like)} | ${num(s?.coin)} | ${num(s?.favorite)} | ${num(s?.danmaku)} | ${ratio} | ${t} |`);
  });
  out.push('', '## 逐条分析', '');
  done.forEach((i, k) => {
    out.push(`### ${k + 1}. ${link(i)} — ${i.upName}`, '');
    if (i.by) out.push(`- 直播里 ${i.by} 点的`);
    const a = i.analysis;
    if (a) {
      if (a.summary) out.push(`- 讲了什么：${a.summary}`);
      if (a.whyHot) out.push(`- 为什么火：${a.whyHot}`);
      if (a.audience) out.push(`- 弹幕和评论：${a.audience}`);
      if (a.memes.length) out.push(`- 梗：${a.memes.map((m) => `**${m.term}**（${m.meaning}）`).join('；')}`);
      if (a.tags.length) out.push(`- 标签：${a.tags.join('、')}`);
    }
    if (i.note) out.push(`- 备注：${i.note}`);
    out.push(`- 字幕文件：\`${i.bvid}.txt\``, '');
  });
  const skipped = job.items.filter((i) => i.status === 'skipped' || i.status === 'failed');
  if (skipped.length) out.push('## 没做成的', '', ...skipped.map((i) => `- ${link(i)}：${i.note ?? ''}`), '');
  return out.join('\n') + '\n';
}

export function renderCsv(job: ResearchJob): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['bvid', 'title', 'up', 'duration_sec', 'view', 'like', 'coin', 'favorite', 'danmaku', 'reply', 'transcript', 'status', 'note'].join(',')];
  for (const i of job.items) {
    const s = i.stats;
    rows.push([i.bvid, i.title, i.upName, i.duration, s?.view, s?.like, s?.coin, s?.favorite, s?.danmaku, s?.reply, i.transcript, i.status, i.note].map(esc).join(','));
  }
  // 带 BOM，Excel 打开不乱码
  return '﻿' + rows.join('\n') + '\n';
}
