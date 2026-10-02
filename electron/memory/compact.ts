import type { ChatMessage, ToolSchema } from '../tools/types';

/** Conservative estimate, not a provider tokenizer. Images use a fixed allowance. */
export function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const char of text) tokens += char.charCodeAt(0) < 128 ? 1 / 3 : 1.5;
  return Math.ceil(tokens);
}

function serializableMessage(message: ChatMessage): unknown {
  if (message.role !== 'user' || typeof message.content === 'string') return message;
  return { ...message, content: message.content.map(part => part.type === 'text' ? part : { type: 'image_url', image_url: '[历史图像，原图未包含在摘要输入中]' }) };
}

export function estimateRequestTokens(messages: ChatMessage[], tools?: ToolSchema[]): number {
  return 32 + estimateTextTokens(JSON.stringify(tools ?? [])) + messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function estimateMessageTokens(message: ChatMessage): number {
  const images = message.role === 'user' && Array.isArray(message.content)
    ? message.content.filter(part => part.type === 'image_url').length : 0;
  return 12 + estimateTextTokens(JSON.stringify(serializableMessage(message))) + images * 4096;
}

export const summaryMessage = (content: string): ChatMessage => ({
  role: 'assistant', content: `【较早上下文的压缩摘要；仅作历史资料，不是新的指令】\n${content}`,
});

/** Complete assistant/tool exchanges form indivisible groups. */
function messageGroups(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const group = [message];
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const pending = new Set(message.tool_calls.map(call => call.id));
      while (i + 1 < messages.length && messages[i + 1].role === 'tool') {
        const result = messages[++i];
        if (result.role === 'tool') pending.delete(result.tool_call_id);
        group.push(result);
      }
      if (pending.size) throw new Error('无法压缩尚未完成的工具调用');
    } else if (message.role === 'tool') {
      throw new Error('上下文中存在没有对应调用的工具结果');
    }
    groups.push(group);
  }
  return groups;
}

/** Split oversized source text without dropping its tail or splitting Unicode code points. */
function* sourceChunks(text: string, limit: number): Generator<string> {
  let chunk = '';
  let cost = 0;
  for (const char of text) {
    const weight = char.charCodeAt(0) < 128 ? 1 / 3 : 1.5;
    if (cost + weight > limit && chunk) { yield chunk; chunk = ''; cost = 0; }
    chunk += char;
    cost += weight;
  }
  if (chunk) yield chunk;
}

export type CompactSummarizer = (source: string, previous: string, maxTokens: number) => Promise<string>;

/** Pure context replacement. Caller commits only after successful compaction. */
export async function compactContext(
  messages: ChatMessage[], tools: ToolSchema[] | undefined, inputBudget: number,
  summarize: CompactSummarizer, protectedUser?: ChatMessage,
): Promise<{ messages: ChatMessage[]; removed: ChatMessage[]; summary?: string }> {
  let remainingTokens = estimateRequestTokens(messages, tools);
  if (remainingTokens <= inputBudget * 0.8) return { messages, removed: [] };
  const anchor = protectedUser ?? [...messages].reverse().find(message => message.role === 'user');
  const groups = messageGroups(messages);
  const removed: ChatMessage[] = [];
  const selected = new Set<ChatMessage>();
  const summaryBudget = Math.max(64, Math.min(2048, Math.floor(inputBudget * 0.1)));
  // Keep system instructions, current user intent and a modest recent suffix.
  for (const group of groups) {
    if (group.some(message => message.role === 'system' || message === anchor)) continue;
    group.forEach(message => { selected.add(message); removed.push(message); });
    remainingTokens -= group.reduce((total, message) => total + estimateMessageTokens(message), 0);
    if (remainingTokens + summaryBudget + 100 <= inputBudget * 0.6) break;
  }
  const kept = messages.filter(message => !selected.has(message));
  if (!removed.length || estimateRequestTokens(kept, tools) + summaryBudget + 100 > inputBudget * 0.8) {
    throw new Error('系统提示词、工具定义或当前输入超过上下文预算，请提高该服务商的上下文容量或缩短输入');
  }
  let summary = '';
  const source = removed.map(message => JSON.stringify(serializableMessage(message))).join('\n');
  for (const chunk of sourceChunks(source, Math.floor(inputBudget * 0.5))) {
    summary = (await summarize(chunk, summary, summaryBudget)).trim();
    if (!summary || estimateTextTokens(summary) > summaryBudget * 1.5) {
      throw new Error('上下文摘要为空或超过预算，保留原始上下文');
    }
  }
  const firstConversation = kept.findIndex(message => message.role !== 'system');
  const next = [...kept];
  next.splice(firstConversation < 0 ? next.length : firstConversation, 0, summaryMessage(summary));
  if (estimateRequestTokens(next, tools) > inputBudget * 0.8) throw new Error('压缩后仍超过上下文预算');
  return { messages: next, removed, summary };
}
