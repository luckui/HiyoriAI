// =====================================================
// LLM 服务商设置面板
// =====================================================

interface ProviderConfig {
  type: 'openai-compatible';
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

interface RuntimeConfig {
  activeProvider: string;
  contextWindowRounds: number;
  providers: Record<string, ProviderConfig>;
  /** 用户主动删除的 provider key，用于 loadPersistedConfig 合并时跳过 */
  deletedProviders?: string[];
}

interface DiscordConfig {
  enabled: boolean;
  token: string;
  allowedChannels: string;
  proxyUrl: string;
}

interface WeChatConfig {
  enabled: boolean;
  token?: string;
  accountId?: string;
  baseUrl?: string;
  sendChunkDelay?: number;
}

interface VoicePresetItem {
  id: string;
  name: string;
  description: string;
  refAudioFile?: string;
}

interface TTSProviderConfig {
  type: 'http-tts';
  name: string;
  baseUrl: string;
  apiKey: string;
  speaker: string;
  language: string;
  isLocal?: boolean;
  localEngine?: string;
  speakerMode?: 'text' | 'preset';
  voicePresets?: VoicePresetItem[];
}

interface TTSConfig {
  enabled: boolean;
  activeProvider: string;
  providers: Record<string, TTSProviderConfig>;
  deletedProviders?: string[];
}

/** 内置 TTS 方案，不允许删除 */
const BUILTIN_TTS_PROVIDERS = ['local_edge_tts', 'local_moss_nano', 'local_genie_tts'];

/** 内置 LLM 方案，不允许删除 */
const BUILTIN_LLM_PROVIDERS = ['doubao', 'qwen35'];

interface MemoryExportResult {
  success: boolean;
  path?: string;
  error?: string;
}

interface MemoryImportResult {
  success: boolean;
  content?: string;
  error?: string;
}

// ── Skills 配置类型（与 electron/skillsConfig.ts 保持一致） ──────────────────

type SkillListingMode = 'none' | 'names' | 'short' | 'full';

interface SkillsConfig {
  enabled: boolean;
  listingMode: SkillListingMode;
  disabledCollections: string[];
  disabledSkills: string[];
  collectionModes: Record<string, SkillListingMode>;
}

interface SkillEntry {
  name: string;
  summary: string;
  collection: string;
  skillKey: string;
}

/** 集合元信息（从 _collection.json 动态读取，无硬编码） */
interface CollectionInfo {
  id: string;
  displayName: string;
  description: string;
}

declare global {
  interface Window {
    settingsAPI?: {
      get(): Promise<RuntimeConfig>;
      save(cfg: RuntimeConfig): Promise<void>;
    };
    discordAPI?: {
      get(): Promise<DiscordConfig>;
      save(cfg: DiscordConfig): Promise<void>;
      getStatus(): Promise<'online' | 'offline'>;
    };
    wechatAPI?: {
      get(): Promise<WeChatConfig>;
      save(cfg: WeChatConfig): Promise<void>;
      getStatus(): Promise<'online' | 'offline'>;
      startQRLogin(): Promise<{ success: boolean; credentials?: any; error?: string }>;
      onQRLoginUpdate(cb: (state: any) => void): void;
    };
    ttsSettingsAPI?: {
      get(): Promise<TTSConfig>;
      save(cfg: TTSConfig): Promise<{ isEnabled: boolean; fileSaved: boolean; debug: Record<string, unknown> }>;
      test(url: string): Promise<{ ok: boolean; status?: number; body?: string; error?: string }>;
      onConfigChanged?(cb: () => void): void;
    };
    ttsLocalAPI?: {
      status(engine?: string): Promise<{ installed: boolean; running: boolean; healthy: boolean; pid: number | null; port: number; serverDir: string; engine: string }>;
      installAndStart(engine?: string): Promise<{ ok: boolean; detail: string; logs?: string[] }>;
      start(engine?: string): Promise<{ ok: boolean; detail: string }>;
      stop(engine?: string): Promise<{ ok: boolean; detail: string }>;
      onLog(cb: (msg: string) => void): () => void;
    };
    memoryAPI?: {
      export(): Promise<MemoryExportResult>;
      import(): Promise<MemoryImportResult>;
    };
    skillsAPI?: {
      /** 读取当前 Skills 配置 */
      getConfig(): Promise<SkillsConfig>;
      /** 保存 Skills 配置 */
      saveConfig(cfg: SkillsConfig): Promise<void>;
      /** 列出所有可用 skill（含 collection / skillKey），供 UI 展示和选择 */
      listAll(): Promise<SkillEntry[]>;
      /** 列出所有集合元信息（id / displayName / description），从 _collection.json 动态读取 */
      listCollections(): Promise<CollectionInfo[]>;
    };
  }
}

// ── 状态 ──────────────────────────────────────────────

let cfg: RuntimeConfig | null = null;
/** 当前表单正在编辑的 provider key */
let editKey: string | null = null;
/** 打开设置前的窗口宽度，关闭时恢复 */
let savedWindowWidth = 0;
/** 打开设置前的窗口高度，关闭时恢复 */
let savedWindowHeight = 0;
/** Tab 溢出重排回调（由 initTabOverflow 设置） */
let _reflowTabs: (() => void) | null = null;

// ── 表单 ↔ 内存同步 ───────────────────────────────────

function syncFormToCfg(): void {
  if (!cfg || !editKey || !cfg.providers[editKey]) return;
  const p = cfg.providers[editKey];
  p.name       = (document.getElementById('s-name')     as HTMLInputElement).value.trim() || p.name;
  p.baseUrl    = (document.getElementById('s-baseUrl')  as HTMLInputElement).value.trim();
  p.apiKey     = (document.getElementById('s-apiKey')   as HTMLInputElement).value.trim();
  p.model      = (document.getElementById('s-model')    as HTMLInputElement).value.trim();
  p.temperature =
    parseFloat((document.getElementById('s-temp')   as HTMLInputElement).value) || 0.85;
  p.maxTokens  =
    parseInt((document.getElementById('s-tokens') as HTMLInputElement).value, 10) || 1024;
  p.systemPrompt = (document.getElementById('s-sysprompt') as HTMLTextAreaElement).value;

  const rounds = parseInt((document.getElementById('s-rounds') as HTMLInputElement).value, 10);
  if (rounds > 0) cfg.contextWindowRounds = rounds;
}

function renderForm(): void {
  if (!cfg || !editKey) return;
  const p = cfg.providers[editKey];
  if (!p) return;

  (document.getElementById('s-name')      as HTMLInputElement).value  = p.name      ?? '';
  (document.getElementById('s-baseUrl')   as HTMLInputElement).value  = p.baseUrl   ?? '';
  (document.getElementById('s-apiKey')    as HTMLInputElement).value  = p.apiKey    ?? '';
  (document.getElementById('s-model')     as HTMLInputElement).value  = p.model     ?? '';
  (document.getElementById('s-temp')      as HTMLInputElement).value  = String(p.temperature ?? 0.85);
  (document.getElementById('s-tokens')    as HTMLInputElement).value  = String(p.maxTokens  ?? 1024);
  (document.getElementById('s-sysprompt') as HTMLTextAreaElement).value = p.systemPrompt ?? '';

  // 内置方案或只有一个 provider 时隐藏删除按钮
  const delBtn = document.getElementById('s-del-btn') as HTMLButtonElement;
  const isBuiltin = BUILTIN_LLM_PROVIDERS.includes(editKey);
  const onlyOne = Object.keys(cfg.providers).length <= 1;
  delBtn.style.visibility = (isBuiltin || onlyOne) ? 'hidden' : 'visible';
}

// ── Provider Select ─────────────────────────────────────

function renderProviderSelect(): void {
  if (!cfg) return;
  const select = document.getElementById('s-provider-select') as HTMLSelectElement;
  if (!select) return;
  select.innerHTML = '';

  for (const [key, prov] of Object.entries(cfg.providers)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = prov.name || key;
    if (key === cfg.activeProvider) {
      option.textContent += ' (当前使用)';
    }
    if (key === editKey) {
      option.selected = true;
    }
    select.appendChild(option);
  }

  // 监听下拉框变化
  select.onchange = () => {
    syncFormToCfg();
    editKey = select.value;
    renderProviderSelect();
    renderForm();
  };
}

// ── 加载设置到 UI ──────────────────────────────────────

async function loadSettingsUI(): Promise<void> {
  cfg = await window.settingsAPI!.get();
  editKey = cfg.activeProvider;
  (document.getElementById('s-rounds') as HTMLInputElement).value =
    String(cfg.contextWindowRounds);
  renderProviderSelect();
  renderForm();
}

async function loadDiscordUI(): Promise<void> {
  if (!window.discordAPI) return;
  const dc = await window.discordAPI.get();
  (document.getElementById('dc-enabled')  as HTMLInputElement).checked = dc.enabled;
  (document.getElementById('dc-token')    as HTMLInputElement).value   = dc.token;
  (document.getElementById('dc-channels') as HTMLInputElement).value   = dc.allowedChannels;
  (document.getElementById('dc-proxy')    as HTMLInputElement).value   = dc.proxyUrl;
  await refreshDiscordStatus();
}

async function refreshDiscordStatus(): Promise<void> {
  if (!window.discordAPI) return;
  const status = await window.discordAPI.getStatus();
  const dot      = document.getElementById('dc-status-dot')  as HTMLElement;
  const listDot  = document.getElementById('dc-list-dot')    as HTMLElement | null;
  const text     = document.getElementById('dc-status-text') as HTMLElement;
  const cls = status === 'online' ? 's-status-on' : 's-status-off';
  dot.className      = `s-status-dot ${cls}`;
  if (listDot) listDot.className = `s-bridge-dot ${cls}`;
  text.textContent   = status === 'online' ? '已连接' : '未启动';
}

async function saveDiscordSettings(): Promise<void> {
  if (!window.discordAPI) return;
  const cfg: DiscordConfig = {
    enabled:         (document.getElementById('dc-enabled')  as HTMLInputElement).checked,
    token:           (document.getElementById('dc-token')    as HTMLInputElement).value.trim(),
    allowedChannels: (document.getElementById('dc-channels') as HTMLInputElement).value.trim(),
    proxyUrl:        (document.getElementById('dc-proxy')    as HTMLInputElement).value.trim(),
  };
  const btn = document.getElementById('dc-save-btn') as HTMLButtonElement;
  btn.textContent = '保存中…';
  btn.disabled = true;
  try {
    await window.discordAPI.save(cfg);
    btn.textContent = '✓ 已保存';
    // 给 bot 2 秒启动时间再刷新状态
    setTimeout(() => {
      void refreshDiscordStatus();
      btn.textContent = '保存并重启 Bot';
      btn.disabled = false;
    }, 2000);
  } catch (e) {
    btn.textContent = '保存失败';
    setTimeout(() => { btn.textContent = '保存并重启 Bot'; btn.disabled = false; }, 2000);
    console.error('[Discord save]', e);
  }
}

// ── WeChat UI ─────────────────────────────────────────

async function loadWeChatUI(): Promise<void> {
  if (!window.wechatAPI) return;
  const wc = await window.wechatAPI.get();
  (document.getElementById('wc-enabled') as HTMLInputElement).checked = wc.enabled;
  (document.getElementById('wc-chunk-delay') as HTMLInputElement).value = String(wc.sendChunkDelay ?? 0.35);
  
  // 显示账号信息
  if (wc.token && wc.accountId) {
    (document.getElementById('wc-account-id') as HTMLInputElement).value = wc.accountId;
    (document.getElementById('wc-token-preview') as HTMLInputElement).value = wc.token.slice(0, 8) + '***';
    (document.getElementById('wc-account-section') as HTMLElement).style.display = 'block';
    (document.getElementById('wc-qr-section') as HTMLElement).style.display = 'none';
  } else {
    (document.getElementById('wc-account-section') as HTMLElement).style.display = 'none';
    (document.getElementById('wc-qr-section') as HTMLElement).style.display = 'block';
  }
  
  await refreshWeChatStatus();
}

async function refreshWeChatStatus(): Promise<void> {
  if (!window.wechatAPI) return;
  const status = await window.wechatAPI.getStatus();
  const dot      = document.getElementById('wc-status-dot')  as HTMLElement;
  const listDot  = document.getElementById('wc-list-dot')    as HTMLElement | null;
  const text     = document.getElementById('wc-status-text') as HTMLElement;
  const cls = status === 'online' ? 's-status-on' : 's-status-off';
  dot.className      = `s-status-dot ${cls}`;
  if (listDot) listDot.className = `s-bridge-dot ${cls}`;
  text.textContent   = status === 'online' ? '已连接' : '未启动';
}

async function saveWeChatSettings(): Promise<void> {
  if (!window.wechatAPI) return;
  const cfg: WeChatConfig = {
    enabled: (document.getElementById('wc-enabled') as HTMLInputElement).checked,
    sendChunkDelay: parseFloat((document.getElementById('wc-chunk-delay') as HTMLInputElement).value),
  };
  const btn = document.getElementById('wc-save-btn') as HTMLButtonElement;
  btn.textContent = '保存中…';
  btn.disabled = true;
  try {
    await window.wechatAPI.save(cfg);
    btn.textContent = '✓ 已保存';
    setTimeout(() => {
      void refreshWeChatStatus();
      btn.textContent = '保存并重启 Bot';
      btn.disabled = false;
    }, 2000);
  } catch (e) {
    btn.textContent = '保存失败';
    setTimeout(() => { btn.textContent = '保存并重启 Bot'; btn.disabled = false; }, 2000);
    console.error('[WeChat save]', e);
  }
}

async function startWeChatQRLogin(): Promise<void> {
  if (!window.wechatAPI) return;
  
  const btn = document.getElementById('wc-qr-start-btn') as HTMLButtonElement;
  const display = document.getElementById('wc-qr-display') as HTMLElement;
  const statusText = document.getElementById('wc-qr-status') as HTMLElement;
  const img = document.getElementById('wc-qr-img') as HTMLImageElement;
  
  btn.disabled = true;
  btn.textContent = '启动中…';
  display.style.display = 'block';
  statusText.textContent = '正在获取二维码...';
  
  // 监听状态更新
  window.wechatAPI.onQRLoginUpdate((state: any) => {
    console.log('[WeChat QR]', state);
    if (state.qrcodeUrl) {
      img.src = state.qrcodeUrl;
    }
    if (state.status === 'pending') {
      statusText.textContent = '✨ 请使用微信扫描上方二维码';
      statusText.style.color = '#4CAF50';
    } else if (state.status === 'scanned') {
      statusText.textContent = '✅ 已扫码，请在微信里确认授权...';
      statusText.style.color = '#2196F3';
    } else if (state.status === 'confirmed') {
      statusText.textContent = '🎉 登录成功！正在保存凭证...';
      statusText.style.color = '#4CAF50';
      setTimeout(() => {
        void loadWeChatUI(); // 刷新 UI 显示账号信息
        display.style.display = 'none';
        btn.disabled = false;
        btn.textContent = '🔑 启动二维码登录';
      }, 2000);
    } else if (state.status === 'expired') {
      statusText.textContent = `⚠️ 二维码已过期：${state.error || '请重试'}`;
      statusText.style.color = '#FF9800';
      btn.disabled = false;
      btn.textContent = '🔄 重新获取二维码';
    } else if (state.status === 'error') {
      statusText.textContent = `❌ 登录失败：${state.error || '未知错误'}`;
      statusText.style.color = '#F44336';
      btn.disabled = false;
      btn.textContent = '🔄 重试';
    }
  });
  
  // 启动 QR 登录
  try {
    await window.wechatAPI.startQRLogin();
  } catch (err) {
    statusText.textContent = `❌ 启动失败：${err}`;
    statusText.style.color = '#F44336';
    btn.disabled = false;
    btn.textContent = '🔄 重试';
  }
}

// ── TTS UI（多 Provider）────────────────────────────────

let ttsCfg: TTSConfig | null = null;
let ttsEditKey: string | null = null;

async function refreshTTSRuntimeStatus(): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ttsAPI = (window as any).ttsAPI as { isEnabled(): Promise<boolean>; health(): Promise<{ ok: boolean }> } | undefined;
  const dot  = document.getElementById('tts-runtime-dot')  as HTMLElement | null;
  const text = document.getElementById('tts-runtime-text') as HTMLElement | null;
  if (!dot || !text) return false;
  try {
    const enabled = ttsAPI ? await ttsAPI.isEnabled() : false;
    if (!enabled) {
      dot.className = 's-status-dot s-status-err';
      text.textContent = '⚠️ 未启用';
      return false;
    }
    const health = ttsAPI ? await ttsAPI.health() : { ok: false };
    if (health.ok) {
      dot.className = 's-status-dot s-status-on';
      text.textContent = '✓ 已启用（语音将在回复后自动播放）';
      return true;
    } else {
      dot.className = 's-status-dot s-status-err';
      text.textContent = '⚠️ 服务不可达（请检查服务地址或启动本地服务）';
      return false;
    }
  } catch {
    dot.className = 's-status-dot s-status-off';
    text.textContent = '无法获取状态';
    return false;
  }
}

