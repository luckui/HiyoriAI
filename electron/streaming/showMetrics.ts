/**
 * 每场直播的指标：她每说一句记一行 JSONL，下播时汇总成冷场率、重复率、各环节时长、高光候选。
 * 用来判断哪种内容真的撑得住场子，而不是凭感觉改提示词。
 *
 * 记录写在 userData/live-logs/<开播时间>.jsonl，汇总是同名的 .summary.json。
 * 汇总是纯函数（summarizeShow），可以拿模拟直播的记录直接算。
 */

import fs from 'fs';
import path from 'path';
import type { LiveShowSummary, LiveShowSummaryOptions } from '../../shared/types/live';

export type ShowRecord =
  /** 她说了一句：gapMs 是上一句说完到这句开口的空隙 */
  | { type: 'speech'; t: number; kind: string; segment?: string; text: string; speechMs: number; gapMs: number }
  /** 环节开始 / 结束 */
  | { type: 'segment'; t: number; action: 'start' | 'stop'; segmentId: string; title: string }
  /** 值得剪的事：礼物、醒目留言、上舰 */
  | { type: 'event'; t: number; kind: string; user: string; valueYuan: number; text?: string }
  /** 每分钟的弹幕数（找弹幕突增） */
  | { type: 'rate'; t: number; chatsPerMin: number }
  /** 直播间有没有人在看变了：没人的时间她本来就不说话，不算冷场 */
  | { type: 'audience'; t: number; present: boolean };

export type ShowSummaryOptions = LiveShowSummaryOptions;
export type ShowSummary = LiveShowSummary;

const DEFAULTS: Required<ShowSummaryOptions> = { coldGapSec: 8, repeatThreshold: 0.2 };

