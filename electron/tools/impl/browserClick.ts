/**
 * Skill: browser_click_smart
 *
 * 两阶段点击 Skill — AI 先看到候选列表再确认点击，避免盲猜。
 *
 * ── Phase 1（扫描）传 text 不传 idx ─────────────────────────────
 *   扫描全部可见可点击元素（button / a / div[role=button] / 伪按钮等），
 *   按多同义词评分排序：
 *   • 最高分 ≥ 70 且唯一 → 直接点击（免 Phase 2）
 *   • 有歧义或评分不足 → 返回带分数的候选列表（含完整 class 信息），AI 从中选 idx
 *
 * ── Phase 2（执行）传 idx ────────────────────────────────────────
 *   AI 从候选列表中选好编号后直接点击对应元素。
 *   内部点击策略（自动升级）：
 *     1. Playwright locator.click()
 *     2. Playwright locator.click({ force: true })
 *     3. JS el.click() via evaluate
 *
 * ── 评分策略（多同义词，与 browser_type_smart 保持一致）──────────
 *   精确匹配(100) > 首词精确(80) > 任意词精确(70) > 前缀(50) > 包含(20)
 *   匹配字段：innerText / aria-label / title / id / className（无文字时回退 class）
 */

import type { ToolDefinition, ToolExecuteResult, ToolPauseResult, ToolContinuationResult } from '../types';
import { browserSession } from '../impl/browserSession';
import { readPageSummary } from '../impl/browser';

interface BrowserClickSmartParams {
  /** 按钮/链接描述；支持多同义词（逗号/斜杠/分号分隔），如"搜索,search,查找" */
  text?: string;
  /** Phase 2：AI 从候选列表中选择的元素编号（候选列表中的 idx 字段） */
  idx?: string;
  /** 可选 CSS 选择器提示，命中时额外加分（如 ".nav-search-btn"、"#submit"） */
  css?: string;
  /** 是否精确匹配文字，默认 false */
  exact?: boolean;
}

interface ClickCandidate {
  idx: string;
  score: number;
  tag: string;
  text: string;
  classes: string;
  id: string;
  href: string;
  ariaLabel: string;
  title: string;
}

// ── 等待导航稳定 ──────────────────────────────────────────
async function waitSettle(ms = 3000): Promise<void> {
  const page = browserSession.currentPage;
  if (!page) return;
  await page.waitForLoadState('domcontentloaded', { timeout: ms }).catch(() => {});
}

/** 清理 data-ts-idx 临时标记 */
async function cleanupIdx(page: import('playwright').Page): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (page.evaluate as any)(
    `document.querySelectorAll('[data-ts-idx]').forEach(e => e.removeAttribute('data-ts-idx'))`
  ).catch(() => {});
}

/**
 * 扫描所有可见可点击元素，多同义词评分，分配 data-ts-idx，返回排序后候选列表
 */
