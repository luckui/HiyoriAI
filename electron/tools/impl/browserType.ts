/**
 * Skill: browser_type_smart
 *
 * 两阶段输入 Skill — AI 先看到候选列表，再确认目标，最后执行输入。
 *
 * ── 解决的核心问题 ────────────────────────────────────────────────
 * 旧模式：AI 直接调 browser_type(selector, value)，猜测 selector，常常出错。
 * 一刀切模式：Skill 自动选分最高的框，AI 无法干预，可能选错。
 *
 * 新模式（两阶段）：
 *   Phase 1 — 扫描：AI 调用时只传 description + value（不传 idx）
 *             → Skill 扫描所有可见输入框，按评分排序，
 *             → 返回带分数的候选列表，AI 根据列表决定目标。
 *             → 如果最高分唯一且 ≥ 70，视为"明确匹配"，自动进入 Phase 2。
 *             → 如果存在歧义（最高分 < 70，或多个分数相同），返回候选表让 AI 选择。
 *
 *   Phase 2 — 执行：AI 确认后再调用，传 idx（从候选列表中选的编号）+ value
 *             → Skill 直接定位该 idx 对应的元素并输入，不再重新扫描。
 *
 * ── 评分策略（共性方案，与 browser_click_smart 保持一致）─────────
 * 精确匹配(100) > 子串起始(70) > 互相包含(40) → 取最高分
 * 匹配字段：placeholder / aria-label / 关联label文字 / name / id
 *
 * ── 输入方式自动选择 ─────────────────────────────────────────────
 *   - <input> / <textarea>          → Playwright fill()
 *   - <select>                      → Playwright selectOption()
 *   - contenteditable="true"（富文本）→ click() + keyboard.type()
 *
 * ── 暂停场景 ─────────────────────────────────────────────────────
 *   - 页面没有可见输入框 → ToolPauseResult
 */

import type { ToolDefinition, ToolExecuteResult, ToolPauseResult, ToolContinuationResult } from '../types';
import { browserExecution } from '../browserExecution';
import { browserSession } from '../impl/browserSession';

interface BrowserTypeSmartParams {
  /** 目标输入框的描述；支持多个同义词（逗号分隔），如"用户名,username,账号"、"密码,password,pass" */
  description?: string;
  /** Phase 2：AI 从候选列表中选择的输入框编号（扫描结果中的 idx 字段） */
  idx?: string;
  /** 要输入的文字内容 */
  value: string;
  /** 可选 CSS 选择器提示，辅助精确定位（如 "#search-input"、".login-form input"） */
  css?: string;
  /** 输入前是否先清空原有内容，默认 true */
  clear?: boolean;
}

interface InputCandidate {
  idx: string;
  score: number;
  tag: string;
  isRich: boolean;
  inputType: string;
  placeholder: string;
  ariaLabel: string;
  labelText: string;
  name: string;
  id: string;
  classes: string;
}

