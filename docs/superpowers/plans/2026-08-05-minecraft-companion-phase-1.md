# Minecraft Companion Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the single Hiyori persona join a standard Minecraft Java LAN world, converse through Minecraft chat with existing TTS, and control one persistent Mineflayer body through bounded high-level actions.

**Architecture:** Electron owns a `MinecraftRuntimeManager` that communicates with a separately built Node child process over typed IPC. Minecraft chat is an external Hiyori message channel; Mineflayer performs deterministic movement and survival policies while Hiyori performs the only LLM turns. Collection terminal events and critical runtime events reuse the existing conversation wake-up and reply-target routing.

**Tech Stack:** Electron 41, TypeScript 5.9, Vitest 4, Mineflayer 4.37, PrismarineJS pathfinder/collect/auto-eat/PVP plugins, Node child-process IPC, Minecraft Java LAN multicast.

## Global Constraints

- Target standard Minecraft Java LAN worlds; do not add a NetEase protocol path.
- The verified compatibility floor is Minecraft Java 1.11.2 launched by HMCL.
- Keep one Hiyori persona, prompt stack, conversation history, memory system, and TTS lifecycle.
- Keep Mineflayer outside the Electron main process.
- Never read, persist, or log Microsoft/HMCL credentials.
- Expose one user-facing tool named `minecraft_companion`; do not expose packet, pathfinder, process, or provider terminology.
- At most one bot and one foreground game behavior may be active.
- Collection quantity is capped at 64 and radius at 64 blocks.
- Do not poll the LLM for progress; emit one collection terminal event.
- Auto-eat only inventory food. Missing food produces one deduplicated notification; Phase 1 does not forage, hunt, harvest, or inspect containers.
- Basic defense never attacks players or neutral entities.
- No Minecraft settings UI or native Simple Voice Chat implementation in Phase 1; reserve a voice sink interface only.

---

### Task 1: Dependencies, IPC Contract, And LAN Discovery

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `electron/minecraft/protocol.ts`
- Create: `electron/minecraft/lanDiscovery.ts`
- Create: `electron/minecraft/__tests__/lanDiscovery.test.ts`

**Interfaces:**
- Produces: `MinecraftCommand`, `MinecraftWorkerMessage`, `MinecraftStatus`, `MinecraftRoom`, `MinecraftTerminalEvent`.
- Produces: `parseLanAnnouncement(message, sourceAddress): MinecraftRoom | null`.
- Produces: `discoverLanRooms(options?): Promise<MinecraftRoom[]>` with injected socket/probe dependencies for tests.

- [ ] **Step 1: Install the supported PrismarineJS dependencies**

Run:

```powershell
npm install mineflayer@4.37.1 mineflayer-pathfinder@2.4.5 mineflayer-collectblock@1.6.0 mineflayer-auto-eat@5.0.3 mineflayer-pvp@1.3.2
```

Expected: dependencies appear under `dependencies`, lockfile resolves without audit/install failure, and Electron's Node version satisfies Mineflayer's `>=22` requirement.

- [ ] **Step 2: Write failing LAN parser and decision tests**

Create tests covering:

```ts
expect(parseLanAnnouncement('[MOTD]GeoLingua - test[/MOTD][AD]60131[/AD]', '49.52.30.20')).toEqual({
  motd: 'GeoLingua - test',
  advertisedHost: '49.52.30.20',
  port: 60131,
});
expect(parseLanAnnouncement('invalid', '127.0.0.1')).toBeNull();
expect(parseLanAnnouncement('[MOTD]x[/MOTD][AD]70000[/AD]', '127.0.0.1')).toBeNull();
```

Test discovery deduplicates identical ports, probes `127.0.0.1` before the advertised address, and returns zero/one/multiple rooms without selecting among multiple rooms.

- [ ] **Step 3: Run the tests and verify the expected failure**

Run: `npx vitest run electron/minecraft/__tests__/lanDiscovery.test.ts`

Expected: FAIL because `lanDiscovery.ts` and the protocol types do not exist.

- [ ] **Step 4: Implement the typed protocol and LAN discovery**

Define the command union:

```ts
export type MinecraftAction = 'discover' | 'connect' | 'disconnect' | 'status' | 'say' | 'follow' | 'collect' | 'stop';

export interface MinecraftCommand<T = unknown> {
  type: 'command';
  id: string;
  action: MinecraftAction;
  payload: T;
}

export type MinecraftWorkerMessage =
  | { type: 'response'; id: string; ok: true; data: unknown }
  | { type: 'response'; id: string; ok: false; error: string }
  | { type: 'event'; event: MinecraftRuntimeEvent };
```

