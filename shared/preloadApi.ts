/**
 * preload 暴露给渲染层的全部接口（window.xxxAPI）——唯一的定义处。
 *
 *   electron/preload.ts   按这里的接口实现（expose 时做类型检查，漏实现或签名不符会编译失败）
 *   src/types/window.d.ts 把它们声明到 window 上，渲染层直接使用
 *
 * 新增接口：先在这里加签名，再在 preload.ts 实现，最后在 electron/ipc/ 注册对应的 handler
 * （IPC 契约测试会检查 preload 调用的通道都有 handler）。
 */

import type {
  AIConfig,
  AvatarConfig,
  DiscordConfig,
  FeishuConfig,
  Live2DModelProfile,
  SkillCollectionInfo,
  SkillEntry,
  SkillImportResult,
  SkillsConfig,
  TTSConfig,
  VoicePresetItem,
  WeChatConfig,
} from './types/config';
import type {
  ChatReply,
  ConversationWithPreview,
  Conversation,
  DBMessage,
  ExternalTurn,
  TerminalBlockEvent,
  ToolCallEvent,
  TranscriptionResult,
  WakeupPayload,
} from './types/chat';
import type { ServiceResult, SttServerStatus, TtsServerStatus } from './types/services';

/** 取消监听 */
export type Unsubscribe = () => void;
export type BridgeStatus = 'online' | 'offline';

export interface ElectronAPI {
  dragWindow(deltaX: number, deltaY: number): void;
  closeWindow(): void;
  resizeWindow(width: number, height: number): void;
  togglePin(): void;
  onPinState(cb: (pinned: boolean) => void): void;
  /** 全屏光标位置（~60fps），用于 Live2D 目光追踪 */
  onCursorPosition(cb: (pos: { x: number; y: number }) => void): void;
}

export interface ChatAPI {
  createConversation(): Promise<Conversation>;
  listConversations(): Promise<ConversationWithPreview[]>;
  loadConversation(id: string): Promise<DBMessage[]>;
  deleteConversation(id: string): Promise<void>;
  renameConversation(id: string, title: string): Promise<void>;
  send(conversationId: string, content: string, replyTarget?: unknown, requestContext?: unknown): Promise<ChatReply>;
  stopAI(): Promise<void>;
  /** 后台任务 / 定时提醒完成后，主进程请求开启新一轮对话 */
  onWakeup(cb: (payload: WakeupPayload) => void): Unsubscribe;
  onExternalTurn(cb: (turn: ExternalTurn) => void): Unsubscribe;
}

export interface SettingsAPI {
  get(): Promise<AIConfig>;
  save(cfg: AIConfig): Promise<void>;
}

export interface DiscordAPI {
  get(): Promise<DiscordConfig>;
  save(cfg: DiscordConfig): Promise<void>;
  getStatus(): Promise<BridgeStatus>;
}

export interface FeishuRegisterUpdate {
  status: string;
  url?: string;
  qrcodeUrl?: string;
  expireIn?: number;
  interval?: number;
  appId?: string;
  error?: string;
}

export interface FeishuAPI {
  get(): Promise<FeishuConfig>;
  /** voiceRepliesEnabled 省略时视为关闭 */
  save(cfg: Omit<FeishuConfig, 'voiceRepliesEnabled'> & { voiceRepliesEnabled?: boolean }): Promise<void>;
  getStatus(): Promise<BridgeStatus>;
  /** 扫码创建飞书应用，过程状态通过 onRegisterAppUpdate 推送 */
  registerApp(): Promise<{ success: boolean; appId?: string; appSecret?: string; error?: string }>;
  onRegisterAppUpdate(cb: (update: FeishuRegisterUpdate) => void): void;
}

export interface WeChatQrLoginState {
  status: 'pending' | 'scanned' | 'confirmed' | 'expired' | 'error';
  qrcodeUrl?: string;
  error?: string;
  credentials?: { token: string; accountId: string; baseUrl: string };
}

export interface WeChatAPI {
  get(): Promise<WeChatConfig>;
  /** 只传需要修改的字段；未传的保持原值 */
  save(cfg: Partial<WeChatConfig> & { enabled: boolean }): Promise<void>;
  getStatus(): Promise<BridgeStatus>;
  startQRLogin(): Promise<{ success: boolean; credentials?: WeChatQrLoginState['credentials']; error?: string }>;
  onQRLoginUpdate(cb: (state: WeChatQrLoginState) => void): void;
}

export interface TtsAPI {
  isEnabled(): Promise<boolean>;
  health(): Promise<{ ok: boolean; error?: string }>;
  /** 合成一句话，返回 base64 WAV；TTS 未启用或失败时为 null */
  speak(text: string): Promise<{ data: string } | null>;
  /** 取消所有挂起的合成请求（新一轮播放开始时调用，防止旧请求堆积在服务器队列） */
  abortSpeak(): Promise<void>;
  /** 主进程请求朗读（直播、Minecraft 等） */
  onPlay(cb: (text: string) => void): void;
  /** TTS 播放期间暂停 / 恢复听觉，防止 AI 的声音被麦克风听到 */
  pauseHearing(): Promise<void>;
  resumeHearing(): Promise<void>;
}

export interface TtsSettingsAPI {
  get(): Promise<TTSConfig>;
  save(cfg: TTSConfig): Promise<{ isEnabled: boolean; runtime: { ok: boolean; detail?: string } }>;
  test(url: string): Promise<{ ok: boolean; status?: number; body?: string; error?: string }>;
  onConfigChanged(cb: () => void): void;
}

