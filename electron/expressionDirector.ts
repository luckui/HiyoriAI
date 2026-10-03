/**
 * 表情导演：她要说一段话时，给每一句选一个表情和强度。
 *
 * 为什么是单独的一次小调用，而不是让回复里夹带 [emotion:xxx] 标签：
 * - 回复正文保持干净，发到 Discord、飞书的文字里不会混进标签；
 * - 和人设、工具调用互不干扰，主回复不用分心去记格式；
 * - 按句给出，一段话里可以先惊讶、再害羞、再得意；
 * - 输出是结构化 JSON，逐项校验，出错就整体放弃，由渲染层的即时线索兜底。
 *
 * 渲染层在开始合成第一句语音时同时发出请求，合成本来就要一两秒，基本不增加等待。
 */

import aiConfig from './ai.config';
import { fetchCompletion } from './llmClient';
import { stripThinkTags } from './utils/textUtils';
import { EXPRESSIONS, EXPRESSION_GUIDE, isExpression, type ExpressionCue } from '../shared/expressions';

/** 一段话最多导演这么多句，再多的句子由渲染层沿用前面的表情 */
const MAX_SENTENCES = 12;
const TIMEOUT_MS = 8000;

const SYSTEM_PROMPT = `你是虚拟主播的表情导演。她马上要把下面这段话一句一句说出来，你为每一句选一个她说这句时脸上该有的表情，以及强度。

可选表情：
${EXPRESSIONS.map(e => `- ${e}：${EXPRESSION_GUIDE[e]}`).join('\n')}

要求：
- 按说话的语气和内容选，不按字面关键词。玩笑话、反话要看出真实语气；
- 表情要连贯：相邻几句的情绪通常是延续的，不要每句都换；
- 强度 0.2–1：平铺直叙的句子用 neutral 或很低的强度，情绪最浓的那一句才用到 0.8 以上；
- 只输出 JSON，不要解释：{"cues":[{"e":"happy","i":0.6}, ...]}，数量和句子数完全一致。`;

function buildUserPrompt(sentences: string[], context?: string): string {
  const lines = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `${context ? `对方刚才说：${context.slice(0, 300)}\n\n` : ''}她要说的话（共 ${sentences.length} 句）：\n${lines}`;
}

/** 解析并逐项校验；任何一项不合格就整体放弃（返回 null），不猜 */
export function parseCues(text: string, count: number): ExpressionCue[] | null {
  const cleaned = stripThinkTags(text).trim();
  const fenced = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced ? fenced[1] : cleaned);
  } catch {
    return null;
  }
  const cues = (parsed as { cues?: unknown })?.cues;
  if (!Array.isArray(cues) || cues.length !== count) return null;
  const result: ExpressionCue[] = [];
  for (const item of cues) {
    const { e, i } = (item ?? {}) as { e?: unknown; i?: unknown };
    if (!isExpression(e) || typeof i !== 'number' || !Number.isFinite(i)) return null;
    result.push({ expression: e, intensity: Math.min(1, Math.max(0, i)) });
  }
  return result;
}

/**
 * @param sentences 渲染层切好的句子（和 TTS 一一对应）
 * @param context 对方刚才说的话（可选），帮助判断语气
 * @returns 每句一个表情；无法判断时返回 null
 */
export async function directExpressions(sentences: string[], context?: string): Promise<ExpressionCue[] | null> {
  const provider = aiConfig.providers[aiConfig.activeProvider];
  if (!provider?.apiKey?.trim() || sentences.length === 0) return null;
  const directed = sentences.slice(0, MAX_SENTENCES);
  try {
    const extraParams = { ...provider.extraParams };
    for (const key of ['max_tokens', 'max_completion_tokens', 'response_format', 'tool_choice', 'tools', 'messages', 'model']) delete extraParams[key];
    const data = await fetchCompletion(
      { ...provider, extraParams },
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(directed, context) },
      ],
      undefined,
      AbortSignal.timeout(TIMEOUT_MS),
      { maxTokens: 40 + 24 * directed.length, temperature: 0.3, disableThinking: true },
    );
    const choice = data.choices?.[0];
    const content = choice?.message.content ?? '';
    const cues = choice?.finish_reason === 'stop' ? parseCues(content, directed.length) : null;
    if (!cues) console.warn(`[Expression] 表情导演的输出无法使用（${choice?.finish_reason}），改用即时线索:`, content.slice(0, 200));
    return cues;
  } catch (error) {
    console.warn('[Expression] 表情导演失败，改用即时线索:', (error as Error).message);
    return null;
  }
}