// ── Memory UI ─────────────────────────────────────────

async function exportMemory(): Promise<void> {
  if (!window.memoryAPI) return;
  const btn = document.getElementById('memory-export-btn') as HTMLButtonElement | null;
  if (!btn) return;
  
  btn.textContent = '导出中…';
  btn.disabled = true;
  
  try {
    const result = await window.memoryAPI.export();
    if (result.success) {
      btn.textContent = '✓ 已导出';
      setTimeout(() => {
        btn.textContent = '📤 导出记忆';
        btn.disabled = false;
      }, 1800);
    } else {
      btn.textContent = '导出失败';
      setTimeout(() => {
        btn.textContent = '📤 导出记忆';
        btn.disabled = false;
      }, 2000);
    }
  } catch (e) {
    console.error('[Memory export]', e);
    btn.textContent = '导出失败';
    setTimeout(() => {
      btn.textContent = '📤 导出记忆';
      btn.disabled = false;
    }, 2000);
  }
}

async function importMemory(): Promise<void> {
  if (!window.memoryAPI) return;
  const btn = document.getElementById('memory-import-btn') as HTMLButtonElement | null;
  if (!btn) return;
  
  btn.textContent = '导入中…';
  btn.disabled = true;
  
  try {
    const result = await window.memoryAPI.import();
    if (result.success) {
      btn.textContent = '✓ 已导入';
      setTimeout(() => {
        btn.textContent = '📥 导入记忆';
        btn.disabled = false;
      }, 1800);
    } else {
      btn.textContent = '导入失败';
      setTimeout(() => {
        btn.textContent = '📥 导入记忆';
        btn.disabled = false;
      }, 2000);
    }
  } catch (e) {
    console.error('[Memory import]', e);
    btn.textContent = '导入失败';
    setTimeout(() => {
      btn.textContent = '📥 导入记忆';
      btn.disabled = false;
    }, 2000);
  }
}

