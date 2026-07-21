import { LAppDelegate } from './lappdelegate';

type AvatarMotionSlot = 'idle' | 'touch' | 'thinking' | 'speaking';
const ACTIVE_MOTION_SLOTS: AvatarMotionSlot[] = ['idle', 'touch'];
const BUILTIN_AVATAR_ID = 'builtin:hiyori_pro';

interface AvatarMotionResource {
  id: string;
  group: string;
  index: number;
  file: string;
  label: string;
}

interface AvatarExpressionResource {
  id: string;
  name: string;
  file: string;
}

interface Live2DModelProfile {
  id: string;
  name: string;
  sourceDir: string;
  modelJsonName: string;
  importedAt?: number;
  motions: AvatarMotionResource[];
  expressions: AvatarExpressionResource[];
  hitAreas: Array<{ id: string; name: string }>;
  lipSyncIds: string[];
  mapping: {
    motions: Record<AvatarMotionSlot, string[]>;
    expressions: Record<string, string>;
  };
  unassignedMotionIds: string[];
}

interface AvatarConfig {
  activeModelId: string;
  models: Live2DModelProfile[];
}

declare global {
  interface Window {
    avatarAPI?: {
      get(): Promise<AvatarConfig>;
      importFolder(): Promise<{
        ok: boolean;
        canceled?: boolean;
        detail?: string;
        config?: AvatarConfig;
        profile?: Live2DModelProfile;
        baseUrl?: string;
      }>;
      save(cfg: AvatarConfig): Promise<AvatarConfig>;
      select(modelId: string): Promise<AvatarConfig>;
      delete(modelId: string): Promise<AvatarConfig>;
      onConfigChanged(cb: (cfg: AvatarConfig) => void): () => void;
    };
  }
}

const SLOT_LABELS: Record<AvatarMotionSlot, { title: string; desc: string }> = {
  idle: { title: '待机', desc: '空闲时循环播放' },
  touch: { title: '点击', desc: '用户触摸角色时播放' },
  thinking: { title: '思考中', desc: '等待回复或工具结果时播放' },
  speaking: { title: '说话中', desc: '回答和 TTS 播放时使用' },
};

let avatarConfig: AvatarConfig | null = null;

export function initAvatarStudio(): void {
  document.getElementById('avatar-import-btn')?.addEventListener('click', () => void importAvatarFolder());
  document.getElementById('avatar-save-btn')?.addEventListener('click', () => void saveAvatarConfig());
  document.getElementById('avatar-reset-btn')?.addEventListener('click', resetActiveMapping);
  window.avatarAPI?.onConfigChanged((cfg) => {
    avatarConfig = cfg;
    renderAvatarStudio();
  });
  void refreshAvatarStudio();
}

export async function refreshAvatarStudio(): Promise<void> {
  if (!window.avatarAPI) return;
  avatarConfig = await window.avatarAPI.get();
  renderAvatarStudio();
  const profile = getActiveProfile();
  if (profile) applyProfile(profile);
}

async function importAvatarFolder(): Promise<void> {
  const btn = document.getElementById('avatar-import-btn') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '导入中...';
  }
  try {
    const result = await window.avatarAPI?.importFolder();
    if (result?.ok && result.config && result.profile) {
      avatarConfig = result.config;
      renderAvatarStudio();
      applyProfile(result.profile, result.baseUrl);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '导入模型文件夹';
    }
  }
}

