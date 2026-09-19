/**
 * 浏览器基础工具（基于 Playwright Chromium）
 *
 * 工具列表：
 *   browser_open        - 打开网址或搜索关键词
 *   browser_search      - 用搜索引擎或站内搜索框搜索
 *   browser_read_page   - 读取页面摘要与可交互元素
 *   browser_back        - 后退
 *   browser_refresh     - 刷新
 *   browser_screenshot  - 截图（返回图像给 AI 分析）
 *
 * 点击与输入走两阶段的 browser_click_smart / browser_type_smart（见 browserClick.ts / browserType.ts）。
 */

import { nativeImage } from 'electron';
import { browserSession } from './browserSession';
import type { ToolDefinition, ToolImageResult } from '../types';
import { browserExecution } from '../browserExecution';

const browserSharedExecution = browserExecution<any>('shared');
const browserExclusiveExecution = browserExecution<any>('exclusive');

/** 浏览器截图最大宽度，超出等比缩小 */
const SCREENSHOT_MAX_WIDTH = 1280;

// ── 辅助函数 ──────────────────────────────────────────────────────

/** 
 * 等待页面加载稳定（改进：支持动态渲染页面）
 * 
 * 策略：
 *   1. 先等待 domcontentloaded（HTML 解析完成）
 *   2. 再等待 networkidle（网络请求基本完成，适合 SPA）
 *   3. 如果 networkidle 超时，回退到检测主内容区是否出现
 * 
 * @param ms - 总超时时间（默认 8 秒，给 SPA 更多时间）
 */
async function waitSettle(ms = 8000): Promise<void> {
  const page = browserSession.currentPage;
  if (!page) return;

  // 步骤 1: 等待 DOM 解析完成（快速）
  await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});

  // 步骤 2: 尝试等待网络空闲（适合 SPA 动态加载内容）
  const networkIdleSuccess = await page
    .waitForLoadState('networkidle', { timeout: ms - 3000 })
    .then(() => true)
    .catch(() => false);

  if (networkIdleSuccess) return;

  // 步骤 3: 回退策略 - 显式等待主内容区出现（针对 React/Vue SPA）
  await page
    .waitForSelector('main,article,[role=main],#app > *,#root > *,.content', { timeout: 2000 })
    .catch(() => {});

  // 额外等待 500ms 让动态内容稳定
  await new Promise((resolve) => setTimeout(resolve, 500));
}

/** 返回当前页面简短状态描述（含 tab 索引） */
async function pageInfo(): Promise<string> {
  const page = browserSession.currentPage;
  if (!page) return '（浏览器未打开）';
  const title = await page.title().catch(() => '（无标题）');
  const all = browserSession.pages;
  const idx = all.indexOf(page);
  const tabTag = all.length > 1 ? ` [Tab ${idx + 1}/${all.length}]` : '';
  return `"${title}"${tabTag} | ${page.url()}`;
}