/** 自发保存时跳过 onConfigChanged 触发的重载 */
let _ttsSavingFromUI = false;

async function loadTTSUI(): Promise<void> {
  if (!window.ttsSettingsAPI) return;
  // 自发保存后的广播回调 → 跳过重载，避免编辑位置跳回
  if (_ttsSavingFromUI) return;

  ttsCfg = await window.ttsSettingsAPI.get() as TTSConfig;
  // 如果当前正在编辑的 provider 仍存在，保留编辑位置
  if (!ttsEditKey || !ttsCfg.providers[ttsEditKey]) {
    ttsEditKey = ttsCfg.activeProvider;
  }

  // 全局开关 — 反映配置中保存的 enabled 状态（而非运行时健康状态）
  (document.getElementById('tts-enabled') as HTMLInputElement).checked = ttsCfg.enabled;
  // 状态指示器 — 单独显示实际运行状态
  await refreshTTSRuntimeStatus();

  renderTTSProviderSelect();
  renderTTSForm();
}

function syncTTSFormToCfg(): void {
  if (!ttsCfg || !ttsEditKey || !ttsCfg.providers[ttsEditKey]) return;
  const p = ttsCfg.providers[ttsEditKey];
  p.name     = (document.getElementById('tts-name')     as HTMLInputElement).value.trim() || p.name;
  p.baseUrl  = (document.getElementById('tts-url')      as HTMLInputElement).value.trim();
  p.apiKey   = (document.getElementById('tts-apikey')   as HTMLInputElement).value.trim();
  p.language = (document.getElementById('tts-language')  as HTMLSelectElement).value;

  // 根据 speakerMode 从不同控件读取 speaker
  if (p.speakerMode === 'preset') {
    const sel = document.getElementById('tts-speaker-select') as HTMLSelectElement;
    p.speaker = sel.value;
  } else {
    p.speaker = (document.getElementById('tts-speaker') as HTMLInputElement).value.trim();
  }
}

