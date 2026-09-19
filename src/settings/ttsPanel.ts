/** 语音合成设置：TTS 方案、总开关（打开时自动部署本地服务）、健康检查、Genie 音色导入 */

import type { TTSConfig } from '../../shared/types/config';
import { BUILTIN_TTS_PROVIDERS } from './types';
import { clearSettingsDirty, markSettingsDirty, registerSection } from './sections';
import { bindPasswordToggle, button, input, runWithButton, select } from './dom';
import { showUnsavedSettingsDialog } from './dialog';

let ttsCfg: TTSConfig | null = null;
let ttsEditKey: string | null = null;
/** 自己保存触发的 onConfigChanged 广播要跳过，否则重载会让编辑位置跳回 */
let savingFromUI = false;

const LOCAL_ENGINE_HINTS: Record<string, string> = {
  'edge-tts': '打开上方「语音播报」开关即可自动部署免费的 edge-tts 本地服务（自动准备 uv 与 Python，无需手动安装）',
  'moss-tts-nano': '打开上方「语音播报」开关即可自动部署 MOSS-TTS-Nano 本地离线语音合成（约 2GB 磁盘）',
  'genie-tts': '打开上方「语音播报」开关即可自动部署 Genie-TTS 本地语音合成，菲比音色（约 1.5GB 磁盘，首次安装耗时较长）',
};

function setRuntimeStatus(dotClass: string, message: string): void {
  const dot = document.getElementById('tts-runtime-dot');
  const text = document.getElementById('tts-runtime-text');
  if (dot) dot.className = `s-status-dot ${dotClass}`;
  if (text) text.textContent = message;
}

function setRuntimePending(message: string): void {
  setRuntimeStatus('s-status-pending', message);
}

/** 显示 TTS 实际运行状态（与开关的"配置已启用"区分开） */
async function refreshRuntimeStatus(): Promise<void> {
  if (!document.getElementById('tts-runtime-dot')) return;
  try {
    const enabled = window.ttsAPI ? await window.ttsAPI.isEnabled() : false;
    if (!enabled) {
      setRuntimeStatus('s-status-err', '⚠️ 未启用');
      return;
    }
    const health = window.ttsAPI ? await window.ttsAPI.health() : { ok: false };
    if (health.ok) setRuntimeStatus('s-status-on', '✓ 已启用（语音将在回复后自动播放）');
    else setRuntimeStatus('s-status-err', '⚠️ 服务不可达（请检查服务地址或启动本地服务）');
  } catch {
    setRuntimeStatus('s-status-off', '无法获取状态');
  }
}

/** 清空并显示本地服务日志框，订阅主进程推来的安装/启动日志；返回取消订阅函数 */
function followLocalLog(): { append(text: string): void; stop(): void } {
  const log = document.getElementById('tts-local-log');
  const append = (text: string) => {
    if (!log) return;
    log.textContent += text;
    log.scrollTop = log.scrollHeight;
  };
  if (log) {
    log.style.display = 'block';
    log.textContent = '';
  }
  const unsubscribe = window.ttsLocalAPI?.onLog?.((msg: string) => append(msg + '\n'));
  return { append, stop: () => unsubscribe?.() };
}

function syncFormToCfg(): void {
  if (!ttsCfg || !ttsEditKey || !ttsCfg.providers[ttsEditKey]) return;
  const p = ttsCfg.providers[ttsEditKey];
  p.name = input('tts-name').value.trim() || p.name;
  p.baseUrl = input('tts-url').value.trim();
  p.apiKey = input('tts-apikey').value.trim();
  p.language = select('tts-language').value;
  // preset 模式从下拉框取音色，text 模式从文本框取
  p.speaker = p.speakerMode === 'preset' ? select('tts-speaker-select').value : input('tts-speaker').value.trim();
}

function renderProviderSelect(): void {
  if (!ttsCfg) return;
  const sel = document.getElementById('tts-provider-select') as HTMLSelectElement | null;
  if (!sel) return;
  sel.innerHTML = '';
  for (const [key, prov] of Object.entries(ttsCfg.providers)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = (prov.name || key) + (key === ttsCfg.activeProvider ? ' (当前使用)' : '');
    option.selected = key === ttsEditKey;
    sel.appendChild(option);
  }
  sel.onchange = () => {
    syncFormToCfg();
    ttsEditKey = sel.value;
    renderProviderSelect();
    renderForm();
  };
}