const browserTypeSmartSkill: ToolDefinition<BrowserTypeSmartParams> = {
  execution: browserExecution('exclusive'),
  schema: {
    type: 'function',
    function: {
      name: 'browser_type_smart',
      description:
        '【两阶段输入 Skill】在浏览器页面的指定输入框中输入文字。\n' +
        '\n' +
        '【Phase 1 — 扫描模式】传 description + value（不传 idx）：\n' +
        '  Skill 扫描页面所有可见输入框，按匹配评分排序后返回候选列表。\n' +
        '  • 如果最高分 ≥ 70 且唯一，直接执行输入（无需 Phase 2）。\n' +
        '  • 如果存在歧义（评分相同或最高分 < 70），返回带分数的候选列表，由你选择。\n' +
        '\n' +
        '【Phase 2 — 执行模式】传 idx + value（从候选列表中选的编号）：\n' +
        '  直接在该编号对应的输入框中输入，不重新扫描。\n' +
        '\n' +
        '【使用场景示例】\n' +
        '  • 第一次：browser_type_smart(description="用户名", value="xxx")\n' +
        '    → 若有歧义，返回候选列表（含评分）\n' +
        '  • 确认后：browser_type_smart(idx="0", value="xxx")\n' +
        '    → 在编号0的输入框中输入\n' +
        '\n' +
        '【何时用 css 参数】\n' +
        '  description 无法唯一定位时，提供 CSS 选择器作为额外评分加成。',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description:
              '【Phase 1】目标输入框的描述。\n' +
              '【强烈建议】同时提供多个同义词（逗号分隔），大幅提升匹配率，例如：\n' +
              '  "用户名,username,账号"  "密码,password,pass"  "搜索,search,关键词"\n' +
              '对应输入框的 placeholder / label文字 / aria-label / name / id 之一即可。\n' +
              '与 idx 二选一，idx 优先。',
          },
          idx: {
            type: 'string',
            description:
              '【Phase 2】从 Phase 1 返回的候选列表中选择的输入框编号（idx 字段的值）。' +
              '传此参数后直接执行输入，不重新扫描。与 description 二选一，idx 优先。',
          },
          value: {
            type: 'string',
            description: '要输入的文字内容。对于 <select> 下拉框，填写选项文字即可。',
          },
          css: {
            type: 'string',
            description:
              '可选 CSS 选择器提示，辅助精确定位输入框（如 "#username"、".search-input"）。Phase 1 有效。',
          },
          clear: {
            type: 'boolean',
            description: '输入前是否先清空原有内容，默认 true。',
          },
        },
        required: ['value'],
      },
    },
  },


  async execute({ description, idx, value, css, clear = true }): Promise<ToolExecuteResult> {
    const page = browserSession.currentPage;
    if (!page) return '❌ 浏览器未打开，请先调用 browser_open';

    // ══════════════════════════════════════════════════
    // Phase 2：AI 已从候选列表中选好 idx，直接执行输入
    // ══════════════════════════════════════════════════
    if (idx !== undefined) {
      const steps: string[] = [`Phase 2 — 直接输入 (idx="${idx}")`];

      // 直接查找 Phase 1 留在 DOM 上的 data-ts-idx 标记
      // 不重新扫描！重新扫描会因收集顺序/可见性判断差异导致 idx 错位
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const found: { tag: string; isRich: boolean; isSelect: boolean; label: string } | null
        = await (page.evaluate as any)(/* js */`
        (() => {
          const el = document.querySelector('[data-ts-idx="${idx}"]');
          if (!el) return null;
          const tag = el.tagName.toLowerCase();
          const isRich = el.getAttribute('contenteditable') === 'true';
          const isSelect = tag === 'select';
          const label = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || el.id || '<' + tag + '>';
          return { tag, isRich, isSelect, label };
        })()
      `);

      if (!found) {
        return {
          __pause: true,
          trace: steps,
          userMessage: `未找到编号 ${idx} 对应的输入框，页面可能已发生变化。`,
          resumeHint: '请重新调用 browser_type_smart(description=...) 重新扫描。',
        } satisfies ToolPauseResult;
      }

      steps.push(`目标: "${found.label}" (idx=${idx})`);
      return await doType(page, idx, found.tag, found.isRich, found.isSelect, found.label, value, clear, steps);
    }

    // ══════════════════════════════════════════════════
    // Phase 1：扫描全部可见输入框，评分排序，决定是否需要 AI 确认
    // ══════════════════════════════════════════════════
    if (!description) {
      return '❌ 请提供 description（输入框描述）或 idx（候选编号）';
    }

    const steps: string[] = ['Phase 1 — 扫描输入框'];
    // 支持多同义词，逗号/斜杠/分号分隔，如"用户名,username,账号"
    const descArray = (description ?? '').split(/[,，;；/|]+/).map(s => s.trim()).filter(Boolean);
    if (descArray.length === 0 && description) descArray.push(description.trim());
    const descsJson = JSON.stringify(descArray);
    const cssJson   = JSON.stringify(css || '');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candidates: InputCandidate[] = await (page.evaluate as any)(/* js */`
      (() => {
        const descs   = ${descsJson};   // 所有同义词
        const cssHint = ${cssJson};

        function scoreOne(hay, needle) {
          if (!hay || !needle) return 0;
          const h = hay.trim().toLowerCase().replace(/\\s+/g, '');
          const n = needle.trim().toLowerCase().replace(/\\s+/g, '');
          if (!h || !n) return 0;
          if (h === n) return 100;
          if (h.startsWith(n) || n.startsWith(h)) return 70;
          if (h.includes(n) || n.includes(h)) return 40;
          return 0;
        }
        function matchScore(hay) {
          if (!descs.length) return 0;
          return Math.max(...descs.map(d => scoreOne(hay, d)));
        }

        function getLabelText(el) {
          if (el.id) {
            const label = document.querySelector('label[for="' + el.id + '"]');
            if (label) return (label.innerText || '').trim().replace(/\\s+/g, ' ');
          }
          let cur = el.parentElement;
          for (let i = 0; i < 4 && cur && cur !== document.body; i++, cur = cur.parentElement) {
            if (cur.tagName.toLowerCase() === 'label') {
              return (cur.innerText || '').trim().replace(/\\s+/g, ' ');
            }
          }
          const prev = el.previousElementSibling;
          if (prev) {
            const t = (prev.innerText || prev.textContent || '').trim().replace(/\\s+/g, ' ');
            if (t.length < 20) return t;
          }
          return '';
        }

        document.querySelectorAll('[data-ts-idx]').forEach(e => e.removeAttribute('data-ts-idx'));

        const selector =
          'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset])' +
              ':not([type=image]):not([type=file]):not([type=checkbox]):not([type=radio]), ' +
          'textarea, [contenteditable="true"], select';

        const elems = Array.from(document.querySelectorAll(selector));

        let cssHintEls = [];
        if (cssHint) {
          try { cssHintEls = Array.from(document.querySelectorAll(cssHint)); } catch(e) {}
        }

        const results = [];
        let idxCounter = 0;

        elems.forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;
          const st = window.getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return;

          const placeholder = el.getAttribute('placeholder') || '';
          const ariaLabel   = el.getAttribute('aria-label')  || '';
          const name        = el.getAttribute('name')        || '';
          const id          = el.id || '';
          const tag         = el.tagName.toLowerCase();
          const inputType   = el.getAttribute('type') || '';
          const isRich      = el.getAttribute('contenteditable') === 'true';
          const labelText   = getLabelText(el);
          const classes     = [...el.classList].slice(0, 8).join(' ');

          const fieldScore = Math.max(
            matchScore(placeholder),
            matchScore(ariaLabel),
            matchScore(labelText),
            matchScore(name),
            matchScore(id),
          );

          const hintBonus = cssHintEls.includes(el) ? 10 : 0;
          const score = fieldScore + hintBonus;

          const idx = String(idxCounter++);
          el.setAttribute('data-ts-idx', idx);

          results.push({ idx, score, tag, isRich, inputType, placeholder, ariaLabel, labelText, name, id, classes });
        });

        return results.sort((a, b) => b.score - a.score);
      })()
    `);

    steps.push(`扫描完成: 找到 ${candidates.length} 个输入框`);

    // ── 无输入框 → 暂停 ──────────────────────────────────────────
    if (candidates.length === 0) {
      await cleanupIdx(page);
      return {
        __pause: true,
        trace: steps,
        userMessage: '当前页面没有找到任何可见的输入框，页面可能尚未加载完成。',
        resumeHint: '请调用 browser_screenshot 确认页面状态后重试。',
      } satisfies ToolPauseResult;
    }

    const best = candidates[0];
    const bestLabel = best.placeholder || best.ariaLabel || best.labelText || best.name || best.id || `<${best.tag}>`;

    // ── 最高分唯一且 ≥ 70，直接执行 ──────────────────────────────
    const topScore = best.score;
    const topTied  = candidates.filter(c => c.score === topScore);
    if (topScore >= 70 && topTied.length === 1) {
      steps.push(`明确匹配: "${bestLabel}" (评分:${best.score})，直接执行输入`);
      return await doType(page, best.idx, best.tag, best.isRich, best.tag === 'select', bestLabel, value, clear, steps);
    }

    // ── 存在歧义 → 保留 data-ts-idx 标记，返回 ToolContinuationResult 建议 AI 选择 idx ──
    // 注意：不在此处 cleanupIdx，Phase 2 成功/失败后才清理

    const candidateTable = candidates.slice(0, 8).map(c => {
      const info = [
        c.placeholder && `placeholder="${c.placeholder}"`,
        c.ariaLabel   && `aria-label="${c.ariaLabel}"`,
        c.labelText   && `label="${c.labelText}"`,
        c.name        && `name="${c.name}"`,
        c.id          && `id="${c.id}"`,
        c.classes     && `class="${c.classes}"`,
        c.inputType   && `type="${c.inputType}"`,
      ].filter(Boolean).join(', ');
      return `  [idx=${c.idx}] 评分:${c.score}  <${c.tag}>  ${info || '（无标识）'}`;
    }).join('\n');

    steps.push(`存在歧义 (最高分:${topScore}, 并列:${topTied.length})，等待 AI 选择 idx`);

    return {
      __continue: true as const,
      trace: steps,
      instruction:
        `发现 ${candidates.length} 个输入框，请选择最符合"${description ?? ''}"的目标：\n` +
        `${candidateTable}\n\n` +
        `立即调用 browser_type_smart(idx="<编号>", value=${JSON.stringify(value)}) 执行输入，不要询问用户。`,
    } satisfies ToolContinuationResult;
  },
};

