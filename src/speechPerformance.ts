/**
 * 一段话的表演：她说每一句时，脸上换上这一句的表情。
 *
 *   开始说 → 把切好的句子交给表情导演（主进程，一次小模型调用），同时开始合成语音
 *   每句开口 → 有导演的结果就用；还没回来（常见于第一句）或失败了，用即时线索；
 *              都判断不出来就沿用上一句，但一句比一句淡
 *   说完 → 表情再停留一会儿，然后回到平常
 *
 * TTS 播放器按真实播放进度调用 enter(i)；TTS 关闭时按字数估算进度（performWithoutVoice）。
 */

import type { ExpressionCue } from '../shared/expressions';
import { normalizeSpokenText, splitSpokenText } from '../shared/spokenText';
import { instantCue } from './liveliness/expressionCues';
import { liveliness } from './liveliness/motor';

/** 一段话最多切这么多句（再多就合并相邻的短句）；与表情导演一次能导演的句数一致 */
const MAX_SENTENCES = 12;
/** 说完后表情再停留这么久 */
const LINGER_MS = 2000;
/** 沿用上一句的表情时，每过一句强度乘这个数；太淡就不再沿用 */
const CARRY_DECAY = 0.6;
const CARRY_MIN = 0.25;
/** 没有真实时长时，按每字这么多毫秒估算 */
const ESTIMATED_MS_PER_CHAR = 60;

/** 用户刚说的话，给表情导演参考语气。只用一次，两分钟后作废（避免拿旧话去判断新回复） */
let pendingContext: { text: string; at: number } | null = null;

export function setPerformanceContext(text: string): void {
  pendingContext = { text, at: Date.now() };
}

function takeContext(): string | undefined {
  const context = pendingContext;
  pendingContext = null;
  return context && Date.now() - context.at < 120_000 ? context.text : undefined;
}

/** 和 TTS 用同一套清洗、切句，保证表情和语音一句对一句 */
export function spokenSentences(text: string): string[] {
  const cleaned = normalizeSpokenText(text, { language: 'auto' });
  return cleaned ? splitSpokenText(cleaned, { maxSegments: MAX_SENTENCES }) : [];
}

export interface Performance {
  /** 第 index 句开口 */
  enter(index: number): void;
  /** 整段说完（或被打断） */
  finish(): void;
}

export function startPerformance(sentences: string[]): Performance {
  let directed: ExpressionCue[] | null = null;
  let current = -1;
  let last: ExpressionCue | null = null;
  let finished = false;

  const cueFor = (index: number): ExpressionCue | null => {
    const cue = directed?.[index] ?? instantCue(sentences[index] ?? '');
    if (cue) return cue;
    if (!last || last.intensity * CARRY_DECAY < CARRY_MIN) return null;
    return { expression: last.expression, intensity: last.intensity * CARRY_DECAY };
  };
  const apply = (index: number): void => {
    last = cueFor(index);
    liveliness.setExpression(last);
  };

  window.live2dAPI?.directExpressions(sentences, takeContext())
    .then((cues) => {
      if (!cues || finished) return;
      directed = cues;
      if (current >= 0) apply(current); // 导演的结果比这一句晚到：立刻换上
    })
    .catch(() => { /* 即时线索兜底 */ });

  return {
    enter(index) {
      current = index;
      apply(index);
      liveliness.beginSentence();
    },
    finish() {
      if (finished) return;
      finished = true;
      liveliness.setExpression(last, LINGER_MS);
    },
  };
}

/** TTS 关闭时：没有声音，也按估算的阅读进度一句句换表情 */
export function performWithoutVoice(text: string): void {
  const sentences = spokenSentences(text);
  liveliness.setConversationState('idle');
  if (!sentences.length) return;
  const performance = startPerformance(sentences);
  let at = 0;
  sentences.forEach((sentence, index) => {
    setTimeout(() => performance.enter(index), at);
    at += [...sentence].length * ESTIMATED_MS_PER_CHAR;
  });
  setTimeout(() => performance.finish(), at);
}
