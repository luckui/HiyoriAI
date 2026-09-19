/**
 * AI 接入配置
 *
 * 切换 LLM：修改 activeProvider 为 providers 中某 key 即可。
 * 添加新服务商：在 providers 中新增一项。
 * 所有 openai-compatible 服务（OpenAI / DeepSeek / 智谱 / 月之暗面等）均可直接接入。
 */


export type ProviderType = 'openai-compatible';

export interface LLMProviderConfig {
  type: ProviderType;
  /** 服务商展示名称 */
  name: string;
  /** API 基础地址（结尾不带斜杠，如 https://api.openai.com/v1） */
  baseUrl: string;
  /** Bearer Token / API Key */
  apiKey: string;
  /** 模型 ID */
  model: string;
  /** 最大回复 token 数，默认 1024 */
  maxTokens?: number;
  /** 温度参数 0-2，默认 0.85 */
  temperature?: number;
  /**
   * 推理模型（如 doubao-seed、DeepSeek-R1）的 thinking token 上限。
   * 对应 volcengine/ark API 的 `thinking.budget_tokens` 字段。
   * 设为 0 表示关闭 thinking（等价 type:"disabled"）。
   * 不设则不发此字段（模型默认行为）。
   *
   * ⚠️ 智能兼容性检测：
   * 系统会根据模型名称自动判断是否支持 thinking 参数，即使配置了此字段，
   * 如果模型名称不包含 seed/reasoner/r1/thinking，也不会发送 thinking 参数。
   *
   * 支持 thinking 的模型关键词：
   *   - doubao-seed / doubao-pro-seed（字节豆包推理模型）
   *   - deepseek-reasoner / deepseek-r1（DeepSeek R1）
   *   - qwen-plus-thinking / qwen-max-thinking（阿里云 Qwen 推理版）
   *
   * 不支持的常见模型（会被自动过滤）：
   *   - doubao-pro-4k / doubao-lite-4k（豆包标准模型）
   *   - deepseek-chat（DeepSeek 对话模型）
   *   - gpt-4o / gpt-4o-mini（OpenAI）
   *   - glm-4-xxx（智谱 GLM）
   */
  thinkingBudgetTokens?: number;
  /**
   * 额外透传到 API 的请求体字段（优先级最高）。
   * 可用于配置服务商特有参数（如自定义 stop 序列、response_format 等）。
   */
  extraParams?: Record<string, unknown>;
}

export interface AIConfig {
  /** 当前激活的 provider key */
  activeProvider: string;
  /**
   * 短期记忆窗口（轮数）。
   * 1 轮 = 1 条 user + 1 条 assistant。
   * 超出部分永久存入 SQLite，但不进入本次请求的 context。
   */
  contextWindowRounds: number;
  providers: Record<string, LLMProviderConfig>;
  /**
   * 用户在 UI 中主动删除的 provider key 列表。
   * loadPersistedConfig 合并时会跳过这些 key，避免代码新增的同名 provider 被复活。
   * 运行时字段，不需要在 ai.config.ts 里预设。
   */
  deletedProviders?: string[];
}

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
