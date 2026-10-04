import { speechWeight } from '../shared/spokenText';

/** 字幕节奏的一个点：到 atMs（performance.now 时刻）时应显示到第 chars 个字符 */
export interface TypewriterPoint {
  chars: number;
  atMs: number;
}

export type TypewriterShow = (text: string, durationMs: number) => void;
/** 打到一半知道了这句真实多长（或拿到了逐词时间）：剩下的字按新节奏打完 */
export type TypewriterRetime = (text: string, durationMs: number, timeline?: TypewriterPoint[]) => void;

/**
 * 每句开始时（update=false）调用；之后这句的真实时长、逐词时间到了再以 update=true 调用。
 * timeline 给出时，字幕按她实际念到哪个词显示，而不是匀速打字
 */
export type TypewriterPlaybackCallback = (
  actualMs: number,
  sentenceText?: string,
  update?: boolean,
  timeline?: TypewriterPoint[],
) => void;

export interface TimedWord {
  text: string;
  /** 本段音频中的秒数 */
  atSec: number;
  endSec: number;
  /** 属于第几句（引擎按文本位置标的） */
  sentence?: number;
}

/** 句读后面紧跟着字母或数字：服务端把两边的词粘成了一个 */
const GLUED = /[,.!?;:，。！？；：—][^\s]*[\p{L}\p{N}]/u;
const SEC_PER_LETTER = 0.06;

/** 念出来的字符（字母、数字、汉字），小写，连同它在原文中的下标 */
function spokenChars(text: string): Array<{ ch: string; index: number }> {
  const out: Array<{ ch: string; index: number }> = [];
  let index = 0;
  for (const ch of text) {
    if (speechWeight(ch)) out.push({ ch: ch.toLowerCase(), index });
    index += ch.length;
  }
  return out;
}

/**
 * 把逐词时间对到这句的字符上：每个词开始时显示到这个词之前，结束时显示到这个词（连同后面的标点）。
 * 按念出来的字符逐个对，允许跳过几个对不上的（服务端会把句号两边的词粘成「in.If」，也可能改写个别字），
 * 返回的 atSec 仍是音频中的秒数。
 */
export function mapWordsToChars(sentence: string, words: TimedWord[]): Array<{ chars: number; atSec: number }> {
  const letters = spokenChars(sentence);
  const length = sentence.length;
  const charEnd = (pos: number) => (pos < letters.length ? letters[pos].index : length);
  const points: Array<{ chars: number; atSec: number }> = [];
  let cursor = 0;
  let lastEnd: number | null = null;
  for (const word of words) {
    const w = spokenChars(word.text).map((c) => c.ch);
    if (!w.length || cursor >= letters.length) continue;

    // 在接下来几个字符里找这个词（词跨出这句时只比到句尾）
    let at = -1;
    for (let p = cursor; p <= Math.min(letters.length - 1, cursor + 8) && at < 0; p++) {
      const k = Math.min(w.length, letters.length - p);
      let match = true;
      for (let j = 0; j < k && match; j++) match = letters[p + j].ch === w[j];
      if (match) at = p;
    }
    // 词头粘着上一句的尾巴（「in.If」）：用词尾去对
    if (at < 0) {
      for (let cut = 1; cut < w.length && at < 0; cut++) {
        const tail = w.slice(cut);
        const k = Math.min(tail.length, letters.length - cursor);
        let match = k > 0;
        for (let j = 0; j < k && match; j++) match = letters[cursor + j].ch === tail[j];
        if (match) { at = cursor; w.splice(0, cut); }
      }
    }
    if (at < 0) at = cursor;
    const end = Math.min(letters.length, at + w.length);
    // 粘连词（「ending,so」「in.If」：句读两边的词被服务端粘成一个）的时间不可靠：
    // 接在前一个词后面，按落在这句里的字数估
    let { atSec, endSec } = word;
    if (GLUED.test(word.text) && lastEnd !== null) {
      atSec = lastEnd;
      endSec = lastEnd + (end - at) * SEC_PER_LETTER;
    }
    lastEnd = endSec;
    points.push({ chars: letters[at].index, atSec });
    points.push({ chars: charEnd(end), atSec: endSec });
    cursor = end;
  }
  return points;
}

const MS_PER_HAN = 220;
const MS_PER_WORD = 330;
const MS_PER_FINAL_MARK = 250;
const MS_PER_COMMA = 150;

/**
 * 还不知道一句真实多长时，估计她说完要多久。中文按字，英文按词（按字母算会慢两三倍，
 * 英文字幕会被下一句截断），标点算停顿。
 */
export function estimateSpeechMs(text: string): number {
  const han = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const words = text.match(/[A-Za-z0-9]+(?:['’][A-Za-z]+)*/g)?.length ?? 0;
  const finals = text.match(/[。！？.!?…]+/g)?.length ?? 0;
  const commas = text.match(/[，、；：,;:]/g)?.length ?? 0;
  return han * MS_PER_HAN + words * MS_PER_WORD + finals * MS_PER_FINAL_MARK + commas * MS_PER_COMMA;
}

export function shouldShowEstimatedTypewriter(
  chatExpanded: boolean,
  ttsEnabled: boolean,
): boolean {
  return !chatExpanded && !ttsEnabled;
}

export function createTypewriterPlaybackCallback(
  fullText: string,
  canShow: () => boolean,
  show: TypewriterShow,
  retime?: TypewriterRetime,
): TypewriterPlaybackCallback {
  return (actualMs, sentenceText, update = false, timeline) => {
    if (!canShow()) return;

    const displayedText = sentenceText ?? fullText;
    const durationMs = actualMs > 0
      ? Math.max(300, actualMs * 0.92)
      : displayedText.length * 60;
    if (update) retime?.(displayedText, durationMs, timeline);
    else show(displayedText, durationMs);
  };
}
