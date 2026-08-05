import { codingAgentSessionRouter } from '../../codingAgents';
import { listCodexSessionCandidates } from '../../runtimes/providers/codexSessionDiscovery';
import type { ToolContext, ToolDefinition } from '../types';

type CodingAgentAction = 'send' | 'status' | 'sessions' | 'stop';

interface CodingAgentParams {
  action: CodingAgentAction;
  agent?: string;
  task?: string;
  cwd?: string;
  resume_session_id?: string;
  model?: string;
  reasoning_effort?: string;
  approval_policy?: string;
  sandbox_mode?: string;
  network_access_enabled?: boolean;
}

type CodexSessionDiscovery = typeof listCodexSessionCandidates;

interface SendSessionDecision {
  resumeSessionId?: string;
  userMessage?: string;
  resumedNotice?: string;
}

function conversationIdFrom(context?: ToolContext): string {
  return context?.conversationId || 'default';
}

function toolResult(status: string, nextStep: '回复用户' | '询问用户' | '继续执行', body: string): string {
  return [
    '【工具结果】',
    `状态：${status}`,
    `下一步：${nextStep}`,
    body,
  ].join('\n');
}

function suggestedReply(text: string): string {
  return `建议回复：\n${text}`;
}

function resultText(text: string): string {
  return `结果：\n${text}`;
}

function formatSessionChoice(session: Awaited<ReturnType<CodexSessionDiscovery>>[number], index: number): string {
  return [
    `${index + 1}. ${session.title || session.id}`,
    `   id: ${session.id}`,
    session.cwd ? `   cwd: ${session.cwd}` : undefined,
  ].filter(Boolean).join('\n');
}

export async function resolveSendSessionDecision(
  params: CodingAgentParams,
  discover: CodexSessionDiscovery = listCodexSessionCandidates
): Promise<SendSessionDecision> {
  const agent = params.agent?.trim() || 'codex';
  if (agent !== 'codex' || params.resume_session_id?.trim() || !params.cwd?.trim()) {
    return {};
  }

  const candidates = await discover({ cwd: params.cwd, limit: 2 });
  if (candidates.length === 0) return {};
  if (candidates.length === 1) {
    return {
      resumeSessionId: candidates[0].id,
      resumedNotice: `已自动恢复该目录最近的 Codex 任务：${candidates[0].title || candidates[0].id}`,
    };
  }

  return {
    userMessage: toolResult('需要用户选择', '询问用户', suggestedReply([
      `找到多个可恢复的 Codex 任务（目录：${params.cwd}）。`,
      '请选择要继续哪一个，或选择新建任务：',
      '',
      ...candidates.map(formatSessionChoice),
      `${candidates.length + 1}. 新建任务`,
    ].join('\n'))),
  };
}

const codingAgentTool: ToolDefinition<CodingAgentParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'coding_agent',
      description:
        'Send development tasks to Codex or another coding agent asynchronously. ' +
        'For normal programming-agent requests, use action="send" with the project cwd and the user task. ' +
        'If the user names a Codex project but cwd is unknown, call codex_projects first to resolve the project. ' +
        'Codex tasks submitted through Hiyori are unattended and high-autonomy: approval prompts and Windows sandbox popups are avoided by the router. ' +
        'A successful send means the task is submitted; the final result will arrive later as an async result notification. ' +
        'Use status/sessions/stop only when the user explicitly asks for progress, available sessions, or stopping.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['send', 'status', 'sessions', 'stop'],
            description:
              'send submits a task asynchronously; status checks progress on explicit user request; sessions lists resumable Codex tasks; stop releases the selected project binding.',
          },
          agent: {
            type: 'string',
            description: 'Optional agent name. Defaults to codex. Use fake only for development tests.',
          },
          task: {
            type: 'string',
            description: 'The programming task to submit when action=send.',
          },
          cwd: {
            type: 'string',
            description: 'Project directory for the coding agent. Use the current project path when known.',
          },
          resume_session_id: {
            type: 'string',
            description: 'Optional Codex task/thread id selected by the user.',
          },
          model: {
            type: 'string',
            description: 'Optional model override for the coding agent, for example gpt-5.1-codex.',
          },
          reasoning_effort: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'xhigh'],
            description: 'Optional Codex reasoning effort. Use low for lightweight tasks.',
          },
          approval_policy: {
            type: 'string',
            enum: ['never', 'on-request', 'on-failure', 'untrusted'],
            description: 'Ignored for Codex through Hiyori; Codex is forced to approval_policy=never to avoid blocking popups.',
          },
          sandbox_mode: {
            type: 'string',
            enum: ['read-only', 'workspace-write', 'danger-full-access'],
            description: 'Ignored for Codex through Hiyori; Codex is forced to danger-full-access to avoid Windows sandbox popups.',
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

    if (params.action === 'send') {
      if (!params.task?.trim()) {
        return toolResult('需要补充信息', '询问用户', suggestedReply('请告诉我要交给编程代理处理的具体任务。'));
      }
      const sendDecision = await resolveSendSessionDecision(params);
      if (sendDecision.userMessage) return sendDecision.userMessage;
      const result = await codingAgentSessionRouter.send({
        conversationId,
        agent: params.agent || 'codex',
        task: params.task,
        cwd: params.cwd,
        resumeSessionId: params.resume_session_id || sendDecision.resumeSessionId,
        model: params.model,
        reasoningEffort: params.reasoning_effort,
        approvalPolicy: params.approval_policy,
        sandboxMode: params.sandbox_mode,
        networkAccessEnabled: params.network_access_enabled,
      });
      const message = sendDecision.resumedNotice
        ? `${sendDecision.resumedNotice}\n${result.userMessage}`
        : result.userMessage;
      return toolResult('已提交', '回复用户', suggestedReply(message));
    }

    if (params.action === 'status') {
      const result = await codingAgentSessionRouter.status({
        conversationId,
        agent: params.agent,
        cwd: params.cwd,
      });
      return toolResult('已查询', '回复用户', resultText(result.userMessage));
    }

    if (params.action === 'sessions') {
      const candidates = await listCodexSessionCandidates({ cwd: params.cwd, limit: 5 });
      if (!candidates.length) {
        const message = params.cwd
          ? `没有找到目录 ${params.cwd} 对应的可恢复 Codex 任务。`
          : '没有找到可恢复 Codex 任务。';
        return toolResult('已查询', '回复用户', resultText(message));
      }
      return toolResult('已查询', '回复用户', resultText([
        params.cwd ? `最近可恢复的 Codex 任务（目录：${params.cwd}）：` : '最近可恢复的 Codex 任务：',
        ...candidates.map(formatSessionChoice),
      ].join('\n')));
    }

    if (params.action === 'stop') {
      const result = await codingAgentSessionRouter.stop({
        conversationId,
        agent: params.agent,
        cwd: params.cwd,
      });
      return toolResult('已处理', '回复用户', resultText(result.userMessage));
    }

    return toolResult('无法处理', '回复用户', resultText('不支持的编程代理操作。'));
  },
};

export default codingAgentTool;