/** 在当前页面中尝试定位“站内搜索框”，返回推荐 CSS selector */
async function detectSiteSearchSelector(): Promise<string | null> {
  const page = browserSession.currentPage;
  if (!page) return null;

  const selector: string | null = await page.evaluate(() => {
    const g: any = globalThis as any;
    const doc: any = g.document;
    const getComputedStyle: ((el: any) => any) | undefined = g.getComputedStyle?.bind(g);
    if (!doc || !getComputedStyle) return null;

    const KEYWORDS = ['search', '搜索', '查找', 'query', 'keyword', '关键词'];

    const isVisible = (el: any) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
    };

    const esc = (s: string) => {
      const css = (g as { CSS?: { escape?: (v: string) => string } }).CSS;
      if (css?.escape) return css.escape(s);
      return s.replace(/"/g, '\\"');
    };

    const candidates: any[] = Array.from(doc.querySelectorAll(
      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), [contenteditable="true"]'
    ) as any);

    let best: { score: number; selector: string | null } = { score: -1, selector: null };

    for (const el of candidates) {
      if (!isVisible(el)) continue;

      const tag = (el.tagName || '').toLowerCase();
      const type = ((el.getAttribute('type') || '') + '').toLowerCase();
      const id = (el.id || '').trim();
      const name = (el.getAttribute('name') || '').trim();
      const placeholder = (el.getAttribute('placeholder') || '').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();
      const cls = ((el.className || '') + '').trim();
      const role = (el.getAttribute('role') || '').trim();

      const haystack = [id, name, placeholder, aria, cls, role, type].join(' ').toLowerCase();
      let score = 0;

      if (type === 'search') score += 60;
      if (tag === 'input' || tag === 'textarea') score += 10;
      if (role === 'searchbox' || role === 'textbox') score += 12;
      const nameLower = name.toLowerCase();
      if (nameLower === 'q' || nameLower === 's') score += 10;

      for (const kw of KEYWORDS) {
        if (haystack.includes(kw)) score += 20;
      }

      if (['password', 'email', 'tel', 'number'].includes(type)) score -= 40;

      let candSelector: string | null = null;
      if (id) candSelector = '#' + esc(id);
      else if (name) candSelector = `${tag}[name="${esc(name)}"]`;
      else if (placeholder) candSelector = `${tag}[placeholder="${esc(placeholder)}"]`;
      else if (aria) candSelector = `${tag}[aria-label="${esc(aria)}"]`;

      if (!candSelector) continue;
      if (score > best.score) best = { score, selector: candSelector };
    }

    return best.score >= 30 ? best.selector : null;
  });

  return selector;
}

