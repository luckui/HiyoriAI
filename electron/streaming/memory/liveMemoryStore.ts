/**
 * 直播记忆的存储：观众档案、每场回顾、直播间的梗、她自己的口味。存在单独的 SQLite（userData/live-memory.db），
 * 不进主人的私人记忆（electron/memory/）——观众多、内容公开，两者的容量和隐私要求都不一样。
 *
 * 直播中只做便宜的记录（谁来了、说了什么，每人每场最多留 MAX_LINES 句）；
 * 下播后由 liveMemoryDistill.ts 一次性请 LLM 提炼成要点，写回这里。
 *
 * 隐私：uid 为空或被平台打码的观众不建档；观众说「忘了我」就删档并记下 optOut，以后不再记录。
 * 只存观众在直播间公开说的话。
 */

import Database from 'better-sqlite3';
import type { LivePlatform } from '../../../shared/types/live';

/** 每位观众每场最多留几句原话（给下播提炼用） */
export const MAX_LINES = 12;
/** 每位观众最多几条要点、每条多长 */
export const MAX_NOTES = 5;
export const MAX_NOTE_CHARS = 60;
/** 超过这么久没来的观众，只保留基本信息（要点清掉） */
export const FORGET_AFTER_MS = 90 * 24 * 3600_000;

export interface ViewerNote {
  text: string;
  /** 最近一次被提到（提炼出来或再次聊到）的时间 */
  at: number;
}

export interface ViewerRecord {
  platform: LivePlatform;
  uid: string;
  names: string[];
  firstSeen: number;
  lastSeen: number;
  /** 来过几场 */
  visits: number;
  /** 上一次来是哪一场 */
  lastStreamId: number | null;
  giftYuan: number;
  guardLevel: number;
  /** 她对这位观众的称呼 */
  nickname: string | null;
  /** 观众鉴定的结果（T4 写入），原样存 JSON */
  appraisal: unknown;
  notes: ViewerNote[];
}

export interface StreamRecord {
  id: number;
  startedAt: number;
  endedAt: number | null;
  /** 回顾：5–10 行要点 */
  recap: string[];
  distilled: boolean;
}

export interface MemeRecord {
  id: number;
  text: string;
  sourceStream: number | null;
  createdAt: number;
  lastMentioned: number;
}

export type TasteKind = 'like' | 'dislike' | 'follow';

export interface TasteRecord {
  id: number;
  kind: TasteKind;
  subject: string;
  reason: string;
  updatedAt: number;
}

