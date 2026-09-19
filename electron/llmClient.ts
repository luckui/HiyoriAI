/**
 * 底层 LLM HTTP 客户端
 *
 * 纯粹的 /chat/completions API 调用，不依赖工具注册表。
 * 可被 aiService（主聊天循环）和 Agent 模块（Planner / Verifier）共同使用，
 * 避免循环依赖。
 */

import type { LLMProviderConfig } from './ai.config';
import { buildProviderExtraBody, modelSupportsThinking } from './utils/textUtils';
import type { ChatMessage, ToolSchema, ToolCall } from './tools/types';

// 重新导出，让调用方无需直接依赖 tools/types
export type { ChatMessage, ToolSchema, ToolCall };

export interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | string;
  }>;
  error?: { message: string };
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface FetchCompletionOptions {
  maxTokens?: number;
  temperature?: number;
  disableThinking?: boolean;
  /** 单次 HTTP 请求超时（毫秒）。超时按临时故障重试；不设则不限时 */
  timeoutMs?: number;
}

/**
 * LLM 请求错误：携带 HTTP 状态与重试语义，供任务层判断是否值得重跑。
 * message 保持 `HTTP <status>: <body>` 格式，与旧版一致。
 */
export class LLMRequestError extends Error {
  readonly status?: number;
  /** 临时故障（限流 / 网关 / 网络 / 超时），稍后重试可能成功 */
  readonly retryable: boolean;
  /** 鉴权或额度问题，重试没有意义，批量任务应立即停止 */
  readonly fatal: boolean;
  /** 服务端通过 Retry-After 指定的等待时间 */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { status?: number; retryable?: boolean; fatal?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'LLMRequestError';
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.fatal = options.fatal ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** 可中断的 sleep，signal 触发时立即 reject */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(id); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

/** 短暂 API / 网关错误重试配置（只读：Retry-After 只影响当次请求，不能改写全局延迟） */
const RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000]; // 最多重试 3 次
const MAX_RETRY_DELAY_MS = 60_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const FATAL_STATUS = new Set([401, 402, 403]);

/** ±20% 抖动：并发子任务同时被限流时，错开它们的重试时刻 */
function withJitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function toRequestError(error: unknown, timeoutMs?: number): LLMRequestError {
  if (error instanceof LLMRequestError) return error;
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new LLMRequestError(`LLM 请求超时（${Math.round((timeoutMs ?? 0) / 1000)}s 内无响应）`, {
      retryable: true,
      cause: error,
    });
  }
  // fetch 在 DNS / 连接重置 / TLS 等网络层失败时抛 TypeError；响应体读取中断也归为网络故障
  const code = error instanceof Error ? (error.cause as { code?: string } | undefined)?.code : undefined;
  const detail = code ?? (error instanceof Error ? error.message : String(error));
  return new LLMRequestError(`LLM 网络请求失败：${detail}`, { retryable: true, cause: error });
}

async function requestCompletion(
  provider: LLMProviderConfig,
  body: string,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<ChatCompletionResponse> {
  const timeout = timeoutMs ? new AbortController() : undefined;
  const timer = timeout
    ? setTimeout(() => timeout.abort(new DOMException(`Timed out after ${timeoutMs}ms`, 'TimeoutError')), timeoutMs)
    : undefined;
  const requestSignal = timeout
    ? (signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal)
    : signal;

  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body,
      signal: requestSignal,
    });

    if (!response.ok) {
      const status = response.status;
      const errText = await response.text();
      throw new LLMRequestError(`HTTP ${status}: ${errText}`, {
        status,
        retryable: RETRYABLE_STATUS.has(status),
        fatal: FATAL_STATUS.has(status),
        retryAfterMs: parseRetryAfterMs(response.headers.get('Retry-After')),
      });
    }

    const data = (await response.json()) as ChatCompletionResponse;
    if (data.error) throw new LLMRequestError(data.error.message);
    return data;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 向 /chat/completions 发起请求，返回原始响应。
 * 对限流 / 网关错误 / 网络故障 / 超时做带抖动的退避重试（最多 3 次），尊重 Retry-After header。
 * 最终失败时抛出 LLMRequestError（retryable / fatal 标记供任务层决策）。
 *
 * @param provider - LLM Provider 配置（含 baseUrl / apiKey / model 等）
 * @param messages - 消息列表
 * @param tools    - 传入工具 schema 数组时启用 function calling；不传则禁用
 * @param signal   - 可选的 AbortSignal，用于中断请求
 */
export async function fetchCompletion(
  provider: LLMProviderConfig,
  messages: ChatMessage[],
  tools?: ToolSchema[],
  signal?: AbortSignal,
  options: FetchCompletionOptions = {},
): Promise<ChatCompletionResponse> {
  const withTools = tools && tools.length > 0;

  const body = JSON.stringify({
    model: provider.model,
    messages,
    max_tokens: options.maxTokens ?? provider.maxTokens ?? 1024,
    temperature: options.temperature ?? provider.temperature ?? 0.85,
    ...(withTools ? { tools } : {}),
    // 推理参数 + 服务商扩展字段（统一由 buildProviderExtraBody 处理）
    ...buildProviderExtraBody(provider),
    ...(options.disableThinking && modelSupportsThinking(provider.model)
      ? { thinking: { type: 'disabled' } }
      : {}),
  });

  let lastError: LLMRequestError | undefined;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delayMs = Math.min(
        MAX_RETRY_DELAY_MS,
        Math.max(withJitter(RETRY_DELAYS_MS[attempt - 1]), lastError?.retryAfterMs ?? 0),
      );
      console.warn(
        `[llmClient] ${lastError?.message.slice(0, 120) ?? 'transient API error'}，`
        + `${(delayMs / 1000).toFixed(1)}s 后重试 (${attempt}/${RETRY_DELAYS_MS.length})...`,
      );
      await sleep(delayMs, signal);
    }

    try {
      return await requestCompletion(provider, body, signal, options.timeoutMs);
    } catch (error) {
      if (signal?.aborted) throw error; // 调用方主动取消：原样抛出，不重试
      const requestError = toRequestError(error, options.timeoutMs);
      if (!requestError.retryable) throw requestError;
      lastError = requestError;
    }
  }

  throw lastError ?? new LLMRequestError('fetchCompletion: 未知错误');
}
