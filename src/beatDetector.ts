/**
 * Beat Detector — 系统音频节拍检测，驱动 Live2D 模型随音乐弹动
 *
 * 架构与 airi-main 完全对齐：
 *   getDisplayMedia() → createMediaStreamSource()
 *   → @nekopaw/tempora AudioWorklet（能量历史法 onset 检测）
 *   → scheduleBeat() → BeatSyncState 弹簧物理 → AngleX / BodyAngleX
 *
 * 不与 hearing.ts 共用任何状态，完全独立的 AudioContext。
 * 自动启动：页面加载后立即尝试；若需要用户手势，则在首次点击时重试。
 */

import { startAnalyser } from '@nekopaw/tempora';
import workletUrl from '@nekopaw/tempora/worklet?url';
import { LAppDelegate } from './lappdelegate';

// ── 获取当前 Live2D 模型实例 ────────────────────────────────────────
function getLiveModel() {
  try {
    return LAppDelegate.getInstance().getFirstSubdelegate()?.getLive2DManager().getFirstModel() ?? null;
  } catch {
    return null;
  }
}

// ── 内部状态 ────────────────────────────────────────────────────────
let _active = false;
let _audioCtx: AudioContext | undefined;
let _stream: MediaStream | undefined;
let _startAttempted = false;

// ── 停止 ────────────────────────────────────────────────────────────
function stop(): void {
  if (!_active) return;
  _active = false;
  try { _stream?.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
  try { _audioCtx?.close(); } catch { /* noop */ }
  _stream = undefined;
  _audioCtx = undefined;
  console.log('[BeatDetector] 已停止');
}

// ── 启动 ────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  if (_active) return;

  // 请求系统音频（与 hearing.ts getSystemAudioStream 相同方式，但独立实现）
  let rawStream: MediaStream;
  try {
    rawStream = await navigator.mediaDevices.getDisplayMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: { width: 1, height: 1 }, // 最小视频，仅用于获取系统音频权限
    });
  } catch (err) {
    // NotAllowedError: 用户拒绝，或 NotSupportedError：环境不支持
    console.warn('[BeatDetector] getDisplayMedia 失败:', (err as Error).message);
    return;
  }

  // 只保留音频轨道，立刻停掉视频
  rawStream.getVideoTracks().forEach(t => t.stop());
  const audioTracks = rawStream.getAudioTracks();
  if (audioTracks.length === 0) {
    console.warn('[BeatDetector] 未获取到系统音频轨道（请在分享时勾选"共享系统音频"）');
    return;
  }

  const audioStream = new MediaStream(audioTracks);

  // 创建独立 AudioContext + tempora analyser
  const ctx = new AudioContext();
  let analyser: Awaited<ReturnType<typeof startAnalyser>>;
  try {
    analyser = await startAnalyser({
      context: ctx,
      worklet: workletUrl,
      workletParams: {
        sensitivity: 0.7,
        minBeatInterval: 0.2,        // 最小节拍间隔 200ms = 300 BPM 上限
        lowpassFilterFrequency: 200,  // 低通，降低人声，突出鼓声
        highpassFilterFrequency: 30,
        adaptiveThreshold: true,
        spectralFlux: true,
      },
      listeners: {
        onBeat: (e) => {
          // 直接调用 scheduleBeat，与 airi signal chain 完全对等
          getLiveModel()?.scheduleBeat(performance.now());
          console.log(`[BeatDetector] ♪ energy=${e.energy.toFixed(3)} interval=${e.interval.toFixed(0)}ms`);
        },
      },
    });
  } catch (err) {
    console.error('[BeatDetector] tempora analyser 启动失败:', err);
    ctx.close();
    audioStream.getTracks().forEach(t => t.stop());
    return;
  }

  // 音频路由：source → analyser.workletNode
  const source = ctx.createMediaStreamSource(audioStream);
  source.connect(analyser.workletNode);

  _active = true;
  _audioCtx = ctx;
  _stream = audioStream;

  // 音频轨道结束（用户停止共享）→ 自动停止
  audioTracks.forEach(track => {
    track.addEventListener('ended', () => {
      console.log('[BeatDetector] 系统音频轨道已结束');
      stop();
    });
  });

  console.log('[BeatDetector] 已启动，监听系统音频节拍 ✓');
  console.log('[BeatDetector] 音频轨道:', audioTracks[0].label);
}

// ── 自动启动逻辑 ─────────────────────────────────────────────────────
/**
 * 在 main.ts 的 DOMContentLoaded 中调用。
 * Electron 的 setDisplayMediaRequestHandler 已处理权限，
 * 通常不需要显式用户手势——直接尝试启动。
 * 若浏览器要求手势，则退化为首次点击时启动（透明 fallback）。
 */
export function initBeatDetector(): void {
  if (_startAttempted) return;
  _startAttempted = true;

  const tryStart = (): void => {
    start().catch((err) => {
      console.warn('[BeatDetector] 启动失败，等待首次用户交互:', err);
      // fallback：首次点击时重试一次
      document.addEventListener('click', () => {
        _startAttempted = false; // 允许重试
        if (!_active) start().catch(() => { /* 用户显式拒绝，不再重试 */ });
      }, { once: true });
    });
  };

  // 延迟到页面完全加载后（确保 AudioContext 可以创建）
  if (document.readyState === 'complete') {
    // 短暂延迟确保 Electron renderer 完全初始化
    setTimeout(tryStart, 500);
  } else {
    window.addEventListener('load', () => setTimeout(tryStart, 500), { once: true });
  }
}

