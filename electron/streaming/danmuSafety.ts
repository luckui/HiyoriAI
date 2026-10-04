import crypto from 'crypto';
import type { LiveChatEvent } from '../../shared/types/live';
import type { SanitizedChat } from './types';

const MAX_TEXT = 240;
const MAX_NAME = 32;

const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/(system|developer|assistant|tool)\s*:/i, 'role-spoofing'],
  [/(ignore|forget|override).{0,20}(previous|above|instructions|rules)/i, 'instruction-override'],
  [/你现在是|从现在开始|忽略(以上|之前)|系统提示词|开发者消息/, 'cn-instruction-override'],
  [/<\s*(script|iframe|object|embed)\b/i, 'html-script'],
  [/```|<\|.*?\|>|<\/?(system|developer|assistant|tool)>/i, 'prompt-boundary'],
];

/** 观众名进提示词前的清洗 */
export function cleanName(value: unknown): string {
  return cleanScalar(value, MAX_NAME) || '某位观众';
}

/** 观众文字进提示词前的清洗 */
export function cleanText(value: unknown): string {
  return cleanScalar(value, MAX_TEXT);
}

function cleanScalar(value: unknown, maxLen: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function sanitizeChat(event: LiveChatEvent): SanitizedChat {
  const text = cleanScalar(event.text, MAX_TEXT);
  const uname = cleanScalar(event.user.name || `uid-${event.user.id || 'unknown'}`, MAX_NAME);
  const riskFlags = INJECTION_PATTERNS
    .filter(([pattern]) => pattern.test(text))
    .map(([, flag]) => flag);

  const normalized = text
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\p{Script=Han}]+/gu, '')
    .slice(0, 160);

  const fingerprint = crypto
    .createHash('sha1')
    .update(`${event.user.id || uname}:${normalized}`)
    .digest('hex');

  return { id: event.id, ts: event.ts, uid: event.user.id || uname, uname, text, fingerprint, riskFlags, source: event };
}
