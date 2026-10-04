/**
 * 渲染层能调用的全部主进程接口。签名定义在 shared/preloadApi.ts，这里按接口逐个实现；
 * expose 会检查实现与定义一致，渲染层的 window 类型也来自同一份定义。
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { PreloadApis, Unsubscribe } from '../shared/preloadApi';

function expose<K extends keyof PreloadApis>(key: K, api: PreloadApis[K]): void {
  contextBridge.exposeInMainWorld(key, api);
}

/** 订阅主进程推送的事件，返回取消订阅函数 */
function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

expose('electronAPI', {
  dragWindow: (deltaX, deltaY) => ipcRenderer.send('window-drag', { deltaX, deltaY }),
  closeWindow: () => ipcRenderer.send('window-close'),
  resizeWindow: (width, height) => ipcRenderer.send('window-resize', { width, height }),
  togglePin: () => ipcRenderer.send('window-pin'),
  onPinState: (cb) => { subscribe('window-pin-state', cb); },
  onCursorPosition: (cb) => subscribe('cursor-position', cb),
});

expose('chatAPI', {
  createConversation: () => ipcRenderer.invoke('chat:create-conversation'),
  listConversations: () => ipcRenderer.invoke('chat:list-conversations'),
  loadConversation: (id) => ipcRenderer.invoke('chat:load-conversation', id),
  deleteConversation: (id) => ipcRenderer.invoke('chat:delete-conversation', id),
  renameConversation: (id, title) => ipcRenderer.invoke('chat:rename-conversation', id, title),
  send: (conversationId, content, replyTarget, requestContext) =>
    ipcRenderer.invoke('chat:send', conversationId, content, replyTarget, requestContext),
  stopAI: () => ipcRenderer.invoke('chat:stop'),
  onWakeup: (cb) => subscribe('chat:agent-wakeup', cb),
  onExternalTurn: (cb) => subscribe('chat:external-turn', cb),
});

expose('settingsAPI', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (cfg) => ipcRenderer.invoke('settings:save', cfg),
});

expose('discordAPI', {
  get: () => ipcRenderer.invoke('discord:get'),
  save: (cfg) => ipcRenderer.invoke('discord:save', cfg),
  getStatus: () => ipcRenderer.invoke('discord:status'),
});

expose('feishuAPI', {
  get: () => ipcRenderer.invoke('feishu:get'),
  save: (cfg) => ipcRenderer.invoke('feishu:save', cfg),
  getStatus: () => ipcRenderer.invoke('feishu:status'),
  registerApp: () => ipcRenderer.invoke('feishu:register-app'),
  onRegisterAppUpdate: (cb) => { subscribe('feishu:register-app-update', cb); },
});

expose('wechatAPI', {
  get: () => ipcRenderer.invoke('wechat:get'),
  save: (cfg) => ipcRenderer.invoke('wechat:save', cfg),
  getStatus: () => ipcRenderer.invoke('wechat:status'),
  startQRLogin: () => ipcRenderer.invoke('wechat:qr-login'),
  onQRLoginUpdate: (cb) => { subscribe('wechat:qr-login-update', cb); },
});

expose('ttsAPI', {
  isEnabled: () => ipcRenderer.invoke('tts:isEnabled'),
  health: () => ipcRenderer.invoke('tts:health'),
  speak: (text) => ipcRenderer.invoke('tts:speak', text),
  startStream: (sentences, keepOpen) => ipcRenderer.invoke('tts:stream:start', sentences, keepOpen),
  pushStream: (id, sentence) => ipcRenderer.invoke('tts:stream:push', id, sentence),
  finishStream: (id) => ipcRenderer.invoke('tts:stream:finish', id),
  cancelStream: (id) => ipcRenderer.invoke('tts:stream:cancel', id),
  onStreamEvent: (cb) => subscribe('tts:stream:event', cb),
  abortSpeak: () => ipcRenderer.invoke('tts:speak:abort'),
  onPlay: (cb) => { subscribe<{ text: string; id?: number }>('tts:play', (payload) => cb(payload.text, payload.id)); },
  playDone: (id) => ipcRenderer.send('tts:play:done', id),
  pauseHearing: () => ipcRenderer.invoke('hearing:pause-for-tts'),
  resumeHearing: () => ipcRenderer.invoke('hearing:resume-from-tts'),
});

expose('ttsSettingsAPI', {
  get: () => ipcRenderer.invoke('tts:config:get'),
  save: (cfg) => ipcRenderer.invoke('tts:config:save', cfg),
  test: (url, provider) => ipcRenderer.invoke('tts:config:test', url, provider),
  onConfigChanged: (cb) => { subscribe('tts:config-changed', () => cb()); },
});

expose('ttsLocalAPI', {
  status: (engine) => ipcRenderer.invoke('tts:local:status', engine),
  installAndStart: (engine) => ipcRenderer.invoke('tts:local:install-and-start', engine),
  start: (engine) => ipcRenderer.invoke('tts:local:start', engine),
  stop: (engine) => ipcRenderer.invoke('tts:local:stop', engine),
  importGenieVoice: () => ipcRenderer.invoke('tts:genie:import-voice'),
  onLog: (cb) => subscribe('tts:local:log', cb),
});

expose('memoryAPI', {
  export: () => ipcRenderer.invoke('memory:export'),
  import: () => ipcRenderer.invoke('memory:import'),
});

expose('agentAPI', {
  setMode: (mode) => ipcRenderer.invoke('agent:set-mode', mode),
  getMode: () => ipcRenderer.invoke('agent:get-mode'),
  onModeChanged: (cb) => { subscribe('agent-mode:changed', cb); },
});

