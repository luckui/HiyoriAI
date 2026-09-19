/**
 * Live2D 形象：模型导入、选择、删除，以及 hiyori-avatar:// 协议（渲染层按它加载模型文件）。
 */

import { dialog, ipcMain, net, protocol } from 'electron';
import { pathToFileURL } from 'url';
import type { AvatarConfig } from '../avatar/avatarConfig';
import {
  cloneAvatarConfig,
  deleteAvatarModel,
  importAvatarModelFolder,
  modelBaseUrl,
  resolveAvatarProtocolPath,
  selectAvatarModel,
} from '../avatar/avatarManager';
import { builtinAvatarModelDir, getAvatarConfig, persistAppConfig, setAvatarConfig } from '../config/runtimeConfig';
import { broadcastToWindows, dialogParentWindow } from '../mainWindow';

/** 需在 app ready 之前调用 */
export function registerAvatarScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'hiyori-avatar', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/** 需在 app ready 之后调用 */
export function registerAvatarProtocol(): void {
  protocol.handle('hiyori-avatar', (request) => {
    const filePath = resolveAvatarProtocolPath(new URL(request.url), undefined, builtinAvatarModelDir());
    if (!filePath) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

/** 更新形象配置、持久化并通知所有窗口，返回给渲染层的副本 */
function commitAvatarConfig(next: AvatarConfig): AvatarConfig {
  setAvatarConfig(next);
  persistAppConfig();
  broadcastToWindows('avatar:config-changed', getAvatarConfig());
  return cloneAvatarConfig(getAvatarConfig());
}

export function registerAvatarIpc(): void {
  ipcMain.handle('avatar:get', () => cloneAvatarConfig(getAvatarConfig()));

  ipcMain.handle('avatar:import-folder', async () => {
    const result = await dialog.showOpenDialog(dialogParentWindow(), {
      title: '选择 Live2D 模型文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true, detail: '已取消' };
    }
    const imported = importAvatarModelFolder(result.filePaths[0], getAvatarConfig());
    return {
      ok: true,
      config: commitAvatarConfig(imported.config),
      profile: imported.profile,
      baseUrl: modelBaseUrl(imported.profile.id),
    };
  });

  ipcMain.handle('avatar:save', (_e, cfg: AvatarConfig) => commitAvatarConfig(cfg));
  ipcMain.handle('avatar:select', (_e, modelId: string) => commitAvatarConfig(selectAvatarModel(getAvatarConfig(), modelId)));
  ipcMain.handle('avatar:delete', (_e, modelId: string) => commitAvatarConfig(deleteAvatarModel(getAvatarConfig(), modelId)));
}
