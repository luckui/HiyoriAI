# Agent Runtime Host Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first testable Agent Runtime Host skeleton with normalized runtime events, fake-provider integration, in-memory transcript mirroring, and a minimal Hiyori tool surface.

**Architecture:** Add `electron/runtimes/` as an independent service layer that owns provider registration, session lifecycle, event fan-out, and transcript mirroring. Keep provider logic out of `electron/tools/impl`; tools only call the Runtime Host. Use a fake runtime provider first so the host model is verified before Codex or Claude Code integration.

**Tech Stack:** TypeScript, Node.js `EventEmitter`, Vitest, existing Electron main-process TypeScript structure, existing `ToolDefinition` contract.

---

## Scope

This plan implements Phase 1 from the approved design:

- runtime types
- runtime registry
- runtime host
- normalized runtime events
- fake runtime provider
- in-memory transcript mirror
- minimal runtime tool entry points
- tests for registry, host, transcript mirror, and tool facade

This plan does not implement Codex, Claude Code, ACP, Discord delivery, WeChat pending delivery, database persistence, or UI panels.

## File Structure

Create:

- `electron/runtimes/types.ts`  
  Shared runtime interfaces, session/event unions, provider API, host errors.

- `electron/runtimes/runtimeRegistry.ts`  
  Provider registration and lookup. No session state.

- `electron/runtimes/transcriptMirror.ts`  
  In-memory transcript mirror for Phase 1. Later plans can replace or wrap this with SQLite persistence.

- `electron/runtimes/runtimeHost.ts`  
  Session lifecycle orchestration, provider event subscription, transcript mirroring, event emitter facade.

- `electron/runtimes/providers/fake.ts`  
  Deterministic provider used by tests and early manual verification.

- `electron/runtimes/index.ts`  
  Runtime host singleton and provider registration entry point.

- `electron/tools/impl/runtime.ts`  
  Small generic tool facade: `runtime_start`, `runtime_send`, `runtime_status`, `runtime_interrupt`, `runtime_list`.

- `electron/runtimes/__tests__/runtimeRegistry.test.ts`
- `electron/runtimes/__tests__/transcriptMirror.test.ts`
- `electron/runtimes/__tests__/runtimeHost.test.ts`
- `electron/tools/impl/__tests__/runtimeTools.test.ts`

Modify:

- `package.json`  
  Add Vitest and test scripts.

- `electron/tools/index.ts`  
  Register runtime tools.

- `electron/toolsets.ts`  
  Add the generic runtime tools only to `developer` through the existing `agent-debug` inheritance path, not to broad chat mode.

Avoid modifying:

- `electron/bridges/adapters/discord.ts`
- `electron/bridges/adapters/wechat.ts`
- `electron/aiService.ts`
- `electron/taskManager.ts`
- `electron/tools/terminalManager.ts`

## Task 1: Add Test Runner

**Files:**
- Modify: `package.json`
- Create: `electron/runtimes/__tests__/runtimeRegistry.test.ts`

- [ ] **Step 1: Install Vitest**

Run:

```powershell
npm install -D vitest
```

Expected:

```text
added ... packages
```

- [ ] **Step 2: Add test scripts**

Modify `package.json` scripts to include:

```json
{
  "scripts": {
    "dev": "chcp 65001 > nul && electron-vite dev",
    "build": "chcp 65001 > nul && electron-vite build",
    "preview": "electron-vite preview",
    "start": "electron-vite preview",
    "pack:win": "chcp 65001 > nul && electron-vite build && electron-builder --win --x64",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 3: Write failing registry import test**

Create `electron/runtimes/__tests__/runtimeRegistry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RuntimeRegistry } from '../runtimeRegistry';

