/**
 * 主窗口引用与向渲染层推送消息。
 *
 * 其他模块不直接持有 BrowserWindow：窗口可能尚未创建或已销毁，
 * 统一通过 sendToRenderer / broadcastToWindows 发送，内部做存活检查。
 */

import { BrowserWindow } from 'electron';

let mainWindow: BrowserWindow | null = null;

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

/** 主窗口仍然可用时返回它，否则返回 null */
export function getMainWindow(): BrowserWindow | null {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return null;
  return mainWindow;
}

/** 发给主窗口；窗口不可用时静默丢弃，返回是否已发送 */
export function sendToRenderer(channel: string, ...args: unknown[]): boolean {
  const win = getMainWindow();
  if (!win) return false;
  win.webContents.send(channel, ...args);
  return true;
}

/** 发给所有窗口（设置变更等需要所有界面同步的事件） */
export function broadcastToWindows(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

/** 打开对话框时的父窗口：优先当前聚焦窗口 */
export function dialogParentWindow(): BrowserWindow {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}
