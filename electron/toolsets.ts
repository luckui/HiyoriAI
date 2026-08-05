/**
 * Toolset 系统 - 声明式工具集管理
 *
 * 设计理念（借鉴 hermes-agent）：
 *   - 声明式：所有工具分组在此集中定义，替代分散的 hideWhenSkills
 *   - 可组合：toolset 可以嵌套（includes: ["web", "file"]）
 *   - 语义化：toolset 名字表达使用场景（browser-smart、debugging）
 *   - 扩展性：未来新增场景只需添加新 toolset，不改工具代码
 *
 * @example
 * ```ts
 * import { resolveToolset, TOOLSETS } from './toolsets';
 *
 * // 获取工具集包含的所有工具名
 * const tools = resolveToolset("browser-smart");
 * // → ["browser_open", "browser_search", "browser_click_smart", ...]
 *
 * // 注册表使用
 * registry.getSchemasForToolset("browser-smart");
 * ```
 */

/**
 * Toolset 定义结构
 */
export interface ToolsetDefinition {
  /** 工具集描述 */
  description: string;
  /** 直接包含的工具名列表 */
  tools: string[];
  /** 嵌套包含的其他 toolset 名列表（支持组合） */
  includes?: string[];
}

/**
 * 所有工具集定义
 *
 * 扁平化分层策略：
 *   - core: 核心功能（打开/读取/截图）
 *   - smart: 智能交互 Skills（点击/输入）
 *   - nav: 导航辅助（后退/刷新/搜索）
 *
 * ⚠️ 底层原子工具（browser_click, browser_type, sys_mouse_click 等）
 *    永不暴露给 AI，仅供 Skills 内部使用。
 */
