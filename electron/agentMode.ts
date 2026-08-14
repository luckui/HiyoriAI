/**
 * Agent 模式管理
 *
 * 控制全局 Agent 模式（chat / agent / agent-debug / developer / minecraft）。
 * 模式决定了AI可见的工具集合（通过 toolsets.ts 定义）和系统提示词。
 */

let currentMode: string = 'agent';  // 默认 Agent 模式

export const MINECRAFT_MODE = 'minecraft';

/** 所有合法模式 */
export const VALID_MODES = ['chat', 'agent', 'agent-debug', 'developer', 'streamer', MINECRAFT_MODE] as const;
export type AgentMode = typeof VALID_MODES[number];

/**
 * 设置当前 Agent 模式
 * @param mode - 模式名称（chat / agent / agent-debug / developer / minecraft）
 */
export function setAgentMode(mode: string): void {
  if ((VALID_MODES as readonly string[]).includes(mode)) {
    currentMode = mode;
    console.log(`[AgentMode] 已切换到 ${mode} 模式`);
  } else {
    console.warn(`[AgentMode] 无效模式: ${mode}，保持当前模式: ${currentMode}`);
  }
}

/**
 * 获取当前 Agent 模式
 * @returns 当前模式名称
 */
export function getAgentMode(): string {
  return currentMode;
}

/**
 * 获取当前模式对应的 toolset 列表
 * @returns toolset 名称数组，用于 toolRegistry.getSchemasForToolset()
 */
export function getCurrentToolsets(): string[] {
  return [currentMode];  // 直接返回模式名（chat/agent/agent-debug 都是 toolset 名称）
}

/**
 * 计算本轮实际生效的模式：消息来自 Minecraft 渠道时使用 MINECRAFT_MODE，
 * 其余情况保持全局模式不变。
 */
export function effectiveModeForTrigger(
  baseMode: string,
  trigger?: { source?: string },
): string {
  return trigger?.source === 'minecraft' ? MINECRAFT_MODE : baseMode;
}