/** 只留汉字、字母、数字，小写 */
function bare(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function ngrams(text: string, n: number): Set<string> {
  const chars = [...bare(text)];
  const out = new Set<string>();
  for (let i = 0; i + n <= chars.length; i++) out.add(chars.slice(i, i + n).join(''));
  return out;
}

export function trigrams(text: string): Set<string> {
  return ngrams(text, 3);
}

function noveltyOf(lines: string[]): number {
  const seen = new Set<string>();
  const shares = lines.map((line) => {
    const grams = ngrams(line, 2);
    let fresh = 0;
    for (const g of grams) if (!seen.has(g)) fresh++;
    for (const g of grams) seen.add(g);
    return grams.size ? fresh / grams.size : 1;
  });
  const tail = shares.slice(Math.floor(shares.length / 2));
  return tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 1;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

/** 在至少 minLines 句、且超过 minShare 比例的句子里都出现的 5 字短语 */
function stockPhrases(lines: string[], minLines = 4, minShare = 0.08): Array<{ phrase: string; lines: number }> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const chars = [...bare(line)];
    const seen = new Set<string>();
    for (let i = 0; i + 5 <= chars.length; i++) seen.add(chars.slice(i, i + 5).join(''));
    for (const g of seen) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const need = Math.max(minLines, Math.ceil(lines.length * minShare));
  const hits = [...counts.entries()].filter(([, n]) => n >= need).sort((a, b) => b[1] - a[1]);
  // 长短语会拆出好几个重叠的 5 字片段，只留不被更靠前的片段覆盖的
  const kept: Array<{ phrase: string; lines: number }> = [];
  for (const [phrase, n] of hits) {
    if (kept.some((k) => k.lines === n && overlaps(k.phrase, phrase))) continue;
    kept.push({ phrase, lines: n });
    if (kept.length >= 10) break;
  }
  return kept;
}

function overlaps(a: string, b: string): boolean {
  return a.includes(b.slice(1)) || a.includes(b.slice(0, -1)) || b.includes(a.slice(1)) || b.includes(a.slice(0, -1));
}

export function summarizeShow(records: ShowRecord[], options: ShowSummaryOptions = {}): ShowSummary {
  const opts = { ...DEFAULTS, ...options };
  const speeches = records.filter((r): r is Extract<ShowRecord, { type: 'speech' }> => r.type === 'speech');
  const startedAt = records.length ? Math.min(...records.map((r) => r.t)) : 0;
  const endedAt = records.length ? Math.max(...records.map((r) => (r.type === 'speech' ? r.t + r.speechMs : r.t))) : 0;
  // 没人在看的时段
  const empty: Array<[number, number]> = [];
  let emptySince: number | null = null;
  for (const r of records) {
    if (r.type !== 'audience') continue;
    if (!r.present && emptySince === null) emptySince = r.t;
    else if (r.present && emptySince !== null) { empty.push([emptySince, r.t]); emptySince = null; }
  }
  if (emptySince !== null) empty.push([emptySince, endedAt]);
  const emptyWithin = (from: number, to: number) =>
    empty.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);
  const emptyMs = emptyWithin(startedAt, endedAt);
  const durationMs = Math.max(1, endedAt - startedAt - emptyMs);

  // 空隙里没人在看的部分不算
  const coldMs = speeches.reduce((sum, s) => {
    const gap = s.gapMs - emptyWithin(s.t - s.gapMs, s.t);
    return sum + (gap > opts.coldGapSec * 1000 ? gap : 0);
  }, 0);
  const talkMs = speeches.reduce((sum, s) => sum + s.speechMs, 0);

  // 重复：每句和之前所有句子比
  const grams = speeches.map((s) => trigrams(s.text));
  let repeated = 0;
  const pairs: Array<{ a: string; b: string; similarity: number }> = [];
  for (let i = 1; i < grams.length; i++) {
    let best = 0;
    let bestJ = -1;
    for (let j = 0; j < i; j++) {
      const sim = jaccard(grams[i], grams[j]);
      if (sim > best) { best = sim; bestJ = j; }
    }
    if (best > opts.repeatThreshold) repeated++;
    if (bestJ >= 0) pairs.push({ a: speeches[bestJ].text, b: speeches[i].text, similarity: Number(best.toFixed(2)) });
  }

  const stock = stockPhrases(speeches.map((s) => s.text));
  const stockLines = speeches.filter((s) => stock.some((p) => bare(s.text).includes(p.phrase))).length;

  const heads = speeches.map((s) => [...bare(s.text)].slice(0, 3).join(''));
  const sameHead = heads.filter((h, i) => h.length === 3 && heads.slice(Math.max(0, i - 10), i).includes(h)).length;

  const byKind: Record<string, number> = {};
  for (const s of speeches) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;

  // 环节：start 到下一个 stop（或下一个 start、或结束）
  const segments: ShowSummary['segments'] = [];
  const marks = records.filter((r): r is Extract<ShowRecord, { type: 'segment' }> => r.type === 'segment');
  marks.forEach((m, i) => {
    if (m.action !== 'start') return;
    const until = marks.slice(i + 1).find((n) => n.segmentId === m.segmentId && n.action === 'stop')?.t
      ?? marks.slice(i + 1).find((n) => n.action === 'start')?.t
      ?? endedAt;
    const beats = speeches.filter((s) => s.kind === 'segment' && s.segment === m.segmentId && s.t >= m.t && s.t < until).length;
    segments.push({ segmentId: m.segmentId, title: m.title, ms: until - m.t, beats });
  });

  return {
    startedAt,
    durationMs,
    emptyMs,
    speeches: speeches.length,
    talkRatio: Number((talkMs / durationMs).toFixed(3)),
    coldRate: Number((coldMs / durationMs).toFixed(3)),
    longestGapMs: speeches.reduce((m, s) => Math.max(m, s.gapMs), 0),
    repeatRate: speeches.length > 1 ? Number((repeated / (speeches.length - 1)).toFixed(3)) : 0,
    repeatSamples: pairs.sort((a, b) => b.similarity - a.similarity).slice(0, 5),
    novelty: Number(noveltyOf(speeches.map((s) => s.text)).toFixed(3)),
    stockPhrases: stock,
    stockRate: speeches.length ? Number((stockLines / speeches.length).toFixed(3)) : 0,
    openingRepeatRate: speeches.length ? Number((sameHead / speeches.length).toFixed(3)) : 0,
    byKind,
    segments,
    highlights: highlights(records),
    options: opts,
  };
}

