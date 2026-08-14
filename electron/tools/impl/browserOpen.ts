/**
 * Skill: browser_open
 *
 * 升级版导航 Skill —— 导航完成后自动附带页面概况（标题/URL/类型/链接摘要），
 * 让 AI 不再「盲飞」：打开搜索结果页后能看到结果列表，知道要继续点击目标链接。
 *
 * 行为与原子版 browser_open 完全兼容（接受相同参数格式）：
 *   • 完整网址：https://bilibili.com
 *   • 裸域名：bilibili.com、www.github.com（自动补 https://）
 *   • 显式全网搜索：google:关键词（如 google:playwright 教程）
 *   • 无页面时普通关键词 → 自动 Google 全网搜索
 *
 * 注册时覆盖同名原子工具（Map 中 browser_open 键被 Skill 版本替换），
 * 原子版 browser_open 的 hideWhenSkills: true 标记为冗余文档保留。
 *
 * 导航后如需深度提取页面内容，调用 browser_read_page(detail="full")。
 */

import type { ToolDefinition } from '../types';
import { browserExecution } from '../browserExecution';
import { browserSession } from '../impl/browserSession';
import { readPageSummary } from '../impl/browser';

interface BrowserOpenParams {
  query: string;
}

async function waitSettle(ms = 2000): Promise<void> {
  const page = browserSession.currentPage;
  if (!page) return;
  await page.waitForLoadState('domcontentloaded', { timeout: ms }).catch(() => {});
}

const browserOpenSkill: ToolDefinition<BrowserOpenParams> = {
  execution: browserExecution('exclusive'),
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
            description:
              '网址（https://github.com）、裸域名（github.com）或显式搜索（google:关键词）',
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
    const bareDomainMatch =
      !isFullUrl &&
      !googleMatch &&
      /^([a-z0-9-]+\.)+[a-z]{2,}(\/.*)?$/i.test(q);
    const isPlainKeyword = !isFullUrl && !googleMatch && !bareDomainMatch;
    const hasCurrentPage = !!browserSession.currentPage;

    // 有当前页面 + 普通关键词 → 极可能是站内搜索意图，拦截并引导
    if (isPlainKeyword && hasCurrentPage) {
      const page = browserSession.currentPage!;
      const title = await page.title().catch(() => '');
      const url = page.url();
      return (
        `⚠️ 检测到普通关键词"${q}"，当前已有页面打开，可能是站内搜索意图。\n` +
        `请改用 browser_search(query="${q}", scope="auto")。\n` +
        `当前页面：${title} | ${url}`
      );
    }

    const url = isFullUrl
      ? q
      : googleMatch
        ? `https://www.google.com/search?q=${encodeURIComponent(googleMatch[1])}`
        : bareDomainMatch
          ? `https://${q}`
          : `https://www.google.com/search?q=${encodeURIComponent(q)}`; // 无页面时关键词按全网搜索

    const page = await browserSession.ensurePage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitSettle();

    const summary = await readPageSummary('brief');
    return `✅ 导航完成\n\n${summary}`;
  },
};

export default browserOpenSkill;
