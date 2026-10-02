import type { LLMProviderConfig } from './types/config';

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 65536;

export function normalizeContextWindowTokens(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 2048 && value <= 2000000
    ? value : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

/** Window includes input and reserved output; configuration is capacity, not a claim about the model. */
export function getContextInputBudget(provider: LLMProviderConfig): number {
  if (provider.contextWindowTokens !== undefined && normalizeContextWindowTokens(provider.contextWindowTokens) !== provider.contextWindowTokens) {
    throw new Error('上下文容量必须是 2048–2000000 之间的整数');
  }
  const extra = provider.extraParams ?? {};
  for (const key of ['messages', 'tools', 'model']) {
    if (key in extra) throw new Error(`上下文预算模式不支持 extraParams.${key} 覆盖，请使用对应的配置项`);
  }
  const limits = ['max_tokens' in extra ? extra.max_tokens : provider.maxTokens ?? 1024];
  if ('max_completion_tokens' in extra) limits.push(extra.max_completion_tokens);
  if (limits.some(value => typeof value !== 'number' || !Number.isInteger(value) || value <= 0)) throw new Error('最大输出 token 必须为正整数');
  // Some compatible endpoints accept both names. Reserve the larger bound rather than guessing precedence.
  const output = Math.max(...limits as number[]);
  const budget = normalizeContextWindowTokens(provider.contextWindowTokens) - output;
  if (budget < 1024) throw new Error('上下文容量不足：请为输入预留至少 1024 token');
  return budget;
}