Implement UDP multicast listening on `224.0.2.60:4445`, strict MOTD/port parsing, deduplication, and endpoint probing. Prefer `127.0.0.1` for an advertised port when a Minecraft status ping succeeds; otherwise use the packet source address.

- [ ] **Step 5: Run focused and full tests**

Run:

```powershell
npx vitest run electron/minecraft/__tests__/lanDiscovery.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit the discovery contract**

```powershell
git add package.json package-lock.json electron/minecraft/protocol.ts electron/minecraft/lanDiscovery.ts electron/minecraft/__tests__/lanDiscovery.test.ts
git commit -m "feat: add minecraft lan discovery contract"
```

---

### Task 2: Deterministic Mineflayer Body Controller

**Files:**
- Create: `electron/minecraft/bodyController.ts`
- Create: `electron/minecraft/__tests__/bodyController.test.ts`

**Interfaces:**
- Consumes: protocol status and terminal event types from Task 1.
- Produces: `MinecraftBotAdapter`, an interface that wraps Mineflayer/plugin calls for deterministic tests.
- Produces: `MinecraftBodyController` with `connect`, `disconnect`, `status`, `say`, `follow`, `collect`, and `stop` methods.

- [ ] **Step 1: Write failing body-state tests against a fake adapter**

Cover these behaviors:

```ts
await controller.follow({ player: 'GeoLingua' });
expect(controller.status().behavior).toEqual({ kind: 'follow', player: 'GeoLingua' });

const accepted = await controller.collect({ block: 'oak_log', quantity: 10, radius: 32 });
expect(accepted.state).toBe('running');
expect(adapter.stopFollow).toHaveBeenCalledOnce();

await controller.stop();
await controller.stop();
expect(controller.status().behavior).toEqual({ kind: 'idle' });
```

Also test unknown block rejection, quantity/radius caps, exact one terminal event, player exclusion from defense targets, and one missing-food event per hunger episode.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run electron/minecraft/__tests__/bodyController.test.ts`

Expected: FAIL because `MinecraftBodyController` does not exist.

- [ ] **Step 3: Implement the minimal state controller**

Use a single foreground behavior union:

```ts
type ForegroundBehavior =
  | { kind: 'idle' }
  | { kind: 'follow'; player: string }
  | { kind: 'collect'; jobId: string; block: string; requested: number; collected: number };
```

Starting follow or collection cancels the previous foreground behavior. Chat never changes it. Collection resolves registry names, applies caps, delegates pathing/collection to the adapter, and emits one `completed | partial | cancelled | failed` event. Auto-eat and defense are adapter policies outside this foreground union.

- [ ] **Step 4: Verify GREEN and refactor names only after passing**

Run: `npx vitest run electron/minecraft/__tests__/bodyController.test.ts`

Expected: PASS with no unhandled promise output.

- [ ] **Step 5: Commit the deterministic controller**

```powershell
git add electron/minecraft/bodyController.ts electron/minecraft/__tests__/bodyController.test.ts
git commit -m "feat: add minecraft body state controller"
```

---

### Task 3: Mineflayer Adapter And Worker Entry

**Files:**
- Create: `electron/minecraft/mineflayerAdapter.ts`
- Create: `electron/minecraft/workerEntry.ts`
- Create: `electron/minecraft/__tests__/workerEntry.test.ts`
- Modify: `electron.vite.config.ts`

**Interfaces:**
- Consumes: `MinecraftBotAdapter`, `MinecraftBodyController`, and IPC protocol types.
- Produces: `createMineflayerAdapter(options): MinecraftBotAdapter`.
- Produces: separately bundled `out/main/minecraftWorker.js`.

- [ ] **Step 1: Write failing worker-dispatch tests**

