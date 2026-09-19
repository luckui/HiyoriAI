// 设置面板用到的配置类型与 preload 暴露的 API（与 electron 侧结构保持一致）

export interface ProviderConfig {
  type: 'openai-compatible';
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export interface RuntimeConfig {
  activeProvider: string;
  contextWindowRounds: number;
  providers: Record<string, ProviderConfig>;
  /** 用户主动删除的 provider key，用于 loadPersistedConfig 合并时跳过 */
  deletedProviders?: string[];
}

export interface DiscordConfig {
  enabled: boolean;
  token: string;
  allowedChannels: string;
  proxyUrl: string;
}

export interface FeishuConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  allowedChatIds: string;
  voiceRepliesEnabled?: boolean;
}

export interface WeChatConfig {
  enabled: boolean;
  token?: string;
  accountId?: string;
  baseUrl?: string;
  sendChunkDelay?: number;
  voiceRepliesEnabled?: boolean;
  voiceReplyDelivery?: 'audio_file' | 'native_voice';
}

export interface VoicePresetItem {
  id: string;
  name: string;
  description: string;
  refAudioFile?: string;
}

export interface TTSProviderConfig {
  type: 'http-tts';
  name: string;
  baseUrl: string;
  apiKey: string;
  speaker: string;
  language: string;
  isLocal?: boolean;
  localEngine?: string;
  speakerMode?: 'text' | 'preset';
  voicePresets?: VoicePresetItem[];
}

export interface TTSConfig {
  enabled: boolean;
  activeProvider: string;
  providers: Record<string, TTSProviderConfig>;
  deletedProviders?: string[];
}

/** 内置 TTS 方案，不允许删除 */
export const BUILTIN_TTS_PROVIDERS = ['local_edge_tts', 'local_moss_nano', 'local_genie_tts'];

/** 内置 LLM 方案，不允许删除 */
export const BUILTIN_LLM_PROVIDERS = ['doubao', 'qwen35'];

export interface MemoryExportResult {
  success: boolean;
  path?: string;
  error?: string;
}

export interface MemoryImportResult {
  success: boolean;
  content?: string;
  error?: string;
}

// ── Skills 配置类型（与 electron/skillsConfig.ts 保持一致） ──────────────────

export type SkillListingMode = 'none' | 'names' | 'short' | 'full';

export interface SkillsConfig {
  enabled: boolean;
  listingMode: SkillListingMode;
  disabledCollections: string[];
  disabledSkills: string[];
  collectionModes: Record<string, SkillListingMode>;
}

export interface SkillEntry {
  name: string;
  summary: string;
  collection: string;
  skillKey: string;
}

/** 集合元信息（从 _collection.json 动态读取，无硬编码） */
export interface CollectionInfo {
  id: string;
  displayName: string;
  description: string;
  removable: boolean;
}

declare global {
  interface Window {
    settingsAPI?: {
      get(): Promise<RuntimeConfig>;
      save(cfg: RuntimeConfig): Promise<void>;
    };
    discordAPI?: {
      get(): Promise<DiscordConfig>;
      save(cfg: DiscordConfig): Promise<void>;
      getStatus(): Promise<'online' | 'offline'>;
    };
    feishuAPI?: {
      get(): Promise<FeishuConfig>;
      save(cfg: FeishuConfig): Promise<void>;
      getStatus(): Promise<'online' | 'offline'>;
      registerApp(): Promise<{ success: boolean; appId?: string; appSecret?: string; error?: string }>;
      onRegisterAppUpdate(cb: (state: any) => void): void;
    };
    wechatAPI?: {
      get(): Promise<WeChatConfig>;
      save(cfg: WeChatConfig): Promise<void>;
      getStatus(): Promise<'online' | 'offline'>;
      startQRLogin(): Promise<{ success: boolean; credentials?: any; error?: string }>;
      onQRLoginUpdate(cb: (state: any) => void): void;
    };
    ttsSettingsAPI?: {
      get(): Promise<TTSConfig>;
      save(cfg: TTSConfig): Promise<{ isEnabled: boolean; runtime: { ok: boolean; detail?: string } }>;
      test(url: string): Promise<{ ok: boolean; status?: number; body?: string; error?: string }>;
      onConfigChanged?(cb: () => void): void;
    };
    ttsLocalAPI?: {
      status(engine?: string): Promise<{ installed: boolean; running: boolean; healthy: boolean; pid: number | null; port: number; serverDir: string; engine: string }>;
      installAndStart(engine?: string): Promise<{ ok: boolean; detail: string; logs?: string[] }>;
      start(engine?: string): Promise<{ ok: boolean; detail: string }>;
      stop(engine?: string): Promise<{ ok: boolean; detail: string }>;
      importGenieVoice(): Promise<{ ok: boolean; canceled?: boolean; voice?: VoicePresetItem; detail: string }>;
      onLog(cb: (msg: string) => void): () => void;
    };
    memoryAPI?: {
      export(): Promise<MemoryExportResult>;
      import(): Promise<MemoryImportResult>;
    };
    skillsAPI?: {
      /** 读取当前 Skills 配置 */
      getConfig(): Promise<SkillsConfig>;
      /** 保存 Skills 配置 */
      saveConfig(cfg: SkillsConfig): Promise<void>;
      /** 列出所有可用 skill（含 collection / skillKey），供 UI 展示和选择 */
      listAll(): Promise<SkillEntry[]>;
      /** 列出所有集合元信息（id / displayName / description），从 _collection.json 动态读取 */
      listCollections(): Promise<CollectionInfo[]>;
      /**
       * 打开文件夹选择器，将选定的文件夹导入到 userData/skills/。
       * 自动识别是单个 skill 还是集合。
       */
      importFolder(): Promise<{ success: boolean; canceled?: boolean; type?: 'skill' | 'collection'; message: string }>;
      /**
       * 删除用户导入的集合目录（仅限 userData/skills/<collId>）。
       * 'skills' 根集合不可删除。
       */
      removeCollection(collId: string): Promise<{ success: boolean; message: string }>;
    };
  }
}
