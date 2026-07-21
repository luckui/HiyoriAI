import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  dragWindow: (deltaX: number, deltaY: number) =>
    ipcRenderer.send('window-drag', { deltaX, deltaY }),
  closeWindow: () => ipcRenderer.send('window-close'),
  resizeWindow: (width: number, height: number) => ipcRenderer.send('window-resize', { width, height }),
  togglePin: () => ipcRenderer.send('window-pin'),
  onPinState: (cb: (pinned: boolean) => void) =>
    ipcRenderer.on('window-pin-state', (_e, pinned) => cb(pinned)),
  /** 注册全屏光标位置回调，用于 Live2D 目光追踪 */
  onCursorPosition: (cb: (pos: { x: number; y: number }) => void) =>
    ipcRenderer.on('cursor-position', (_e, pos) => cb(pos)),
});

contextBridge.exposeInMainWorld('chatAPI', {
  createConversation: () =>
    ipcRenderer.invoke('chat:create-conversation'),
  listConversations: () =>
    ipcRenderer.invoke('chat:list-conversations'),
  loadConversation: (id: string) =>
    ipcRenderer.invoke('chat:load-conversation', id),
  deleteConversation: (id: string) =>
    ipcRenderer.invoke('chat:delete-conversation', id),
  renameConversation: (id: string, title: string) =>
    ipcRenderer.invoke('chat:rename-conversation', id, title),
  send: (conversationId: string, content: string, replyTarget?: unknown) =>
    ipcRenderer.invoke('chat:send', conversationId, content, replyTarget),
  stopAI: () =>
    ipcRenderer.invoke('chat:stop'),
  /** 监听主进程注入的 AI 主动消息（来自后台任务完成通知或工具调用） */
  onAgentMessage: (cb: (payload: { conversationId: string; content: string }) => void) => {
    const handler = (_e: unknown, payload: { conversationId: string; content: string }) => cb(payload);
    ipcRenderer.on('chat:agent-message', handler);
    return () => { ipcRenderer.removeListener('chat:agent-message', handler); };
  },
  /** 监听 background/batch 任务完成后触发的 AI 唤醒请求（触发新一轮主对话 AI） */
  onWakeup: (cb: (payload: { conversationId: string; text: string; replyTarget?: unknown }) => void) => {
    const handler = (_e: unknown, payload: { conversationId: string; text: string; replyTarget?: unknown }) => cb(payload);
    ipcRenderer.on('chat:agent-wakeup', handler);
    return () => { ipcRenderer.removeListener('chat:agent-wakeup', handler); };
  },
});

contextBridge.exposeInMainWorld('settingsAPI', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (cfg: unknown) => ipcRenderer.invoke('settings:save', cfg),
});

contextBridge.exposeInMainWorld('discordAPI', {
  get: () => ipcRenderer.invoke('discord:get'),
  save: (cfg: unknown) => ipcRenderer.invoke('discord:save', cfg),
  getStatus: () => ipcRenderer.invoke('discord:status'),
});

contextBridge.exposeInMainWorld('feishuAPI', {
  get: () => ipcRenderer.invoke('feishu:get'),
  save: (cfg: unknown) => ipcRenderer.invoke('feishu:save', cfg),
  getStatus: () => ipcRenderer.invoke('feishu:status'),
  registerApp: () => ipcRenderer.invoke('feishu:register-app'),
  onRegisterAppUpdate: (cb: (state: unknown) => void) =>
    ipcRenderer.on('feishu:register-app-update', (_e, state) => cb(state)),
});

contextBridge.exposeInMainWorld('ttsAPI', {
  isEnabled: () => ipcRenderer.invoke('tts:isEnabled'),
  speak: (text: string) => ipcRenderer.invoke('tts:speak', text),
  /** 取消所有挂起的 speak 请求（新一轮播放开始时调用，防止旧请求堆积在服务器队列） */
  abortSpeak: () => ipcRenderer.invoke('tts:speak:abort'),
  health: () => ipcRenderer.invoke('tts:health'),
  /** 监听主进程推送的 TTS 播放请求（用于直播间等场景） */
  onPlay: (cb: (text: string) => void) =>
    ipcRenderer.on('tts:play', (_e, payload: { text: string }) => cb(payload.text)),
  /** TTS 开始播放时暂停听力（防止 AI 声音被麦克风听到） */
  pauseHearing: () => ipcRenderer.invoke('hearing:pause-for-tts'),
  /** TTS 播放结束后恢复听力 */
  resumeHearing: () => ipcRenderer.invoke('hearing:resume-from-tts'),
});

contextBridge.exposeInMainWorld('ttsSettingsAPI', {
  get:  ()             => ipcRenderer.invoke('tts:config:get'),
  save: (cfg: unknown) => ipcRenderer.invoke('tts:config:save', cfg),
  test: (url: string)  => ipcRenderer.invoke('tts:config:test', url),
  onConfigChanged: (cb: () => void) =>
    ipcRenderer.on('tts:config-changed', () => cb()),
});