async function saveAvatarConfig(): Promise<void> {
  if (!avatarConfig || !window.avatarAPI) return;
  const btn = document.getElementById('avatar-save-btn') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '保存中...';
  }
  try {
    avatarConfig = await window.avatarAPI.save(avatarConfig);
    const profile = getActiveProfile();
    if (profile) applyProfile(profile);
    if (btn) btn.textContent = '已保存';
    setTimeout(() => { if (btn) btn.textContent = '保存设置'; }, 1400);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function resetActiveMapping(): void {
  const profile = getActiveProfile();
  if (!profile) return;
  const idle = profile.motions.filter((motion) => /^idle$/i.test(motion.group)).map((motion) => motion.id);
  const touch = profile.motions
    .filter((motion) => /^tap(body)?$/i.test(motion.group) || /^tap@body$/i.test(motion.group))
    .map((motion) => motion.id);
  profile.mapping.motions = { idle, touch, thinking: [], speaking: [] };
  profile.unassignedMotionIds = profile.motions
    .map((motion) => motion.id)
    .filter((id) => !new Set([...idle, ...touch]).has(id));
  renderAvatarStudio();
}

function renderAvatarStudio(): void {
  const profile = getActiveProfile();
  renderCurrent(profile);
  renderModelLibrary();
  renderMotionSlots(profile);
  renderUnassignedMotions(profile);
  renderExpressions(profile);
}

function renderCurrent(profile: Live2DModelProfile | null): void {
  const section = document.getElementById('avatar-current-section');
  if (!section) return;
  if (!profile) {
    section.innerHTML = `
      <div class="avatar-section-head">
        <h3>当前模型</h3>
        <span class="avatar-badge">Hiyori_pro</span>
      </div>
      <div class="avatar-empty-state">当前使用内置模型。导入模型文件夹后可配置动作与表情映射。</div>
    `;
    return;
  }
  section.innerHTML = `
    <div class="avatar-section-head">
      <h3>当前模型</h3>
      <span class="avatar-badge">${escapeHtml(profile.name)}</span>
    </div>
    <div class="avatar-capability-grid">
      <div><span>动作</span><strong>${profile.motions.length} 个</strong></div>
      <div><span>表情</span><strong>${profile.expressions.length ? `${profile.expressions.length} 个` : '未发现'}</strong></div>
      <div><span>点击区域</span><strong>${escapeHtml(profile.hitAreas.map((area) => area.name).join(', ') || '-')}</strong></div>
    </div>
  `;
}

function renderModelLibrary(): void {
  const section = document.getElementById('avatar-model-library-section');
  if (!section || !avatarConfig) return;
  const activeId = avatarConfig.activeModelId;
  section.innerHTML = `
    <div class="avatar-section-head">
      <h3>模型库</h3>
      <span class="avatar-muted">${avatarConfig.models.length} 个模型</span>
    </div>
    <div class="avatar-model-list">
      ${avatarConfig.models.map((model) => {
        const isActive = model.id === activeId;
        const isBuiltin = model.id === BUILTIN_AVATAR_ID;
        return `
          <div class="avatar-model-card ${isActive ? 'active' : ''}">
            <div class="avatar-model-main">
              <div class="avatar-model-title-row">
                <strong>${escapeHtml(model.name)}</strong>
                ${isActive ? '<span class="avatar-badge">正在使用</span>' : ''}
              </div>
              <span>${escapeHtml(modelSummary(model, isBuiltin))}</span>
            </div>
            <div class="avatar-model-actions">
              ${isActive ? '' : `<button class="avatar-small-btn" data-select-model="${escapeAttr(model.id)}" type="button">使用</button>`}
              ${isBuiltin ? '' : `<button class="avatar-small-btn danger" data-delete-model="${escapeAttr(model.id)}" type="button">删除</button>`}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
  section.querySelectorAll<HTMLButtonElement>('[data-select-model]').forEach((btn) => {
    btn.addEventListener('click', () => void selectModel(btn.dataset.selectModel ?? ''));
  });
  section.querySelectorAll<HTMLButtonElement>('[data-delete-model]').forEach((btn) => {
    btn.addEventListener('click', () => void deleteModel(btn.dataset.deleteModel ?? ''));
  });
}

function renderMotionSlots(profile: Live2DModelProfile | null): void {
  const section = document.getElementById('avatar-motion-section');
  if (!section) return;
  if (!profile) {
    section.innerHTML = `<div class="avatar-empty-state">导入模型后可配置动作映射。</div>`;
    return;
  }
  const motionById = new Map(profile.motions.map((motion) => [motion.id, motion]));
  section.innerHTML = `
    <div class="avatar-section-head">
      <h3>动作映射</h3>
      <span class="avatar-muted">按场景播放</span>
    </div>
    <div class="avatar-slot-list">
      ${ACTIVE_MOTION_SLOTS.map((slot) => {
        const meta = SLOT_LABELS[slot];
        const ids = profile.mapping.motions[slot] ?? [];
        return `
          <div class="avatar-slot" data-slot="${slot}">
            <div class="avatar-slot-main">
              <span class="avatar-slot-title">${meta.title}</span>
              <span class="avatar-slot-desc">${meta.desc}</span>
            </div>
            <div class="avatar-chip-row">
              ${ids.length ? ids.map((id) => renderMotionChip(motionById.get(id), slot)).join('') : '<button class="avatar-chip ghost" type="button">未配置</button>'}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
  section.querySelectorAll<HTMLButtonElement>('[data-preview-motion]').forEach((btn) => {
    btn.addEventListener('click', () => previewMotion(btn.dataset.previewMotion ?? ''));
  });
  section.querySelectorAll<HTMLButtonElement>('[data-remove-motion]').forEach((btn) => {
    btn.addEventListener('click', () => removeMotionFromSlot(btn.dataset.slot as AvatarMotionSlot, btn.dataset.removeMotion ?? ''));
  });
}

function renderUnassignedMotions(profile: Live2DModelProfile | null): void {
  const section = document.getElementById('avatar-unassigned-motion-section');
  if (!section) return;
  if (!profile) {
    section.innerHTML = '';
    return;
  }
  const assigned = new Set(ACTIVE_MOTION_SLOTS.flatMap((slot) => profile.mapping.motions[slot] ?? []));
  const unassigned = profile.motions.filter((motion) => !assigned.has(motion.id));
  section.innerHTML = `
    <div class="avatar-section-head">
      <h3>未分配动作</h3>
      <span class="avatar-muted">预览后加入槽位</span>
    </div>
    <div class="avatar-resource-list">
      ${unassigned.length ? unassigned.map((motion) => `
        <div class="avatar-resource-item">
          <div>
            <strong>${escapeHtml(motion.label)}</strong>
            <span>${escapeHtml(motion.file)}</span>
          </div>
          <div class="avatar-resource-actions">
            <button class="avatar-small-btn" data-preview-motion="${escapeAttr(motion.id)}" type="button">预览</button>
            <select class="avatar-slot-select" data-add-motion="${escapeAttr(motion.id)}">
              <option value="">加入...</option>
              <option value="idle">待机</option>
              <option value="touch">点击</option>
            </select>
          </div>
        </div>
      `).join('') : '<div class="avatar-empty-state">所有动作都已经分配到槽位。</div>'}
    </div>
  `;
  section.querySelectorAll<HTMLButtonElement>('[data-preview-motion]').forEach((btn) => {
    btn.addEventListener('click', () => previewMotion(btn.dataset.previewMotion ?? ''));
  });
  section.querySelectorAll<HTMLSelectElement>('[data-add-motion]').forEach((select) => {
    select.addEventListener('change', () => {
      const slot = select.value as AvatarMotionSlot;
      if (!slot) return;
      addMotionToSlot(slot, select.dataset.addMotion ?? '');
      select.value = '';
    });
  });
}

function renderExpressions(profile: Live2DModelProfile | null): void {
  const section = document.getElementById('avatar-expression-section');
  if (!section) return;
  if (!profile || profile.expressions.length === 0) {
    section.innerHTML = `
      <div class="avatar-section-head">
        <h3>表情映射</h3>
        <span class="avatar-muted">可为空</span>
      </div>
      <div class="avatar-empty-state">当前模型没有 expression 文件。可以继续使用模型切换、动作映射和口型同步。</div>
    `;
    return;
  }
  section.innerHTML = `
    <div class="avatar-section-head">
      <h3>表情映射</h3>
      <span class="avatar-muted">预览后决定用途</span>
    </div>
    <div class="avatar-resource-list">
      ${profile.expressions.map((expression) => `
        <div class="avatar-resource-item">
          <div>
            <strong>${escapeHtml(expression.name)}</strong>
            <span>${escapeHtml(expression.file)}</span>
          </div>
          <button class="avatar-small-btn" data-preview-expression="${escapeAttr(expression.id)}" type="button">预览</button>
        </div>
      `).join('')}
    </div>
  `;
  section.querySelectorAll<HTMLButtonElement>('[data-preview-expression]').forEach((btn) => {
    btn.addEventListener('click', () => previewExpression(btn.dataset.previewExpression ?? ''));
  });
}

function renderMotionChip(motion: AvatarMotionResource | undefined, slot: AvatarMotionSlot): string {
  if (!motion) return '';
  return `
    <span class="avatar-motion-chip">
      <button class="avatar-chip" data-preview-motion="${escapeAttr(motion.id)}" type="button">${escapeHtml(motion.label)}</button>
      <button class="avatar-chip-remove" data-slot="${slot}" data-remove-motion="${escapeAttr(motion.id)}" type="button">×</button>
    </span>
  `;
}

function addMotionToSlot(slot: AvatarMotionSlot, motionId: string): void {
  if (!ACTIVE_MOTION_SLOTS.includes(slot)) return;
  const profile = getActiveProfile();
  if (!profile || !motionId) return;
  const ids = profile.mapping.motions[slot];
  if (!ids.includes(motionId)) ids.push(motionId);
  renderAvatarStudio();
}

function removeMotionFromSlot(slot: AvatarMotionSlot, motionId: string): void {
  if (!ACTIVE_MOTION_SLOTS.includes(slot)) return;
  const profile = getActiveProfile();
  if (!profile || !motionId) return;
  profile.mapping.motions[slot] = profile.mapping.motions[slot].filter((id) => id !== motionId);
  renderAvatarStudio();
}

async function selectModel(modelId: string): Promise<void> {
  if (!modelId || !window.avatarAPI) return;
  avatarConfig = await window.avatarAPI.select(modelId);
  renderAvatarStudio();
  const profile = getActiveProfile();
  if (profile) applyProfile(profile);
}

async function deleteModel(modelId: string): Promise<void> {
  if (!modelId || modelId === BUILTIN_AVATAR_ID || !window.avatarAPI) return;
  const target = avatarConfig?.models.find((model) => model.id === modelId);
  if (!target) return;
  const ok = window.confirm(`删除模型「${target.name}」？导入的模型文件副本也会被删除。`);
  if (!ok) return;
  avatarConfig = await window.avatarAPI.delete(modelId);
  renderAvatarStudio();
  const profile = getActiveProfile();
  if (profile) applyProfile(profile);
}

function previewMotion(motionId: string): void {
  LAppDelegate.getInstance().getFirstSubdelegate()?.getLive2DManager().previewMotion(motionId);
}

function previewExpression(expressionId: string): void {
  LAppDelegate.getInstance().getFirstSubdelegate()?.getLive2DManager().previewExpression(expressionId);
}

function applyProfile(profile: Live2DModelProfile, baseUrl?: string): void {
  const modelUrl = baseUrl ?? modelBaseUrl(profile.id);
  LAppDelegate.getInstance().getFirstSubdelegate()?.getLive2DManager()
    .loadAvatarModel(modelUrl, profile.modelJsonName, profile.mapping);
}

function getActiveProfile(): Live2DModelProfile | null {
  if (!avatarConfig) return null;
  return avatarConfig.models.find((model) => model.id === avatarConfig?.activeModelId) ?? null;
}

function modelBaseUrl(modelId: string): string {
  return `hiyori-avatar://model/${encodeURIComponent(modelId)}/`;
}

function modelSummary(model: Live2DModelProfile, isBuiltin: boolean): string {
  const source = isBuiltin ? '内置模型' : `导入于 ${formatDate(model.importedAt)}`;
  return `${source} · 动作 ${model.motions.length} · 表情 ${model.expressions.length}`;
}

function formatDate(ts: number | undefined): string {
  if (!ts) return '未知时间';
  const date = new Date(ts);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch] ?? ch));
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