/** 根据 URL 推断当前页面类型（在 Node.js 进程中执行，不依赖 page.evaluate） */
function inferPageType(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    const search = u.search;
    if (/[?&](q|wd|search|keyword|kw|query|s|text)=/i.test(search)) return '搜索结果页';
    if (/\/(search|find|results?)\b/i.test(path)) return '搜索结果页';
    if (/\/(wiki|item|entry|article|post|detail|news)\//i.test(path)) return '内容详情页';
    if (/\/(list|category|tag|archive|topics?)\//i.test(path)) return '列表页';
    if (/\/(user|profile|account|member|space)\//i.test(path)) return '个人主页';
    if (/\/(login|signin|register|signup)/i.test(path)) return '登录/注册页';
    if (path === '/' || path === '') return '网站首页';
  } catch { /* ignore invalid URL */ }
  return '普通页面';
}

/**
 * 提取当前页面摘要，供 Skill 内联使用和 browser_read_page 工具调用。
 *
 * brief: 标题 + URL + 页面类型 + H1~H3大纲 + 主内容区链接前5条（nav/header/footer已过滤）
 * full:  brief（链接前15条）+ 正文摘要 + 可交互元素（含操作提示）
 *
 * 改进点：
 *   #1/#6  加入 H1~H3 标题大纲，帮助 AI 理解页面层级结构
 *   #3     交互元素附带 browser_click_smart / browser_type_smart 操作提示
 *   #4     链接优先返回主内容区（main/article），过滤 nav/header/footer 导航链接
 */
export async function readPageSummary(mode: 'brief' | 'full' = 'brief'): Promise<string> {
  const page = browserSession.currentPage;
  if (!page) return '（浏览器未打开）';

  const url = page.url();
  const title = await page.title().catch(() => '（无标题）');
  const pageType = inferPageType(url);
  const linkLimit = mode === 'brief' ? 5 : 15;

  // ── 链接：主内容区优先，过滤 nav/header/footer ─────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const links: Array<{ text: string; href: string }> = await (page.evaluate as any)(
    '(() => {' +
    '  function inNavArea(el) {' +
    '    var p = el.parentElement;' +
    '    while (p) {' +
    '      var t = p.tagName ? p.tagName.toLowerCase() : "";' +
    '      var r2 = (p.getAttribute("role") || "").toLowerCase();' +
    '      if (t === "nav" || t === "header" || t === "footer" || r2 === "navigation" || r2 === "banner") return true;' +
    '      p = p.parentElement;' +
    '    }' +
    '    return false;' +
    '  }' +
    '  var main = document.querySelector("main,article,[role=main],#content,.content,#main");' +
    '  var allLinks = Array.from(document.querySelectorAll("a[href]"));' +
    '  var mainLinks = main ? allLinks.filter(function(el){ return main.contains(el); }) : [];' +
    '  var otherLinks = allLinks.filter(function(el){ return !inNavArea(el) && !(main && main.contains(el)); });' +
    '  var ordered = mainLinks.concat(otherLinks);' +
    '  var res = []; var seen = new Set();' +
    '  ordered.forEach(function(el) {' +
    '    var href = el.href || "";' +
    '    if (!href || href.startsWith("javascript:") || href === "#") return;' +
    '    var r = el.getBoundingClientRect();' +
    '    if (r.width === 0 && r.height === 0) return;' +
    '    var st = window.getComputedStyle(el);' +
    '    if (st.display === "none" || st.visibility === "hidden") return;' +
    '    var text = (el.innerText || el.getAttribute("title") || el.getAttribute("aria-label") || "")' +
    '      .trim().replace(/\\s+/g, " ").slice(0, 60);' +
    '    if (!text || seen.has(href)) return;' +
    '    seen.add(href); res.push({ text: text, href: href });' +
    '  });' +
    '  return res.slice(0, ' + linkLimit + ');' +
    '})()'
  ).catch(() => []);

  // ── H1~H3 标题大纲 ────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const headings: Array<{ level: number; text: string }> = await (page.evaluate as any)(
    '(() => {' +
    '  var res = [];' +
    '  document.querySelectorAll("h1,h2,h3").forEach(function(el) {' +
    '    var r = el.getBoundingClientRect();' +
    '    if (r.width === 0 && r.height === 0) return;' +
    '    var st = window.getComputedStyle(el);' +
    '    if (st.display === "none" || st.visibility === "hidden") return;' +
    '    var level = parseInt(el.tagName.slice(1), 10);' +
    '    var text = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80);' +
    '    if (text) res.push({ level: level, text: text });' +
    '  });' +
    '  return res.slice(0, 10);' +
    '})()'
  ).catch(() => []);

  let out = `【页面状态】\n标题: ${title}\nURL: ${url}\n页面类型: ${pageType}`;

  if (headings.length > 0) {
    const hl = headings.map((h: { level: number; text: string }) => {
      const indent = '  '.repeat(h.level - 1);
      return `${indent}H${h.level}: ${h.text}`;
    }).join('\n');
    out += `\n\n【页面大纲（H1~H3）】\n${hl}`;
  }

  if (links.length > 0) {
    const ll = links.map((l: { text: string; href: string }, i: number) =>
      `  ${i + 1}. ${l.text}  →  ${l.href}`
    ).join('\n');
    out += `\n\n【主内容链接（前${links.length}条，导航栏已过滤）】\n${ll}`;
  }

  if (mode === 'full') {
    // ── 正文摘要（剔除 nav/header/footer/aside/form/script/style）──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bodyText: string = await (page.evaluate as any)(
      '(() => {' +
      '  var m = document.querySelector("main,article,[role=main],#content,.content,#main") || document.body;' +
      '  if (!m) return "";' +
      '  var c = m.cloneNode(true);' +
      '  c.querySelectorAll("script,style,nav,footer,header,aside,form").forEach(function(e){e.remove();});' +
      '  return (c.innerText || c.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 800);' +
      '})()'
    ).catch(() => '');

    if (bodyText) out += `\n\n【正文摘要】\n${bodyText}`;

    // ── 可交互元素（含操作提示，AI 可直接复制参数调用）───────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const interactives: string = await (page.evaluate as any)(
      '(() => {' +
      '  var lines = [];' +
      '  document.querySelectorAll("input:not([type=hidden]):not([disabled]),textarea:not([disabled])").forEach(function(el) {' +
      '    var r = el.getBoundingClientRect();' +
      '    if (r.width === 0 && r.height === 0) return;' +
      '    var st = window.getComputedStyle(el);' +
      '    if (st.display === "none" || st.visibility === "hidden") return;' +
      '    var ph = el.getAttribute("placeholder") || "";' +
      '    var lbl = el.getAttribute("aria-label") || el.getAttribute("title") || "";' +
      '    var desc = (ph || lbl || el.getAttribute("type") || "text").slice(0, 40);' +
      '    lines.push("  输入框: \\"" + desc + "\\" → browser_type_smart(description=\\"" + desc + "\\", value=\\"..\\")");' +
      '  });' +
      '  document.querySelectorAll("button:not([disabled]),[role=button],input[type=submit],input[type=button]").forEach(function(el) {' +
      '    var r = el.getBoundingClientRect();' +
      '    if (r.width === 0 && r.height === 0) return;' +
      '    var st = window.getComputedStyle(el);' +
      '    if (st.display === "none" || st.visibility === "hidden") return;' +
      '    var text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 40);' +
      '    if (text) lines.push("  按钮: \\"" + text + "\\" → browser_click_smart(text=\\"" + text + "\\")");' +
      '  });' +
      '  return lines.slice(0, 20).join("\\n");' +
      '})()'
    ).catch(() => '');

    if (interactives) out += `\n\n【可交互元素（含操作提示）】\n${interactives}`;
  }

  // ── 控制台错误和页面异常 ──────────────────────────────────────
  const consoleErrors = browserSession.getRecentConsoleErrors(10);
  const pageErrors = browserSession.getRecentPageErrors(10);
  
  if (consoleErrors.length > 0 || pageErrors.length > 0) {
    out += '\n\n❌ 【浏览器控制台错误】';
    
    if (pageErrors.length > 0) {
      out += '\n\n页面异常（未捕获的错误）:';
      pageErrors.forEach((err, i) => {
        out += `\n  ${i + 1}. ${err.message}`;
      });
    }
    
    if (consoleErrors.length > 0) {
      out += '\n\n控制台消息:';
      consoleErrors.forEach((err, i) => {
        out += `\n  ${i + 1}. [${err.type}] ${err.text}`;
      });
    }
    
    out += '\n\n⚠️ 检测到浏览器错误！常见原因：';
    out += '\n  • ES Module 导入错误（named export 不存在）';
    out += '\n  • 依赖包版本不匹配或打包配置错误';
    out += '\n  • CORS 跨域问题（file:// 无法加载本地资源）';
    out += '\n  • 第三方库 CDN 链接失效或版本错误';
    out += '\n\n建议操作：';
    out += '\n  1. 检查 import 语句是否正确（包名、导出名）';
    out += '\n  2. 清理依赖缓存：删除 node_modules/.vite 和 dist';
    out += '\n  3. 验证 package.json 中的依赖版本';
    out += '\n  4. 如果是 CORS，需要用 run_command(background=true) 启动开发服务器';
  }

  return out;
}

