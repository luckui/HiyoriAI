/**
 * 工具调用 - 核心类型定义
 *
 * 这里定义的类型与 OpenAI function calling 格式完全兼容，
 * 因此对所有 OpenAI-compatible 接口（豆包/DeepSeek/智谱等）均有效。
 */

// ── JSON Schema ───────────────────────────────────────────

export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'integer' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: JSONSchemaProperty;
}

export interface JSONSchemaObject {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
}

// ── 工具 Schema（OpenAI function calling 格式）────────────

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JSONSchemaObject;
  };
}

// ── 工具定义 ──────────────────────────────────────────────

/**
 * 工具定义接口 - 实现一个新工具只需：
 *
 * 1. 新建 `tools/impl/yourTool.ts`，export default 实现此接口
 * 2. 在 `tools/index.ts` 中 `registry.register(yourTool)`
 *
 * 无需修改任何核心逻辑！
 *
 * @typeParam TParams - 工具参数类型，与 schema.function.parameters 保持一致
 */
// ── 工具执行返回值 ────────────────────────────────────────

/**
 * 带图像的工具返回值
 *
 * 当工具需要向 LLM 传递图像时（如截图），返回此类型。
 * aiService 会自动将图像注入为 user 角色的多模态消息，
 * 保证视觉模型能正确「看到」图像内容。
 */
export interface ToolImageResult {
  /** 回填到 tool 角色消息的文字描述 */
  text: string;
  /** Base64 编码的图像原始数据（不含 data URL 前缀） */
  imageBase64: string;
  /** 图像 MIME 类型 */
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

/**
 * 工具暂停结果 —— 用于工具在执行途中遇到需要用户介入的决策节点。
 *
 * 工具执行逻辑检测到关键分支（如"邮箱未登录"、"找不到确认按钮"等）时，
 * 返回此类型代替字符串，registry 会将其格式化为带 ⏸️ 标记的字符串回填给 AI。
 *
 * AI 收到 ⏸️ 后（配合 systemPrompt 中的规范）会：
 *   1. 向用户说明当前情况（userMessage）
 *   2. 等待用户完成操作
 *   3. 按 resumeHint 的提示继续后续步骤
 *
 * @example
 * ```ts
 * // 在 Skill 中检测到未登录时：
 * if (!isLoggedIn) {
 *   return {
 *     __pause: true as const,
 *     trace: steps,
 *     userMessage: '邮箱当前处于未登录状态，无法继续读取邮件。',
 *     resumeHint:  '用户登录后，请重新调用 check_email() 继续任务。',
 *   };
 * }
 * ```
 */
export interface ToolPauseResult {
  /** 固定标识，registry 用此识别工具暂停并格式化 */
  readonly __pause: true;
  /** 已执行步骤的轨迹（每项一行） */
  trace: string[];
  /** 向 AI（进而向用户）说明当前情况 */
  userMessage: string;
  /** 用户完成操作后，AI 应执行的下一步提示 */
  resumeHint: string;
}

/**
 * 工具内部阶段完成后建议 AI 继续执行下一步（不涉及用户介入）。
 *
 * 与 ToolPauseResult 的区别：
 *   ToolPauseResult  → 需要用户操作后才能继续（如手动登录、确认弹窗）
 *   ToolContinuationResult → 工具内部流程未完成，AI 可按 instruction 继续调用下一步工具
 *
 * registry 会将其格式化为 🔄 前缀字符串；
 *
 * @example
 * ```ts
 * // Phase 1 扫描到候选列表，要求 AI 立即选 idx 调用 Phase 2：
 * return {
 *   __continue: true as const,
 *   trace: steps,
 *   instruction: `找到 ${candidates.length} 个候选，请立即从中选择 idx 并调用 Phase 2。`,
 *   candidates: topN,   // 可选，结构化候选列表供 AI 参考
 * };
 * ```
 */
export interface ToolContinuationResult {
  /** 固定标识，registry 用此识别工具继续并格式化 */
  readonly __continue: true;
  /** 已执行步骤的轨迹 */
  trace: string[];
  /** 告知 AI 当前状态以及建议继续执行的下一步 */
  instruction: string;
}

/** 类型守卫：判断工具结果是否为工具继续 */
export function isToolContinuationResult(r: ToolExecuteResult): r is ToolContinuationResult {
  return typeof r === 'object' && '__continue' in r && (r as ToolContinuationResult).__continue === true;
}

/** 工具执行结果：普通文本 / 含图像 / 工具暂停 / 工具继续 */
export type ToolExecuteResult = string | ToolImageResult | ToolPauseResult | ToolContinuationResult;

/** 类型守卫：判断工具结果是否含图像 */
export function isToolImageResult(r: ToolExecuteResult): r is ToolImageResult {
  return typeof r === 'object' && 'imageBase64' in r;
}

/** 类型守卫：判断工具结果是否为工具暂停 */
export function isToolPauseResult(r: ToolExecuteResult): r is ToolPauseResult {
  return typeof r === 'object' && '__pause' in r && (r as ToolPauseResult).__pause === true;
}

/**
 * 工具执行上下文（可选）
 * 
 * 用于向工具传递会话级元信息（如 conversationId），
 * 使工具能访问会话特定的状态（如 todo_tool 需要隔离不同会话的任务列表）。
 */
export interface ToolContext {
  /** 当前会话 ID */
  conversationId?: string;
  /** 当前 LLM 回合 ID，仅用于日志关联。 */
  turnId?: string;
  /** 触发当前回合的结构化来源，仅用于日志关联。 */
  trigger?: import('../turnTrace').TurnTrigger;
  /** 调用工具的 Agent 层级。主对话默认 main，后台子任务使用 child。 */
  executor?: 'main' | 'child';
  /** 子任务 ID，仅在 executor=child 时存在。 */
  taskId?: string;
  /** 子任务所属的用户对话。 */
  parentConversationId?: string;
  /** 取消当前 Agent 执行时同步取消其正在等待的工具。 */
  signal?: AbortSignal;
}

/** A factual terminal condition that must end the current Agent task. */
export class ToolTerminalError extends Error {
  readonly terminal = true;

