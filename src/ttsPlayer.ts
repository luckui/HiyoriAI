/**
 * TTS 播放器（渲染进程）
 *
 * 职责：
 *   1. 调用 Electron IPC（ttsAPI.speak）获取 base64 WAV 音频
 *   2. 解码后交给 LAppModel._wavFileHandler.startFromBuffer() 播放 + 口型同步
 *   3. 按句子切分文本，并发发起所有请求，顺序播放——流水线策略降低感知延迟
 *
 * 用法：收到 AI 回复文本后调用 playTTS(text)
 */

import { LAppDelegate } from './lappdelegate';
import type { LAppModel } from './lappmodel';
import { shouldShowTypewriterBubble, showTypewriterBubble } from './chat/typewriter';
import { normalizeSpokenText, splitSpokenText } from '../shared/spokenText';
import { createTypewriterPlaybackCallback } from './typewriterPlayback';
import { SerialPlaybackQueue } from './ttsPlaybackQueue';
import { liveliness } from './liveliness/motor';
import { rmsOfByteTimeDomain } from './liveliness/dynamics';

// ── 获取当前 Live2D 模型实例 ───────────────────────────────────────

function getLiveModel(): LAppModel | null {
  try {
    return LAppDelegate.getInstance().getFirstSubdelegate()?.getLive2DManager().getFirstModel() ?? null;
  } catch {
    return null;
  }
}

// ── 句子切分（清洗与切分由 shared/spokenText 负责） ─────────────────

/** 单次并发请求上限，避免短文本产生过多分片 */
const MAX_SEGMENTS = 8;

// ── base64 → ArrayBuffer ─────────────────────────────────────────

function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ── 全局播放通道：所有来源共用同一条串行队列 ─────────────────────

const _playbackQueue = new SerialPlaybackQueue();
let _nextPlaybackId = 0;

// ── 主入口 ───────────────────────────────────────────────────────

type TtsAPI = Window['ttsAPI'];

// ── WebAudio 共享 AudioContext + 实时音量 ─────────────────────────

let _audioCtx: AudioContext | null = null;
let _rafId: number | null = null;

function getAudioContext(): AudioContext {
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new AudioContext();
  }
  return _audioCtx;
}

function stopLevelMeter(): void {
  if (_rafId !== null) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
  liveliness.setSpeechLevel(0);
}

/**
 * 播放一句，同时每帧把音量送给灵动层（口型、重读时点头挑眉都从这里来）。
 * 在音频播放结束时 resolve。
 */
function playBufferWithLipSync(audioBuffer: AudioBuffer): Promise<void> {
  return new Promise<void>((resolve) => {
    const ctx = getAudioContext();

    // Electron/Chromium 长时间无音频后会自动 suspend AudioContext。
    // resume() 是幂等的，已在 running 状态时立即 resolve。
    const doPlay = () => {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const dataArray = new Uint8Array(analyser.fftSize);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(analyser);
      analyser.connect(ctx.destination);

      const loop = (): void => {
        analyser.getByteTimeDomainData(dataArray);
        liveliness.setSpeechLevel(rmsOfByteTimeDomain(dataArray));
        _rafId = requestAnimationFrame(loop);
      };

      source.onended = () => {
        stopLevelMeter();
        resolve();
      };

      source.start();
      _rafId = requestAnimationFrame(loop);
    };

    if (ctx.state === 'suspended') {
      ctx.resume().then(doPlay).catch(() => doPlay());
    } else {
      doPlay();
    }
  });
}

// ── 单句拉取 + 解码 ─────────────────────────────────────────────

async function _fetchAndDecode(
  ttsAPI: TtsAPI,
  sentence: string,
  audioCtx: AudioContext,
): Promise<AudioBuffer | null> {
  try {
    const result = await ttsAPI.speak(sentence);
    if (!result?.data) return null;
    const buf = base64ToBuffer(result.data);
    return await audioCtx.decodeAudioData(buf.slice(0));
  } catch {
    return null;
  }
}

export function playTTS(text: string, onDuration?: (ms: number, sentenceText?: string) => void): Promise<void> {
  const playbackId = ++_nextPlaybackId;
  const queuedAt = performance.now();
  const queuedAhead = _playbackQueue.pendingCount;
  console.log(`[TTS Queue] queued id=${playbackId} ahead=${queuedAhead} text=${JSON.stringify(text.slice(0, 50))}`);

  return _playbackQueue.enqueue(async () => {
    const startedAt = performance.now();
    console.log(`[TTS Queue] start id=${playbackId} waited=${Math.round(startedAt - queuedAt)}ms`);
    try {
      await playTTSNow(text, onDuration);
    } finally {
      console.log(`[TTS Queue] end id=${playbackId} elapsed=${Math.round(performance.now() - startedAt)}ms`);
    }
  });
}

