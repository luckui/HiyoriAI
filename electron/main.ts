/// <reference types="node" />
// 必须在所有 import 之前加载，这样 ai.config.ts 里的 process.env 才能取到局部 .env 的实际内容
import * as dotenv from 'dotenv';
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, session } from 'electron';
import { join } from 'path';

/**
 * 持久化 .env 文件路径：
 *   dev  → 项目根目录（便于直接编辑）
 *   打包 → app.getPath('userData')（系统用户数据目录，跨版本升级不丢失）
 *          Windows: %AppData%\<AppName>\.env
 */
function getEnvFilePath(): string {
  return app.isPackaged
    ? join(app.getPath('userData'), '.env')
    : join(app.getAppPath(), '.env');
}

/**
 * 启动时环境变量合并：
 *   1. 优先读取 userData/.env（用户自定义值）
 *   2. 对 userData/.env 里缺失的键，从 resources/.env.defaults（打包时的项目 .env）补充
 *   这样升级后新增的配置项能自动填入默认值，同时不覆盖用户已有配置。
 */
function migrateEnvFile(): void {
  if (!app.isPackaged) return;
  const fs = require('fs') as typeof import('fs');
  const userDataEnv  = getEnvFilePath();
  const defaultsPath = join(process.resourcesPath, '.env.defaults');

  // 读取默认值（打包时的 .env）
  let defaults: Record<string, string> = {};
  if (fs.existsSync(defaultsPath)) {
    try {
      const raw = fs.readFileSync(defaultsPath, 'utf-8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
        if (m) defaults[m[1].trim()] = m[2].trim();
      }
    } catch { /* 读取失败忽略 */ }
  }

  // 读取用户配置（可能不存在）
  let userLines: string[] = [];
  let userKeys  = new Set<string>();
  if (fs.existsSync(userDataEnv)) {
    try {
      userLines = fs.readFileSync(userDataEnv, 'utf-8').split('\n');
      for (const line of userLines) {
        const m = line.match(/^([^#=\s][^=]*)=/);
        if (m) userKeys.add(m[1].trim());
      }
    } catch { /* 读取失败从空开始 */ }
  }

  // 把 defaults 里有但 userData/.env 里缺的键追加进去
  const missing = Object.entries(defaults).filter(([k]) => !userKeys.has(k));
  if (missing.length > 0 || userLines.length === 0) {
    for (const [k, v] of missing) userLines.push(`${k}=${v}`);
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(userDataEnv, userLines.filter(l => l !== '').join('\n') + '\n', 'utf-8');
      if (missing.length > 0) {
        console.info(`[Config] 补充了 ${missing.length} 个缺失配置项:`, missing.map(([k]) => k).join(', '));
      }
    } catch (e) {
      console.warn('[Config] 写入 userData/.env 失败:', (e as Error).message);
    }
  }
}

// 迁移后再加载（迁移必须在 dotenv.config 之前）
migrateEnvFile();
// 启动时从正确路径加载 .env
dotenv.config({ path: getEnvFilePath() });
import {
  initDatabase,
  createConversation,
  listConversations,
  getMessages,
  deleteConversation,
  renameConversation,
  getSetting,
  setSetting,
  countNonSystemMessages,
  getMemoryCursor,
  getMemoryFragments,
  getGlobalMemoryCursor,
  getStructuredGlobalMemory,
  setStructuredGlobalMemory,
  addMessage as dbAddMessage,
} from './db';
import { sendChatMessage, setToolEventListener, stopCurrentAI } from './aiService';
import { triggerConversationLeave, memoryManager, globalMemoryManager, runStartupCatchUp, startIdleScheduler } from './memory/index';
import { exportMemoryToMarkdown, importMemoryFromMarkdown } from './memory/memoryExport';
import aiConfig from './ai.config';
import { startBridges, stopBridges } from './bridges/index';
import { setCodingAgentNotifier } from './codingAgents';
import { DiscordAdapter } from './bridges/adapters/discord';
import { WeChatAdapter, qrLogin } from './bridges/adapters/wechat';
import { ttsService } from './ttsService';
import defaultTTSConfig from './tts.config';
import type { TTSConfig, TTSProviderConfig } from './tts.config';
import { getAgentMode, setAgentMode } from './agentMode';
import { getSkillsConfig, saveSkillsConfig } from './skillsConfig';
import { listTopicsForUI, listCollections, importSkillFolder, removeUserCollection } from './tools/impl/manual';
import * as ttsServerManager from './ttsServerManager';
import * as sttServerManager from './sttServerManager';
import { hearingManager } from './hearingManager';
import { taskManager } from './taskManager';
import { taskScheduler } from './taskScheduler';
import { initLive2DBridge } from './live2dBridge';

// ── 实运行时加载持久化的 LLM 配置 ──────────────────────────────

/**
 * 用户可在 UI 修改的字段：apiKey / baseUrl / model / temperature / maxTokens / name
 * 其余字段（systemPrompt / extraParams / thinkingBudgetTokens）属于开发者配置，
 * 始终以 ai.config.ts 代码为准，不从数据库覆盖。
 * 这样每次更新提示词后重启即可生效，不需要用户手动清空数据库。
 */
const USER_EDITABLE_FIELDS = ['apiKey', 'baseUrl', 'model', 'temperature', 'maxTokens', 'name'] as const;
/** 内置 LLM 方案 key，禁止删除，始终从代码默认值恢复 */
const BUILTIN_LLM_PROVIDERS = new Set(Object.keys(aiConfig.providers));
/** 内置 TTS 方案 key，禁止删除，始终从代码默认值恢复 */
const BUILTIN_TTS_PROVIDERS = new Set(Object.keys(defaultTTSConfig.providers));
// ── TTS 多 Provider 内存配置 ──────────────────────────────────────
let ttsConfig: TTSConfig = JSON.parse(JSON.stringify(defaultTTSConfig));

/**
 * 根据 ttsConfig 当前状态激活/禁用 ttsService
 */
function activateTTSProvider(): void {
  console.log(`[TTS] activateTTSProvider: enabled=${ttsConfig.enabled}, activeProvider=${ttsConfig.activeProvider}`);
  if (!ttsConfig.enabled) {
    console.log('[TTS] → 全局开关关闭，禁用 TTS');
    ttsService.configure(null);
    return;
  }
  const provider = ttsConfig.providers[ttsConfig.activeProvider];
  if (!provider) {
    console.log(`[TTS] → 找不到 provider "${ttsConfig.activeProvider}"，禁用 TTS`);
    ttsService.configure(null);
    return;
  }
  console.log(`[TTS] → 激活 provider "${ttsConfig.activeProvider}": url=${provider.baseUrl}, speaker=${provider.speaker}, engine=${provider.localEngine ?? 'none'}`);
  ttsService.configure(provider);
}

/** 广播 TTS 配置变化给所有窗口 */
function broadcastTTSChanged(): void {
  const { BrowserWindow } = require('electron') as typeof import('electron');
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('tts:config-changed');
  }
}

/** 供 manageTTS 工具调用：获取当前 TTS 配置 */
export function getTTSConfig(): TTSConfig {
  return ttsConfig;
}

/** 供 manageTTS 工具调用：更新 TTS 配置并激活 */
export function updateTTSConfig(newCfg: Partial<TTSConfig>): void {
  if (newCfg.enabled !== undefined) ttsConfig.enabled = newCfg.enabled;
  if (newCfg.activeProvider !== undefined) ttsConfig.activeProvider = newCfg.activeProvider;
  if (newCfg.providers !== undefined) ttsConfig.providers = newCfg.providers;
  if (newCfg.deletedProviders !== undefined) {
    ttsConfig.deletedProviders = newCfg.deletedProviders.filter(k => !BUILTIN_TTS_PROVIDERS.has(k));
  }
  activateTTSProvider();
  setSetting('tts_config', JSON.stringify(ttsConfig));
  broadcastTTSChanged();
}

/**
 * 播放 TTS 音频（自动生成并发送到渲染进程）
 * 供主进程中的自动化流程（如 streamerController）调用
 */
export async function playTTSAudio(text: string): Promise<boolean> {
  if (!mainWin || mainWin.isDestroyed() || mainWin.webContents.isDestroyed()) {
    console.warn('[TTS] playTTSAudio → 跳过: 主窗口不可用');
    return false;
  }
  // 直接发送文本到渲染进程，让渲染进程调用 playTTS()（复用聊天框逻辑）
  mainWin.webContents.send('tts:play', { text });
  console.log(`[TTS] playTTSAudio → 发送文本到渲染进程: ${text.substring(0, 50)}...`);
  return true;
}

/**
 * 向指定对话注入一条 AI 消息（无需用户输入，适用于异步任务完成通知）
 *
 * 流程：
 *   1. 持久化到对话历史（role: 'assistant'）
 *   2. 推送 chat:agent-message 到渲染层 → 聊天窗口显示消息气泡
 *   3. 触发 TTS 播报（如窗口可用）
 *
 * 供使用：
 *   - speak 工具（后台 agent 主动通知用户）
 */
export async function injectAgentMessage(
  conversationId: string,
  content: string,
): Promise<void> {
  // 1. 持久化
  dbAddMessage({ conversation_id: conversationId, role: 'assistant', content });

  // 2. 推送到渲染层聊天窗口
  if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isDestroyed()) {
    mainWin.webContents.send('chat:agent-message', { conversationId, content });
  }

  // 3. TTS 播报
  await playTTSAudio(content);
}

