/**
 * 设置面板入口：打开/关闭（含未保存修改的确认）与各分区初始化。
 *
 * 分区各自一个文件，并通过 sections.ts 登记 load / save：
 *   llmPanel  ttsPanel  bridgePanels（Discord / 飞书 / 微信）  skillsPanel  memoryPanel
 */

import { clearSettingsDirty, hasUnsavedSettings, loadAllSections, markSettingsDirty, saveDirtySections, type SettingsSection } from './sections';
import { showUnsavedSettingsDialog } from './dialog';
import { initTabs } from './tabs';
import { initLlmPanel } from './llmPanel';
import { initTTSPanel } from './ttsPanel';
import { initBridgePanels } from './bridgePanels';
import { initSkillsPanel } from './skillsPanel';
import { initMemoryPanel } from './memoryPanel';

/** 打开设置前的窗口尺寸，关闭时恢复 */
let savedWindowWidth = 0;
let savedWindowHeight = 0;
/** 设置面板需要的最小窗口高度 */
const SETTINGS_MIN_HEIGHT = 620;

function openSettings(): void {
  clearSettingsDirty();
  savedWindowWidth = window.innerWidth;
  savedWindowHeight = window.innerHeight;
  if (savedWindowHeight < SETTINGS_MIN_HEIGHT) {
    window.electronAPI?.resizeWindow(savedWindowWidth, SETTINGS_MIN_HEIGHT);
  }
  // 暂停 canvas 区域的拖拽捕获，否则设置面板上半部分的点击会被系统当成拖动窗口
  document.getElementById('canvas-container')?.classList.add('drag-region-suspended');
  document.getElementById('settings-panel')?.classList.add('visible');
  void loadAllSections();
}

function closeSettingsNow(): void {
  document.getElementById('settings-panel')?.classList.remove('visible');
  document.getElementById('canvas-container')?.classList.remove('drag-region-suspended');
  if (savedWindowHeight > 0 && savedWindowHeight < SETTINGS_MIN_HEIGHT) {
    window.electronAPI?.resizeWindow(savedWindowWidth, savedWindowHeight);
  }
  savedWindowWidth = 0;
  savedWindowHeight = 0;
  clearSettingsDirty();
}

async function closeSettings(): Promise<void> {
  if (hasUnsavedSettings()) {
    const action = await showUnsavedSettingsDialog({ body: '离开设置前，要保存刚才的修改吗？', saveText: '保存并离开' });
    if (action === 'save') await saveDirtySections();
    else await loadAllSections();
  }
  closeSettingsNow();
}

/** 表单里任何输入都把所在分区标记为未保存（Skills 分区是动态生成的，自己标记） */
function bindDirtyTracking(): void {
  const containers: Array<[string, Exclude<SettingsSection, 'skills'>]> = [
    ['#s-tab-llm', 'llm'],
    ['#s-tab-tts', 'tts'],
    ['#s-bridge-discord', 'discord'],
    ['#s-bridge-feishu', 'feishu'],
    ['#s-bridge-wechat', 'wechat'],
  ];
  for (const [container, section] of containers) {
    document.querySelectorAll(`${container} input, ${container} select, ${container} textarea`).forEach((el) => {
      el.addEventListener('input', () => markSettingsDirty(section));
      el.addEventListener('change', () => markSettingsDirty(section));
    });
  }
}

export function initSettings(): void {
  document.getElementById('settings-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openSettings();
  });
  document.getElementById('settings-back')?.addEventListener('click', () => void closeSettings());

  initLlmPanel();
  initTTSPanel();
  initBridgePanels();
  initSkillsPanel();
  initMemoryPanel();
  initTabs();
  bindDirtyTracking();

  // 防止面板内的输入框触发窗口拖动
  document.querySelectorAll('#settings-panel input, #settings-panel textarea').forEach((el) => {
    el.addEventListener('mousedown', (e) => e.stopPropagation());
  });
}
