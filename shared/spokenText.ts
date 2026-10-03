export type SpokenLanguage = 'auto' | 'zh' | 'ja' | 'en';

export interface SpokenTextOptions {
  language?: string;
}

export interface SplitSpokenTextOptions {
  maxSegments?: number;
  maxSentenceLength?: number;
}

const RE_EMOJI = /\p{Extended_Pictographic}[\u{FE0F}\u{FE0E}\u{200D}\u{20E3}\p{Extended_Pictographic}]*/gu;
const RE_KAOMOJI = /[()（）≧≦OwO><;:XDd^_=+\-~·°☆★○●◇◆□■♪♫☀☁]{3,}/g;
const RE_WINDOWS_PATH = /(?:[A-Za-z]:\\|\\\\)[^\s，。！？；：|]+/g;
const RE_DATE_TIME = /\b(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?\b/g;

const EN_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function normalizeLanguage(language?: string): SpokenLanguage {
  const value = (language ?? 'auto').trim().toLowerCase();
  if (value.startsWith('ja') || value.includes('japan')) return 'ja';
  if (value.startsWith('en') || value.includes('english')) return 'en';
  if (value.startsWith('zh') || value.includes('chinese') || value.includes('中文')) return 'zh';
  return 'auto';
}

function inferSpeechLanguage(text: string, language?: string): Exclude<SpokenLanguage, 'auto'> {
  const normalized = normalizeLanguage(language);
  if (normalized !== 'auto') return normalized;
  const kana = (text.match(/[\u3040-\u30ff]/g) ?? []).length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (kana >= 2 && kana >= cjk) return 'ja';
  if (latin >= 8 && latin > cjk * 2) return 'en';
  return 'zh';
}

function ordinal(n: number, language: Exclude<SpokenLanguage, 'auto'>): string {
  if (language === 'en') return `Item ${n}`;
  if (language === 'ja') return `${n}番目`;
  return `第${toChineseNumber(n)}项`;
}

function listSeparator(language: Exclude<SpokenLanguage, 'auto'>): string {
  if (language === 'en') return ', ';
  if (language === 'ja') return '、';
  return '，';
}

function sentenceEnd(language: Exclude<SpokenLanguage, 'auto'>): string {
  return language === 'en' ? '.' : '。';
}

function toChineseNumber(n: number): string {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n <= 10) return n === 10 ? '十' : digits[n];
  if (n < 20) return `十${digits[n % 10]}`;
  if (n < 100) return `${digits[Math.floor(n / 10)]}十${n % 10 ? digits[n % 10] : ''}`;
  return String(n);
}

