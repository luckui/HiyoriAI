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

function speechLanguage(language?: string): Exclude<SpokenLanguage, 'auto'> {
  const normalized = normalizeLanguage(language);
  return normalized === 'auto' ? 'zh' : normalized;
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
    .replace(/「[^「」]*」/g, '')
    .replace(/『[^『』]*』/g, '')
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
    .replace(/\s*([，。！？；：.!?;:])\s*/g, '$1')
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

  return lines
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/([。！？.!?])([^\s。！？.!?])/g, '$1$2')
    .trim();
}

export function splitSpokenText(text: string, options: SplitSpokenTextOptions = {}): string[] {
  const maxSegments = options.maxSegments ?? 8;
  const maxSentenceLength = options.maxSentenceLength ?? 180;
  const normalized = text.trim();
  if (!normalized) return [];
  const raw = normalized.match(/[^。！？!?；;.]+[。！？!?；;.]?/g) ?? [normalized];
  const chunks: string[] = [];
  for (const sentence of raw.map(value => value.trim()).filter(Boolean)) {
    if (sentence.length <= maxSentenceLength) {
      chunks.push(sentence);
      continue;
    }
    for (let i = 0; i < sentence.length; i += maxSentenceLength) {
      chunks.push(sentence.slice(i, i + maxSentenceLength));
    }
  }
  if (chunks.length <= maxSegments) return chunks;
  return [...chunks.slice(0, maxSegments - 1), chunks.slice(maxSegments - 1).join('')];
}
