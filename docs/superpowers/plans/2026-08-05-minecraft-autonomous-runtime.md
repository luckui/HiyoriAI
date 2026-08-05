# Minecraft Autonomous Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the simple Minecraft controller with an autonomous runtime where Hiyori keeps one persona, receives fresh game context every turn, and delegates deterministic Minecraft actions to a worker-owned body runtime.

**Architecture:** Use AIRI's four-layer split as the code boundary: perception, reflex, action, and planning. Use Mindcraft as the reference for deterministic Minecraft actions and Voyager's observe-act-verify-replan loop as the reference for goal execution, while keeping Mineflayer-specific objects inside the worker adapter. Electron main owns Hiyori cognition, provider settings, routing, and wakeups; the worker owns game state, reflexes, and action execution.

**Tech Stack:** Electron main process, TypeScript, Vitest, Mineflayer, mineflayer-pathfinder, mineflayer-collectblock, mineflayer-auto-eat, mineflayer-pvp, existing `fetchCompletion` LLM client, existing bridge notification routing.

## Global Constraints

- One Hiyori persona: do not introduce a second chat agent inside the Minecraft worker.
- Worker process cannot call LLM providers, read API keys, or persist conversation memory.
- Minecraft context is ephemeral and appended only to the current conversation turn.
- No tick-driven LLM calls; planning is triggered only by user messages, action completion, blocked states, or explicit wake events.
- Public user-facing tool stays high level. Low-level Mineflayer verbs are internal runtime actions.
- Mineflayer is the first body adapter; shared contracts must not expose Mineflayer objects.
- Old controller paths are deleted after feature parity in this branch; do not preserve a permanent fallback.
- Sugar cane collection means ordinary local collection of the whole plant unless a future farming action explicitly asks to preserve roots.
- "Nearby" collection may use an internal safety cap, but tool and reply text must not invent a user-requested quantity.
- Keep the current dirty Minecraft changes unless a task intentionally replaces them.

---

## File Structure

- Create `electron/minecraft/contracts.ts`: normalized data contracts shared by main, worker, tests, and tools.
- Modify `electron/minecraft/protocol.ts`: transport messages for snapshots, runtime actions, and goal correlation.
- Create `electron/minecraft/perception.ts`: converts adapter observations into `MinecraftEnvironmentSnapshot`.
- Modify `electron/minecraft/mineflayerAdapter.ts`: expose normalized observation helpers and action primitives without leaking Mineflayer objects.
- Create `electron/minecraft/actions/types.ts`: action handler signature and action error codes.
- Create `electron/minecraft/actions/registry.ts`: deterministic action registry.
- Create `electron/minecraft/actions/navigation.ts`: follow, move, inspect, wait, pickup primitives.
- Create `electron/minecraft/actions/resources.ts`: collect block and inventory-resource actions.
- Create `electron/minecraft/embodimentRuntime.ts`: worker-side runtime replacing `bodyController.ts`.
- Delete `electron/minecraft/bodyController.ts` after parity.
- Create `electron/minecraft/reflexEngine.ts`: hunger, danger, stuck, and recovery rules.
- Create `electron/minecraft/followController.ts`: long-lived follow state and player distance facts.
- Create `electron/minecraft/stuckDetector.ts`: path and position based stuck detection.
- Modify `electron/minecraft/workerEntry.ts`: route worker commands to embodiment runtime.
- Modify `electron/minecraft/runtimeManager.ts`: manage goals, action origins, snapshots, and significant events.
- Create `electron/runtimeContext.ts`: generic ephemeral runtime-context registry.
- Modify `electron/aiService.ts`: append runtime context to each active turn.
- Create `electron/minecraft/plannerModel.ts`: main-process model adapter that returns typed planner decisions.
- Create `electron/minecraft/cognitionCoordinator.ts`: event-driven observe-act-verify-replan loop.
- Modify `electron/minecraft/mainIntegration.ts`: register context provider and coordinator callbacks.
- Modify `electron/minecraft/chatChannel.ts`: route in-game chat through Hiyori with Minecraft context and game replies.
- Modify `electron/tools/impl/minecraftCompanion.ts`: expose high-level connect/status/say/start_goal/stop_goal operations.
- Add and update tests under `electron/minecraft/__tests__/` and `electron/tools/impl/__tests__/`.
- Create `docs/THIRD_PARTY_NOTICES.md` entry for AIRI, Mindcraft, and Voyager references.

## Shared Interfaces

These signatures are the stable contract for all tasks.

