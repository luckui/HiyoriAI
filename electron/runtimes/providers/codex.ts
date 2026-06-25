import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  AgentRuntimeProvider,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSubscription,
  StartRuntimeSessionInput,
} from '../types';
import type {
  ApprovalMode,
  CodexOptions,
  SandboxMode,
  Thread,
  ThreadEvent,
  ThreadOptions,
  WebSearchMode,
} from '@openai/codex-sdk';

interface CodexClientLike {
  startThread(options?: ThreadOptions): ThreadLike;
  resumeThread(id: string, options?: ThreadOptions): ThreadLike;
}

interface ThreadLike {
  readonly id: string | null;
  runStreamed(input: string): Promise<{
    events: AsyncGenerator<ThreadEventLike>;
  }>;
}

type ThreadEventLike = ThreadEvent;

type CodexSdkModule = typeof import('@openai/codex-sdk');

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<CodexSdkModule>;

export interface CodexRuntimeProviderOptions {
  createClient?: () => CodexClientLike;
  codexOptions?: CodexOptions;
}

interface CodexSessionState {
  session: RuntimeSession;
  thread: ThreadLike;
  abortController?: AbortController;
}

export function createCodexRuntimeProvider(
  options: CodexRuntimeProviderOptions = {}
): AgentRuntimeProvider {
  const emitter = new EventEmitter();
  const sessions = new Map<string, CodexSessionState>();
  let client: CodexClientLike | undefined;

  async function getClient(): Promise<CodexClientLike> {
    if (!client) {
      if (options.createClient) {
        client = options.createClient();
      } else {
        const { Codex } = await dynamicImport('@openai/codex-sdk');
        client = new Codex(createCodexSdkOptions(options.codexOptions));
      }
    }
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

  async function runTurn(state: CodexSessionState, input: string): Promise<void> {
    const { events } = await state.thread.runStreamed(input);
    for await (const event of events) {
      applyThreadEvent(state, event);
    }
  }

  function scheduleTurn(state: CodexSessionState, input: string): void {
    setTimeout(() => {
      void runTurn(state, input).catch((error) => {
        state.session.status = 'failed';
        state.session.updatedAt = Date.now();
        emit(state.session, 'failed', (error as Error).message);
      });
    }, 0);
  }

  function applyThreadEvent(state: CodexSessionState, event: ThreadEventLike): void {
    const { session } = state;
    if (event.type === 'thread.started') {
      session.providerSessionRef = event.thread_id;
      session.metadata = { ...session.metadata, codexThreadId: event.thread_id };
      session.updatedAt = Date.now();
      emit(session, 'session_started', `codex thread started: ${event.thread_id}`, event);
      return;
    }

    if (event.type === 'turn.started') {
      session.status = 'running';
      session.updatedAt = Date.now();
      emit(session, 'notification', 'codex turn started', event);
      return;
    }

    if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
      emitItemEvent(session, event.item, event);
      return;
    }

    if (event.type === 'turn.completed') {
      session.status = 'completed';
      session.updatedAt = Date.now();
      emit(session, 'completed', 'codex turn completed', event);
      return;
    }

    if (event.type === 'turn.failed') {
      session.status = 'failed';
      session.updatedAt = Date.now();
      emit(session, 'failed', event.error.message, event);
      return;
    }

    if (event.type === 'error' && event.message.startsWith('Reconnecting...')) {
      session.updatedAt = Date.now();
      emit(session, 'notification', event.message, event);
      return;
    }

    if (event.type === 'error') {
      session.status = 'failed';
      session.updatedAt = Date.now();
      emit(session, 'failed', event.message, event);
    }
  }

  function emitItemEvent(
    session: RuntimeSession,
    item: ThreadEventLike extends { item: infer Item } ? Item : never,
    raw: ThreadEventLike
  ): void {
    if (!item || typeof item !== 'object' || !('type' in item)) return;

    if (item.type === 'agent_message') {
      emit(session, 'assistant_message', item.text, raw);
      return;
    }

    if (item.type === 'reasoning') {
      emit(session, 'assistant_delta', item.text, raw);
      return;
    }

    if (item.type === 'command_execution') {
      emit(session, 'tool_call', `${item.command}\n${item.aggregated_output}`.trim(), raw);
      return;
    }

    if (item.type === 'mcp_tool_call') {
      emit(session, 'tool_call', `${item.server}.${item.tool}`, raw);
      return;
    }

    if (item.type === 'file_change') {
      emit(
        session,
        'tool_result',
        item.changes.map((change) => `${change.kind}: ${change.path}`).join('\n'),
        raw
      );
      return;
    }

    if (item.type === 'error') {
      emit(session, 'failed', item.message, raw);
    }
  }

  function createThreadOptions(input: StartRuntimeSessionInput): ThreadOptions {
    const metadata = input.metadata ?? {};
    return {
      workingDirectory: input.cwd,
      skipGitRepoCheck: metadata.skipGitRepoCheck === true ? true : undefined,
      sandboxMode: readString(metadata.sandboxMode) as SandboxMode | undefined,
      approvalPolicy: readString(metadata.approvalPolicy) as ApprovalMode | undefined,
      model: readString(metadata.model),
      modelReasoningEffort: readString(metadata.modelReasoningEffort) as ThreadOptions['modelReasoningEffort'],
      networkAccessEnabled:
        typeof metadata.networkAccessEnabled === 'boolean' ? metadata.networkAccessEnabled : undefined,
      webSearchMode: readString(metadata.webSearchMode) as WebSearchMode | undefined,
      webSearchEnabled: typeof metadata.webSearchEnabled === 'boolean' ? metadata.webSearchEnabled : undefined,
      additionalDirectories: Array.isArray(metadata.additionalDirectories)
        ? metadata.additionalDirectories.filter((value): value is string => typeof value === 'string')
        : undefined,
    };
  }

  function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
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
      const now = Date.now();
      const thread = (await getClient()).startThread(createThreadOptions(input));
      const session: RuntimeSession = {
        id: randomUUID(),
        providerId: 'codex',
        providerSessionRef: thread.id ?? '',
        hiyoriConversationId: input.hiyoriConversationId,
        cwd: input.cwd,
        title: input.title,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        metadata: input.metadata ?? {},
      };
      const state: CodexSessionState = { session, thread };
      sessions.set(session.id, state);
      scheduleTurn(state, input.initialMessage);
      return session;
    },

    async resumeSession(input) {
      const codexThreadId = readString(input.metadata?.providerSessionRef);
      if (!codexThreadId) {
        throw new Error('Codex providerSessionRef is required to resume a thread');
      }
      const now = Date.now();
      const thread = (await getClient()).resumeThread(codexThreadId, {
        workingDirectory: input.cwd,
      });
      const session: RuntimeSession = {
        id: input.runtimeSessionId,
        providerId: 'codex',
        providerSessionRef: codexThreadId,
        hiyoriConversationId: input.hiyoriConversationId,
        cwd: input.cwd,
        title: input.title,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        metadata: input.metadata ?? {},
      };
      sessions.set(session.id, { session, thread });
      return session;
    },

    async sendMessage(sessionId, message) {
      const state = sessions.get(sessionId);
      if (!state) throw new Error(`Codex runtime session not found: ${sessionId}`);
      state.session.status = 'running';
      state.session.updatedAt = Date.now();
      await runTurn(state, message.content);
    },

    async interrupt(sessionId) {
      const state = sessions.get(sessionId);
      if (!state) throw new Error(`Codex runtime session not found: ${sessionId}`);
      state.abortController?.abort();
      state.session.status = 'interrupted';
      state.session.updatedAt = Date.now();
      emit(state.session, 'interrupted', 'codex turn interrupted');
    },

    async stop(sessionId) {
      const state = sessions.get(sessionId);
      if (!state) throw new Error(`Codex runtime session not found: ${sessionId}`);
      state.abortController?.abort();
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

export function createCodexSdkOptions(baseOptions?: CodexOptions): CodexOptions | undefined {
  if (baseOptions?.env) return baseOptions;
  const proxy =
    process.env['CODEX_PROXY'] ||
    process.env['HTTPS_PROXY'] ||
    process.env['HTTP_PROXY'] ||
    process.env['DISCORD_PROXY'];

  if (!proxy) return baseOptions;

  return {
    ...baseOptions,
    env: {
      ...process.env,
      HTTP_PROXY: process.env['HTTP_PROXY'] || proxy,
      HTTPS_PROXY: process.env['HTTPS_PROXY'] || proxy,
      http_proxy: process.env['http_proxy'] || proxy,
      https_proxy: process.env['https_proxy'] || proxy,
    } as Record<string, string>,
  };
}