function renderForm(): void {
  if (!ttsCfg || !ttsEditKey) return;
  const p = ttsCfg.providers[ttsEditKey];
  if (!p) return;

  input('tts-name').value = p.name ?? '';
  input('tts-url').value = p.baseUrl ?? '';
  input('tts-apikey').value = p.apiKey ?? '';
  select('tts-language').value = p.language ?? 'Auto';

  // 内置方案：name / url / apiKey 只读（由代码控制）
  const isBuiltin = BUILTIN_TTS_PROVIDERS.includes(ttsEditKey);
  for (const id of ['tts-name', 'tts-url', 'tts-apikey']) input(id).readOnly = isBuiltin;

  // 音色：preset 模式显示下拉，text 模式显示文本框
  const speakerInput = input('tts-speaker');
  const speakerSelect = select('tts-speaker-select');
  const usePresets = p.speakerMode === 'preset' && Boolean(p.voicePresets?.length);
  speakerInput.style.display = usePresets ? 'none' : '';
  speakerSelect.style.display = usePresets ? '' : 'none';
  if (usePresets) {
    speakerSelect.innerHTML = '';
    for (const preset of p.voicePresets!) {
      const opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = `${preset.name}（${preset.description}）`;
      opt.selected = preset.id === p.speaker;
      speakerSelect.appendChild(opt);
    }
  } else {
    speakerInput.value = p.speaker ?? '';
  }

  const genieImportBtn = document.getElementById('tts-genie-import-btn');
  if (genieImportBtn) genieImportBtn.style.display = ttsEditKey === 'local_genie_tts' ? '' : 'none';

  // 内置方案或只有一个 provider 时隐藏删除按钮
  const hideDelete = isBuiltin || Object.keys(ttsCfg.providers).length <= 1;
  button('tts-del-btn').style.visibility = hideDelete ? 'hidden' : 'visible';

  // 本地服务区域：仅本地方案显示
  const localSection = document.getElementById('tts-local-section');
  if (localSection) {
    localSection.style.display = p.isLocal ? '' : 'none';
    const hint = document.getElementById('tts-local-hint');
    if (hint) hint.textContent = LOCAL_ENGINE_HINTS[p.localEngine || 'edge-tts'] ?? LOCAL_ENGINE_HINTS['edge-tts'];
  }
}

async function load(): Promise<void> {
  if (!window.ttsSettingsAPI || savingFromUI) return;
  ttsCfg = await window.ttsSettingsAPI.get();
  // 如果当前正在编辑的 provider 仍存在，保留编辑位置
  if (!ttsEditKey || !ttsCfg.providers[ttsEditKey]) ttsEditKey = ttsCfg.activeProvider;

  // 开关反映配置里保存的 enabled，状态点单独显示实际运行状态
  input('tts-enabled').checked = ttsCfg.enabled;
  await refreshRuntimeStatus();
  renderProviderSelect();
  renderForm();
}

async function save(): Promise<void> {
  const api = window.ttsSettingsAPI;
  const cfg = ttsCfg;
  if (!api || !cfg) return;
  syncFormToCfg();
  // 下拉框当前选中的即为活跃 provider
  if (ttsEditKey) cfg.activeProvider = ttsEditKey;
  cfg.enabled = input('tts-enabled').checked;
  const provider = cfg.providers[cfg.activeProvider];
  const log = cfg.enabled && provider?.isLocal ? followLocalLog() : undefined;
  if (log) setRuntimePending(`正在应用 ${provider?.name ?? 'TTS'}...`);

  savingFromUI = true;
  try {
    await runWithButton(button('tts-save-btn'), { busy: '保存中…', done: '✓ 已保存', failed: '保存失败' }, async () => {
      await api.save(cfg);
      clearSettingsDirty('tts');
      void refreshRuntimeStatus();
      renderProviderSelect();
    });
  } finally {
    log?.stop();
    // 延迟重置，确保广播回调已被跳过
    setTimeout(() => { savingFromUI = false; }, 500);
  }
}

function addProvider(): void {
  if (!ttsCfg) return;
  syncFormToCfg();
  const key = `tts_${Date.now()}`;
  ttsCfg.providers[key] = { type: 'http-tts', name: '新 TTS 服务', baseUrl: '', apiKey: '', speaker: '', language: 'Auto' };
  ttsEditKey = key;
  renderProviderSelect();
  renderForm();
}

function deleteProvider(): void {
  if (!ttsCfg || !ttsEditKey || Object.keys(ttsCfg.providers).length <= 1) return;
  if (BUILTIN_TTS_PROVIDERS.includes(ttsEditKey)) {
    alert('内置 TTS 方案不允许删除');
    return;
  }
  if (ttsEditKey === ttsCfg.activeProvider) {
    ttsCfg.activeProvider = Object.keys(ttsCfg.providers).filter((k) => k !== ttsEditKey)[0];
  }
  ttsCfg.deletedProviders = [...(ttsCfg.deletedProviders ?? []), ttsEditKey];
  delete ttsCfg.providers[ttsEditKey];
  ttsEditKey = ttsCfg.activeProvider;
  void save();
}

