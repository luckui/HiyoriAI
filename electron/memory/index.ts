/** Compact 在请求路径上运行；这里的调度只负责把已有摘要精炼进全局记忆。 */
export { memoryManager, MemoryManager } from './manager';
export { globalMemoryManager, GlobalMemoryManager } from './globalManager';

import { globalMemoryManager } from './globalManager';

export function triggerConversationLeave(conversationId: string): void {
  void globalMemoryManager.refineAsync(conversationId);
}

let lastActivityMs = 0;
export function recordMessageActivity(): void { lastActivityMs = Date.now(); }

/** 只处理尚未精炼的摘要，不在启动时总结原始历史 */
export async function runStartupCatchUp(conversationIds: string[]): Promise<void> {
  for (const id of conversationIds) await globalMemoryManager.refineAsync(id);
}

export function startIdleScheduler(getActiveConvId: () => string | null, idleMs = 10 * 60 * 1000): void {
  setInterval(async () => {
    if (!lastActivityMs || Date.now() - lastActivityMs < idleMs) return;
    lastActivityMs = 0;
    const id = getActiveConvId();
    if (id) await globalMemoryManager.refineAsync(id);
  }, 60000);
}
