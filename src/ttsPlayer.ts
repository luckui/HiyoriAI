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
import { showTypewriterBubble } from './chat';
import { normalizeSpokenText, splitSpokenText } from '../shared/spokenText';

// ── 获取当前 Live2D 模型实例 ───────────────────────────────────────

function getLiveModel(): LAppModel | null {
  try {
    return LAppDelegate.getInstance().getFirstSubdelegate()?.getLive2DManager().getFirstModel() ?? null;
  } catch {
    return null;
  }
}

// ── 文本预处理：去除对 TTS 无意义的符号、表情、动作描述 ────────

/** Unicode Emoji：使用 Unicode 属性转义，覆盖所有 emoji（含变体序列和 ZWJ 组合） */
const RE_EMOJI = /\p{Extended_Pictographic}[\u{FE0F}\u{FE0E}\u{200D}\u{20E3}\p{Extended_Pictographic}]*/gu;

/** 颜文字：由常见颜文字构成字符连续出现 3 个以上，避免误伤正常标点 */
const RE_KAOMOJI = /[（()）≧≦∇OwO><;:XDd^_=+\-~·°▽○●□■♡♥★☆♪♫◇◆]{3,}/g;

function cleanForTTS(text: string): string {
  return text
    // ── 1. 去除各种括号内的动作/表情/旁白描述 ──
    .replace(/（[^（）]*）/g, '')              // 全角括号：（微笑）
    .replace(/\([^()]*\)/g, '')               // 半角括号：(smiles)
    .replace(/【[^【】]*】/g, '')              // 方头括号：【动作】
    .replace(/「[^「」]*」/g, '')              // 日式引号：「旁白」
    .replace(/『[^『』]*』/g, '')              // 日式双引号：『心想』
    .replace(/〈[^〈〉]*〉/g, '')              // 尖括号：〈动作描述〉
    .replace(/《[^《》]*》/g, '')              // 书名号：《偶尔用作描述》

    // ── 2. 去除星号包裹的动作描述（AI 常用格式） ──
    .replace(/\*[^*\n]{1,30}\*/g, '')         // *叹了口气* *微笑*（限 30 字防误删段落）

    // ── 3. Markdown 语法 → 纯文本 ──
    .replace(/\*\*(.+?)\*\*/g, '$1')          // **粗体**
    .replace(/\*(.+?)\*/g, '$1')              // *斜体*（上一步已删动作，剩余的是格式）
    .replace(/`{1,3}[\s\S]*?`{1,3}/g, '')    // `代码` / ```代码块```
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [链接](url) → 保留文字
    .replace(/^#{1,6}\s/gm, '')              // # 标题
    .replace(/^[-*+]\s/gm, '')               // 列表符号
    .replace(/^>\s?/gm, '')                  // 引用符号
    .replace(/[_~|]/g, '')                   // 剩余 markdown 装饰符

    // ── 4. Emoji + 颜文字 + 特殊符号 → 逗号（避免删除后前后文黏连） ──
    .replace(RE_EMOJI, '，')                   // 🎉😊 → 逗号分隔
    .replace(RE_KAOMOJI, '，')                 // ≧∇≦  OwO  ^_^
    .replace(/[♪♫♬♩★☆✦✧❤♡♥❥◇◆○●□■△▽→←↑↓↔]/g, '') // 散落的装饰符号直接删

    // ── 5. 清理多余逗号和空白 ──
    .replace(/[，,]{2,}/g, '，')               // 连续多个逗号合并
    .replace(/([。！？!?…])，/g, '$1')          // 句末标点后的多余逗号
    .replace(/，([。！？!?…])/g, '$1')          // 句末标点前的多余逗号
    .replace(/^\s*[，,]\s*/g, '')              // 开头的逗号
    .replace(/\s*[，,]\s*$/g, '')              // 结尾的逗号
    .replace(/\s+/g, ' ')
    .trim();
}

// ── 句子切分 ─────────────────────────────────────────────────────

/** 单次并发请求上限，避免短文本产生过多分片 */
const MAX_SEGMENTS = 8;

/**
 * 按句末标点（。！？!?…）切分句子，保留标点在句尾。
 * 过短的碎片会合并到下一段，切分结果不超过 MAX_SEGMENTS 条。
 *
 * 英文句末 ". "（后接大写字母/汉字）也视为句子边界，但排除 2 字母以内的缩写
 * （Mr. Dr. e.g. i.e. U.S. 等），避免误切。
 */
function splitSentences(text: string): string[] {
  // 把英文句末 ". " + 大写 / CJK 规范化为中文句号，便于后续统一切分
  // \w{3,} 排除 Mr./Dr./e.g. 等缩写（结尾单词 < 3 字符）
  const normalized = text
    .replace(/(?<=\w{3,})\.\s+(?=[A-Z\u4e00-\u9fa5\u3040-\u30ff])/g, '。')
    // 英文 ! / ? 后跟空格 + 大写（避免句号规范化破坏已有感叹/问号切分）
    .replace(/([!?])\s+(?=[A-Z\u4e00-\u9fa5])/g, '$1 ');

  const raw = normalized.split(/(?<=[。！？!?…]+)\s*/);
  const result: string[] = [];
  let buffer = '';
  for (const part of raw) {
    buffer += part;
    // 积累到至少 6 个字符才独立成句，避免切出过短碎片
    if (buffer.trim().length >= 6) {
      result.push(buffer.trim());
      buffer = '';
    }
  }
  if (buffer.trim().length >= 3) result.push(buffer.trim());

  // 超出上限时，把尾部多余项合并成一句
  if (result.length > MAX_SEGMENTS) {
    const merged = [...result.slice(0, MAX_SEGMENTS - 1), result.slice(MAX_SEGMENTS - 1).join('')];
    return merged;
  }
  return result.filter(s => s.length > 0);
}

// ── base64 → ArrayBuffer ─────────────────────────────────────────

function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ── 播放世代：新调用时取消上一次未完成的队列 ──────────────────────

let _playGeneration = 0;

// ── 主入口 ───────────────────────────────────────────────────────

type TtsAPI = {
  isEnabled(): Promise<boolean>;
  speak(text: string): Promise<{ data: string } | null>;
  /** 取消主进程所有挂起的 speak 请求，防止旧请求堆积在 CPU 推理队列 */
  abortSpeak?: () => Promise<void>;
  /** 可选：TTS 播放时暂停听力（如果听力未开启，调用无副作用） */
  pauseHearing?: () => Promise<void>;
  /** 可选：TTS 结束后恢复听力 */
  resumeHearing?: () => Promise<void>;
};

// ── WebAudio 共享 AudioContext + 实时口型 ─────────────────────────

let _audioCtx: AudioContext | null = null;
let _rafId: number | null = null;

function getAudioContext(): AudioContext {
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new AudioContext();
  }
  return _audioCtx;
}