/** 清理 data-ts-idx 临时标记 */
async function cleanupIdx(page: import('playwright').Page): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (page.evaluate as any)(
    `document.querySelectorAll('[data-ts-idx]').forEach(e => e.removeAttribute('data-ts-idx'))`
  ).catch(() => {});
}

/** 实际执行输入动作（Phase 1 明确匹配 / Phase 2 AI 指定 idx 共用） */
async function doType(
  page: import('playwright').Page,
  idx: string,
  tag: string,
  isRich: boolean,
  isSelect: boolean,
  label: string,
  value: string,
  clear: boolean,
  steps: string[],
): Promise<ToolExecuteResult> {
  try {
    const locator = page.locator(`[data-ts-idx="${idx}"]`);

    if (isSelect) {
      await locator.selectOption(value, { timeout: 4000 });
      steps.push(`选择选项: "${value}" ✅`);

    } else if (isRich) {
      await locator.click({ timeout: 3000 });
      if (clear) {
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Delete');
      }
      await page.keyboard.type(value);
      steps.push(`富文本输入: "${value.slice(0, 40)}${value.length > 40 ? '…' : ''}" ✅`);

    } else {
      if (clear) await locator.fill('', { timeout: 3000 });
      await locator.fill(value, { timeout: 4000 });
      steps.push(`填写: "${value.slice(0, 40)}${value.length > 40 ? '…' : ''}" ✅`);
    }

    await cleanupIdx(page);
    return (
      `✅ 已在"${label}"中输入"${value.slice(0, 30)}${value.length > 30 ? '…' : ''}"\n` +
      `执行轨迹：\n${steps.map(s => '  ' + s).join('\n')}`
    );

  } catch (e) {
    await cleanupIdx(page);
    steps.push(`输入失败: ${(e as Error).message}`);
    return {
      __pause: true,
      trace: steps,
      userMessage: `找到了目标输入框"${label}"，但输入时发生错误：${(e as Error).message}。`,
      resumeHint: `可调用 browser_screenshot 查看页面状态，或提供更精确的 css 参数后重试。`,
    } satisfies ToolPauseResult;
  }
}

export default browserTypeSmartSkill;
