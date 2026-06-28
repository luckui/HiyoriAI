/**
 * 全局记忆调度层 - 唯一职责：决定「何时精炼」「如何拼接全局记忆提示词」
 *
 * 改进：采用 Hermes Agent 风格的结构化记忆（USER + MEMORY 双分块）
 *
 * 依赖关系（单向）：
 *   globalManager → hermesGlobalSummarizer（调用 LLM，生成结构化记忆）
 *   globalManager → db（读写持久化）
 *   globalManager → ai.config（读取 provider）
 *
 * 外部调用方式（通过 memory/index.ts）：
 *   1. refineAsync(conversationId)         — 可 await 的精炼（供离开对话链式调用）
 *   2. buildGlobalMemoryAppend()           — 同步读取，构建 prompt 时调用（全对话通用）
 */

import aiConfig from '../ai.config';
import {
  getMemoryFragments,
  getStructuredGlobalMemory,
  setStructuredGlobalMemory,
  getGlobalMemoryCursor,
  setGlobalMemoryCursor,
} from '../db';
import { refineStructuredGlobalMemory } from './hermesGlobalSummarizer';
import { DEFAULT_GLOBAL_MEMORY_CONFIG, type GlobalMemoryConfig } from './types';
import { selectMemoryRefinementProvider } from './providerSelection';

export class GlobalMemoryManager {
  private readonly config: GlobalMemoryConfig;

  constructor(config: Partial<GlobalMemoryConfig> = {}) {
    this.config = { ...DEFAULT_GLOBAL_MEMORY_CONFIG, ...config };
  }

  // ── 公开接口 ─────────────────────────────────────────────

  /**
   * 构建全局记忆追加提示词（Hermes 风格，结构化分块显示）。
   * 返回字符串直接 append 到角色 system prompt 末尾。
   * 若尚无全局记忆则返回空字符串。
   */
  buildGlobalMemoryAppend(): string {
    const mem = getStructuredGlobalMemory();
    
    // 无任何记忆时返回空
    if (mem.user.length === 0 && mem.memory.length === 0) return '';

    const parts: string[] = [];

    // USER（用户画像）分块
    if (mem.user.length > 0) {
      const userChars = mem.user.join('').length;
      const userPct = Math.min(100, Math.round((userChars / 1100) * 100)); // 假设 1100 字上限
      const separator = '═'.repeat(46);
      
      parts.push(
        `\n${separator}`,
        `USER PROFILE（用户画像）[${userPct}% — ${userChars}/1100 字]`,
        separator,
        mem.user.join('\n§\n')
      );
    }

    // MEMORY（环境配置）分块
    if (mem.memory.length > 0) {
      const memoryChars = mem.memory.join('').length;
      const memoryPct = Math.min(100, Math.round((memoryChars / 1800) * 100)); // 假设 1800 字上限
      const separator = '═'.repeat(46);
      
      parts.push(
        `\n${separator}`,
        `MEMORY（环境配置和工具经验）[${memoryPct}% — ${memoryChars}/1800 字]`,
        separator,
        mem.memory.join('\n§\n')
      );
    }

    return '\n\n' + parts.join('\n');
  }

  /**
   * 构建仅包含 USER 画像的记忆提示词（Chat 模式专用）。
   * 跳过 MEMORY（环境配置和工具经验）分块，为轻量对话节省 token。
   */
  buildUserProfileOnly(): string {
    const mem = getStructuredGlobalMemory();
    if (mem.user.length === 0) return '';

    const userChars = mem.user.join('').length;
    const userPct = Math.min(100, Math.round((userChars / 1100) * 100));
    const separator = '═'.repeat(46);

    return '\n\n' + [
      `\n${separator}`,
      `USER PROFILE（用户画像）[${userPct}% — ${userChars}/1100 字]`,
      separator,
      mem.user.join('\n§\n'),
    ].join('\n');
  }

  /**
   * 可 await 的全局记忆精炼。
   * 供 memory/index.ts 的离开对话流水线链式调用，保证在本地摘要完成后执行。
   * 若失败，日志记录但不抛出（不阻塞离开流程）。
   */
  async refineAsync(conversationId: string): Promise<void> {
    try {
      await this.doRefine(conversationId);
    } catch (e) {
      console.error('[GlobalMemory] 精炼失败（游标未推进，下次重试）:', (e as Error).message);
    }
  }

  // ── 内部实现 ─────────────────────────────────────────────

  /**
   * 核心精炼逻辑（采用 Hermes 风格的结构化记忆生成）：
   * 1. 读取此对话的全部 memory_fragments
   * 2. 对比全局游标，取出尚未精炼的新片段
   * 3. 数量不足 minNewFragments 时跳过（避免频繁 LLM 调用）
   * 4. 读取当前结构化记忆，调用 LLM 合并更新
   * 5. 仅 LLM 判断有新内容时才写入（"无变化" 时静默跳过）
   * 6. 无论有无新内容，都推进游标（防止对同一批片段重复精炼）
   *    注意：LLM 调用失败时不推进游标，留待下次重试
   */
  private async doRefine(conversationId: string): Promise<void> {
    const selected = selectMemoryRefinementProvider(aiConfig);
    if (!selected.provider) {
      console.warn(
        `[GlobalMemory] skip refinement: activeProvider=${selected.key}, reason=${selected.reason}`
      );
      return;
    }

    const allFragments = getMemoryFragments(conversationId);
    const cursor = getGlobalMemoryCursor(conversationId);
    const newFragments = allFragments.slice(cursor);

    if (newFragments.length < this.config.minNewFragments) {
      // 无新片段或数量不足阈值，跳过
      return;
    }

    const currentMemory = getStructuredGlobalMemory();

    const updated = await refineStructuredGlobalMemory(
      selected.provider,
      currentMemory,
      newFragments,
      this.config
    );

    // LLM 成功返回后推进游标（无论有无新内容）
    setGlobalMemoryCursor(conversationId, allFragments.length);

    if (updated) {
      setStructuredGlobalMemory(updated);
      console.info(
        `[GlobalMemory] 对话 ${conversationId.slice(0, 8)}… 全局记忆已更新（provider=${selected.key}）` +
        `（整合 ${newFragments.length} 条新片段，USER: ${updated.user.length} 条，MEMORY: ${updated.memory.length} 条）`
      );
    } else {
      console.info(
        `[GlobalMemory] 对话 ${conversationId.slice(0, 8)}… 模型判断“无变化”（provider=${selected.key}），仅推进游标`
      );
    }
  }
}

/** 全局单例，供 memory/index.ts 和 aiService 使用 */
export const globalMemoryManager = new GlobalMemoryManager();
