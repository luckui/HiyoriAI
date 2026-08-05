import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import type {
  AgentRuntimeProvider,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSubscription,
  StartRuntimeSessionInput,
} from '../types';
import { CodexAppServerClient, type CodexJsonRpcNotification } from './codexAppServerClient';

type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

interface CodexAppServerLike {
  start(): Promise<void>;
  request(method: string, params?: any, timeoutMs?: number): Promise<any>;
  onNotification(listener: (notification: CodexJsonRpcNotification) => void): () => void;
  onStderr?(listener: (message: string) => void): () => void;
}

export interface CodexRuntimeProviderOptions {
  createClient?: () => CodexAppServerLike;
}

interface CodexSessionState {
  session: RuntimeSession;
  threadId: string;
  currentTurnId?: string;
  unsubscribeNotifications: () => void;
}

function appServerEnv(): Record<string, string> {
  const proxy =
    process.env['CODEX_PROXY'] ||
    process.env['HTTPS_PROXY'] ||
    process.env['HTTP_PROXY'] ||
    process.env['DISCORD_PROXY'];
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (proxy) {
    env['HTTP_PROXY'] = env['HTTP_PROXY'] || proxy;
    env['HTTPS_PROXY'] = env['HTTPS_PROXY'] || proxy;
    env['http_proxy'] = env['http_proxy'] || proxy;
    env['https_proxy'] = env['https_proxy'] || proxy;
  }
  return env;
}

