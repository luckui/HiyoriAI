import type { ToolDefinition, ToolSchema, ToolExecuteResult, ToolImageResult } from './types';
import { isToolPauseResult, isToolContinuationResult } from './types';
import { resolveToolset } from '../toolsets';

/**
 * 工具注册中心
 *
 * 统一管理所有工具的注册与执行，解耦 LLM 调用循环与具体工具实现。
 *
 * 核心改进（借鉴 hermes-agent）：
 *   - 使用 Toolset 系统替代 hideWhenSkills（声明式、可组合、语义化）
 *   - 支持 checkAvailable() 运行时条件检测（API key 不存在时自动隐藏工具）
 *
 * @example
 * ```ts
 * registry.register(myTool);                           // 注册
 * registry.getSchemasForToolset("browser-smart");      // → 智能工具集
 * await registry.execute(name, argsJson);              // 执行工具调用
 * ```
 */
export class ToolRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly tools = new Map<string, ToolDefinition<any>>();

  /** 注册一个工具，支持链式调用 */
  register<T>(tool: ToolDefinition<T>): this {
    this.tools.set(tool.schema.function.name, tool);
    return this;
  }

  /** 当前是否没有注册任何工具 */
  get isEmpty(): boolean {
    return this.tools.size === 0;
  }

  /** 获取所有已注册工具的名称集合（用于验证记忆条目中的工具名） */
  getToolNames(): ReadonlySet<string> {
    return new Set(this.tools.keys());
  }

  /** 获取所有工具的 schema 列表（不推荐，优先使用 getSchemasForToolset） */
  getSchemas(): ToolSchema[] {
    return [...this.tools.values()]
      .filter(t => !t.checkAvailable || t.checkAvailable())  // 运行时条件检测
      .map((t) => t.schema);
  }

  /**
   * 获取排除指定工具名后的 schema 列表
   * 用于 Agent Executor：排除 agent_start 防止递归触发新 Agent
   */
  getSchemasExcluding(names: string[]): ToolSchema[] {
    return [...this.tools.values()]
      .filter((t) => !names.includes(t.schema.function.name))
      .filter(t => !t.checkAvailable || t.checkAvailable())  // 运行时条件检测
      .map((t) => t.schema);
  }

  /**
   * 根据 Toolset 获取工具 schema 列表（新架构，推荐使用）
   *
   * 设计理念：
   *   - 声明式：工具分组在 toolsets.ts 集中定义，不在各工具代码中分散标记
   *   - 可组合：toolset 支持嵌套（debugging = browser-full + file + terminal）
   *   - 条件过滤：checkAvailable() 运行时检测（API key 不存在时自动隐藏）
   *
   * @param toolsets - toolset 名称数组，如 ["browser-smart", "file-smart"]
   * @returns 过滤后的工具 schema 数组
   *
   * @example
   * ```ts
   * // 默认模式（智能工具）
   * registry.getSchemasForToolset(["default"]);
   * // → browser_click_smart, browser_type_smart, write_file, open_terminal...
   *
   * // 调试模式（包含底层工具）
   * registry.getSchemasForToolset(["debugging"]);
   * // → browser_click, browser_type, browser_click_smart, ...
   * ```
   */
  getSchemasForToolset(toolsets: string[]): ToolSchema[] {
    // 1. 解析 toolset → 工具名集合
    const allowedTools = new Set<string>();
    for (const ts of toolsets) {
      const tools = resolveToolset(ts);
      for (const tool of tools) {
        allowedTools.add(tool);
      }
    }

    // 2. 过滤：只返回 toolset 包含 + checkAvailable 通过的工具
    return [...this.tools.values()]
      .filter(t => allowedTools.has(t.schema.function.name))       // toolset 白名单
      .filter(t => !t.checkAvailable || t.checkAvailable())        // 运行时条件
      .map(t => t.schema);
  }

  /**
   * 按工具名列表获取 schema（用于子智能体工具集过滤）
   * @param names - 工具名数组
   * @returns 匹配且可用的工具 schema 数组
   */
  getSchemasByNames(names: string[]): ToolSchema[] {
    const nameSet = new Set(names);
    return [...this.tools.values()]
      .filter(t => nameSet.has(t.schema.function.name))
      .filter(t => !t.checkAvailable || t.checkAvailable())
      .map(t => t.schema);
  }

  /**
   * 执行指定工具
   *
   * @param name     - 工具函数名（来自 LLM 响应的 tool_call.function.name）
   * @param argsJson - JSON 字符串（来自 LLM 响应的 tool_call.function.arguments）
   * @param context  - 可选的执行上下文（如 conversationId）
   * @returns        - 工具执行结果：字符串或含图像的 ToolImageResult
   *                   ToolPauseResult 已在此处格式化为带 ⏸️ 标记的字符串，
   *                   调用方（aiService）无需感知暂停类型。
   */
  async execute(name: string, argsJson: string, context?: import('./types').ToolContext): Promise<string | ToolImageResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `[工具错误] 未找到名为 "${name}" 的工具，已注册: ${[...this.tools.keys()].join(', ')}`;
    }
    try {
      const args = JSON.parse(argsJson) as Record<string, unknown>;
      const result = await tool.execute(args, context);

      // ── 工具暂停：格式化为带 ⏸️ 标记的字符串，AI 按工具结果规范处理 ──
      if (isToolPauseResult(result)) {
        const traceLines = result.trace.length
          ? result.trace.map(t => '  ' + t).join('\n')
          : '  （无执行轨迹）';
        return (
          `⏸️ 工具暂停，等待用户操作\n` +
          `执行轨迹：\n${traceLines}\n\n` +
          `【当前状态】${result.userMessage}\n` +
          `【用户完成后】${result.resumeHint}`
        );
      }

      // ── 工具继续：格式化为带 🔄 标记的字符串，AI 按工具结果规范判断下一步 ──
      if (isToolContinuationResult(result)) {
        const traceLines = result.trace.length
          ? result.trace.map(t => '  ' + t).join('\n')
          : '  （无执行轨迹）';
        return (
          `🔄 工具阶段完成，建议继续下一步\n` +
          `执行轨迹：\n${traceLines}\n\n` +
          `【建议下一步】${result.instruction}`
        );
      }

      return result;
    } catch (e) {
      return `[工具错误] "${name}" 执行失败: ${(e as Error).message}`;
    }
  }
}
