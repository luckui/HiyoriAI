import { codingAgentSessionRouter } from '../../codingAgents';
import type { ToolContext, ToolDefinition } from '../types';

type CodingAgentAction = 'start' | 'continue' | 'status' | 'stop';

interface CodingAgentParams {
  action: CodingAgentAction;
  agent?: string;
  task?: string;
  message?: string;
  cwd?: string;
}

function conversationIdFrom(context?: ToolContext): string {
  return context?.conversationId || 'default';
}

const codingAgentTool: ToolDefinition<CodingAgentParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'coding_agent',
      description:
        'User-facing bridge to Codex or another coding agent. Use when the user asks to let Codex, Claude Code, or a coding agent handle a programming task, continue it, check status, or stop it. Do not expose runtime/provider/session ids to the user.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'continue', 'status', 'stop'],
            description:
              'start a new coding-agent task, continue the active task, report status, or stop the active task.',
          },
          agent: {
            type: 'string',
            description: 'Optional agent name. Defaults to codex. Use fake only for development tests.',
          },
          task: {
            type: 'string',
            description: 'The programming task to send when action=start.',
          },
          message: {
            type: 'string',
            description: 'Message to send when action=continue.',
          },
          cwd: {
            type: 'string',
            description: 'Project directory for the coding agent. Use the current project path when known.',
          },
        },
        required: ['action'],
      },
    },
  },

  async execute(params, context?: ToolContext) {
    const conversationId = conversationIdFrom(context);

    if (params.action === 'start') {
      if (!params.task?.trim()) return '请告诉我要交给编程代理处理的具体任务。';
      const result = await codingAgentSessionRouter.start({
        conversationId,
        agent: params.agent || 'codex',
        task: params.task,
        cwd: params.cwd,
      });
      return result.userMessage;
    }

    if (params.action === 'continue') {
      const result = await codingAgentSessionRouter.continue({
        conversationId,
        message: params.message?.trim() || '继续',
      });
      return result.userMessage;
    }

    if (params.action === 'status') {
      const result = await codingAgentSessionRouter.status({ conversationId });
      return result.userMessage;
    }

    if (params.action === 'stop') {
      const result = await codingAgentSessionRouter.stop({ conversationId });
      return result.userMessage;
    }

    return '不支持的编程代理操作。';
  },
};

export default codingAgentTool;
