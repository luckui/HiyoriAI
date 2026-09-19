/** 全局记忆导出 / 导入（Markdown 文件） */

import { button, runWithButton } from './dom';

function bindMemoryAction(buttonId: string, verb: '导出' | '导入', action: () => Promise<{ success: boolean; error?: string }>): void {
  document.getElementById(buttonId)?.addEventListener('click', () => {
    void runWithButton(button(buttonId), { busy: `${verb}中…`, done: `✓ 已${verb}`, failed: `${verb}失败` }, async () => {
      const result = await action();
      if (!result.success) throw new Error(result.error ?? `${verb}失败`);
    });
  });
}

export function initMemoryPanel(): void {
  const api = window.memoryAPI;
  if (!api) return;
  bindMemoryAction('memory-export-btn', '导出', () => api.export());
  bindMemoryAction('memory-import-btn', '导入', () => api.import());
}