```ts
export type MinecraftFollowPhase =
  | 'inactive'
  | 'approaching'
  | 'nearby'
  | 'recovering'
  | 'blocked'
  | 'target-lost';

export type MinecraftActionName =
  | 'navigate_to_player'
  | 'follow_player'
  | 'wait'
  | 'inspect'
  | 'collect_block'
  | 'pickup_drops'
  | 'craft_item'
  | 'smelt_item'
  | 'use_container'
  | 'eat'
  | 'equip'
  | 'defend'
  | 'retreat'
  | 'sleep'
  | 'harvest_crop'
  | 'till_soil'
  | 'sow_crop'
  | 'place_block'
  | 'break_block'
  | 'execute_blueprint';

export type MinecraftActionErrorCode =
  | 'not_connected'
  | 'target_not_found'
  | 'path_unreachable'
  | 'blocked'
  | 'missing_tool'
  | 'missing_item'
  | 'inventory_full'
  | 'unsafe'
  | 'timeout'
  | 'cancelled'
  | 'adapter_error';

export interface MinecraftFact {
  id: string;
  at: number;
  severity: 'info' | 'notice' | 'warning' | 'error';
  kind: string;
  text: string;
  data?: Record<string, unknown>;
}

export interface MinecraftObservedBlock {
  name: string;
  displayName?: string;
  position: { x: number; y: number; z: number };
  distance: number;
}

export interface MinecraftObservedEntity {
  name: string;
  type: string;
  position: { x: number; y: number; z: number };
  distance: number;
  hostile: boolean;
}

export interface MinecraftEnvironmentSnapshot {
  capturedAt: number;
  stale: boolean;
  connection: { connected: boolean; username?: string; host?: string; port?: number };
  world?: { dimension: string; biome?: string; timeOfDay?: number; weather?: string };
  body?: {
    position: { x: number; y: number; z: number };
    health: number;
    food: number;
    oxygen?: number;
    inventory: Record<string, number>;
  };
  owner?: { name: string; visible: boolean; distance?: number; relativeDirection?: string };
  follow: { phase: MinecraftFollowPhase; target?: string; distance?: number };
  nearby: { blocks: MinecraftObservedBlock[]; entities: MinecraftObservedEntity[] };
  action?: { id: string; name: MinecraftActionName; state: 'running' | 'paused' | 'cancelled' };
  recentEvents: MinecraftFact[];
}

export interface MinecraftActionInstruction {
  id: string;
  name: MinecraftActionName;
  args: Record<string, unknown>;
}

export interface MinecraftWorldChange {
  kind: 'block_broken' | 'block_placed' | 'item_picked_up' | 'entity_hit';
  name: string;
  position?: { x: number; y: number; z: number };
  count?: number;
}

export interface MinecraftActionResult {
  actionId: string;
  outcome: 'succeeded' | 'partial' | 'failed' | 'cancelled';
  summary: string;
  durationMs: number;
  inventoryDelta: Record<string, number>;
  worldChanges: MinecraftWorldChange[];
  observations: MinecraftFact[];
  error?: { code: MinecraftActionErrorCode; recoverable: boolean; details: Record<string, unknown> };
}

export type MinecraftPlannerDecision =
  | { kind: 'act'; action: MinecraftActionInstruction; rationale: string }
  | { kind: 'complete'; result: string }
  | { kind: 'ask-user'; question: string; reason: string }
  | { kind: 'wait'; condition: { kind: 'action' | 'player' | 'time'; value: string } }
  | { kind: 'revise-plan'; plan: Array<{ title: string; expected: string }> };
```

---

### Task 1: Shared Minecraft Contracts

**Files:**
- Create: `electron/minecraft/contracts.ts`
- Modify: `electron/minecraft/protocol.ts`
- Test: `electron/minecraft/__tests__/contracts.test.ts`

**Interfaces:**
- Consumes: existing worker message channel from `protocol.ts`.
- Produces: all types listed in Shared Interfaces plus:

```ts
export type MinecraftWorkerCommand =
  | { type: 'discover'; requestId: string }
  | { type: 'connect'; requestId: string; host: string; port: number; username?: string }
  | { type: 'disconnect'; requestId: string }
  | { type: 'status'; requestId: string }
  | { type: 'say'; requestId: string; message: string }
  | { type: 'snapshot'; requestId: string }
  | { type: 'execute-action'; requestId: string; instruction: MinecraftActionInstruction }
  | { type: 'cancel-action'; requestId: string; actionId: string };
```

- [ ] **Step 1: Write the failing contract export test**

```ts
import { describe, expect, it } from 'vitest';
import type {
  MinecraftActionInstruction,
  MinecraftEnvironmentSnapshot,
  MinecraftWorkerCommand,
} from '../contracts';

describe('minecraft contracts', () => {
  it('models a portable snapshot and action command without adapter objects', () => {
    const snapshot: MinecraftEnvironmentSnapshot = {
      capturedAt: 1784440000000,
      stale: false,
      connection: { connected: true, host: '127.0.0.1', port: 60131, username: 'Hiyori' },
      world: { dimension: 'overworld', biome: 'forest' },
      body: { position: { x: 1, y: 64, z: 2 }, health: 20, food: 18, inventory: { dirt: 3 } },
      owner: { name: 'Player', visible: true, distance: 4.2, relativeDirection: 'front-left' },
      follow: { phase: 'nearby', target: 'Player', distance: 4.2 },
      nearby: { blocks: [], entities: [] },
      recentEvents: [],
    };
    const instruction: MinecraftActionInstruction = {
      id: 'act-1',
      name: 'collect_block',
      args: { block: 'sugar_cane', scope: 'nearby' },
    };
    const command: MinecraftWorkerCommand = { type: 'execute-action', requestId: 'req-1', instruction };

    expect(snapshot.connection.connected).toBe(true);
    expect(command.type).toBe('execute-action');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- electron/minecraft/__tests__/contracts.test.ts`

Expected: fail because `../contracts` does not exist.

- [ ] **Step 3: Create `contracts.ts` and re-export from `protocol.ts`**

Implement the Shared Interfaces exactly in `electron/minecraft/contracts.ts`. In `protocol.ts`, import those types and make existing protocol unions use `MinecraftWorkerCommand` for worker commands.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- electron/minecraft/__tests__/contracts.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/minecraft/contracts.ts electron/minecraft/protocol.ts electron/minecraft/__tests__/contracts.test.ts
git commit -m "feat: add minecraft runtime contracts"
```

---

### Task 2: Perception Snapshot Builder

**Files:**
- Create: `electron/minecraft/perception.ts`
- Modify: `electron/minecraft/mineflayerAdapter.ts`
- Test: `electron/minecraft/__tests__/perception.test.ts`

**Interfaces:**
- Consumes: `MinecraftEnvironmentSnapshot`, `MinecraftObservedBlock`, `MinecraftObservedEntity`, `MinecraftFact`.
- Produces:

```ts
export interface MinecraftRawObservation {
  capturedAt: number;
  connection: MinecraftEnvironmentSnapshot['connection'];
  world?: MinecraftEnvironmentSnapshot['world'];
  body?: MinecraftEnvironmentSnapshot['body'];
  owner?: MinecraftEnvironmentSnapshot['owner'];
  follow?: MinecraftEnvironmentSnapshot['follow'];
  nearbyBlocks: MinecraftObservedBlock[];
  nearbyEntities: MinecraftObservedEntity[];
  recentEvents: MinecraftFact[];
}