export interface TtsLocalAPI {
  status(engine?: string): Promise<TtsServerStatus>;
  installAndStart(engine?: string): Promise<ServiceResult & { logs?: string[] }>;
  start(engine?: string): Promise<ServiceResult>;
  stop(engine?: string): Promise<ServiceResult>;
  importGenieVoice(): Promise<{ ok: boolean; canceled?: boolean; voice?: VoicePresetItem; detail: string }>;
  /** 本地服务安装 / 启动日志 */
  onLog(cb: (msg: string) => void): Unsubscribe;
}

export interface MemoryAPI {
  export(): Promise<{ success: boolean; path?: string; error?: string }>;
  /** content 为导入后的结构化全局记忆（主进程已写入数据库） */
  import(): Promise<{ success: boolean; content?: unknown; error?: string }>;
}

export interface AgentAPI {
  /** chat / agent / agent-debug / developer / minecraft */
  setMode(mode: string): Promise<void>;
  getMode(): Promise<string>;
  onModeChanged(cb: (mode: string) => void): void;
}

export interface AppLifecycleAPI {
  /** 开始退出流水线时触发（正在保存记忆） */
  onQuitting(cb: () => void): void;
  /** 流水线完成、即将关闭时触发 */
  onQuitReady(cb: () => void): void;
}

export interface DebugAPI {
  onToolCall(cb: (ev: ToolCallEvent) => void): void;
}

export interface HearingStartedEvent {
  source: string;
  wsUrl: string;
  mode: string;
}

export interface HearingAPI {
  start(source: string): Promise<{ ok: boolean; detail: string; wsUrl?: string; mode?: string }>;
  stop(): Promise<{ ok: boolean; detail: string }>;
  getStatus(): Promise<unknown>;
  /** 主进程开始收听：渲染层据此开始采集音频 */
  onStarted(cb: (ev: HearingStartedEvent) => void): Unsubscribe;
  onStopped(cb: () => void): Unsubscribe;
  onTranscription(cb: (result: TranscriptionResult) => void): Unsubscribe;
  /** 渲染层把 STT 转写结果交给主进程 */
  reportTranscription(result: TranscriptionResult): void;
  reportCaptureFailed(reason: string): void;
  onTerminalBlock(cb: (ev: TerminalBlockEvent) => void): Unsubscribe;
  sttStatus(): Promise<SttServerStatus>;
  sttInstallAndStart(): Promise<ServiceResult & { logs?: string[] }>;
  sttStart(): Promise<ServiceResult>;
  sttStop(): Promise<ServiceResult>;
  onSttLog(cb: (msg: string) => void): Unsubscribe;
  /** 听写 / 总结模式识别完成，请渲染层把文本发给 AI */
  onAutoSend(cb: (ev: { text: string; type: 'dictation' | 'summary' }) => void): Unsubscribe;
}

/** 主进程下发的 Live2D 控制命令（manage_live2d 工具等） */
export interface Live2DCommand {
  type: 'emotion' | 'motion' | 'param' | 'query';
  [key: string]: unknown;
}

export interface Live2DAPI {
  onCommand(cb: (cmd: Live2DCommand) => void): Unsubscribe;
}

export interface SkillsAPI {
  getConfig(): Promise<SkillsConfig>;
  saveConfig(cfg: SkillsConfig): Promise<void>;
  /** 所有可用 skill，供设置界面展示和勾选 */
  listAll(): Promise<SkillEntry[]>;
  listCollections(): Promise<SkillCollectionInfo[]>;
  /** 选择文件夹导入到 userData/skills/，自动识别是单个 skill 还是集合 */
  importFolder(): Promise<SkillImportResult>;
  /** 删除用户导入的集合（'skills' 根集合不可删） */
  removeCollection(collId: string): Promise<{ success: boolean; message: string }>;
}

export interface AvatarAPI {
  get(): Promise<AvatarConfig>;
  importFolder(): Promise<{
    ok: boolean;
    canceled?: boolean;
    detail?: string;
    config?: AvatarConfig;
    profile?: Live2DModelProfile;
    baseUrl?: string;
  }>;
  save(cfg: AvatarConfig): Promise<AvatarConfig>;
  select(modelId: string): Promise<AvatarConfig>;
  delete(modelId: string): Promise<AvatarConfig>;
  onConfigChanged(cb: (cfg: AvatarConfig) => void): Unsubscribe;
}

/** window 上由 preload 注入的全部接口 */
export interface PreloadApis {
  electronAPI: ElectronAPI;
  chatAPI: ChatAPI;
  settingsAPI: SettingsAPI;
  discordAPI: DiscordAPI;
  feishuAPI: FeishuAPI;
  wechatAPI: WeChatAPI;
  ttsAPI: TtsAPI;
  ttsSettingsAPI: TtsSettingsAPI;
  ttsLocalAPI: TtsLocalAPI;
  memoryAPI: MemoryAPI;
  agentAPI: AgentAPI;
  appLifecycleAPI: AppLifecycleAPI;
  debugAPI: DebugAPI;
  hearingAPI: HearingAPI;
  live2dAPI: Live2DAPI;
  skillsAPI: SkillsAPI;
  avatarAPI: AvatarAPI;
}
