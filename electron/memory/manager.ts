import type { LLMProviderConfig } from '../ai.config';
import type { ChatMessage, ToolSchema } from '../tools/types';
import { getContextCheckpoint, setContextCheckpoint, getMessagesInRange, addMemoryFragment, runInTransaction } from '../db';
import { getContextInputBudget } from '../../shared/contextBudget';
import { compactContext, summaryMessage } from './compact';
import { createCompactSummarizer } from './summarizer';
import { globalMemoryManager } from './globalManager';

export class MemoryManager {
  /** Only the current checkpoint and uncovered original messages enter the prompt. */
  readContext(conversationId: string): ChatMessage[] {
    const checkpoint = getContextCheckpoint(conversationId);
    const raw = getMessagesInRange(conversationId, checkpoint?.covered_messages ?? 0, -1);
    return [
      ...(checkpoint ? [summaryMessage(checkpoint.summary)] : []),
      ...raw.map(message => ({ role: message.role as 'user' | 'assistant', content: message.content })),
    ];
  }

  async prepareContext(
    conversationId: string, system: ChatMessage[], provider: LLMProviderConfig,
    tools?: ToolSchema[], signal?: AbortSignal,
  ): Promise<ChatMessage[]> {
    const checkpoint = getContextCheckpoint(conversationId);
    const covered = checkpoint?.covered_messages ?? 0;
    const raw = getMessagesInRange(conversationId, covered, -1);
    const original: ChatMessage[] = raw.map(message => ({ role: message.role as 'user' | 'assistant', content: message.content }));
    const messages = [...system, ...(checkpoint ? [summaryMessage(checkpoint.summary)] : []), ...original];
    const result = await compactContext(messages, tools, getContextInputBudget(provider), createCompactSummarizer(provider, signal));
    if (!result.summary) return result.messages;
    signal?.throwIfAborted();
    const removed = new Set(result.removed);
    const count = original.filter(message => removed.has(message)).length;
    if (original.slice(0, count).some(message => !removed.has(message))) throw new Error('压缩范围不是连续历史前缀');
    runInTransaction(() => {
      if (JSON.stringify(getContextCheckpoint(conversationId)) !== JSON.stringify(checkpoint)) throw new Error('上下文压缩检查点已更新，请重试');
      setContextCheckpoint(conversationId, { covered_messages: covered + count, summary: result.summary! });
      addMemoryFragment({ conversation_id: conversationId, content: result.summary!, msg_offset_end: covered + count });
    });
    console.info(`[Compact] ${conversationId.slice(0, 8)}… 已覆盖 ${covered + count} 条原始消息`);
    // 摘要刚落盘：让记忆子智能体从中提取值得长期保留的事实。
    // 不等待也不阻塞本次回复；失败只记日志，游标不前进，下次压缩或空闲时重试。
    void globalMemoryManager.refineAsync(conversationId);
    return result.messages;
  }
}

export const memoryManager = new MemoryManager();