/**
 * 唤醒父对话的 AI：触发新一轮 AI 处理（仅用于 background/batch 异步任务完成后）。
 *
 * 与 injectAgentMessage 的区别：
 *   injectAgentMessage = AI 主动说话（speak 工具，子智能体自己发）
 *   sendAgentWakeup     = 系统通知主对话 AI「子任务结果来了，继续工作流」
 *
 * 仅对 background/batch 任务使用。cron 任务由子智能体自己用 speak 通知用户。
 */
export function sendAgentWakeup(conversationId: string, triggerText: string): void {
  if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isDestroyed()) {
    mainWin.webContents.send('chat:agent-wakeup', { conversationId, text: triggerText });
    console.log(`[Agent Wakeup] 唤醒对话 ${conversationId.slice(0, 8)}…: ${triggerText.slice(0, 80)}`);
  }
}

function loadPersistedConfig(): void {
  const stored = getSetting('llm_config');
  if (!stored) return;
  try {
    const saved = JSON.parse(stored) as typeof aiConfig;
    if (saved.activeProvider) aiConfig.activeProvider = saved.activeProvider;
    if (saved.contextWindowRounds) aiConfig.contextWindowRounds = saved.contextWindowRounds;

    // 记录用户曾主动删除的 provider key（排除内置方案）
    const deletedProviders: string[] = (saved.deletedProviders ?? []).filter((k: string) => !BUILTIN_LLM_PROVIDERS.has(k));
    aiConfig.deletedProviders = deletedProviders;

    if (saved.providers && Object.keys(saved.providers).length > 0) {
      for (const [key, codeProv] of Object.entries(aiConfig.providers)) {
        const dbProv = saved.providers[key];
        if (!dbProv) continue; // DB 里没有此 provider，保留代码默认值
        // 只把用户可编辑字段从 DB 合并进来，开发者字段（systemPrompt 等）始终用代码版本
        for (const field of USER_EDITABLE_FIELDS) {
          if (dbProv[field] !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (codeProv as any)[field] = dbProv[field];
          }
        }
      }
      // 将 DB 里用户自行新增的 provider（代码里没有的）也加进来
      for (const [key, dbProv] of Object.entries(saved.providers)) {
        if (!(key in aiConfig.providers) && !deletedProviders.includes(key)) {
          aiConfig.providers[key] = dbProv;
        }
      }
    }
  } catch {
    // 解析失败时保持默认配置
  }

  // ── 从 SQLite 恢复 TTS 配置（多 Provider 格式 + 合并新增默认） ──
  const storedTTS = getSetting('tts_config');
  if (storedTTS) {
    try {
      const saved = JSON.parse(storedTTS);
      if (saved.providers && saved.activeProvider) {
        // 新格式：多 Provider
        ttsConfig.enabled = saved.enabled ?? false;
        ttsConfig.activeProvider = saved.activeProvider;
        ttsConfig.providers = {}; // 先清空，重新构建
        // 清洗 deletedProviders：内置方案不允许残留在删除列表中
        ttsConfig.deletedProviders = (saved.deletedProviders ?? []).filter((k: string) => !BUILTIN_TTS_PROVIDERS.has(k));

        // 内置方案：强制从代码默认值恢复，仅保留用户的 speaker / language
        for (const [key, codeProv] of Object.entries(defaultTTSConfig.providers)) {
          const dbProv = saved.providers[key];
          if (dbProv) {
            // DB 中有此内置方案：仅保留用户可编辑字段
            ttsConfig.providers[key] = {
              ...codeProv,
              speaker: dbProv.speaker ?? codeProv.speaker,
              language: dbProv.language ?? codeProv.language,
            };
          } else {
            // DB 中缺失（被删除过）：整个补回
            ttsConfig.providers[key] = codeProv;
          }
        }

        // 将 DB 里用户自行新增的 provider 保留（非内置且未删除）
        const deleted = new Set(ttsConfig.deletedProviders);
        for (const [key, dbProv] of Object.entries(saved.providers)) {
          if (!BUILTIN_TTS_PROVIDERS.has(key) && !deleted.has(key)) {
            ttsConfig.providers[key] = dbProv as TTSProviderConfig;
          }
        }

        // 若 activeProvider 指向已不存在的 key，回退到默认
        if (!(ttsConfig.activeProvider in ttsConfig.providers)) {
          ttsConfig.activeProvider = defaultTTSConfig.activeProvider;
        }
      } else if (saved.url !== undefined) {
        // 旧格式迁移：{ enabled, url, apiKey, speaker, language }
        const migrated: TTSConfig = {
          enabled: saved.enabled ?? false,
          activeProvider: 'migrated',
          providers: {
            migrated: {
              type: 'http-tts',
              name: '迁移的 TTS 服务',
              baseUrl: saved.url || 'http://127.0.0.1:9880',
              apiKey: saved.apiKey || '',
              speaker: saved.speaker || 'xiaoxiao',
              language: saved.language || 'Auto',
            },
            ...defaultTTSConfig.providers,
          },
          deletedProviders: [],
        };
        ttsConfig = migrated;
        // 回写新格式
        setSetting('tts_config', JSON.stringify(ttsConfig));
        console.info('[TTS] 已从旧格式迁移到多 Provider 格式');
      }
    } catch { /* 解析失败保持默认 */ }
  }
}

