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
  TTSProviderConfig,
  VoicePresetItem,
  WeChatConfig,
} from './types/config';
import type { ExpressionCue } from './expressions';
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
import type {
  LiveCaptureSource,
  LiveConfig,
  LiveCredits,
  LiveEvent,
  LiveFocus,
  LiveSegment,
  LiveStagePhase,
  LiveStageState,
  LiveSegmentInfo,
  LiveDirectorState,
  LiveRundownItem,
  LiveShowSummary,
  StagePanelState,
  ResearchJobSummary,
  ResearchLogLine,
  ResearchSpecInput,
  LiveBoard,
  LivePatrolSettings,
  LiveStatus,
  LiveTheme,
  LiveUpdate,
} from './types/live';

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
  onCursorPosition(cb: (pos: { x: number; y: number }) => void): Unsubscribe;
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

/** 流式朗读推给渲染进程的事件（tts:stream:event） */
export type TtsStreamEvent =
  /** 一块 16-bit 单声道 PCM，接在上一块后面播 */
  | { id: number; type: 'audio'; sampleRate: number; pcm: Uint8Array }
  /** 第 sentence 句从本段音频的第 atSec 秒开始（可能早于或晚于那段音频送达） */
  | { id: number; type: 'sentence'; sentence: number; atSec: number; exact?: boolean }
  /** 逐词时间戳（秒，本段音频中的位置）：字幕按她念到哪个词显示 */
  | { id: number; type: 'words'; words: Array<{ text: string; atSec: number; endSec: number; sentence?: number }> }
  /** 第 sentence 句的音频已全部给出 */
  | { id: number; type: 'sentence-done'; sentence: number }
  /** 结束；error 非空表示中途失败 */
  | { id: number; type: 'end'; error?: string };

export interface TtsAPI {
  isEnabled(): Promise<boolean>;
  health(): Promise<{ ok: boolean; error?: string }>;
  /** 合成一句话，返回 base64 WAV；TTS 未启用或失败时为 null */
  speak(text: string): Promise<{ data: string } | null>;
  /**
   * 开始流式朗读，返回流 ID（TTS 未启用时为 null）。音频经 onStreamEvent 陆续送回。
   * keepOpen 为 true 时之后还能 pushStream 追加句子（边生成边读），最后 finishStream
   */
  startStream(sentences: string[], keepOpen?: boolean): Promise<number | null>;
  pushStream(id: number, sentence: string): Promise<void>;
  finishStream(id: number): Promise<void>;
  cancelStream(id: number): Promise<void>;
  onStreamEvent(cb: (event: TtsStreamEvent) => void): Unsubscribe;
  /** 取消所有挂起的合成请求（新一轮播放开始时调用，防止旧请求堆积在服务器队列） */
  abortSpeak(): Promise<void>;
  /** 主进程请求朗读（直播、Minecraft 等）；带 id 的播完后要用 playDone 回报 */
  onPlay(cb: (text: string, id?: number) => void): void;
  /** 回报主进程：这段朗读已经播完（或放弃） */
  playDone(id: number): void;
  /** 主进程要她立刻闭嘴（主人开口）：停掉正在说的，排队的也不说了 */
  onInterrupt(cb: () => void): void;
  /** TTS 播放期间暂停 / 恢复听觉，防止 AI 的声音被麦克风听到 */
  pauseHearing(): Promise<void>;
  resumeHearing(): Promise<void>;
}