async function scanCandidates(
  page: import('playwright').Page,
  queries: string[],
  cssHint: string,
): Promise<ClickCandidate[]> {
  const queriesJson = JSON.stringify(queries);
  const cssJson = JSON.stringify(cssHint);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (page.evaluate as any)(/* js */`
    (() => {
      const qs = ${queriesJson};
      const cssHint = ${cssJson};

      function scoreOne(hay, q) {
        if (!hay || !q) return 0;
        const h = hay.trim().replace(/\\s+/g, ' ').toLowerCase();
        const n = q.trim().toLowerCase();
        if (!h || !n) return 0;
        if (h === n) return 100;
        const words = h.split(/[\\s\\/|,，、·\\-–—]+/).map(w => w.trim()).filter(Boolean);
        if (words[0] === n) return 80;
        if (words.some(w => w === n)) return 70;
        if (h.startsWith(n)) return 50;
        if (h.includes(n)) return 20;
        return 0;
      }
      function matchScore(hay) {
        if (!qs.length) return 0;
        return Math.max(...qs.map(q => scoreOne(hay, q)));
      }
      function isVisible(el) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const st = window.getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
      }

      // 清理上次标记
      document.querySelectorAll('[data-ts-idx]').forEach(e => e.removeAttribute('data-ts-idx'));

      const seen = new Set();
      const raw = [];

      // 1. 标准可点击元素
      document.querySelectorAll(
        'button, a[href], [role="button"], input[type="submit"], input[type="button"], ' +
        'input[type="reset"], [class*="btn"], [class*="button"], [class*="submit"]'
      ).forEach(el => { if (isVisible(el)) raw.push(el); });

      // 2. div/span/li/i/svg 伪按钮（cursor:pointer / tabindex / role / btn类名）
      document.querySelectorAll('div, span, li, i, svg').forEach(el => {
        if (raw.includes(el) || !isVisible(el)) return;
        const role = (el.getAttribute('role') || '').toLowerCase();
        const st = window.getComputedStyle(el);
        const cls = (el.className || '').toString();
        if (
          role === 'button' || el.hasAttribute('tabindex') || st.cursor === 'pointer' ||
          /(^|\\s)(btn|button|submit|search|clickable|icon)(\\s|$|-)/i.test(cls)
        ) raw.push(el);
      });

      // 3. 文字节点Walker → 向上找可点击祖先（修复 <button><span>文字</span></button> 嵌套）
      function findClickableAncestor(el) {
        let cur = el;
        while (cur && cur !== document.body) {
          const tag = cur.tagName.toLowerCase();
          const role = (cur.getAttribute('role') || '').toLowerCase();
          if (tag === 'button' || tag === 'a' || role === 'button' || cur.onclick !== null) return cur;
          cur = cur.parentElement;
        }
        return null;
      }
      if (qs.length > 0) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const txt = (node.textContent || '').trim();
          if (!txt || matchScore(txt) === 0) continue;
          const parent = node.parentElement;
          if (!parent || !isVisible(parent)) continue;
          const anc = findClickableAncestor(parent) || parent;
          if (isVisible(anc) && !raw.includes(anc)) raw.push(anc);
        }
      }

      let cssHintEl = null;
      if (cssHint) { try { cssHintEl = document.querySelector(cssHint); } catch(e) {} }

      let idxCounter = 0;
      const results = [];

      raw.forEach(el => {
        if (!isVisible(el)) return;
        const tag       = el.tagName.toLowerCase();
        const text      = (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
        const ariaLabel = el.getAttribute('aria-label') || '';
        const title     = el.getAttribute('title')     || '';
        const id        = el.id                        || '';
        const href      = tag === 'a' ? (el.href || '') : '';
        const classes   = [...el.classList].slice(0, 8).join(' ');

        // 去重（tag + id + text + classes 前缀）
        const uid = tag + '||' + id + '||' + text.slice(0, 30) + '||' + classes.slice(0, 20);
        if (seen.has(uid)) return;
        seen.add(uid);

        // 有文字/ariaLabel/title → 文字评分；无文字 → class名评分（-10惩罚，覆盖纯图标按钮）
        const textScore = Math.max(
          matchScore(text), matchScore(ariaLabel), matchScore(title), matchScore(id)
        );
        const clsScore = (text || ariaLabel || title) ? 0 : Math.max(0, matchScore(classes) - 10);
        const cssBonus = cssHintEl === el ? 15 : 0;
        const score    = Math.max(textScore, clsScore) + cssBonus;

        const idx = String(idxCounter++);
        el.setAttribute('data-ts-idx', idx);
        results.push({ idx, score, tag, text, classes, id, href, ariaLabel, title });
      });

      return results.sort((a, b) => b.score - a.score);
    })()
  `);
}

/**
 * 通过 idx 重新定位元素并执行点击（三级策略：标准→force→JS）
 */