// ── 1. browser_open ───────────────────────────────────────────────

interface OpenParams { query: string }

const browserOpen: ToolDefinition<OpenParams> = {
  execution: browserExclusiveExecution,
  schema: {
    type: 'function',
    function: {
      name: 'browser_open',
      description:
        '打开浏览器并导航到目标地址。导航完成后自动返回页面概况（标题/URL/类型/链接摘要），' +
        '让你判断是否到达目标页、下一步应该点击哪个链接。\n' +
        '支持三种输入格式：\n' +
        '  • 完整网址：https://bilibili.com（推荐，最可靠）\n' +
        '  • 裸域名：bilibili.com、www.github.com（自动补 https://）\n' +
        '  • 显式全网搜索：google:关键词（如 google:哈基米 百度百科）\n' +
        '【重要】本工具只负责导航（URL/域名/href），不负责站内搜索。\n' +
        '需要搜索时请用 browser_search；导航后需深度读取页面用 browser_read_page(detail="full")。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '网址（https://github.com）、裸域名（github.com）或显式搜索（google:关键词）',
          },
        },
        required: ['query'],
      },
    },
  },

  async execute({ query }) {
    const q = query.trim();
    if (!q) return '❌ 参数 query 不能为空';

    const isFullUrl = /^https?:\/\//i.test(q);
    const googleMatch = q.match(/^google\s*:\s*(.+)$/i);
    // 裸域名自动补 https://（如 bilibili.com、www.github.com、sub.example.co.jp）
    const bareDomainMatch = !isFullUrl && !googleMatch &&
      /^([a-z0-9-]+\.)+[a-z]{2,}(\/.*)?$/i.test(q);
    const isPlainKeyword = !isFullUrl && !googleMatch && !bareDomainMatch;

    // 有当前页面时，普通关键词大概率是“站内搜索”意图：拦截并引导 browser_search
    if (isPlainKeyword && browserSession.currentPage) {
      return (
        '⚠️ browser_open 已阻止本次操作：检测到普通关键词，当前存在页面，可能是站内搜索意图。\n' +
        '请改用 browser_search(query="关键词", scope="auto")；若明确要全网搜索，使用 scope="web" 或 google:关键词。\n' +
        `当前页面：${await pageInfo()}`
      );
    }

    const url = isFullUrl
      ? q
      : googleMatch
        ? `https://www.google.com/search?q=${encodeURIComponent(googleMatch[1])}`
        : bareDomainMatch
          ? `https://${q}`
          : `https://www.google.com/search?q=${encodeURIComponent(q)}`; // 浏览器未打开时，普通关键词按全网搜索处理

    const page = await browserSession.ensurePage();
    browserSession.clearErrors(); // 清除旧页面的错误记录
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return `✅ 导航完成\n\n${await readPageSummary('brief')}`;
  },
};

