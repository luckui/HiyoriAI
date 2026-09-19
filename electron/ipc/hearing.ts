/**
 * 听觉系统：本地 STT 服务管理、开始/停止收听，以及把转写事件推给渲染层。
 */

import { ipcMain } from 'electron';
import * as sttServerManager from '../sttServerManager';
import { hearingManager, type AudioSource, type HearingMode } from '../hearingManager';
import { sendToRenderer } from '../mainWindow';

export function registerHearingIpc(): void {
  // ── 本地 STT 服务 ────────────────────────────────────────
  ipcMain.handle('stt:local:status', () => sttServerManager.getStatus());

  ipcMain.handle('stt:local:install-and-start', async (e) => {
    const logs: string[] = [];
    const result = await sttServerManager.installAndStart((msg) => {
      logs.push(msg);
      try { e.sender.send('stt:local:log', msg); } catch { /* window closed */ }
    });
    return { ...result, logs };
  });

  ipcMain.handle('stt:local:start', async (e) => {
    const result = await sttServerManager.startServer();
    if (!result.ok) {
      try { e.sender.send('stt:local:log', result.detail); } catch { /* window closed */ }
    }
    return result;
  });

  ipcMain.handle('stt:local:stop', () => sttServerManager.stopServer());

  // ── 收听控制 ─────────────────────────────────────────────
  ipcMain.handle('hearing:start', (_e, source: AudioSource, mode?: HearingMode) =>
    hearingManager.start(source, mode ?? 'passive'));
  ipcMain.handle('hearing:stop', () => hearingManager.stop());
  ipcMain.handle('hearing:status', () => hearingManager.getStatus());

  // TTS 播放期间暂停/恢复转录处理（防止 AI 声音自回音）
  ipcMain.handle('hearing:pause-for-tts', () => hearingManager.pauseForTTS());
  ipcMain.handle('hearing:resume-from-tts', () => hearingManager.resumeAfterTTS());

  // renderer 上报转写结果 / 音频捕获失败（失败时重置 main 侧状态）
  ipcMain.on('hearing:report-transcription', (_e, result) => hearingManager.onTranscription(result));
  ipcMain.on('hearing:capture-failed', (_e, reason: string) => hearingManager.onCaptureFailed(reason));

  // ── 听觉事件（工具路径与 IPC 路径共用）→ 渲染层 ──────────
  hearingManager.on('started', (ev) => sendToRenderer('hearing:started', ev));
  hearingManager.on('stopped', () => sendToRenderer('hearing:stopped'));
  hearingManager.on('transcription', (result) => sendToRenderer('hearing:transcription', result));
  // 听写模式：合并文本就绪 → 自动作为用户消息发给 AI
  hearingManager.on('dictation-ready', (text: string) => sendToRenderer('hearing:auto-send', { text, type: 'dictation' }));
  // 总结模式：停止时全文就绪 → 自动发给 AI 请求总结
  hearingManager.on('summary-ready', (text: string) => sendToRenderer('hearing:auto-send', { text, type: 'summary' }));
}
