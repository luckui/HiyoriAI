/**
 * streamerGuard.ts — funded_request 安全守卫
 *
 * 付费观众通过弹幕驱动 AI 调用工具，攻击面包括：
 *   1. 导航到危险 URL（file://、内网、成人站点）
 *   2. 调用高权限工具（memory、switch_agent_mode、manage_bilibili_live 等）
 *   3. 通过 browser_read_page 读取事先导航到的敏感页面
 *
 * 本模块在程序层面实施防护，不依赖 AI 自律：
 *   • FUNDED_ALLOWED_TOOLS — 严格白名单，白名单外工具调用直接拦截
 *   • checkUrl()           — URL 安全检查，拦截危险协议、内网地址、不良内容
 *   • checkToolCall()      — 综合检查，白名单 + 参数级安全验证
 *
 * 设计原则：
 *   - 安全逻辑全部集中在本文件，其他文件只做 import + 调用
 *   - 不修改通用工具（普通对话场景不受限制）
 *   - 白名单和黑名单可在本文件维护，无需散落到各处
 */

// ─── 工具白名单 ──────────────────────────────────────────────────────────────

/**
 * funded_request 允许调用的工具（严格最小化）。
 *
 * 排除说明：
 *   memory              → 可读取主播历史对话，隐私泄露风险
 *   todo                → 可污染任务列表，影响主播工作流
 *   read_skill          → 泄露内部技能文档结构
 *   show_available_tools → 泄露系统工具列表
 *   switch_agent_mode   → 可切换到更高权限模式
 *   manage_tts          → 可静音或改变主播 TTS 设置
 *   manage_hearing      → 可关闭主播对弹幕的感知
 *   manage_bilibili_live → 包含 Cookie/Token 等敏感操作
 *   browser_click_smart → 可点击表单按钮、触发账号操作
 *   browser_type_smart  → 可在表单中输入凭据或恶意内容
 */
export const FUNDED_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'watch_bilibili_video', // 仅读取 B 站视频信息，域名固定
  'browser_open',         // 受 URL 守卫保护（见 checkToolCall）
  'browser_read_page',    // 读取当前页面，受当前 URL 守卫保护
  'browser_screenshot',   // 截图，只读，无副作用
  'manage_live2d',        // 控制表情/动作，无敏感信息
  'browser_click_smart', // 暂且保留，后续根据实际风险评估决定是否移除
  'browser_type_smart',  // 暂且保留，后续根据实际风险评估决定是否移除
]);

// ─── URL 安全检查 ────────────────────────────────────────────────────────────

/** 仅允许的 URL 协议（拦截 file:// data: javascript: ftp: 等） */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** 本地网络地址模式（阻止访问宿主机上的服务） */
const LOCAL_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^\[::1\]$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
];

/** 成人/危险内容域名关键词（小写模糊匹配，降低维护成本） */
const BLOCKED_DOMAIN_KEYWORDS: string[] = [
  'pornhub', 'xvideos', 'xnxx', 'xhamster',
  'nhentai', 'hentai', 'rule34',
  'brazzers', 'redtube', 'youporn', 'gov', 'mili', 'army', 'navy', 'airforce', '91'
];

export interface UrlCheckResult {
  safe: boolean;
  reason?: string; // 中文原因，会反馈给模型让其向观众解释
}

/**
 * 在程序层面验证 URL 是否安全，供 browser_open / browser_read_page 调用前检查。
 * @param rawUrl 原始字符串（可能是完整 URL 或裸域名）
 */
export function checkUrl(rawUrl: string): UrlCheckResult {
  if (!rawUrl) return { safe: false, reason: 'URL 为空' };

  let parsed: URL;
  try {
    // 裸域名自动补 https://，与 browserOpen 保持一致
    const normalized = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    parsed = new URL(normalized);
  } catch {
    return { safe: false, reason: `URL 格式无效：${rawUrl}` };
  }

  // 1. 协议检查
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { safe: false, reason: `不允许的协议 ${parsed.protocol}（仅允许 http/https）` };
  }

  // 2. 本地网络检查
  const host = parsed.hostname;
  if (LOCAL_HOST_PATTERNS.some(p => p.test(host))) {
    return { safe: false, reason: `不允许访问本地网络地址：${host}` };
  }

  // 3. 不良内容域名关键词检查
  const hostLower = host.toLowerCase();
  const blocked = BLOCKED_DOMAIN_KEYWORDS.find(kw => hostLower.includes(kw));
  if (blocked) {
    return { safe: false, reason: `域名包含不适宜关键词（${blocked}）` };
  }

  return { safe: true };
}

// ─── 工具调用综合检查 ─────────────────────────────────────────────────────────

export interface ToolCheckResult {
  safe: boolean;
  reason?: string;
}

/**
 * 在执行工具前做白名单 + 参数级安全检查。
 * @param toolName       工具名
 * @param rawArgs        工具参数（JSON 字符串）
 * @param currentPageUrl 当前浏览器页面 URL（仅 browser_read_page 时传入做防御检查）
 */
export function checkToolCall(
  toolName: string,
  rawArgs: string,
  currentPageUrl?: string,
): ToolCheckResult {
  // 1. 白名单检查
  if (!FUNDED_ALLOWED_TOOLS.has(toolName)) {
    return { safe: false, reason: `工具 "${toolName}" 不在付费请求的允许列表中` };
  }

  // 2. browser_open — 检查 URL 参数
  if (toolName === 'browser_open') {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(rawArgs);
    } catch {
      return { safe: false, reason: '参数解析失败，请检查格式' };
    }
    const query = String(args.query ?? '').trim();
    // google:关键词 和 普通关键词 → 走 Google 搜索，安全
    const isSearch = /^google\s*:/i.test(query) || !/^https?:\/\/|^[a-z0-9-]+\.[a-z]{2,}/i.test(query);
    if (!isSearch) {
      const urlResult = checkUrl(query);
      if (!urlResult.safe) return { safe: false, reason: urlResult.reason };
    }
  }

  // 3. browser_read_page — 检查当前页面 URL（防御性：防止读取之前导航到的危险页面）
  if (toolName === 'browser_read_page' && currentPageUrl) {
    const urlResult = checkUrl(currentPageUrl);
    if (!urlResult.safe) {
      return { safe: false, reason: `当前页面 URL 不安全，拒绝读取：${urlResult.reason}` };
    }
  }

  return { safe: true };
}
