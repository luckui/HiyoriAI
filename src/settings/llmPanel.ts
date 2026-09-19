/** LLM 服务商设置：多个 provider 的增删改与"当前使用" */

import { BUILTIN_LLM_PROVIDERS, type RuntimeConfig } from './types';
import { clearSettingsDirty, markSettingsDirty, registerSection } from './sections';
import { bindPasswordToggle, button, input } from './dom';

let cfg: RuntimeConfig | null = null;
/** 当前表单正在编辑的 provider key */
let editKey: string | null = null;

function syncFormToCfg(): void {
  if (!cfg || !editKey || !cfg.providers[editKey]) return;
  const p = cfg.providers[editKey];
  p.name = input('s-name').value.trim() || p.name;
  p.baseUrl = input('s-baseUrl').value.trim();
  p.apiKey = input('s-apiKey').value.trim();
  p.model = input('s-model').value.trim();
  p.temperature = parseFloat(input('s-temp').value) || 0.85;
  p.maxTokens = parseInt(input('s-tokens').value, 10) || 1024;
  const rounds = parseInt(input('s-rounds').value, 10);
  if (rounds > 0) cfg.contextWindowRounds = rounds;
}

function renderForm(): void {
  if (!cfg || !editKey) return;
  const p = cfg.providers[editKey];
  if (!p) return;

  input('s-name').value = p.name ?? '';
  input('s-baseUrl').value = p.baseUrl ?? '';
  input('s-apiKey').value = p.apiKey ?? '';
  input('s-model').value = p.model ?? '';
  input('s-temp').value = String(p.temperature ?? 0.85);
  input('s-tokens').value = String(p.maxTokens ?? 1024);
  // 内置方案或只有一个 provider 时隐藏删除按钮
  const hideDelete = BUILTIN_LLM_PROVIDERS.includes(editKey) || Object.keys(cfg.providers).length <= 1;
  button('s-del-btn').style.visibility = hideDelete ? 'hidden' : 'visible';
}

function renderProviderSelect(): void {
  if (!cfg) return;
  const sel = document.getElementById('s-provider-select') as HTMLSelectElement | null;
  if (!sel) return;
  sel.innerHTML = '';
  for (const [key, prov] of Object.entries(cfg.providers)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = (prov.name || key) + (key === cfg.activeProvider ? ' (当前使用)' : '');
    option.selected = key === editKey;
    sel.appendChild(option);
  }
  sel.onchange = () => {
    syncFormToCfg();
    markSettingsDirty('llm');
    editKey = sel.value;
    renderProviderSelect();
    renderForm();
  };
}

async function load(): Promise<void> {
  cfg = await window.settingsAPI!.get();
  editKey = cfg.activeProvider;
  input('s-rounds').value = String(cfg.contextWindowRounds);
  renderProviderSelect();
  renderForm();
}

async function save(): Promise<void> {
  if (!cfg) return;
  syncFormToCfg();
  // 下拉框当前选中的即为活跃 provider
  if (editKey) cfg.activeProvider = editKey;
  await window.settingsAPI!.save(cfg);
  clearSettingsDirty('llm');

  const btn = button('settings-save-btn');
  btn.textContent = '✓ 已保存';
  btn.classList.add('saved');
  setTimeout(() => {
    btn.textContent = '保存设置';
    btn.classList.remove('saved');
  }, 1800);
  renderProviderSelect(); // 刷新"当前使用"标记
}

function addProvider(): void {
  if (!cfg) return;
  syncFormToCfg();
  const key = `provider_${Date.now()}`;
  cfg.providers[key] = {
    type: 'openai-compatible',
    name: '新服务商',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.85,
    maxTokens: 1024,
  };
  editKey = key;
  renderProviderSelect();
  renderForm();
  document.getElementById('s-form-section')?.scrollIntoView({ behavior: 'smooth' });
}

function deleteProvider(): void {
  if (!cfg || !editKey || Object.keys(cfg.providers).length <= 1) return;
  if (BUILTIN_LLM_PROVIDERS.includes(editKey)) {
    alert('内置 LLM 方案不允许删除');
    return;
  }
  if (editKey === cfg.activeProvider) {
    cfg.activeProvider = Object.keys(cfg.providers).filter((k) => k !== editKey)[0];
  }
  // 记录删除，保证重启后代码默认 provider 里同名的不会被重新补入
  cfg.deletedProviders = [...(cfg.deletedProviders ?? []), editKey];
  delete cfg.providers[editKey];
  editKey = cfg.activeProvider;
  renderProviderSelect();
  renderForm();
  // 立即持久化，不依赖用户手动点保存
  void save();
}

export function initLlmPanel(): void {
  registerSection('llm', { load, save });
  document.getElementById('s-add-btn')?.addEventListener('click', addProvider);
  document.getElementById('s-del-btn')?.addEventListener('click', deleteProvider);
  document.getElementById('settings-save-btn')?.addEventListener('click', () => void save());
  bindPasswordToggle('s-apiKey', 's-eye-btn');
}
