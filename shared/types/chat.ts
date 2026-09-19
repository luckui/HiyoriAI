/**
 * 对话与实时事件的数据结构：主进程产生、经 IPC 推给渲染层展示。
 * 两边都从这里 import，保证结构只有一份定义。
 */

// ── 对话与消息 ───────────────────────────────────────────

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

/** chat:send 的返回 */
export interface ChatReply {
  content: string;
  created_at: number;
  turnId?: string;
}

/** 异步任务 / 定时提醒完成后，主进程请求渲染层开启新一轮对话 */
export interface WakeupPayload {
  conversationId: string;
  text: string;
  replyTarget?: unknown;
  trigger?: unknown;
}

/** Minecraft 等外部渠道完成的一轮对话，同步显示到桌面窗口 */
export interface ExternalTurn {
  conversationId: string;
  user: string;
  assistant: string;
  createdAt: number;
}

// ── AI 工作过程 ──────────────────────────────────────────

/** 单次工具调用的调试记录（推送给渲染层展示） */
export interface ToolCallEvent {
  /** 工具名，如 browser_click_smart */
  name: string;
  /** 解析后的参数对象 */
  args: Record<string, unknown>;
  /** 执行结果文字（截取前 300 字） */
  result: string;
  /** true = ✅ 成功；false = ❌ 失败 / ⏸️ 暂停 */
  ok: boolean;
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** 工具调用来源对话ID（用于区分跨对话工具调用） */
  conversationId?: string;
}

/** 终端块：命令执行的实时输出，同一 blockId 持续追加 */
export interface TerminalBlockEvent {
  blockId: string;
  title?: string;
  line?: string;
  status?: 'running' | 'idle' | 'done' | 'error';
}

// ── 听觉 ────────────────────────────────────────────────

export interface TranscriptionResult {
  text: string;
  start: number;
  end: number;
  is_final: boolean;
  language: string;
  timestamp: number;
}
