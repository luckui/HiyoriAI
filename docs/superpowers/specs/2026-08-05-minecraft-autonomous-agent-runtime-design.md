# Minecraft Autonomous Agent Runtime Design

## Goal

Turn Hiyori's Minecraft integration from a small set of remote-controlled bot
commands into a persistent embodied companion that can observe, react, plan,
act, verify results, recover from failures, and explore autonomously while
remaining the same Hiyori persona used by desktop and mobile conversations.

The implementation adopts established embodied-agent patterns instead of
inventing a Hiyori-specific agent vocabulary:

- AIRI provides the four-layer cognitive architecture and event-driven
  inhibition model.
- Mindcraft provides the primary reference implementations for deterministic
  Minecraft actions and recovery behavior.
- Voyager provides the observation, action feedback, verification, and
  iterative replanning pattern.

The first body adapter remains Mineflayer for the lightweight independent
second-player experience. The cognitive contracts must not depend on
Mineflayer objects so a later Fabric body adapter can replace it without
replacing Hiyori's planner or conversation integration.

## Non-Goals

- Do not embed AIRI, Mindcraft, or Voyager as a second complete agent.
- Do not add a second persona, conversation database, memory system, provider
  configuration, or user-facing Minecraft chat agent.
- Do not expose dozens of low-level Minecraft actions to Hiyori's ordinary
  tool loop.
- Do not run an LLM on game ticks or raw movement events.
- Do not keep the existing simple controller as a permanent fallback after the
  new runtime reaches feature parity.
- Do not expose hidden ores or blocks through walls in ordinary environmental
  context. Omniscient scans are outside the default fair-play policy.

## Verified Upstream Baselines

The design is based on these pinned MIT-licensed source revisions:

- AIRI: `20d6158144b594eeb4423e4fd4b514964aa644f0`
- Mindcraft: `5f3acc87b479864124173de444f31fa5538f94a6`
- Voyager: `55e45a880755d0c8c66ca7fb5fe7962ac8974f89`

AIRI's Minecraft package is private and depends on AIRI workspace packages,
its bridge, its model client, and its configuration. Mindcraft is a complete
application with global agent state. Voyager combines a Python research
orchestrator with an older Mineflayer bridge. None is a drop-in library for
Hiyori. Reuse therefore means a documented, tested adaptation of bounded
modules, not copying an entire application or maintaining two agent stacks.

Every adapted source file must identify its upstream repository, pinned commit,
and meaningful local changes. `THIRD_PARTY_NOTICES.md` must contain the MIT
notices. A source map document must list adapted modules and the corresponding
upstream files so later upstream reviews are mechanical rather than based on
memory.

## Process Boundary

The existing child-process isolation remains correct. The architecture is split
between an embodiment runtime in the Minecraft worker and a cognition
coordinator in the Electron main process.

### Minecraft worker: embodiment

The worker owns everything that needs a live Mineflayer bot or reacts at game
speed:

- body adapter and connection lifecycle
- normalized perception events
- current environment snapshot
- reflex engine
- deterministic action registry and executor
- session-scoped spatial observations
- movement, inventory, combat, and action verification facts

The worker never receives API keys and never calls an LLM.

### Electron main process: cognition

The main process owns everything that belongs to Hiyori:

- high-level Minecraft goals
- task-scoped planning transcript
- event-driven planner turns
- model/provider selection and token budget
- user conversation and persona
- desktop/mobile reply routing
- persistent task and world-memory policy

The planner uses Hiyori's configured provider through the existing LLM client.
It is a task-scoped game cognition loop, not a second character. Its decisions
and terminal results are visible to the main Hiyori conversation, while its
intermediate planning transcript is not stored as ordinary user chat.

## Layer Contracts

### 1. Perception

Perception converts Mineflayer data into immutable facts. It does not decide
what Hiyori should do or how Hiyori should phrase a response.

`MinecraftEnvironmentSnapshot` contains:

- capture timestamp and freshness
- dimension, position, Y level, biome, time, and weather
- health, hunger, oxygen, armor, held item, and compact inventory counts
- current goal, action, progress, and interruption state
- owner visibility, distance, relative direction, and follow phase
- visible nearby block types with nearest distance and bounded counts
- nearby entities grouped by type with nearest distance
- terrain cues such as surface, water, tree cover, cave opening, and hazards
- recent significant events and recoverable errors

Ambient context uses blocks that are visible or exposed to the surface. A
targeted action may inspect exact blocks required for execution, but hidden
resource locations are not included in the conversational snapshot.

Snapshots are ephemeral. They are regenerated for each Hiyori turn while
Minecraft is connected and are never inserted into SQLite chat history, global
memory, or conversation summaries.

Perception also emits normalized events such as:

- player appeared, moved, disappeared, died, or respawned
- bot damaged, hungry, drowning, burning, falling, or dead
- path updated, no path, collision, or lack of progress
- action progress, inventory delta, and world delta
- noteworthy resource, structure, hostile entity, or dropped item observed

