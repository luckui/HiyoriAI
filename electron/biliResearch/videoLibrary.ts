/**
 * 视频档案：一个视频的详情、热评和全文字幕，存在 userData/bili-videos/<BV号>.json，
 * 旁边一份 <BV号>.txt（带时间戳的纯文本），直播以外做研究也能直接拿来用。
 *
 * 字幕优先用 B 站接口（AI 字幕登录后就有）；没有就下载音频、用本地 faster-whisper 转写前 10 分钟
 * （stt-server/transcribe_file.py；STT 没装就跳过，只用简介）。
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BiliComment, BiliVideo, BiliVideoClient, TranscriptLine, VideoDanmaku } from '../streaming/platforms/bilibili/biliVideo';

export type TranscriptSource = 'subtitle' | 'asr' | 'none';

/** 弹幕最密的一段：从哪开始、多少条、观众在刷什么 */
export interface DanmakuPeak {
  fromSec: number;
  toSec: number;
  count: number;
  /** 全视频弹幕数（抽样） */
  total: number;
  samples: string[];
}

export interface VideoDossier {
  video: BiliVideo;
  comments: BiliComment[];
  peak?: DanmakuPeak | null;
  transcript: { source: TranscriptSource; lines: TranscriptLine[] };
  fetchedAt: number;
}

export interface AsrCommand {
  python: string;
  script: string;
  model: string;
  language: string;
}

/** 转写超时：音频时长的一半再加五分钟（CPU 上 base 模型大约是实时的 1/5–1/10） */
const asrTimeoutMs = (sec: number) => (sec / 2 + 300) * 1000;

/**
 * 转写策略：
 *   - full：没字幕就整段转写（主人指定要转录的视频）；
 *   - head：没字幕就转前 headSec 秒；
 *   - none：只用 B 站字幕，没有就不转。
 */
export type AsrPolicy = { mode: 'full' } | { mode: 'head'; headSec: number } | { mode: 'none' };

/** 处理过程的一行输出（舞台的终端里显示）；id 相同的行原地更新（进度条） */
export interface LibraryLog {
  text: string;
  id?: string;
}

export interface DossierOptions {
  asr: AsrPolicy;
  log?: (line: LibraryLog) => void;
}
/** 档案多久以内直接用缓存（热评和数据会变，字幕不会） */
const FRESH_MS = 6 * 3600_000;

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export class VideoLibrary {
  constructor(
    private readonly client: BiliVideoClient,
    private readonly dir: string,
    private readonly asr: () => Promise<AsrCommand | null>,
  ) {}

  private file(bvid: string, ext: string): string {
    return path.join(this.dir, `${bvid}.${ext}`);
  }

  cached(bvid: string): VideoDossier | null {
    try {
      return JSON.parse(fs.readFileSync(this.file(bvid, 'json'), 'utf8')) as VideoDossier;
    } catch {
      return null;
    }
  }

  /**
   * 查齐一个视频：详情、热评、弹幕高峰、字幕（按策略转写）。
   * 详情查不到会抛错（视频没了、被风控）；字幕、弹幕、热评查不到不算失败。
   */
  async dossier(bvid: string, opts: DossierOptions, now = Date.now()): Promise<VideoDossier> {
    const log = opts.log ?? (() => {});
    const old = this.cached(bvid);
    // 转写过的（或这次也不打算转写的）直接用缓存
    if (old && now - old.fetchedAt < FRESH_MS && (old.transcript.source !== 'none' || opts.asr.mode === 'none')) {
      log({ text: `[cache] ${bvid} 用 ${Math.round((now - old.fetchedAt) / 60_000)} 分钟前的档案` });
      return old;
    }

    log({ text: `[fetch] x/web-interface/view ${bvid}` });
    const video = await this.client.video(bvid);
    log({ text: `[info]  《${video.title.slice(0, 30)}》 ${video.upName} · ${clock(video.duration)} · ▶${video.stat.view} 👍${video.stat.like}` });
    const comments = await this.client.hotComments(video.aid, 6).catch(() => old?.comments ?? []);
    log({ text: `[reply] 热评 ${comments.length} 条` });
    const peak = await this.client.danmaku(video.cid).then(
      (list) => {
        const p = danmakuPeak(list, video.duration);
        log({ text: p ? `[dm]    弹幕 ${list.length} 条，最密 ${clock(p.fromSec)}–${clock(p.toSec)}（${p.count} 条）` : `[dm]    弹幕 ${list.length} 条` });
        return p;
      },
      (err) => {
        log({ text: `[dm]    弹幕取不到：${(err as Error).message}` });
        return null;
      },
    );
    let transcript = old && old.transcript.source !== 'none' ? old.transcript : null;
    if (!transcript) {
      const subs = await this.client.subtitles(video.bvid, video.cid).catch((err) => {
        log({ text: `[sub]   字幕接口失败：${(err as Error).message}` });
        return null;
      });
      if (subs?.length) {
        transcript = { source: 'subtitle', lines: subs };
        log({ text: `[sub]   B 站字幕 ${subs.length} 行` });
      }
    }
    if (!transcript) {
      const lines = opts.asr.mode === 'none' ? null : await this.transcribe(video, opts.asr, log).catch((err) => {
        log({ text: `[asr]   转写失败：${(err as Error).message}` });
        return null;
      });
      transcript = lines?.length ? { source: 'asr', lines } : { source: 'none', lines: [] };
    }
    const dossier: VideoDossier = { video, comments, peak, transcript, fetchedAt: now };
    this.save(dossier);
    log({ text: `[save]  bili-videos/${bvid}.txt` });
    return dossier;
  }

  get folder(): string {
    return this.dir;
  }

  private save(d: VideoDossier): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file(d.video.bvid, 'json'), JSON.stringify(d, null, 1), 'utf8');
      const v = d.video;
      const header = [
        `# ${v.title}`,
        `UP 主：${v.upName}（${v.upMid}）  分区：${v.tname}  时长：${clock(v.duration)}`,
        `https://www.bilibili.com/video/${v.bvid}`,
        `字幕来源：${{ subtitle: 'B 站字幕', asr: '本地转写', none: '无' }[d.transcript.source]}`,
        '',
      ];
      const body = d.transcript.lines.map((l) => `[${clock(l.from)}] ${l.text}`);
      fs.writeFileSync(this.file(v.bvid, 'txt'), [...header, ...body].join('\n') + '\n', 'utf8');
    } catch (err) {
      console.warn('[VideoLibrary] 保存档案失败:', (err as Error).message);
    }
  }

  /** 没字幕：下载音频，交给本地 faster-whisper 转写 */
  private async transcribe(video: BiliVideo, policy: AsrPolicy, log: (line: LibraryLog) => void): Promise<TranscriptLine[] | null> {
    const cmd = await this.asr();
    if (!cmd || !fs.existsSync(cmd.script)) {
      log({ text: '[asr]   没有字幕，语音识别（STT）还没装，跳过转写' });
      return null;
    }
    const url = await this.client.audioUrl(video.bvid, video.cid);
    if (!url) return null;
    log({ text: '[audio] 下载音频…' });
    const tmp = path.join(os.tmpdir(), `hiyori-${video.bvid}.m4s`);
    fs.writeFileSync(tmp, await this.client.download(url));
    const maxSec = policy.mode === 'head' ? Math.min(policy.headSec, video.duration) : video.duration;
    try {
      return await runAsr(cmd, tmp, policy.mode === 'head' ? policy.headSec : 0, maxSec, (line, at) => {
        const pct = Math.min(100, Math.round((at / Math.max(1, maxSec)) * 100));
        const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '░');
        log({ id: `asr-${video.bvid}`, text: `[asr]   ${bar} ${pct}%  ${clock(at)}/${clock(maxSec)}` });
        // 偶尔露一小截转出来的字
        if (line && Math.random() < 0.2) log({ text: `        ${clock(at)}  ${line.slice(0, 24)}` });
      });
    } finally {
      fs.rm(tmp, { force: true }, () => {});
    }
  }
}