function formatDateTime(year: string, month: string, day: string, hour: string | undefined, minute: string | undefined, language: Exclude<SpokenLanguage, 'auto'>): string {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (language === 'en') {
    const date = `${EN_MONTHS[Math.max(0, Math.min(11, m - 1))]} ${d}, ${y}`;
    return hour && minute ? `${date} at ${hour}:${minute}` : date;
  }
  if (language === 'ja') {
    return hour && minute ? `${y}年${m}月${d}日${Number(hour)}時${minute}分` : `${y}年${m}月${d}日`;
  }
  return hour && minute ? `${y}年${m}月${d}日${Number(hour)}点${minute}分` : `${y}年${m}月${d}日`;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```([\s\S]*?)```/g, ' $1 ')
    .replace(/`([^`\n]+)`/g, ' $1 ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/[_~]/g, '');
}

function stripBracketAsides(text: string): string {
  return text
    .replace(/（[^（）]*）/g, '')
    .replace(/\([^()]*\)/g, '')
    .replace(/【[^【】]*】/g, '')
    // 引号里多半是要读出来的话（她说「你好」），保留内容、去掉引号
    .replace(/「([^「」]*)」/g, '$1')
    .replace(/『([^『』]*)』/g, '$1')
    .replace(/《([^《》]*)》/g, '$1');
}

function normalizeInlineText(text: string, language: Exclude<SpokenLanguage, 'auto'>): string {
  return text
    .replace(RE_DATE_TIME, (_match, y, m, d, h, min) => formatDateTime(y, m, d, h, min, language))
    .replace(RE_WINDOWS_PATH, '')
    .replace(/项目\/工作区/g, language === 'en' ? 'project or workspace' : language === 'ja' ? 'プロジェクトまたはワークスペース' : '项目或工作区')
    .replace(/\s[\/]\s/g, language === 'en' ? ' or ' : language === 'ja' ? ' または ' : '或')
    .replace(/[|｜]/g, '，')
    .replace(RE_EMOJI, '，')
    .replace(RE_KAOMOJI, '，')
    .replace(/[★☆♪♫☀☁❤♡♥→←↑↓]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*([，。！？；：])\s*/g, '$1')
    // 英文标点前不留空格、后面留一个：「something. So」的空格是切句判断句号的依据
    .replace(/\s+([.!?;:])/g, '$1')
    .replace(/([.!?;:])\s+/g, '$1 ')
    .replace(/,\s*/g, ', ')
    .replace(/[，,]{2,}/g, '，')
    .replace(/^[，,。！？；：\s]+|[，,。！？；：\s]+$/g, '')
    .trim();
}

function normalizeLine(line: string, language: Exclude<SpokenLanguage, 'auto'>): string | null {
  let current = stripMarkdown(line).trim();
  if (!current) return null;

  const numbered = current.match(/^(\d+)[.)、]\s*(.+)$/);
  if (numbered) {
    const text = normalizeInlineText(numbered[2], language);
    return text ? `${ordinal(Number(numbered[1]), language)}${listSeparator(language)}${text}${sentenceEnd(language)}` : null;
  }

  current = current.replace(/^[-*+]\s+/, '');

  if (/^(路径|path)\s*[:：]/i.test(current)) return null;
  current = normalizeInlineText(current, language);
  if (!current) return null;
  if (!/[。！？.!?]$/.test(current)) current += sentenceEnd(language);
  return current;
}

export function normalizeSpokenText(text: string, options: SpokenTextOptions = {}): string {
  const language = inferSpeechLanguage(text, options.language);
  const preprocessed = stripBracketAsides(stripMarkdown(text)).replace(/\r\n?/g, '\n');
  const lines = preprocessed
    .split('\n')
    .map(line => normalizeLine(line, language))
    .filter((line): line is string => !!line);

  // 以英文标点结尾的行和下一行之间留空格，否则「line one.Line two」切不开句、英文单词也会粘在一起
  return lines
    .reduce((joined, line) => (joined && /[.!?;:]$/.test(joined) ? `${joined} ${line}` : joined + line), '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 至少包含一个可读出的字符（任意语言的文字或数字）。纯标点如"……"送去合成会得到一段无意义的声音 */
export function hasSpeakableContent(sentence: string): boolean {
  return /[\p{L}\p{N}]/u.test(sentence);
}

/**
 * 切句：把一段话切成一句句送去合成。
 *
 * GPT-SoVITS 类模型（Genie）一次合成一句最稳，太长、太短都会出问题：
 * - 太短（「诶？」「哈哈！」）：实测常被读错音或出一段怪声 → 并到相邻句子里；
 * - 太长：注意力容易散，还可能超出单次生成的长度上限 → 在逗号、顿号处断开，每段 40 字左右；
 * - 句号要认得出不是句号的点：3.14、v2.0.2、example.com 都不能在点上切开。
 */

/** 句末标点：一句话到这里结束（英文句点另行判断） */
const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '；', ';']);
/** 紧跟在句末标点后、仍属于这一句的收尾符号（引号、括号、连续的标点） */
const TRAILING = /[」』”’"）)】\]…～~！？!?。]/u;
/** 长句可以断开的地方 */
const CLAUSE_BREAK = /[，,、：:]/u;
/** 少于这么多个可读字符的句子并到相邻句子里 */
const MIN_SPEAKABLE_CHARS = 5;
/** 超过这么多个可读字符的句子在逗号处断开，每段尽量不超过 TARGET */
const LONG_SENTENCE_CHARS = 60;
const TARGET_CLAUSE_CHARS = 40;

function speakableLength(sentence: string): number {
  return sentence.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

function joinSentences(a: string, b: string): string {
  return /[A-Za-z0-9][.!?,]?$/.test(a) && /^[A-Za-z0-9]/.test(b) ? `${a} ${b}` : a + b;
}

/** 英文句点是不是句末：数字中间（3.14）、后面紧跟字母（example.com、e.g.）、省略号中间都不是 */
function isSentencePeriod(chars: string[], i: number): boolean {
  const prev = chars[i - 1] ?? '';
  const next = chars[i + 1] ?? '';
  if (/\d/.test(prev) && /\d/.test(next)) return false;
  if (/[A-Za-z0-9.]/.test(next)) return false;
  return true;
}

function splitSentences(text: string): string[] {
  const chars = [...text];
  const sentences: string[] = [];
  let current = '';
  for (let i = 0; i < chars.length; i++) {
    current += chars[i];
    const ends = SENTENCE_END.has(chars[i]) || (chars[i] === '.' && isSentencePeriod(chars, i));
    if (!ends) continue;
    while (i + 1 < chars.length && TRAILING.test(chars[i + 1])) current += chars[++i];
    sentences.push(current.trim());
    current = '';
  }
  if (current.trim()) sentences.push(current.trim());
  return sentences;
}

/** 长句在逗号处断开；一个分句本身就超过 hardMax（没有标点的长串）才硬切 */
function splitLongSentence(sentence: string, hardMax: number): string[] {
  if (speakableLength(sentence) <= LONG_SENTENCE_CHARS) return [sentence];
  const clauses: string[] = [];
  let current = '';
  for (const char of sentence) {
    current += char;
    if (CLAUSE_BREAK.test(char)) {
      clauses.push(current);
      current = '';
    }
  }
  if (current) clauses.push(current);

  const pieces: string[] = [];
  let piece = '';
  for (const clause of clauses) {
    if (piece && speakableLength(piece) + speakableLength(clause) > TARGET_CLAUSE_CHARS) {
      pieces.push(piece);
      piece = '';
    }
    piece += clause;
  }
  if (piece) pieces.push(piece);

  return pieces.flatMap((p) => {
    if (p.length <= hardMax) return [p.trim()];
    const chunks: string[] = [];
    const chars = [...p];
    for (let i = 0; i < chars.length; i += hardMax) chunks.push(chars.slice(i, i + hardMax).join('').trim());
    return chunks;
  }).filter(Boolean);
}

function mergeShortSentences(sentences: string[]): string[] {
  const merged: string[] = [];
  let pending = '';
  for (const sentence of sentences) {
    pending = pending ? joinSentences(pending, sentence) : sentence;
    if (speakableLength(pending) >= MIN_SPEAKABLE_CHARS) {
      merged.push(pending);
      pending = '';
    }
  }
  if (pending) {
    if (merged.length) merged[merged.length - 1] = joinSentences(merged[merged.length - 1], pending);
    else merged.push(pending);
  }
  return merged;
}

/** 句数超过上限：反复合并相邻两句里加起来最短的一对，而不是把剩下的全堆进最后一句 */
function limitSegments(sentences: string[], maxSegments: number): string[] {
  const list = [...sentences];
  while (list.length > Math.max(1, maxSegments)) {
    let best = 0;
    for (let i = 1; i < list.length - 1; i++) {
      if (list[i].length + list[i + 1].length < list[best].length + list[best + 1].length) best = i;
    }
    list.splice(best, 2, joinSentences(list[best], list[best + 1]));
  }
  return list;
}

export function splitSpokenText(text: string, options: SplitSpokenTextOptions = {}): string[] {
  const maxSegments = options.maxSegments ?? 8;
  const hardMax = options.maxSentenceLength ?? 80;
  const normalized = text.trim();
  if (!normalized) return [];
  const sentences = splitSentences(normalized)
    .filter(hasSpeakableContent)
    .flatMap((sentence) => splitLongSentence(sentence, hardMax));
  return limitSegments(mergeShortSentences(sentences), maxSegments);
}