Raw physics and entity-movement events are never forwarded directly to the LLM.

### 2. Reflex

Reflex handles immediate, deterministic reactions that cannot wait for an LLM:

- auto-eat available food
- defend against immediate hostile threats
- escape fire, lava, drowning, and dangerous falls
- collect nearby drops produced by the current action
- maintain or rebind a follow target after entity replacement or respawn
- attempt bounded movement recovery when strong evidence indicates obstruction

Reflex behavior follows AIRI's inhibition pattern. While a reflex owns the body,
conflicting conscious actions pause. Routine reflex events do not wake the LLM.
Only meaningful transitions, unresolved needs, or terminal failures reach the
cognition coordinator.

Stuck detection is evidence-based rather than a single rigid timeout. It
combines expected action movement, position delta, progress toward the target,
Pathfinder `noPath`/`stuck` signals, collision state, and target movement.
Stationary work such as digging or waiting at a furnace does not accumulate a
stuck score. A blocked episode is emitted once, cleared only after meaningful
movement or a new route, and subject to a cooldown.

### 3. Action

Actions are deterministic, typed capabilities. They do not contain persona
prompts and are not Hiyori Skills. The planner selects actions; the worker
executes and verifies them.

Each action returns a structured result:

```ts
interface MinecraftActionResult {
  outcome: 'succeeded' | 'partial' | 'failed' | 'cancelled'
  summary: string
  durationMs: number
  inventoryDelta: Record<string, number>
  worldChanges: MinecraftWorldChange[]
  observations: MinecraftFact[]
  error?: {
    code: MinecraftActionErrorCode
    recoverable: boolean
    details: Record<string, unknown>
  }
}
```

Initial action families are adapted from AIRI and Mindcraft:

- navigation: go to player, position, block, entity, or exploration frontier
- following: persistent follow, approach, wait, and stop
- observation: inspect inventory, entities, visible blocks, recipes, and terrain
- resources: collect blocks, pick up drops, equip appropriate tools
- production: craft, smelt, use crafting tables, furnaces, and chests
- survival: eat, equip armor, defend, retreat, sleep, and recover after death
- farming: harvest, till, sow, and collect crops with explicit crop policy
- construction: place/break blocks and execute bounded blueprints

Solid blocks continue to use Mineflayer collection plugins where appropriate.
Plants and other empty-collision blocks use the established Mindcraft pattern:
approach, interact or dig according to block mechanics, then pick up and verify
drops. Ordinary sugar-cane collection removes the whole nearby plant. A
root-preserving harvest is a separate explicit farming action.

User phrases such as "nearby sugar cane" do not invent a quantity. They select
the matching blocks in the currently observed local patch, subject only to an
internal safety cap. Explicit quantities remain exact goals and are verified by
inventory/world deltas rather than attempted-block counts.

### 4. Planning and autonomy

The cognition coordinator owns one active Minecraft goal and a bounded queue of
user updates. A planner turn receives:

- the user's goal and later corrections
- the latest environment snapshot
- current inventory and equipment
- the current plan and completed steps
- the last structured action result
- relevant session/world memory
- the available high-level action schemas

The planner returns one structured decision:

```ts
type MinecraftPlannerDecision =
  | { kind: 'act'; action: MinecraftActionInstruction; rationale: string }
  | { kind: 'complete'; result: string }
  | { kind: 'ask-user'; question: string; reason: string }
  | { kind: 'wait'; condition: MinecraftWaitCondition }
  | { kind: 'revise-plan'; plan: MinecraftPlanStep[] }
```

The coordinator executes one decision, obtains fresh observations, verifies the
result, and replans. It never asks the LLM to predict whether an action worked.

Planner turns are event-driven. They occur when:

- the user starts or changes a goal
- an action completes, partially completes, or fails
- a reflex cannot resolve a hazard or resource need
- the environment invalidates the current plan
- a wait condition becomes true
- an idle-autonomy interval allows a new exploration decision

They do not occur on raw game ticks. Rate limits, action budgets, repeated-error
guards, and cancellation tokens prevent runaway model or movement loops.

The default planner uses typed action calls. AIRI's isolated JavaScript planner
is adapted later for tasks that genuinely need dynamic composition. Generated
code receives only a read-only query DSL and the action registry; it has no Node,
filesystem, network, process, Electron, or credential access.

## Conversation Integration

While Minecraft is connected, every normal Hiyori turn obtains a fresh compact
environment snapshot through an ephemeral context provider. This applies to
messages originating from Minecraft, desktop, Discord, WeChat, and Feishu.

The snapshot is appended as factual runtime context immediately before the LLM
request. It does not instruct the model to call a tool and does not persist in
the conversation. If snapshot retrieval fails or is stale, the context says so
instead of retaining old coordinates.

