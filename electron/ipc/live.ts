/**
 * 直播：设置读写、弹幕姬连接、直播间画面、AI 互动开关，以及主播在控制台对她说话。
 *
 * - liveHub 的批量更新推给所有窗口：弹幕姬（控制台）显示事件，主窗口的直播间画面做弹幕和特效。
 * - 直播间画面就是主窗口换了一身：16:9、背景、弹幕、字幕，聊天面板藏起来；用 OBS / 直播姬采集这个窗口。
 * - 弹幕姬窗口兼做控制台，开播时主播在这里操作和打字，不会出现在画面里。
 */

import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, shell } from 'electron';
import * as sttServerManager from '../sttServerManager';
import { join } from 'path';
import {
  LIVE_SEGMENTS,
  LIVE_THEMES,
  type LiveCaptureSource,
  type LiveConfig,
  type LiveFocus,
  type LiveSegment,
  type LiveStagePhase,
  type LiveStageState,
  type LiveStatus,
  type LiveTheme,
} from '../../shared/types/live';
import { getLiveConfig, persistAppConfig, setLiveConfig } from '../config/runtimeConfig';
import { broadcastToWindows, sendToRenderer } from '../mainWindow';
import { liveHub } from '../streaming/liveHub';
import { streamerSession } from '../streaming/streamerSession';
import { streamerController } from '../streaming/streamerController';
import { ShowLog } from '../streaming/showLog';
import * as show from '../streaming/showRunner';
import { listSegments } from '../streaming/segments/registry';
import { LiveMemory } from '../streaming/memory/liveMemory';
import { LiveMemoryStore } from '../streaming/memory/liveMemoryStore';
import type { Topic } from '../streaming/attention/topics';
import { getAgentMode, setAgentMode } from '../agentMode';
import { sendChatMessage } from '../aiService';
import { defaultConversationId, getActiveConversationId } from './chat';
import { setStageWindow } from './window';

let liveWindow: BrowserWindow | null = null;
let phase: LiveStagePhase = 'off';
let segment: LiveSegment = 'chat';
let theme: LiveTheme = LIVE_SEGMENTS.chat.theme;
let stageTitle = LIVE_SEGMENTS.chat.title;
let capture: LiveCaptureSource | null = null;
const showLog = new ShowLog();
/** 开 AI 互动前的对话模式，停的时候还原 */
let modeBeforeAi: string | null = null;
let liveMemory: LiveMemory | null = null;

function stageState(): LiveStageState {
  return {
    on: phase !== 'off',
    phase,
    segment,
    theme,
    title: stageTitle,
    background: getLiveConfig().background,
    capture,
    aiRunning: streamerController.isRunning && streamerSession.running,
  };
}

function broadcastStage(): LiveStageState {
  const state = stageState();
  broadcastToWindows('live:stage', state);
  return state;
}

