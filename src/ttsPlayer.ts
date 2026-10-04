/**
 * TTS 播放器（渲染进程）
 *
 *   1. 按句切分文本，交给主进程开一段流式朗读（ttsAPI.startStream），引擎是什么都一样：
 *      本地 TTS 按句合成、豆包边合成边返回，送回来的都是 PCM 音频块；
 *   2. PcmStreamPlayer 把音频块首尾相接地播放，每句第一块真正出声时换表情、显示字幕；
 *   3. 播放时每帧把音量送给灵动层（口型、重读时点头挑眉）。
 *
 * 用法：收到 AI 回复文本后调用 playTTS(text)；要打断就 stopTTS()
 */

import { LAppDelegate } from './lappdelegate';
import type { LAppModel } from './lappmodel';
import { dismissTypewriterBubble, typewriterPlayback } from './chat/typewriter';
import { estimateSpeechMs, mapWordsToChars, type TimedWord, type TypewriterPlaybackCallback } from './typewriterPlayback';
import { SerialPlaybackQueue } from './ttsPlaybackQueue';
import { liveliness } from './liveliness/motor';
import { rmsOfByteTimeDomain } from './liveliness/dynamics';
import { performWithoutVoice, spokenSentences, startPerformance } from './speechPerformance';
import { PcmStreamPlayer } from './pcmStreamPlayer';
import type { TtsStreamEvent } from '../shared/preloadApi';


function getLiveModel(): LAppModel | null {
  try {
    return LAppDelegate.getInstance().getFirstSubdelegate()?.getLive2DManager().getFirstModel() ?? null;
  } catch {
    return null;
  }
}

// ── 全局播放通道：所有来源共用同一条串行队列 ─────────────────────

const _playbackQueue = new SerialPlaybackQueue();
let _nextPlaybackId = 0;

// ── WebAudio 共享 AudioContext + 实时音量 ─────────────────────────

let _audioCtx: AudioContext | null = null;
let _rafId: number | null = null;

function getAudioContext(): AudioContext {
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new AudioContext();
  }
  return _audioCtx;
}

function startLevelMeter(analyser: AnalyserNode): void {
  const data = new Uint8Array(analyser.fftSize);
  const loop = (): void => {
    analyser.getByteTimeDomainData(data);
    liveliness.setSpeechLevel(rmsOfByteTimeDomain(data));
    _rafId = requestAnimationFrame(loop);
  };
  _rafId = requestAnimationFrame(loop);
}

function stopLevelMeter(): void {
  if (_rafId !== null) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
  liveliness.setSpeechLevel(0);
}

// ── 当前这一段（打断用）─────────────────────────────────────────

let _current: { streamId: number | null; player: PcmStreamPlayer; abort: () => void } | null = null;

/** 立刻停止正在说的话（之后排队的照常播放） */
export function stopTTS(): void {
  _current?.abort();
}

/** 打断代数：排队时记下，轮到时发现变了就不说 */
let _generation = 0;

/** 立刻停下，排队还没开始的也都不说了（直播中主人开口） */
export function interruptTTS(): void {
  _generation += 1;
  stopTTS();
  // 说到一半的字幕也收掉
  dismissTypewriterBubble();
}

// ── 主入口 ───────────────────────────────────────────────────────

export function playTTS(text: string, onDuration?: TypewriterPlaybackCallback): Promise<void> {
  const playbackId = ++_nextPlaybackId;
  const queuedAt = performance.now();
  const queuedAhead = _playbackQueue.pendingCount;
  console.log(`[TTS Queue] queued id=${playbackId} ahead=${queuedAhead} text=${JSON.stringify(text.slice(0, 50))}`);

  const generation = _generation;
  return _playbackQueue.enqueue(async () => {
    if (generation !== _generation) {
      console.log(`[TTS Queue] skip id=${playbackId}（被打断）`);
      return;
    }
    const startedAt = performance.now();
    console.log(`[TTS Queue] start id=${playbackId} waited=${Math.round(startedAt - queuedAt)}ms`);
    try {
      await playTTSNow(text, onDuration);
    } finally {
      console.log(`[TTS Queue] end id=${playbackId} elapsed=${Math.round(performance.now() - startedAt)}ms`);
    }
  });
}

