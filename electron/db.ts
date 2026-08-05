/// <reference types="node" />
import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'path';
import { randomUUID } from 'crypto';

// ── 类型定义 ──────────────────────────────────────────────

export interface Conversation {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface ConversationWithPreview extends Conversation {
  preview: string;
}

export interface DBMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: number;
}

export interface MemoryFragment {
  id: string;
  conversation_id: string;
  /** 精简摘要文本 */
  content: string;
  /** 本片段归纳的 user+assistant 消息累计偏移终点 */
  msg_offset_end: number;
  created_at: number;
}

// ── 数据库实例 ────────────────────────────────────────────

let db: Database.Database;

// ── 初始化 ────────────────────────────────────────────────

export function initDatabase(): void {
  const dbPath = join(app.getPath('userData'), 'hiyori-chat.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id         TEXT    PRIMARY KEY,
      title      TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT    PRIMARY KEY,
      conversation_id TEXT    NOT NULL,
      role            TEXT    NOT NULL,
      content         TEXT    NOT NULL,
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv
      ON messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_fragments (
      id              TEXT    PRIMARY KEY,
      conversation_id TEXT    NOT NULL,
      content         TEXT    NOT NULL,
      msg_offset_end  INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_memory_conv
      ON memory_fragments(conversation_id, created_at);

    -- ── 异步任务管理 ──────────────────────────────────────
    CREATE TABLE IF NOT EXISTS tasks (
      id              TEXT    PRIMARY KEY,
      conversation_id TEXT,
      type            TEXT    NOT NULL DEFAULT 'background',
      status          TEXT    NOT NULL DEFAULT 'pending',
      title           TEXT    NOT NULL,
      prompt          TEXT    NOT NULL,
      context         TEXT,
      result          TEXT,
      error           TEXT,
      progress        REAL    DEFAULT 0,
      progress_text   TEXT,
      created_at      INTEGER NOT NULL,
      started_at      INTEGER,
      completed_at    INTEGER,
      parent_task_id  TEXT,
      metadata        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status
      ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent
      ON tasks(parent_task_id);

    -- ── 定时调度 ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS schedules (
      id            TEXT    PRIMARY KEY,
      task_title    TEXT    NOT NULL,
      prompt        TEXT    NOT NULL,
      schedule_type TEXT    NOT NULL,
      cron_expr     TEXT,
      interval_ms   INTEGER,
      run_at        INTEGER,
      enabled       INTEGER NOT NULL DEFAULT 1,
      last_run_at   INTEGER,
      next_run_at   INTEGER,
      repeat_limit  INTEGER,
      repeat_count  INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      metadata      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_enabled
      ON schedules(enabled, next_run_at);
  `);
}

// ── Settings 键值存储 ─────────────────────────────────────

export function getSetting(key: string): string | null {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

// ── 结构化全局记忆（Hermes 风格分块）──────────────────────

/** 结构化记忆接口（Hermes 风格：USER + MEMORY 双文件） */
export interface StructuredGlobalMemory {
  /** 用户画像（偏好、习惯、沟通风格） */
  user: string[];
  /** 环境配置和工具经验（系统信息、工具特性、项目约定） */
  memory: string[];
}

/** 读取结构化全局记忆（返回条目数组）
 * 【兼容性】如果结构化字段为空，fallback 到旧 global_memory 字段 */
export function getStructuredGlobalMemory(): StructuredGlobalMemory {
  const userRaw = getSetting('global_memory_user');
  const memoryRaw = getSetting('global_memory_main');
  
  const user = userRaw ? userRaw.split('§').map(s => s.trim()).filter(Boolean) : [];
  const memory = memoryRaw ? memoryRaw.split('§').map(s => s.trim()).filter(Boolean) : [];
  
  // 如果结构化字段都为空，fallback 到旧的 global_memory
  if (user.length === 0 && memory.length === 0) {
    const legacy = getSetting('global_memory');
    if (legacy?.trim()) {
      // 将旧记忆临时归入 MEMORY 块（环境配置）
      return { user: [], memory: [legacy.trim()] };
    }
  }
  
  return { user, memory };
}

/** 写入结构化全局记忆（条目数组）
 * 【兼容性】同时更新旧 global_memory 字段，保持 memory tool 可读性 */
export function setStructuredGlobalMemory(data: StructuredGlobalMemory): void {
  setSetting('global_memory_user', data.user.join('§'));
  setSetting('global_memory_main', data.memory.join('§'));
  
  // 同步写入旧字段（memory tool 兼容性）
  const allEntries = [...data.user, ...data.memory];
  setSetting('global_memory', allEntries.join('§'));
}

// ── 对话 CRUD ─────────────────────────────────────────────

export function createConversation(title = '新对话'): Conversation {
  const conv: Conversation = {
    id: randomUUID(),
    title,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  db.prepare(
    'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(conv.id, conv.title, conv.created_at, conv.updated_at);
  return conv;
}

export function listConversations(): ConversationWithPreview[] {
  return db.prepare(`
    SELECT
      c.*,
      COALESCE(
        (SELECT content FROM messages
         WHERE conversation_id = c.id AND role != 'system'
         ORDER BY created_at DESC LIMIT 1),
        ''
      ) AS preview
    FROM conversations c
    ORDER BY c.updated_at DESC
  `).all() as ConversationWithPreview[];
}

export function renameConversation(id: string, title: string): void {
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
}

export function deleteConversation(id: string): void {
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

// ── 消息 CRUD ─────────────────────────────────────────────

export function getMessages(conversationId: string): DBMessage[] {
  return db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(conversationId) as DBMessage[];
}

export function addMessage(msg: Omit<DBMessage, 'id' | 'created_at'>): DBMessage {
  const full: DBMessage = { ...msg, id: randomUUID(), created_at: Date.now() };
  db.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(full.id, full.conversation_id, full.role, full.content, full.created_at);
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(
    full.created_at,
    msg.conversation_id
  );
  return full;
}

/**
 * 获取最近 N 轮上下文消息（user + assistant，不含 system），时间升序。
 * N 轮 = 最多 N*2 条消息。
 */
export function getRecentContext(conversationId: string, rounds: number): DBMessage[] {
  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ? AND role != 'system'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(conversationId, rounds * 2) as DBMessage[];
  return rows.reverse();
}

// ── 记忆片段 CRUD ─────────────────────────────────────────

/** 获取一个对话的所有记忆片段，按时间升序（旧 → 新） */
export function getMemoryFragments(conversationId: string): MemoryFragment[] {
  return db.prepare(
    'SELECT * FROM memory_fragments WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(conversationId) as MemoryFragment[];
}

/** 新增一条记忆片段 */
export function addMemoryFragment(
  data: Omit<MemoryFragment, 'id' | 'created_at'>
): MemoryFragment {
  const fragment: MemoryFragment = {
    ...data,
    id: randomUUID(),
    created_at: Date.now(),
  };
  db.prepare(
    'INSERT INTO memory_fragments (id, conversation_id, content, msg_offset_end, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(fragment.id, fragment.conversation_id, fragment.content, fragment.msg_offset_end, fragment.created_at);
  return fragment;
}

/**
 * 智能分词：自动识别中文并切分
 * @param text - 输入文本
 * @returns 关键词数组
 * 
 * @example
 * smartTokenize("上海天气") → ["上海", "天气"]（2-gram 中文切分）
 * smartTokenize("上海 天气") → ["上海", "天气"]（保留空格分隔）
 * smartTokenize("Discord上海") → ["Discord", "上海"]（混合文本）
 */
export function smartTokenize(text: string): string[] {
  // 1️⃣ 先按空格、逗号、顿号分割
  const segments = text.split(/[\s,，、]+/).filter(s => s.trim().length > 0);
  
  const keywords: string[] = [];
  
  for (const seg of segments) {
    // 2️⃣ 检测是否为纯中文（连续汉字 ≥2 个）
    const chineseRegex = /[\u4e00-\u9fa5]/g;
    const chineseChars = seg.match(chineseRegex);
    
    // 如果包含 2 个以上连续汉字，进行 2-gram 切分
    if (chineseChars && chineseChars.length >= 2) {
      // 提取所有汉字连续段
      const chineseBlocks = seg.match(/[\u4e00-\u9fa5]+/g) || [];
      
      for (const block of chineseBlocks) {
        if (block.length === 1) {
          // 单个汉字：直接加入
          keywords.push(block);
        } else if (block.length === 2) {
          // 两个汉字：直接加入（不需要切分）
          keywords.push(block);
        } else {
          // 3+ 汉字：2-gram 切分
          // "上海天气" → ["上海", "海天", "天气"]
          for (let i = 0; i < block.length - 1; i++) {
            keywords.push(block.substring(i, i + 2));
          }
          // 同时保留完整词（提高召回率）
          keywords.push(block);
        }
      }
      
      // 3️⃣ 提取非中文部分（如 "Discord上海" 中的 "Discord"）
      const nonChinese = seg.replace(/[\u4e00-\u9fa5]+/g, '').trim();
      if (nonChinese.length > 0) {
        keywords.push(nonChinese);
      }
    } else {
      // 纯英文/数字，直接加入
      keywords.push(seg);
    }
  }
  
  // 去重（保持顺序）
  return [...new Set(keywords)];
}

/**
 * 搜索所有对话的记忆片段（智能分词搜索 + 相关性优先排序）
 * @param query - 搜索关键词（自动识别中文、支持空格分隔）
 * @param limit - 最多返回条数（默认 20）
 * @returns 匹配的记忆片段（按相关性排序：核心词全匹配 > 匹配数 > 时间）
 * 
 * @example
 * searchMemoryFragments("上海天气") → 自动切分为 ["上海", "天气"]
 * searchMemoryFragments("上海 天气 查询") → ["上海", "天气", "查询"]
 * searchMemoryFragments("Discord上海") → ["Discord", "上海"]
 */
export function searchMemoryFragments(query: string, limit = 20): MemoryFragment[] {
  // 1️⃣ 提取核心关键词（用户原始输入，按空格/逗号分隔）
  const coreKeywords = query.trim().split(/[\s,，、]+/).filter(k => k.length > 0);
  
  // 2️⃣ 智能分词（包含 2-gram，用于提高召回率）
  const allKeywords = smartTokenize(query);
  
  if (allKeywords.length === 0) return [];
  
  // 单个关键词：简单 LIKE 查询
  if (allKeywords.length === 1) {
    const pattern = `%${allKeywords[0]}%`;
    return db.prepare(
      'SELECT * FROM memory_fragments WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?'
    ).all(pattern, limit) as MemoryFragment[];
  }
  
  // 多个关键词：OR 条件查询（匹配任意关键词即可）
  const conditions = allKeywords.map(() => 'content LIKE ?').join(' OR ');
  const patterns = allKeywords.map(k => `%${k}%`);
  
  const allMatches = db.prepare(
    `SELECT * FROM memory_fragments WHERE ${conditions} ORDER BY created_at DESC`
  ).all(...patterns) as MemoryFragment[];
  
  // 3️⃣ 计算相关性得分
  const scored = allMatches.map(frag => {
    const content = frag.content.toLowerCase();
    
    // 核心关键词匹配数（用户原始输入）
    const coreMatchCount = coreKeywords.filter(k => content.includes(k.toLowerCase())).length;
    
    // 所有关键词匹配数（含 2-gram）
    const totalMatchCount = allKeywords.filter(k => content.includes(k.toLowerCase())).length;
    
    // 是否匹配所有核心关键词（最高优先级）
    const isFullCoreMatch = coreMatchCount === coreKeywords.length;
    
    return { 
      ...frag, 
      isFullCoreMatch,     // 核心词全匹配标志
      coreMatchCount,      // 核心词匹配数
      totalMatchCount      // 总匹配数
    };
  });
  
  // 4️⃣ 按相关性排序（优先级：核心词全匹配 > 核心词匹配数 > 总匹配数 > 时间）
  scored.sort((a, b) => {
    // 优先级 1：核心词全匹配的排最前
    if (a.isFullCoreMatch !== b.isFullCoreMatch) {
      return a.isFullCoreMatch ? -1 : 1;
    }
    
    // 优先级 2：核心词匹配数多的在前
    if (a.coreMatchCount !== b.coreMatchCount) {
      return b.coreMatchCount - a.coreMatchCount;
    }
    
    // 优先级 3：总匹配数多的在前
    if (a.totalMatchCount !== b.totalMatchCount) {
      return b.totalMatchCount - a.totalMatchCount;
    }
    
    // 优先级 4：时间新的在前
    return b.created_at - a.created_at;
  });
  
  // 返回前 limit 条（移除得分字段）
  return scored.slice(0, limit).map(({ isFullCoreMatch, coreMatchCount, totalMatchCount, ...frag }) => frag as MemoryFragment);
}

/**
 * 统计一个对话中 user + assistant 消息总数（不含 system）。
 * 用于判断是否已积累足够消息触发记忆总结。
 */
export function countNonSystemMessages(conversationId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM messages WHERE conversation_id = ? AND role IN ('user', 'assistant')"
  ).get(conversationId) as { count: number };
  return row.count;
}

/**
 * 按偏移量获取一批 user+assistant 消息（用于送入 LLM 总结）。
 * @param offset - 跳过的消息数（= 已总结游标）
 * @param limit  - 本次获取的消息数（= summaryWindowRounds * 2）
 */
export function getMessagesInRange(
  conversationId: string,
  offset: number,
  limit: number
): DBMessage[] {
  return db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ? AND role IN ('user', 'assistant')
    ORDER BY created_at ASC
    LIMIT ? OFFSET ?
  `).all(conversationId, limit, offset) as DBMessage[];
}

/** 读取记忆总结游标（已总结到的消息偏移） */
export function getMemoryCursor(conversationId: string): number {
  const val = getSetting(`mem_cursor_${conversationId}`);
  return val ? parseInt(val, 10) : 0;
}

/** 更新记忆总结游标 */
export function setMemoryCursor(conversationId: string, cursor: number): void {
  setSetting(`mem_cursor_${conversationId}`, String(cursor));
}

// ── 全局核心记忆 ──────────────────────────────────────────

/** 读取全局核心记忆文本（不存在时返回 null）【遗留 API，建议迁移到 getStructuredGlobalMemory】 */
export function getGlobalMemory(): string | null {
  return getSetting('global_memory');
}

/** 更新全局核心记忆文本 */
export function setGlobalMemory(content: string): void {
  setSetting('global_memory', content);
}

/**
 * 读取「某对话已有多少条 memory_fragment 被纳入全局记忆」的游标。
 * 用于防止对同一片段重复精炼。
 */
export function getGlobalMemoryCursor(conversationId: string): number {
  const val = getSetting(`global_mem_cursor_${conversationId}`);
  return val ? parseInt(val, 10) : 0;
}

/** 更新全局记忆游标 */
export function setGlobalMemoryCursor(conversationId: string, n: number): void {
  setSetting(`global_mem_cursor_${conversationId}`, String(n));
}

// ── 异步任务 CRUD ─────────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskType = 'background' | 'delegate' | 'batch' | 'cron';

export interface DBTask {
  id: string;
  conversation_id: string | null;
  type: TaskType;
  status: TaskStatus;
  title: string;
  prompt: string;
  context: string | null;       // JSON
  result: string | null;
  error: string | null;
  progress: number;             // 0.0 ~ 1.0
  progress_text: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  parent_task_id: string | null;
  metadata: string | null;      // JSON
}

export function createTask(task: Omit<DBTask, 'id' | 'created_at' | 'started_at' | 'completed_at' | 'result' | 'error' | 'progress' | 'progress_text'>): DBTask {
  const full: DBTask = {
    ...task,
    id: randomUUID(),
    result: null,
    error: null,
    progress: 0,
    progress_text: null,
    created_at: Date.now(),
    started_at: null,
    completed_at: null,
  };
  db.prepare(`
    INSERT INTO tasks (id, conversation_id, type, status, title, prompt, context, result, error, progress, progress_text, created_at, started_at, completed_at, parent_task_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    full.id, full.conversation_id, full.type, full.status, full.title, full.prompt,
    full.context, full.result, full.error, full.progress, full.progress_text,
    full.created_at, full.started_at, full.completed_at, full.parent_task_id, full.metadata
  );
  return full;
}

export function getTask(taskId: string): DBTask | null {
  return (db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as DBTask) ?? null;
}

export function listTasks(filter?: { status?: TaskStatus; conversationId?: string; parentTaskId?: string }): DBTask[] {
  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params: unknown[] = [];
  if (filter?.status) { sql += ' AND status = ?'; params.push(filter.status); }
  if (filter?.conversationId) { sql += ' AND conversation_id = ?'; params.push(filter.conversationId); }
  if (filter?.parentTaskId) { sql += ' AND parent_task_id = ?'; params.push(filter.parentTaskId); }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params) as DBTask[];
}

export function updateTask(taskId: string, updates: Partial<Pick<DBTask, 'status' | 'result' | 'error' | 'progress' | 'progress_text' | 'started_at' | 'completed_at'>>): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) { sets.push(`${key} = ?`); params.push(val); }
  }
  if (sets.length === 0) return;
  params.push(taskId);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteTask(taskId: string): void {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
}

// ── 定时调度 CRUD ─────────────────────────────────────────

export type ScheduleType = 'once' | 'interval' | 'cron';

export interface DBSchedule {
  id: string;
  task_title: string;
  prompt: string;
  schedule_type: ScheduleType;
  cron_expr: string | null;
  interval_ms: number | null;
  run_at: number | null;          // 一次性执行时间戳
  enabled: number;                // 0 | 1
  last_run_at: number | null;
  next_run_at: number | null;
  repeat_limit: number | null;    // null = 无限
  repeat_count: number;
  created_at: number;
  metadata: string | null;        // JSON
}

export function createSchedule(sched: Omit<DBSchedule, 'id' | 'created_at' | 'last_run_at' | 'repeat_count'>): DBSchedule {
  const full: DBSchedule = {
    ...sched,
    id: randomUUID(),
    last_run_at: null,
    repeat_count: 0,
    created_at: Date.now(),
  };
  db.prepare(`
    INSERT INTO schedules (id, task_title, prompt, schedule_type, cron_expr, interval_ms, run_at, enabled, last_run_at, next_run_at, repeat_limit, repeat_count, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    full.id, full.task_title, full.prompt, full.schedule_type, full.cron_expr,
    full.interval_ms, full.run_at, full.enabled, full.last_run_at, full.next_run_at,
    full.repeat_limit, full.repeat_count, full.created_at, full.metadata
  );
  return full;
}

export function getSchedule(scheduleId: string): DBSchedule | null {
  return (db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId) as DBSchedule) ?? null;
}

export function listSchedules(enabledOnly = true): DBSchedule[] {
  if (enabledOnly) {
    return db.prepare('SELECT * FROM schedules WHERE enabled = 1 ORDER BY created_at DESC').all() as DBSchedule[];
  }
  return db.prepare('SELECT * FROM schedules ORDER BY created_at DESC').all() as DBSchedule[];
}

export function updateSchedule(scheduleId: string, updates: Partial<Omit<DBSchedule, 'id' | 'created_at'>>): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) { sets.push(`${key} = ?`); params.push(val); }
  }
  if (sets.length === 0) return;
  params.push(scheduleId);
  db.prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteSchedule(scheduleId: string): void {
  db.prepare('DELETE FROM schedules WHERE id = ?').run(scheduleId);
}

export function getDueSchedules(now: number): DBSchedule[] {
  return db.prepare(
    'SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?'
  ).all(now) as DBSchedule[];
}
