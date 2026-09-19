/**
 * 设置页：LLM 配置、Agent 模式、Skills、记忆导入导出。
 */

import { dialog, ipcMain } from 'electron';
import aiConfig from '../ai.config';
import { getAgentMode, setAgentMode } from '../agentMode';
import { getSkillsConfig, saveSkillsConfig } from '../skillsConfig';
import { importSkillFolder, listCollections, listTopicsForUI, removeUserCollection } from '../tools/impl/skill';
import { getStructuredGlobalMemory, setStructuredGlobalMemory } from '../db';
import { exportMemoryToMarkdown, importMemoryFromMarkdown } from '../memory/memoryExport';
import { persistAppConfig } from '../config/runtimeConfig';
import { dialogParentWindow } from '../mainWindow';

export function registerSettingsIpc(): void {
  // ── LLM ──────────────────────────────────────────────────
  ipcMain.handle('settings:get', () => ({
    activeProvider: aiConfig.activeProvider,
    contextWindowRounds: aiConfig.contextWindowRounds,
    providers: aiConfig.providers,
    deletedProviders: aiConfig.deletedProviders ?? [],
  }));

  ipcMain.handle('settings:save', (_e, next: typeof aiConfig) => {
    aiConfig.activeProvider = next.activeProvider;
    aiConfig.contextWindowRounds = next.contextWindowRounds;
    aiConfig.providers = next.providers; // 完全替换
    aiConfig.deletedProviders = next.deletedProviders ?? [];
    persistAppConfig();
  });

  // ── Agent 模式 ───────────────────────────────────────────
  ipcMain.handle('agent:get-mode', () => getAgentMode());
  ipcMain.handle('agent:set-mode', (_e, mode: string) => {
    setAgentMode(mode);
    console.log(`[IPC] Agent 模式切换为: ${mode}`);
  });

  // ── Skills ───────────────────────────────────────────────
  ipcMain.handle('skills:get-config', () => getSkillsConfig());
  ipcMain.handle('skills:save-config', (_e, cfg: ReturnType<typeof getSkillsConfig>) => {
    saveSkillsConfig(cfg);
    persistAppConfig();
  });

  /** 所有可用 skill：{ name, summary, collection, skillKey }[]，skillKey 用于 disabledSkills */
  ipcMain.handle('skills:list', () => listTopicsForUI());

  /** 所有集合的元信息 { id, displayName, description }[]；dirPath 仅主进程内部使用，剥掉后再发给渲染进程 */
  ipcMain.handle('skills:list-collections', () => listCollections().map(({ dirPath: _dirPath, ...rest }) => rest));

  /** 选择文件夹导入到 USER_SKILLS_DIR，自动识别是单个 skill 还是集合 */
  ipcMain.handle('skills:import-folder', async () => {
    const result = await dialog.showOpenDialog(dialogParentWindow(), {
      title: '选择要导入的 Skill 文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true, message: '已取消' };
    }
    return importSkillFolder(result.filePaths[0]);
  });

  /** 删除用户导入的集合目录（只允许删 USER_SKILLS_DIR 下的子目录，'skills' 根集合不可删） */
  ipcMain.handle('skills:remove-collection', (_e, collId: string) => removeUserCollection(collId));

  // ── 全局记忆导入导出 ─────────────────────────────────────
  ipcMain.handle('memory:export', () => exportMemoryToMarkdown(getStructuredGlobalMemory()));
  ipcMain.handle('memory:import', async () => {
    const result = await importMemoryFromMarkdown();
    if (result.success && result.content) setStructuredGlobalMemory(result.content);
    return result;
  });
}