export interface TtsSettingsAPI {
  get(): Promise<TTSConfig>;
  save(cfg: TTSConfig): Promise<{ isEnabled: boolean; runtime: { ok: boolean; detail?: string } }>;
  /** 测试方案：HTTP 方案探测地址；豆包方案合成一句话（音色和资源 ID 不匹配也能测出来） */
  test(url: string, provider?: TTSProviderConfig): Promise<{ ok: boolean; status?: number; body?: string; error?: string }>;
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
  /** 表情导演：为要说的每一句选表情；无法判断时为 null（渲染层改用即时线索） */
  directExpressions(sentences: string[], context?: string): Promise<ExpressionCue[] | null>;
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

/** 直播：弹幕姬窗口与设置页共用 */
export interface LiveAPI {
  getConfig(): Promise<LiveConfig>;
  /** 保存设置；已连接时按新设置重连 */
  saveConfig(cfg: LiveConfig): Promise<LiveStatus>;
  /** 按已保存的设置连接 */
  connect(): Promise<{ ok: boolean; detail?: string; status: LiveStatus }>;
  disconnect(): Promise<LiveStatus>;
  getStatus(): Promise<LiveStatus>;
  /** 最近的事件（旧 → 新），弹幕姬打开时补齐历史 */
  getRecent(): Promise<LiveEvent[]>;
  openWindow(): Promise<void>;
  /** 弹幕姬窗口置顶开关，返回新的状态 */
  togglePin(): Promise<boolean>;
  onUpdate(cb: (update: LiveUpdate) => void): Unsubscribe;
  /** 直播间画面 */
  getStage(): Promise<LiveStageState>;
  /** 切换画面阶段：off 桌宠 / waiting 准备中 / opening 开场 / live 直播中 / ending 谢幕 */
  setPhase(phase: LiveStagePhase): Promise<LiveStageState>;
  /** 换节目形式（同时换成该节目的默认主题） */
  setSegment(segment: LiveSegment, title?: string): Promise<LiveStageState>;
  setTheme(theme: LiveTheme): Promise<LiveStageState>;
  /** 本场记录：谢幕的感谢名单 */
  getCredits(): Promise<LiveCredits>;
  /** 可采集的窗口（游戏回） */
  listCaptureSources(): Promise<LiveCaptureSource[]>;
  setCapture(source: LiveCaptureSource | null): Promise<LiveStageState>;
  /** 她正在回应哪些事件 */
  onFocus(cb: (focus: LiveFocus) => void): Unsubscribe;
  pickBackground(): Promise<LiveStageState>;
  clearBackground(): Promise<LiveStageState>;
  onStage(cb: (state: LiveStageState) => void): Unsubscribe;
  /** AI 自动回应直播间 */
  startAi(): Promise<{ ok: boolean; detail?: string; state: LiveStageState }>;
  stopAi(): Promise<LiveStageState>;
  /** 主播在控制台对她说话（观众只听得到她的回答） */
  ownerSay(text: string): Promise<{ ok: boolean; reply?: string; detail?: string }>;
  /** 主人麦克风（按键说话）开关：会确保本地语音识别服务在跑 */
  setOwnerMic(on: boolean): Promise<{ ok: boolean; detail?: string; wsUrl?: string }>;
  /** 按下说话键：她立刻停下 */
  pttDown(): Promise<boolean>;
  /** 松开：把转写结果交给她 */
  pttUp(text: string): Promise<boolean>;
  /** 全局热键（F8）切换说话 */
  onPttToggle(cb: () => void): Unsubscribe;
  /** 主人正在说 / 说了什么（舞台字幕条） */
  onOwnerVoice(cb: (voice: { state: 'listening' | 'heard' | 'idle'; text: string }) => void): Unsubscribe;
  /** 直播记忆：记了多少观众、场次、梗、口味 */
  getMemoryStats(): Promise<{ viewers: number; streams: number; memes: number; tastes: number } | null>;
  /** 清空直播记忆（说过「别记我」的名单保留） */
  clearMemory(): Promise<{ viewers: number; streams: number; memes: number; tastes: number } | null>;
  /** 测试：以测试观众身份发一条弹幕（AI 互动开着时才有效） */
  testChat(name: string, text: string, uid?: string): Promise<boolean>;
  /** 没开播时测试：以某个测试观众的身份进场、送礼（uid 填了就用它，测试私信用） */
  testEvent(event: { kind: 'enter' | 'gift'; name: string; uid?: string; gift?: string }): Promise<boolean>;
  getBoard(): Promise<{ board: LiveBoard; lines: string[] }>;
  setBoard(board: LiveBoard): Promise<{ board: LiveBoard; lines: string[] }>;
  /** 公告板改了（舞台显示用） */
  onBoard(cb: (state: { board: LiveBoard; lines: string[] }) => void): Unsubscribe;
  /** 「现在的环节」：直播中说一句过渡就切过去，开播前就是第一个环节（choice 如 bili-intel、free-chat@game） */
  switchSegment(choice: string): Promise<LiveDirectorState | null>;
  /** 主进程的提示（比如 AI 互动开不了） */
  onNotice(cb: (text: string) => void): Unsubscribe;
  /** 节目单：能选的环节 + 导演当前状态 */
  getRundown(): Promise<{ segments: LiveSegmentInfo[]; state: LiveDirectorState | null }>;
  /** 保存节目单（正在跑时下一场才生效） */
  saveRundown(items: LiveRundownItem[]): Promise<LiveDirectorState | null>;
  /** 没开画面时手动开始 / 停止节目单 */
  startRundown(): Promise<LiveDirectorState | null>;
  stopRundown(): Promise<LiveDirectorState | null>;
  /** 说一句过渡，进下一个环节 */
  nextSegment(): Promise<LiveDirectorState | null>;
  extendSegment(minutes: number): Promise<LiveDirectorState | null>;
  /** 拿掉排在后面的第一项 */
  skipUpcoming(): Promise<LiveDirectorState | null>;
  onDirector(cb: (state: LiveDirectorState) => void): Unsubscribe;
  getPanel(): Promise<StagePanelState | null>;
  onPanel(cb: (panel: StagePanelState | null) => void): Unsubscribe;
  /** B 站巡逻：用主人的账号点赞 / 留评论（默认都关） */
  getPatrolSettings(): Promise<LivePatrolSettings>;
  setPatrolSettings(next: LivePatrolSettings): Promise<LivePatrolSettings>;
  /** B站研究任务：热门快照 / UP 主全部投稿 / 关键词搜索 / 指定视频 */
  startResearch(spec: ResearchSpecInput): Promise<{ ok: boolean; detail?: string; job?: ResearchJobSummary | null }>;
  /** 控制台里选的研究什么（存进配置；情报站自己开任务时用它） */
  getResearchSpec(): Promise<ResearchSpecInput>;
  setResearchSpec(spec: ResearchSpecInput): Promise<ResearchSpecInput>;
  stopResearch(): Promise<ResearchJobSummary | null>;
  getResearch(): Promise<ResearchJobSummary | null>;
  /** 之前的研究任务（新的在前） */
  listResearch(): Promise<Array<{ id: string; title: string; status: string; createdAt: number; reportFile?: string; done: number; total: number }>>;
  onResearch(cb: (job: ResearchJobSummary | null) => void): Unsubscribe;
  /** 生成（或重新生成）报告；不给 id 是当前任务 */
  researchReport(id?: string): Promise<{ file: string; markdown: string } | null>;
  onResearchReport(cb: (report: { id: string; title: string; file: string }) => void): Unsubscribe;
  /** 打开报告文件夹 / 字幕文件夹 / 某份报告 */
  openResearch(what: 'reports' | 'videos' | 'file', file?: string): Promise<boolean>;
  /** 研究过程的输出（舞台终端） */
  onTerminal(cb: (line: ResearchLogLine) => void): Unsubscribe;
  /** 舞台播放器（巡逻环节放视频片段）：主进程下命令，舞台放完回报 */
  onPlayer(cb: (cmd:
    | { action: 'play'; id: number; bvid: string; cid: number; startSec: number; clipSec: number }
    | { action: 'open'; bvid: string; title: string }
    | { action: 'stop' }) => void): Unsubscribe;
  /** 放完了：played 是不是真的放了，frames 是放的时候截的画面（data URL） */
  playerDone(id: number, played: boolean, frames?: string[]): void;
  /** 上一场的指标汇总 */
  getShowSummary(): Promise<{ summary: LiveShowSummary; file: string | null } | null>;
  onShowSummary(cb: (result: { summary: LiveShowSummary; file: string | null }) => void): Unsubscribe;
  openShowLogs(): Promise<boolean>;
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
  liveAPI: LiveAPI;
}