  constructor(message: string) {
    super(message);
    this.name = 'ToolTerminalError';
  }
}

export function isToolTerminalError(error: unknown): error is ToolTerminalError {
  return error instanceof ToolTerminalError
    || (error instanceof Error && error.name === 'ToolTerminalError');
}

export type ToolResourceAccess = 'shared' | 'exclusive';

export interface ToolResourceClaim {
  key: string;
  access: ToolResourceAccess;
}

export interface ToolExecutionPolicy<TParams> {
  resources?: (
    params: TParams,
    context?: ToolContext,
  ) => readonly ToolResourceClaim[];
}

export interface ToolExecutionCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolQueuedEvent {
  call: ToolExecutionCall;
  args: Record<string, unknown>;
  claims: ToolResourceClaim[];
}

export interface ToolStartedEvent extends ToolQueuedEvent {
  queueWaitMs: number;
}

export interface ToolBatchExecution extends ToolStartedEvent {
  durationMs: number;
  result: string | ToolImageResult;
}

export interface ToolBatchHooks {
  queued?: (event: ToolQueuedEvent) => void;
  started?: (event: ToolStartedEvent) => void;
  completed?: (event: ToolBatchExecution) => void;
}

export interface ToolDefinition<TParams = Record<string, unknown>> {
  /** OpenAI function calling 格式的工具描述，LLM 依据此决定是否调用 */
  schema: ToolSchema;
  /**
   * 工具执行函数
   * @param params - 已解析的参数对象（由 LLM 生成，registry 负责 JSON.parse）
   * @param context - 可选的执行上下文（如 conversationId）
   * @returns 字符串结果或含图像的 ToolImageResult，aiService 会自动处理注入
   */
  execute: (params: TParams, context?: ToolContext) => Promise<ToolExecuteResult> | ToolExecuteResult;

  /** Optional runtime resources used to coordinate conflicting tool calls. */
  execution?: ToolExecutionPolicy<TParams>;

  /**
   * 运行时条件可用性检测（借鉴 hermes-agent）
   *
   * 当返回 false 时，工具不会暴露给 AI（即使在 toolset 中也会被过滤）。
   * 适用场景：
   *   - API key 不存在时隐藏依赖外部服务的工具（如 web_extract 需要 FIRECRAWL_API_KEY）
   *   - 浏览器未启动时隐藏 browser 工具
   *   - 某个依赖未安装时隐藏相关功能
   *
   * @returns true=可用（暴露给 AI），false=不可用（自动隐藏）
   *
   * @example
   * ```ts
   * export const webExtractTool: ToolDefinition<WebExtractParams> = {
   *   checkAvailable: () => !!process.env.FIRECRAWL_API_KEY,
   *   schema: { ... },
   *   execute: async (args) => { ... }
   * };
   * ```
   */
  checkAvailable?: () => boolean;
}

// ── OpenAI Chat Message 类型（工具调用感知）──────────────

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** LLM 生成的 JSON 字符串，由 registry.execute 负责解析 */
    arguments: string;
  };
}

// ── 多模态内容片段（Vision 支持）────────────────────────

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export type ChatMessage =
  | { role: 'system'; content: string }
  /** user 消息支持纯文本或多模态内容数组（图文混合） */
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