async function playTTSNow(text: string, onDuration?: TypewriterPlaybackCallback): Promise<void> {
  const ttsAPI = window.ttsAPI;
  if (!ttsAPI) {
    console.warn('[TTS] 跳过：window.ttsAPI 未注入（preload 未包含？）');
    return;
  }

  // TTS 未启用：不发起任何语音请求，但表情照样按阅读进度一句句演
  const enabled = await ttsAPI.isEnabled();
  if (!enabled) {
    performWithoutVoice(text);
    return;
  }

  // 串行队列保证上一轮已经结束；这里只清理主进程可能遗留的合成
  ttsAPI.abortSpeak?.().catch(() => {});
  const model = getLiveModel();
  model?._wavFileHandler.stop();
  model?.setSpeaking(false);
  stopLevelMeter();

  const sentences = spokenSentences(text);
  if (sentences.length === 0) {
    console.warn('[TTS] 跳过：没有可朗读的内容（如纯标点“……”）');
    liveliness.setConversationState('idle');
    return;
  }
  console.log(`[TTS] 切分为 ${sentences.length} 句:`, sentences);
  // 表情导演和语音合成同时开始：合成本来就要等一会儿，表情基本不增加等待
  const performance = startPerformance(sentences);

  getLiveModel()?.setSpeaking(true);
  ttsAPI.pauseHearing?.().catch(() => {});

  const ctx = getAudioContext();
  // Electron/Chromium 长时间无音频后会自动 suspend AudioContext
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(ctx.destination);

  const requestedAt = window.performance.now();
  /** 正在说的句子，以及它的真实时长是否已经告诉字幕 */
  let current = -1;
  let currentTimed = false;
  const player = new PcmStreamPlayer(ctx, analyser, (sentence) => {
    if (sentence === 0) console.log(`[TTS] 首句出声，距请求 ${Math.round(window.performance.now() - requestedAt)}ms`);
    const sentenceText = sentences[sentence];
    // 每句出声时通知字幕：下一句起点已知就用实际时长，否则先估计，知道了再改（见 onSentenceTimed）
    const known = player.sentenceDurationMs(sentence);
    current = sentence;
    currentTimed = known !== null;
    onDuration?.(known ?? estimateSpeechMs(sentenceText ?? ''), sentenceText);
    applyWords();
    // 从真正出声开始算「在说话」：等合成的那段时间里，该听歌还听歌
    liveliness.setSpeaking(true);
    performance.enter(sentence);
  });

  // 后一句的起点到了（或音频结束），正在说的这句的真实时长就知道了：让字幕按它把剩下的字打完
  player.onSentenceTimed = () => {
    if (current < 0) return;
    if (!currentTimed) {
      const ms = player.sentenceDurationMs(current);
      if (ms !== null) {
        currentTimed = true;
        onDuration?.(ms, sentences[current], true);
      }
    }
    applyWords();
  };

  /**
   * 引擎给的逐词时间（豆包开了字幕）：正在说的这句按她实际念到的词显示字幕。
   * 这句的词 = 起点之后、下一句起点之前开始的词
   */
  const words: TimedWord[] = [];
  const applyWords = () => {
    if (current < 0 || !words.length) return;
    const start = player.sentenceStart(current);
    if (start === null) return;
    const next = player.sentenceStart(current + 1);
    // 引擎标了词属于哪句就按它；没标的按时间猜
    const mine = words.filter((w) => (w.sentence !== undefined
      ? w.sentence === current
      : w.atSec >= start - 0.15 && (next === null || w.atSec < next - 0.05)));
    if (!mine.length) return;
    const timeline = mapWordsToChars(sentences[current], mine)
      .map((p) => ({ chars: p.chars, atMs: player.streamToPerfMs(p.atSec) }))
      .filter((p): p is { chars: number; atMs: number } => p.atMs !== null);
    if (!timeline.length) return;
    // 第一个点前补上「这句开始时什么都没显示」
    const startMs = player.streamToPerfMs(start);
    if (startMs !== null && startMs < timeline[0].atMs) timeline.unshift({ chars: 0, atMs: startMs });
    onDuration?.(player.sentenceDurationMs(current) ?? estimateSpeechMs(sentences[current]), sentences[current], true, timeline);
  };

  let streamId: number | null = null;
  let resolveEnd: (error?: string) => void = () => {};
  const streamEnded = new Promise<string | undefined>((resolve) => { resolveEnd = resolve; });
  // 事件可能比 startStream 的返回值先到：先存着，拿到 ID 再处理
  const early: TtsStreamEvent[] = [];
  const handle = (event: TtsStreamEvent) => {
    if (event.type === 'audio') player.enqueue(event.sampleRate, event.pcm);
    else if (event.type === 'sentence') player.mark(event.sentence, event.atSec, event.exact);
    else if (event.type === 'words') {
      words.push(...event.words);
      applyWords();
    }
    else if (event.type === 'end') resolveEnd(event.error);
  };
  const unsubscribe = ttsAPI.onStreamEvent((event) => {
    if (streamId === null) early.push(event);
    else if (event.id === streamId) handle(event);
  });

  let aborted = false;
  _current = {
    streamId: null,
    player,
    abort: () => {
      aborted = true;
      if (streamId !== null) ttsAPI.cancelStream(streamId).catch(() => {});
      player.stop();
      resolveEnd('interrupted');
    },
  };

  startLevelMeter(analyser);
  try {
    streamId = await ttsAPI.startStream(sentences);
    if (streamId === null) {
      console.warn('[TTS] 无法开始朗读（TTS 未启用或引擎出错）');
      resolveEnd('unavailable');
    } else {
      _current.streamId = streamId;
      for (const event of early.splice(0)) if (event.id === streamId) handle(event);
    }

    const error = await streamEnded;
    if (error && !aborted) console.warn(`[TTS] 朗读中途失败: ${error}`);
    if (!aborted) await player.finish();
  } finally {
    unsubscribe();
    _current = null;
    // 无论怎么结束都要复位：卡在「说话中」会让灵动层一直忽略音乐节拍
    stopLevelMeter();
    analyser.disconnect();
    getLiveModel()?.setSpeaking(false);
    liveliness.setSpeaking(false);
    performance.finish();
  }

  ttsAPI.resumeHearing?.().catch(() => {});
  // 一句都没播出来（服务不可达）：通知调用方降级处理
  if (onDuration && !player.anyAudio) onDuration(0);
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

  ttsAPI.onPlay((text, id) => {
    console.log('[TTS] 收到主进程推送的文本，调用 playTTS():', text.substring(0, 50));
    // 复用聊天框的 TTS 逻辑并显示打字机气泡（pause/resume hearing 已内置于 playTTS 内部）
    playTTS(text, typewriterPlayback(text))
      .catch((e) => console.error('[TTS] playTTS error:', e))
      // 主进程（直播节奏）在等她说完
      .finally(() => { if (id !== undefined) ttsAPI.playDone(id); });
  });

  ttsAPI.onInterrupt?.(() => {
    console.log('[TTS] 被打断：停下正在说的，清掉排队的');
    interruptTTS();
  });

  console.log('[TTS] tts:play 监听器已注册');
}
