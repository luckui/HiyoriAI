/**
 * 应用配置的数据结构：主进程读写、持久化，渲染层的设置界面编辑。
 * 两边都从这里 import，保证结构只有一份定义。
 */

// ── LLM 服务商 ────────────────────────────────────

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

// ── 语音合成（TTS） ────────────────────────────────

/** 预设音色项 */
export interface VoicePresetItem {
  /** 预设 ID，同时作为 speaker 字段发送给 TTS 服务 */
  id: string;
  /** 显示名 */
  name: string;
  /** 描述（如"中文女声 A"） */
  description: string;
  /** 对应的参考音频文件名（相对于 voices/ 目录） */
  refAudioFile?: string;
}

export interface TTSProviderConfig {
  /** 目前仅 http-tts；将来可扩展 websocket 等 */
  type: 'http-tts';
  /** 显示名："Edge-TTS 本地"、"CosyVoice 远程"… */
  name: string;
  /** RESTful 端点（不带尾斜杠） */
  baseUrl: string;
  /** Bearer Token，留空则不发 */
  apiKey: string;
  /** 音色 ID */
  speaker: string;
  /** 语言代码 */
  language: string;
  /** 是否由本应用管理进程生命周期 */
  isLocal?: boolean;
  /** 本地引擎标识：'edge-tts' | 'moss-tts-nano' … */
  localEngine?: string;
  /** 音色选择模式：text = 自由文本输入（默认），preset = 下拉预设列表 */
  speakerMode?: 'text' | 'preset';
  /** 预设音色列表（speakerMode='preset' 时在 UI 展示下拉） */
  voicePresets?: VoicePresetItem[];
}

export interface TTSConfig {
  /** 全局开关：用户是否想要语音 */
  enabled: boolean;
  /** 当前使用的 provider key */
  activeProvider: string;
  /** 所有已配置的 TTS 服务商 */
  providers: Record<string, TTSProviderConfig>;
  /** 用户主动删除的 key，防止代码更新后同名 provider 复活 */
  deletedProviders?: string[];
}

// ── 平台桥接 ──────────────────────────────────────────

export interface DiscordConfig {
  enabled: boolean;
  token: string;
  allowedChannels: string;
  proxyUrl: string;
}

export interface WeChatConfig {
  enabled: boolean;
  token: string;
  accountId: string;
  baseUrl: string;
  sendChunkDelay: number;
  voiceRepliesEnabled: boolean;
  voiceReplyDelivery: 'audio_file' | 'native_voice';
}

export interface FeishuConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  allowedChatIds: string;
  voiceRepliesEnabled: boolean;
}

export interface BridgeAppConfig {
  discord: DiscordConfig;
  wechat: WeChatConfig;
  feishu: FeishuConfig;
}

// ── Skills ──────────────────────────────────────

/**
 * skill 目录注入系统提示词时每个条目的展示详细程度：
 *   'none'  → 不注入该集合 / 技能（模型不会在目录中看到它）
 *   'names' → 仅注入技能名称（无描述，最省 token）
 *   'short' → 名称 + 截断到 40 字的描述
 *   'full'  → 名称 + 截断到 100 字的描述（默认行为）
 */
export type SkillListingMode = 'none' | 'names' | 'short' | 'full';

export interface SkillsConfig {
  /**
   * 是否在 agent 模式下将 skills 目录注入系统提示词。
   * false = 完全不注入任何 skill 条目。
   */
  enabled: boolean;

  /**
   * 全局默认展示模式，作用于所有未被 collectionModes 覆盖的集合。
   */
  listingMode: SkillListingMode;

  /**
   * 被整体禁用的集合名称列表。
   * 集合名 = skills/ 子目录名，如 "scientific"。
   * 根目录直属技能的集合名固定为 "skills"。
   */
  disabledCollections: string[];

  /**
   * 被单独禁用的技能列表。
   * - 集合内技能格式："{collection}/{skill-name}"，如 "scientific/matplotlib"
   * - 根目录技能格式："{skill-name}"，如 "bilibili-live"
   */
  disabledSkills: string[];

  /**
   * 每个集合的展示模式覆盖。
   * key = 集合名（'skills' 表示根目录直属技能）
   * value = 该集合的展示模式，优先级高于全局 listingMode
   */
  collectionModes: Record<string, SkillListingMode>;
}

/** 设置界面列出的单个 skill */
export interface SkillEntry {
  name: string;
  summary: string;
  /** 所属集合 id */
  collection: string;
  /** 在 disabledSkills 中使用的唯一标识 */
  skillKey: string;
}

/** 集合元信息（来自目录中的 _collection.json，或从目录名生成默认值） */
export interface SkillCollectionInfo {
  /** 集合唯一标识符（目录名，根目录 skill 固定为 'skills'） */
  id: string;
  /** 带 emoji 的可读名称，例如 "📦 Scientific（科研技能库）" */
  displayName: string;
  /** 可选描述文本 */
  description: string;
  /** 是否允许用户删除（仅用户导入的子目录集合可删除，'skills' 根集合不可删） */
  removable: boolean;
}

export interface SkillImportResult {
  success: boolean;
  canceled?: boolean;
  type?: 'skill' | 'collection';
  message: string;
}

// ── Live2D 形象 ────────────────────────────────

export type AvatarMotionSlot = 'idle' | 'touch' | 'thinking' | 'speaking';

export interface AvatarMotionResource {
  id: string;
  group: string;
  index: number;
  file: string;
  label: string;
}

export interface AvatarExpressionResource {
  id: string;
  name: string;
  file: string;
}

export interface AvatarHitArea {
  id: string;
  name: string;
}

export interface AvatarMapping {
  motions: Record<AvatarMotionSlot, string[]>;
  expressions: Record<string, string>;
}

export interface Live2DModelProfile {
  id: string;
  name: string;
  sourceDir: string;
  modelJsonName: string;
  importedAt?: number;
  motions: AvatarMotionResource[];
  expressions: AvatarExpressionResource[];
  hitAreas: AvatarHitArea[];
  lipSyncIds: string[];
  mapping: AvatarMapping;
  unassignedMotionIds: string[];
}

export interface AvatarConfig {
  activeModelId: string;
  models: Live2DModelProfile[];
}
