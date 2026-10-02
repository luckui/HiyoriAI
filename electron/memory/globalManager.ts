/**
 * 全局记忆调度层：决定「何时精炼」「怎么拼进提示词」。
 *
 * 触发点只有一个真正重要：压缩（compact）刚产生一条摘要时。
 * 其余入口（离开对话、空闲、退出、启动追赶）都是补漏，捡上次失败或没触发到的片段。
 *
 * 所有精炼串行执行：精炼结束时会校验「期间记忆和游标没被改过」，
 * 并发跑只会让后完成的那次白白丢掉一整个 LLM 调用。
 */

import aiConfig from '../ai.config';
import {
  getMemoryFragments,
  getStructuredGlobalMemory,
  setStructuredGlobalMemory,
  getGlobalMemoryCursor,
  setGlobalMemoryCursor,
  runInTransaction,
} from '../db';
import { refineGlobalMemory } from './globalRefiner';
import { renderGlobalMemory } from './globalMemory';
import { selectMemoryRefinementProvider } from './providerSelection';

export class GlobalMemoryManager {
  private queue: Promise<void> = Promise.resolve();
  private readonly pending = new Set<string>();

  /**
   * 构建追加到 system prompt 末尾的记忆提示词；无记忆时返回空字符串。
   * userOnly 供 chat / minecraft 模式使用：只带稳定的用户画像。
   */
  buildGlobalMemoryAppend(options: { userOnly?: boolean } = {}): string {
    return renderGlobalMemory(getStructuredGlobalMemory(), options);
  }

  /**
   * 排队精炼这个对话的新片段。失败只记日志（游标不前进，下次重试），
   * 所以调用方可以安全地 void 掉。
   */
  async refineAsync(conversationId: string): Promise<void> {
    // 已经排在队里还没跑的，合并成一次：它跑起来时会读到最新的片段
    if (this.pending.has(conversationId)) return this.queue;
    this.pending.add(conversationId);
    this.queue = this.queue.then(async () => {
      this.pending.delete(conversationId);
      try {
        await this.doRefine(conversationId);
      } catch (e) {
        console.error('[Memory] 精炼失败（游标未前进，下次重试）:', (e as Error).message);
      }
    });
    return this.queue;
  }

  /**
   * 1. 取游标之后的新摘要片段，没有就直接返回
   * 2. 调精炼子智能体合并进当前记忆
   * 3. 事务里确认记忆和游标没被别人改过，再写入并推进游标
   *    —— 模型判断「无变化」时也推进游标，避免对同一批片段反复提问；
   *       只有调用或落盘失败才不推进。
   */
  private async doRefine(conversationId: string): Promise<void> {
    const selected = selectMemoryRefinementProvider(aiConfig);
    if (!selected.provider) {
      console.warn(`[Memory] 跳过精炼：activeProvider=${selected.key}，原因=${selected.reason}`);
      return;
    }

    const allFragments = getMemoryFragments(conversationId);
    const cursor = getGlobalMemoryCursor(conversationId);
    const fragments = allFragments.slice(cursor);
    if (!fragments.length) return;

    const current = getStructuredGlobalMemory();
    const updated = await refineGlobalMemory(selected.provider, current, fragments);

    runInTransaction(() => {
      if (getGlobalMemoryCursor(conversationId) !== cursor ||
          JSON.stringify(getStructuredGlobalMemory()) !== JSON.stringify(current)) {
        throw new Error('精炼期间记忆或游标已变化，放弃旧结果，下次重试');
      }
      if (updated) setStructuredGlobalMemory(updated);
      setGlobalMemoryCursor(conversationId, allFragments.length);
    });

    const outcome = updated
      ? `已更新（USER ${updated.user.length} 条，MEMORY ${updated.memory.length} 条）`
      : '模型判断无变化';
    console.info(
      `[Memory] ${conversationId.slice(0, 8)}… 整合 ${fragments.length} 条摘要：${outcome}`
      + `（provider=${selected.key}）`
    );
  }
}

/** 全局单例，供 memory/index.ts、manager 和 aiService 使用 */
export const globalMemoryManager = new GlobalMemoryManager();