async function executeClickByIdx(
  page: import('playwright').Page,
  idx: string,
  label: string,
  steps: string[],
): Promise<ToolExecuteResult> {
  // 直接检查 Phase 1 扫描时留在 DOM 上的 data-ts-idx 标记
  // 不重新扫描！重新扫描会因收集顺序/可见性判断差异导致 idx 错位
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const found: boolean = await (page.evaluate as any)(
    `!!document.querySelector('[data-ts-idx="${idx}"]')`
  );

  if (!found) {
    await cleanupIdx(page);
    return {
      __pause: true,
      trace: steps,
      userMessage: `未找到编号 ${idx} 对应的元素，页面可能已发生变化。`,
      resumeHint: '请重新调用 browser_click_smart(text=...) 重新扫描。',
    } satisfies ToolPauseResult;
  }

  // 策略 1: Playwright 标准点击
  try {
    await page.locator(`[data-ts-idx="${idx}"]`).first().click({ timeout: 3000 });
    steps.push(`Playwright click: ✅`);
    await cleanupIdx(page);
    await waitSettle(2000);
    const pageSummary = await readPageSummary('brief');
    return `✅ 已点击"${label}"\n执行轨迹：\n${steps.map(s => '  ' + s).join('\n')}\n\n【点击后页面概览】\n${pageSummary}`;
  } catch (e) {
    steps.push(`Playwright click: ❌ ${(e as Error).message.slice(0, 80)}`);
  }

  // 策略 2: Force click
  try {
    await page.locator(`[data-ts-idx="${idx}"]`).first().click({ force: true, timeout: 3000 });
    steps.push(`Force click: ✅`);
    await cleanupIdx(page);
    await waitSettle(2000);
    const pageSummary = await readPageSummary('brief');
    return `✅ 已点击"${label}"\n执行轨迹：\n${steps.map(s => '  ' + s).join('\n')}\n\n【点击后页面概览】\n${pageSummary}`;
  } catch (e) {
    steps.push(`Force click: ❌ ${(e as Error).message.slice(0, 80)}`);
  }

  // 策略 3: JS el.click()
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (page.evaluate as any)(`
      const el = document.querySelector('[data-ts-idx="${idx}"]');
      if (!el) throw new Error('元素已消失');
      el.click();
    `);
    steps.push(`JS el.click(): ✅`);
    await cleanupIdx(page);
    await waitSettle(2000);
    const pageSummary = await readPageSummary('brief');
    return `✅ 已点击"${label}"\n执行轨迹：\n${steps.map(s => '  ' + s).join('\n')}\n\n【点击后页面概览】\n${pageSummary}`;
  } catch (e) {
    steps.push(`JS el.click(): ❌ ${(e as Error).message.slice(0, 80)}`);
  }

  await cleanupIdx(page);
  return {
    __pause: true,
    trace: steps,
    userMessage: `找到了"${label}"但所有点击策略均失败，可能被遮挡或不可交互。`,
    resumeHint: '请调用 browser_screenshot 查看页面状态，或手动操作后告知。',
  } satisfies ToolPauseResult;
}

// ── 主 Skill ──────────────────────────────────────────────────────

