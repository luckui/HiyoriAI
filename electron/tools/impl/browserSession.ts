/**
 * 浏览器会话单例
 *
 * 使用 launchPersistentContext 持久化浏览器 Profile（Cookie / LocalStorage /
 * 历史记录），并注入 Init Script 隐藏 webdriver 标志，尽量规避人机验证。
 *
 * 反检测策略：
 *   1. launchPersistentContext — Profile 存入 AppData，再次打开仍是"老用户"
 *   2. navigator.webdriver = undefined — 抹掉最常见的机器人识别标志
 *   3. headless: false — 使用有界面模式，避免 Headless 特征
 *   4. 真实 Chrome User-Agent
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import { join } from 'path';
import { app } from 'electron';

/** 浏览器 Profile 目录（Cookie 等持久化到此处） */
function getProfileDir(): string {
  return join(app.getPath('userData'), 'browser-profile');
}

/**
 * 注入到每个新页面的反检测脚本：
 * - 隐藏 navigator.webdriver
 * - 补全 chrome runtime 对象（部分网站检测此对象是否存在）
 * - 修复 permissions.query 返回值（有些检测会查询 notifications 权限）
 */
const STEALTH_SCRIPT = `
  // 1. 隐藏 webdriver 标志
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // 2. 补全 window.chrome
  if (!window.chrome) {
    window.chrome = { runtime: {} };
  }

  // 3. 修复 permissions.query（让 notifications 看起来是 denied 而非 prompt）
  const _query = window.navigator.permissions.query.bind(window.navigator.permissions);
  window.navigator.permissions.query = (params) =>
    params.name === 'notifications'
      ? Promise.resolve({ state: 'denied', onchange: null })
      : _query(params);

  // 4. 补全 plugins（空插件列表是常见机器人特征）
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5],
  });

  // 5. 语言设置
  Object.defineProperty(navigator, 'languages', {
    get: () => ['zh-CN', 'zh', 'en-US', 'en'],
  });
`;

class BrowserSession {
  private _context: BrowserContext | null = null;
  private _page: Page | null = null;
  private _consoleErrors: Array<{ type: string; text: string; timestamp: number }> = [];
  private _pageErrors: Array<{ message: string; timestamp: number }> = [];

  /**
   * 获取或创建当前 Page，自动启动持久化浏览器。
   */
  async ensurePage(): Promise<Page> {
    // 上下文不存在或浏览器已断开，重新创建
    if (!this._context || !this._context.browser()?.isConnected()) {
      this._context = await chromium.launchPersistentContext(getProfileDir(), {
        headless: false,
        viewport: { width: 1280, height: 800 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        args: [
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled', // 关键：关闭自动化控制标志
          '--disable-dev-shm-usage',
          '--disable-infobars',
          '--autoplay-policy=no-user-gesture-required', // 允许自动播放（含音频）
          '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies', // 取消静音白名单限制
        ],
        ignoreDefaultArgs: ['--enable-automation'], // 去掉 --enable-automation 参数
      });

      // 注入反检测脚本到所有新页面
      await this._context.addInitScript(STEALTH_SCRIPT);
      this._page = null;

      // ── 监听新 tab/popup：自动切换 currentPage ────────────────────
      // 当点击 target="_blank" 链接或 window.open() 产生新页面时自动跟进，
      // 避免 AI 还在操作旧页面、不知道新页面已存在的问题。
      this._context.on('page', (newPage: Page) => {
        this._page = newPage;
        this._setupPageListeners(newPage);
        // 等页面加载稳定后再允许操作
        newPage.waitForLoadState('domcontentloaded').catch(() => {});
      });
    }

    // 页面关闭或未创建，新建一个
    if (!this._page || this._page.isClosed()) {
      // 复用已有 pages（比如用户手动打开的标签）
      const pages = this._context.pages();
      this._page = pages.length > 0 ? pages[pages.length - 1] : await this._context.newPage();
      this._setupPageListeners(this._page);
    }

    return this._page;
  }

  /**
   * 为页面设置控制台和错误监听器
   */
  private _setupPageListeners(page: Page): void {
    // 监听控制台消息（错误和警告）
    page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        this._consoleErrors.push({
          type,
          text: msg.text(),
          timestamp: Date.now()
        });
        // 只保留最近 50 条错误
        if (this._consoleErrors.length > 50) {
          this._consoleErrors.shift();
        }
      }
    });

    // 监听页面错误（未捕获的异常）
    page.on('pageerror', (error) => {
      this._pageErrors.push({
        message: error.message,
        timestamp: Date.now()
      });
      // 只保留最近 50 条错误
      if (this._pageErrors.length > 50) {
        this._pageErrors.shift();
      }
    });
  }

  /**
   * 获取最近的控制台错误（最多返回最近的 count 条）
   */
  getRecentConsoleErrors(count: number = 10): Array<{ type: string; text: string; timestamp: number }> {
    return this._consoleErrors.slice(-count);
  }

  /**
   * 获取最近的页面错误（最多返回最近的 count 条）
   */
  getRecentPageErrors(count: number = 10): Array<{ message: string; timestamp: number }> {
    return this._pageErrors.slice(-count);
  }

  /**
   * 清除错误记录（通常在页面导航后调用）
   */
  clearErrors(): void {
    this._consoleErrors = [];
    this._pageErrors = [];
  }

  /** 获取当前页面（不自动创建）；浏览器未打开时返回 null */
  get currentPage(): Page | null {
    return this._page && !this._page.isClosed() ? this._page : null;
  }

  /** 获取所有打开的页面列表（已关闭的自动过滤） */
  get pages(): Page[] {
    return this._context?.pages().filter((p) => !p.isClosed()) ?? [];
  }

  /**
   * 切换到指定 tab（0-based index）。
   * 超出范围时抛出错误。
   */
  switchToPage(index: number): Page {
    const all = this.pages;
    if (index < 0 || index >= all.length) {
      throw new Error(`tab 索引 ${index} 越界，当前共 ${all.length} 个 tab`);
    }
    this._page = all[index];
    return this._page;
  }

  /** 关闭浏览器并释放所有资源（Profile 数据保留在磁盘） */
  async close(): Promise<void> {
    await this._context?.close().catch(() => {});
    this._context = null;
    this._page = null;
  }
}

export const browserSession = new BrowserSession();