export const TOOLSETS: Record<string, ToolsetDefinition> = {
  // ═════════════════════════════════════════════════════════════
  // 浏览器工具集（扁平化）
  // ═════════════════════════════════════════════════════════════

  "browser-core": {
    description: "浏览器核心工具（打开/读取/截图）",
    tools: [
      "browser_open",            // 智能导航（Skill：合并 open/search 逻辑）
      "browser_read_page",       // 读取页面内容（页面摘要 + 可交互元素）
      "browser_screenshot",      // 截图（保存到文件）
    ],
  },

  "browser-smart": {
    description: "浏览器智能交互 Skills（点击/输入）",
    tools: [
      "browser_click_smart",     // 智能点击（Skill：两阶段 扫描→确认）
      "browser_type_smart",      // 智能输入（Skill：定位输入框→填充）
    ],
  },

  "browser-nav": {
    description: "浏览器导航辅助（后退/刷新/搜索）",
    tools: [
      "browser_back",            // 后退
      "browser_refresh",         // 刷新
      "browser_search",          // 搜索引擎
    ],
  },

  // ═════════════════════════════════════════════════════════════
  // 其他工具集（扁平化）
  // ═════════════════════════════════════════════════════════════

  "ocr": {
    description: "OCR 文字识别工具",
    tools: [
      "sys_find_text",           // OCR 查找文字
      "sys_find_text_click",     // OCR 查找并点击
    ],
  },

  "basic-tools": {
    description: "基础工具（计算器/时间/截图）",
    tools: [
      "calculate",               // 计算器
      "get_current_datetime",    // 获取当前时间
      "take_screenshot",         // 截图（屏幕）
    ],
  },

  // ═════════════════════════════════════════════════════════════
  // 平台特定 Toolset（根据消息来源动态注入）
  // ═════════════════════════════════════════════════════════════

  "discord": {
    description: "Discord 平台专属工具（当消息来自 Discord 时自动注入）",
    tools: [
      "discord_send_file",       // Discord 附件/截图发送
    ],
  },

  "wechat": {
    description: "WeChat 平台专属工具（当消息来自 WeChat 时自动注入）",
    tools: [
      "wechat_send_file",        // WeChat 附件/截图发送
    ],
  },

  "feishu": {
    description: "Lark / Feishu 平台专属工具（当消息来自飞书时自动注入）",
    tools: [
      "feishu_send_file",        // Feishu 附件/截图发送
    ],
  },

  // ═════════════════════════════════════════════════════════════
  // 三级模式：Chat / Agent / Agent-Debug（扁平化，易读）
  // ═════════════════════════════════════════════════════════════

  // 节省模式
  "chat": {
    description: "Chat 模式 - 轻量对话助手",
    tools: [
      // 核心能力
      "memory",                  // 全局核心记忆（AI 主动管理用户画像）
      // "todo",                    // 任务管理（会话级任务追踪）
      "run_command",             // ⭐ 核心：执行命令
      "show_available_tools",    // 🆕 显示可用工具列表
      "switch_agent_mode",       // 🆕 切换 Agent 模式
      
      // TTS 语音管理
      "manage_tts",              // 🆕 管理本地 TTS 语音合成服务
      "manage_hearing",          // 🆕 管理听觉系统（STT 语音识别）
      "manage_live2d",           // 🆕 控制 Live2D 角色情绪与动作
      "minecraft_companion",

      // 基础工具
      "take_screenshot",         // 截图（屏幕）
    ],
  },

  "agent": {
    description: "Agent 模式 - 全功能自动化助手",
    tools: [
      // 核心能力
      "memory",                  // 全局核心记忆
      "todo",                    // 任务管理
      "read_skill",              // 读取 Skills
      "run_command",             // ⭐ 执行命令（含 background 后台模式）
      "process",                 // ⭐ 后台进程管理（poll/kill/send，配合 run_command background）
      "show_available_tools",    // 显示可用工具列表
      "switch_agent_mode",       // 🆕 切换 Agent 模式
      "codex_projects",
      "coding_agent",
      "minecraft_companion",
      
      // 浏览器 - 完整工具集
      "browser_open",            // 打开网页（Skill）
      "browser_read_page",       // 读取页面内容
      "browser_screenshot",      // 截图
      "browser_click_smart",     // 智能点击（Skill）
      "browser_type_smart",      // 智能输入（Skill）
      "browser_refresh",         // 刷新
      // "browser_back",            // 后退
      // "browser_search",          // 搜索引擎
      
      // Skills（高级能力）
      // "open_terminal",           // Skill: 打开终端
      "write_file",              // Skill: 写入文件
      // "check_python_env",        // Skill: 检查 Python 环境
      "manage_tts",              // 🆕 管理本地 TTS 语音合成服务
      "manage_hearing",          // 🆕 管理听觉系统（STT 语音识别）
      "manage_live2d",           // 🆕 控制 Live2D 角色情绪与动作
      
      // 异步任务
      "async_task",              // 🆕 异步后台任务管理
      "schedule_task",           // 🆕 定时任务调度
      
      // B 站视频（供后台 agent 任务使用，如定时逛B站首页解说）
      "watch_bilibili_video",    // 打开B站视频并获取元数据      
      // OCR 工具
      // "sys_find_text",           // OCR 查找文字
      // "sys_find_text_click",     // OCR 查找并点击
      
      // 基础工具
      // "calculate",               // 计算器
      // "get_current_datetime",    // 获取当前时间
      "take_screenshot",         // 截图（屏幕）
    ],
  },

  "agent-debug": {
    description: "Agent 调试模式 - 开发者专用（同 Agent，但暴露系统底层工具 + 打工人核心工具）",
    tools: [
      // 核心能力
      "memory",
      "todo",
      "read_skill",
      "run_command",
      "show_available_tools",
      "codex_projects",
      "coding_agent",
      "minecraft_companion",
      
      // 🆕 打工人核心工具（文件操作）
      "read_file",               // 读取文件（支持行范围）
      "edit_file",               // 编辑文件（字符串替换）
      "list_directory",          // 列出目录内容
      "search_files",            // 搜索文件内容
      "write_file",              // 写入文件（覆盖/追加），skills
      
      // 🆕 后台进程管理（run_command background=true 启动，process 管理）
      "process",                 // poll/log/kill/send/list

      // Delegated runtime sessions
      "runtime_start",
      "runtime_send",
      "runtime_status",
      "runtime_interrupt",
      "runtime_list",
      "runtime_providers",
      
      // 🆕 打工人核心工具（Git 操作）
      "git_status",              // Git 状态
      "git_diff",                // Git 差异
      "git_commit",              // Git 提交
      "git_log",                 // Git 历史
      
      // 浏览器 - 完整工具集
      "browser_open",
      "browser_read_page",
      "browser_screenshot",
      "browser_click_smart",
      "browser_type_smart",
      "browser_refresh",
      "browser_search",
      // "browser_back",
      
      // Skills
      // "open_terminal",
      // "check_python_env",
      "manage_tts",              // 🆕 管理本地 TTS 语音合成服务
      "manage_hearing",          // 🆕 管理听觉系统（STT 语音识别）
      "manage_live2d",           // 🆕 控制 Live2D 角色情绪与动作
      
      // 异步任务
      "async_task",              // 🆕 异步后台任务管理
      "schedule_task",           // 🆕 定时任务调度
      
      // B 站视频
      "watch_bilibili_video",    // 打开B站视频并获取元数据
      
      // OCR 工具
      // "sys_find_text",
      // "sys_find_text_click",
      
      // 系统底层工具（⚠️ 调试用，生产环境不要开启）
      "sys_key_press",           // 键盘按键
      "sys_key_type",            // 键盘输入
      "sys_mouse_click",         // 鼠标点击
      "sys_mouse_move",          // 鼠标移动
      "sys_wait",                // 等待
      
      // 基础工具
      // "calculate",
      // "get_current_datetime",
      "take_screenshot",
    ],
  },

  // ═════════════════════════════════════════════════════════════
  // Worker 模式：batch 子任务专用精简工具集
  // ═════════════════════════════════════════════════════════════

  "worker": {
    description: "Worker 模式 - 批量子任务的精简工具集（参考 Hermes delegate_task 默认 terminal+file+web）",
    tools: [
      // 文件操作（核心：子任务需要读写文件、发现文件）
      "read_file",               // 读取文本文件
      "write_file",              // 写入结果文件
      "list_directory",          // 列出目录内容
      "search_files",            // 搜索文件

      // 执行（子任务需要跑 Python 解析文档、处理数据）
      "run_command",             // 通用命令执行（pip install、python script.py 等）

      // 技能库（子任务遇到不熟悉的操作可查技能，如文档读取方法）
      "read_skill",              // 读取 Skills
    ],
  },

  // ═════════════════════════════════════════════════════════════
  // Developer 模式（nightly）：软件工程师，方法论驱动开发
  // ═════════════════════════════════════════════════════════════

  "developer": {
    description: "Developer 模式 - 软件工程师（继承 agent-debug 全部工具 + 方法论驱动提示词）",
    tools: [
      // developer 自身不需要额外工具，全部通过 includes 继承
    ],
    includes: ["agent-debug"],  // ← 继承 agent-debug 的全部工具
  },

  // ═════════════════════════════════════════════════════════════
  // Live2D 控制工具集（角色表情与动作管理）
  // ═════════════════════════════════════════════════════════════

  "live2d": {
    description: "Live2D 角色控制（情绪/动作/参数）",
    tools: [
      "manage_live2d",          // 设置情绪、播放动作、直接控制参数
    ],
  },
  "streamer": {
    description: "Streamer mode - Bilibili live host with danmu pool, gift priority, and topic control",
    tools: [
      "memory",
      "todo",
      "read_skill",              // 查阅 Skills（逛B站工作流、浏览器操作规范等）
      "show_available_tools",
      "switch_agent_mode",
      "schedule_task",           // 🆕 定时任务调度（每N分钟执行直播任务，如B站推荐解说）
      "manage_tts",
      "manage_hearing",
      "manage_live2d",
      "manage_bilibili_live",
      "watch_bilibili_video",    // 🆕 观看B站视频并获取元数据（Streamer专用）
      "browser_open",
      "browser_read_page",
      "browser_click_smart",
      "browser_type_smart",
      "browser_screenshot",
      // "take_screenshot",
    ],
  },
};

/**
 * 解析 toolset，递归展开 includes，返回所有工具名集合
 *
 * @param name - toolset 名称
 * @returns 去重后的工具名数组
 *
 * @example
 * ```ts
 * resolveToolset("browser-smart");
 * // → ["browser_open", "browser_search", "browser_click_smart", ...]
 *
 * resolveToolset("default");
 * // → 递归展开所有 includes，返回完整工具列表
 * ```
 */
export function resolveToolset(name: string): string[] {
  const def = TOOLSETS[name];
  if (!def) {
    console.warn(`[toolsets] Unknown toolset: ${name}`);
    return [];
  }

  const result = new Set<string>();

  // 添加直接工具
  for (const tool of def.tools) {
    result.add(tool);
  }

  // 递归添加嵌套 toolset
  if (def.includes) {
    for (const included of def.includes) {
      const nested = resolveToolset(included);
      for (const tool of nested) {
        result.add(tool);
      }
    }
  }

  return Array.from(result);
}

/**
 * 验证 toolset 名称是否存在
 */
export function validateToolset(name: string): boolean {
  return name in TOOLSETS;
}

/**
 * 获取所有可用的 toolset 名称
 */
export function getAllToolsets(): string[] {
  return Object.keys(TOOLSETS);
}