function renderTTSProviderSelect(): void {
  if (!ttsCfg) return;
  const select = document.getElementById('tts-provider-select') as HTMLSelectElement;
  if (!select) return;
  select.innerHTML = '';

  for (const [key, prov] of Object.entries(ttsCfg.providers)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = prov.name || key;
    if (key === ttsCfg.activeProvider) option.textContent += ' (当前使用)';
    if (key === ttsEditKey) option.selected = true;
    select.appendChild(option);
  }

  select.onchange = () => {
    syncTTSFormToCfg();
    ttsEditKey = select.value;
    renderTTSProviderSelect();
    renderTTSForm();
  };
}

function renderTTSForm(): void {
  if (!ttsCfg || !ttsEditKey) return;
  const p = ttsCfg.providers[ttsEditKey];
  if (!p) return;

  (document.getElementById('tts-name')     as HTMLInputElement).value  = p.name     ?? '';
  (document.getElementById('tts-url')      as HTMLInputElement).value  = p.baseUrl  ?? '';
  (document.getElementById('tts-apikey')   as HTMLInputElement).value  = p.apiKey   ?? '';
  (document.getElementById('tts-language') as HTMLSelectElement).value = p.language  ?? 'Auto';

  // 内置方案：name / url / apiKey 只读（由代码控制）
  const isBuiltin = BUILTIN_TTS_PROVIDERS.includes(ttsEditKey);
  (document.getElementById('tts-name')   as HTMLInputElement).readOnly = isBuiltin;
  (document.getElementById('tts-url')    as HTMLInputElement).readOnly = isBuiltin;
  (document.getElementById('tts-apikey') as HTMLInputElement).readOnly = isBuiltin;

  // ── 音色区域：preset 模式显示下拉，text 模式显示文本框 ──
  const speakerInput  = document.getElementById('tts-speaker')        as HTMLInputElement;
  const speakerSelect = document.getElementById('tts-speaker-select') as HTMLSelectElement;

  if (p.speakerMode === 'preset' && p.voicePresets && p.voicePresets.length > 0) {
    speakerInput.style.display  = 'none';
    speakerSelect.style.display = '';
    speakerSelect.innerHTML = '';
    for (const preset of p.voicePresets) {
      const opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = `${preset.name}（${preset.description}）`;
      if (preset.id === p.speaker) opt.selected = true;
      speakerSelect.appendChild(opt);
    }
  } else {
    speakerInput.style.display  = '';
    speakerSelect.style.display = 'none';
    speakerInput.value = p.speaker ?? '';
  }



  // 内置方案或只有一个 provider 时隐藏删除按钮
  const delBtn = document.getElementById('tts-del-btn') as HTMLButtonElement;
  const onlyOne = Object.keys(ttsCfg.providers).length <= 1;
  delBtn.style.visibility = (isBuiltin || onlyOne) ? 'hidden' : 'visible';

  // 本地服务管理区域：仅 isLocal 时显示，且更新提示文本
  const localSection = document.getElementById('tts-local-section') as HTMLElement;
  if (localSection) {
    localSection.style.display = p.isLocal ? '' : 'none';
    const hint = document.getElementById('tts-local-hint') as HTMLElement | null;
    if (hint) {
      const hintMap: Record<string, string> = {
        'edge-tts': '一键部署免费的 edge-tts 本地服务（需 Python 3.10+）',
        'moss-tts-nano': '部署 MOSS-TTS-Nano 本地离线语音合成（需 Python 3.10+，约 2GB 磁盘）',
        'genie-tts': '部署 Genie-TTS 本地语音合成，菲比音色（需 Python 3.10+，约 1.5GB 磁盘，首次安装耗时较长）',
      };
      hint.textContent = hintMap[p.localEngine || 'edge-tts'] ?? hintMap['edge-tts'];
    }
  }
}

async function saveTTSSettings(): Promise<void> {
  if (!window.ttsSettingsAPI || !ttsCfg) return;
  syncTTSFormToCfg();
  // 下拉框当前选中的即为活跃 provider
  if (ttsEditKey) ttsCfg.activeProvider = ttsEditKey;
  ttsCfg.enabled = (document.getElementById('tts-enabled') as HTMLInputElement).checked;

  const btn = document.getElementById('tts-save-btn') as HTMLButtonElement;
  btn.textContent = '保存中…';
  btn.disabled = true;
  // 抑制自发保存触发的 onConfigChanged 回调（避免重载导致编辑位置跳回）
  _ttsSavingFromUI = true;
  try {
    await window.ttsSettingsAPI.save(ttsCfg);
    btn.textContent = '✓ 已保存';
    void refreshTTSRuntimeStatus();
    renderTTSProviderSelect();
    setTimeout(() => { btn.textContent = '保存设置'; btn.disabled = false; }, 1800);
  } catch (e) {
    btn.textContent = '保存失败';
    setTimeout(() => { btn.textContent = '保存设置'; btn.disabled = false; }, 2000);
    console.error('[TTS save]', e);
  } finally {
    // 延迟重置，确保广播回调已被跳过
    setTimeout(() => { _ttsSavingFromUI = false; }, 500);
  }
}

function addTTSProvider(): void {
  if (!ttsCfg) return;
  syncTTSFormToCfg();
  const key = `tts_${Date.now()}`;
  ttsCfg.providers[key] = {
    type: 'http-tts',
    name: '新 TTS 服务',
    baseUrl: '',
    apiKey: '',
    speaker: '',
    language: 'Auto',
  };
  ttsEditKey = key;
  renderTTSProviderSelect();
  renderTTSForm();
}

