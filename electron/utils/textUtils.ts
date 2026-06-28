/**
 * 文本处理工具函数（供 aiService 和 memory 模块共用）
 */

/**
 * 清除推理模型在 content 中残留的 thinking 内容。
 * 各服务商 API 的返回形态不一，需处理以下三种情况：
 *   1. 完整块：<think>思维链</think>正文  → 删除整个 <think> 块
 *   2. 缺开头：思维链</think>正文         → 删除 </think> 及其之前的所有内容
 *   3. 缺结尾：<think>思维链              → 删除 <think> 及其之后的所有内容
 */
export function stripThinkTags(text: string): string {
  // 1. 移除完整的 <think>...</think> 块（含跨行）
  let result = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // 2. 移除孤立 </think> 及其之前的全部内容
  const closeIdx = result.indexOf('</think>');
  if (closeIdx !== -1) {
    result = result.slice(closeIdx + '</think>'.length);
  }
  // 3. 移除孤立 <think> 及其之后的全部内容
  const openIdx = result.indexOf('<think>');
  if (openIdx !== -1) {
    result = result.slice(0, openIdx);
  }
  return result.trim();
}

export function modelSupportsThinking(model?: string): boolean {
  const modelName = (model ?? '').toLowerCase();
  return (
    modelName.includes('seed') ||
    modelName.includes('reasoner') ||
    modelName.includes('r1') ||
    modelName.includes('thinking')
  );
}

/**
 * 将 LLMProviderConfig 的推理/扩展参数拼入请求体。
 * summarizer / globalSummarizer 和 aiService 均需传入，避免推理模型泄漏思考内容。
 */
export function buildProviderExtraBody(provider: {
  model?: string;
  thinkingBudgetTokens?: number;
  extraParams?: Record<string, unknown>;
}): Record<string, unknown> {
  const extra = { ...(provider.extraParams ?? {}) };

  // 兼容历史配置：部分 Qwen/OpenAI-compatible 服务将 enable_thinking
  // 错配在顶层 extraParams；这里自动下沉到 chat_template_kwargs。
  if (
    Object.prototype.hasOwnProperty.call(extra, 'enable_thinking') &&
    typeof extra['enable_thinking'] === 'boolean' &&
    !Object.prototype.hasOwnProperty.call(extra, 'chat_template_kwargs')
  ) {
    extra['chat_template_kwargs'] = {
      enable_thinking: extra['enable_thinking'],
    };
    delete extra['enable_thinking'];
  }

  // ── 智能 thinking 参数兼容性检测 ──────────────────────────────────
  // 只有同时满足以下条件才发送 thinking 参数：
  //   1. 配置了 thinkingBudgetTokens 且 > 0
  //   2. 模型名称明确支持 thinking
  //
  // 支持 thinking 的模型系列（大小写不敏感）：
  //   - doubao-seed / doubao-pro-seed（字节豆包推理模型）
  //   - deepseek-reasoner / deepseek-r1（DeepSeek R1 推理模型）
  //   - qwen-plus-thinking / qwen-max-thinking（阿里云 Qwen 推理版）
  //
  // 不支持的常见模型（会触发 400 错误）：
  //   - doubao-xxx（非 seed 后缀，如 doubao-pro-4k / doubao-lite-4k）
  //   - deepseek-chat（DeepSeek 对话模型，非推理版）
  //   - gpt-4o / gpt-4o-mini（OpenAI 标准模型）
  //   - glm-4-xxx（智谱 GLM 系列）
  //   - qwen-xxx（非 thinking 后缀）
  const supportsThinking = modelSupportsThinking(provider.model);

  return {
    ...(provider.thinkingBudgetTokens &&
        provider.thinkingBudgetTokens > 0 &&
        supportsThinking  // ← 新增：模型名称检测
      ? {
          thinking: {
            type: 'auto',
            budget_tokens: provider.thinkingBudgetTokens,
          },
        }
      : {}),
    ...extra,
  };
}
