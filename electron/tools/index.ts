/**
 * 工具注册入口
 *
 * ✨ 添加新工具只需三步：
 *   1. 在 `impl/` 目录下新建工具文件，实现 `ToolDefinition<T>` 接口
 *   2. 在此文件中 import 该工具
 *   3. 在下方链式调用 `.register(yourTool)` 注册
 *
 * 无需修改任何核心循环逻辑！
 *
 * 💡 部分工具支持暂停/继续交互结果（ToolPauseResult / ToolContinuationResult）
 */

import { ToolRegistry } from './registry';
import datetimeTool from './impl/datetime';
import calculatorTool from './impl/calculator';
import screenshotTool from './impl/screenshot';
import { browserTools } from './impl/browser';
import { systemTools } from './impl/system';
import { ocrTools } from './impl/ocr';
import runCommandTool from './impl/runCommand';
import discordSendTool from './impl/discordSend';
import wechatSendTool from './impl/wechatSend';  // 🆕 微信发送工具
import readSkillTool from './impl/skill';
import memoryTool from './impl/memory';
import todoTool from './impl/todo';
import requestAgentMode from './impl/requestAgentMode';  // 🆕 请求 Agent 模式
import showAvailableTools from './impl/showAvailableTools';  // 🆕 显示可用工具列表
import switchAgentMode from './impl/switchAgentMode';  // 🆕 切换 Agent 模式
import codingAgentTool from './impl/codingAgent';
import codexProjectsTool from './impl/codexProjects';
import minecraftCompanionTool from './impl/minecraftCompanion';

// 🆕 打工人核心工具（文件操作）
import readFileTool from './impl/readFile';
import editFileTool from './impl/editFile';
import listDirectoryTool from './impl/listDirectory';
import searchFilesTool from './impl/searchFiles';

// 🆕 后台进程管理工具
import processTool from './impl/process';

// 🆕 打工人核心工具（Git 操作）
import gitStatusTool from './impl/gitStatus';
import gitDiffTool from './impl/gitDiff';
import gitCommitTool from './impl/gitCommit';
import gitLogTool from './impl/gitLog';

// 🆕 高级工具（支持暂停/继续交互结果）
import openTerminalTool from './impl/openTerminal';
import browserOpenTool from './impl/browserOpen';
import browserClickTool from './impl/browserClick';
import browserTypeTool from './impl/browserType';
import checkPythonEnvTool from './impl/checkPythonEnv';
import writeFileTool from './impl/writeFile';
import discordSendFileTool from './impl/discordSendFile';
import wechatSendFileTool from './impl/wechatSendFile';
import feishuSendFileTool from './impl/feishuSendFile';
import manageTTSTool from './impl/manageTTS';
import manageHearingTool from './impl/manageHearing';
import manageLive2dTool from './impl/manageLive2d';
import asyncTaskTool from './impl/asyncTask';
import scheduleTaskTool from './impl/scheduleTask';
import manageBilibiliLiveTool from './impl/manageBilibiliLive';
import watchBilibiliVideoTool from './impl/watchBilibiliVideo';  // 🆕 B站视频观看工具
import { runtimeTools } from './impl/runtime';

import { setToolRegistry } from './toolContext';

const registry = new ToolRegistry()
  .register(datetimeTool)
  .register(calculatorTool)
  .register(screenshotTool)
  .register(runCommandTool)
  .register(discordSendTool)
  .register(wechatSendTool)      // 🆕 注册微信发送工具
  .register(readSkillTool)
  .register(memoryTool)        // 全局核心记忆工具（AI 主动管理用户画像）
  .register(todoTool)          // 任务管理工具（会话级任务追踪）
  .register(requestAgentMode)  // 🆕 请求 Agent 模式工具（Chat→Agent 渐进式升级）
  .register(showAvailableTools) // 🆕 显示可用工具列表（AI 自我感知能力边界）
  .register(switchAgentMode)   // 🆕 切换 Agent 模式（AI 主动切换）
  .register(codexProjectsTool)  // Discover local Codex projects and tasks
  .register(codingAgentTool)    // User-facing bridge to Codex and coding agents
  .register(minecraftCompanionTool)
  
  // 🆕 注册打工人核心工具（文件操作）
  .register(readFileTool)
  .register(editFileTool)
  .register(listDirectoryTool)
  .register(searchFilesTool)
  
  // 🆕 注册后台进程管理工具
  .register(processTool)
  
  // 🆕 注册打工人核心工具（Git 操作）
  .register(gitStatusTool)
  .register(gitDiffTool)
  .register(gitCommitTool)
  .register(gitLogTool)
  
  // 🆕 注册高级工具（支持暂停/继续交互结果）
  .register(openTerminalTool)
  .register(browserOpenTool)
  .register(browserClickTool)
  .register(browserTypeTool)
  .register(checkPythonEnvTool)
  .register(writeFileTool)
  .register(discordSendFileTool)
  .register(wechatSendFileTool)
  .register(feishuSendFileTool)
  .register(manageTTSTool)
  .register(manageHearingTool)
  .register(manageLive2dTool)
  .register(manageBilibiliLiveTool)
  .register(asyncTaskTool)
  .register(scheduleTaskTool)
  .register(watchBilibiliVideoTool);  // 🆕 B站视频观看

// 批量注册所有浏览器工具
for (const tool of browserTools) {
  registry.register(tool);
}

// 批量注册所有系统级工具（键盘/鼠标）
for (const tool of systemTools) {
  registry.register(tool);
}

// 批量注册 OCR 工具（WinRT，Win10/11 内置，无需额外依赖）
for (const tool of ocrTools) {
  registry.register(tool);
}

for (const tool of runtimeTools) {
  registry.register(tool);
}

// 初始化工具上下文（打破 tools/impl/* ↔ tools/index 的循环依赖）
// 此时 registry 已包含所有工具，impl 文件的 execute() 可通过 getToolRegistry() 调用其他工具
setToolRegistry(registry);

export const toolRegistry = registry;

// 重新导出，方便外部直接从此模块引入类型和类
export type { ToolDefinition } from './types';
export { ToolRegistry } from './registry';