// ── 1.5 browser_search ───────────────────────────────────────────

interface SearchParams {
  query: string;
  scope?: 'auto' | 'site' | 'web';
}

const browserSearch: ToolDefinition<SearchParams> = {
  execution: browserExclusiveExecution,
  schema: {
    type: 'function',
    function: {
      name: 'browser_search',
      description:
        '执行搜索意图（而非纯导航）。\n' +
        'scope=auto（默认）：优先站内搜索，找不到站内搜索框时自动回退到全网搜索。\n' +
        'scope=site：仅站内搜索；scope=web：仅全网搜索。\n' +
        '当用户说“搜一下xxx/查xxx”时优先使用本工具。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '要搜索的关键词（例如：黑神话 评测）',
          },
          scope: {
            type: 'string',
            enum: ['auto', 'site', 'web'],
            description: '搜索范围：auto=优先站内失败回退全网，site=仅站内，web=仅全网。默认 auto。',
          },
        },
        required: ['query'],
      },
    },
  },

  async execute({ query, scope = 'auto' }) {
    const q = query.trim();
    if (!q) return '❌ 关键词不能为空';

    // 显式 URL 或 google: 前缀，直接按导航处理
    const isFullUrl = /^https?:\/\//i.test(q);
    const googleMatch = q.match(/^google\s*:\s*(.+)$/i);
    const bareDomainMatch = !isFullUrl && !googleMatch &&
      /^([a-z0-9-]+\.)+[a-z]{2,}(\/.*)?$/i.test(q);

    if (isFullUrl || bareDomainMatch || googleMatch) {
      const url = isFullUrl
        ? q
        : googleMatch
          ? `https://www.google.com/search?q=${encodeURIComponent(googleMatch[1])}`
          : `https://${q}`;
      const page = await browserSession.ensurePage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitSettle();
      const summary = await readPageSummary('brief');
      return `✅ 检测到导航格式，已打开\n\n${summary}`;
    }

    const goWeb = async (reason?: string) => {
      const page = await browserSession.ensurePage();
      const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitSettle();
      const prefix = reason ? `✅ 已执行全网搜索（${reason}）` : `✅ 已执行全网搜索`;
      const summary = await readPageSummary('brief');
      return `${prefix}\n\n${summary}`;
    };

    if (scope === 'web') {
      return goWeb();
    }

    // site / auto：尝试站内搜索
    if (!browserSession.currentPage) {
      if (scope === 'site') {
        return '⚠️ 当前没有已打开页面，无法执行站内搜索。请先打开站点，或改用 scope="web"。';
      }
      return goWeb('当前无页面，自动回退');
    }

    const selector = await detectSiteSearchSelector();
    if (!selector) {
      if (scope === 'site') {
        return '⚠️ 未找到站内搜索框。可先调用 browser_find 定位搜索输入框，或改用 scope="web"。';
      }
      return goWeb('未找到站内搜索框，自动回退');
    }

    const page = browserSession.currentPage!;
    const locator = page.locator(selector).first();
    await locator.click({ timeout: 5000 }).catch(() => {});
    await locator.fill(q, { timeout: 8000 });
    await locator.press('Enter').catch(() => {});
    await waitSettle();
    const siteSummary = await readPageSummary('brief');
    return `✅ 已执行站内搜索（selector=${selector}）\n\n${siteSummary}`;
  },
};

