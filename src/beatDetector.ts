/**
 * 系统音频监听：每帧给灵动层送两样东西，让模型跟着电脑上放的音乐动
 *   - 起音强度：频谱「突然变响了多少」，节拍时钟从这条曲线推算速度和相位
 *   - 音量：RMS，决定律动幅度，也用来判断声音是否连续（区分音乐和说话）
 *
 *   getDisplayMedia(loopback) → MediaStreamSource → AnalyserNode
 *     → 每帧：dB 频谱 → SpectralFlux ┐
 *             时域 RMS ──────────────┴→ liveliness.setMusicFrame
 *
 * 不与 hearing.ts 共用任何状态，完全独立的 AudioContext。
 * 自动启动：页面加载后立即尝试；若需要用户手势，则在首次点击时重试。
 */

import { liveliness } from './liveliness/motor';
import { rmsOfByteTimeDomain } from './liveliness/dynamics';
import { SpectralFlux } from './liveliness/spectralFlux';

/** 1024 点 @48kHz ≈ 21 ms 窗口、47 Hz 一个频点：底鼓能分出来，时间又不至于糊 */
const FFT_SIZE = 1024;

let _active = false;
let _audioCtx: AudioContext | undefined;
let _stream: MediaStream | undefined;
let _rafId: number | null = null;
let _startAttempted = false;

function stop(): void {
  if (!_active) return;
  _active = false;
  if (_rafId !== null) cancelAnimationFrame(_rafId);
  _rafId = null;
  try { _stream?.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
  try { void _audioCtx?.close(); } catch { /* noop */ }
  _stream = undefined;
  _audioCtx = undefined;
  liveliness.setMusicFrame(0, 0, performance.now());
  console.log('[BeatDetector] 已停止');
}

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

  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  // 默认 0.8 的频谱平滑会把鼓点的瞬态抹平，算起音强度必须关掉
  analyser.smoothingTimeConstant = 0;
  ctx.createMediaStreamSource(audioStream).connect(analyser);

  const samples = new Uint8Array(FFT_SIZE);
  const spectrum = new Float32Array(analyser.frequencyBinCount);
  const flux = new SpectralFlux(ctx.sampleRate / FFT_SIZE);
  const tick = (): void => {
    analyser.getByteTimeDomainData(samples);
    analyser.getFloatFrequencyData(spectrum);
    liveliness.setMusicFrame(flux.push(spectrum), rmsOfByteTimeDomain(samples), performance.now());
    _rafId = requestAnimationFrame(tick);
  };

  _active = true;
  _audioCtx = ctx;
  _stream = audioStream;
  _rafId = requestAnimationFrame(tick);

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