Inject a fake controller and send commands through an in-memory transport. Assert that each command returns the same request id, failures become `{ ok: false, error }`, and body events are forwarded as worker events. Include idempotent disconnect and process disconnect cleanup.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run electron/minecraft/__tests__/workerEntry.test.ts`

Expected: FAIL because the worker dispatcher does not exist.

- [ ] **Step 3: Implement the Mineflayer adapter**

Use:

```ts
bot.loadPlugin(pathfinder);
bot.loadPlugin(collectBlock.plugin);
bot.loadPlugin(autoEat.loader);
bot.loadPlugin(pvp.plugin);
```

Connect with `auth: 'offline'`, wait for `spawn`, expose compact status, and forward public `chat` events excluding the bot's own username. Follow uses pathfinder dynamic goals. Collection uses `mineflayer-collectblock`. Auto-eat consumes inventory food only. Defense selects hostile mobs from registry/entity metadata and never player entities.

- [ ] **Step 4: Implement worker command dispatch and the extra Vite entry**

Add:

```ts
input: {
  index: resolve('electron/main.ts'),
  minecraftWorker: resolve('electron/minecraft/workerEntry.ts'),
}
```

The entry receives `MinecraftCommand`, calls the controller, sends a correlated response, forwards controller events, and disconnects the bot on parent IPC closure.

- [ ] **Step 5: Run tests and build**

Run:

```powershell
npx vitest run electron/minecraft/__tests__/workerEntry.test.ts
npm run build
Test-Path out/main/minecraftWorker.js
```

Expected: tests PASS, build succeeds, final command prints `True`.

- [ ] **Step 6: Commit the worker**

```powershell
git add electron/minecraft/mineflayerAdapter.ts electron/minecraft/workerEntry.ts electron/minecraft/__tests__/workerEntry.test.ts electron.vite.config.ts
git commit -m "feat: run minecraft body in isolated worker"
```

---

### Task 4: Electron Runtime Manager And Terminal Event Routing

**Files:**
- Create: `electron/minecraft/runtimeManager.ts`
- Create: `electron/minecraft/__tests__/runtimeManager.test.ts`
- Create: `electron/minecraft/index.ts`

**Interfaces:**
- Produces: `MinecraftRuntimeManager.command<T>(action, payload, timeoutMs?): Promise<T>`.
- Produces: `MinecraftRuntimeManager.startCollection(payload, origin): Promise<AcceptedCollection>`.
- Produces: `MinecraftRuntimeManager.onEvent(listener): () => void` and `shutdown(): Promise<void>`.
- Produces: singleton `minecraftRuntime` and notifier setters without importing `electron/main.ts`.

- [ ] **Step 1: Write failing manager tests with a fake child process**

Assert request correlation, command timeout cleanup, worker crash rejection, exactly-once terminal notification, unexpected-disconnect notification, and clean shutdown. Assert progress/status events do not call the notifier.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run electron/minecraft/__tests__/runtimeManager.test.ts`

Expected: FAIL because the manager does not exist.

- [ ] **Step 3: Implement manager lifecycle and origin tracking**

Define origin metadata only in the parent:

```ts
export interface MinecraftCommandOrigin {
  conversationId: string;
  replyTarget?: ReplyTarget;
}
```

Map collection `jobId` to its origin, remove it on the first terminal event, and invoke the configured notifier with a compact instruction containing requested/collected quantities and outcome. Never send pathfinder progress to Hiyori.

- [ ] **Step 4: Verify focused tests**

Run: `npx vitest run electron/minecraft/__tests__/runtimeManager.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the manager**

```powershell
git add electron/minecraft/runtimeManager.ts electron/minecraft/index.ts electron/minecraft/__tests__/runtimeManager.test.ts
git commit -m "feat: manage minecraft worker lifecycle"
```

---

### Task 5: Hiyori Minecraft Tool

**Files:**
- Create: `electron/tools/impl/minecraftCompanion.ts`
- Create: `electron/tools/impl/__tests__/minecraftCompanion.test.ts`
- Modify: `electron/tools/index.ts`
- Modify: `electron/toolsets.ts`

**Interfaces:**
- Consumes: `minecraftRuntime` and `getReplyTargetForConversation`.
- Produces: one `minecraft_companion` tool visible in the existing `chat`, `agent`, and `agent-debug` toolsets used by the main Hiyori. Do not add it to delegated or batch-worker toolsets.

- [ ] **Step 1: Write failing schema and behavior tests**

Require actions:

```ts
type MinecraftCompanionAction =
  | 'connect' | 'disconnect' | 'status' | 'say'
  | 'follow' | 'collect' | 'stop';
```

Test natural tool results: no room asks the user to open LAN; multiple rooms asks the user to choose; one room connects automatically; collect returns “正在执行” and does not suggest status polling; repeated stop/disconnect remain successful. Test optional `owner`, `host`, `port`, `player`, `message`, `block`, `quantity`, and `radius` validation.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run electron/tools/impl/__tests__/minecraftCompanion.test.ts`

Expected: FAIL because the tool is not registered.

- [ ] **Step 3: Implement and register the tool**

The description must state facts, not defensive special cases:

```text
Control Hiyori's persistent Minecraft companion body. A command changes the
body's state once; movement and survival continue in the Minecraft runtime.
Collection reports its final outcome later. Use status only when the user asks.
```

`connect` auto-discovers unless host/port are supplied. If one human is present,
bind it as owner. If multiple humans are present and no owner is supplied, keep
chat mention-only and return the player names for user selection; repeating
`connect` with `owner` updates the binding without reconnecting.

- [ ] **Step 4: Verify tool tests and toolset integrity**

Run:

```powershell
npx vitest run electron/tools/impl/__tests__/minecraftCompanion.test.ts
npx tsx electron/verify_toolsets.ts
```

Expected: PASS with no unknown tool references.

- [ ] **Step 5: Commit the tool**

```powershell
git add electron/tools/impl/minecraftCompanion.ts electron/tools/impl/__tests__/minecraftCompanion.test.ts electron/tools/index.ts electron/toolsets.ts
git commit -m "feat: expose minecraft companion tool"
```

---

### Task 6: Minecraft Chat As A Hiyori Message Channel

**Files:**
- Create: `electron/minecraft/chatChannel.ts`
- Create: `electron/minecraft/__tests__/chatChannel.test.ts`
- Modify: `electron/aiService.ts`
- Modify: `electron/bridges/asyncDelivery.ts`

**Interfaces:**
- Produces: optional `ChatRequestContext` accepted by `sendChatMessage(conversationId, userContent, requestContext?)`.
- Extends: `BridgePlatform` and `ReplyTarget` with Minecraft.
- Produces: `MinecraftChatChannel` that serializes inbound game messages and invokes the existing Hiyori LLM once per accepted message.
- Reserves: `MinecraftVoiceSink` interface without implementing Simple Voice Chat.

- [ ] **Step 1: Write failing chat-filter and routing tests**

Test:

- One human plus Hiyori: that human's normal chat is accepted.
- Additional human present: owner normal chat is accepted; non-owner chat requires a case-insensitive `Hiyori` mention.
- Bot's own messages are ignored.
- Accepted chat invokes one LLM turn, one Minecraft text reply, and one existing local TTS playback.
- A second incoming chat waits behind the first LLM turn but game movement remains untouched.
- Source metadata is supplied to the current LLM turn while the persisted user message remains clean.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run electron/minecraft/__tests__/chatChannel.test.ts electron/bridges/__tests__/asyncDelivery.test.ts`

Expected: FAIL because Minecraft is not a channel/reply target.

- [ ] **Step 3: Add structured current-turn source context**

Add:

```ts
export interface ChatRequestContext {
  sourceContext?: string;
}
```

Append `sourceContext` to the current system context only; save `userContent`
unchanged in SQLite. Existing desktop and bridge calls remain source-compatible.

- [ ] **Step 4: Extend reply-target routing**

Add:

```ts
export type ReplyTarget =
  | { kind: 'desktop' }
  | { kind: 'discord'; channelId: string }
  | { kind: 'wechat'; userId: string }
  | { kind: 'feishu'; chatId: string }
  | { kind: 'minecraft'; player: string };

export interface MinecraftVoiceSink {
  available(): boolean;
  send(player: string, audio: Uint8Array): Promise<void>;
}
```

Extend delivery adapters with `sendMinecraft(player, text)`. Do not implement the
voice sink; Phase 1 calls Hiyori's existing local `playTTSAudio` after text reply.

- [ ] **Step 5: Implement the channel controller**

Use compact factual context such as:

```text
当前消息来自 Minecraft 玩家 GeoLingua。Hiyori 已连接，当前动作：collect oak_log，生命：18，饥饿：12。
```

Call `noteBridgeInboundMessage` with platform `minecraft`, process the clean chat
through `sendChatMessage`, send final text through the runtime, and invoke local
TTS. Do not create Minecraft-specific memory or another agent runner.

- [ ] **Step 6: Verify focused tests**

Run: `npx vitest run electron/minecraft/__tests__/chatChannel.test.ts electron/bridges/__tests__/asyncDelivery.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit channel routing**

```powershell
git add electron/minecraft/chatChannel.ts electron/minecraft/__tests__/chatChannel.test.ts electron/aiService.ts electron/bridges/asyncDelivery.ts electron/bridges/__tests__/asyncDelivery.test.ts
git commit -m "feat: route minecraft chat through hiyori"
```

---