const browserClickSmartSkill: ToolDefinition<BrowserClickSmartParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'browser_click_smart',
      description:
        '【两阶段点击 Skill】点击浏览器页面上的按钮、链接或可交互元素。\n' +
        '\n' +
        '【Phase 1 — 扫描模式】传 text（不传 idx）：\n' +
        '  扫描所有可见可点击元素，按多同义词评分排序。\n' +
        '  • 最高分 ≥ 70 且唯一 → 直接点击（免 Phase 2）\n' +
        '  • 有歧义 → 返回带评分的候选列表（含 tag / class / id / href），你从中选 idx\n' +
        '\n' +
        '【Phase 2 — 执行模式】传 idx（从候选列表中选的编号）：\n' +
        '  直接点击该编号对应的元素，不重新扫描。\n' +
        '\n' +
        '【使用示例】\n' +
        '  第一次：browser_click_smart(text="搜索,search,查找")\n' +
        '    → 若有歧义，返回候选列表（含 class 信息）\n' +
        '  确认后：browser_click_smart(idx="2")\n' +
        '    → 点击编号2的元素\n' +
        '\n' +
        '【text 参数强烈建议】同时提供多同义词（逗号分隔），大幅提升匹配率：\n' +
        '  "搜索,search,查找"  "登录,login,sign in"  "提交,submit,确认"',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              '【Phase 1】按钮/链接描述，支持多同义词（逗号分隔）。\n' +
              '例如："搜索,search,查找"、"登录,login,sign in"。\n' +
              '与 idx 二选一，idx 优先。不传时列出页面全部可点击元素。',
          },
          idx: {
            type: 'string',
            description:
              '【Phase 2】从 Phase 1 返回的候选列表中选择的元素编号（idx 字段的值）。\n' +
              '传此参数后直接执行点击。与 text 二选一，idx 优先。',
          },
          css: {
            type: 'string',
            description: '可选 CSS 选择器提示，命中时额外加分（如 ".nav-search-btn"、"#submit"）。',
          },
          exact: {
            type: 'boolean',
            description: '是否精确匹配文字，默认 false（包含目标文字即可）。',
          },
        },
        required: [],
      },
    },
  },


  async execute({ text, idx, css, exact = false }): Promise<ToolExecuteResult> {
    const page = browserSession.currentPage;
    if (!page) return '❌ 浏览器未打开，请先调用 browser_open';

    // ══════════════════════════════════════════════════
    // Phase 2：AI 已选好 idx，直接执行点击
    // ══════════════════════════════════════════════════
    if (idx !== undefined) {
      const steps: string[] = [`Phase 2 — 直接点击 (idx="${idx}")`];
      return executeClickByIdx(page, idx, `idx=${idx}`, steps);
    }

    // ══════════════════════════════════════════════════
    // Phase 1：扫描候选元素
    // ══════════════════════════════════════════════════
    const queries = text
      ? text.split(/[,，;；/|]+/).map(s => s.trim()).filter(Boolean)
      : [];

    const steps: string[] = [
      `Phase 1 — 扫描可点击元素${queries.length ? ` (同义词: ${queries.join('/')})` : ' (全量列表)'}`,
    ];

    const candidates = await scanCandidates(page, queries, css ?? '');
    steps.push(`扫描完成: 找到 ${candidates.length} 个可点击元素`);

    if (candidates.length === 0) {
      return {
        __pause: true,
        trace: steps,
        userMessage: '当前页面没有找到任何可见可点击元素，页面可能未加载完成。',
        resumeHint: '请调用 browser_screenshot 确认页面状态。',
      } satisfies ToolPauseResult;
    }

    const best = candidates[0];
    const bestLabel = best.text || best.ariaLabel || best.title || best.classes || `<${best.tag}>`;

    // 最高分 ≥ 70 且唯一 → 直接点击
    const topScore = best.score;
    const topTied  = candidates.filter(c => c.score === topScore);
    if (topScore >= 70 && topTied.length === 1) {
      steps.push(`明确匹配: "${bestLabel}" (评分:${best.score})，直接执行点击`);
      return executeClickByIdx(page, best.idx, bestLabel, steps);
    }

    // 有歧义 → 保留 data-ts-idx 标记（Phase 2 需要直接用），返回候选列表给 AI
    // 注意：不在此处 cleanupIdx，Phase 2 成功/失败后才清理

    // 有关键词时：只返回 score > 0 的匹配项；全为 0 才返回全部（让 AI 自行判断）
    const hasQueries = queries.length > 0;
    const matched = hasQueries ? candidates.filter(c => c.score > 0) : [];
    const displayList = matched.length > 0 ? matched.slice(0, 15) : candidates.slice(0, 15);
    const isFullDump = matched.length === 0;

    const topN = displayList.map(c => {
      const parts = [
        c.text      && `"${c.text}"`,
        c.ariaLabel && `aria-label="${c.ariaLabel}"`,
        c.title     && `title="${c.title}"`,
        c.id        && `#${c.id}`,
        c.classes   && `class="${c.classes}"`,
        c.href      && `href="${c.href.slice(0, 60)}"`,
      ].filter(Boolean).join('  ');
      return `  [idx=${c.idx}] 评分:${c.score}  <${c.tag}>  ${parts || '（无标识）'}`;
    }).join('\n');

    if (isFullDump) {
      // 关键词无命中，返回全量列表，要求 AI 立即选 idx 继续
      steps.push(`关键词无命中，返回全部 ${displayList.length} 个可点击元素`);
      return {
        __continue: true as const,
        trace: steps,
        instruction:
          `未找到与"${queries.join('/')}"匹配的元素，以下是页面全部可点击元素` +
          `（共 ${candidates.length} 个，展示前 ${displayList.length} 个）：\n${topN}\n\n` +
          `请根据元素内容判断目标，立即调用 browser_click_smart(idx="<编号>") 点击。`,
      } satisfies ToolContinuationResult;
    }

    steps.push(`匹配到 ${matched.length} 个元素 (最高分:${topScore}, 并列:${topTied.length})，等待 AI 选择 idx`);
    return {
      __continue: true as const,
      trace: steps,
      instruction:
        `找到 ${matched.length} 个匹配"${queries.join('/')}"的元素，请从中选择最符合目标的一个：\n${topN}\n\n` +
        `立即调用 browser_click_smart(idx="<编号>") 执行点击，不要询问用户。`,
    } satisfies ToolContinuationResult;
  },
};

export default browserClickSmartSkill;
