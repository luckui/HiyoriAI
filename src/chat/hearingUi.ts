/** 听觉系统界面：输入区上方的"正在聆听"指示条、消息流里的转写气泡，以及把主进程的听觉事件接到音频捕获 */

import { startCapture, stopCapture, onTranscription } from '../hearing';
import { appendToFeed, escapeHtml } from './messages';
import { sendFromHearing } from './turns';

/** 本次收听已收到的转写条数 */
let transcriptionCount = 0;
/** 消息流中最多保留的转写气泡数 */
const MAX_TRANSCRIPTION_BUBBLES = 50;

/**
 * 创建并显示听觉指示器条（固定在 input-area 上方）
 * 包含：脉冲点 + 正在聆听 + 最新转录预览 + 模式标签 + 计数
 */
function showHearingIndicator(mode: string, source: string): void {
  removeHearingIndicator();

  const chatView = document.getElementById('chat-view');
  if (!chatView) return;

  const modeLabels: Record<string, string> = {
    dictation: '语音输入', passive: '陪伴监听', summary: '总结',
  };
  const sourceLabels: Record<string, string> = {
    mic: '麦克风', system: '系统音频', both: '全部',
  };

  const indicator = document.createElement('div');
  indicator.id = 'hearing-indicator';
  indicator.className = 'hearing-indicator';

  indicator.innerHTML = `
    <div class="hearing-ind-left">
      <span class="hearing-pulse-dot"></span>
      <span class="hearing-ind-label">正在聆听</span>
      <span class="hearing-ind-latest" id="hearing-latest-text">${escapeHtml(sourceLabels[source] ?? source)}</span>
    </div>
    <div class="hearing-ind-right">
      <span class="hearing-mode-badge ${escapeHtml(mode)}">${escapeHtml(modeLabels[mode] ?? mode)}</span>
      <span class="hearing-ind-count" id="hearing-count">0 条</span>
    </div>`;

  chatView.appendChild(indicator);

  // 延迟添加 active 类触发入场动画
  requestAnimationFrame(() => {
    requestAnimationFrame(() => indicator.classList.add('active'));
  });
}

/** 移除听觉指示器 */
function removeHearingIndicator(): void {
  const el = document.getElementById('hearing-indicator');
  if (el) {
    el.classList.remove('active');
    // 等动画结束再移除 DOM
    setTimeout(() => el.remove(), 200);
  }
  transcriptionCount = 0;
}

/** 更新指示器：最新文本 + 计数 */
function updateHearingIndicator(text: string): void {
  transcriptionCount++;
  const latestEl = document.getElementById('hearing-latest-text');
  const countEl = document.getElementById('hearing-count');
  if (latestEl) {
    const preview = text.length > 35 ? text.slice(0, 35) + '…' : text;
    latestEl.textContent = `"${preview}"`;
    latestEl.title = text;
  }
  if (countEl) {
    countEl.textContent = `${transcriptionCount} 条`;
  }
}

/** 在消息流中添加一条转写气泡，超过上限时移除最旧的 */
function addTranscriptionBubble(text: string, language: string): void {
  const time = new Date();
  const timeStr = [time.getHours(), time.getMinutes(), time.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  const bubble = document.createElement('div');
  bubble.className = 'transcription-bubble';
  bubble.innerHTML = `
    <div class="transcription-bubble-inner">
      <span class="tb-ear">👂</span>
      <span class="tb-text">${escapeHtml(text)}</span>
      <span class="tb-meta">
        <span class="tb-lang">${escapeHtml(language)}</span>
        <span class="tb-time">${timeStr}</span>
      </span>
    </div>`;
  if (!appendToFeed(bubble)) return;
  const all = document.querySelectorAll('#messages .transcription-bubble');
  if (all.length > MAX_TRANSCRIPTION_BUBBLES) all[0].remove();
}

export function initHearingUi(): void {
  onTranscription((result) => {
    updateHearingIndicator(result.text);
    addTranscriptionBubble(result.text, result.language);
  });

  // 主进程通知开始收听 → 渲染层开始采集音频（麦克风 / 系统回环）
  window.hearingAPI?.onStarted((ev) => {
    console.log('[Hearing] 收到启动通知, source:', ev.source, 'wsUrl:', ev.wsUrl, 'mode:', ev.mode);
    showHearingIndicator(ev.mode ?? 'passive', ev.source);
    startCapture(ev.wsUrl, ev.source as 'mic' | 'system' | 'both').catch((err) => {
      console.error('[Hearing] 启动音频捕获失败:', err);
      removeHearingIndicator();
      addTranscriptionBubble(`⚠ 音频捕获失败: ${(err as Error).message}`, 'error');
      // 通知主进程捕获失败，重置它那边的收听状态
      window.hearingAPI?.reportCaptureFailed((err as Error).message);
    });
  });

  window.hearingAPI?.onStopped(() => {
    console.log('[Hearing] 收到停止通知');
    removeHearingIndicator();
    stopCapture();
  });

  // 听写 / 总结模式：识别完成后自动发给 AI
  window.hearingAPI?.onAutoSend((ev) => {
    console.log(`[Hearing] 自动发送 (${ev.type}):`, ev.text.slice(0, 50));
    void sendFromHearing(ev.text, ev.type);
  });
}
