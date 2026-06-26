import { normalize } from 'path';
import type { RuntimeEvent, RuntimeSession } from '../runtimes/types';
import type { RuntimeHost } from '../runtimes/runtimeHost';

export type CodingAgentActionResultKind =
  | 'started'
  | 'already_active'
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
  resumeSessionId?: string;
  model?: string;
  reasoningEffort?: string;
  approvalPolicy?: string;
  sandboxMode?: string;
  networkAccessEnabled?: boolean;
}

export interface ContinueCodingAgentInput {
  conversationId: string;
  agent?: string;
  cwd?: string;
  message: string;
}

export interface ConversationCodingAgentInput {
  conversationId: string;
  agent?: string;
  cwd?: string;
}

export type CodingAgentNotifier = (conversationId: string, content: string) => Promise<void> | void;
export type CodingAgentTerminalNotifier = (event: {
  conversationId: string;
  sessionId: string;
  blockId: string;
  title: string;
  line?: string;
  status?: 'running' | 'idle' | 'done' | 'error';
}) => Promise<void> | void;

interface CodingAgentBinding {
  conversationId: string;
  sessionId: string;
  agent: string;
  displayName: string;
  cwd?: string;
  scopeKey: string;
}

export class CodingAgentSessionRouter {
  private readonly bindings = new Map<string, CodingAgentBinding>();
  private readonly scopedBindings = new Map<string, CodingAgentBinding>();
  private readonly sessionsToConversations = new Map<string, string>();
  private readonly deliveredEvents = new Set<string>();
  private readonly lastAssistantMessages = new Map<string, string>();
  private readonly terminalTurns = new Map<string, { index: number; blockId: string; idle: boolean }>();
  private notifier: CodingAgentNotifier | undefined;
  private terminalNotifier: CodingAgentTerminalNotifier | undefined;

  constructor(private readonly runtimeHost: RuntimeHost) {
    this.runtimeHost.onRuntimeEvent((event) => {
      void this.handleRuntimeEvent(event);
    });
  }

  setNotifier(notifier: CodingAgentNotifier | undefined): void {
    this.notifier = notifier;
  }

  setTerminalNotifier(notifier: CodingAgentTerminalNotifier | undefined): void {
    this.terminalNotifier = notifier;
  }

  async start(input: StartCodingAgentInput): Promise<CodingAgentActionResult> {
    const agent = input.agent?.trim() || 'codex';
    const scopeKey = this.scopeKey(input.conversationId, agent, input.cwd);
    const existing = this.scopedBindings.get(scopeKey);
    if (existing) {
      this.bindings.set(input.conversationId, existing);
      return {
        kind: 'already_active',
        sessionId: existing.sessionId,
        userMessage:
          `${existing.displayName} already has a managed session for this project. ` +
          'Use continue to add instructions, or stop this project session before starting a replacement.',
      };
    }

    const session = await this.runtimeHost.startSession({
      providerId: agent,
      hiyoriConversationId: input.conversationId,
      title: this.titleFromTask(input.task),
      initialMessage: input.task,
      cwd: input.cwd,
      metadata: this.buildSessionMetadata(input),
    });
    const displayName = this.displayName(session);
    this.bindings.set(input.conversationId, {
      conversationId: input.conversationId,
      sessionId: session.id,
      agent,
      displayName,
      cwd: input.cwd,
      scopeKey,
    });
    this.scopedBindings.set(scopeKey, {
      conversationId: input.conversationId,
      sessionId: session.id,
      agent,
      displayName,
      cwd: input.cwd,
      scopeKey,
    });
    this.sessionsToConversations.set(session.id, input.conversationId);
    await this.forwardUserMessage(input.conversationId, session.id, displayName, input.task);

    return {
      kind: 'started',
      sessionId: session.id,
      userMessage: `已交给 ${displayName}。完成后我会读取最终结果，再决定如何转述给你。`,
    };
  }

