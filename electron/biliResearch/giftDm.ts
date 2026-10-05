/**
 * 送礼私信解析：观众送任意礼物、再发 BV 号（顺序反过来也行），Hiyori 研究完这个视频，
 * 把字幕节选和分析写成一条私信发给他。
 *
 * B 站私信的限制（决定了这里的做法）：
 *   - 对方没回复、没关注你之前最多发 1 条（21047）——所以一份解析就是一条完整的私信，不分段；
 *   - 一条最多 2000 字节；对方隐私设置可能不收（25003）；发太快会被限（21020 / 21046）。
 * 所以：一个礼物换一条私信；每场有上限；发不出去就退还名额，让她在直播里说一声为什么。
 */

import type { LiveUser } from '../../shared/types/live';
import { BV_PATTERN, B23_PATTERN, DmError } from '../streaming/platforms/bilibili/biliVideo';
import type { VideoAnalysis } from './analyze';
import type { ResearchItem, ResearchJob, ResearchRunner } from './research';
import { transcriptText, type VideoDossier } from './videoLibrary';

/** 礼物换来的名额多久内有效 */
const CREDIT_TTL_MS = 30 * 60_000;
/** 先发了 BV 号再送礼：多久以内的 BV 号算数 */
const REQUEST_TTL_MS = 30 * 60_000;
/** 每场最多发几条 */
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

function wan(n: number): string {
  return n >= 10_000 ? `${(n / 10_000).toFixed(1)}万` : String(n);
}

function bytes(text: string): number {
  return Buffer.byteLength(JSON.stringify({ content: text }), 'utf8');
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
  if (!analysis) body.push('', '（这次没来得及做分析，先给你数据和字幕）');
  const tail = ['', '—— 来自 Hiyori 的直播间，谢谢你的礼物！'];
  const source = { subtitle: 'B 站字幕', asr: '语音识别', none: '' }[dossier.transcript.source] ?? '';
  const base = [...head, ...body].join('\n');
  if (!source || !dossier.transcript.lines.length) return [base, ...tail].join('\n');
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

export class GiftDm {
  private credits = new Map<string, { viewer: Viewer; count: number; at: number }>();
  private lastRequest = new Map<string, { bvid: string; at: number }>();
  private waiting: Waiting[] = [];
  private sent = 0;
  private lastSentAt = -Infinity;
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: GiftDmDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    deps.runner.on('item', (_job: ResearchJob, item: ResearchItem, dossier: VideoDossier) => this.researched(item, dossier));
    deps.runner.on('changed', () => this.checkFailed());
  }

  /** 新的一场：名额、计数清零 */
  reset(): void {
    this.credits.clear();
    this.lastRequest.clear();
    this.waiting = [];
    this.sent = 0;
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
    if (this.sent + this.waiting.length >= MAX_DM_PER_SHOW) {
      this.deps.announce(`${viewer.name}送了礼物想要视频解析，但这场的私信名额（${MAX_DM_PER_SHOW} 条）用完了：谢谢他，说明下次早点来`);
      return;
    }
    if (this.waiting.some((w) => w.viewer.uid === viewer.uid && w.bvid === bvid)) return;
    this.spend(viewer.uid);
    this.waiting.push({ viewer, bvid, since: this.now() });
    this.deps.log(`[dm]    ${viewer.name} 的礼物换一份解析：${bvid}，研究完私信给他`);
    void this.deps.runner.request(bvid, viewer.name, { startNow: true }).then((item) => {
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
    for (const w of ready) this.enqueue(w.viewer, text, dossier.video.title);
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

  private enqueue(viewer: Viewer, text: string, title: string): void {
    this.chain = this.chain.then(async () => {
      const wait = this.lastSentAt + SEND_GAP_MS - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastSentAt = this.now();
      try {
        await this.deps.send(viewer.uid, text);
        this.sent += 1;
        this.deps.log(`[dm]    已私信 ${viewer.name}：《${title.slice(0, 24)}》的解析（${Buffer.byteLength(text, 'utf8')} 字节）`);
        this.deps.announce(`《${title.slice(0, 30)}》的解析已经私信给${viewer.name}了：告诉他去消息里查收，谢谢他的礼物`);
      } catch (err) {
        const code = err instanceof DmError ? err.code : 0;
        this.refund(viewer);
        this.deps.log(`[dm]    私信 ${viewer.name} 失败：${code} ${(err as Error).message.slice(0, 60)}`);
        this.deps.announce(dmFailure(viewer.name, code));
      }
    });
  }
}

/** 发不出去时她怎么说 */
function dmFailure(name: string, code: number): string {
  if (code === 21047) return `给${name}的私信发不出去：B 站规定对方回复或关注之前只能发一条。请他先关注直播间或者回一句私信，再来找你`;
  if (code === 25003) return `给${name}的私信被他的隐私设置挡住了：请他在 B 站设置里允许接收私信，再来找你`;
  if (code === 21020 || code === 21046) return `私信发得太频繁被 B 站限制了，${name}的解析要晚一点：跟他道个歉，名额还在`;
  return `给${name}的私信没发出去：跟他道个歉，礼物名额还在，过会儿再试`;
}
