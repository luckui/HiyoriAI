/**
 * 送礼私信解析：观众送任意礼物、再发 BV 号（顺序反过来也行），Hiyori 研究完这个视频，
 * 先发分析和字幕节选；关注后按平台消息长度分段补发完整字幕。
 *
 * B 站私信的限制（决定了这里的做法）：
 *   - 对方没回复、没关注你之前最多发 1 条（21047）；
 *   - 一条最多 2000 字节；对方隐私设置可能不收（25003）；发太快会被限（21020 / 21046）。
 * 所以：一个礼物换一份解析；每场有上限；完整字幕仅在确认关注后续发。
 */

import fs from 'fs';
import path from 'path';
import type { LiveUser } from '../../shared/types/live';
import { BV_PATTERN, B23_PATTERN } from '../streaming/platforms/bilibili/biliVideo';
import { DmError } from '../bilibili/accountActions';
import type { VideoAnalysis } from './analyze';
import type { ResearchItem, ResearchJob, ResearchRunner } from './research';
import { transcriptText, type VideoDossier } from './videoLibrary';

/** 礼物换来的名额多久内有效 */
const CREDIT_TTL_MS = 30 * 60_000;
/** 先发了 BV 号再送礼：多久以内的 BV 号算数 */
const REQUEST_TTL_MS = 30 * 60_000;
/** 每场最多接受几份送礼解析 */
export const MAX_DM_PER_SHOW = 20;
/** 两条私信至少隔多久（别被当成刷屏） */
const SEND_GAP_MS = 15_000;
/** 研究等太久就算了（退还名额） */
const WAIT_MS = 10 * 60_000;
/** 私信内容上限：2000 字节，留点余量 */
const MAX_BYTES = 1900;

export interface GiftDmDeps {
  enabled(): boolean;
  runner: Pick<ResearchRunner, 'request' | 'on' | 'off' | 'current'>;
  cached(bvid: string): VideoDossier | null;
  resolveLink(text: string): Promise<string | null>;
  /** 发私信；失败时抛出带 code 的错误 */
  send(uid: string, text: string): Promise<void>;
  /** 观众是否关注登录账号；null 表示查不到，仍可等直播关注事件 */
  follows?(uid: string): Promise<boolean | null>;
  /** 未完成的续发任务保存在 userData；应用重启后继续检查关注关系 */
  pendingFile?: string;
  /** 舞台终端 */
  log(text: string): void;
  /** 让她在直播里说一声（一两句话的指示） */
  announce(instruction: string): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Viewer {
  uid: string;
  name: string;
}

interface Waiting {
  viewer: Viewer;
  bvid: string;
  since: number;
}

interface Delivery {
  viewer: Viewer;
  bvid: string;
  title: string;
  initial: string;
  parts: string[];
  nextPart: number;
  initialSent: boolean;
  queued: boolean;
}

function wan(n: number): string {
  return n >= 10_000 ? `${(n / 10_000).toFixed(1)}万` : String(n);
}

function bytes(text: string): number {
  return Buffer.byteLength(JSON.stringify({ content: text }), 'utf8');
}

function clip(text: string, budget: number): string {
  let out = '';
  let size = 0;
  for (const char of text) {
    const cost = Buffer.byteLength(JSON.stringify(char), 'utf8') - 2;
    if (size + cost > budget) return out + '…';
    out += char;
    size += cost;
  }
  return out;
}

/** 一条私信：标题和数据、分析、字幕节选（字幕填满剩下的字节） */
export function composeDm(dossier: VideoDossier, analysis: VideoAnalysis | null | undefined): string {
  const v = dossier.video;
  const min = Math.max(1, Math.round(v.duration / 60));
  const head = [
    '【Hiyori 情报站 · 视频解析】',
    `《${v.title}》`,
    `UP：${v.upName} · ${min} 分钟 · 播放 ${wan(v.stat.view)} · 点赞 ${wan(v.stat.like)}`,
    `https://www.bilibili.com/video/${v.bvid}`,
  ];
  const body: string[] = [];
  if (analysis?.summary) body.push('', '▍讲了什么', analysis.summary);
  if (analysis?.whyHot) body.push('', '▍为什么火', analysis.whyHot);
  if (analysis?.memes.length) body.push('', '▍梗和新词', ...analysis.memes.slice(0, 4).map((m) => `· ${m.term}：${m.meaning}`));
  if (analysis?.audience) body.push('', '▍弹幕和评论在聊', analysis.audience);
  if (!analysis) body.push('', '（这次没来得及做分析，先给你视频数据）');
  const tail = ['', '—— 来自 Hiyori 的直播间，谢谢你的礼物！'];
  const source = { subtitle: 'B 站字幕', asr: '语音识别', none: '' }[dossier.transcript.source] ?? '';
  const hasTranscript = !!source && dossier.transcript.lines.length > 0;
  if (!hasTranscript) tail.unshift('这个视频暂时没有可用字幕，完整转录无法发送。');
  const base = clip([...head, ...body].join('\n'), MAX_BYTES - bytes(tail.join('\n')) - 180);
  if (!hasTranscript) return [base, ...tail].join('\n');
  tail.unshift('已关注 Hiyori 的话，完整字幕会接着发；还没关注的话，点关注后继续发。');
  // 字幕节选：剩下的字节能放多少放多少
  const label = `\n\n▍字幕节选（${source}）\n`;
  let chars = 600;
  let text = '';
  while (chars > 40) {
    const excerpt = transcriptText(dossier.transcript.lines, chars);
    text = [base + label + excerpt + (excerpt.length >= chars - 20 ? '…' : ''), ...tail].join('\n');
    if (bytes(text) <= MAX_BYTES) return text;
    chars -= 60;
  }
  return [base, ...tail].join('\n');
}

/** 保留每一行和时间戳，按私信 JSON 字节数切分；拼回正文不会丢字符。 */
export function composeTranscriptParts(dossier: VideoDossier): string[] {
  if (!dossier.transcript.lines.length) return [];
  const raw = dossier.transcript.lines.map((line) => {
    const sec = Math.max(0, Math.floor(line.from));
    const stamp = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    return `[${stamp}] ${line.text}\n`;
  }).join('');
  const heading = `【Hiyori · 完整字幕】\n${dossier.video.bvid}\n`;
  const limit = MAX_BYTES - bytes(`${heading}（9999/9999）\n`);
  const chunks: string[] = [];
  let chunk = '';
  let size = 0;
  for (const char of raw) {
    const cost = Buffer.byteLength(JSON.stringify(char), 'utf8') - 2;
    if (size + cost > limit && chunk) { chunks.push(chunk); chunk = ''; size = 0; }
    chunk += char;
    size += cost;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part, i) => `${heading}（${i + 1}/${chunks.length}）\n${part}`);
}