function highlights(records: ShowRecord[]): Array<{ t: number; why: string }> {
  const out: Array<{ t: number; why: string }> = [];
  for (const r of records) {
    if (r.type !== 'event') continue;
    if (r.kind === 'superchat') out.push({ t: r.t, why: `醒目留言 ¥${r.valueYuan}：${r.user}` });
    else if (r.kind === 'membership') out.push({ t: r.t, why: `上舰：${r.user}` });
    else if (r.valueYuan >= 5) out.push({ t: r.t, why: `礼物 ¥${r.valueYuan}：${r.user}` });
  }
  // 弹幕突增：比前 5 分钟的平均多一倍以上，且至少 10 条/分
  const rates = records.filter((r): r is Extract<ShowRecord, { type: 'rate' }> => r.type === 'rate');
  rates.forEach((r, i) => {
    const before = rates.slice(Math.max(0, i - 5), i);
    if (!before.length) return;
    const avg = before.reduce((s, b) => s + b.chatsPerMin, 0) / before.length;
    if (r.chatsPerMin >= 10 && r.chatsPerMin >= avg * 2) out.push({ t: r.t, why: `弹幕突增 ${r.chatsPerMin}/分（之前约 ${Math.round(avg)}）` });
  });
  return out.sort((a, b) => a.t - b.t);
}

/** 一场直播的记录文件：边播边追加，下播时写汇总 */
export class ShowRecorder {
  private records: ShowRecord[] = [];
  private file: string | null = null;
  private lastSpeechEnd: number | null = null;

  constructor(private readonly dir: string) {}

  get path(): string | null {
    return this.file;
  }

  begin(now = Date.now()): void {
    this.records = [];
    this.lastSpeechEnd = now;
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.file = path.join(this.dir, `${stamp}.jsonl`);
    } catch (err) {
      console.warn('[ShowRecorder] 无法创建记录目录:', (err as Error).message);
      this.file = null;
    }
  }

  get active(): boolean {
    return this.lastSpeechEnd !== null;
  }

  speech(entry: { kind: string; segment?: string; text: string; startedAt: number; endedAt: number }): void {
    if (this.lastSpeechEnd === null) return;
    const gapMs = Math.max(0, entry.startedAt - this.lastSpeechEnd);
    this.lastSpeechEnd = entry.endedAt;
    this.push({ type: 'speech', t: entry.startedAt, kind: entry.kind, segment: entry.segment, text: entry.text, speechMs: entry.endedAt - entry.startedAt, gapMs });
  }

  record(record: ShowRecord): void {
    if (this.lastSpeechEnd === null) return;
    this.push(record);
  }

  /** 下播：写汇总，返回汇总文件路径 */
  finish(options?: ShowSummaryOptions): { summary: ShowSummary; file: string | null } | null {
    if (this.lastSpeechEnd === null) return null;
    this.lastSpeechEnd = null;
    const summary = summarizeShow(this.records, options);
    let file: string | null = null;
    if (this.file) {
      file = this.file.replace(/\.jsonl$/, '.summary.json');
      try {
        fs.writeFileSync(file, JSON.stringify(summary, null, 2), 'utf8');
      } catch (err) {
        console.warn('[ShowRecorder] 写汇总失败:', (err as Error).message);
        file = null;
      }
    }
    return { summary, file };
  }

  private push(record: ShowRecord): void {
    this.records.push(record);
    if (!this.file) return;
    try {
      fs.appendFileSync(this.file, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      console.warn('[ShowRecorder] 写记录失败:', (err as Error).message);
    }
  }
}
