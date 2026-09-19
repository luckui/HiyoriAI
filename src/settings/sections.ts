/**
 * 设置面板的"分区"注册表与未保存状态。
 *
 * 每个分区（LLM / TTS / 各平台 / Skills）登记自己的 load 与 save；
 * 打开设置、放弃修改后重载、离开前保存，都遍历注册表，新增分区只需 registerSection 一次。
 */

export type SettingsSection = 'llm' | 'tts' | 'discord' | 'feishu' | 'wechat' | 'skills';

export interface SectionHandlers {
  /** 从主进程读取已保存的配置并填入表单 */
  load(): Promise<void>;
  /** 把表单内容保存到主进程 */
  save(): Promise<void>;
}

const sections = new Map<SettingsSection, SectionHandlers>();
const dirty = new Set<SettingsSection>();
/** 加载配置时表单会被程序填值，这期间的 input/change 不算用户修改 */
let loading = false;

export function registerSection(id: SettingsSection, handlers: SectionHandlers): void {
  sections.set(id, handlers);
}

export function markSettingsDirty(section: SettingsSection): void {
  if (loading) return;
  dirty.add(section);
  updateUnsavedState();
}

export function clearSettingsDirty(section?: SettingsSection): void {
  if (section) dirty.delete(section);
  else dirty.clear();
  updateUnsavedState();
}

export function hasUnsavedSettings(): boolean {
  return dirty.size > 0;
}

function updateUnsavedState(): void {
  document.getElementById('settings-panel')?.classList.toggle('settings-dirty', hasUnsavedSettings());
}

/** 重新加载所有分区的已保存配置，并清空未保存标记 */
export async function loadAllSections(): Promise<void> {
  loading = true;
  try {
    await Promise.all([...sections.values()].map((section) => section.load()));
  } finally {
    loading = false;
    clearSettingsDirty();
  }
}

/** 只保存有未保存修改的分区 */
export async function saveDirtySections(): Promise<void> {
  for (const id of [...dirty]) {
    await sections.get(id)?.save();
  }
}
