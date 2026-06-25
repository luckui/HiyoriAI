import type { RuntimeEvent, RuntimeSession } from '../runtimes/types';
import type { RuntimeHost } from '../runtimes/runtimeHost';

export type CodingAgentActionResultKind =
  | 'started'
  | 'continued'
  | 'status'
  | 'stopped'
  | 'missing_session';

export interface CodingAgentActionResult {
  kind: CodingAgentActionResultKind;
  userMessage: string;
  sessionId: string;
}

export interface StartCodingAgentInput {
  conversationId: string;
  agent?: string;
  task: string;
  cwd?: string;
}

export interface ContinueCodingAgentInput {
  conversationId: string;
  message: string;
}

export interface ConversationCodingAgentInput {
  conversationId: string;
}

interface CodingAgentBinding {
  conversationId: string;
  sessionId: string;
  agent: string;
  displayName: string;
}

export class CodingAgentSessionRouter {
  private readonly bindings = new Map<string, CodingAgentBinding>();

  constructor(private readonly runtimeHost: RuntimeHost) {}

  async start(input: StartCodingAgentInput): Promise<CodingAgentActionResult> {
    const agent = input.agent?.trim() || 'codex';
    const session = await this.runtimeHost.startSession({
      providerId: agent,
      hiyoriConversationId: input.conversationId,
      title: this.titleFromTask(input.task),
      initialMessage: input.task,
      cwd: input.cwd,
    });
    const displayName = this.displayName(session);
    this.bindings.set(input.conversationId, {
      conversationId: input.conversationId,
      sessionId: session.id,
      agent,
      displayName,
    });

    return {
      kind: 'started',
      sessionId: session.id,
      userMessage: `已交给 ${displayName}，我会把它的进展和结果带回这个对话。`,
    };
  }

  async continue(input: ContinueCodingAgentInput): Promise<CodingAgentActionResult> {
    const binding = this.bindings.get(input.conversationId);
    if (!binding) return this.missingSession();

    await this.runtimeHost.sendMessage(binding.sessionId, { content: input.message });
    return {
      kind: 'continued',
      sessionId: binding.sessionId,
      userMessage: `已发送给 ${binding.displayName}，后续进展会继续回到这个对话。`,
    };
  }

  async status(input: ConversationCodingAgentInput): Promise<CodingAgentActionResult> {
    const binding = this.bindings.get(input.conversationId);
    if (!binding) return this.missingSession();

    const session = this.runtimeHost.getSession(binding.sessionId);
    const events = this.runtimeHost.listEvents(binding.sessionId);
    return {
      kind: 'status',
      sessionId: binding.sessionId,
      userMessage: this.formatStatus(binding, session, events),
    };
  }

  async stop(input: ConversationCodingAgentInput): Promise<CodingAgentActionResult> {
    const binding = this.bindings.get(input.conversationId);
    if (!binding) return this.missingSession();

    await this.runtimeHost.stop(binding.sessionId);
    this.bindings.delete(input.conversationId);
    return {
      kind: 'stopped',
      sessionId: binding.sessionId,
      userMessage: `已停止 ${binding.displayName} 当前任务。`,
    };
  }

  getActiveSession(conversationId: string): RuntimeSession | undefined {
    const binding = this.bindings.get(conversationId);
    return binding ? this.runtimeHost.getSession(binding.sessionId) : undefined;
  }

  private missingSession(): CodingAgentActionResult {
    return {
      kind: 'missing_session',
      sessionId: '',
      userMessage: '当前没有正在进行的编程代理任务。请告诉我要交给 Codex 做什么。',
    };
  }

  private titleFromTask(task: string): string {
    const normalized = task.trim().replace(/\s+/g, ' ');
    return normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized || 'Coding Agent Task';
  }

  private displayName(session: RuntimeSession): string {
    if (session.providerId === 'codex') return 'Codex';
    if (session.providerId === 'fake') return 'Fake Runtime';
    return session.providerId;
  }

  private formatStatus(
    binding: CodingAgentBinding,
    session: RuntimeSession | undefined,
    events: RuntimeEvent[]
  ): string {
    const status = session?.status ?? 'unknown';
    const visibleEvents = events.filter((event) => this.isUserVisibleEvent(event));
    const recent = visibleEvents.slice(-8);
    const lines = [
      `${binding.displayName} 当前状态：${status}`,
      recent.length
        ? '最近进展：'
        : `${binding.displayName} 已启动，正在处理；尚未收到可展示的回复、操作结果或完成消息。`,
    ];

    for (const event of recent) {
      if (!event.content.trim()) continue;
      lines.push(`- ${this.eventLabel(event.type)}：${event.content}`);
    }
    return lines.join('\n');
  }

  private isUserVisibleEvent(event: RuntimeEvent): boolean {
    return (
      event.type === 'assistant_message' ||
      event.type === 'tool_call' ||
      event.type === 'tool_result' ||
      event.type === 'approval_requested' ||
      event.type === 'notification' ||
      event.type === 'completed' ||
      event.type === 'failed' ||
      event.type === 'interrupted' ||
      event.type === 'stopped'
    );
  }

  private eventLabel(type: RuntimeEvent['type']): string {
    if (type === 'assistant_message') return '回复';
    if (type === 'tool_call') return '操作';
    if (type === 'tool_result') return '结果';
    if (type === 'approval_requested') return '需要批准';
    if (type === 'failed') return '失败';
    if (type === 'completed') return '完成';
    if (type === 'interrupted') return '已中断';
    if (type === 'stopped') return '已停止';
    return '事件';
  }
}