describe('RuntimeRegistry', () => {
  it('starts empty', () => {
    const registry = new RuntimeRegistry();
    expect(registry.listProviders()).toEqual([]);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run:

```powershell
npm test -- electron/runtimes/__tests__/runtimeRegistry.test.ts
```

Expected:

```text
FAIL electron/runtimes/__tests__/runtimeRegistry.test.ts
Cannot find module '../runtimeRegistry'
```

- [ ] **Step 5: Commit**

```powershell
git add package.json package-lock.json electron/runtimes/__tests__/runtimeRegistry.test.ts
git commit -m "test: add runtime host test runner"
```

## Task 2: Define Runtime Types

**Files:**
- Create: `electron/runtimes/types.ts`
- Modify: `electron/runtimes/__tests__/runtimeRegistry.test.ts`

- [ ] **Step 1: Extend failing registry test with provider shape**

Replace `electron/runtimes/__tests__/runtimeRegistry.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { RuntimeRegistry } from '../runtimeRegistry';
import type { AgentRuntimeProvider, RuntimeEvent, RuntimeSubscription } from '../types';

function makeProvider(id: string): AgentRuntimeProvider {
  return {
    id,
    displayName: `Provider ${id}`,
    async checkAvailability() {
      return { available: true };
    },
    async startSession(input) {
      return {
        id: `${id}-session`,
        providerId: id,
        providerSessionRef: `${id}-native`,
        hiyoriConversationId: input.hiyoriConversationId,
        cwd: input.cwd,
        title: input.title,
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
        metadata: {},
      };
    },
    async resumeSession(input) {
      return {
        id: input.runtimeSessionId,
        providerId: id,
        providerSessionRef: `${id}-native`,
        hiyoriConversationId: input.hiyoriConversationId,
        cwd: input.cwd,
        title: input.title,
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
        metadata: {},
      };
    },
    async sendMessage() {},
    async interrupt() {},
    async stop() {},
    subscribe(_sessionId: string, _onEvent: (event: RuntimeEvent) => void): RuntimeSubscription {
      return { unsubscribe() {} };
    },
  };
}

describe('RuntimeRegistry', () => {
  it('starts empty', () => {
    const registry = new RuntimeRegistry();
    expect(registry.listProviders()).toEqual([]);
  });

  it('registers and returns providers by id', () => {
    const registry = new RuntimeRegistry();
    const provider = makeProvider('fake');

    registry.register(provider);

    expect(registry.getProvider('fake')).toBe(provider);
    expect(registry.listProviders()).toEqual([
      { id: 'fake', displayName: 'Provider fake' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it still fails**

Run:

```powershell
npm test -- electron/runtimes/__tests__/runtimeRegistry.test.ts
```

Expected:

```text
FAIL ... Cannot find module '../types'
```

- [ ] **Step 3: Create runtime type definitions**

Create `electron/runtimes/types.ts`:

```ts
export type RuntimeSessionStatus =
  | 'starting'
  | 'running'
  | 'waiting_for_input'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'stopped';

export type RuntimeEventType =
  | 'session_started'
  | 'assistant_delta'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'approval_requested'
  | 'waiting_for_input'
  | 'notification'
  | 'completed'
  | 'failed'
  | 'interrupted';

export interface RuntimeAvailability {
  available: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeSession {
  id: string;
  providerId: string;
  providerSessionRef: string;
  hiyoriConversationId: string;
  cwd?: string;
  title: string;
  status: RuntimeSessionStatus;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface StartRuntimeSessionInput {
  providerId: string;
  hiyoriConversationId: string;
  title: string;
  initialMessage: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
}

export interface ResumeRuntimeSessionInput {
  providerId: string;
  runtimeSessionId: string;
  hiyoriConversationId: string;
  title: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeUserMessage {
  content: string;
  channel?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeEvent {
  id: string;
  sessionId: string;
  providerId: string;
  type: RuntimeEventType;
  content: string;
  createdAt: number;
  raw?: Record<string, unknown>;
}

export interface RuntimeSubscription {
  unsubscribe(): void;
}

export interface AgentRuntimeProvider {
  id: string;
  displayName: string;
  checkAvailability(): Promise<RuntimeAvailability>;
  startSession(input: StartRuntimeSessionInput): Promise<RuntimeSession>;
  resumeSession(input: ResumeRuntimeSessionInput): Promise<RuntimeSession>;
  sendMessage(sessionId: string, message: RuntimeUserMessage): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  subscribe(sessionId: string, onEvent: (event: RuntimeEvent) => void): RuntimeSubscription;
}

export interface RuntimeProviderSummary {
  id: string;
  displayName: string;
}
```

- [ ] **Step 4: Run test and confirm missing registry only**

Run:

```powershell
npm test -- electron/runtimes/__tests__/runtimeRegistry.test.ts
```

Expected:

```text
FAIL ... Cannot find module '../runtimeRegistry'
```

- [ ] **Step 5: Commit**

```powershell
git add electron/runtimes/types.ts electron/runtimes/__tests__/runtimeRegistry.test.ts
git commit -m "feat: define runtime host types"
```

## Task 3: Implement Runtime Registry

**Files:**
- Create: `electron/runtimes/runtimeRegistry.ts`
- Modify: `electron/runtimes/__tests__/runtimeRegistry.test.ts`

- [ ] **Step 1: Add duplicate registration test**

Append this test inside the `describe` block in `electron/runtimes/__tests__/runtimeRegistry.test.ts`:

```ts
  it('rejects duplicate provider ids', () => {
    const registry = new RuntimeRegistry();

    registry.register(makeProvider('fake'));

    expect(() => registry.register(makeProvider('fake'))).toThrow(
      'Runtime provider already registered: fake'
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- electron/runtimes/__tests__/runtimeRegistry.test.ts
```

Expected:

```text
FAIL ... Cannot find module '../runtimeRegistry'
```

- [ ] **Step 3: Implement registry**

Create `electron/runtimes/runtimeRegistry.ts`:

```ts
import type { AgentRuntimeProvider, RuntimeProviderSummary } from './types';

export class RuntimeRegistry {
  private readonly providers = new Map<string, AgentRuntimeProvider>();

  register(provider: AgentRuntimeProvider): this {
    if (this.providers.has(provider.id)) {
      throw new Error(`Runtime provider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
    return this;
  }

  getProvider(id: string): AgentRuntimeProvider | undefined {
    return this.providers.get(id);
  }

  requireProvider(id: string): AgentRuntimeProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`Runtime provider not found: ${id}`);
    }
    return provider;
  }

  listProviders(): RuntimeProviderSummary[] {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
    }));
  }
}
```

- [ ] **Step 4: Run registry tests**

Run:

```powershell
npm test -- electron/runtimes/__tests__/runtimeRegistry.test.ts
```

Expected:

```text
PASS electron/runtimes/__tests__/runtimeRegistry.test.ts
```

- [ ] **Step 5: Commit**

```powershell
git add electron/runtimes/runtimeRegistry.ts electron/runtimes/__tests__/runtimeRegistry.test.ts
git commit -m "feat: add runtime provider registry"
```

## Task 4: Add Transcript Mirror

**Files:**
- Create: `electron/runtimes/transcriptMirror.ts`
- Create: `electron/runtimes/__tests__/transcriptMirror.test.ts`

- [ ] **Step 1: Write failing transcript mirror tests**

Create `electron/runtimes/__tests__/transcriptMirror.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TranscriptMirror } from '../transcriptMirror';
import type { RuntimeEvent, RuntimeSession } from '../types';

function session(id: string): RuntimeSession {
  return {
    id,
    providerId: 'fake',
    providerSessionRef: `native-${id}`,
    hiyoriConversationId: 'conv-1',
    title: 'Test Session',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
  };
}

function event(sessionId: string, content: string): RuntimeEvent {
  return {
    id: `event-${content}`,
    sessionId,
    providerId: 'fake',
    type: 'assistant_message',
    content,
    createdAt: Date.now(),
  };
}

describe('TranscriptMirror', () => {
  it('stores sessions and events separately', () => {
    const mirror = new TranscriptMirror();

    mirror.recordSession(session('s1'));
    mirror.recordEvent(event('s1', 'hello'));
    mirror.recordEvent(event('s1', 'world'));

    expect(mirror.getSession('s1')?.title).toBe('Test Session');
    expect(mirror.listEvents('s1').map((item) => item.content)).toEqual(['hello', 'world']);
  });

  it('updates session status without removing events', () => {
    const mirror = new TranscriptMirror();

    mirror.recordSession(session('s1'));
    mirror.recordEvent(event('s1', 'hello'));
    mirror.updateSessionStatus('s1', 'completed');

    expect(mirror.getSession('s1')?.status).toBe('completed');
    expect(mirror.listEvents('s1')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- electron/runtimes/__tests__/transcriptMirror.test.ts
```

Expected:

```text
FAIL ... Cannot find module '../transcriptMirror'
```

- [ ] **Step 3: Implement transcript mirror**

Create `electron/runtimes/transcriptMirror.ts`:

```ts
import type { RuntimeEvent, RuntimeSession, RuntimeSessionStatus } from './types';

export class TranscriptMirror {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly events = new Map<string, RuntimeEvent[]>();

  recordSession(session: RuntimeSession): void {
    this.sessions.set(session.id, session);
    if (!this.events.has(session.id)) {
      this.events.set(session.id, []);
    }
  }

  updateSessionStatus(sessionId: string, status: RuntimeSessionStatus): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Runtime session not found: ${sessionId}`);
    }
    this.sessions.set(sessionId, {
      ...session,
      status,
      updatedAt: Date.now(),
    });
  }

  recordEvent(event: RuntimeEvent): void {
    const list = this.events.get(event.sessionId) ?? [];
    list.push(event);
    this.events.set(event.sessionId, list);
  }

  getSession(sessionId: string): RuntimeSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): RuntimeSession[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listEvents(sessionId: string): RuntimeEvent[] {
    return [...(this.events.get(sessionId) ?? [])];
  }
}
```

- [ ] **Step 4: Run transcript mirror tests**

Run:

```powershell
npm test -- electron/runtimes/__tests__/transcriptMirror.test.ts
```

Expected:

```text
PASS electron/runtimes/__tests__/transcriptMirror.test.ts
```

- [ ] **Step 5: Commit**

```powershell
git add electron/runtimes/transcriptMirror.ts electron/runtimes/__tests__/transcriptMirror.test.ts
git commit -m "feat: add runtime transcript mirror"
```

## Task 5: Add Fake Runtime Provider

**Files:**
- Create: `electron/runtimes/providers/fake.ts`
- Create: `electron/runtimes/__tests__/fakeProvider.test.ts`

- [ ] **Step 1: Write failing fake provider tests**

Create `electron/runtimes/__tests__/fakeProvider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createFakeRuntimeProvider } from '../providers/fake';

describe('createFakeRuntimeProvider', () => {
  it('starts a running session', async () => {
    const provider = createFakeRuntimeProvider();

    const session = await provider.startSession({
      providerId: 'fake',
      hiyoriConversationId: 'conv-1',
      title: 'Fake Work',
      initialMessage: 'hello',
      cwd: 'D:/repo',
    });

    expect(session.providerId).toBe('fake');
    expect(session.hiyoriConversationId).toBe('conv-1');
    expect(session.cwd).toBe('D:/repo');
    expect(session.status).toBe('running');
  });

  it('emits assistant messages after sendMessage', async () => {
    const provider = createFakeRuntimeProvider();
    const session = await provider.startSession({
      providerId: 'fake',
      hiyoriConversationId: 'conv-1',
      title: 'Fake Work',
      initialMessage: 'hello',
    });
    const events: string[] = [];

    provider.subscribe(session.id, (event) => events.push(`${event.type}:${event.content}`));
    await provider.sendMessage(session.id, { content: 'continue' });

    expect(events).toContain('assistant_message:fake received: continue');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- electron/runtimes/__tests__/fakeProvider.test.ts
```

Expected:

```text
FAIL ... Cannot find module '../providers/fake'
```

- [ ] **Step 3: Implement fake provider**

Create `electron/runtimes/providers/fake.ts`:

```ts
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  AgentRuntimeProvider,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSubscription,
} from '../types';

export function createFakeRuntimeProvider(): AgentRuntimeProvider {
  const emitter = new EventEmitter();
  const sessions = new Map<string, RuntimeSession>();

  function emit(session: RuntimeSession, type: RuntimeEvent['type'], content: string): void {
    const event: RuntimeEvent = {
      id: randomUUID(),
      sessionId: session.id,
      providerId: session.providerId,
      type,
      content,
      createdAt: Date.now(),
    };
    emitter.emit(session.id, event);
  }

  return {
    id: 'fake',
    displayName: 'Fake Runtime',

    async checkAvailability() {
      return { available: true };
    },

    async startSession(input) {
      const now = Date.now();
      const session: RuntimeSession = {
        id: randomUUID(),
        providerId: 'fake',
        providerSessionRef: randomUUID(),
        hiyoriConversationId: input.hiyoriConversationId,
        cwd: input.cwd,
        title: input.title,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        metadata: input.metadata ?? {},
      };
      sessions.set(session.id, session);
      queueMicrotask(() => {
        emit(session, 'session_started', `fake started: ${input.initialMessage}`);
      });
      return session;
    },

    async resumeSession(input) {
      const existing = sessions.get(input.runtimeSessionId);
      if (existing) return existing;
      const now = Date.now();
      const session: RuntimeSession = {
        id: input.runtimeSessionId,
        providerId: 'fake',
        providerSessionRef: randomUUID(),
        hiyoriConversationId: input.hiyoriConversationId,
        cwd: input.cwd,
        title: input.title,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        metadata: input.metadata ?? {},
      };
      sessions.set(session.id, session);
      return session;
    },

    async sendMessage(sessionId, message) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Fake runtime session not found: ${sessionId}`);
      emit(session, 'assistant_message', `fake received: ${message.content}`);
    },

    async interrupt(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Fake runtime session not found: ${sessionId}`);
      session.status = 'interrupted';
      session.updatedAt = Date.now();
      emit(session, 'interrupted', 'fake interrupted');
    },

    async stop(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Fake runtime session not found: ${sessionId}`);
      session.status = 'stopped';
      session.updatedAt = Date.now();
      emit(session, 'completed', 'fake stopped');
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
```

- [ ] **Step 4: Run fake provider tests**

Run:

```powershell
npm test -- electron/runtimes/__tests__/fakeProvider.test.ts
```

Expected:

```text
PASS electron/runtimes/__tests__/fakeProvider.test.ts
```

- [ ] **Step 5: Commit**

```powershell
git add electron/runtimes/providers/fake.ts electron/runtimes/__tests__/fakeProvider.test.ts
git commit -m "feat: add fake runtime provider"
```

## Task 6: Implement Runtime Host

**Files:**
- Create: `electron/runtimes/runtimeHost.ts`
- Create: `electron/runtimes/__tests__/runtimeHost.test.ts`

- [ ] **Step 1: Write failing host tests**

Create `electron/runtimes/__tests__/runtimeHost.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createFakeRuntimeProvider } from '../providers/fake';
import { RuntimeHost } from '../runtimeHost';
import { RuntimeRegistry } from '../runtimeRegistry';
import { TranscriptMirror } from '../transcriptMirror';

function createHost() {
  const registry = new RuntimeRegistry();
  registry.register(createFakeRuntimeProvider());
  const mirror = new TranscriptMirror();
  return { host: new RuntimeHost(registry, mirror), mirror };
}

describe('RuntimeHost', () => {
  it('starts sessions through a provider and mirrors them', async () => {
    const { host, mirror } = createHost();

    const session = await host.startSession({
      providerId: 'fake',
      hiyoriConversationId: 'conv-1',
      title: 'Fake Session',
      initialMessage: 'hello',
    });

    expect(session.status).toBe('running');
    expect(mirror.getSession(session.id)?.title).toBe('Fake Session');
  });

  it('mirrors provider events and emits them to subscribers', async () => {
    const { host, mirror } = createHost();
    const session = await host.startSession({
      providerId: 'fake',
      hiyoriConversationId: 'conv-1',
      title: 'Fake Session',
      initialMessage: 'hello',
    });
    const seen: string[] = [];

    host.onRuntimeEvent((event) => {
      if (event.sessionId === session.id) seen.push(event.content);
    });
    await host.sendMessage(session.id, { content: 'continue' });

    expect(seen).toContain('fake received: continue');
    expect(mirror.listEvents(session.id).map((event) => event.content)).toContain(
      'fake received: continue'
    );
  });

  it('lists mirrored sessions', async () => {
    const { host } = createHost();

    await host.startSession({
      providerId: 'fake',
      hiyoriConversationId: 'conv-1',
      title: 'Fake Session',
      initialMessage: 'hello',
    });

    expect(host.listSessions()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- electron/runtimes/__tests__/runtimeHost.test.ts
```

Expected:

```text
FAIL ... Cannot find module '../runtimeHost'
```

- [ ] **Step 3: Implement runtime host**

Create `electron/runtimes/runtimeHost.ts`:

```ts
import { EventEmitter } from 'events';
import type {
  RuntimeEvent,
  RuntimeSession,
  RuntimeSubscription,
  RuntimeUserMessage,
  StartRuntimeSessionInput,
} from './types';
import type { RuntimeRegistry } from './runtimeRegistry';
import type { TranscriptMirror } from './transcriptMirror';

type RuntimeEventListener = (event: RuntimeEvent) => void;

export class RuntimeHost {
  private readonly emitter = new EventEmitter();
  private readonly providerSubscriptions = new Map<string, RuntimeSubscription>();

  constructor(
    private readonly registry: RuntimeRegistry,
    private readonly mirror: TranscriptMirror
  ) {}

  async startSession(input: StartRuntimeSessionInput): Promise<RuntimeSession> {
    const provider = this.registry.requireProvider(input.providerId);
    const availability = await provider.checkAvailability();
    if (!availability.available) {
      throw new Error(
        availability.reason
          ? `Runtime provider unavailable: ${input.providerId} (${availability.reason})`
          : `Runtime provider unavailable: ${input.providerId}`
      );
    }

    const session = await provider.startSession(input);
    this.mirror.recordSession(session);

    const subscription = provider.subscribe(session.id, (event) => {
      this.mirror.recordEvent(event);
      if (event.type === 'completed') this.mirror.updateSessionStatus(event.sessionId, 'completed');
      if (event.type === 'failed') this.mirror.updateSessionStatus(event.sessionId, 'failed');
      if (event.type === 'interrupted') this.mirror.updateSessionStatus(event.sessionId, 'interrupted');
      this.emitter.emit('runtime-event', event);
    });
    this.providerSubscriptions.set(session.id, subscription);

    return session;
  }

  async sendMessage(sessionId: string, message: RuntimeUserMessage): Promise<void> {
    const session = this.requireSession(sessionId);
    const provider = this.registry.requireProvider(session.providerId);
    await provider.sendMessage(sessionId, message);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const provider = this.registry.requireProvider(session.providerId);
    await provider.interrupt(sessionId);
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const provider = this.registry.requireProvider(session.providerId);
    await provider.stop(sessionId);
    this.providerSubscriptions.get(sessionId)?.unsubscribe();
    this.providerSubscriptions.delete(sessionId);
  }

  getSession(sessionId: string): RuntimeSession | undefined {
    return this.mirror.getSession(sessionId);
  }

  listSessions(): RuntimeSession[] {
    return this.mirror.listSessions();
  }

  listEvents(sessionId: string): RuntimeEvent[] {
    return this.mirror.listEvents(sessionId);
  }

  onRuntimeEvent(listener: RuntimeEventListener): RuntimeSubscription {
    this.emitter.on('runtime-event', listener);
    return {
      unsubscribe: () => this.emitter.off('runtime-event', listener),
    };
  }

  private requireSession(sessionId: string): RuntimeSession {
    const session = this.mirror.getSession(sessionId);
    if (!session) {
      throw new Error(`Runtime session not found: ${sessionId}`);
    }
    return session;
  }
}
```

- [ ] **Step 4: Run runtime host tests**

Run:

```powershell
npm test -- electron/runtimes/__tests__/runtimeHost.test.ts
```

Expected:

```text
PASS electron/runtimes/__tests__/runtimeHost.test.ts
```

- [ ] **Step 5: Run all runtime tests**

Run:

```powershell
npm test -- electron/runtimes
```

Expected:

```text
PASS electron/runtimes/__tests__/runtimeRegistry.test.ts
PASS electron/runtimes/__tests__/transcriptMirror.test.ts
PASS electron/runtimes/__tests__/fakeProvider.test.ts
PASS electron/runtimes/__tests__/runtimeHost.test.ts
```

- [ ] **Step 6: Commit**

```powershell
git add electron/runtimes/runtimeHost.ts electron/runtimes/__tests__/runtimeHost.test.ts
git commit -m "feat: add runtime host orchestration"
```

## Task 7: Add Runtime Singleton

**Files:**
- Create: `electron/runtimes/index.ts`
- Create: `electron/runtimes/__tests__/runtimeIndex.test.ts`

- [ ] **Step 1: Write failing singleton test**

Create `electron/runtimes/__tests__/runtimeIndex.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runtimeRegistry, runtimeHost } from '../index';

describe('runtime index', () => {
  it('registers the fake provider for development and tests', () => {
    expect(runtimeRegistry.listProviders()).toEqual([
      { id: 'fake', displayName: 'Fake Runtime' },
    ]);
  });

  it('exports a runtime host singleton', () => {
    expect(runtimeHost.listSessions()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- electron/runtimes/__tests__/runtimeIndex.test.ts
```

Expected:

```text
FAIL ... Cannot find module '../index'
```

- [ ] **Step 3: Implement singleton exports**

Create `electron/runtimes/index.ts`:

```ts
import { createFakeRuntimeProvider } from './providers/fake';
import { RuntimeHost } from './runtimeHost';
import { RuntimeRegistry } from './runtimeRegistry';
import { TranscriptMirror } from './transcriptMirror';

export const runtimeRegistry = new RuntimeRegistry()
  .register(createFakeRuntimeProvider());

export const transcriptMirror = new TranscriptMirror();

export const runtimeHost = new RuntimeHost(runtimeRegistry, transcriptMirror);

export type {
  AgentRuntimeProvider,
  RuntimeAvailability,
  RuntimeEvent,
  RuntimeEventType,
  RuntimeProviderSummary,
  RuntimeSession,
  RuntimeSessionStatus,
  RuntimeSubscription,
  RuntimeUserMessage,
  StartRuntimeSessionInput,
} from './types';
```

- [ ] **Step 4: Run singleton test**

Run:

```powershell
npm test -- electron/runtimes/__tests__/runtimeIndex.test.ts
```

Expected:

```text
PASS electron/runtimes/__tests__/runtimeIndex.test.ts
```

- [ ] **Step 5: Commit**

```powershell
git add electron/runtimes/index.ts electron/runtimes/__tests__/runtimeIndex.test.ts
git commit -m "feat: expose runtime host singleton"
```

## Task 8: Add Runtime Tool Facade

**Files:**
- Create: `electron/tools/impl/runtime.ts`
- Create: `electron/tools/impl/__tests__/runtimeTools.test.ts`

- [ ] **Step 1: Write failing runtime tool tests**

Create `electron/tools/impl/__tests__/runtimeTools.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runtimeTools } from '../runtime';

function tool(name: string) {
  const found = runtimeTools.find((item) => item.schema.function.name === name);
  if (!found) throw new Error(`Missing tool: ${name}`);
  return found;
}

describe('runtime tools', () => {
  it('starts and lists runtime sessions through generic tools', async () => {
    const start = tool('runtime_start');
    const list = tool('runtime_list');

    const startResult = await start.execute({
      provider_id: 'fake',
      conversation_id: 'conv-1',
      title: 'Fake Work',
      message: 'hello',
    });
    const text = String(startResult);
    const sessionId = text.match(/session_id: ([a-f0-9-]+)/)?.[1];

    expect(sessionId).toBeTruthy();
    expect(String(await list.execute({}))).toContain('Fake Work');
  });

  it('sends messages to an existing runtime session', async () => {
    const start = tool('runtime_start');
    const send = tool('runtime_send');
    const status = tool('runtime_status');

    const startResult = String(await start.execute({
      provider_id: 'fake',
      conversation_id: 'conv-2',
      title: 'Fake Work 2',
      message: 'hello',
    }));
    const sessionId = startResult.match(/session_id: ([a-f0-9-]+)/)?.[1];
    if (!sessionId) throw new Error('runtime_start did not return a session id');

    expect(String(await send.execute({ session_id: sessionId, message: 'continue' }))).toContain(
      'message sent'
    );
    expect(String(await status.execute({ session_id: sessionId }))).toContain('fake received: continue');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- electron/tools/impl/__tests__/runtimeTools.test.ts
```

Expected:

```text
FAIL ... Cannot find module '../runtime'
```

- [ ] **Step 3: Implement runtime tools**

Create `electron/tools/impl/runtime.ts`:

```ts
import { runtimeHost } from '../../runtimes';
import type { ToolDefinition } from '../types';

interface RuntimeStartParams {
  provider_id: string;
  conversation_id: string;
  title: string;
  message: string;
  cwd?: string;
}

interface RuntimeSessionParams {
  session_id: string;
}

interface RuntimeSendParams extends RuntimeSessionParams {
  message: string;
}

const runtimeStart: ToolDefinition<RuntimeStartParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'runtime_start',
      description: 'Start an external or native agent runtime session through the Agent Runtime Host.',
      parameters: {
        type: 'object',
        properties: {
          provider_id: { type: 'string', description: 'Runtime provider id, for example fake, codex, claude-code, or acp.' },
          conversation_id: { type: 'string', description: 'Hiyori conversation id that owns the mirrored runtime session.' },
          title: { type: 'string', description: 'Short title for the runtime session.' },
          message: { type: 'string', description: 'Initial user message sent to the runtime.' },
          cwd: { type: 'string', description: 'Optional working directory for coding runtimes.' },
        },
        required: ['provider_id', 'conversation_id', 'title', 'message'],
      },
    },
  },
  async execute(params) {
    const session = await runtimeHost.startSession({
      providerId: params.provider_id,
      hiyoriConversationId: params.conversation_id,
      title: params.title,
      initialMessage: params.message,
      cwd: params.cwd,
    });
    return `runtime started\nprovider_id: ${session.providerId}\nsession_id: ${session.id}\nstatus: ${session.status}\ntitle: ${session.title}`;
  },
};

const runtimeSend: ToolDefinition<RuntimeSendParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'runtime_send',
      description: 'Send a message to an existing Agent Runtime Host session.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Runtime session id returned by runtime_start.' },
          message: { type: 'string', description: 'Message to send to the runtime.' },
        },
        required: ['session_id', 'message'],
      },
    },
  },
  async execute(params) {
    await runtimeHost.sendMessage(params.session_id, { content: params.message });
    return `message sent\nsession_id: ${params.session_id}`;
  },
};

const runtimeStatus: ToolDefinition<RuntimeSessionParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'runtime_status',
      description: 'Show status and recent mirrored events for an Agent Runtime Host session.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Runtime session id.' },
        },
        required: ['session_id'],
      },
    },
  },
  execute(params) {
    const session = runtimeHost.getSession(params.session_id);
    if (!session) return `runtime session not found: ${params.session_id}`;
    const events = runtimeHost.listEvents(params.session_id).slice(-10);
    const eventLines = events.length
      ? events.map((event) => `- ${event.type}: ${event.content}`).join('\n')
      : '- no mirrored events';
    return [
      `session_id: ${session.id}`,
      `provider_id: ${session.providerId}`,
      `status: ${session.status}`,
      `title: ${session.title}`,
      `events:`,
      eventLines,
    ].join('\n');
  },
};

const runtimeInterrupt: ToolDefinition<RuntimeSessionParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'runtime_interrupt',
      description: 'Interrupt a running Agent Runtime Host session.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Runtime session id.' },
        },
        required: ['session_id'],
      },
    },
  },
  async execute(params) {
    await runtimeHost.interrupt(params.session_id);
    return `runtime interrupted\nsession_id: ${params.session_id}`;
  },
};

const runtimeList: ToolDefinition<Record<string, never>> = {
  schema: {
    type: 'function',
    function: {
      name: 'runtime_list',
      description: 'List mirrored Agent Runtime Host sessions.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  execute() {
    const sessions = runtimeHost.listSessions();
    if (sessions.length === 0) return 'no runtime sessions';
    return sessions.map((session) => (
      `${session.id} | ${session.providerId} | ${session.status} | ${session.title}`
    )).join('\n');
  },
};

export const runtimeTools: ToolDefinition<any>[] = [
  runtimeStart,
  runtimeSend,
  runtimeStatus,
  runtimeInterrupt,
  runtimeList,
];
```

- [ ] **Step 4: Run runtime tool tests**

Run:

```powershell
npm test -- electron/tools/impl/__tests__/runtimeTools.test.ts
```

Expected:

```text
PASS electron/tools/impl/__tests__/runtimeTools.test.ts
```

- [ ] **Step 5: Commit**

```powershell
git add electron/tools/impl/runtime.ts electron/tools/impl/__tests__/runtimeTools.test.ts
git commit -m "feat: add runtime host tool facade"
```

## Task 9: Register Runtime Tools

**Files:**
- Modify: `electron/tools/index.ts`
- Modify: `electron/toolsets.ts`

- [ ] **Step 1: Write failing registration test**

Create `electron/tools/impl/__tests__/runtimeRegistration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toolRegistry } from '../../index';
import { resolveToolset } from '../../../toolsets';

describe('runtime tool registration', () => {
  it('registers runtime tools in the tool registry', () => {
    const names = toolRegistry.getToolNames();

    expect(names.has('runtime_start')).toBe(true);
    expect(names.has('runtime_send')).toBe(true);
    expect(names.has('runtime_status')).toBe(true);
    expect(names.has('runtime_interrupt')).toBe(true);
    expect(names.has('runtime_list')).toBe(true);
  });

  it('exposes runtime tools through agent-debug and developer but not chat', () => {
    expect(resolveToolset('agent-debug')).toEqual(expect.arrayContaining([
      'runtime_start',
      'runtime_send',
      'runtime_status',
      'runtime_interrupt',
      'runtime_list',
    ]));
    expect(resolveToolset('developer')).toEqual(expect.arrayContaining([
      'runtime_start',
      'runtime_send',
      'runtime_status',
      'runtime_interrupt',
      'runtime_list',
    ]));
    expect(resolveToolset('chat')).not.toContain('runtime_start');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- electron/tools/impl/__tests__/runtimeRegistration.test.ts
```

Expected:

```text
FAIL ... expected false to be true
```

- [ ] **Step 3: Register runtime tools in registry**

Modify `electron/tools/index.ts`.

Add import near other advanced tools:

```ts
import { runtimeTools } from './impl/runtime';
```

Add registration loop before `setToolRegistry(registry);`:

```ts
for (const tool of runtimeTools) {
  registry.register(tool);
}
```

- [ ] **Step 4: Add runtime tools to agent-debug toolset**

Modify `electron/toolsets.ts` inside the `agent-debug.tools` array, near the other developer-facing orchestration tools:

```ts
      "runtime_start",
      "runtime_send",
      "runtime_status",
      "runtime_interrupt",
      "runtime_list",
```

Do not add these tools to `chat`.

- [ ] **Step 5: Run registration test**

Run:

```powershell
npm test -- electron/tools/impl/__tests__/runtimeRegistration.test.ts
```

Expected:

```text
PASS electron/tools/impl/__tests__/runtimeRegistration.test.ts
```

- [ ] **Step 6: Commit**

```powershell
git add electron/tools/index.ts electron/toolsets.ts electron/tools/impl/__tests__/runtimeRegistration.test.ts
git commit -m "feat: register runtime host tools"
```

## Task 10: Verify Phase 1 Boundary

**Files:**
- Modify: none

- [ ] **Step 1: Run full test suite**

Run:

```powershell
npm test
```

Expected:

```text
PASS
```

- [ ] **Step 2: Run TypeScript build**

Run:

```powershell
npm run build
```

Expected:

```text
electron-vite build
...
built successfully
```

- [ ] **Step 3: Check runtime code does not depend on tools or bridges**

Run:

```powershell
rg -n "tools/impl|bridges|terminalManager|aiService|DiscordAdapter|WeChatAdapter" electron/runtimes
```

Expected: no output.

- [ ] **Step 4: Check no Codex or Claude implementation slipped into Phase 1**

Run:

```powershell
rg -n "codex|claude|app-server|hook" electron/runtimes electron/tools/impl/runtime.ts
```

Expected: no output except comments if a later implementer adds explanatory text. Remove any actual provider implementation from this phase.

- [ ] **Step 5: Inspect git diff**

Run:

```powershell
git status --short
git diff --stat HEAD
```

Expected:

```text
 M package.json
 M package-lock.json
 M electron/toolsets.ts
 M electron/tools/index.ts
 ...
```

Only files from this plan should appear, plus any pre-existing unrelated user changes that were already present before implementation.

- [ ] **Step 6: Commit verification fixes if needed**

If Step 1 or Step 2 required small fixes, commit them:

```powershell
git add package.json package-lock.json electron/runtimes electron/tools/impl/runtime.ts electron/tools/impl/__tests__ electron/tools/index.ts electron/toolsets.ts
git commit -m "test: verify runtime host skeleton"
```

If no fixes were needed, skip this commit.

## Self-Review Checklist

Spec coverage:

- Runtime types: Task 2.
- Runtime registry: Task 3.
- Event model: Tasks 2, 5, 6.
- Transcript mirror: Task 4.
- Fake provider before Codex: Task 5.
- Runtime Host orchestration: Task 6.
- Small generic tool surface: Tasks 8 and 9.
- No GUI/OCR or Codex/Claude first-pass implementation: Task 10.
- No channel delivery yet: explicitly out of scope for this Phase 1 plan.
- No SQLite persistence yet: explicitly out of scope for this Phase 1 plan.

Placeholder scan:

- The plan contains no placeholder markers or deferred-work instructions.
- Steps include concrete paths, commands, and expected results.

Type consistency:

- Provider interface names match `types.ts`.
- `RuntimeHost` uses `RuntimeRegistry` and `TranscriptMirror`.
- Runtime tools call `runtimeHost` and do not implement provider logic.

## Handoff

After this plan is implemented, the next plan should be Phase 2: Codex Provider. Do not start Phase 2 until Phase 1 tests and build pass.
