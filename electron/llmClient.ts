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
}

/** 可中断的 sleep，signal 触发时立即 reject */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(id); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

/** 短暂 API / 网关错误重试配置 */
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000]; // 最多重试 3 次
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/**
 * 向 /chat/completions 发起单次请求，返回原始响应。
 * 自动对 HTTP 429 进行指数退避重试（最多 3 次），尊重 Retry-After header。
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

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delayMs = RETRY_DELAYS_MS[attempt - 1];
      console.warn(`[llmClient] transient API error，${delayMs / 1000}s 后重试 (${attempt}/${RETRY_DELAYS_MS.length})...`);
      await sleep(delayMs, signal);
    }

    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body,
      signal,
    });

    if (RETRYABLE_STATUS.has(response.status)) {
      const retryAfter = response.headers.get('Retry-After');
      const errText = await response.text();
      if (response.status === 429 && retryAfter) {
        // 尊重服务端指定的等待时间（若有）
        const waitMs = (parseFloat(retryAfter) || 5) * 1000;
        console.warn(`[llmClient] Retry-After: ${retryAfter}s`);
        RETRY_DELAYS_MS[attempt] = Math.max(RETRY_DELAYS_MS[attempt] ?? 5000, waitMs);
      }
      lastError = new Error(`HTTP ${response.status}: ${errText}`);
      continue; // 进入下一次重试
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    if (data.error) throw new Error(data.error.message);
    return data;
  }

  throw lastError ?? new Error('fetchCompletion: 未知错误');
}
