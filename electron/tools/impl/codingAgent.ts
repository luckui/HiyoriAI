import { codingAgentSessionRouter } from '../../codingAgents';
import { listCodexSessionCandidates } from '../../runtimes/providers/codexSessionDiscovery';
import type { ToolContext, ToolDefinition } from '../types';

type CodingAgentAction = 'start' | 'continue' | 'status' | 'result' | 'sessions' | 'stop';

interface CodingAgentParams {
  action: CodingAgentAction;
  agent?: string;
  task?: string;
  message?: string;
  cwd?: string;
  resume_session_id?: string;
  model?: string;
  reasoning_effort?: string;
  approval_policy?: string;
  sandbox_mode?: string;
  network_access_enabled?: boolean;
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
        'User-facing bridge to Codex or another coding agent. Use start only when the current conversation has no active coding-agent session; use continue to add instructions to the bound session; use status/result to inspect it; use stop before replacing it. Never retry start automatically after a failure or wakeup.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'continue', 'status', 'result', 'sessions', 'stop'],
            description:
              'start creates/resumes the one managed session for this conversation, continue sends a new turn to that same session, status/result inspects it, sessions lists Codex threads, stop releases the binding.',
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
          resume_session_id: {
            type: 'string',
            description:
              'Optional Codex/agent session or thread id to resume. Use this when the user wants to continue an existing project conversation instead of starting fresh.',
          },
          model: {
            type: 'string',
            description: 'Optional model override for the coding agent, for example gpt-5.1-codex.',
          },
          reasoning_effort: {
            type: 'string',
            enum: ['minimal', 'low', 'medium', 'high', 'xhigh'],
            description: 'Optional Codex reasoning effort.',
          },
          approval_policy: {
            type: 'string',
            enum: ['never', 'on-request', 'on-failure', 'untrusted'],
            description: 'Optional Codex approval policy.',
          },
          sandbox_mode: {
            type: 'string',
            enum: ['read-only', 'workspace-write', 'danger-full-access'],
            description: 'Optional Codex sandbox mode.',
          },
          network_access_enabled: {
            type: 'boolean',
            description: 'Optional Codex network access setting for workspace-write sandbox.',
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
        resumeSessionId: params.resume_session_id,
        model: params.model,
        reasoningEffort: params.reasoning_effort,
        approvalPolicy: params.approval_policy,
        sandboxMode: params.sandbox_mode,
        networkAccessEnabled: params.network_access_enabled,
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

    if (params.action === 'status' || params.action === 'result') {
      const result = await codingAgentSessionRouter.status({ conversationId });
      return result.userMessage;
    }

    if (params.action === 'sessions') {
      const candidates = await listCodexSessionCandidates({ cwd: params.cwd, limit: 5 });
      if (!candidates.length) {
        return params.cwd
          ? `没有找到目录 ${params.cwd} 对应的可恢复 Codex 会话。可以直接 start 新任务，或让用户提供 Codex thread id。`
          : '没有找到可恢复 Codex 会话。可以直接 start 新任务，或让用户提供 Codex thread id。';
      }
      return [
        params.cwd ? `最近可恢复的 Codex 会话（目录：${params.cwd}）：` : '最近可恢复的 Codex 会话：',
        ...candidates.map((session, index) => (
          `${index + 1}. ${session.id}${session.cwd ? `\n   cwd: ${session.cwd}` : ''}`
        )),
        '',
        '继续已有会话时，用 coding_agent(action="start", resume_session_id="<上面的 id>", cwd="<项目目录>", task="<新指令>")。',
      ].join('\n');
    }

    if (params.action === 'stop') {
      const result = await codingAgentSessionRouter.stop({ conversationId });
      return result.userMessage;
    }

    return '不支持的编程代理操作。';
  },
};

export default codingAgentTool;