interface ViewerRow {
  platform: string; uid: string; names: string; first_seen: number; last_seen: number; visits: number;
  last_stream: number | null; gift_yuan: number; guard_level: number; nickname: string | null; appraisal: string | null; notes: string;
}

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class LiveMemoryStore {
  private readonly db: Database.Database;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS viewers (
        platform    TEXT    NOT NULL,
        uid         TEXT    NOT NULL,
        names       TEXT    NOT NULL DEFAULT '[]',
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL,
        visits      INTEGER NOT NULL DEFAULT 0,
        last_stream INTEGER,
        gift_yuan   REAL    NOT NULL DEFAULT 0,
        guard_level INTEGER NOT NULL DEFAULT 0,
        nickname    TEXT,
        appraisal   TEXT,
        notes       TEXT    NOT NULL DEFAULT '[]',
        PRIMARY KEY (platform, uid)
      );
      CREATE TABLE IF NOT EXISTS opt_out (
        platform TEXT    NOT NULL,
        uid      TEXT    NOT NULL,
        at       INTEGER NOT NULL,
        PRIMARY KEY (platform, uid)
      );
      CREATE TABLE IF NOT EXISTS viewer_lines (
        platform  TEXT    NOT NULL,
        uid       TEXT    NOT NULL,
        stream_id INTEGER NOT NULL,
        at        INTEGER NOT NULL,
        text      TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_viewer_lines ON viewer_lines(stream_id, platform, uid);
      CREATE TABLE IF NOT EXISTS streams (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER,
        recap      TEXT    NOT NULL DEFAULT '[]',
        distilled  INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memes (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        text           TEXT    NOT NULL UNIQUE,
        source_stream  INTEGER,
        created_at     INTEGER NOT NULL,
        last_mentioned INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tastes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        kind       TEXT    NOT NULL,
        subject    TEXT    NOT NULL,
        reason     TEXT    NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        UNIQUE (kind, subject)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // ── 场次 ─────────────────────────────────────────────

  beginStream(now: number): number {
    return Number(this.db.prepare('INSERT INTO streams (started_at) VALUES (?)').run(now).lastInsertRowid);
  }

  endStream(id: number, now: number): void {
    this.db.prepare('UPDATE streams SET ended_at = ? WHERE id = ?').run(now, id);
  }

  setRecap(id: number, recap: string[]): void {
    this.db.prepare('UPDATE streams SET recap = ?, distilled = 1 WHERE id = ?').run(JSON.stringify(recap), id);
  }

  getStream(id: number): StreamRecord | null {
    const row = this.db.prepare('SELECT * FROM streams WHERE id = ?').get(id) as
      { id: number; started_at: number; ended_at: number | null; recap: string; distilled: number } | undefined;
    return row ? { id: row.id, startedAt: row.started_at, endedAt: row.ended_at, recap: parse(row.recap, []), distilled: !!row.distilled } : null;
  }

  /** 已经结束、还没提炼的场次（上次提炼失败的也在里面） */
  pendingStreams(): number[] {
    return (this.db.prepare('SELECT id FROM streams WHERE ended_at IS NOT NULL AND distilled = 0 ORDER BY id').all() as Array<{ id: number }>)
      .map((r) => r.id);
  }

  /** 最近一场有回顾的直播（不含 exceptId） */
  lastRecappedStream(exceptId?: number): StreamRecord | null {
    const row = this.db.prepare(`SELECT id FROM streams WHERE distilled = 1 AND id != ? ORDER BY started_at DESC LIMIT 1`)
      .get(exceptId ?? -1) as { id: number } | undefined;
    return row ? this.getStream(row.id) : null;
  }

  // ── 观众 ─────────────────────────────────────────────

  isOptedOut(platform: LivePlatform, uid: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM opt_out WHERE platform = ? AND uid = ?').get(platform, uid);
  }

  /** 观众出现（进场、发言、送礼）：建档或更新；返回这是不是本场第一次出现 */
  touchViewer(platform: LivePlatform, uid: string, name: string, streamId: number, now: number): { firstThisStream: boolean } {
    const row = this.db.prepare('SELECT names, last_stream FROM viewers WHERE platform = ? AND uid = ?').get(platform, uid) as
      Pick<ViewerRow, 'names' | 'last_stream'> | undefined;
    if (!row) {
      this.db.prepare(`INSERT INTO viewers (platform, uid, names, first_seen, last_seen, visits, last_stream)
        VALUES (?, ?, ?, ?, ?, 1, ?)`).run(platform, uid, JSON.stringify(name ? [name] : []), now, now, streamId);
      return { firstThisStream: true };
    }
    const names = parse<string[]>(row.names, []);
    if (name && names[names.length - 1] !== name) {
      // 历史昵称：最近的在最后，最多留 5 个
      const next = [...names.filter((n) => n !== name), name].slice(-5);
      this.db.prepare('UPDATE viewers SET names = ? WHERE platform = ? AND uid = ?').run(JSON.stringify(next), platform, uid);
    }
    const firstThisStream = row.last_stream !== streamId;
    this.db.prepare(`UPDATE viewers SET last_seen = ?, visits = visits + ?, last_stream = ? WHERE platform = ? AND uid = ?`)
      .run(now, firstThisStream ? 1 : 0, streamId, platform, uid);
    return { firstThisStream };
  }

  /** 这位观众在本场说的话，只留最近 MAX_LINES 句 */
  addLine(platform: LivePlatform, uid: string, streamId: number, text: string, now: number): void {
    this.db.prepare('INSERT INTO viewer_lines (platform, uid, stream_id, at, text) VALUES (?, ?, ?, ?, ?)')
      .run(platform, uid, streamId, now, text);
    this.db.prepare(`DELETE FROM viewer_lines WHERE rowid IN (
      SELECT rowid FROM viewer_lines WHERE platform = ? AND uid = ? AND stream_id = ? ORDER BY at DESC LIMIT -1 OFFSET ?)`)
      .run(platform, uid, streamId, MAX_LINES);
  }

  addGift(platform: LivePlatform, uid: string, yuan: number, guardLevel?: number): void {
    this.db.prepare(`UPDATE viewers SET gift_yuan = gift_yuan + ?,
      guard_level = CASE WHEN ? > 0 AND (guard_level = 0 OR ? < guard_level) THEN ? ELSE guard_level END
      WHERE platform = ? AND uid = ?`).run(yuan, guardLevel ?? 0, guardLevel ?? 0, guardLevel ?? 0, platform, uid);
  }

  getViewer(platform: LivePlatform, uid: string): ViewerRecord | null {
    const row = this.db.prepare('SELECT * FROM viewers WHERE platform = ? AND uid = ?').get(platform, uid) as ViewerRow | undefined;
    return row ? toViewer(row) : null;
  }

  /** 本场说过话的观众和他们的原话 */
  streamLines(streamId: number): Array<{ platform: LivePlatform; uid: string; lines: string[] }> {
    const rows = this.db.prepare('SELECT platform, uid, text FROM viewer_lines WHERE stream_id = ? ORDER BY at').all(streamId) as
      Array<{ platform: LivePlatform; uid: string; text: string }>;
    const byViewer = new Map<string, { platform: LivePlatform; uid: string; lines: string[] }>();
    for (const r of rows) {
      const key = `${r.platform}:${r.uid}`;
      const entry = byViewer.get(key) ?? { platform: r.platform, uid: r.uid, lines: [] };
      entry.lines.push(r.text);
      byViewer.set(key, entry);
    }
    return [...byViewer.values()];
  }

  /** 提炼完的原话就不留了 */
  dropStreamLines(streamId: number): void {
    this.db.prepare('DELETE FROM viewer_lines WHERE stream_id = ?').run(streamId);
  }

  setNotes(platform: LivePlatform, uid: string, notes: ViewerNote[], nickname?: string | null): void {
    const trimmed = notes.slice(-MAX_NOTES).map((n) => ({ text: n.text.slice(0, MAX_NOTE_CHARS), at: n.at }));
    if (nickname === undefined) {
      this.db.prepare('UPDATE viewers SET notes = ? WHERE platform = ? AND uid = ?').run(JSON.stringify(trimmed), platform, uid);
    } else {
      this.db.prepare('UPDATE viewers SET notes = ?, nickname = ? WHERE platform = ? AND uid = ?')
        .run(JSON.stringify(trimmed), nickname, platform, uid);
    }
  }

  setAppraisal(platform: LivePlatform, uid: string, appraisal: unknown): void {
    this.db.prepare('UPDATE viewers SET appraisal = ? WHERE platform = ? AND uid = ?').run(JSON.stringify(appraisal), platform, uid);
  }

  /** 观众要求忘掉他：删档、删原话，记下以后不再记录 */
  forgetViewer(platform: LivePlatform, uid: string, now: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM viewers WHERE platform = ? AND uid = ?').run(platform, uid);
      this.db.prepare('DELETE FROM viewer_lines WHERE platform = ? AND uid = ?').run(platform, uid);
      this.db.prepare('INSERT OR REPLACE INTO opt_out (platform, uid, at) VALUES (?, ?, ?)').run(platform, uid, now);
    })();
  }

  /** 淡化：太久没来的观众只留基本信息 */
  fadeViewers(now: number): number {
    return this.db.prepare(`UPDATE viewers SET notes = '[]', nickname = NULL, appraisal = NULL WHERE last_seen < ? AND (notes != '[]' OR nickname IS NOT NULL OR appraisal IS NOT NULL)`)
      .run(now - FORGET_AFTER_MS).changes;
  }

  // ── 梗与口味 ─────────────────────────────────────────

  addMeme(text: string, streamId: number | null, now: number): void {
    this.db.prepare(`INSERT INTO memes (text, source_stream, created_at, last_mentioned) VALUES (?, ?, ?, ?)
      ON CONFLICT(text) DO UPDATE SET last_mentioned = excluded.last_mentioned`).run(text, streamId, now, now);
  }

  touchMeme(id: number, now: number): void {
    this.db.prepare('UPDATE memes SET last_mentioned = ? WHERE id = ?').run(now, id);
  }

  memes(): MemeRecord[] {
    return (this.db.prepare('SELECT * FROM memes ORDER BY last_mentioned DESC').all() as
      Array<{ id: number; text: string; source_stream: number | null; created_at: number; last_mentioned: number }>)
      .map((r) => ({ id: r.id, text: r.text, sourceStream: r.source_stream, createdAt: r.created_at, lastMentioned: r.last_mentioned }));
  }

  upsertTaste(kind: TasteKind, subject: string, reason: string, now: number): void {
    // 同一件事换了态度（喜欢 ↔ 讨厌）：旧的删掉
    this.db.prepare(`DELETE FROM tastes WHERE subject = ? AND kind != ? AND kind != 'follow' AND ? != 'follow'`).run(subject, kind, kind);
    this.db.prepare(`INSERT INTO tastes (kind, subject, reason, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(kind, subject) DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at`).run(kind, subject, reason, now);
  }

  tastes(kind?: TasteKind): TasteRecord[] {
    const rows = (kind
      ? this.db.prepare('SELECT * FROM tastes WHERE kind = ? ORDER BY updated_at DESC').all(kind)
      : this.db.prepare('SELECT * FROM tastes ORDER BY updated_at DESC').all()) as
      Array<{ id: number; kind: TasteKind; subject: string; reason: string; updated_at: number }>;
    return rows.map((r) => ({ id: r.id, kind: r.kind, subject: r.subject, reason: r.reason, updatedAt: r.updated_at }));
  }

  // ── 维护 ─────────────────────────────────────────────

  counts(): { viewers: number; streams: number; memes: number; tastes: number } {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      viewers: n('SELECT COUNT(*) AS n FROM viewers'),
      streams: n('SELECT COUNT(*) AS n FROM streams'),
      memes: n('SELECT COUNT(*) AS n FROM memes'),
      tastes: n('SELECT COUNT(*) AS n FROM tastes'),
    };
  }

  /** 设置页「清空直播记忆」：opt_out 名单保留（说过别记我的人，清空后也不该再记） */
  clearAll(): void {
    this.db.exec('DELETE FROM viewers; DELETE FROM viewer_lines; DELETE FROM streams; DELETE FROM memes; DELETE FROM tastes;');
  }
}

function toViewer(row: ViewerRow): ViewerRecord {
  return {
    platform: row.platform as LivePlatform,
    uid: row.uid,
    names: parse(row.names, []),
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    visits: row.visits,
    lastStreamId: row.last_stream,
    giftYuan: row.gift_yuan,
    guardLevel: row.guard_level,
    nickname: row.nickname,
    appraisal: parse(row.appraisal, null),
    notes: parse(row.notes, []),
  };
}