export function buildMinecraftSnapshot(input: MinecraftRawObservation): MinecraftEnvironmentSnapshot;
```

- [ ] **Step 1: Write the failing perception tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildMinecraftSnapshot } from '../perception';

describe('buildMinecraftSnapshot', () => {
  it('keeps only visible nearby facts and marks connected snapshots fresh', () => {
    const snapshot = buildMinecraftSnapshot({
      capturedAt: 1784440000000,
      connection: { connected: true, username: 'Hiyori' },
      world: { dimension: 'overworld', biome: 'forest' },
      body: { position: { x: 0, y: 68, z: 0 }, health: 20, food: 19, inventory: { apple: 2 } },
      owner: { name: 'Player', visible: true, distance: 6, relativeDirection: 'behind' },
      follow: { phase: 'approaching', target: 'Player', distance: 6 },
      nearbyBlocks: [{ name: 'sugar_cane', position: { x: 3, y: 64, z: 1 }, distance: 3.2 }],
      nearbyEntities: [{ name: 'zombie', type: 'mob', position: { x: 8, y: 64, z: 0 }, distance: 8, hostile: true }],
      recentEvents: [],
    });

    expect(snapshot.stale).toBe(false);
    expect(snapshot.nearby.blocks[0].name).toBe('sugar_cane');
    expect(snapshot.follow.phase).toBe('approaching');
  });

  it('marks disconnected snapshots stale and leaves body undefined', () => {
    const snapshot = buildMinecraftSnapshot({
      capturedAt: 1784440000000,
      connection: { connected: false },
      nearbyBlocks: [],
      nearbyEntities: [],
      recentEvents: [],
    });

    expect(snapshot.stale).toBe(true);
    expect(snapshot.body).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- electron/minecraft/__tests__/perception.test.ts`

Expected: fail because `../perception` does not exist.

- [ ] **Step 3: Implement snapshot builder and adapter observation method**

Add `buildMinecraftSnapshot` with deterministic sorting by distance for blocks and entities. Add `getRawObservation(ownerName?: string): MinecraftRawObservation` to `mineflayerAdapter.ts`, using current bot state, inventory, entities, visible blocks, and recent adapter facts.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- electron/minecraft/__tests__/perception.test.ts electron/minecraft/__tests__/mineflayerAdapter.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/minecraft/perception.ts electron/minecraft/mineflayerAdapter.ts electron/minecraft/__tests__/perception.test.ts electron/minecraft/__tests__/mineflayerAdapter.test.ts
git commit -m "feat: build minecraft environment snapshots"
```

---

### Task 3: Action Registry And Embodiment Runtime

**Files:**
- Create: `electron/minecraft/actions/types.ts`
- Create: `electron/minecraft/actions/registry.ts`
- Create: `electron/minecraft/actions/navigation.ts`
- Create: `electron/minecraft/actions/resources.ts`
- Create: `electron/minecraft/embodimentRuntime.ts`
- Modify: `electron/minecraft/workerEntry.ts`
- Delete: `electron/minecraft/bodyController.ts`
- Test: `electron/minecraft/__tests__/embodimentRuntime.test.ts`
- Test: replace `electron/minecraft/__tests__/bodyController.test.ts` with runtime tests

**Interfaces:**
- Consumes: `MinecraftActionInstruction`, `MinecraftActionResult`, `MinecraftEnvironmentSnapshot`.
- Produces:

```ts
export interface MinecraftActionContext {
  adapter: MinecraftBodyAdapter;
  signal: AbortSignal;
  now: () => number;
  snapshot: () => Promise<MinecraftEnvironmentSnapshot>;
}

export interface MinecraftActionHandler {
  name: MinecraftActionName;
  run(instruction: MinecraftActionInstruction, context: MinecraftActionContext): Promise<MinecraftActionResult>;
}

export interface MinecraftBodyAdapter {
  isConnected(): boolean;
  getSnapshot(): Promise<MinecraftEnvironmentSnapshot>;
  say(message: string): Promise<void>;
  navigateToPlayer(playerName: string, options: { range: number; timeoutMs: number; dynamic: boolean }): Promise<void>;
  stopNavigation(): Promise<void>;
  inspect(options: { radius: number }): Promise<MinecraftEnvironmentSnapshot>;
  collectBlock(options: { block: string; radius: number; maxCount: number; preserveRoot: boolean }): Promise<MinecraftActionResult>;
  pickupDrops(options: { radius: number }): Promise<MinecraftActionResult>;
}

export class MinecraftEmbodimentRuntime {
  constructor(options: { adapter: MinecraftBodyAdapter; now?: () => number });
  snapshot(): Promise<MinecraftEnvironmentSnapshot>;
  execute(instruction: MinecraftActionInstruction): Promise<MinecraftActionResult>;
  cancel(actionId: string): Promise<boolean>;
}
```

- [ ] **Step 1: Write failing runtime tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { MinecraftEmbodimentRuntime } from '../embodimentRuntime';
import type { MinecraftBodyAdapter } from '../actions/types';

function fakeAdapter(overrides: Partial<MinecraftBodyAdapter> = {}): MinecraftBodyAdapter {
  return {
    isConnected: () => true,
    getSnapshot: vi.fn(async () => ({
      capturedAt: 1,
      stale: false,
      connection: { connected: true },
      follow: { phase: 'inactive' },
      nearby: { blocks: [], entities: [] },
      recentEvents: [],
    })),
    say: vi.fn(async () => {}),
    navigateToPlayer: vi.fn(async () => {}),
    stopNavigation: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({
      capturedAt: 2,
      stale: false,
      connection: { connected: true },
      follow: { phase: 'inactive' },
      nearby: { blocks: [], entities: [] },
      recentEvents: [],
    })),
    collectBlock: vi.fn(async (options) => ({
      actionId: 'act-1',
      outcome: 'succeeded',
      summary: `collected ${options.block}`,
      durationMs: 10,
      inventoryDelta: { [options.block]: 3 },
      worldChanges: [{ kind: 'block_broken', name: options.block, count: 3 }],
      observations: [],
    })),
    pickupDrops: vi.fn(async () => ({
      actionId: 'act-2',
      outcome: 'succeeded',
      summary: 'picked up drops',
      durationMs: 10,
      inventoryDelta: {},
      worldChanges: [],
      observations: [],
    })),
    ...overrides,
  };
}

describe('MinecraftEmbodimentRuntime', () => {
  it('executes collect_block through the registry and verifies whole sugar cane collection', async () => {
    const adapter = fakeAdapter();
    const runtime = new MinecraftEmbodimentRuntime({ adapter, now: () => 100 });

    const result = await runtime.execute({
      id: 'act-1',
      name: 'collect_block',
      args: { block: 'sugar_cane', scope: 'nearby' },
    });

    expect(adapter.collectBlock).toHaveBeenCalledWith({
      block: 'sugar_cane',
      radius: 16,
      maxCount: 64,
      preserveRoot: false,
    });
    expect(result.outcome).toBe('succeeded');
  });

  it('returns a recoverable not_connected result instead of throwing', async () => {
    const runtime = new MinecraftEmbodimentRuntime({ adapter: fakeAdapter({ isConnected: () => false }) });

    const result = await runtime.execute({ id: 'act-3', name: 'inspect', args: { radius: 12 } });

    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('not_connected');
    expect(result.error?.recoverable).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- electron/minecraft/__tests__/embodimentRuntime.test.ts`