function stopLipSync(): void {
  if (_rafId !== null) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
  (window as any)._live2dMouthOpen = 0;
}

/**
 * 通过 WebAudio AnalyserNode 播放 AudioBuffer，同时实时驱动 Live2D 口型 + beat-sync。
 * 返回 Promise，在音频播放结束时 resolve。
 */

/** beat-sync 峰值检测状态（模块级，跨句子保持连续性） */
let _beatLastRms = 0;
let _beatLastTriggerMs = 0;
let _beatFireCount = 0;      // 本次 TTS 播放期间累计触发次数，用于诊断
let _beatRmsLogTimer = 0;    // 每 500ms 打一次 RMS 峰值样本，用于调阈值
let _beatRmsMax = 0;         // 本采样周期内最大 RMS

// RMS 升沿触发阈值：口型用 rms*10，即 rms=0.05 → 嘴开 50%。
// 阈值必须远低于 0.1，否则 TTS 音频振幅不够时永远触发不了 beat。
const BEAT_PEAK_THRESHOLD = 0.04;
const BEAT_MIN_INTERVAL_MS = 220;  // 最小节拍间隔（ms），与 airi-main scheduleBeat 一致

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

      // 实时读取 RMS：① 驱动口型 ② 峰值检测驱动 beat-sync
      const loop = (): void => {
        analyser.getByteTimeDomainData(dataArray);
        let sumSq = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const norm = (dataArray[i] - 128) / 128; // [-1, 1]
          sumSq += norm * norm;
        }
        const rms = Math.sqrt(sumSq / dataArray.length);
        // 放大并钳制到 [0, 1]，中文 TTS 音频振幅偶尔较小，提高系数确保口型明显
        (window as any)._live2dMouthOpen = Math.min(1, rms * 10);

        // ── 诊断日志：每 500ms 打印一次当期最大 RMS，帮助校准阈值 ─────────
        const now = performance.now();
        if (rms > _beatRmsMax) _beatRmsMax = rms;
        if (now - _beatRmsLogTimer >= 500) {
          console.log(`[beat-sync] rms peak=${_beatRmsMax.toFixed(4)}  mouth=${Math.min(1, _beatRmsMax * 10).toFixed(2)}  threshold=${BEAT_PEAK_THRESHOLD}  beats_total=${_beatFireCount}`);
          _beatRmsMax = 0;
          _beatRmsLogTimer = now;
        }

        // ── beat-sync 峰值检测（RMS 升沿触发）────────────────────────────
        if (
          rms > BEAT_PEAK_THRESHOLD &&
          _beatLastRms <= BEAT_PEAK_THRESHOLD &&
          now - _beatLastTriggerMs >= BEAT_MIN_INTERVAL_MS
        ) {
          const interval = now - (_beatLastTriggerMs || now);
          _beatLastTriggerMs = now;
          _beatFireCount++;
          getLiveModel()?.scheduleBeat(now);
          console.log(`[beat-sync] ♪ beat #${_beatFireCount}  rms=${rms.toFixed(4)}  interval=${interval.toFixed(0)}ms`);
        }
        _beatLastRms = rms;

        _rafId = requestAnimationFrame(loop);
      };

      source.onended = () => {
        stopLipSync();
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

export async function playTTS(text: string, onDuration?: (ms: number, sentenceText?: string) => void): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ttsAPI = (window as any).ttsAPI as TtsAPI | undefined;
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

  // 递增世代，取消上一次未完成的播放队列；同时停止正在播放的音频
  const gen = ++_playGeneration;
  const isCurrentGen = () => gen === _playGeneration;

  // 通知主进程取消所有挂起的 HTTP 请求，防止旧请求堆积在 CPU 推理服务器队列
  ttsAPI.abortSpeak?.().catch(() => {});
  const model = getLiveModel();
  model?._wavFileHandler.stop();
  model?.setSpeaking(false);
  stopLipSync();
  // 重置 beat-sync 诊断计数器
  _beatFireCount = 0;
  _beatRmsMax = 0;
  _beatRmsLogTimer = performance.now();
  _beatLastRms = 0;
  _beatLastTriggerMs = 0;

  const sentences = splitSpokenText(cleaned, { maxSegments: MAX_SEGMENTS });
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

  for (let i = 0; i < sentences.length; i++) {
    if (!isCurrentGen()) break;

    // 使用上一轮已预取的 Promise，或现在才发请求
    const fetchNow = prefetch ?? _fetchAndDecode(ttsAPI, sentences[i], audioCtx);
    prefetch = null;

    // 立即开始预取下一句（与当前句推理并行，降低感知延迟）
    if (i + 1 < sentences.length && isCurrentGen()) {
      prefetch = _fetchAndDecode(ttsAPI, sentences[i + 1], audioCtx);
    }

    const audioBuffer = await fetchNow;
    if (!isCurrentGen()) break;

    if (!audioBuffer) {
      console.warn(`[TTS] 第 ${i + 1} 句 buffer 为空，跳过`);
      continue;
    }

    // 每句播放前通知当句文本+实际音频时长，让气泡与口型严格对齐
    onDuration?.(Math.round(audioBuffer.duration * 1000), sentences[i]);
    anyPlayed = true;

    console.log(`[TTS] 第 ${i + 1}/${sentences.length} 句开始播放，时长: ${audioBuffer.duration.toFixed(2)}s`);

    try {
      await playBufferWithLipSync(audioBuffer);
    } catch (e) {
      console.warn(`[TTS] 第 ${i + 1} 句 WebAudio 播放失败:`, e);
    }

    if (!isCurrentGen()) break;
    console.log(`[TTS] 第 ${i + 1} 句播放完毕`);
  }

  stopLipSync();
  getLiveModel()?.setSpeaking(false);

  // 只有当前世代才恢复听力：防止旧世代的清理撤销新世代的 pauseHearing
  if (isCurrentGen()) {
    ttsAPI.resumeHearing?.().catch(() => {});
    // 所有句均为空（服务器不可达），通知调用方降级处理
    if (onDuration && !anyPlayed) onDuration(0);
    console.log('[TTS] 全部句子播放完成');
  }
}

/**
 * 注册 IPC 监听器，处理主进程推送的 TTS 文本（复用聊天框的 playTTS 逻辑）
 * 在应用初始化时调用
 */
export function registerTTSPlayListener(): void {
  const ttsAPI = (window as any).ttsAPI;
  if (!ttsAPI?.onPlay) {
    console.warn('[TTS] ttsAPI.onPlay 未注入，无法注册 tts:play 监听器');
    return;
  }

  ttsAPI.onPlay((text: string) => {
    console.log('[TTS] 收到主进程推送的文本，调用 playTTS():', text.substring(0, 50));
    // 复用聊天框的 TTS 逻辑并显示打字机气泡（pause/resume hearing 已内置于 playTTS 内部）
    playTTS(text, (actualMs) => {
      if (actualMs > 0) {
        showTypewriterBubble(text, Math.max(300, actualMs * 0.92));
      } else {
        showTypewriterBubble(text, text.length * 60);
      }
    }).catch((e) => console.error('[TTS] playTTS error:', e));
  });

  console.log('[TTS] tts:play 监听器已注册');
}