function deleteTTSProvider(): void {
  if (!ttsCfg || !ttsEditKey) return;
  if (Object.keys(ttsCfg.providers).length <= 1) return;
  
  // 禁止删除内置 TTS 方案
  if (BUILTIN_TTS_PROVIDERS.includes(ttsEditKey)) {
    alert('内置 TTS 方案不允许删除');
    return;
  }
  
  if (ttsEditKey === ttsCfg.activeProvider) {
    ttsCfg.activeProvider = Object.keys(ttsCfg.providers).filter(k => k !== ttsEditKey)[0];
  }
  ttsCfg.deletedProviders = [...(ttsCfg.deletedProviders ?? []), ttsEditKey];
  delete ttsCfg.providers[ttsEditKey];
  ttsEditKey = ttsCfg.activeProvider;
  void saveTTSSettings();
}

function setActiveTTSProvider(): void {
  if (!ttsCfg || !ttsEditKey) return;
  syncTTSFormToCfg();
  ttsCfg.activeProvider = ttsEditKey;
  renderTTSProviderSelect();
  renderTTSForm();
  void saveTTSSettings();
}

async function runTTSHealthCheck(): Promise<void> {
  if (!window.ttsSettingsAPI) return;
  const url  = (document.getElementById('tts-url') as HTMLInputElement).value.trim();
  const dot  = document.getElementById('tts-status-dot')  as HTMLElement;
  const text = document.getElementById('tts-status-text') as HTMLElement;
  const btn  = document.getElementById('tts-test-btn')    as HTMLButtonElement;

  btn.disabled = true;
  btn.textContent = '测试中…';
  dot.className = 's-status-dot s-status-off';
  text.textContent = '连接中…';

  try {
    const result = await window.ttsSettingsAPI.test(url);
    if (result.ok) {
      dot.className = 's-status-dot s-status-on';
      text.textContent = `✓ 连接成功（HTTP ${result.status}）`;
    } else {
      dot.className = 's-status-dot s-status-err';
      text.textContent = result.error ?? `✗ HTTP ${result.status}`;
    }
  } catch (e) {
    dot.className = 's-status-dot s-status-err';
    text.textContent = `✗ ${String(e)}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 测试连接';
  }
}

// ── 保存（LLM） ────────────────────────────────────────

// ── Local TTS UI ──────────────────────────────────────

async function localTTSInstallAndStart(): Promise<void> {
  const api = (window as any).ttsLocalAPI as Window['ttsLocalAPI'];
  if (!api) return;

  const engine = ttsCfg?.providers[ttsEditKey!]?.localEngine;
  const btn = document.getElementById('tts-local-install-btn') as HTMLButtonElement;
  const log = document.getElementById('tts-local-log')         as HTMLElement;
  btn.disabled = true;
  btn.textContent = '安装中…';
  log.style.display = 'block';
  log.textContent = '';

  // 订阅实时日志
  const unsubscribe = api.onLog?.((msg: string) => {
    log.textContent += msg + '\n';
    log.scrollTop = log.scrollHeight;
  });

  try {
    const result = await api.installAndStart(engine);

    // 追加最终结果
    if (result.ok) {
      log.textContent += '\n✅ ' + result.detail;
      btn.textContent = '✅ 完成';
      // 安装启动成功 → 自动勾选启用 + 保存
      const toggle = document.getElementById('tts-enabled') as HTMLInputElement;
      toggle.checked = true;
      await saveTTSSettings();
    } else {
      log.textContent += '\n❌ ' + result.detail;
      btn.textContent = '❌ 失败，点击重试';
    }
    log.scrollTop = log.scrollHeight;
  } catch (e) {
    log.textContent += `\n错误: ${String(e)}`;
    btn.textContent = '❌ 失败，点击重试';
  } finally {
    unsubscribe?.();
    btn.disabled = false;
    void refreshTTSRuntimeStatus();
  }
}

async function localTTSStart(): Promise<void> {
  const api = (window as any).ttsLocalAPI as Window['ttsLocalAPI'];
  if (!api) return;

  const engine = ttsCfg?.providers[ttsEditKey!]?.localEngine;
  const btn = document.getElementById('tts-local-start-btn') as HTMLButtonElement;
  const log = document.getElementById('tts-local-log') as HTMLElement;
  btn.disabled = true;
  btn.textContent = '启动中…';
  log.style.display = 'block';
  log.textContent = '启动 TTS Server…\n';

  const unsubscribe = api.onLog?.((msg: string) => {
    log.textContent += msg + '\n';
    log.scrollTop = log.scrollHeight;
  });

  try {
    const result = await api.start(engine);
    if (result.ok) {
      log.textContent += '✅ ' + result.detail;
      // 启动成功 → 自动勾选启用 + 保存
      const toggle = document.getElementById('tts-enabled') as HTMLInputElement;
      toggle.checked = true;
      await saveTTSSettings();
    } else {
      log.textContent += '❌ ' + result.detail;
    }
    log.scrollTop = log.scrollHeight;
  } catch (e) {
    log.textContent += `错误: ${String(e)}`;
    console.error('[TTS local start]', e);
  } finally {
    unsubscribe?.();
    btn.textContent = '▶ 启动';
    btn.disabled = false;
    void refreshTTSRuntimeStatus();
  }
}

async function localTTSStop(): Promise<void> {
  const api = (window as any).ttsLocalAPI as Window['ttsLocalAPI'];
  if (!api) return;

  const engine = ttsCfg?.providers[ttsEditKey!]?.localEngine;
  const btn = document.getElementById('tts-local-stop-btn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = '停止中…';

  try {
    await api.stop(engine);
  } catch (e) {
    console.error('[TTS local stop]', e);
  } finally {
    btn.textContent = '⏹ 停止';
    btn.disabled = false;
    void refreshTTSRuntimeStatus();
  }
}

// ── 保存（LLM） ────────────────────────────────────────

async function saveSettings(): Promise<void> {
  if (!cfg) return;
  syncFormToCfg();
  // 下拉框当前选中的即为活跃 provider
  if (editKey) cfg.activeProvider = editKey;
  await window.settingsAPI!.save(cfg);

  const btn = document.getElementById('settings-save-btn') as HTMLButtonElement;
  btn.textContent = '✓ 已保存';
  btn.classList.add('saved');
  setTimeout(() => {
    btn.textContent = '保存设置';
    btn.classList.remove('saved');
  }, 1800);

  renderProviderSelect(); // 刷新 active 标记
}

// ── 新增 Provider ──────────────────────────────────────

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
    systemPrompt: '',
  };
  editKey = key;
  renderProviderSelect();
  renderForm();
  // 滚动到表单
  document.getElementById('s-form-section')?.scrollIntoView({ behavior: 'smooth' });
}

// ── 删除 Provider ──────────────────────────────────────

function deleteProvider(): void {
  if (!cfg || !editKey || Object.keys(cfg.providers).length <= 1) return;
  
  // 禁止删除内置 LLM 方案
  if (BUILTIN_LLM_PROVIDERS.includes(editKey)) {
    alert('内置 LLM 方案不允许删除');
    return;
  }
  
  if (editKey === cfg.activeProvider) {
    const remaining = Object.keys(cfg.providers).filter((k) => k !== editKey);
    cfg.activeProvider = remaining[0];
  }
  // 记录删除，保证重启后代码默认 provider 里同名的不会被重新补入
  cfg.deletedProviders = [...(cfg.deletedProviders ?? []), editKey];
  delete cfg.providers[editKey];
  editKey = cfg.activeProvider;
  renderProviderSelect();
  renderForm();
  // 立即持久化，不依赖用户手动点保存
  void saveSettings();
}

// ── 设为当前 ──────────────────────────────────────────

function setActiveProvider(): void {
  if (!cfg || !editKey) return;
  syncFormToCfg();
  cfg.activeProvider = editKey;
  renderProviderSelect();
  renderForm();
}

// ── 面板开关 ──────────────────────────────────────────

// ── Tab 溢出自适应 ────────────────────────────────────

function initTabOverflow(): void {
  const strip   = document.getElementById('s-tabs-strip') as HTMLElement | null;
  const moreBtn = document.getElementById('s-tabs-more') as HTMLButtonElement | null;
  const dropdown = document.getElementById('s-tabs-dropdown') as HTMLElement | null;
  if (!strip || !moreBtn || !dropdown) return;

  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
  });

  document.addEventListener('click', (e) => {
    if (!moreBtn.contains(e.target as Node) && !dropdown.contains(e.target as Node)) {
      dropdown.hidden = true;
    }
  });

  function reflow(): void {
    const allTabs = Array.from(strip!.querySelectorAll<HTMLButtonElement>('.s-tab'));

    // Reset: show all tabs, hide more button + dropdown
    allTabs.forEach((t) => { t.style.display = ''; });
    moreBtn!.hidden = true;
    dropdown!.hidden = true;
    dropdown!.innerHTML = '';

    // Force layout flush
    void strip!.scrollWidth;

    if (strip!.scrollWidth <= strip!.clientWidth + 1) return;

    // Overflow detected — show more button
    moreBtn!.hidden = false;
    void moreBtn!.offsetWidth; // flush so strip narrows

    const stripRect = strip!.getBoundingClientRect();
    const overflowing: HTMLButtonElement[] = [];
    for (const tab of allTabs) {
      if (tab.getBoundingClientRect().right > stripRect.right + 1) {
        tab.style.display = 'none';
        overflowing.push(tab);
      }
    }

    if (overflowing.length === 0) {
      moreBtn!.hidden = true;
      return;
    }

    // Mirror active state onto more button
    const hasActiveOverflow = overflowing.some((t) => t.classList.contains('s-tab-active'));
    moreBtn!.classList.toggle('s-tab-active', hasActiveOverflow);

    // Build dropdown items
    for (const tab of overflowing) {
      const item = document.createElement('button');
      item.className = 's-tab-dropdown-item';
      if (tab.classList.contains('s-tab-active')) item.classList.add('s-tab-active');
      item.dataset['tab'] = tab.dataset['tab'];
      item.textContent = tab.textContent;
      item.addEventListener('click', () => {
        tab.click();
        dropdown!.hidden = true;
      });
      dropdown!.appendChild(item);
    }
  }

  _reflowTabs = reflow;
  new ResizeObserver(reflow).observe(strip);
  reflow();
}

// ── Skills 管理 UI ────────────────────────────────────

async function loadSkillsUI(): Promise<void> {
  const container = document.getElementById('skills-mgr');
  if (!container) return;

  if (!window.skillsAPI) {
    container.innerHTML = '<p class="s-hint">Skills API 不可用</p>';
    return;
  }

  container.innerHTML = '<p class="s-hint">加载中…</p>';

  let config: SkillsConfig;
  let allSkills: SkillEntry[];
  let collections: CollectionInfo[];
  try {
    [config, allSkills, collections] = await Promise.all([
      window.skillsAPI.getConfig(),
      window.skillsAPI.listAll(),
      window.skillsAPI.listCollections(),
    ]);
  } catch (e) {
    container.innerHTML = `<p class="s-hint">加载失败: ${String(e)}</p>`;
    return;
  }

  // Deep clone for in-memory editing
  const draft: SkillsConfig = JSON.parse(JSON.stringify(config)) as SkillsConfig;

  // Group skills by collection
  const collMap = new Map<string, SkillEntry[]>();
  for (const s of allSkills) {
    const arr = collMap.get(s.collection) ?? [];
    arr.push(s);
    collMap.set(s.collection, arr);
  }

  // Build display name map from dynamic collection metadata
  // Falls back to "📦 <id>" for any collection without _collection.json
  const collDisplayMap = new Map(collections.map((c) => [c.id, c.displayName]));

  container.innerHTML = '';

  // ── 全局设置 ────────────────────────────────────────
  const globalSec = skillsMkSection('全局设置');

  globalSec.appendChild(skillsMkToggleRow(
    '注入技能目录',
    '在 agent 模式下将技能注入系统提示词（chat 模式始终不注入）',
    draft.enabled,
    (v) => {
      draft.enabled = v;
      container.querySelectorAll<HTMLElement>('.skills-coll-body').forEach((el) => {
        el.style.opacity = v ? '1' : '0.4';
        el.style.pointerEvents = v ? '' : 'none';
      });
    },
  ));

  globalSec.appendChild(skillsMkSelectRow(
    '全局展示模式',
    [
      { value: 'none',  label: '不注入（节省最多 token）' },
      { value: 'names', label: '仅名称' },
      { value: 'short', label: '名称 + 短描述（40字）' },
      { value: 'full',  label: '名称 + 完整描述（默认）' },
    ],
    draft.listingMode,
    (v) => { draft.listingMode = v as SkillListingMode; },
  ));

  container.appendChild(globalSec);

  // ── Per-collection cards ─────────────────────────────

  for (const [collId, skills] of collMap) {
    const titleHtml =
      (collDisplayMap.get(collId) ?? `📦 ${collId}`) +
      `&nbsp;<span style="font-weight:400;opacity:.6;font-size:10px">${skills.length} 个技能</span>`;
    const collSec = skillsMkSection(titleHtml);
    collSec.classList.add('skills-coll-section');

    const collBody = document.createElement('div');
    collBody.className = 'skills-coll-body';
    if (!draft.enabled) { collBody.style.opacity = '0.4'; collBody.style.pointerEvents = 'none'; }

    // Skills area (affected by collection enabled toggle)
    const skillsArea = document.createElement('div');
    skillsArea.className = 'skills-coll-skills-area';
    const collEnabled = !draft.disabledCollections.includes(collId);
    if (!collEnabled) { skillsArea.style.opacity = '0.4'; skillsArea.style.pointerEvents = 'none'; }

    // Collection enabled toggle
    collBody.appendChild(skillsMkToggleRow('启用此集合', null, collEnabled, (v) => {
      if (v) {
        draft.disabledCollections = draft.disabledCollections.filter((c) => c !== collId);
      } else if (!draft.disabledCollections.includes(collId)) {
        draft.disabledCollections.push(collId);
      }
      skillsArea.style.opacity = v ? '1' : '0.4';
      skillsArea.style.pointerEvents = v ? '' : 'none';
    }));

    // Collection mode override
    collBody.appendChild(skillsMkSelectRow(
      '展示模式（此集合）',
      [
        { value: '',      label: `继承全局（${skillsModeLabel(draft.listingMode)}）` },
        { value: 'none',  label: '不注入' },
        { value: 'names', label: '仅名称' },
        { value: 'short', label: '名称 + 短描述' },
        { value: 'full',  label: '名称 + 完整描述' },
      ],
      draft.collectionModes[collId] ?? '',
      (v) => {
        if (v === '') { delete draft.collectionModes[collId]; }
        else { draft.collectionModes[collId] = v as SkillListingMode; }
      },
    ));

    // Collapsible skill list
    const detailsEl = document.createElement('details');
    detailsEl.className = 'skills-details';
    if (skills.length <= 8) detailsEl.open = true;

    const summaryEl = document.createElement('summary');
    const setSummaryText = () => {
      summaryEl.textContent = detailsEl.open
        ? `▾ 收起 ${skills.length} 个技能`
        : `▸ 展开 ${skills.length} 个技能`;
    };
    setSummaryText();
    detailsEl.addEventListener('toggle', setSummaryText);

    // Controls row
    const ctrlRow = document.createElement('div');
    ctrlRow.className = 'skills-ctrl-row';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'skills-search';
    searchInput.placeholder = '搜索技能…';
    const btnAll  = document.createElement('button');
    btnAll.className  = 's-small-btn';
    btnAll.textContent = '全选';
    const btnNone = document.createElement('button');
    btnNone.className  = 's-small-btn';
    btnNone.textContent = '全不选';
    ctrlRow.append(searchInput, btnAll, btnNone);

    // Skills grid
    const grid = document.createElement('div');
    grid.className = 'skills-grid';
    const itemEls: HTMLLabelElement[] = [];

    for (const skill of skills) {
      const lbl = document.createElement('label');
      lbl.className = 'skills-item';
      lbl.title = skill.summary;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !draft.disabledSkills.includes(skill.skillKey);
      cb.addEventListener('change', () => {
        if (cb.checked) {
          draft.disabledSkills = draft.disabledSkills.filter((k) => k !== skill.skillKey);
        } else if (!draft.disabledSkills.includes(skill.skillKey)) {
          draft.disabledSkills.push(skill.skillKey);
        }
      });

      const nameSpan = document.createElement('span');
      nameSpan.className = 'skills-item-name';
      nameSpan.textContent = skill.name;

      lbl.append(cb, nameSpan);
      grid.appendChild(lbl);
      itemEls.push(lbl);
    }

    // Search filter
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase();
      for (const el of itemEls) {
        const name = (el.querySelector('.skills-item-name')?.textContent ?? '').toLowerCase();
        el.style.display = name.includes(q) ? '' : 'none';
      }
    });

    // Bulk select / deselect (visible items only)
    const toggleAll = (checked: boolean) => {
      grid.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((c) => {
        if ((c.closest('label') as HTMLElement | null)?.style.display !== 'none') {
          c.checked = checked;
          c.dispatchEvent(new Event('change'));
        }
      });
    };
    btnAll.addEventListener('click',  () => toggleAll(true));
    btnNone.addEventListener('click', () => toggleAll(false));

    detailsEl.append(summaryEl, ctrlRow, grid);
    skillsArea.appendChild(detailsEl);
    collBody.appendChild(skillsArea);
    collSec.appendChild(collBody);
    container.appendChild(collSec);
  }

  // ── 保存按钮 ────────────────────────────────────────
  const saveRow = document.createElement('div');
  saveRow.style.cssText = 'display:flex;justify-content:flex-end;padding:4px 0 8px';
  const saveBtn = document.createElement('button');
  saveBtn.className = 's-save-btn';
  saveBtn.textContent = '保存 Skills 配置';
  saveBtn.addEventListener('click', async () => {
    try {
      await window.skillsAPI!.saveConfig(draft);
      saveBtn.textContent = '✓ 已保存';
      setTimeout(() => { saveBtn.textContent = '保存 Skills 配置'; }, 2000);
    } catch {
      saveBtn.textContent = '保存失败';
      setTimeout(() => { saveBtn.textContent = '保存 Skills 配置'; }, 2000);
    }
  });
  saveRow.appendChild(saveBtn);
  container.appendChild(saveRow);
}

// ── Skills UI 辅助函数 ────────────────────────────────

function skillsModeLabel(m: SkillListingMode): string {
  const labels: Record<SkillListingMode, string> = {
    none: '不注入', names: '仅名称', short: '名称+短描述', full: '名称+完整描述',
  };
  return labels[m] ?? m;
}

function skillsMkSection(titleHtml: string): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 's-section';
  const h = document.createElement('h3');
  h.className = 's-title';
  h.innerHTML = titleHtml;
  sec.appendChild(h);
  return sec;
}

function skillsMkToggleRow(
  label: string,
  hint: string | null,
  checked: boolean,
  onChange: (v: boolean) => void,
): HTMLElement {
  const row = document.createElement('label');
  row.className = 's-label s-label-row';

  const text = document.createElement('span');
  text.className = 's-label-text';
  text.textContent = label;

  const toggleWrap = document.createElement('label');
  toggleWrap.className = 's-toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const slider = document.createElement('span');
  slider.className = 's-toggle-slider';
  toggleWrap.append(input, slider);

  row.append(text, toggleWrap);

  if (hint) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:3px';
    const hintEl = document.createElement('span');
    hintEl.className = 's-hint';
    hintEl.textContent = hint;
    wrap.append(row, hintEl);
    return wrap;
  }
  return row;
}

function skillsMkSelectRow(
  label: string,
  options: Array<{ value: string; label: string }>,
  currentValue: string,
  onChange: (v: string) => void,
): HTMLElement {
  const lbl = document.createElement('label');
  lbl.className = 's-label';
  lbl.textContent = label;
  const sel = document.createElement('select');
  sel.className = 's-input';
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    sel.appendChild(o);
  }
  sel.value = currentValue;
  sel.addEventListener('change', () => onChange(sel.value));
  lbl.appendChild(sel);
  return lbl;
}

export function openSettings(): void {
  savedWindowWidth  = window.innerWidth;
  savedWindowHeight = window.innerHeight;
  // 打开设置时确保窗口足够高（620px）以显示完整表单
  if (savedWindowHeight < 620) {
    window.electronAPI?.resizeWindow(savedWindowWidth, 620);
  }
  // 暂停 canvas 区域的 Electron 拖拽捕获，否则设置面板上半部分点击会被 OS 拦截
  document.getElementById('canvas-container')?.classList.add('drag-region-suspended');
  document.getElementById('settings-panel')?.classList.add('visible');
  void loadSettingsUI();
  void loadDiscordUI();
  void loadWeChatUI();
  void loadTTSUI();
  void loadSkillsUI();

  // 当 Agent 或主进程修改了 TTS 配置时自动刷新设置界面（仅注册一次）
  if (!(window as any).__ttsConfigListenerRegistered) {
    (window as any).__ttsConfigListenerRegistered = true;
    window.ttsSettingsAPI?.onConfigChanged?.(() => {
      void loadTTSUI();
    });
  }
}

export function closeSettings(): void {
  document.getElementById('settings-panel')?.classList.remove('visible');
  // 恢复 canvas 区域的拖拽功能
  document.getElementById('canvas-container')?.classList.remove('drag-region-suspended');
  // 恢复原始窗口尺寸
  if (savedWindowHeight > 0 && savedWindowHeight < 620) {
    window.electronAPI?.resizeWindow(savedWindowWidth, savedWindowHeight);
  }
  savedWindowWidth  = 0;
  savedWindowHeight = 0;
}

// ── 初始化入口 ────────────────────────────────────────

export function initSettings(): void {
  // 设置面板触发按钮
  document.getElementById('settings-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openSettings();
  });

  // 返回按钮
  document.getElementById('settings-back')?.addEventListener('click', closeSettings);

  // 新增 provider
  document.getElementById('s-add-btn')?.addEventListener('click', addProvider);

  // 删除 provider
  document.getElementById('s-del-btn')?.addEventListener('click', deleteProvider);

  // 保存
  document.getElementById('settings-save-btn')?.addEventListener('click', saveSettings);

  // 记忆导出/导入
  document.getElementById('memory-export-btn')?.addEventListener('click', () => void exportMemory());
  document.getElementById('memory-import-btn')?.addEventListener('click', () => void importMemory());

  // API Key 显示/隐藏
  document.getElementById('s-eye-btn')?.addEventListener('click', () => {
    const input = document.getElementById('s-apiKey') as HTMLInputElement;
    const btn = document.getElementById('s-eye-btn') as HTMLButtonElement;
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = '🙈';
    } else {
      input.type = 'password';
      btn.textContent = '👁';
    }
  });

  // ── 选项卡切换 ───────────────────────────────────────
  document.querySelectorAll<HTMLButtonElement>('.s-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      const target = tabBtn.dataset['tab'];
      document.querySelectorAll<HTMLButtonElement>('.s-tab').forEach((b) =>
        b.classList.toggle('s-tab-active', b === tabBtn)
      );
      document.querySelectorAll<HTMLElement>('.s-tab-pane').forEach((pane) => {
        const match = pane.id === `s-tab-${target}`;
        pane.classList.toggle('s-tab-pane-hidden', !match);
      });
      _reflowTabs?.();
    });
  });

  initTabOverflow();

  // ── 平台列表左侧切换 ──────────────────────────────
  document.querySelectorAll<HTMLElement>('.s-bridge-item').forEach((item) => {
    item.addEventListener('click', () => {
      const bridge = item.dataset['bridge'];
      // 切换激活项
      document.querySelectorAll<HTMLElement>('.s-bridge-item').forEach((el) =>
        el.classList.toggle('s-bridge-active', el === item)
      );
      // 切换详情面板
      document.querySelectorAll<HTMLElement>('.s-bridge-pane').forEach((pane) =>
        pane.classList.toggle('s-bridge-pane-hidden', pane.id !== `s-bridge-${bridge}`)
      );
    });
  });

  // ── Discord 表单事件 ─────────────────────────────────
  document.getElementById('dc-save-btn')?.addEventListener('click', () => void saveDiscordSettings());

  document.getElementById('dc-eye-btn')?.addEventListener('click', () => {
    const input = document.getElementById('dc-token') as HTMLInputElement;
    const btn   = document.getElementById('dc-eye-btn') as HTMLButtonElement;
    if (input.type === 'password') { input.type = 'text';     btn.textContent = '🙈'; }
    else                           { input.type = 'password'; btn.textContent = '👁'; }
  });

  // ── WeChat 表单事件 ──────────────────────────────────
  document.getElementById('wc-save-btn')?.addEventListener('click', () => void saveWeChatSettings());
  document.getElementById('wc-qr-start-btn')?.addEventListener('click', () => void startWeChatQRLogin());
  // ── TTS 表单事件 ─────────────────────────────────────
  document.getElementById('tts-save-btn')?.addEventListener('click', () => void saveTTSSettings());
  document.getElementById('tts-test-btn')?.addEventListener('click', () => void runTTSHealthCheck());
  document.getElementById('tts-add-btn')?.addEventListener('click', addTTSProvider);
  document.getElementById('tts-del-btn')?.addEventListener('click', deleteTTSProvider);
  document.getElementById('tts-local-install-btn')?.addEventListener('click', () => void localTTSInstallAndStart());
  document.getElementById('tts-local-start-btn')?.addEventListener('click', () => void localTTSStart());
  document.getElementById('tts-local-stop-btn')?.addEventListener('click', () => void localTTSStop());

  document.getElementById('tts-eye-btn')?.addEventListener('click', () => {
    const input = document.getElementById('tts-apikey') as HTMLInputElement;
    const btn   = document.getElementById('tts-eye-btn') as HTMLButtonElement;
    if (input.type === 'password') { input.type = 'text';     btn.textContent = '\uD83D\uDE48'; }
    else                           { input.type = 'password'; btn.textContent = '\uD83D\uDC41'; }
  });
  // 防止面板内所有输入触发窗口拖动
  document.querySelectorAll('#settings-panel input, #settings-panel textarea').forEach((el) => {
    el.addEventListener('mousedown', (e) => e.stopPropagation());
  });
}