async function runHealthCheck(): Promise<void> {
  if (!window.ttsSettingsAPI) return;
  const dot = document.getElementById('tts-status-dot') as HTMLElement;
  const text = document.getElementById('tts-status-text') as HTMLElement;
  const btn = button('tts-test-btn');

  btn.disabled = true;
  btn.textContent = '测试中…';
  dot.className = 's-status-dot s-status-off';
  text.textContent = '连接中…';
  try {
    const result = await window.ttsSettingsAPI.test(input('tts-url').value.trim());
    dot.className = `s-status-dot ${result.ok ? 's-status-on' : 's-status-err'}`;
    text.textContent = result.ok ? `✓ 连接成功（HTTP ${result.status}）` : result.error ?? `✗ HTTP ${result.status}`;
  } catch (e) {
    dot.className = 's-status-dot s-status-err';
    text.textContent = `✗ ${String(e)}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 测试连接';
  }
}

async function importGenieVoice(): Promise<void> {
  const api = window.ttsLocalAPI;
  if (!api || !ttsCfg) return;
  syncFormToCfg();
  const provider = ttsCfg.providers['local_genie_tts'];
  if (!provider) return;

  const btn = document.getElementById('tts-genie-import-btn') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '导入中...';
  }
  const log = followLocalLog();
  setRuntimePending('正在导入 Genie 音色...');

  try {
    const result = await api.importGenieVoice();
    if (result.canceled) return;
    const voice = result.voice;
    if (!result.ok || !voice) {
      log.append(`\n导入失败：${result.detail}\n`);
      setRuntimePending('Genie 音色导入失败');
      return;
    }
    provider.voicePresets = [...(provider.voicePresets ?? []).filter((v) => v.id !== voice.id), voice];
    provider.speakerMode = 'preset';
    provider.speaker = voice.id;
    ttsEditKey = 'local_genie_tts';
    ttsCfg.activeProvider = 'local_genie_tts';
    renderProviderSelect();
    renderForm();
    markSettingsDirty('tts');
    await save();
  } catch (e) {
    log.append(`\n导入失败：${String(e)}\n`);
    setRuntimePending('Genie 音色导入失败');
    console.error('[Genie voice import]', e);
  } finally {
    log.stop();
    if (btn) {
      btn.disabled = false;
      btn.textContent = '导入 Genie 音色';
    }
    void refreshRuntimeStatus();
  }
}

/** 打开开关：本地方案先安装并启动服务（失败则开关退回关闭），然后保存 */
async function enableFromToggle(): Promise<void> {
  const toggle = input('tts-enabled');
  if (!ttsCfg || !ttsEditKey) return;
  syncFormToCfg();
  ttsCfg.activeProvider = ttsEditKey;
  const provider = ttsCfg.providers[ttsCfg.activeProvider];

  toggle.disabled = true;
  try {
    if (provider?.isLocal) {
      const api = window.ttsLocalAPI;
      if (!api) throw new Error('TTS local API is unavailable');
      setRuntimePending(`正在安装/启动 ${provider.name}...`);
      const log = followLocalLog();
      try {
        const result = await api.installAndStart(provider.localEngine);
        log.append(`\n${result.ok ? '✅' : '❌'} ${result.detail}`);
        if (!result.ok) throw new Error(result.detail);
      } finally {
        log.stop();
      }
    } else {
      setRuntimePending(`正在启用 ${provider?.name ?? '语音服务'}...`);
    }
    toggle.checked = true;
    ttsCfg.enabled = true;
    await save();
  } catch (e) {
    console.error('[TTS toggle enable]', e);
    toggle.checked = false;
    ttsCfg.enabled = false;
    await save();
  } finally {
    toggle.disabled = false;
    void refreshRuntimeStatus();
  }
}

/** 关闭开关：会连带关闭依赖 TTS 的微信语音回复，先征得确认；本地服务一并停止 */
async function disableFromToggle(): Promise<void> {
  const toggle = input('tts-enabled');
  if (!ttsCfg || !ttsEditKey) return;

  const wechatConfig = await window.wechatAPI?.get().catch(() => null);
  if (wechatConfig?.voiceRepliesEnabled) {
    const action = await showUnsavedSettingsDialog({
      body: '关闭 TTS 引擎会同时关闭微信语音回复。要继续关闭吗？',
      saveText: '关闭',
      discardText: '取消',
    });
    if (action !== 'save') {
      toggle.checked = true;
      return;
    }
  }

  syncFormToCfg();
  const provider = ttsCfg.providers[ttsCfg.activeProvider] ?? ttsCfg.providers[ttsEditKey];
  toggle.disabled = true;
  try {
    toggle.checked = false;
    ttsCfg.enabled = false;
    await save();
    if (provider?.isLocal) await window.ttsLocalAPI?.stop(provider.localEngine);
  } catch (e) {
    console.error('[TTS toggle disable]', e);
  } finally {
    toggle.disabled = false;
    void refreshRuntimeStatus();
  }
}

export function initTTSPanel(): void {
  registerSection('tts', { load, save });
  document.getElementById('tts-save-btn')?.addEventListener('click', () => void save());
  document.getElementById('tts-enabled')?.addEventListener('change', () => {
    void (input('tts-enabled').checked ? enableFromToggle() : disableFromToggle());
  });
  document.getElementById('tts-test-btn')?.addEventListener('click', () => void runHealthCheck());
  document.getElementById('tts-add-btn')?.addEventListener('click', addProvider);
  document.getElementById('tts-del-btn')?.addEventListener('click', deleteProvider);
  document.getElementById('tts-genie-import-btn')?.addEventListener('click', () => void importGenieVoice());
  bindPasswordToggle('tts-apikey', 'tts-eye-btn');
  // Agent 或主进程改了 TTS 配置时刷新界面
  window.ttsSettingsAPI?.onConfigChanged?.(() => void load());
}