contextBridge.exposeInMainWorld('ttsLocalAPI', {
  status:          (engine?: string) => ipcRenderer.invoke('tts:local:status', engine),
  installAndStart: (engine?: string) => ipcRenderer.invoke('tts:local:install-and-start', engine),
  start:           (engine?: string) => ipcRenderer.invoke('tts:local:start', engine),
  stop:            (engine?: string) => ipcRenderer.invoke('tts:local:stop', engine),
  importGenieVoice: () => ipcRenderer.invoke('tts:genie:import-voice'),
  onLog:           (cb: (msg: string) => void) => {
    const handler = (_e: unknown, msg: string) => cb(msg);
    ipcRenderer.on('tts:local:log', handler);
    return () => { ipcRenderer.removeListener('tts:local:log', handler); };
  },
});

contextBridge.exposeInMainWorld('memoryAPI', {
  export: () => ipcRenderer.invoke('memory:export'),
  import: () => ipcRenderer.invoke('memory:import'),
});

contextBridge.exposeInMainWorld('agentAPI', {
  /** 设置 Agent 模式（chat / agent / agent-debug） */
  setMode: (mode: string) => ipcRenderer.invoke('agent:set-mode', mode),
  /** 获取当前模式 */
  getMode: () => ipcRenderer.invoke('agent:get-mode'),
  /** 监听模式切换事件 */
  onModeChanged: (cb: (mode: string) => void) =>
    ipcRenderer.on('agent-mode:changed', (_e, mode) => cb(mode)),
});

contextBridge.exposeInMainWorld('wechatAPI', {
  /** 获取 WeChat 配置 */
  get: () => ipcRenderer.invoke('wechat:get'),
  /** 保存 WeChat 配置 */
  save: (cfg: unknown) => ipcRenderer.invoke('wechat:save', cfg),
  /** 获取连接状态 */
  getStatus: () => ipcRenderer.invoke('wechat:status'),
  /** 启动二维码登录流程 */
  startQRLogin: () => ipcRenderer.invoke('wechat:qr-login'),
  /** 监听 QR 登录状态更新 */
  onQRLoginUpdate: (cb: (state: unknown) => void) =>
    ipcRenderer.on('wechat:qr-login-update', (_e, state) => cb(state)),
});

/** 应用退出相关事件 */
contextBridge.exposeInMainWorld('appLifecycleAPI', {
  /** 开始退出流水线时触发（正在保存记忆） */
  onQuitting: (cb: () => void) =>
    ipcRenderer.on('app:quitting', () => cb()),
  /** 流水线完成、即将关闭时触发 */
  onQuitReady: (cb: () => void) =>
    ipcRenderer.on('app:quit-ready', () => cb()),
});

/** AI 工具调用调试事件（开发调试用） */
contextBridge.exposeInMainWorld('debugAPI', {
  onToolCall: (cb: (ev: {
    name: string;
    args: Record<string, unknown>;
    result: string;
    ok: boolean;
    durationMs: number;
  }) => void) => ipcRenderer.on('tool-call-log', (_e, ev) => cb(ev)),
});

