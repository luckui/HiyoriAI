/**
 * 主窗口：创建、置顶、拖动、缩放，以及每帧推送光标位置（Live2D 目光追踪）。
 */

import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'path';
import { setToolEventListener } from '../aiService';
import { initLive2DBridge } from '../live2dBridge';
import { getMainWindow, sendToRenderer, setMainWindow } from '../mainWindow';

/** 窗口应有的尺寸：拖动时每次都用它还原尺寸（见 window-drag），由 window-resize 更新 */
let windowSize = { width: 360, height: 620 };
let pinned = true;

export function createMainWindow(): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    ...windowSize,
    x: width - 380,
    y: height - 640,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    },
  });
  setMainWindow(win);
  initLive2DBridge(win);

  // 启动时用 screen-saver 层级，确保盖过全屏应用和其他 alwaysOnTop 窗口
  win.setAlwaysOnTop(pinned, 'screen-saver');

  // 工具调用调试事件：AI 每次调用工具时实时推送给渲染层
  setToolEventListener((ev) => sendToRenderer('tool-call-log', ev));

  // 全屏光标追踪：每帧推送光标屏幕坐标给渲染层，用于 Live2D 目光追踪
  const cursorInterval = setInterval(() => {
    sendToRenderer('cursor-position', screen.getCursorScreenPoint());
  }, 16); // ~60fps

  win.on('closed', () => {
    clearInterval(cursorInterval);
    setToolEventListener(null);
    setMainWindow(null);
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

export function registerWindowIpc(): void {
  ipcMain.on('window-pin', () => {
    const win = getMainWindow();
    if (!win) return;
    pinned = !pinned;
    if (pinned) win.setAlwaysOnTop(true, 'screen-saver');
    else win.setAlwaysOnTop(false);
    win.webContents.send('window-pin-state', pinned);
  });

  // Windows 小数缩放（如 125%）下，setPosition 每次都会因逻辑像素 ↔ 物理像素取整把窗口撑大约 1px；
  // 拖动时每秒调用几十次，窗口就会越拖越大。因此改用 setBounds，每次都带上应有的尺寸。
  ipcMain.on('window-drag', (_e, { deltaX, deltaY }: { deltaX: number; deltaY: number }) => {
    const win = getMainWindow();
    if (!win) return;
    const [x, y] = win.getPosition();
    win.setBounds({ x: x + deltaX, y: y + deltaY, ...windowSize });
  });

  ipcMain.on('window-close', () => app.quit());

  ipcMain.on('window-resize', (_e, { width, height }: { width: number; height: number }) => {
    windowSize = { width, height };
    const win = getMainWindow();
    if (!win) return;
    const bounds = win.getBounds();
    const { height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    // 钳位 y：确保窗口扩展后不超出屏幕底部（保留 6px 间距）
    const clampedY = Math.min(bounds.y, screenH - height - 6);
    win.setBounds({ x: bounds.x, y: Math.max(0, clampedY), width, height });
  });
}