expose('appLifecycleAPI', {
  onQuitting: (cb) => { subscribe('app:quitting', () => cb()); },
  onQuitReady: (cb) => { subscribe('app:quit-ready', () => cb()); },
});

expose('debugAPI', {
  onToolCall: (cb) => { subscribe('tool-call-log', cb); },
});

expose('hearingAPI', {
  start: (source) => ipcRenderer.invoke('hearing:start', source),
  stop: () => ipcRenderer.invoke('hearing:stop'),
  getStatus: () => ipcRenderer.invoke('hearing:status'),
  onStarted: (cb) => subscribe('hearing:started', cb),
  onStopped: (cb) => subscribe('hearing:stopped', () => cb()),
  onTranscription: (cb) => subscribe('hearing:transcription', cb),
  reportTranscription: (result) => ipcRenderer.send('hearing:report-transcription', result),
  reportCaptureFailed: (reason) => ipcRenderer.send('hearing:capture-failed', reason),
  onTerminalBlock: (cb) => subscribe('hearing:terminal-block', cb),
  sttStatus: () => ipcRenderer.invoke('stt:local:status'),
  sttInstallAndStart: () => ipcRenderer.invoke('stt:local:install-and-start'),
  sttStart: () => ipcRenderer.invoke('stt:local:start'),
  sttStop: () => ipcRenderer.invoke('stt:local:stop'),
  onSttLog: (cb) => subscribe('stt:local:log', cb),
  onAutoSend: (cb) => subscribe('hearing:auto-send', cb),
});

expose('live2dAPI', {
  onCommand: (cb) => subscribe('live2d:cmd', cb),
  directExpressions: (sentences, context) => ipcRenderer.invoke('live2d:direct-expressions', sentences, context),
});

expose('skillsAPI', {
  getConfig: () => ipcRenderer.invoke('skills:get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('skills:save-config', cfg),
  listAll: () => ipcRenderer.invoke('skills:list'),
  listCollections: () => ipcRenderer.invoke('skills:list-collections'),
  importFolder: () => ipcRenderer.invoke('skills:import-folder'),
  removeCollection: (collId) => ipcRenderer.invoke('skills:remove-collection', collId),
});

expose('avatarAPI', {
  get: () => ipcRenderer.invoke('avatar:get'),
  importFolder: () => ipcRenderer.invoke('avatar:import-folder'),
  save: (cfg) => ipcRenderer.invoke('avatar:save', cfg),
  select: (modelId) => ipcRenderer.invoke('avatar:select', modelId),
  delete: (modelId) => ipcRenderer.invoke('avatar:delete', modelId),
  onConfigChanged: (cb) => subscribe('avatar:config-changed', cb),
});

expose('liveAPI', {
  getConfig: () => ipcRenderer.invoke('live:get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('live:save-config', cfg),
  connect: () => ipcRenderer.invoke('live:connect'),
  disconnect: () => ipcRenderer.invoke('live:disconnect'),
  getStatus: () => ipcRenderer.invoke('live:status'),
  getRecent: () => ipcRenderer.invoke('live:recent'),
  openWindow: () => ipcRenderer.invoke('live:open-window'),
  togglePin: () => ipcRenderer.invoke('live:toggle-pin'),
  onUpdate: (cb) => subscribe('live:update', cb),
  getStage: () => ipcRenderer.invoke('live:stage:get'),
  setPhase: (phase) => ipcRenderer.invoke('live:stage:phase', phase),
  setSegment: (segment, title) => ipcRenderer.invoke('live:stage:segment', segment, title),
  setTheme: (theme) => ipcRenderer.invoke('live:stage:theme', theme),
  getCredits: () => ipcRenderer.invoke('live:stage:credits'),
  listCaptureSources: () => ipcRenderer.invoke('live:stage:sources'),
  setCapture: (source) => ipcRenderer.invoke('live:stage:capture', source),
  onFocus: (cb) => subscribe('live:focus', cb),
  pickBackground: () => ipcRenderer.invoke('live:stage:pick-background'),
  clearBackground: () => ipcRenderer.invoke('live:stage:clear-background'),
  onStage: (cb) => subscribe('live:stage', cb),
  testChat: (name, text) => ipcRenderer.invoke('live:test-chat', name, text),
  getRundown: () => ipcRenderer.invoke('live:rundown:get'),
  saveRundown: (items) => ipcRenderer.invoke('live:rundown:save', items),
  startRundown: () => ipcRenderer.invoke('live:rundown:start'),
  stopRundown: () => ipcRenderer.invoke('live:rundown:stop'),
  nextSegment: () => ipcRenderer.invoke('live:rundown:next'),
  extendSegment: (minutes) => ipcRenderer.invoke('live:rundown:extend', minutes),
  skipUpcoming: () => ipcRenderer.invoke('live:rundown:skip'),
  onDirector: (cb) => subscribe('live:director', cb),
  getPanel: () => ipcRenderer.invoke('live:panel:get'),
  onPanel: (cb) => subscribe('live:panel', cb),
  getShowSummary: () => ipcRenderer.invoke('live:show:summary'),
  onShowSummary: (cb) => subscribe('live:show-summary', cb),
  openShowLogs: () => ipcRenderer.invoke('live:show:open-logs'),
  startAi: () => ipcRenderer.invoke('live:ai:start'),
  stopAi: () => ipcRenderer.invoke('live:ai:stop'),
  ownerSay: (text) => ipcRenderer.invoke('live:owner-say', text),
});