/** maxSec 为 0 表示整段；durationSec 用来定超时和算进度 */
export function runAsr(
  cmd: AsrCommand,
  file: string,
  maxSec: number,
  durationSec: number,
  onLine?: (text: string, atSec: number) => void,
): Promise<TranscriptLine[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.python, [cmd.script, '--file', file, '--max-sec', String(maxSec), '--model', cmd.model, '--language', cmd.language], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const lines: TranscriptLine[] = [];
    let buf = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('转写超时')); }, asrTimeoutMs(durationSec));
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const p of parts) {
        try {
          const row = JSON.parse(p) as { from?: number; to?: number; text?: string; done?: boolean };
          if (row.done) done = true;
          else if (row.text) {
            lines.push({ from: row.from ?? 0, to: row.to ?? 0, text: row.text });
            onLine?.(row.text, row.to ?? 0);
          }
        } catch {
          // 模型下载进度之类的输出
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString('utf8')).slice(-2000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (done || lines.length) resolve(lines);
      else reject(new Error(`转写进程退出 ${code}：${err.trim().split('\n').pop() ?? ''}`));
    });
  });
}

/** 一段时间里的字幕（播放片段用） */
export function linesBetween(lines: TranscriptLine[], from: number, to: number): TranscriptLine[] {
  return lines.filter((l) => l.to > from && l.from < to);
}

/** 字幕拼成一段文字，截到 maxChars */
export function transcriptText(lines: TranscriptLine[], maxChars: number): string {
  let out = '';
  for (const l of lines) {
    if (out.length + l.text.length + 1 > maxChars) break;
    out += (out ? ' ' : '') + l.text;
  }
  return out;
}

const PEAK_WINDOW_SEC = 30;

/** 弹幕最密的 30 秒（片头 5% 不算，常是「来了」「前排」）；弹幕太少返回 null */
export function danmakuPeak(list: VideoDanmaku[], duration: number): DanmakuPeak | null {
  if (list.length < 20 || duration < PEAK_WINDOW_SEC) return null;
  const times = list.map((d) => d.t).sort((a, b) => a - b);
  const skip = duration * 0.05;
  let best = { from: -1, count: 0 };
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    if (times[i] < skip || times[i] > duration - 5) continue;
    if (j < i) j = i;
    while (j < times.length && times[j] < times[i] + PEAK_WINDOW_SEC) j++;
    if (j - i > best.count) best = { from: times[i], count: j - i };
  }
  if (best.from < 0) return null;
  const from = Math.floor(best.from);
  const inside = list.filter((d) => d.t >= from && d.t < from + PEAK_WINDOW_SEC).map((d) => d.text.trim()).filter(Boolean);
  // 刷得最多的几句放前面
  const counts = new Map<string, number>();
  for (const t of inside) counts.set(t, (counts.get(t) ?? 0) + 1);
  const samples = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => (n > 1 ? `${t}（×${n}）` : t));
  return { fromSec: from, toSec: from + PEAK_WINDOW_SEC, count: best.count, total: list.length, samples };
}