### Task 7: Main Process, Wake-Up, TTS, And Desktop History Wiring

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/chat.ts`
- Create: `electron/minecraft/__tests__/mainIntegration.test.ts`

**Interfaces:**
- Consumes: runtime/channel singletons and Minecraft reply target from earlier tasks.
- Produces: renderer event `chat:external-turn` with clean user and assistant text.
- Produces: collection/disconnect/food wake-ups addressed to the initiating conversation and reply target.

- [ ] **Step 1: Write failing integration tests**

Test main-process dependency wiring without launching Electron:

- Runtime chat is handled by the configured conversation.
- Final Minecraft reply is sent once and local TTS is requested once.
- Collection completion wakes Hiyori with `{ kind: 'minecraft', player }` when initiated from Minecraft.
- Low-food duplicate events produce one wake-up until food recovers.
- App shutdown calls runtime shutdown.
- External turn mirroring contains clean display text and does not trigger a second TTS call.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run electron/minecraft/__tests__/mainIntegration.test.ts`

Expected: FAIL because application wiring is absent.

- [ ] **Step 3: Wire the runtime without circular imports**

Configure notifier and channel dependencies inside `app.whenReady()` after the
database/config initialization. Extend `deliverReplyTarget` with
`sendMinecraft`. Register runtime shutdown in the existing quit path. Do not add
startup auto-connect in Phase 1.

- [ ] **Step 4: Add clean desktop mirroring**

Expose:

```ts
onExternalTurn(cb: (payload: {
  conversationId: string;
  user: string;
  assistant: string;
  createdAt: number;
}) => void): () => void;
```

The renderer appends the turn only when that conversation is active. It does not
call `playTTS`; the main channel path already requested playback. Reloading the
conversation uses the clean SQLite messages written by `sendChatMessage`.

- [ ] **Step 5: Verify integration and regression tests**

Run:

```powershell
npx vitest run electron/minecraft/__tests__/mainIntegration.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit application wiring**

```powershell
git add electron/main.ts electron/preload.ts src/chat.ts electron/minecraft/__tests__/mainIntegration.test.ts
git commit -m "feat: integrate minecraft chat with hiyori"
```

---

### Task 8: Build, Package, And Live HMCL Smoke Test

**Files:**
- Modify only if verification reveals a tested packaging/runtime defect.
- Update: `docs/superpowers/specs/2026-08-05-minecraft-companion-phase-1-design.md` only if implemented behavior necessarily differs from the approved design.

**Interfaces:**
- Verifies all interfaces from Tasks 1-7 end to end.

- [ ] **Step 1: Run static/build/test verification**

Run:

```powershell
npm test
npm run build
npm run pack:win
```

Expected: all tests pass, Electron build succeeds, and the Windows package includes the worker and all production Mineflayer dependencies.

- [ ] **Step 2: Verify the packaged worker exists**

Inspect the packaged app archive/resources and confirm `minecraftWorker.js` plus Mineflayer/plugin dependencies are present. Do not rely on globally installed Node packages or the temporary probe directory.

- [ ] **Step 3: Run the live HMCL smoke test**

With the existing standard Java world open to LAN:

1. Start Hiyori via `npm run dev`.
2. Tell Hiyori the Minecraft room is open.
3. Verify automatic discovery and `Hiyori` spawning without a supplied port.
4. Send Minecraft chat and verify one Hiyori LLM reply, one in-game text reply, one local TTS playback, and clean desktop history.
5. Verify follow then stop.
6. Request a small nearby block collection; continue chatting while movement runs; verify one terminal callback.
7. Remove food or use a fake-adapter test state to verify deduplicated shortage notification without destructive gameplay.
8. Disconnect and confirm clean player departure.

- [ ] **Step 4: Fix only evidence-backed defects with TDD**

For every observed defect, add a failing regression test to the nearest test file,
run it to confirm RED, implement the minimal fix, and rerun focused plus full
tests. Do not expand into settings UI, foraging, building, or Simple Voice Chat.

- [ ] **Step 5: Final verification and commit**

Run:

```powershell
git status --short
git diff --check
npm test
npm run build
```

Commit the verified implementation and documentation paths:

```powershell
git add package.json package-lock.json electron.vite.config.ts electron/main.ts electron/preload.ts electron/aiService.ts electron/toolsets.ts electron/tools/index.ts electron/tools/impl/minecraftCompanion.ts electron/tools/impl/__tests__/minecraftCompanion.test.ts electron/bridges/asyncDelivery.ts electron/bridges/__tests__/asyncDelivery.test.ts electron/minecraft src/chat.ts docs/superpowers/specs/2026-08-05-minecraft-companion-phase-1-design.md
git commit -m "test: verify minecraft companion workflow"
```