Expected: fail because runtime modules do not exist.

- [ ] **Step 3: Implement action types, registry, navigation actions, resource actions, and runtime**

Implement `createMinecraftActionRegistry()` with handlers for `inspect`, `wait`, `navigate_to_player`, `follow_player`, `collect_block`, `pickup_drops`, and `break_block`. In `resources.ts`, map `scope: 'nearby'` to `{ radius: 16, maxCount: 64 }` as an internal cap and never include "64 requested" in summaries. For `sugar_cane`, set `preserveRoot: false`.

- [ ] **Step 4: Switch worker entry and remove old controller**

Replace `bodyController` construction in `workerEntry.ts` with `MinecraftEmbodimentRuntime`. Delete `bodyController.ts`; migrate useful tests into `embodimentRuntime.test.ts` and `workerEntry.test.ts`.

- [ ] **Step 5: Run worker and runtime tests**

Run: `npm test -- electron/minecraft/__tests__/embodimentRuntime.test.ts electron/minecraft/__tests__/workerEntry.test.ts electron/minecraft/__tests__/mineflayerAdapter.test.ts`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add electron/minecraft/actions electron/minecraft/embodimentRuntime.ts electron/minecraft/workerEntry.ts electron/minecraft/__tests__/embodimentRuntime.test.ts electron/minecraft/__tests__/workerEntry.test.ts electron/minecraft/__tests__/mineflayerAdapter.test.ts
git rm electron/minecraft/bodyController.ts electron/minecraft/__tests__/bodyController.test.ts
git commit -m "feat: replace minecraft body controller with action runtime"
```

---

### Task 4: Reflex And Follow State

**Files:**
- Create: `electron/minecraft/stuckDetector.ts`
- Create: `electron/minecraft/followController.ts`
- Create: `electron/minecraft/reflexEngine.ts`
- Modify: `electron/minecraft/embodimentRuntime.ts`
- Modify: `electron/minecraft/mineflayerAdapter.ts`
- Test: `electron/minecraft/__tests__/stuckDetector.test.ts`
- Test: `electron/minecraft/__tests__/followController.test.ts`
- Test: `electron/minecraft/__tests__/reflexEngine.test.ts`

**Interfaces:**
- Consumes: action runtime and snapshots.
- Produces:

```ts
export interface PositionSample {
  at: number;
  position: { x: number; y: number; z: number };
  pathStatus?: 'moving' | 'stuck' | 'noPath' | 'arrived';
}

export class StuckDetector {
  add(sample: PositionSample): MinecraftFact | null;
  reset(): void;
}

export class MinecraftFollowController {
  start(target: string): void;
  stop(): void;
  update(snapshot: MinecraftEnvironmentSnapshot): MinecraftFact[];
  getPhase(): MinecraftEnvironmentSnapshot['follow'];
}

export class MinecraftReflexEngine {
  update(snapshot: MinecraftEnvironmentSnapshot): MinecraftActionInstruction[];
}
```

- [ ] **Step 1: Write failing stuck detector test**

```ts
import { describe, expect, it } from 'vitest';
import { StuckDetector } from '../stuckDetector';

describe('StuckDetector', () => {
  it('emits one blocked fact when position barely changes across samples', () => {
    const detector = new StuckDetector({ minDistance: 0.4, windowMs: 4000 });
    detector.add({ at: 0, position: { x: 1, y: 64, z: 1 }, pathStatus: 'moving' });
    detector.add({ at: 2000, position: { x: 1.1, y: 64, z: 1.05 }, pathStatus: 'moving' });
    const fact = detector.add({ at: 4500, position: { x: 1.15, y: 64, z: 1.1 }, pathStatus: 'moving' });

    expect(fact?.kind).toBe('movement.blocked');
    expect(detector.add({ at: 4600, position: { x: 1.16, y: 64, z: 1.1 }, pathStatus: 'moving' })).toBeNull();
  });
});
```

- [ ] **Step 2: Write failing follow controller test**

```ts
import { describe, expect, it } from 'vitest';
import { MinecraftFollowController } from '../followController';
import type { MinecraftEnvironmentSnapshot } from '../contracts';

function snapshot(distance?: number, visible = true): MinecraftEnvironmentSnapshot {
  return {
    capturedAt: Date.now(),
    stale: false,
    connection: { connected: true },
    owner: { name: 'Player', visible, distance },
    follow: { phase: 'inactive' },
    nearby: { blocks: [], entities: [] },
    recentEvents: [],
  };
}

