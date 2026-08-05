/**
 * 工具: request_agent_mode
 *
 * Chat 模式工具不足时，向用户请求升级为 Agent 模式。
 * 用户可能忘记切换模式，AI 应主动检测并提醒。
 *
 * 返回 ToolPauseResult，AI 会暂停等待用户响应。
 * 用户确认后，前端发送 IPC 切换模式，AI 自动继续对话并获得新工具权限。
 */

import type { ToolDefinition, ToolPauseResult } from '../types';
import { BrowserWindow } from 'electron';

interface RequestAgentModeParams {
  /** 为什么需要 Agent 权限（如："需要在搜索框自动输入关键词"） */
  reason: string;
  /** 具体需要哪些工具（可选） */
  needed_tools?: string[];
}

const requestAgentMode: ToolDefinition<RequestAgentModeParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'request_agent_mode',
      description:
        'Chat模式工具不足时，向用户请求升级为Agent模式（获得完整自动化能力）。\n' +
        '用户可能忘记切换模式，AI应主动检测并提醒。\n' +
        '【使用场景】\n' +
        '  • 需要自动点击/输入网页元素（需要browser_click_smart/type_smart）\n' +
        '  • 需要操作键盘鼠标（需要sys_key_press/mouse_click）\n' +
        '  • 需要打开终端（需要open_terminal Skill）\n' +
        '  • 需要复杂文件或文档编辑（需要完整 Agent 工具集）\n' +
        '【不要滥用】\n' +
        '  • 能用run_command解决的不要请求Agent（Chat模式已有run_command）\n' +
        '  • 能用browser_open打开网页的不要请求（Chat已有browser_open）',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: '为什么需要Agent权限（如："需要在搜索框自动输入关键词"）',
          },
          needed_tools: {
            type: 'array',
            items: { type: 'string' },
            description: '具体需要哪些工具（可选，如 ["browser_type_smart", "browser_click_smart"]）',
          },
        },
        required: ['reason'],
      },
    },
  },

  async execute({ reason, needed_tools }): Promise<ToolPauseResult> {
    // 不发送 IPC 事件，只返回文本提示（用户手动点击 toggle 切换）
    return {
      __pause: true as const,
      trace: [
        `检测到 Chat 模式工具不足`,
        `原因：${reason}`,
        needed_tools?.length ? `需要工具：${needed_tools.join(', ')}` : '',
        `等待用户手动切换到 Agent 模式`,
      ].filter(Boolean),
      userMessage:
        `当前处于 Chat 模式，无法执行此操作。\n` +
        `原因：${reason}\n` +
        (needed_tools?.length ? `需要工具：${needed_tools.join(', ')}\n` : '') +
        `请点击聊天窗口右上角的 "Chat/Agent" 开关切换到 Agent 模式。`,
      resumeHint: `用户切换到 Agent 模式后，请重新调用刚才失败的工具（如 browser_click_smart 或 browser_type_smart）继续任务。`,
    };
  },
};

export default requestAgentMode;
