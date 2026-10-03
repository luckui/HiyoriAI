/**
 * 即时表情线索：只看这一句的语气词和标点，零延迟、零成本。
 *
 * 表情导演（主进程里的一次小模型调用）给每句选表情，这里是它的兜底：
 * 导演的结果还没回来（第一句往往如此）或者请求失败时用。
 * 只认很有把握的信号，认不出就返回 null，交给上下文（沿用上一句的表情）。
 */

import type { ExpressionCue } from '../../shared/expressions';

/** 顺序有意义：先匹配更具体的（「哼哼」是得意，单个「哼」才是不满） */
const RULES: Array<{ pattern: RegExp; cue: ExpressionCue }> = [
  { pattern: /哼哼|那当然|本小姐|就知道|没错吧|毕竟是我|小菜一碟|嘿嘿嘿/, cue: { expression: 'smug', intensity: 0.6 } },
  { pattern: /[诶欸咦哇]+[？?！!]|什么[？?！!]|真的[吗嘛][？?！!]?|不会吧|竟然|居然|难以置信|\bwhat\?|\bwow\b/i, cue: { expression: 'surprised', intensity: 0.7 } },
  { pattern: /害羞|不好意思|人家|讨厌啦|欸嘿|才、才|别、别|>\/</, cue: { expression: 'shy', intensity: 0.65 } },
  { pattern: /呜+|唉+|难过|伤心|抱歉|对不起|可惜|心疼|\bsorry\b/i, cue: { expression: 'sad', intensity: 0.55 } },
  { pattern: /哼[，,。！!]|^哼|切[，,。！!]|气死|过分|笨蛋|才不/, cue: { expression: 'angry', intensity: 0.55 } },
  { pattern: /[！!]{2,}|太棒了|好厉害|超级|冲呀|耶[！!～~]/, cue: { expression: 'excited', intensity: 0.7 } },
  { pattern: /嘿嘿|哈哈|嘻嘻|好耶|太好了|开心|谢谢|喜欢|\bhaha\b|\byay\b/i, cue: { expression: 'happy', intensity: 0.6 } },
  { pattern: /^(嗯+|唔+|让我想想|我想想|这个嘛|怎么说呢)|也许|可能吧|大概吧/, cue: { expression: 'thinking', intensity: 0.5 } },
  { pattern: /[？?]\s*$/, cue: { expression: 'curious', intensity: 0.4 } },
];

export function instantCue(sentence: string): ExpressionCue | null {
  const text = sentence.trim();
  for (const { pattern, cue } of RULES) if (pattern.test(text)) return cue;
  return null;
}