// ── 1.7 browser_read_page ─────────────────────────────────────────

interface ReadPageParams { detail?: 'brief' | 'full' }

const browserReadPage: ToolDefinition<ReadPageParams> = {
  execution: browserSharedExecution,
  schema: {
    type: 'function',
    function: {
      name: 'browser_read_page',
      description:
        '读取当前页面的核心信息：标题、URL、页面类型（搜索结果/内容详情/列表页等）、\n' +
        'H1~H3 标题大纲（帮助理解页面层级）、主内容区链接（导航栏已过滤），\n' +
        '以及（detail=full 时）正文摘要和可交互元素（含 browser_click_smart / browser_type_smart 操作提示）。\n' +
        '【何时调用】\n' +
        '  • 导航（browser_open/browser_click_smart）后，不确定是否到达目标页时 → detail=brief\n' +
        '  • 需要理解页面内容、找到正文或操作元素时 → detail=full\n' +
        'detail=brief（默认）：~150 token，快速判断页面类型和可点链接。\n' +
        'detail=full：~700 token，额外返回正文摘要和输入框/按钮列表（含操作提示）。\n' +
        '若结果仍不足以理解页面（如动态渲染/图片为主/内容稀少），应主动调用 browser_screenshot 截图后再决策。',
      parameters: {
        type: 'object',
        properties: {
          detail: {
            type: 'string',
            enum: ['brief', 'full'],
            description: 'brief=快速概览（默认），full=深度提取（含正文+可交互元素）',
          },
        },
        required: [],
      },
    },
  },

  async execute({ detail = 'brief' }) {
    const page = browserSession.currentPage;
    if (!page) return '❌ 浏览器未打开，请先调用 browser_open';

    const result = await readPageSummary(detail);

    // 检测 SPA 特征（URL 带 # 路由，或检测到 React/Vue）
    const url = page.url();
    const isSPA = url.includes('#/') || url.includes('#!/');
    
    // 截图建议：分三档
    //   极贫乏（无大纲+无链接）→ 强烈建议
    //   SPA 且内容少 → 强烈建议（可能是动态渲染、视频、Canvas）
    //   内容一般（链接/大纲数量少，或 full 模式无正文）→ 轻度建议
    const hasOutline = result.includes('【页面大纲');
    const hasLinks = result.includes('【主内容链接');
    const hasBody = detail === 'full' && result.includes('【正文摘要');
    const isThin = !hasOutline && !hasLinks;
    const isSparse = !isThin && (result.length < 350 || (detail === 'full' && !hasBody));

    if (isThin) {
      const spaHint = isSPA
        ? '（检测到单页应用路由 #/，页面可能通过 JavaScript 动态渲染视频/Canvas/图片等非文本内容）'
        : '（可能是纯图片/Canvas/动态渲染页面）';
      return (
        result +
        `\n\n⚠️ 页面文本信息极少${spaHint}。` +
        '\n强烈建议立即调用 browser_screenshot 截图，根据画面视觉内容继续决策。'
      );
    }

    if (isSparse || isSPA) {
      const spaHint = isSPA
        ? '\n（检测到单页应用路由 #/，内容可能在等待后仍以视觉形式呈现，文本提取有限）'
        : '';
      return (
        result +
        `\n\n💡 页面结构信息有限${spaHint}，若以上内容不足以判断下一步操作，` +
        '请调用 browser_screenshot 截图直观确认页面状态。'
      );
    }

    return result;
  },
};

