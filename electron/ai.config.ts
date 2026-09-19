/**
 * AI 接入配置
 *
 * 切换 LLM：修改 activeProvider 为 providers 中某 key 即可。
 * 添加新服务商：在 providers 中新增一项。
 * 所有 openai-compatible 服务（OpenAI / DeepSeek / 智谱 / 月之暗面等）均可直接接入。
 */


import type { ProviderType, LLMProviderConfig, AIConfig } from '../shared/types/config';
export type { ProviderType, LLMProviderConfig, AIConfig };

const aiConfig: AIConfig = {
  activeProvider: 'doubao',
  contextWindowRounds: 6,
  providers: {
    doubao: {
      type: 'openai-compatible',
      name: '豆包',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: process.env['DOUBAO_API_KEY'] ?? '',
      model: 'doubao-pro-4k',
      temperature: 0.85,
      maxTokens: 1024,
    },

    'doubao-coding-plan': {
      type: 'openai-compatible',
      name: '豆包 Coding Plan',
      // ⚠️ 警告：此配置使用火山引擎 Coding Plan API
      // 仅适用于 AI 编程工具场景，非编程用途可能违反服务条款导致账号封禁
      // 文档：https://www.volcengine.com/docs/82379/1925114
      baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',  // Coding Plan 专用端点
      apiKey: process.env['DOUBAO_API_KEY'] ?? '',  // 使用同一个 API Key
      model: 'doubao-seed-2.0-code',  // Coding Plan 支持的模型
      temperature: 0.85,
      maxTokens: 2048,
    },

    'doubao-agent-plan': {
      type: 'openai-compatible',
      name: '豆包 Agent Plan',
      // ⚠️ 警告：此配置使用火山引擎 Agent Plan API
      // 仅适用于 AI 编程工具场景，非编程用途可能违反服务条款导致账号封禁
      // 文档：https://www.volcengine.com/docs/82379/1925114
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',  // Agent Plan 专用端点
      apiKey: process.env['DOUBAO_API_KEY'] ?? '',  // 使用同一个 API Key
      model: 'doubao-seed-2.0-code',  // Agent Plan 支持的模型
      temperature: 0.85,
      maxTokens: 2048,
    },

    qwen35: {
      type: 'openai-compatible',
      name: 'Qwen3.5-4B（本地）',
      baseUrl: process.env['QWEN_BASE_URL'] ?? 'http://localhost:7860',
      apiKey: process.env['QWEN_API_KEY'] ?? 'EMPTY',           // vLLM/SGLang 本地部署通常不需要 key，填 EMPTY 即可
      model: 'Qwen3.5-4B',       // 与服务端部署时的 --served-model-name 保持一致
      temperature: 0.7,
      maxTokens: 1024,
      // Qwen3 系列默认开启 thinking，4B 小模型思考收益有限且占满 max_tokens。
      // vLLM 必须通过 chat_template_kwargs 传递，顶层 enable_thinking 字段会被忽略。
      extraParams: { chat_template_kwargs: { enable_thinking: false } },
    },

    // ── 其他服务商预留（填入 apiKey 后修改 activeProvider 切换） ──────────
    // openai: {
    //   type: 'openai-compatible',
    //   name: 'OpenAI',
    //   baseUrl: 'https://api.openai.com/v1',
    //   apiKey: 'sk-...',
    //   model: 'gpt-4o-mini',
    // },
    // deepseek: {
    //   type: 'openai-compatible',
    //   name: 'DeepSeek',
    //   baseUrl: 'https://api.deepseek.com/v1',
    //   apiKey: 'sk-...',
    //   model: 'deepseek-chat',
    // },
    // zhipu: {
    //   type: 'openai-compatible',
    //   name: '智谱 GLM',
    //   baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    //   apiKey: '...',
    //   model: 'glm-4-flash',
    // },
    // moonshot: {
    //   type: 'openai-compatible',
    //   name: '月之暗面 Kimi',
    //   baseUrl: 'https://api.moonshot.cn/v1',
    //   apiKey: 'sk-...',
    //   model: 'moonshot-v1-8k',
    // },
  },
};

export default aiConfig;