async function playTTSNow(text: string, onDuration?: (ms: number, sentenceText?: string) => void): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ttsAPI = window.ttsAPI;
  if (!ttsAPI) {
    console.warn('[TTS] 跳过：window.ttsAPI 未注入（preload 未包含？）');
    return;
  }

  // 前置检查：TTS 未启用时静默返回，不发起任何 IPC 请求
  const enabled = await ttsAPI.isEnabled();
  if (!enabled) return;

  const cleaned = normalizeSpokenText(text, { language: 'auto' });
  if (!cleaned) {
    console.warn('[TTS] 跳过：清洗后文本为空');
    return;
  }

  // 串行队列保证上一轮已经结束；这里只清理服务端可能遗留的挂起请求。
  ttsAPI.abortSpeak?.().catch(() => {});
  const model = getLiveModel();
  model?._wavFileHandler.stop();
  model?.setSpeaking(false);
  stopLevelMeter();

  const sentences = splitSpokenText(cleaned, { maxSegments: MAX_SEGMENTS });
  if (sentences.length === 0) {
    console.warn('[TTS] 跳过：没有可朗读的内容（如纯标点“……”）');
    return;
  }
  console.log(`[TTS] 切分为 ${sentences.length} 句:`, sentences);

  getLiveModel()?.setSpeaking(true);
  ttsAPI.pauseHearing?.().catch(() => {});

  const audioCtx = getAudioContext();
  let anyPlayed = false;

  // ── 流水线策略：拿到第 i 句就立刻播放，同时在后台预取第 i+1 句 ──────────
  // 相比旧的"并发全部→等全部→才播放"，这样能：
  //   1. 第 1 句推理完毕就开始发声，不等后续句子
  //   2. 旧世代被中断时已播放的句子不受影响，只是后续句子停止
  //   3. 不会因为等待某一句超时导致整轮静默
  let prefetch: Promise<AudioBuffer | null> | null = null;

  try {
    for (let i = 0; i < sentences.length; i++) {
      // 使用上一轮已预取的 Promise，或现在才发请求
      const fetchNow = prefetch ?? _fetchAndDecode(ttsAPI, sentences[i], audioCtx);
      prefetch = null;

      // 立即开始预取下一句（与当前句推理并行，降低感知延迟）
      if (i + 1 < sentences.length) {
        prefetch = _fetchAndDecode(ttsAPI, sentences[i + 1], audioCtx);
      }

      const audioBuffer = await fetchNow;

      if (!audioBuffer) {
        console.warn(`[TTS] 第 ${i + 1} 句 buffer 为空，跳过`);
        continue;
      }

      // 每句播放前通知当句文本+实际音频时长，让气泡与口型严格对齐
      onDuration?.(Math.round(audioBuffer.duration * 1000), sentences[i]);
      anyPlayed = true;

      console.log(`[TTS] 第 ${i + 1}/${sentences.length} 句开始播放，时长: ${audioBuffer.duration.toFixed(2)}s`);
      // 从真正出声开始算「在说话」：等第一句合成的那几秒里，该听歌还听歌
      liveliness.setSpeaking(true);

      try {
        await playBufferWithLipSync(audioBuffer);
      } catch (e) {
        console.warn(`[TTS] 第 ${i + 1} 句 WebAudio 播放失败:`, e);
      }

      console.log(`[TTS] 第 ${i + 1} 句播放完毕`);
    }
  } finally {
    // 无论怎么结束都要复位：卡在「说话中」会让灵动层一直忽略音乐节拍
    stopLevelMeter();
    getLiveModel()?.setSpeaking(false);
    liveliness.setSpeaking(false);
  }

  ttsAPI.resumeHearing?.().catch(() => {});
  // 所有句均为空（服务器不可达），通知调用方降级处理
  if (onDuration && !anyPlayed) onDuration(0);
  console.log('[TTS] 全部句子播放完成');
}

/**
 * 注册 IPC 监听器，处理主进程推送的 TTS 文本（复用聊天框的 playTTS 逻辑）
 * 在应用初始化时调用
 */
export function registerTTSPlayListener(): void {
  const ttsAPI = window.ttsAPI;
  if (!ttsAPI?.onPlay) {
    console.warn('[TTS] ttsAPI.onPlay 未注入，无法注册 tts:play 监听器');
    return;
  }

  ttsAPI.onPlay((text) => {
    console.log('[TTS] 收到主进程推送的文本，调用 playTTS():', text.substring(0, 50));
    // 复用聊天框的 TTS 逻辑并显示打字机气泡（pause/resume hearing 已内置于 playTTS 内部）
    playTTS(
      text,
      createTypewriterPlaybackCallback(text, shouldShowTypewriterBubble, showTypewriterBubble),
    ).catch((e) => console.error('[TTS] playTTS error:', e));
  });

  console.log('[TTS] tts:play 监听器已注册');
}