/** 听觉系统 API（语音转文字 / STT） */
contextBridge.exposeInMainWorld('hearingAPI', {
  /** 启动听觉系统 */
  start: (source: string) => ipcRenderer.invoke('hearing:start', source),
  /** 停止听觉系统 */
  stop: () => ipcRenderer.invoke('hearing:stop'),
  /** 获取听觉系统状态 */
  getStatus: () => ipcRenderer.invoke('hearing:status'),
  /** 监听：main 通知 renderer 开始音频捕获 */
  onStarted: (cb: (ev: { source: string; wsUrl: string; mode: string }) => void) => {
    const handler = (_e: unknown, ev: { source: string; wsUrl: string; mode: string }) => cb(ev);
    ipcRenderer.on('hearing:started', handler);
    return () => { ipcRenderer.removeListener('hearing:started', handler); };
  },
  /** 监听：main 通知 renderer 停止音频捕获 */
  onStopped: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('hearing:stopped', handler);
    return () => { ipcRenderer.removeListener('hearing:stopped', handler); };
  },
  /** 监听：转写结果（main → renderer 推送） */
  onTranscription: (cb: (result: {
    text: string;
    start: number;
    end: number;
    is_final: boolean;
    language: string;
    timestamp: number;
  }) => void) => {
    const handler = (_e: unknown, result: any) => cb(result);
    ipcRenderer.on('hearing:transcription', handler);
    return () => { ipcRenderer.removeListener('hearing:transcription', handler); };
  },
  /** renderer 上报转写结果到 main */
  reportTranscription: (result: {
    text: string;
    start: number;
    end: number;
    is_final: boolean;
    language: string;
    timestamp: number;
  }) => ipcRenderer.send('hearing:report-transcription', result),
  /** renderer 上报音频捕获失败 */
  reportCaptureFailed: (reason: string) => ipcRenderer.send('hearing:capture-failed', reason),
  /** 监听终端块事件（安装进度等） */
  onTerminalBlock: (cb: (ev: {
    blockId: string;
    line?: string;
    status?: 'running' | 'idle' | 'done' | 'error';
    title?: string;
  }) => void) => {
    const handler = (_e: unknown, ev: any) => cb(ev);
    ipcRenderer.on('hearing:terminal-block', handler);
    return () => { ipcRenderer.removeListener('hearing:terminal-block', handler); };
  },
  /** STT 本地服务管理（类比 ttsLocalAPI） */
  sttStatus: () => ipcRenderer.invoke('stt:local:status'),
  sttInstallAndStart: () => ipcRenderer.invoke('stt:local:install-and-start'),
  sttStart: () => ipcRenderer.invoke('stt:local:start'),
  sttStop: () => ipcRenderer.invoke('stt:local:stop'),
  onSttLog: (cb: (msg: string) => void) => {
    const handler = (_e: unknown, msg: string) => cb(msg);
    ipcRenderer.on('stt:local:log', handler);
    return () => { ipcRenderer.removeListener('stt:local:log', handler); };
  },
  /** 监听：听写/总结模式自动发送（main → renderer 触发消息发送流程） */
  onAutoSend: (cb: (ev: { text: string; type: 'dictation' | 'summary' }) => void) => {
    const handler = (_e: unknown, ev: any) => cb(ev);
    ipcRenderer.on('hearing:auto-send', handler);
    return () => { ipcRenderer.removeListener('hearing:auto-send', handler); };
  },
});

/** Live2D 控制 API（主进程工具 → 渲染进程 Live2D 驱动） */
contextBridge.exposeInMainWorld('live2dAPI', {
  /**
   * 监听来自主进程的 Live2D 控制命令。
   * 渲染进程在初始化后调用一次注册回调。
   */
  onCommand: (cb: (cmd: {
    type: 'emotion' | 'motion' | 'param' | 'query';
    [key: string]: unknown;
  }) => void) => {
    const handler = (_e: unknown, cmd: any) => cb(cmd);
    ipcRenderer.on('live2d:cmd', handler);
    return () => { ipcRenderer.removeListener('live2d:cmd', handler); };
  },
});

/** Skills 配置 API（供 UI 读写 SkillsConfig） */
contextBridge.exposeInMainWorld('skillsAPI', {
  /** 读取当前 Skills 配置 */
  getConfig: () => ipcRenderer.invoke('skills:get-config'),
  /** 保存 Skills 配置（传入完整的 SkillsConfig 对象） */
  saveConfig: (cfg: unknown) => ipcRenderer.invoke('skills:save-config', cfg),
  /**
   * 列出所有可用 skill（含 collection / skillKey），供 UI 展示和选择。
   * 返回类型：{ name, summary, collection, skillKey }[]
   */
  listAll: () => ipcRenderer.invoke('skills:list'),
  /** 列出所有集合的元信息（id + 显示名 + 描述），从目录 _collection.json 读取，无硬编码 */
  listCollections: () => ipcRenderer.invoke('skills:list-collections'),
  /**
   * 打开文件夹选择器，将用户选定的文件夹导入到 userData/skills/。
   * 自动识别结构：单个 skill（含 SKILL.md）或集合（含子文件夹/SKILL.md）。
   * 返回：{ success: boolean; canceled?: boolean; type?: 'skill' | 'collection'; message: string }
   */
  importFolder: () => ipcRenderer.invoke('skills:import-folder'),
  /**
   * 删除用户导入的集合目录（仅 userData/skills/<collId>）。
   * 'skills' 根集合不可删除。
   * 返回：{ success: boolean; message: string }
   */
  removeCollection: (collId: string) => ipcRenderer.invoke('skills:remove-collection', collId),
});

contextBridge.exposeInMainWorld('avatarAPI', {
  get: () => ipcRenderer.invoke('avatar:get'),
  importFolder: () => ipcRenderer.invoke('avatar:import-folder'),
  save: (cfg: unknown) => ipcRenderer.invoke('avatar:save', cfg),
  select: (modelId: string) => ipcRenderer.invoke('avatar:select', modelId),
  delete: (modelId: string) => ipcRenderer.invoke('avatar:delete', modelId),
  onConfigChanged: (cb: (cfg: unknown) => void) => {
    const handler = (_e: unknown, cfg: unknown) => cb(cfg);
    ipcRenderer.on('avatar:config-changed', handler);
    return () => { ipcRenderer.removeListener('avatar:config-changed', handler); };
  },
});
