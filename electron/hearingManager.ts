/**
 * 听觉系统管理器（主进程）— 状态协调 + 转录缓存 + 三模式逻辑
 *
 * 架构说明：
 *   - 音频捕获 + WebSocket 连接在 renderer 进程（使用浏览器原生 API）
 *   - 本模块在 main 进程，负责：
 *     1. 听觉系统状态管理（start/stop/status）
 *     2. 接收 renderer 通过 IPC 上报的转写结果并缓存
 *     3. 三种听觉模式的数据流逻辑
 *   - sttServerManager 负责 Python STT 服务的安装和生命周期
 *
 * 三种模式：
 *   dictation（语音输入）：转录文本合并后自动作为用户消息发送给 AI
 *   passive （陪伴监听）：转录缓存，AI 通过 get_transcript 工具按需读取
 *   summary （总结模式）：转录缓存，停止时自动注入全文供 AI 总结
 *
 * TranscriptBuffer 生命周期：
 *   创建：hearingManager.start() 时创建（清空旧缓存）
 *   追加：每次 onTranscription() 调用时追加条目
 *   读取：getTranscript() 供工具/外部读取；dictation 模式内部 flush 读取
 *   销毁：hearingManager.stop() 时清空（summary 模式会先读取再清空）
 *   上限：最多保留 500 条，超限自动淘汰最早的
 *
 * 事件：
 *   'started'          { source, wsUrl, mode }   — 通知 renderer 开始捕获
 *   'stopped'          void                       — 通知 renderer 停止捕获
 *   'transcription'    TranscriptionResult        — 每条转录推送到 renderer
 *   'dictation-ready'  string                     — 听写模式合并文本就绪
 *   'summary-ready'    string                     — 总结模式全文就绪
 */

import { EventEmitter } from 'events';
import * as sttServerManager from './sttServerManager';

// ── 类型 ────────────────────────────────────────────────────────────

export type AudioSource = 'mic' | 'system' | 'both';
export type HearingMode = 'dictation' | 'passive' | 'summary';

export interface HearingStatus {
  active: boolean;
  source: AudioSource | null;
  mode: HearingMode;
  sttServer: {
    installed: boolean;
    running: boolean;
    healthy: boolean;
  };
  transcriptionCount: number;
  wsUrl: string;
}

import type { TranscriptionResult } from '../shared/types/chat';
export type { TranscriptionResult };

export interface TranscriptEntry {
  text: string;
  timestamp: number;
  start: number;
  end: number;
  language: string;
}

// ── 转录缓存 ────────────────────────────────────────────────────────

class TranscriptBuffer {
  private entries: TranscriptEntry[] = [];
  private static MAX = 500;

  append(result: TranscriptionResult): void {
    this.entries.push({
      text: result.text,
      timestamp: result.timestamp,
      start: result.start,
      end: result.end,
      language: result.language,
    });
    if (this.entries.length > TranscriptBuffer.MAX) {
      this.entries = this.entries.slice(-TranscriptBuffer.MAX);
    }
  }

  getAll(): TranscriptEntry[] {
    return [...this.entries];
  }

  getSince(timestamp: number): TranscriptEntry[] {
    return this.entries.filter(e => e.timestamp >= timestamp);
  }

  getRecent(count: number): TranscriptEntry[] {
    return this.entries.slice(-count);
  }

  getText(separator = '\n'): string {
    return this.entries.map(e => e.text).join(separator);
  }

  getTextSince(timestamp: number, separator = '\n'): string {
    return this.getSince(timestamp).map(e => e.text).join(separator);
  }

  clear(): void {
    this.entries = [];
  }

  get length(): number {
    return this.entries.length;
  }
}

// ── 听觉管理器 ──────────────────────────────────────────────────────

class HearingManager extends EventEmitter {
  private active = false;
  private source: AudioSource | null = null;
  private mode: HearingMode = 'passive';
  private buffer = new TranscriptBuffer();
  private transcriptionCount = 0;

  /** 听写模式：合并定时器 */
  private dictationTimer: ReturnType<typeof setTimeout> | null = null;
  /** 听写模式：上次注入后的时间戳 */
  private lastDictationTs = 0;
  /** TTS 播放期间暂时屏蔽转录（防止 TTS 声音自回音污染转录缓存） */
  private ttsMuted = false;

  /** 听写合并窗口（毫秒）：用户停说 1.5s 后认为一句话结束 */
  static readonly DICTATION_MERGE_MS = 1500;

  // ── 启停 ────────────────────────────────────────────────────────