// ── 2. browser_back ───────────────────────────────────────────────

const browserBack: ToolDefinition<Record<string, never>> = {
  execution: browserExclusiveExecution,
  schema: {
    type: 'function',
    function: {
      name: 'browser_back',
      description: '浏览器后退到上一页。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  async execute() {
    const page = browserSession.currentPage;
    if (!page) return '❌ 浏览器未打开，请先调用 browser_open';
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
    return `✅ 已后退 → ${await pageInfo()}`;
  },
};

// ── 3. browser_refresh ────────────────────────────────────────────

const browserRefresh: ToolDefinition<Record<string, never>> = {
  execution: browserExclusiveExecution,
  schema: {
    type: 'function',
    function: {
      name: 'browser_refresh',
      description: '刷新当前浏览器页面。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  async execute() {
    const page = browserSession.currentPage;
    if (!page) return '❌ 浏览器未打开，请先调用 browser_open';
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    return `✅ 已刷新 → ${await pageInfo()}`;
  },
};

// ── 9. browser_screenshot ─────────────────────────────────────────

const browserScreenshot: ToolDefinition<Record<string, never>> = {
  execution: browserSharedExecution,
  schema: {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description:
        '截取当前浏览器页面的可见区域，以图像形式返回给 AI 分析。' +
        '这是最重要的辅助工具：导航后截图确认内容，根据截图决定下一步操作。' +
        '当不确定页面结构时，先截图观察再行动。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  async execute(): Promise<ToolImageResult> {
    const page = browserSession.currentPage;
    if (!page) {
      return {
        text: '❌ 浏览器未打开，请先调用 browser_open',
        imageBase64: '',
        mimeType: 'image/png',
      };
    }

    const rawBuffer = await page.screenshot({ type: 'png', fullPage: false });
    // 等比压缩，超过 1280px 才缩小（减少 token 开销）
    let img = nativeImage.createFromBuffer(rawBuffer);
    const { width } = img.getSize();
    if (width > SCREENSHOT_MAX_WIDTH) {
      img = nativeImage.createFromBuffer(
        img.resize({ width: SCREENSHOT_MAX_WIDTH }).toPNG()
      );
    }
    const buffer = img.toPNG();
    const title = await page.title().catch(() => '（无标题）');
    const all = browserSession.pages;
    const idx = all.indexOf(page);
    const tabTag = all.length > 1 ? ` [Tab ${idx + 1}/${all.length}]` : '';

    return {
      text: `📸 浏览器截图${tabTag} | ${title} | ${page.url()}`,
      imageBase64: buffer.toString('base64'),
      mimeType: 'image/png',
    };
  },
};

// ── 导出工具列表 ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const browserTools: ToolDefinition<any>[] = [
  browserOpen,
  browserSearch,
  browserReadPage,
  browserBack,
  browserRefresh,
  browserScreenshot,
];
