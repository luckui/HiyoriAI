/** Skills 设置：全局开关与展示模式、按集合启用/覆盖展示模式、逐个勾选技能、导入/删除集合 */

import type { CollectionInfo, SkillEntry, SkillListingMode, SkillsConfig } from './types';
import { clearSettingsDirty, markSettingsDirty, registerSection } from './sections';

/** 当前面板里正在编辑的配置草稿（点保存或离开时写回） */
let currentDraft: SkillsConfig | null = null;
let saveButton: HTMLButtonElement | null = null;

async function save(): Promise<void> {
  if (!currentDraft || !window.skillsAPI) return;
  const btn = saveButton;
  try {
    await window.skillsAPI.saveConfig(currentDraft);
    clearSettingsDirty('skills');
    if (btn) btn.textContent = '✓ 已保存';
  } catch {
    if (btn) btn.textContent = '保存失败';
  }
  if (btn) setTimeout(() => { btn.textContent = '保存设置'; }, 2000);
}

async function load(): Promise<void> {
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
  const draft: SkillsConfig = structuredClone(config);
  currentDraft = draft;

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
  const collRemovableSet = new Set(collections.filter((c) => c.removable).map((c) => c.id));

  // All collection-mode selects' "inherit" options — updated immediately when global mode changes
  const inheritOpts: HTMLOptionElement[] = [];

  container.innerHTML = '';

  // ── 头部操作行：导入按钮 ──────────────────────────────
  const headerRow = document.createElement('div');
  headerRow.style.cssText = 'display:flex;justify-content:flex-end;align-items:center;padding:0 0 6px;gap:8px';
  const importBtn = document.createElement('button');
  importBtn.className = 's-small-btn';
  importBtn.textContent = '⬆️ 导入 Skill 文件夹';
  const importHint = document.createElement('span');
  importHint.className = 's-hint';
  importHint.style.cssText = 'flex:1;transition:color .2s';
  headerRow.append(importHint, importBtn);
  container.appendChild(headerRow);

  importBtn.addEventListener('click', async () => {
    importBtn.disabled = true;
    importBtn.textContent = '选择中…';
    importHint.textContent = '';
    try {
      const res = await window.skillsAPI!.importFolder();
      if (res.canceled) {
        importHint.textContent = '';
      } else if (res.success) {
        importHint.style.color = 'var(--accent, #7aa2f7)';
        importHint.textContent = `✓ ${res.message}`;
        // 导入成功后刷新整个面板，新集合/技能将自动出现
        await load();
      } else {
        importHint.style.color = '#f7768e';
        importHint.textContent = `✗ ${res.message}`;
      }
    } catch (e) {
      importHint.style.color = '#f7768e';
      importHint.textContent = `✗ 导入失败: ${String(e)}`;
    } finally {
      importBtn.disabled = false;
      importBtn.textContent = '⬆️ 导入 Skill 文件夹';
    }
  });

  // ── 全局设置 ────────────────────────────────────────
  const globalSec = skillsMkSection('全局设置');

  globalSec.appendChild(skillsMkToggleRow(
    '注入技能目录',
    '在 agent 模式下将技能注入系统提示词（chat 模式始终不注入）',
    draft.enabled,
    (v) => {
      markSettingsDirty('skills');
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
    (v) => {
      markSettingsDirty('skills');
      draft.listingMode = v as SkillListingMode;
      // Sync every collection's "inherit" placeholder text immediately
      const inherited = `继承全局（${skillsModeLabel(draft.listingMode)}）`;
      for (const opt of inheritOpts) { opt.textContent = inherited; }
    },
  ));

  container.appendChild(globalSec);

  // ── Per-collection cards ─────────────────────────────

  for (const [collId, skills] of collMap) {
    const titleHtml =
      (collDisplayMap.get(collId) ?? `📦 ${collId}`) +
      `&nbsp;<span style="font-weight:400;opacity:.6;font-size:10px">${skills.length} 个技能</span>`;
    const collSec = skillsMkSection(titleHtml);
    collSec.classList.add('skills-coll-section');

    // 可移除的集合在卡片标题右上角显示×按钮
    if (collRemovableSet.has(collId)) {
      const h3 = collSec.querySelector('h3')!;
      h3.style.cssText += ';display:flex;align-items:center;justify-content:space-between;gap:6px';
      const removeBtn = document.createElement('button');
      removeBtn.className = 's-small-btn';
      removeBtn.title = '移除此集合';
      removeBtn.style.cssText = 'padding:2px 7px;font-size:13px;color:#f7768e;border-color:transparent;background:transparent;flex-shrink:0;opacity:.7';
      removeBtn.textContent = '\u2715';
      removeBtn.addEventListener('mouseenter', () => { removeBtn.style.opacity = '1'; });
      removeBtn.addEventListener('mouseleave', () => { removeBtn.style.opacity = '.7'; });
      removeBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const displayName = collDisplayMap.get(collId) ?? collId;
        // eslint-disable-next-line no-alert
        if (!confirm(`确定要删除集合「${displayName}」吗？\n此操作不可撤销，将永久删除该集合的所有文件。`)) return;
        removeBtn.disabled = true;
        removeBtn.textContent = '…';
        const res = await window.skillsAPI!.removeCollection(collId);
        if (res.success) {
          await load();
        } else {
          // eslint-disable-next-line no-alert
          alert(`删除失败: ${res.message}`);
          removeBtn.disabled = false;
          removeBtn.textContent = '\u2715';
        }
      });
      h3.appendChild(removeBtn);
    }

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
      markSettingsDirty('skills');
      if (v) {
        draft.disabledCollections = draft.disabledCollections.filter((c) => c !== collId);
      } else if (!draft.disabledCollections.includes(collId)) {
        draft.disabledCollections.push(collId);
      }
      skillsArea.style.opacity = v ? '1' : '0.4';
      skillsArea.style.pointerEvents = v ? '' : 'none';
    }));

    // Collection mode override
    const modeRow = skillsMkSelectRow(
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
        markSettingsDirty('skills');
        if (v === '') { delete draft.collectionModes[collId]; }
        else { draft.collectionModes[collId] = v as SkillListingMode; }
      },
    );
    // Register the inherit option so it stays in sync with global mode changes
    const inheritOpt = modeRow.querySelector<HTMLOptionElement>('option[value=""]');
    if (inheritOpt) inheritOpts.push(inheritOpt);
    collBody.appendChild(modeRow);

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
        markSettingsDirty('skills');
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
  saveRow.className = 's-save-row';
  const saveBtn = document.createElement('button');
  saveBtn.className = 's-save-btn';
  saveBtn.textContent = '保存设置';
  saveButton = saveBtn;
  saveBtn.addEventListener('click', () => void save());
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

export function initSkillsPanel(): void {
  registerSection('skills', { load, save });
}