function openLiveWindow(): void {
  if (liveWindow && !liveWindow.isDestroyed()) {
    if (liveWindow.isMinimized()) liveWindow.restore();
    liveWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 400,
    height: 720,
    minWidth: 300,
    minHeight: 400,
    title: '弹幕姬',
    autoHideMenuBar: true,
    backgroundColor: '#16161c',
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  liveWindow = win;
  win.on('closed', () => {
    if (liveWindow === win) liveWindow = null;
  });
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/live.html`);
  } else {
    void win.loadFile(join(__dirname, '../renderer/live.html'));
  }
}

function connectSaved(): { ok: boolean; detail?: string; status: LiveStatus } {
  const cfg = getLiveConfig();
  if (!cfg.roomId) return { ok: false, detail: '还没有填写直播间房间号', status: liveHub.status() };
  return { ok: true, status: liveHub.connect(cfg) };
}

/** 只有直播中（或没开画面时）她才自己回应弹幕；准备中、开场、谢幕都不插话 */
function syncAutoReply(): void {
  streamerSession.setAutoReply(phase === 'live' || phase === 'off');
}

function setPhase(next: LiveStagePhase): LiveStageState {
  const prev = phase;
  if (next === prev) return broadcastStage();
  phase = next;
  setStageWindow(next !== 'off');
  if (next === 'opening' || prev === 'off') showLog.reset();
  // 一场的记录：开场开始记，回到桌宠时写汇总；节目单只在直播中跑
  if (next === 'opening' || next === 'live') show.beginRecording();
  if (next === 'live') show.startRundown();
  else show.stopRundown();
  syncAutoReply();
  const aiOn = streamerController.isRunning && streamerSession.running;
  if (aiOn && next === 'live' && prev === 'opening') {
    void streamerController.announce({ kind: 'opening', segmentTitle: stageTitle, plan: show.rundownTitles() });
  } else if (aiOn && next === 'ending') {
    void streamerController.announce({ kind: 'ending', summary: showLog.summary() });
  }
  if (next === 'off') show.finishRecording();
  return broadcastStage();
}

function setSegment(next: LiveSegment, title?: string): LiveStageState {
  segment = LIVE_SEGMENTS[next] ? next : 'chat';
  stageTitle = title?.trim() || LIVE_SEGMENTS[segment].title;
  theme = LIVE_SEGMENTS[segment].theme;
  streamerSession.setTopic(LIVE_SEGMENTS[segment].topic);
  show.layoutChanged(segment);
  return broadcastStage();
}

function setTheme(next: LiveTheme): LiveStageState {
  if (LIVE_THEMES[next]) theme = next;
  return broadcastStage();
}

async function listCaptureSources(): Promise<LiveCaptureSource[]> {
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 240, height: 135 } });
  return sources
    // 不采自己（直播间画面、控制台）
    .filter((s) => !/^Hiyori|弹幕姬/.test(s.name))
    .map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
}

function onTopic(topic: Topic): void {
  const ids = (() => {
    switch (topic.kind) {
      case 'chat': return topic.picks.map((p) => p.event.id);
      case 'superchat': return [topic.event.id];
      case 'thanks': return topic.events.map((e) => e.id);
      case 'gifts': return topic.events.map((e) => e.id);
      default: return [];
    }
  })();
  const focus: LiveFocus = { kind: topic.kind, eventIds: ids };
  broadcastToWindows('live:focus', focus);
}

function startAi(): { ok: boolean; detail?: string; state: LiveStageState } {
  const cfg = getLiveConfig();
  if (!cfg.roomId) return { ok: false, detail: '还没有填写直播间房间号', state: stageState() };
  streamerSession.start(
    { platform: cfg.platform, roomId: cfg.roomId, topic: LIVE_SEGMENTS[segment].topic, autoReply: true },
    cfg.cookie,
  );
  syncAutoReply();
  streamerController.start();
  // 直播模式：主播跟她说的话、她的回答都会在直播里说出来
  if (getAgentMode() !== 'streamer') {
    modeBeforeAi = getAgentMode();
    setAgentMode('streamer');
    broadcastToWindows('agent-mode:changed', 'streamer');
  }
  return { ok: true, state: broadcastStage() };
}

function stopAi(): LiveStageState {
  streamerController.stop();
  streamerSession.stop();
  if (modeBeforeAi) {
    setAgentMode(modeBeforeAi);
    broadcastToWindows('agent-mode:changed', modeBeforeAi);
    modeBeforeAi = null;
  }
  return broadcastStage();
}

// ── 主人语音同台（按键说话）──────────────────────────────
// 控制台窗口采麦克风、连本地 faster-whisper 转写；这里只管打断她、让出话筒、把转写交给发言出口。

/** 全局热键：在游戏里也能按（按一下开始说，再按一下说完） */
const PTT_HOTKEY = 'F8';

async function setOwnerMic(on: boolean): Promise<{ ok: boolean; detail?: string; wsUrl?: string }> {
  if (!on) {
    if (globalShortcut.isRegistered(PTT_HOTKEY)) globalShortcut.unregister(PTT_HOTKEY);
    return { ok: true };
  }
  const status = await sttServerManager.getStatus();
  if (!status.installed) return { ok: false, detail: '还没装语音识别：到设置里安装 STT，或者让她「安装语音识别」' };
  if (!status.running || !status.healthy) {
    const started = await sttServerManager.startServer();
    if (!started.ok) return { ok: false, detail: `语音识别服务没起来：${started.detail}` };
  }
  if (!globalShortcut.isRegistered(PTT_HOTKEY)) {
    globalShortcut.register(PTT_HOTKEY, () => {
      if (liveWindow && !liveWindow.isDestroyed()) liveWindow.webContents.send('live:ptt-toggle');
    });
  }
  return { ok: true, wsUrl: sttServerManager.getWebSocketUrl() };
}

function ownerVoice(state: 'listening' | 'heard' | 'idle', text = ''): void {
  broadcastToWindows('live:owner-voice', { state, text });
}

/** 主播在控制台打字跟她说话：走正常对话（直播模式下她的回答会说出来），并同步到主窗口的聊天记录 */
async function ownerSay(text: string): Promise<{ ok: boolean; reply?: string; detail?: string }> {
  const content = text.trim();
  if (!content) return { ok: false, detail: '内容为空' };
  const conversationId = getActiveConversationId() ?? defaultConversationId();
  try {
    const result = await sendChatMessage(conversationId, content, {
      trigger: { actor: 'user', source: 'desktop', event: 'live-console' },
      sourceContext: '主播（开发者本人）正在直播中，从直播控制台打字跟你说话；观众听不到主播，只听得到你的回答。',
    });
    sendToRenderer('chat:external-turn', { conversationId, user: content, assistant: result.content, createdAt: result.created_at });
    return { ok: true, reply: result.content };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

export function registerLiveIpc(): void {
  show.initShowRunner({
    dataDir: app.getPath('userData'),
    // 环节自带布局：换环节时画面跟着换（主播手动切走则环节暂停）
    applyLayout: (layout) => { if (layout !== segment) setSegment(layout); },
    broadcast: broadcastToWindows,
  });
  try {
    liveMemory = new LiveMemory(new LiveMemoryStore(join(app.getPath('userData'), 'live-memory.db')));
    streamerSession.setMemory(liveMemory, () => showLog.summary());
  } catch (err) {
    // 记忆坏了不影响直播
    console.warn('[LiveMemory] 打不开直播记忆库:', (err as Error).message);
  }
  liveHub.onUpdate((update) => {
    showLog.observeOnline(update.status.stats.online);
    broadcastToWindows('live:update', update);
  });
  liveHub.subscribe((event, isUpdate) => showLog.observe(event, isUpdate));
  streamerController.on('state', () => broadcastStage());
  streamerController.on('topic', onTopic);

  ipcMain.handle('live:get-config', () => getLiveConfig());

  ipcMain.handle('live:save-config', (_e, cfg: LiveConfig) => {
    setLiveConfig({
      platform: cfg.platform === 'bilibili' ? cfg.platform : 'bilibili',
      roomId: Math.max(0, Math.floor(Number(cfg.roomId) || 0)),
      cookie: String(cfg.cookie ?? '').trim(),
      background: String(cfg.background ?? getLiveConfig().background ?? ''),
    });
    persistAppConfig();
    // 已连着就按新设置重连；roomId 清空则断开
    if (liveHub.currentConfig) return getLiveConfig().roomId ? liveHub.connect(getLiveConfig()) : liveHub.disconnect();
    return liveHub.status();
  });

  ipcMain.handle('live:connect', () => connectSaved());
  ipcMain.handle('live:disconnect', () => liveHub.disconnect());
  ipcMain.handle('live:status', () => liveHub.status());
  ipcMain.handle('live:recent', () => liveHub.recentEvents());
  ipcMain.handle('live:open-window', () => openLiveWindow());
  ipcMain.handle('live:toggle-pin', () => {
    if (!liveWindow || liveWindow.isDestroyed()) return false;
    const next = !liveWindow.isAlwaysOnTop();
    liveWindow.setAlwaysOnTop(next);
    return next;
  });

  ipcMain.handle('live:stage:get', () => stageState());
  ipcMain.handle('live:stage:phase', (_e, next: LiveStagePhase) =>
    setPhase((['off', 'waiting', 'opening', 'live', 'ending'] as const).includes(next) ? next : 'off'));
  ipcMain.handle('live:stage:segment', (_e, next: LiveSegment, title?: string) => setSegment(next, title));
  ipcMain.handle('live:stage:theme', (_e, next: LiveTheme) => setTheme(next));
  ipcMain.handle('live:stage:credits', () => showLog.credits());
  ipcMain.handle('live:stage:sources', () => listCaptureSources());
  ipcMain.handle('live:stage:capture', (_e, source: LiveCaptureSource | null) => {
    capture = source ? { id: String(source.id), name: String(source.name) } : null;
    return broadcastStage();
  });
  ipcMain.handle('live:stage:pick-background', async () => {
    const parent = liveWindow && !liveWindow.isDestroyed() ? liveWindow : undefined;
    const options = {
      title: '选择直播间背景（视频或图片）',
      properties: ['openFile' as const],
      filters: [
        { name: '视频或图片', extensions: ['mp4', 'webm', 'mov', 'png', 'jpg', 'jpeg', 'gif', 'webp'] },
      ],
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return stageState();
    setLiveConfig({ ...getLiveConfig(), background: result.filePaths[0] });
    persistAppConfig();
    return broadcastStage();
  });
  ipcMain.handle('live:stage:clear-background', () => {
    setLiveConfig({ ...getLiveConfig(), background: '' });
    persistAppConfig();
    return broadcastStage();
  });
  ipcMain.handle('live:ai:start', () => startAi());
  ipcMain.handle('live:ai:stop', () => stopAi());
  ipcMain.handle('live:owner-say', (_e, text: string) => ownerSay(String(text ?? '')));
  ipcMain.handle('live:owner-mic', (_e, on: boolean) => setOwnerMic(!!on));
  // 按下说话键：她立刻停下；松开：转写结果交给她接话
  ipcMain.handle('live:ptt:down', () => {
    if (!streamerController.isRunning) return false;
    streamerController.ownerStarted();
    ownerVoice('listening');
    return true;
  });
  ipcMain.handle('live:ptt:up', (_e, text: string) => {
    const said = String(text ?? '').trim().slice(0, 300);
    ownerVoice(said ? 'heard' : 'idle', said);
    void streamerController.ownerFinished(said);
    return true;
  });
  // 没开播时测试：以测试观众的身份发一条弹幕（和真实弹幕走同一条路）
  ipcMain.handle('live:test-chat', (_e, name: string, text: string) => {
    if (!streamerSession.running) return false;
    streamerSession.ingestTest(String(name || '测试观众').slice(0, 20), String(text ?? '').slice(0, 200));
    return true;
  });

  // 节目单
  ipcMain.handle('live:rundown:get', () => ({ segments: listSegments(), state: show.directorState() }));
  ipcMain.handle('live:rundown:save', (_e, items: unknown) => show.saveRundown(Array.isArray(items) ? items : []));
  // 没开画面测试时手动开始 / 停止（开了画面由阶段机管）
  ipcMain.handle('live:rundown:start', () => { show.startRundown(); return show.directorState(); });
  ipcMain.handle('live:rundown:stop', () => {
    show.stopRundown();
    if (phase === 'off') show.finishRecording();
    return show.directorState();
  });
  ipcMain.handle('live:rundown:next', () => { show.nextSegment(); return show.directorState(); });
  ipcMain.handle('live:rundown:extend', (_e, minutes: number) => { show.extendSegment(Number(minutes) || 5); return show.directorState(); });
  ipcMain.handle('live:rundown:skip', () => { show.skipUpcoming(); return show.directorState(); });
  ipcMain.handle('live:panel:get', () => show.currentPanel());
  ipcMain.handle('live:memory:stats', () => liveMemory?.store.counts() ?? null);
  ipcMain.handle('live:memory:clear', () => {
    liveMemory?.store.clearAll();
    return liveMemory?.store.counts() ?? null;
  });
  ipcMain.handle('live:show:summary', () => show.lastShowSummary());
  ipcMain.handle('live:show:open-logs', async () => {
    const dir = show.logsDir();
    if (!dir) return false;
    await shell.openPath(dir);
    return true;
  });
}

/** 退出前断开（避免重连定时器拖住进程） */
export function shutdownLive(): void {
  if (globalShortcut.isRegistered(PTT_HOTKEY)) globalShortcut.unregister(PTT_HOTKEY);
  streamerController.stop();
  liveHub.onUpdate(null);
  liveHub.disconnect();
}