The public `minecraft_companion` tool becomes a high-level control surface:

- connect or disconnect the body
- start or update a natural-language goal
- report current goal and environment status
- stop the current goal while remaining connected
- explicitly say a message in Minecraft when needed

Low-level actions stay inside the Minecraft planner and are not added to
Hiyori's ordinary tool list. This keeps the main prompt small and prevents the
main chat loop from micromanaging each movement.

Significant state transitions wake Hiyori once through the existing route:

- first arrival near the followed player
- unresolved blocked or target-lost episode
- need for user choice or unavailable critical resource
- goal completion, cancellation, or terminal failure

Wake-up payloads contain facts and destination routing only. Hiyori decides how
to phrase them, allowing playful responses without hard-coded personality text.

## Follow Semantics

Follow state exposes factual phases:

- `approaching`: target visible and outside follow range
- `nearby`: within follow range
- `recovering`: reflex is attempting a route correction
- `blocked`: evidence threshold reached and automatic recovery failed
- `target-lost`: target entity is unavailable

Starting follow returns the current distance and phase. It never claims Hiyori
is already nearby merely because a dynamic goal was installed. The runtime
tracks the player by username and rebinds `GoalFollow` when the entity object is
replaced after respawn, dimension change, or chunk reload.

Entering `nearby`, unresolved `blocked`, and `target-lost` emit one deduplicated
transition. Continuous distance updates remain in snapshots and do not create
chat messages.

## World and Task Memory

Three lifetimes remain separate:

- live snapshot: current facts, replaced every capture
- task memory: current goal, plan, action results, and failures; removed when the
  task is complete unless summarized
- world memory: named places, structures, resource sites, containers, death
  points, and explored frontiers

World memory is stored only after a stable world identity can be established.
Until then it remains session-scoped; LAN host/port alone is not a stable world
identifier. A future persistent store uses the application's SQLite database as
the single source of truth and must not introduce a competing config file.

## Migration

The implementation occurs on the current feature branch behind the existing
worker process, but it is a replacement rather than a permanent fallback:

1. Introduce shared event, snapshot, action, and planner contracts.
2. Replace `MinecraftBodyController` with the embodiment runtime while retaining
   current connect/chat/follow/collect behavior through the new contracts.
3. Add ephemeral context injection and factual follow transitions.
4. Port the first action families with provenance and tests.
5. Add the cognition coordinator and event-driven goal loop.
6. Add autonomous exploration and task verification.
7. Delete the old controller paths and old narrow collection protocol once
   parity tests pass.

There is no production switch between old and new implementations and no
long-lived compatibility adapter.

## Failure Handling

- Reflex failures become structured signals; they do not silently loop.
- Repeating the same recoverable action error is capped and forces replanning.
- Repeating the same plan/action pair without meaningful world change is
  rejected as a loop.
- User messages can update, pause, or cancel the active goal at any time.
- Connection loss cancels actions, preserves a concise task checkpoint, and
  notifies the originating route once.
- Planner/provider failure stops planning without stopping immediate survival
  reflexes.
- Worker crashes remain isolated from Electron and reject pending commands.

## Testing

Tests are divided by layer:

- perception tests translate bot fixtures into stable snapshots and normalized
  events without policy text
- reflex tests verify inhibition, deduplication, stuck evidence, recovery, and
  no LLM dependency
- action contract tests run deterministic fake-world scenarios and verify
  inventory/world deltas
- upstream-adaptation tests preserve behavior copied from AIRI/Mindcraft
- planner tests use a fake model to verify act/observe/replan/complete cycles,
  cancellation, budgets, and loop prevention
- context tests verify every connected Hiyori channel receives fresh ephemeral
  context without storing it in SQLite
- IPC tests verify correlation, event ordering, worker crash handling, and stale
  snapshot behavior
- integration tests verify one Hiyori persona, one conversation route, and no
  duplicate LLM turn for a single Minecraft message

Manual game scenarios cover following across distance and respawn, obstruction
recovery, whole-plant sugar-cane collection, tool preparation, iron acquisition,
death recovery, autonomous exploration, mid-task user conversation, and goal
cancellation.

## Acceptance Criteria

- Hiyori can truthfully describe its current Minecraft surroundings and body
  state on every conversation turn while connected.
- Hiyori can pursue a multi-step goal without keeping the user's chat turn open.
- The user can continue talking and can change or stop the goal during action.
- Immediate hazards are handled without waiting for or repeatedly invoking an
  LLM.
- Every action is followed by observed verification before the planner advances.
- Follow never claims proximity without measured distance and survives entity
  replacement after respawn.
- Autonomous exploration is bounded by explicit budgets and remains interruptible.
- Existing desktop/mobile chat, TTS, scheduling, coding-agent, and notification
  routes retain their behavior.
- Adapted upstream code is attributable, testable, and traceable to pinned
  revisions.