  async continue(input: ContinueCodingAgentInput): Promise<CodingAgentActionResult> {
    const binding = this.resolveBinding(input);
    if (!binding) return this.missingSession();

    await this.runtimeHost.sendMessage(binding.sessionId, { content: input.message });
    await this.forwardUserMessage(input.conversationId, binding.sessionId, binding.displayName, input.message);
    return {
      kind: 'continued',
      sessionId: binding.sessionId,
      userMessage: `已发送给 ${binding.displayName}。我会等待最终结果。`,
    };
  }

  async status(input: ConversationCodingAgentInput): Promise<CodingAgentActionResult> {
    const binding = this.resolveBinding(input);
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
    const binding = this.resolveBinding(input);
    if (!binding) return this.missingSession();

    await this.runtimeHost.stop(binding.sessionId);
    if (this.bindings.get(input.conversationId)?.sessionId === binding.sessionId) {
      this.bindings.delete(input.conversationId);
    }
    this.scopedBindings.delete(binding.scopeKey);
    this.sessionsToConversations.delete(binding.sessionId);
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

  private resolveBinding(input: ConversationCodingAgentInput): CodingAgentBinding | undefined {
    if (input.cwd?.trim()) {
      const requestedCwd = this.normalizedCwd(input.cwd);
      const agent = input.agent?.trim();
      const matches = Array.from(this.scopedBindings.values()).filter((binding) => (
        binding.conversationId === input.conversationId &&
        this.normalizedCwd(binding.cwd) === requestedCwd &&
        (!agent || binding.agent === agent)
      ));
      const scoped = matches.length === 1 ? matches[0] : undefined;
      if (scoped) this.bindings.set(input.conversationId, scoped);
      return scoped;
    }
    return this.bindings.get(input.conversationId);
  }

  private scopeKey(conversationId: string, agent: string, cwd?: string): string {
    const normalizedCwd = this.normalizedCwd(cwd);
    return `${conversationId}\0${agent.trim() || 'codex'}\0${normalizedCwd}`;
  }

  private normalizedCwd(cwd?: string): string {
    return cwd?.trim() ? normalize(cwd).toLowerCase() : '<default>';
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

  private buildSessionMetadata(input: StartCodingAgentInput): Record<string, unknown> {
    return {
      providerSessionRef: input.resumeSessionId?.trim() || undefined,
      model: input.model?.trim() || undefined,
      modelReasoningEffort: input.reasoningEffort?.trim() || undefined,
      approvalPolicy: input.approvalPolicy?.trim() || undefined,
      sandboxMode: input.sandboxMode?.trim() || undefined,
      networkAccessEnabled: input.networkAccessEnabled,
      skipGitRepoCheck: !!input.cwd?.trim(),
    };
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
    const visibleEvents = events.filter((event) => this.isStatusVisibleEvent(event));
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

  private isStatusVisibleEvent(event: RuntimeEvent): boolean {
    return (
      event.type === 'assistant_message' ||
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

  private async handleRuntimeEvent(event: RuntimeEvent): Promise<void> {
    this.recordRuntimeEvent(event);
    await this.forwardTerminalEvent(event);

    if (this.deliveredEvents.has(event.id)) return;
    const conversationId = this.sessionsToConversations.get(event.sessionId);
    if (!conversationId || !this.notifier) return;

    const session = this.runtimeHost.getSession(event.sessionId);
    const displayName = session ? this.displayName(session) : event.providerId;
    const content = this.formatDelivery(displayName, event, session);
    if (!content) return;

    this.deliveredEvents.add(event.id);
    await this.notifier(conversationId, content);
  }

  private recordRuntimeEvent(event: RuntimeEvent): void {
    if (event.type === 'assistant_message' && event.content.trim()) {
      this.lastAssistantMessages.set(event.sessionId, event.content.trim());
      return;
    }
    if (event.type === 'failed' || event.type === 'interrupted' || event.type === 'stopped') {
      this.lastAssistantMessages.delete(event.sessionId);
    }
  }

  private async forwardTerminalEvent(event: RuntimeEvent): Promise<void> {
    if (!this.terminalNotifier) return;
    const conversationId = this.sessionsToConversations.get(event.sessionId);
    if (!conversationId) return;

    const session = this.runtimeHost.getSession(event.sessionId);
    const displayName = session ? this.displayName(session) : event.providerId;
    const title = `${displayName}${session?.title ? `: ${session.title}` : ''}`;
    const terminalEvent = this.formatTerminalEvent(event);
    if (!terminalEvent) return;
    const blockId = this.resolveTerminalBlockId(event);

    await this.terminalNotifier({
      conversationId,
      sessionId: event.sessionId,
      blockId,
      title,
      ...terminalEvent,
    });
  }

  private async forwardUserMessage(
    conversationId: string,
    sessionId: string,
    displayName: string,
    content: string
  ): Promise<void> {
    if (!this.terminalNotifier) return;
    const session = this.runtimeHost.getSession(sessionId);
    const title = `${displayName}${session?.title ? `: ${session.title}` : ''}`;
    const blockId = this.resolveTerminalBlockId({
      id: `user-message:${Date.now()}`,
      sessionId,
      providerId: session?.providerId ?? displayName,
      type: 'notification',
      content: 'turn started',
      createdAt: Date.now(),
    });

    await this.terminalNotifier({
      conversationId,
      sessionId,
      blockId,
      title,
      line: `Hiyori -> ${displayName}: ${content}`,
      status: 'running',
    });
  }

  private resolveTerminalBlockId(event: RuntimeEvent): string {
    const existing = this.terminalTurns.get(event.sessionId);
    if (!existing) {
      const next = { index: 1, blockId: `${event.sessionId}:turn-1`, idle: false };
      this.terminalTurns.set(event.sessionId, next);
      return next.blockId;
    }

    if (event.type === 'notification' && event.content.includes('turn started') && existing.idle) {
      const nextIndex = existing.index + 1;
      const next = {
        index: nextIndex,
        blockId: `${event.sessionId}:turn-${nextIndex}`,
        idle: false,
      };
      this.terminalTurns.set(event.sessionId, next);
      return next.blockId;
    }

    if (event.type === 'completed') {
      existing.idle = true;
    }
    if (event.type === 'failed' || event.type === 'interrupted' || event.type === 'stopped') {
      existing.idle = true;
    }
    return existing.blockId;
  }

  private formatTerminalEvent(event: RuntimeEvent): { line?: string; status?: 'running' | 'idle' | 'done' | 'error' } | null {
    if (event.type === 'session_started') return { status: 'running' };
    if (event.type === 'notification') {
      if (event.content.startsWith('Reconnecting...')) return { line: event.content, status: 'running' };
      return { status: 'running' };
    }
    if (event.type === 'assistant_message') return { line: event.content, status: 'running' };
    if (event.type === 'tool_call' || event.type === 'tool_result') return { status: 'running' };
    if (event.type === 'completed') return { status: 'idle' };
    if (event.type === 'failed') return { line: event.content, status: 'error' };
    if (event.type === 'interrupted' || event.type === 'stopped') return { line: event.content, status: 'done' };
    return null;
  }

  private formatDelivery(
    displayName: string,
    event: RuntimeEvent,
    session: RuntimeSession | undefined
  ): string | null {
    if (!event.content.trim()) return null;

    if (event.type === 'approval_requested') {
      return `${displayName} 需要你批准：\n${event.content}`;
    }
    if (event.type === 'completed') {
      const finalResponse = this.lastAssistantMessages.get(event.sessionId);
      if (!finalResponse) return null;
      this.lastAssistantMessages.delete(event.sessionId);
      return [
        `【系统通知】${displayName} 编程代理任务已完成。`,
        session?.title ? `任务：${session.title}` : undefined,
        '',
        `这是 ${displayName} 的最终回复，请你理解结果后，用自己的话向用户转述；不要原样扮演 ${displayName}，也不要暴露执行过程细节。`,
        '不要再调用 coding_agent 的 status、result、continue 或 start 来确认本次结果；下面已经是本轮最终回复。除非用户明确提出新的编程代理指令，否则请直接回复用户。',
        '',
        finalResponse,
      ].filter((line): line is string => line !== undefined).join('\n');
    }
    if (event.type === 'failed') return null;
    if (event.type === 'interrupted') return `${displayName} 已中断。`;
    if (event.type === 'stopped') return `${displayName} 已停止。`;
    return null;
  }
}