describe('MinecraftFollowController', () => {
  it('reports approaching before nearby and target-lost when player disappears', () => {
    const follow = new MinecraftFollowController({ nearbyDistance: 4 });
    follow.start('Player');

    expect(follow.update(snapshot(12))[0].text).toContain('coming');
    expect(follow.getPhase().phase).toBe('approaching');
    follow.update(snapshot(3));
    expect(follow.getPhase().phase).toBe('nearby');
    follow.update(snapshot(undefined, false));
    expect(follow.getPhase().phase).toBe('target-lost');
  });
});
```

- [ ] **Step 3: Implement reflex and follow modules**

Implement low-cost reflexes for hunger, immediate hostile danger, blocked movement, and target lost. Reflex output is only deterministic action instructions, never chat text. The coordinator later decides whether Hiyori says anything.

- [ ] **Step 4: Integrate into runtime**

Runtime calls `reflexEngine.update(snapshot)` before non-critical actions. Runtime records significant facts from follow and stuck modules into `recentEvents`.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- electron/minecraft/__tests__/stuckDetector.test.ts electron/minecraft/__tests__/followController.test.ts electron/minecraft/__tests__/reflexEngine.test.ts electron/minecraft/__tests__/embodimentRuntime.test.ts`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add electron/minecraft/stuckDetector.ts electron/minecraft/followController.ts electron/minecraft/reflexEngine.ts electron/minecraft/embodimentRuntime.ts electron/minecraft/mineflayerAdapter.ts electron/minecraft/__tests__/stuckDetector.test.ts electron/minecraft/__tests__/followController.test.ts electron/minecraft/__tests__/reflexEngine.test.ts electron/minecraft/__tests__/embodimentRuntime.test.ts
git commit -m "feat: add minecraft reflex and follow state"
```

---

### Task 5: Runtime Manager Goals And Events

**Files:**
- Modify: `electron/minecraft/runtimeManager.ts`
- Modify: `electron/minecraft/mainIntegration.ts`
- Test: `electron/minecraft/__tests__/runtimeManager.test.ts`
- Test: `electron/minecraft/__tests__/mainIntegration.test.ts`

**Interfaces:**
- Consumes: worker `snapshot`, `execute-action`, `cancel-action`.
- Produces:

```ts
export interface MinecraftGoalOrigin {
  conversationId?: string;
  source: 'desktop' | 'discord' | 'wechat' | 'feishu' | 'minecraft';
  replyTarget?: string;
}

export interface MinecraftGoalState {
  id: string;
  title: string;
  origin: MinecraftGoalOrigin;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  lastSnapshot?: MinecraftEnvironmentSnapshot;
  lastResult?: MinecraftActionResult;
}
```

- [ ] **Step 1: Write failing runtime-manager tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { MinecraftRuntimeManager } from '../runtimeManager';

describe('MinecraftRuntimeManager goals', () => {
  it('stores action origins by goal instead of collection-only state', async () => {
    const manager = new MinecraftRuntimeManager({ workerFactory: fakeWorkerFactory() });
    await manager.startGoal({
      id: 'goal-1',
      title: 'collect nearby sugar cane',
      origin: { source: 'minecraft', conversationId: 'conv-1' },
    });

    expect(manager.getGoal('goal-1')?.origin.source).toBe('minecraft');
  });

  it('dedupes significant terminal events before notifying main integration', async () => {
    const notify = vi.fn();
    const manager = new MinecraftRuntimeManager({ workerFactory: fakeWorkerFactory(), notify });

    manager.recordSignificantEvent('goal-1', { kind: 'completed', text: 'done' });
    manager.recordSignificantEvent('goal-1', { kind: 'completed', text: 'done' });

    expect(notify).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- electron/minecraft/__tests__/runtimeManager.test.ts`

Expected: fail because goal APIs do not exist.

- [ ] **Step 3: Implement goal state and event dedupe**

Replace collection-specific origin maps with generic goal origin storage. Keep existing collection terminal notification behavior through the generic event path.

- [ ] **Step 4: Run integration tests**

Run: `npm test -- electron/minecraft/__tests__/runtimeManager.test.ts electron/minecraft/__tests__/mainIntegration.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/minecraft/runtimeManager.ts electron/minecraft/mainIntegration.ts electron/minecraft/__tests__/runtimeManager.test.ts electron/minecraft/__tests__/mainIntegration.test.ts
git commit -m "feat: track minecraft goals and significant events"
```

---

### Task 6: Ephemeral Runtime Context

**Files:**
- Create: `electron/runtimeContext.ts`
- Modify: `electron/aiService.ts`
- Modify: `electron/minecraft/mainIntegration.ts`
- Modify: `electron/minecraft/chatChannel.ts`
- Test: `electron/__tests__/runtimeContext.test.ts`
- Test: `electron/minecraft/__tests__/chatChannel.test.ts`

**Interfaces:**
- Consumes: `MinecraftEnvironmentSnapshot`.
- Produces:

```ts
export type RuntimeContextProvider = () => Promise<string | null>;
export function registerRuntimeContextProvider(id: string, provider: RuntimeContextProvider): () => void;
export async function buildRuntimeContext(): Promise<string>;
export function formatMinecraftRuntimeContext(snapshot: MinecraftEnvironmentSnapshot): string;
```

- [ ] **Step 1: Write failing context-registry test**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { buildRuntimeContext, registerRuntimeContextProvider, resetRuntimeContextProvidersForTest } from '../runtimeContext';

afterEach(() => resetRuntimeContextProvidersForTest());