export class GiftDm {
  private credits = new Map<string, { viewer: Viewer; count: number; at: number }>();
  private lastRequest = new Map<string, { bvid: string; at: number }>();
  private waiting: Waiting[] = [];
  private sent = 0;
  private lastSentAt = -Infinity;
  private chain: Promise<void> = Promise.resolve();
  private deliveries = new Set<Delivery>();
  private followed = new Set<string>();
  private blockedUntil = new Map<string, number>();
  private polling = false;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: GiftDmDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    deps.runner.on('item', (_job: ResearchJob, item: ResearchItem, dossier: VideoDossier) => this.researched(item, dossier));
    deps.runner.on('changed', () => this.checkFailed());
    this.restore();
  }

  private restore(): void {
    if (!this.deps.pendingFile) return;
    try {
      const rows = JSON.parse(fs.readFileSync(this.deps.pendingFile, 'utf8')) as Delivery[];
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        if (!row?.viewer?.uid || !/^\d+$/.test(row.viewer.uid) || !Array.isArray(row.parts)
          || !row.parts.every((part) => typeof part === 'string' && bytes(part) <= MAX_BYTES)
          || typeof row.initial !== 'string' || typeof row.title !== 'string'
          || bytes(row.initial) > MAX_BYTES || typeof row.bvid !== 'string'
          || !Number.isInteger(row.nextPart) || row.nextPart < 0 || row.nextPart > row.parts.length) continue;
        this.deliveries.add({ ...row, queued: false });
      }
    } catch { /* 还没有待续发任务 */ }
  }

  private persist(): void {
    if (!this.deps.pendingFile) return;
    try {
      fs.mkdirSync(path.dirname(this.deps.pendingFile), { recursive: true });
      const tmp = `${this.deps.pendingFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.deliveries]), 'utf8');
      fs.renameSync(tmp, this.deps.pendingFile);
    } catch (err) { this.deps.log(`[dm]    保存续发进度失败：${(err as Error).message.slice(0, 60)}`); }
  }

  /** 关注事件可能在断线时漏掉；定期只读复查有待续发任务的 UID。 */
  async pollFollowers(): Promise<void> {
    if (this.polling || !this.deps.enabled() || !this.deps.follows || !this.deliveries.size) return;
    this.polling = true;
    try {
      for (const uid of new Set([...this.deliveries].map((d) => d.viewer.uid))) {
        if (this.followed.has(uid) || this.now() < (this.blockedUntil.get(uid) ?? 0)) continue;
        const yes = await this.deps.follows(uid).catch(() => null);
        if (yes) this.onFollow({ id: uid, name: '' });
      }
    } finally { this.polling = false; }
  }

  /** 新的一场：名额、计数清零 */
  reset(): void {
    this.credits.clear();
    this.lastRequest.clear();
    this.waiting = [];
    this.sent = 0;
    this.followed.clear();
  }

  /** 这位观众有没有还没用的礼物名额（给提示词用） */
  hasCredit(user: LiveUser): boolean {
    const c = this.credits.get(user.id);
    return !!c && c.count > 0 && this.now() - c.at <= CREDIT_TTL_MS;
  }

  get sentCount(): number {
    return this.sent;
  }

  onGift(user: LiveUser): void {
    if (!this.deps.enabled() || !user.id || user.masked) return;
    const now = this.now();
    const viewer = { uid: user.id, name: user.name };
    const credit = this.credits.get(user.id);
    this.credits.set(user.id, { viewer, count: (credit && now - credit.at <= CREDIT_TTL_MS ? credit.count : 0) + 1, at: now });
    // 之前发过 BV 号：直接给他做
    const req = this.lastRequest.get(user.id);
    if (req && now - req.at <= REQUEST_TTL_MS) {
      this.lastRequest.delete(user.id);
      this.bind(viewer, req.bvid);
    }
  }

  /** 直播间的关注事件带 UID，能唤醒之前因一条私信限制而暂停的任务。 */
  onFollow(user: LiveUser): void {
    if (!this.deps.enabled() || !user.id || user.masked) return;
    this.followed.add(user.id);
    this.blockedUntil.delete(user.id);
    for (const delivery of this.deliveries) if (delivery.viewer.uid === user.id) this.schedule(delivery);
  }

  onChat(user: LiveUser, text: string): void {
    if (!this.deps.enabled() || !user.id || user.masked) return;
    if (!BV_PATTERN.test(text) && !B23_PATTERN.test(text)) return;
    void this.deps.resolveLink(text).then((bvid) => {
      if (!bvid) return;
      const viewer = { uid: user.id, name: user.name };
      if (this.hasCredit(user)) this.bind(viewer, bvid);
      else this.lastRequest.set(user.id, { bvid, at: this.now() });
    }).catch(() => {});
  }

  /** 用掉一个名额，等这个视频研究完 */
  private bind(viewer: Viewer, bvid: string): void {
    if (this.waiting.some((w) => w.viewer.uid === viewer.uid && w.bvid === bvid)) return;
    if ([...this.deliveries].some((d) => d.viewer.uid === viewer.uid && d.bvid === bvid)) return;
    if (this.sent + this.waiting.length + [...this.deliveries].filter((d) => !d.initialSent).length >= MAX_DM_PER_SHOW) {
      this.deps.announce(`${viewer.name}送了礼物想要视频解析，但这场的私信名额（${MAX_DM_PER_SHOW} 条）用完了：谢谢他，说明下次早点来`);
      return;
    }
    this.spend(viewer.uid);
    this.waiting.push({ viewer, bvid, since: this.now() });
    this.deps.log(`[dm]    ${viewer.name} 的礼物换一份解析：${bvid}，研究完私信给他`);
    void this.deps.runner.request(bvid, viewer.name, { startNow: true, fullTranscript: true }).then((item) => {
      // 早就研究完了
      if (item.status === 'done') {
        const dossier = this.deps.cached(bvid);
        if (dossier) this.researched(item, dossier);
      }
    }).catch((err) => this.giveUp(bvid, `查不到这个视频（${(err as Error).message.slice(0, 40)}）`));
  }

  private spend(uid: string): void {
    const c = this.credits.get(uid);
    if (c) c.count -= 1;
  }

  private refund(viewer: Viewer): void {
    const c = this.credits.get(viewer.uid);
    if (c) c.count += 1;
    else this.credits.set(viewer.uid, { viewer, count: 1, at: this.now() });
  }

  private researched(item: ResearchItem, dossier: VideoDossier): void {
    const ready = this.waiting.filter((w) => w.bvid === item.bvid);
    if (!ready.length) return;
    this.waiting = this.waiting.filter((w) => w.bvid !== item.bvid);
    const text = composeDm(dossier, item.analysis);
    const parts = composeTranscriptParts(dossier);
    for (const w of ready) {
      const delivery: Delivery = { viewer: w.viewer, bvid: dossier.video.bvid, title: dossier.video.title, initial: text, parts, nextPart: 0, initialSent: false, queued: false };
      this.deliveries.add(delivery);
      this.persist();
      this.schedule(delivery);
    }
  }

  /** 研究失败、跳过、等太久：退还名额，告诉他 */
  private checkFailed(): void {
    const now = this.now();
    for (const w of [...this.waiting]) {
      const item = this.deps.runner.current?.items.find((i) => i.bvid === w.bvid);
      if (item && (item.status === 'failed' || item.status === 'skipped')) this.giveUp(w.bvid, item.note ?? '解析失败');
      else if (now - w.since > WAIT_MS) this.giveUp(w.bvid, '研究排太久了');
    }
  }

  private giveUp(bvid: string, why: string): void {
    const gone = this.waiting.filter((w) => w.bvid === bvid);
    this.waiting = this.waiting.filter((w) => w.bvid !== bvid);
    for (const w of gone) {
      this.refund(w.viewer);
      this.deps.log(`[dm]    ${w.viewer.name} 的解析没做成：${why}`);
      this.deps.announce(`${w.viewer.name}要的视频解析没做成（${why}）：告诉他礼物名额还在，换个 BV 号再发`);
    }
  }

  private schedule(delivery: Delivery): void {
    if (delivery.queued) return;
    delivery.queued = true;
    this.chain = this.chain.then(() => this.deliver(delivery)).catch((err) => {
      delivery.queued = false;
      this.deps.log(`[dm]    续发异常：${(err as Error).message.slice(0, 80)}`);
    });
  }

  private async sendOne(uid: string, text: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastSentAt + SEND_GAP_MS - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastSentAt = this.now();
      try { await this.deps.send(uid, text); return; }
      catch (err) {
        const code = err instanceof DmError ? err.code : 0;
        if ((code !== 21020 && code !== 21046) || attempt >= 2) throw err;
        await this.sleep(60_000 * (attempt + 1));
      }
    }
  }

  private async deliver(d: Delivery): Promise<void> {
    const { viewer, title } = d;
    let followState: boolean | null = this.followed.has(viewer.uid) ? true : null;
    if (!this.followed.has(viewer.uid) && this.deps.follows) {
      followState = await this.deps.follows(viewer.uid).catch(() => null);
      if (followState) this.followed.add(viewer.uid);
    }
    try {
      if (!d.initialSent) {
        await this.sendOne(viewer.uid, d.initial);
        d.initialSent = true;
        this.sent += 1;
        this.persist();
        this.deps.log(`[dm]    已私信 ${viewer.name}：《${title.slice(0, 24)}》的解析`);
        this.deps.announce(d.parts.length && !this.followed.has(viewer.uid)
          ? `《${title.slice(0, 30)}》的解析已经私信给${viewer.name}了：${followState === false ? '告诉他“你还没关注我呢，想要完整字幕就点个关注，关注后会自动续发”' : '告诉他关注 Hiyori 后会继续收到完整字幕'}`
          : `《${title.slice(0, 30)}》的解析已经私信给${viewer.name}了：告诉他去消息里查收，谢谢他的礼物`);
      }
      if (!d.parts.length) { this.deliveries.delete(d); this.persist(); return; }
      if (!this.followed.has(viewer.uid)) return;
      while (d.nextPart < d.parts.length) {
        await this.sendOne(viewer.uid, d.parts[d.nextPart]);
        d.nextPart++;
        this.persist();
        this.deps.log(`[dm]    ${viewer.name} 完整字幕 ${d.nextPart}/${d.parts.length}`);
      }
      this.deliveries.delete(d);
      this.persist();
      this.deps.announce(`${viewer.name}关注后，《${title.slice(0, 30)}》的完整字幕已经分段私信发完：告诉他查收`);
    } catch (err) {
      const code = err instanceof DmError ? err.code : 0;
      this.deps.log(`[dm]    私信 ${viewer.name} 失败：${code} ${(err as Error).message.slice(0, 60)}`);
      if (code === 21047) {
        this.followed.delete(viewer.uid);
        this.blockedUntil.set(viewer.uid, this.now() + 5 * 60_000);
        this.deps.announce(`${viewer.name}的字幕还没发完：B 站只允许先发一条。请他关注 Hiyori，关注后会自动续发`);
      } else if (code === 25003) {
        this.deliveries.delete(d);
        this.persist();
        if (!d.initialSent) this.refund(viewer);
        this.deps.announce(dmFailure(viewer.name, code));
      } else {
        this.deps.announce(dmFailure(viewer.name, code));
        setTimeout(() => { if (this.deps.enabled()) this.schedule(d); }, 5 * 60_000).unref();
      }
    } finally {
      d.queued = false;
    }
  }
}

/** 发不出去时她怎么说 */
function dmFailure(name: string, code: number): string {
  if (code === 21047) return `给${name}的私信发不出去：B 站规定对方回复或关注之前只能发一条。请他先关注直播间或者回一句私信，再来找你`;
  if (code === 25003) return `给${name}的私信被他的隐私设置挡住了：请他在 B 站设置里允许接收私信，再来找你`;
  if (code === 21020 || code === 21046) return `私信发得太频繁被 B 站限制了，${name}的解析要晚一点：跟他道个歉，名额还在`;
  return `给${name}的私信没发出去：跟他道个歉，礼物名额还在，过会儿再试`;
}