export function createCodexRuntimeProvider(
  options: CodexRuntimeProviderOptions = {}
): AgentRuntimeProvider {
  const emitter = new EventEmitter();
  const sessions = new Map<string, CodexSessionState>();
  const sessionsByThreadId = new Map<string, CodexSessionState>();
  let client: CodexAppServerLike | undefined;

  async function getClient(): Promise<CodexAppServerLike> {
    if (!client) client = options.createClient?.() ?? new CodexAppServerClient({ env: appServerEnv() });
    await client.start();
    return client;
  }

  function emit(session: RuntimeSession, type: RuntimeEvent['type'], content: string, raw?: unknown): void {
    const event: RuntimeEvent = {
      id: randomUUID(),
      sessionId: session.id,
      providerId: session.providerId,
      type,
      content,
      createdAt: Date.now(),
      raw: raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined,
    };
    emitter.emit(session.id, event);
  }

  function subscribeToThread(state: CodexSessionState, appServer: CodexAppServerLike): void {
    state.unsubscribeNotifications = appServer.onNotification((notification) => {
      const threadId = notification.params?.threadId;
      if (threadId !== state.threadId) return;
      applyNotification(state, notification);
    });
  }

  function applyNotification(state: CodexSessionState, notification: CodexJsonRpcNotification): void {
    const { session } = state;
    if (notification.method === 'turn/started') {
      state.currentTurnId = notification.params?.turn?.id;
      session.status = 'running';
      session.updatedAt = Date.now();
      emit(session, 'notification', 'codex turn started', notification);
      return;
    }

    if (notification.method === 'thread/status/changed') {
      session.status = mapThreadStatus(notification.params?.status);
      session.updatedAt = Date.now();
      emit(session, 'notification', `codex status: ${session.status}`, notification);
      return;
    }

    if (notification.method === 'item/agentMessage/delta') {
      session.updatedAt = Date.now();
      emit(session, 'assistant_delta', notification.params?.delta ?? '', notification);
      return;
    }

    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      emitItemEvent(session, notification.params?.item, notification);
      return;
    }

    if (notification.method === 'turn/completed') {
      session.status = notification.params?.turn?.status === 'failed' ? 'failed' : 'completed';
      session.updatedAt = Date.now();
      const errorMessage = notification.params?.turn?.error?.message;
      emit(session, session.status === 'failed' ? 'failed' : 'completed', errorMessage || 'codex turn completed', notification);
      return;
    }

    if (notification.method === 'error') {
      session.status = 'failed';
      session.updatedAt = Date.now();
      emit(session, 'failed', appServerErrorMessage(notification.params), notification);
      return;
    }

    if (typeof (notification as any).id === 'number') {
      session.status = 'waiting_for_input';
      session.updatedAt = Date.now();
      emit(session, 'waiting_for_input', `Codex app-server requested client action: ${notification.method}`, notification);
    }
  }

  function emitItemEvent(session: RuntimeSession, item: any, raw: CodexJsonRpcNotification): void {
    if (!item || typeof item !== 'object') return;

    if (item.type === 'agentMessage') {
      emit(session, 'assistant_message', item.text ?? '', raw);
      return;
    }

    if (item.type === 'reasoning') {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].filter(Boolean).join('\n');
      if (text) emit(session, 'assistant_delta', text, raw);
      return;
    }

    if (item.type === 'commandExecution') {
      emit(session, 'tool_call', `${item.command ?? ''}\n${item.aggregatedOutput ?? ''}`.trim(), raw);
      return;
    }

    if (item.type === 'mcpToolCall') {
      emit(session, 'tool_call', `${item.server}.${item.tool}`, raw);
      return;
    }

    if (item.type === 'dynamicToolCall') {
      emit(session, 'tool_call', `${item.namespace ? `${item.namespace}.` : ''}${item.tool}`, raw);
      return;
    }

    if (item.type === 'fileChange') {
      emit(
        session,
        'tool_result',
        (item.changes ?? []).map((change: any) => `${change.kind}: ${change.path}`).join('\n'),
        raw
      );
    }
  }

  function mapThreadStatus(status: any): RuntimeSession['status'] {
    if (status?.type === 'active') return 'running';
    if (status?.type === 'idle' || status?.type === 'notLoaded') return 'completed';
    if (status?.type === 'systemError') return 'failed';
    return 'running';
  }

  function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  function appServerErrorMessage(params: any): string {
    return (
      readString(params?.message) ||
      readString(params?.error?.message) ||
      readString(params?.error) ||
      'Codex app-server error'
    );
  }

  function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
    const effort = readString(value) as ReasoningEffort | undefined;
    if (!effort) return undefined;
    return effort === 'minimal' ? 'low' : effort;
  }

  function threadParams(input: StartRuntimeSessionInput): Record<string, unknown> {
    const metadata = input.metadata ?? {};
    return {
      cwd: input.cwd,
      model: readString(metadata.model),
      approvalPolicy: (readString(metadata.approvalPolicy) as ApprovalPolicy | undefined) ?? 'never',
      sandbox: (readString(metadata.sandboxMode) as SandboxMode | undefined) ?? 'danger-full-access',
      serviceName: 'Hiyori',
      threadSource: 'hiyori',
    };
  }

  function turnParams(threadId: string, content: string, input?: StartRuntimeSessionInput): Record<string, unknown> {
    const metadata = input?.metadata ?? {};
    return {
      threadId,
      input: [{ type: 'text', text: content, text_elements: [] }],
      cwd: input?.cwd,
      approvalPolicy: (readString(metadata.approvalPolicy) as ApprovalPolicy | undefined) ?? 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      model: readString(metadata.model),
      effort: normalizeReasoningEffort(metadata.modelReasoningEffort),
    };
  }

  function scheduleTurn(state: CodexSessionState, content: string, input?: StartRuntimeSessionInput): void {
    setTimeout(() => {
      void getClient()
        .then((appServer) => appServer.request('turn/start', turnParams(state.threadId, content, input), 30000))
        .catch((error) => {
          state.session.status = 'failed';
          state.session.updatedAt = Date.now();
          emit(state.session, 'failed', (error as Error).message);
        });
    }, 0);
  }

  return {
    id: 'codex',
    displayName: 'Codex',

    async checkAvailability() {
      try {
        await getClient();
        return { available: true };
      } catch (error) {
        return { available: false, reason: (error as Error).message };
      }
    },

    async startSession(input) {
      const appServer = await getClient();
      const resumeThreadId = readString(input.metadata?.providerSessionRef);
      const response = resumeThreadId
        ? await appServer.request('thread/resume', { threadId: resumeThreadId, ...threadParams(input) })
        : await appServer.request('thread/start', threadParams(input));
      const thread = response.thread;
      const now = Date.now();
      const session: RuntimeSession = {
        id: randomUUID(),
        providerId: 'codex',
        providerSessionRef: thread.id,
        hiyoriConversationId: input.hiyoriConversationId,
        cwd: thread.cwd ?? input.cwd,
        title: thread.name ?? input.title,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        metadata: { ...(input.metadata ?? {}), resumedProviderSessionRef: resumeThreadId || undefined },
      };
      const state: CodexSessionState = {
        session,
        threadId: thread.id,
        unsubscribeNotifications: () => undefined,
      };
      sessions.set(session.id, state);
      sessionsByThreadId.set(thread.id, state);
      subscribeToThread(state, appServer);
      emit(session, 'session_started', `codex thread started: ${thread.id}`, response);
      scheduleTurn(state, input.initialMessage, input);
      return session;
    },

    async resumeSession(input) {
      const codexThreadId = readString(input.metadata?.providerSessionRef);
      if (!codexThreadId) throw new Error('Codex providerSessionRef is required to resume a thread');
      const appServer = await getClient();
      const response = await appServer.request('thread/resume', {
        threadId: codexThreadId,
        ...threadParams({
          providerId: input.providerId,
          hiyoriConversationId: input.hiyoriConversationId,
          title: input.title,
          initialMessage: '',
          cwd: input.cwd,
          metadata: input.metadata,
        }),
      });
      const now = Date.now();
      const thread = response.thread;
      const session: RuntimeSession = {
        id: input.runtimeSessionId,
        providerId: 'codex',
        providerSessionRef: thread.id,
        hiyoriConversationId: input.hiyoriConversationId,
        cwd: thread.cwd ?? input.cwd,
        title: thread.name ?? input.title,
        status: mapThreadStatus(thread.status),
        createdAt: now,
        updatedAt: now,
        metadata: input.metadata ?? {},
      };
      const state: CodexSessionState = {
        session,
        threadId: thread.id,
        unsubscribeNotifications: () => undefined,
      };
      sessions.set(session.id, state);
      sessionsByThreadId.set(thread.id, state);
      subscribeToThread(state, appServer);
      return session;
    },

    async sendMessage(sessionId, message) {
      const state = sessions.get(sessionId);
      if (!state) throw new Error(`Codex runtime session not found: ${sessionId}`);
      state.session.status = 'running';
      state.session.updatedAt = Date.now();
      scheduleTurn(state, message.content);
    },

    async interrupt(sessionId) {
      const state = sessions.get(sessionId);
      if (!state) throw new Error(`Codex runtime session not found: ${sessionId}`);
      if (state.currentTurnId) {
        await (await getClient()).request('turn/interrupt', { threadId: state.threadId, turnId: state.currentTurnId });
      }
      state.session.status = 'interrupted';
      state.session.updatedAt = Date.now();
      emit(state.session, 'interrupted', 'codex turn interrupted');
    },

    async stop(sessionId) {
      const state = sessions.get(sessionId);
      if (!state) throw new Error(`Codex runtime session not found: ${sessionId}`);
      state.unsubscribeNotifications();
      sessions.delete(sessionId);
      sessionsByThreadId.delete(state.threadId);
      state.session.status = 'stopped';
      state.session.updatedAt = Date.now();
      emit(state.session, 'stopped', 'codex session stopped');
    },

    subscribe(sessionId, onEvent): RuntimeSubscription {
      emitter.on(sessionId, onEvent);
      return {
        unsubscribe() {
          emitter.off(sessionId, onEvent);
        },
      };
    },
  };
}

export function createCodexAppServerEnv(): Record<string, string> {
  return appServerEnv();
}
