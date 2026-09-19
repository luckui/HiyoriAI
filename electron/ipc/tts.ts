/**
 * 语音合成：朗读请求、TTS 方案配置、本地 TTS 服务管理、Genie 音色导入。
 */

import { dialog, ipcMain, type WebContents } from 'electron';
import { ttsService } from '../ttsService';
import type { TTSConfig } from '../tts.config';
import * as ttsServerManager from '../ttsServerManager';
import { importGenieVoiceFromFolder } from '../genieVoiceManager';
import { getBridgeConfig, getTTSConfig, setBridgeConfig } from '../config/runtimeConfig';
import { saveTTSSettings } from '../ttsRuntime';
import { dialogParentWindow } from '../mainWindow';

/** 把本地服务安装/启动日志推给发起请求的窗口（窗口可能已关闭） */
function logTo(sender: WebContents) {
  return (msg: string) => {
    try { sender.send('tts:local:log', msg); } catch { /* window closed */ }
  };
}

export function registerTTSIpc(): void {
  // ── 朗读 ────────────────────────────────────────────────
  ipcMain.handle('tts:speak:abort', () => ttsService.abortAll());

  ipcMain.handle('tts:speak', async (_e, text: string) => {
    console.log(`[TTS] tts:speak 收到请求: enabled=${ttsService.isEnabled}, text="${text.slice(0, 60)}…"`);
    if (!ttsService.isEnabled) {
      console.warn('[TTS] tts:speak → 跳过: TTS 未启用');
      return null;
    }
    try {
      const wav = await ttsService.speak(text);
      console.log(`[TTS] tts:speak → 成功, ${wav.byteLength} bytes`);
      return { data: Buffer.from(wav).toString('base64') };
    } catch (e) {
      console.error('[TTS] tts:speak → 失败:', (e as Error).message);
      return null;
    }
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

  // ── 方案配置 ─────────────────────────────────────────────
  ipcMain.handle('tts:config:get', () => {
    const cfg = getTTSConfig();
    return {
      enabled: cfg.enabled,
      activeProvider: cfg.activeProvider,
      providers: cfg.providers,
      deletedProviders: cfg.deletedProviders ?? [],
    };
  });

  ipcMain.handle('tts:config:save', async (e, next: TTSConfig) => {
    console.log(`[TTS] tts:config:save: enabled=${next.enabled}, activeProvider=${next.activeProvider}, providerKeys=[${Object.keys(next.providers).join(',')}]`);
    // 关闭 TTS 时，依赖它的桥接语音回复一并关闭
    const bridges = getBridgeConfig();
    if (!next.enabled && (bridges.wechat.voiceRepliesEnabled || bridges.feishu.voiceRepliesEnabled)) {
      setBridgeConfig({
        ...bridges,
        wechat: { ...bridges.wechat, voiceRepliesEnabled: false },
        feishu: { ...bridges.feishu, voiceRepliesEnabled: false },
      });
    }
    const log = logTo(e.sender);
    const runtime = await saveTTSSettings(next, (msg) => {
      console.info(`[TTS] config save apply: ${msg}`);
      log(msg);
    });
    console.log(`[TTS] tts:config:save 完成: isEnabled=${ttsService.isEnabled}`);
    return { isEnabled: ttsService.isEnabled, runtime };
  });

  ipcMain.handle('tts:config:test', async (_e, url: string) => {
    if (!url) return { ok: false, error: '地址为空' };
    try {
      const resp = await fetch(`${url.replace(/\/$/, '')}/health/`, { signal: AbortSignal.timeout(5000) });
      const body = await resp.text().catch(() => '');
      return { ok: resp.ok, status: resp.status, body: body.slice(0, 100) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  // ── 本地 TTS 服务 ────────────────────────────────────────
  ipcMain.handle('tts:local:status', (_e, engine?: string) => ttsServerManager.getStatus(engine));

  ipcMain.handle('tts:local:install-and-start', async (e, engine?: string) => {
    const log = logTo(e.sender);
    const logs: string[] = [];
    const result = await ttsServerManager.installAndStart((msg) => {
      logs.push(msg);
      log(msg);
    }, engine);
    return { ...result, logs };
  });

  ipcMain.handle('tts:local:start', async (e, engine?: string) => {
    const result = await ttsServerManager.startServer(engine);
    if (!result.ok) logTo(e.sender)(result.detail);
    return result;
  });

  ipcMain.handle('tts:local:stop', (_e, engine?: string) => ttsServerManager.stopServer(engine));

  ipcMain.handle('tts:genie:import-voice', async (e) => {
    const pick = await dialog.showOpenDialog(dialogParentWindow(), {
      title: '选择 GPT-SoVITS V2/V2ProPlus 音色文件夹',
      properties: ['openDirectory'],
    });
    if (pick.canceled || pick.filePaths.length === 0) {
      return { ok: false, canceled: true, detail: '已取消' };
    }
    const log = logTo(e.sender);
    const result = await importGenieVoiceFromFolder(pick.filePaths[0], {
      onProgress: (msg) => {
        console.info(`[Genie Voice] ${msg}`);
        log(msg);
      },
    });
    if (result.ok) {
      await ttsServerManager.stopServer('genie-tts');
      log('已停止 Genie-TTS，保存设置后会重新加载新音色。');
    }
    return result;
  });
}