/** 当前活跃对话 ID，用于切换时触发全局记忆精炼 */
let activeConversationId: string | null = null;

/** 全局窗口引用，用于向渲染层推送退出状态 */
let mainWin: BrowserWindow | null = null;

function createWindow(): void {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  const win = new BrowserWindow({
    width: 360,
    height: 620,
    x: width - 380,
    y: height - 640,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    }
  });
  mainWin = win;
  initLive2DBridge(win);

  // 启动时用 screen-saver 层级，确保盖过全屏应用和其他 alwaysOnTop 窗口
  win.setAlwaysOnTop(true, 'screen-saver');

  // 置顶切换
  let pinned = true;
  ipcMain.on('window-pin', () => {
    pinned = !pinned;
    if (pinned) {
      win.setAlwaysOnTop(true, 'screen-saver');
    } else {
      win.setAlwaysOnTop(false);
    }
    win.webContents.send('window-pin-state', pinned);
  });
  win.on('closed', () => ipcMain.removeAllListeners('window-pin'));

  // ── 工具调用调试事件：AI 每次调用工具时实时推送给渲染层 ──────
  setToolEventListener((ev) => {
    if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isDestroyed()) {
      mainWin.webContents.send('tool-call-log', ev);
    }
  });
  win.on('closed', () => setToolEventListener(null));

  // ── 全屏光标追踪：每帧推送光标屏幕坐标给渲染层，用于 Live2D 目光追踪 ──
  const cursorInterval = setInterval(() => {
    if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isDestroyed()) {
      const { x, y } = screen.getCursorScreenPoint();
      mainWin.webContents.send('cursor-position', { x, y });
    }
  }, 16); // ~60fps
  win.on('closed', () => clearInterval(cursorInterval));

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // ── 窗口控制 ──────────────────────────────────────────────
  ipcMain.on('window-drag', (_e, { deltaX, deltaY }: { deltaX: number; deltaY: number }) => {
    const [x, y] = win.getPosition();
    win.setPosition(x + deltaX, y + deltaY);
  });

  ipcMain.on('window-close', () => app.quit());

  ipcMain.on('window-resize', (_e, { width: w, height: h }: { width: number; height: number }) => {
    const bounds = win.getBounds();
    const { height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    // 钳位 y：确保窗口扩展后不超出屏幕底部（保留 6px 间距）
    const clampedY = Math.min(bounds.y, screenH - h - 6);
    win.setBounds({ x: bounds.x, y: Math.max(0, clampedY), width: w, height: h });
  });

  // ── 对话管理 ──────────────────────────────────────────────
  ipcMain.handle('chat:create-conversation', () => createConversation());
  ipcMain.handle('chat:list-conversations', () => listConversations());
  ipcMain.handle('chat:load-conversation', (_e, id: string) => {
    // 切换到不同对话时，触发旧对话的离开流水线（强制衦1 + 全局精炼）
    if (activeConversationId && activeConversationId !== id) {
      triggerConversationLeave(activeConversationId);
    }
    activeConversationId = id;
    return getMessages(id);
  });
  ipcMain.handle('chat:delete-conversation', (_e, id: string) => deleteConversation(id));
  ipcMain.handle('chat:rename-conversation', (_e, id: string, title: string) =>
    renameConversation(id, title)
  );

  // ── AI 发送消息 ────────────────────────────────────────────
  ipcMain.handle('chat:send', (_e, conversationId: string, content: string) =>
    sendChatMessage(conversationId, content)
  );

  // ── AI 停止回答 ────────────────────────────────────────────
  ipcMain.handle('chat:stop', () => {
    stopCurrentAI();
  });

  // ── LLM 设置 ──────────────────────────────────────────────
  ipcMain.handle('settings:get', () => ({
    activeProvider: aiConfig.activeProvider,
    contextWindowRounds: aiConfig.contextWindowRounds,
    providers: aiConfig.providers,
    deletedProviders: aiConfig.deletedProviders ?? [],
  }));

  ipcMain.handle('settings:save', (_e, newCfg: typeof aiConfig) => {
    aiConfig.activeProvider = newCfg.activeProvider;
    aiConfig.contextWindowRounds = newCfg.contextWindowRounds;
    aiConfig.providers = newCfg.providers; // 完全替换
    // 内置方案不允许出现在删除列表中
    aiConfig.deletedProviders = (newCfg.deletedProviders ?? []).filter(k => !BUILTIN_LLM_PROVIDERS.has(k));
    setSetting('llm_config', JSON.stringify({
      activeProvider: newCfg.activeProvider,
      contextWindowRounds: newCfg.contextWindowRounds,
      providers: newCfg.providers,
      deletedProviders: aiConfig.deletedProviders,
    }));
  });

  // ── Discord 设置 ──────────────────────────────────────────
  ipcMain.handle('discord:get', () => {
    return {
      enabled:         process.env['DISCORD_ENABLED'] === 'true',
      token:           process.env['DISCORD_TOKEN'] ?? '',
      allowedChannels: process.env['DISCORD_ALLOWED_CHANNELS'] ?? '',
      proxyUrl:        process.env['DISCORD_PROXY'] ?? '',
    };
  });

  ipcMain.handle('discord:status', () => {
    return DiscordAdapter.activeClient !== null ? 'online' : 'offline';
  });

  ipcMain.handle('discord:save', async (_e, cfg: {
    enabled: boolean; token: string; allowedChannels: string; proxyUrl: string;
  }) => {
    // ① 先更新内存 env（当前会话立即生效，与文件写入无关）
    process.env['DISCORD_ENABLED']          = String(cfg.enabled);
    process.env['DISCORD_TOKEN']            = cfg.token;
    process.env['DISCORD_ALLOWED_CHANNELS'] = cfg.allowedChannels;
    process.env['DISCORD_PROXY']            = cfg.proxyUrl;

    // ② 再持久化到 .env 文件（失败只影响下次重启，不影响当前会话）
    try {
      const fs = require('fs') as typeof import('fs');
      const envPath = getEnvFilePath();
      let envContent = '';
      try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch { }
      const lines = envContent.split('\n').filter(l => !/^DISCORD_/.test(l.trim()));
      lines.push(`DISCORD_ENABLED=${cfg.enabled}`);
      lines.push(`DISCORD_TOKEN=${cfg.token}`);
      lines.push(`DISCORD_ALLOWED_CHANNELS=${cfg.allowedChannels}`);
      lines.push(`DISCORD_PROXY=${cfg.proxyUrl}`);
      fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
    } catch (e) {
      console.warn('[Discord config] 写入 .env 失败（仅影响持久化）:', (e as Error).message);
    }

    // ③ 重启 bridges
    await stopBridges();
    const convs = listConversations();
    const convId = convs.length > 0 ? convs[0].id : createConversation().id;
    await startBridges(convId).catch(e => console.error('[Discord] 重启失败:', (e as Error).message));
  });

  // ── TTS ──────────────────────────────────────────────────────
  ipcMain.handle('tts:speak:abort', () => {
    ttsService.abortAll();
  });

  ipcMain.handle('tts:speak', async (_e, text: string) => {
    console.log(`[TTS] tts:speak 收到请求: enabled=${ttsService.isEnabled}, text="${text.slice(0, 60)}…"`);
    if (!ttsService.isEnabled) {
      console.warn('[TTS] tts:speak → 跳过: TTS 未启用');
      return null;
    }
    try {
      const wav = await ttsService.speak(text);
      const data = Buffer.from(wav).toString('base64');
      console.log(`[TTS] tts:speak → 成功, ${wav.byteLength} bytes`);
      return { data };
    } catch (e) {
      console.error('[TTS] tts:speak → 失败:', (e as Error).message);
      return null;
    }
  });

  // ── WeChat 设置 ──────────────────────────────────────────────
  ipcMain.handle('wechat:get', () => {
    return {
      enabled:         process.env['WECHAT_ENABLED'] === 'true',
      token:           process.env['WECHAT_TOKEN'] ?? '',
      accountId:       process.env['WECHAT_ACCOUNT_ID'] ?? '',
      baseUrl:         process.env['WECHAT_BASE_URL'] ?? 'https://ilinkai.weixin.qq.com',
      sendChunkDelay:  parseFloat(process.env['WECHAT_SEND_CHUNK_DELAY'] ?? '0.35'),
    };
  });

  ipcMain.handle('wechat:status', () => {
    return WeChatAdapter.activeAdapter !== null ? 'online' : 'offline';
  });

  ipcMain.handle('wechat:save', async (_e, cfg: {
    enabled: boolean; token?: string; accountId?: string; baseUrl?: string; sendChunkDelay?: number;
  }) => {
    // 更新内存 env
    process.env['WECHAT_ENABLED']         = String(cfg.enabled);
    if (cfg.token) process.env['WECHAT_TOKEN'] = cfg.token;
    if (cfg.accountId) process.env['WECHAT_ACCOUNT_ID'] = cfg.accountId;
    if (cfg.baseUrl) process.env['WECHAT_BASE_URL'] = cfg.baseUrl;
    if (cfg.sendChunkDelay !== undefined) {
      process.env['WECHAT_SEND_CHUNK_DELAY'] = String(cfg.sendChunkDelay);
    }

    // 持久化到 .env 文件
    try {
      const fs = require('fs') as typeof import('fs');
      const envPath = getEnvFilePath();
      let envContent = '';
      try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch { }
      const lines = envContent.split('\n').filter(l => !/^WECHAT_/.test(l.trim()));
      lines.push(`WECHAT_ENABLED=${cfg.enabled}`);
      if (cfg.token) lines.push(`WECHAT_TOKEN=${cfg.token}`);
      if (cfg.accountId) lines.push(`WECHAT_ACCOUNT_ID=${cfg.accountId}`);
      if (cfg.baseUrl) lines.push(`WECHAT_BASE_URL=${cfg.baseUrl}`);
      if (cfg.sendChunkDelay !== undefined) {
        lines.push(`WECHAT_SEND_CHUNK_DELAY=${cfg.sendChunkDelay}`);
      }
      fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
    } catch (e) {
      console.warn('[WeChat config] 写入 .env 失败（仅影响持久化）:', (e as Error).message);
    }

    // 重启 bridges
    await stopBridges();
    const convs = listConversations();
    const convId = convs.length > 0 ? convs[0].id : createConversation().id;
    await startBridges(convId).catch(e => console.error('[WeChat] 重启失败:', (e as Error).message));
  });

  ipcMain.handle('wechat:qr-login', async (event) => {
    try {
      for await (const state of qrLogin()) {
        event.sender.send('wechat:qr-login-update', state);
        if (state.status === 'confirmed' && state.credentials) {
          // 保存凭证到 .env
          const creds = state.credentials;
          process.env['WECHAT_ENABLED']    = 'true';
          process.env['WECHAT_TOKEN']      = creds.token;
          process.env['WECHAT_ACCOUNT_ID'] = creds.accountId;
          process.env['WECHAT_BASE_URL']   = creds.baseUrl;
          
          try {
            const fs = require('fs') as typeof import('fs');
            const envPath = getEnvFilePath();
            let envContent = '';
            try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch { }
            const lines = envContent.split('\n').filter(l => !/^WECHAT_/.test(l.trim()));
            lines.push(`WECHAT_ENABLED=true`);
            lines.push(`WECHAT_TOKEN=${creds.token}`);
            lines.push(`WECHAT_ACCOUNT_ID=${creds.accountId}`);
            lines.push(`WECHAT_BASE_URL=${creds.baseUrl}`);
            fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
          } catch (e) {
            console.warn('[WeChat QR] 写入 .env 失败:', (e as Error).message);
          }
          
          // 登录成功后自动启动 adapter
          try {
            await stopBridges();
            const convs = listConversations();
            const convId = convs.length > 0 ? convs[0].id : createConversation().id;
            await startBridges(convId);
            console.log('[WeChat QR] adapter 已自动启动');
          } catch (e) {
            console.error('[WeChat QR] 自动启动 adapter 失败:', (e as Error).message);
          }
          
          return { success: true, credentials: creds };
        } else if (state.status === 'error' || state.status === 'expired') {
          return { success: false, error: state.error };
        }
      }
      return { success: false, error: '登录超时' };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Memory 导出/导入 ─────────────────────────────────────────
  ipcMain.handle('memory:export', async () => {
    const memory = getStructuredGlobalMemory();
    return await exportMemoryToMarkdown(memory);
  });

  ipcMain.handle('memory:import', async () => {
    const result = await importMemoryFromMarkdown();
    if (result.success && result.content) {
      // 导入成功，写入数据库
      setStructuredGlobalMemory(result.content);
    }
    return result;
  });

  // ── Agent 模式管理 ────────────────────────────────────────────
  ipcMain.handle('agent:get-mode', () => {
    return getAgentMode();
  });

  ipcMain.handle('agent:set-mode', (_e, mode: string) => {
    setAgentMode(mode);
    console.log(`[IPC] Agent 模式切换为: ${mode}`);
  });

  // ── Skills 配置管理 ────────────────────────────────────────
  ipcMain.handle('skills:get-config', () => {
    return getSkillsConfig();
  });

  ipcMain.handle('skills:save-config', (_e, cfg: ReturnType<typeof getSkillsConfig>) => {
    saveSkillsConfig(cfg);
  });

  /**
   * 返回所有可用 skill 的列表，供 UI 展示 / 选择。
   * 返回格式：{ name, summary, collection, skillKey }[]
   *   collection: skill 所属集合（"scientific" | "skills" | ...）
   *   skillKey:   在 disabledSkills 中使用的唯一标识符
   */
  ipcMain.handle('skills:list', () => {
    return listTopicsForUI();
  });

  /**
   * 返回所有集合的元信息列表，供 UI 动态渲染集合标题（无需硬编码）。
   * 返回格式：{ id, displayName, description }[]
   */
  ipcMain.handle('skills:list-collections', () => {
    // dirPath 仅主进程内部使用，剥掉后再发给渲染进程
    return listCollections().map(({ dirPath: _dp, ...rest }) => rest);
  });

  /**
   * 打开文件夹选择器，将用户选定的文件夹导入到 USER_SKILLS_DIR。
   * 自动识别是单个 skill 还是集合，返回 { success, canceled, type, message }。
   */
  ipcMain.handle('skills:import-folder', async (_e) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0], {
      title: '选择要导入的 Skill 文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true, message: '已取消' };
    }
    return importSkillFolder(result.filePaths[0]);
  });

  /** 删除用户导入的集合目录（只允许删 USER_SKILLS_DIR 下的子目录，'skills' 根集合不可删） */
  ipcMain.handle('skills:remove-collection', (_e, collId: string) => {
    return removeUserCollection(collId);
  });

  ipcMain.handle('tts:isEnabled', () => {
    console.log(`[TTS] tts:isEnabled → ${ttsService.isEnabled} (url=${ttsService.currentUrl})`);
    return ttsService.isEnabled;
  });

  ipcMain.handle('tts:health', async () => {
    const result = await ttsService.health();
    console.log(`[TTS] tts:health → ok=${result.ok}, url=${ttsService.currentUrl}`, result.error ?? '');
    return result;
  });

  // ── TTS 多 Provider 配置读写 ───────────────────────────────────
  ipcMain.handle('tts:config:get', () => ({
    enabled: ttsConfig.enabled,
    activeProvider: ttsConfig.activeProvider,
    providers: ttsConfig.providers,
    deletedProviders: ttsConfig.deletedProviders ?? [],
  }));

  ipcMain.handle('tts:config:save', (_e, newCfg: TTSConfig) => {
    console.log(`[TTS] tts:config:save: enabled=${newCfg.enabled}, activeProvider=${newCfg.activeProvider}, providerKeys=[${Object.keys(newCfg.providers).join(',')}]`);
    ttsConfig.enabled = newCfg.enabled;
    ttsConfig.activeProvider = newCfg.activeProvider;
    ttsConfig.providers = newCfg.providers;
    // 内置方案不允许出现在删除列表中
    ttsConfig.deletedProviders = (newCfg.deletedProviders ?? []).filter(k => !BUILTIN_TTS_PROVIDERS.has(k));

    // 内置方案关键字段强制用代码版本（用户只能改 speaker/language）
    for (const [key, codeProv] of Object.entries(defaultTTSConfig.providers)) {
      if (key in ttsConfig.providers) {
        const uiProv = ttsConfig.providers[key];
        ttsConfig.providers[key] = {
          ...codeProv,
          speaker: uiProv.speaker ?? codeProv.speaker,
          language: uiProv.language ?? codeProv.language,
        };
      } else {
        ttsConfig.providers[key] = codeProv;
      }
    }

    activateTTSProvider();
    setSetting('tts_config', JSON.stringify(ttsConfig));
    broadcastTTSChanged();
    console.log(`[TTS] tts:config:save 完成: isEnabled=${ttsService.isEnabled}`);
    return { isEnabled: ttsService.isEnabled };
  });

  ipcMain.handle('tts:config:test', async (_e, url: string) => {
    if (!url) return { ok: false, error: '地址为空' };
    const cleanUrl = url.replace(/\/$/, '');
    try {
      const resp = await fetch(`${cleanUrl}/health/`, { signal: AbortSignal.timeout(5000) });
      const body = await resp.text().catch(() => '');
      return { ok: resp.ok, status: resp.status, body: body.slice(0, 100) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  // ── TTS 本地服务管理 ──────────────────────────────────────────
  ipcMain.handle('tts:local:status', (_e, engine?: string) => ttsServerManager.getStatus(engine));

  ipcMain.handle('tts:local:install-and-start', async (e, engine?: string) => {
    const sender = e.sender;
    const logs: string[] = [];
    const result = await ttsServerManager.installAndStart((msg) => {
      logs.push(msg);
      try { sender.send('tts:local:log', msg); } catch { /* window closed */ }
    }, engine);
    return { ...result, logs };
  });

  ipcMain.handle('tts:local:start', async (e, engine?: string) => {
    const sender = e.sender;
    const result = await ttsServerManager.startServer(engine);
    if (!result.ok) {
      try { sender.send('tts:local:log', result.detail); } catch { /* ignore */ }
    }
    return result;
  });

  ipcMain.handle('tts:local:stop', (_e, engine?: string) => ttsServerManager.stopServer(engine));

  // ── STT 本地服务管理（听觉系统） ──────────────────────────────
  ipcMain.handle('stt:local:status', () => sttServerManager.getStatus());

  ipcMain.handle('stt:local:install-and-start', async (e) => {
    const sender = e.sender;
    const logs: string[] = [];
    const result = await sttServerManager.installAndStart((msg) => {
      logs.push(msg);
      try { sender.send('stt:local:log', msg); } catch { /* window closed */ }
    });
    return { ...result, logs };
  });

  ipcMain.handle('stt:local:start', async (e) => {
    const sender = e.sender;
    const result = await sttServerManager.startServer();
    if (!result.ok) {
      try { sender.send('stt:local:log', result.detail); } catch { /* ignore */ }
    }
    return result;
  });

  ipcMain.handle('stt:local:stop', () => sttServerManager.stopServer());

  // ── 听觉系统管理 ─────────────────────────────────────────────
  ipcMain.handle('hearing:start', async (_e, source: string, mode?: string) => {
    return hearingManager.start(source as any, (mode ?? 'passive') as any);
  });

  ipcMain.handle('hearing:stop', async () => {
    return hearingManager.stop();
  });

  ipcMain.handle('hearing:status', () => hearingManager.getStatus());

  // TTS 播放期间暂停/恢复转录处理（防止 AI 声音自回音）
  ipcMain.handle('hearing:pause-for-tts', () => hearingManager.pauseForTTS());
  ipcMain.handle('hearing:resume-from-tts', () => hearingManager.resumeAfterTTS());

  // renderer 上报转写结果
  ipcMain.on('hearing:report-transcription', (_e, result) => {
    hearingManager.onTranscription(result);
  });

  // renderer 上报音频捕获失败 → 重置 main 侧状态
  ipcMain.on('hearing:capture-failed', (_e, reason: string) => {
    hearingManager.onCaptureFailed(reason);
  });

  // ── 听觉事件（事件驱动，工具路径 + IPC 路径共用） ──────────
  hearingManager.on('started', (ev) => {
    mainWin?.webContents?.send('hearing:started', ev);
  });

  hearingManager.on('stopped', () => {
    mainWin?.webContents?.send('hearing:stopped');
  });

  hearingManager.on('transcription', (result) => {
    mainWin?.webContents?.send('hearing:transcription', result);
  });

  // 听写模式：合并文本就绪 → 自动作为用户消息发给 AI
  hearingManager.on('dictation-ready', (text: string) => {
    mainWin?.webContents?.send('hearing:auto-send', { text, type: 'dictation' });
  });

  // 总结模式：停止时全文就绪 → 自动发给 AI 请求总结
  hearingManager.on('summary-ready', (text: string) => {
    mainWin?.webContents?.send('hearing:auto-send', { text, type: 'summary' });
  });

  // ── 异步任务管理 ──────────────────────────────────────────────
  ipcMain.handle('task:list', (_e, statusFilter?: string) => {
    return taskManager.listTasks(statusFilter ? { status: statusFilter as any } : undefined);
  });

  ipcMain.handle('task:detail', (_e, taskId: string) => {
    return taskManager.getTask(taskId);
  });

  ipcMain.handle('task:cancel', (_e, taskId: string) => {
    return taskManager.cancelTask(taskId);
  });

  // ── 异步任务事件推送到渲染层 ────────────────────────────────────
  const pushTaskEvent = (channel: string) => (payload: any) => {
    mainWin?.webContents?.send(channel, payload);
  };
  taskManager.on('task:started',   pushTaskEvent('task:started'));
  taskManager.on('task:completed', (task) => {
    // 推送事件到渲染进程
    pushTaskEvent('task:completed')(task);
    // 控制台输出
    const typeLabel = task.type === 'cron' ? '定时' : task.type === 'batch' ? '批量' : '后台';
    console.log(`[TaskManager] ✅ ${typeLabel}任务全部完成: 「${task.title}」 (${task.id.slice(0, 8)}…)`);
    // streamer 模式：定时任务完成后自动 TTS 播报结果
    // 动态 import 避免 main ↔ streamerController 静态循环依赖
    if (task.type === 'cron' && task.result?.trim()) {
      void import('./streaming/streamerController').then(({ streamerController }) => {
        if (streamerController.getStatus().running) {
          void streamerController.speak(task.result!);
        }
      });
    }
    // background/batch 异步任务：唤醒主对话 AI 继续工作流
    // cron（schedule_task）不需要：子智能体自己用 speak 通知用户
    // 有 parent_task_id 的是批量子任务，不单独唤醒——等父任务完成后统一唤醒一次
    if ((task.type === 'background' || task.type === 'batch') && task.conversation_id && !task.parent_task_id) {
      let wakeupText: string;

      if (task.type === 'batch') {
        // 批量任务：聚合结果可能超万字，wakeup 只告知状态 + task_id
        // AI 必须主动调用 async_task result 才能拿到所有数据
        const statsLine = task.result?.split('\n').slice(0, 4).join(' ') ?? '';
        wakeupText = [
          `【系统通知】批量任务「${task.title}」全部子任务已执行完毕。`,
          statsLine ? `统计：${statsLine}` : '',
          '',
          `⚠️ 聚合结果体积较大，未自动注入上下文。`,
          `请立即调用以下工具获取完整数据后再回复用户：`,
          `  async_task({"action":"result","task_id":"${task.id}"})`,
        ].filter(s => s !== null).join('\n');
      } else {
        // 普通后台任务：结果通常较短，直接附在 wakeup 里
        const resultPreview = task.result && task.result.length > 1500
          ? task.result.slice(0, 1500) + `\n…(共 ${task.result.length} 字，如需完整结果请调用 async_task result task_id="${task.id}")`
          : task.result ?? '';
        wakeupText = `【系统通知】后台任务「${task.title}」已完成。${resultPreview ? `\n\n结果：\n${resultPreview}` : ''}\n\n请检查结果并继续执行后续步骤。`;
      }

      sendAgentWakeup(task.conversation_id, wakeupText);
    }
  });
  taskManager.on('task:failed',    (task) => {
    pushTaskEvent('task:failed')(task);
    console.log(`[TaskManager] ❌ 任务失败: 「${task.title}」 (${task.id.slice(0, 8)}…) — ${task.error ?? '未知错误'}`);
    if ((task.type === 'background' || task.type === 'batch') && task.conversation_id && !task.parent_task_id) {
      const wakeupText = `【系统通知】后台任务「${task.title}」执行失败。\n错误信息：${task.error ?? '未知错误'}\n\n请处理错误或告知用户。`;
      sendAgentWakeup(task.conversation_id, wakeupText);
    }
  });
  taskManager.on('task:cancelled', pushTaskEvent('task:cancelled'));
  taskManager.on('task:progress',  pushTaskEvent('task:progress'));
}

app.whenReady().then(() => {
  initDatabase();
  loadPersistedConfig();
  setCodingAgentNotifier((conversationId, content) => injectAgentMessage(conversationId, content));

  // ── 系统音频捕获支持：拦截 renderer 的 getDisplayMedia 请求 ──
  // 自动选择主屏幕 + loopback 回环音频，无需用户手动选择
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => {
      callback({ video: undefined as any, audio: undefined as any });
    });
  });

  // 启动时激活 TTS provider（默认 enabled=false，不会连接）
  activateTTSProvider();

  // 若 TTS 已启用且为本地服务，后台静默拉起（重启后无需用户手动 enable）
  if (ttsConfig.enabled) {
    const activeP = ttsConfig.providers[ttsConfig.activeProvider];
    if (activeP?.isLocal && activeP.localEngine) {
      ttsServerManager.getStatus(activeP.localEngine).then((status) => {
        if (status.installed && !status.running) {
          console.info(`[TTS] 启动时自动拉起本地服务: ${activeP.localEngine}`);
          return ttsServerManager.startServer(activeP.localEngine);
        }
      }).catch((e) => console.warn('[TTS] 启动时自动拉起失败（忽略）:', (e as Error).message));
    }
  }

  createWindow();

  // ── 启动平台桥接（Discord 等）：使用首个对话 ID 作为默认绑定对话 ──
  const existingConvs = listConversations();
  const defaultConvId = existingConvs.length > 0
    ? existingConvs[0].id
    : createConversation().id;
  startBridges(defaultConvId).catch((e) =>
    console.error('[Bridges] 启动失败:', (e as Error).message)
  );

  // ── 启动时批量追赶：延迟 3s 等 UI 稳定后处理所有遗留的未总结消息 ──
  setTimeout(() => {
    const ids = listConversations().map((c) => c.id);
    runStartupCatchUp(ids).catch((e) =>
      console.error('[Memory] 启动追赶异常:', (e as Error).message)
    );
  }, 3000);

  // ── 空闲调度器：用户停止聊天 10 分钟后自动后台总结 ──
  startIdleScheduler(() => activeConversationId);

  // ── 定时任务调度器 ──
  taskScheduler.start();
});

/** 防止 before-quit 重入：流水线执行完成后我们主动调用 app.quit()，不再被拦截 */
let isQuitting = false;

app.on('before-quit', (event) => {
  // 停止定时任务调度器
  taskScheduler.stop();

  if (isQuitting || !activeConversationId) return;

  // ── 快速判断是否真的有需要处理的内容 ──────────────────────
  const convId = activeConversationId;
  const batchSize = 6; // leaveMinRounds(3) * 2，与 DEFAULT_MEMORY_CONFIG 保持一致
  const unsummarized = countNonSystemMessages(convId) - getMemoryCursor(convId);
  const newFragments = getMemoryFragments(convId).length - getGlobalMemoryCursor(convId);
  const hasWork = unsummarized >= batchSize || newFragments > 0;

  if (!hasWork) return; // 无需处理，放行立即退出

  // ── 有工作要做：拦截退出，显示遮罩，执行流水线 ─────────────
  event.preventDefault();
  isQuitting = true;

  // 通知渲染层显示退出提示
  if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isDestroyed()) {
    mainWin.webContents.send('app:quitting');
  }

  ;(async () => {
    console.info('[Memory] 应用退出，执行记忆流水线...');
    await memoryManager.forcePartialSummarize(convId);
    await globalMemoryManager.refineAsync(convId);
    console.info('[Memory] 记忆流水线完成，正常退出');
  })()
    .catch((e) => console.error('[Memory] 退出时流水线异常:', (e as Error).message))
    .finally(() => {
      stopBridges().finally(() => {
        if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isDestroyed()) {
          // 通知渲染层流水线完成，短暂展示"已保存"后关闭
          mainWin.webContents.send('app:quit-ready');
          setTimeout(() => {
            mainWin?.destroy(); // 直接 destroy 跳过 close 事件，防止重入
            app.quit();
          }, 400);
        } else {
          app.quit();
        }
      });
    });
});

app.on('window-all-closed', () => {
  app.quit();
});