  async start(
    source: AudioSource = 'mic',
    mode: HearingMode = 'passive',
  ): Promise<{ ok: boolean; detail: string; wsUrl?: string; mode?: HearingMode }> {
    // 如果已在运行且参数不同，自动停止再重启
    if (this.active) {
      if (this.source === source && this.mode === mode) {
        return {
          ok: true,
          detail: '听觉系统已在运行',
          wsUrl: sttServerManager.getWebSocketUrl(),
          mode: this.mode,
        };
      }
      // 参数变化，先停止
      await this.stop();
    }

    const sttStatus = await sttServerManager.getStatus();
    if (!sttStatus.running || !sttStatus.healthy) {
      return { ok: false, detail: 'STT 服务未运行，请先安装并启动 STT 服务' };
    }

    this.active = true;
    this.source = source;
    this.mode = mode;
    this.transcriptionCount = 0;
    this.buffer.clear();
    this.lastDictationTs = 0;

    const wsUrl = sttServerManager.getWebSocketUrl();
    this.emit('started', { source, wsUrl, mode });
    return {
      ok: true,
      detail: `听觉系统已启动（${this.modeLabel(mode)}，音频源: ${source}）`,
      wsUrl,
      mode,
    };
  }

  async stop(): Promise<{ ok: boolean; detail: string }> {
    if (!this.active) {
      return { ok: true, detail: '听觉系统未在运行' };
    }

    // 清理听写定时器
    if (this.dictationTimer) {
      clearTimeout(this.dictationTimer);
      this.dictationTimer = null;
    }

    // 听写模式：刷出剩余未注入的文本
    if (this.mode === 'dictation') {
      this.flushDictation();
    }

    // 总结模式：stop 时发出全部缓存文本
    if (this.mode === 'summary') {
      const text = this.buffer.getText();
      if (text.trim()) {
        this.emit('summary-ready', text.trim());
      }
    }

    this.active = false;
    this.source = null;
    this.buffer.clear();
    this.lastDictationTs = 0;

    this.emit('stopped');
    return { ok: true, detail: '听觉系统已停止' };
  }

  // ── 状态查询 ────────────────────────────────────────────────────

  async getStatus(): Promise<HearingStatus> {
    const sttStatus = await sttServerManager.getStatus();
    return {
      active: this.active,
      source: this.source,
      mode: this.mode,
      sttServer: {
        installed: sttStatus.installed,
        running: sttStatus.running,
        healthy: sttStatus.healthy,
      },
      transcriptionCount: this.transcriptionCount,
      wsUrl: sttServerManager.getWebSocketUrl(),
    };
  }

  isActive(): boolean {
    return this.active;
  }

  getMode(): HearingMode {
    return this.mode;
  }

  // ── 转录接收 ────────────────────────────────────────────────────

  /** 暂停转录处理（TTS 播放期间调用，防止 AI 声音被自己听到） */
  pauseForTTS(): void {
    this.ttsMuted = true;
    console.log('[HearingManager] TTS 开始，暂停转录接收');
  }

  /** 恢复转录处理（TTS 播放结束后调用） */
  resumeAfterTTS(): void {
    this.ttsMuted = false;
    console.log('[HearingManager] TTS 结束，恢复转录接收');
  }

  onTranscription(result: TranscriptionResult): void {
    // TTS 播放期间忽略转录，防止 AI 声音自回音
    if (this.ttsMuted) return;
    this.transcriptionCount++;
    this.buffer.append(result);
    this.emit('transcription', result);

    // 听写模式：每次来新转录就重置合并定时器
    if (this.mode === 'dictation') {
      if (this.dictationTimer) clearTimeout(this.dictationTimer);
      this.dictationTimer = setTimeout(() => {
        this.flushDictation();
      }, HearingManager.DICTATION_MERGE_MS);
    }
  }

  /** 听写模式：将累积文本作为用户输入发出 */
  private flushDictation(): void {
    this.dictationTimer = null;
    const text = this.lastDictationTs > 0
      ? this.buffer.getTextSince(this.lastDictationTs)
      : this.buffer.getText();
    if (text.trim()) {
      this.lastDictationTs = Date.now();
      this.emit('dictation-ready', text.trim());
    }
  }

  // ── 转录缓存公开接口（供 AI 工具读取） ─────────────────────────

  getTranscript(opts?: { since?: number; recent?: number }): {
    entries: TranscriptEntry[];
    text: string;
    count: number;
    mode: HearingMode;
  } {
    let entries: TranscriptEntry[];
    if (opts?.since) {
      entries = this.buffer.getSince(opts.since);
    } else if (opts?.recent) {
      entries = this.buffer.getRecent(opts.recent);
    } else {
      entries = this.buffer.getAll();
    }
    return {
      entries,
      text: entries.map(e => e.text).join('\n'),
      count: entries.length,
      mode: this.mode,
    };
  }

  clearTranscript(): void {
    this.buffer.clear();
    this.lastDictationTs = 0;
  }

  /** renderer 报告音频捕获失败 → 重置 main 侧状态 */
  onCaptureFailed(reason: string): void {
    console.warn('[HearingManager] renderer 音频捕获失败:', reason);
    this.active = false;
    this.source = null;
    this.buffer.clear();
    this.lastDictationTs = 0;
    this.emit('stopped');
  }

  // ── 工具函数 ────────────────────────────────────────────────────

  private modeLabel(mode: HearingMode): string {
    switch (mode) {
      case 'dictation': return '语音输入';
      case 'passive': return '陪伴监听';
      case 'summary': return '总结模式';
    }
  }
}

// ── 单例 ────────────────────────────────────────────────────────────

export const hearingManager = new HearingManager();