describe('runtime context registry', () => {
  it('builds fresh context and omits empty providers', async () => {
    let count = 0;
    registerRuntimeContextProvider('minecraft', async () => `Minecraft context ${++count}`);
    registerRuntimeContextProvider('empty', async () => null);

    expect(await buildRuntimeContext()).toContain('Minecraft context 1');
    expect(await buildRuntimeContext()).toContain('Minecraft context 2');
    expect(await buildRuntimeContext()).not.toContain('empty');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- electron/__tests__/runtimeContext.test.ts`

Expected: fail because `runtimeContext.ts` does not exist.

- [ ] **Step 3: Implement context registry and aiService append**

`aiService.ts` calls `buildRuntimeContext()` while constructing the system message for a turn. Append the returned text under a short heading. Do not write this context to message history or memory.

- [ ] **Step 4: Register Minecraft context provider**

`mainIntegration.ts` registers a provider that asks `runtimeManager.snapshot()` and formats connection, owner distance, health, food, follow phase, nearby visible blocks, nearby hostile entities, and current action.

- [ ] **Step 5: Run context and channel tests**

Run: `npm test -- electron/__tests__/runtimeContext.test.ts electron/minecraft/__tests__/chatChannel.test.ts`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add electron/runtimeContext.ts electron/aiService.ts electron/minecraft/mainIntegration.ts electron/minecraft/chatChannel.ts electron/__tests__/runtimeContext.test.ts electron/minecraft/__tests__/chatChannel.test.ts
git commit -m "feat: add ephemeral runtime context for minecraft"
```

---

### Task 7: Planner Model Adapter

**Files:**
- Create: `electron/minecraft/plannerModel.ts`
- Test: `electron/minecraft/__tests__/plannerModel.test.ts`

**Interfaces:**
- Consumes: existing `fetchCompletion` from `electron/llmClient.ts`.
- Produces:

```ts
export interface MinecraftPlannerPrompt {
  userInstruction: string;
  snapshot: MinecraftEnvironmentSnapshot;
  recentResults: MinecraftActionResult[];
}

export interface MinecraftPlannerModel {
  decide(input: MinecraftPlannerPrompt): Promise<MinecraftPlannerDecision>;
}

export function createMinecraftPlannerModel(options: {
  complete: (messages: Array<{ role: 'system' | 'user'; content: string }>) => Promise<string>;
}): MinecraftPlannerModel;
```

- [ ] **Step 1: Write failing parser tests**

```ts
import { describe, expect, it } from 'vitest';
import { createMinecraftPlannerModel } from '../plannerModel';

describe('createMinecraftPlannerModel', () => {
  it('parses a typed action decision', async () => {
    const model = createMinecraftPlannerModel({
      complete: async () => JSON.stringify({
        kind: 'act',
        rationale: 'visible sugar cane is nearby',
        action: { id: 'act-1', name: 'collect_block', args: { block: 'sugar_cane', scope: 'nearby' } },
      }),
    });

    const decision = await model.decide({
      userInstruction: 'collect the sugar cane nearby',
      snapshot: disconnectedSnapshot(),
      recentResults: [],
    });

    expect(decision.kind).toBe('act');
    expect(decision.kind === 'act' && decision.action.name).toBe('collect_block');
  });

  it('turns malformed model output into an ask-user decision', async () => {
    const model = createMinecraftPlannerModel({ complete: async () => 'not json' });

    const decision = await model.decide({
      userInstruction: 'do something',
      snapshot: disconnectedSnapshot(),
      recentResults: [],
    });

    expect(decision.kind).toBe('ask-user');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- electron/minecraft/__tests__/plannerModel.test.ts`

Expected: fail because planner model does not exist.

- [ ] **Step 3: Implement strict JSON planner adapter**

The system prompt says the model must return exactly one JSON decision. The parser accepts only the union in Shared Interfaces. Unknown action names, missing `kind`, and non-object output become `{ kind: 'ask-user', question: '我需要确认一下 Minecraft 里的下一步要做什么。', reason: 'planner-output-invalid' }`.

- [ ] **Step 4: Run tests**

Run: `npm test -- electron/minecraft/__tests__/plannerModel.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/minecraft/plannerModel.ts electron/minecraft/__tests__/plannerModel.test.ts
git commit -m "feat: add minecraft planner model adapter"
```

---

### Task 8: Cognition Coordinator

**Files:**
- Create: `electron/minecraft/cognitionCoordinator.ts`
- Modify: `electron/minecraft/mainIntegration.ts`
- Test: `electron/minecraft/__tests__/cognitionCoordinator.test.ts`
- Test: `electron/minecraft/__tests__/mainIntegration.test.ts`

**Interfaces:**
- Consumes: planner model, runtime manager goals, runtime manager action execution.
- Produces:

```ts
export interface MinecraftGoalRequest {
  id: string;
  title: string;
  instruction: string;
  origin: MinecraftGoalOrigin;
}

export class MinecraftCognitionCoordinator {
  constructor(options: {
    planner: MinecraftPlannerModel;
    runtime: MinecraftRuntimeManager;
    notify: (origin: MinecraftGoalOrigin, message: string) => Promise<void>;
    maxPlannerTurns?: number;
  });
  startGoal(request: MinecraftGoalRequest): Promise<void>;
  stopGoal(goalId: string): Promise<boolean>;
  handleRuntimeEvent(goalId: string): Promise<void>;
}
```

- [ ] **Step 1: Write failing coordinator tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { MinecraftCognitionCoordinator } from '../cognitionCoordinator';

describe('MinecraftCognitionCoordinator', () => {
  it('executes act decisions and completes after verified result', async () => {
    const runtime = fakeRuntime({
      executeResult: { outcome: 'succeeded', summary: 'collected sugar cane', inventoryDelta: { sugar_cane: 3 } },
    });
    const planner = fakePlanner([
      { kind: 'act', rationale: 'nearby', action: { id: 'act-1', name: 'collect_block', args: { block: 'sugar_cane' } } },
      { kind: 'complete', result: '甘蔗已经采好了，拿到了 3 个。' },
    ]);
    const notify = vi.fn(async () => {});

    const coordinator = new MinecraftCognitionCoordinator({ planner, runtime, notify, maxPlannerTurns: 4 });
    await coordinator.startGoal({
      id: 'goal-1',
      title: 'collect cane',
      instruction: '帮我采附近甘蔗',
      origin: { source: 'minecraft', conversationId: 'conv-1' },
    });

    expect(runtime.execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'collect_block' }));
    expect(notify).toHaveBeenCalledWith(expect.anything(), '甘蔗已经采好了，拿到了 3 个。');
  });

  it('stops after repeated recoverable failures and asks the user', async () => {
    const runtime = fakeRuntime({ executeResult: { outcome: 'failed', errorCode: 'path_unreachable' } });
    const planner = fakePlanner([
      { kind: 'act', rationale: 'try path', action: { id: 'act-1', name: 'collect_block', args: { block: 'sugar_cane' } } },
      { kind: 'act', rationale: 'try path again', action: { id: 'act-2', name: 'collect_block', args: { block: 'sugar_cane' } } },
      { kind: 'ask-user', question: '我走不过去，能带我靠近一点吗？', reason: 'path-unreachable' },
    ]);
    const notify = vi.fn(async () => {});

    const coordinator = new MinecraftCognitionCoordinator({ planner, runtime, notify, maxPlannerTurns: 4 });
    await coordinator.startGoal({ id: 'goal-1', title: 'collect cane', instruction: '采甘蔗', origin: { source: 'desktop' } });

    expect(notify).toHaveBeenCalledWith(expect.anything(), '我走不过去，能带我靠近一点吗？');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- electron/minecraft/__tests__/cognitionCoordinator.test.ts`

Expected: fail because coordinator does not exist.

- [ ] **Step 3: Implement event-driven planning loop**

Coordinator obtains snapshot, calls planner, executes one deterministic action, observes result, and calls planner again only after a significant result. It never loops on world ticks. It stops at `complete`, `ask-user`, cancellation, or `maxPlannerTurns`.

- [ ] **Step 4: Wire main integration**

`mainIntegration.ts` creates the coordinator after runtime manager initialization and routes Minecraft chat goal requests to it.

- [ ] **Step 5: Run coordinator tests**

Run: `npm test -- electron/minecraft/__tests__/cognitionCoordinator.test.ts electron/minecraft/__tests__/mainIntegration.test.ts`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add electron/minecraft/cognitionCoordinator.ts electron/minecraft/mainIntegration.ts electron/minecraft/__tests__/cognitionCoordinator.test.ts electron/minecraft/__tests__/mainIntegration.test.ts
git commit -m "feat: coordinate minecraft goals through hiyori cognition"
```

---

### Task 9: Public Tool Surface

**Files:**
- Modify: `electron/tools/impl/minecraftCompanion.ts`
- Modify: `electron/tools/impl/__tests__/minecraftCompanion.test.ts`
- Modify: any tool schema registry file that references `minecraft_companion`

**Interfaces:**
- Consumes: `MinecraftCognitionCoordinator`.
- Produces public actions:

```ts
type MinecraftCompanionToolInput =
  | { action: 'connect'; host?: string; port?: number; username?: string }
  | { action: 'disconnect' }
  | { action: 'status' }
  | { action: 'say'; message: string }
  | { action: 'start_goal'; task: string }
  | { action: 'stop_goal'; goal_id?: string };
```

- [ ] **Step 1: Write failing tool tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createMinecraftCompanionTool } from '../minecraftCompanion';

describe('minecraft companion tool', () => {
  it('starts a natural-language goal instead of exposing collect and follow choices', async () => {
    const coordinator = { startGoal: vi.fn(async () => {}) };
    const tool = createMinecraftCompanionTool({ coordinator, runtimeManager: fakeRuntimeManager() });

    const result = await tool.execute({ action: 'start_goal', task: '帮我采附近的甘蔗' }, fakeToolContext());

    expect(coordinator.startGoal).toHaveBeenCalledWith(expect.objectContaining({ instruction: '帮我采附近的甘蔗' }));
    expect(result).toContain('已开始 Minecraft 目标');
  });

  it('rejects obsolete low-level collect action with clear wording', async () => {
    const tool = createMinecraftCompanionTool({ coordinator: fakeCoordinator(), runtimeManager: fakeRuntimeManager() });

    const result = await tool.execute({ action: 'collect', block: 'sugar_cane' } as never, fakeToolContext());

    expect(result).toContain('请用 start_goal 描述想在 Minecraft 里完成的事情');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- electron/tools/impl/__tests__/minecraftCompanion.test.ts`

Expected: fail because `start_goal` is not implemented or low-level actions still pass.

- [ ] **Step 3: Implement high-level tool schema**

Keep connect, disconnect, status, and say. Replace public follow and collect with `start_goal`. Keep a clear rejection path for old low-level action names during this branch so the LLM gets a useful tool result while prompt caches settle.

- [ ] **Step 4: Run tool tests**

Run: `npm test -- electron/tools/impl/__tests__/minecraftCompanion.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/tools/impl/minecraftCompanion.ts electron/tools/impl/__tests__/minecraftCompanion.test.ts
git commit -m "feat: simplify minecraft companion tool surface"
```

---

### Task 10: Mindcraft-Inspired Deterministic Actions

**Files:**
- Modify: `electron/minecraft/actions/navigation.ts`
- Modify: `electron/minecraft/actions/resources.ts`
- Create: `electron/minecraft/actions/inventory.ts`
- Create: `electron/minecraft/actions/survival.ts`
- Test: `electron/minecraft/__tests__/actions.navigation.test.ts`
- Test: `electron/minecraft/__tests__/actions.resources.test.ts`
- Test: `electron/minecraft/__tests__/actions.survival.test.ts`

**Interfaces:**
- Consumes: action registry.
- Produces handlers for `craft_item`, `smelt_item`, `use_container`, `eat`, `equip`, `defend`, `retreat`, `sleep`, `harvest_crop`, `till_soil`, `sow_crop`, `place_block`, and `break_block`.

- [ ] **Step 1: Write failing resource action tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createResourceActions } from '../actions/resources';

describe('resource actions', () => {
  it('collects visible nearby blocks with inventory delta verification', async () => {
    const adapter = fakeActionAdapter({
      collectBlock: vi.fn(async () => ({
        actionId: 'act-1',
        outcome: 'succeeded',
        summary: 'collected 4 sugar cane',
        durationMs: 1000,
        inventoryDelta: { sugar_cane: 4 },
        worldChanges: [{ kind: 'block_broken', name: 'sugar_cane', count: 4 }],
        observations: [],
      })),
    });
    const action = createResourceActions().find((handler) => handler.name === 'collect_block')!;

    const result = await action.run({ id: 'act-1', name: 'collect_block', args: { block: 'sugar_cane', scope: 'nearby' } }, fakeActionContext(adapter));

    expect(result.inventoryDelta.sugar_cane).toBe(4);
    expect(result.summary).not.toContain('64');
  });
});
```

- [ ] **Step 2: Write failing survival action tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createSurvivalActions } from '../actions/survival';

describe('survival actions', () => {
  it('returns missing_item when eat has no food', async () => {
    const adapter = fakeActionAdapter({ eatBestFood: vi.fn(async () => false) });
    const action = createSurvivalActions().find((handler) => handler.name === 'eat')!;

    const result = await action.run({ id: 'act-1', name: 'eat', args: {} }, fakeActionContext(adapter));

    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('missing_item');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- electron/minecraft/__tests__/actions.resources.test.ts electron/minecraft/__tests__/actions.survival.test.ts`

Expected: fail because new action files and adapter methods do not exist.

- [ ] **Step 4: Implement deterministic handlers**

Port the action behavior as bounded TypeScript handlers. Each handler returns a structured result with an inventory delta, world changes, and recoverability. Use Mineflayer plugins through adapter methods only.

- [ ] **Step 5: Run action tests**

Run: `npm test -- electron/minecraft/__tests__/actions.navigation.test.ts electron/minecraft/__tests__/actions.resources.test.ts electron/minecraft/__tests__/actions.survival.test.ts electron/minecraft/__tests__/embodimentRuntime.test.ts`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add electron/minecraft/actions electron/minecraft/__tests__/actions.navigation.test.ts electron/minecraft/__tests__/actions.resources.test.ts electron/minecraft/__tests__/actions.survival.test.ts electron/minecraft/__tests__/embodimentRuntime.test.ts
git commit -m "feat: expand minecraft deterministic actions"
```

---

### Task 11: Provenance, Removal Verification, And Manual LAN Smoke Tests

**Files:**
- Modify: `docs/THIRD_PARTY_NOTICES.md`
- Modify: `docs/superpowers/specs/2026-08-05-minecraft-autonomous-agent-runtime-design.md`
- Test: existing full test suite

**Interfaces:**
- Consumes: completed runtime, planner, tools, and integration.
- Produces: documented source references and verified release state.

- [ ] **Step 1: Add provenance notes**

Add entries for:

```md
### AIRI
- Repository: https://github.com/moeru-ai/airi
- Reference commit: 20d6158144b594eeb4423e4fd4b514964aa644f0
- License: MIT
- Usage: architecture reference for perception/reflex/action/planning split; no copied production code.

### Mindcraft
- Repository: https://github.com/kolbytn/mindcraft
- Reference commit: 5f3acc87b479864124173de444f31fa5538f94a6
- License: MIT
- Usage: action-library behavior reference for Minecraft deterministic tasks.

### Voyager
- Repository: https://github.com/MineDojo/Voyager
- Reference commit: 55e45a880755d0c8c66ca7fb5fe7962ac8974f89
- License: MIT
- Usage: observe-act-verify-replan reference for goal execution.
```

- [ ] **Step 2: Verify old controller and low-level public actions are absent**

Run:

```powershell
rg "bodyController|action: 'collect'|action: 'follow'|collection-terminal" electron/minecraft electron/tools/impl
```

Expected: no `bodyController` references; `collection-terminal` only remains if the final event name is still intentionally used through generic goal events.

- [ ] **Step 3: Run the focused Minecraft test suite**

Run:

```powershell
npm test -- electron/minecraft electron/tools/impl/__tests__/minecraftCompanion.test.ts electron/__tests__/runtimeContext.test.ts
```

Expected: pass.

- [ ] **Step 4: Run the full test suite and build**

Run:

```powershell
npm test
npm run build
```

Expected: both pass.

- [ ] **Step 5: Manual LAN smoke test**

With Minecraft Java LAN open on the current local port, run the app and verify:

```text
1. Ask Hiyori to connect to the LAN room.
2. In Minecraft chat, say "hi".
3. Confirm Hiyori replies in Minecraft chat and desktop TTS speaks through the normal TTS system.
4. Ask Hiyori to follow you.
5. Walk away and confirm status/context says approaching until distance is small, then nearby.
6. Ask Hiyori to collect nearby sugar cane.
7. Confirm the whole visible plant is collected, inventory delta is reported, and Hiyori does not claim the user requested 64 items.
8. Move behind terrain and confirm blocked or recovering state is reflected in context before Hiyori claims she is nearby.
```

- [ ] **Step 6: Commit**

```bash
git add docs/THIRD_PARTY_NOTICES.md docs/superpowers/specs/2026-08-05-minecraft-autonomous-agent-runtime-design.md
git commit -m "docs: document minecraft runtime provenance"
```

---

## Execution Strategy

Use subagent-driven development for Tasks 1 through 10 when available. Each task is independently reviewable and has focused tests, which keeps the replacement from becoming another compatibility layer. Task 11 must be performed in the main session because it combines local verification, build output, and manual LAN smoke testing.

Commit after every task. Do not batch unrelated tasks into one commit. Do not push until Task 11 passes or the user explicitly asks to push partial work.

## Self-Review

**Spec coverage:** The plan maps the approved architecture to concrete tasks: contracts and perception cover AIRI perception, reflex modules cover AIRI reflex, action registry and Mindcraft-inspired handlers cover action, planner model and coordinator cover planning, runtime context keeps Hiyori as the single persona, and public tool changes keep user interaction high level.

**Placeholder scan:** The plan contains no empty task steps, no undefined "fill later" markers, and no copied shorthand between tasks. Each code-facing task includes exact file names, signatures, test commands, and commit commands.

**Type consistency:** `MinecraftEnvironmentSnapshot`, `MinecraftActionInstruction`, `MinecraftActionResult`, `MinecraftPlannerDecision`, `MinecraftGoalOrigin`, and `MinecraftBodyAdapter` are defined before use and reused with the same property names across the plan.
