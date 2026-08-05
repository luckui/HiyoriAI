# Minecraft Companion Phase 1 Design

## Goal

Add a persistent Minecraft companion runtime that lets Hiyori join a standard
Minecraft Java LAN world as an independent second player. Hiyori owns language,
persona, and user intent; the runtime owns connection state, real-time survival,
and deterministic game actions.

The verified baseline is HMCL launching Minecraft Java 1.11.2 and a Mineflayer
client joining the integrated LAN server with an offline bot identity. NetEase
launcher compatibility is explicitly outside this phase.

## Scope

Phase 1 supports:

- Discovering a Minecraft Java LAN room on the local machine/network.
- Connecting and disconnecting one bot named `Hiyori`.
- Reporting connection, position, health, food, current behavior, and nearby
  player state.
- Sending in-game chat.
- Following a named player.
- Stopping the current foreground behavior without disconnecting.
- Collecting a named block in a bounded radius and bounded quantity.
- Automatically eating available food when needed.
- Basic reactive defense against nearby hostile mobs without attacking players.
- Notifying the originating Hiyori conversation when a bounded collection
  command finishes or fails.

Phase 1 does not include a settings UI, building blueprints, image-to-block
construction, farming workflows, automatic game completion, public-server
automation, player-versus-player combat, or a NetEase protocol adapter.

## Architecture

### Runtime boundary

Mineflayer runs in a forked Node child process. The Electron main process never
imports or owns a live Mineflayer bot. A runtime crash, protocol error, or server
disconnect therefore cannot terminate the Electron main process.

The child process exposes a small typed command protocol over Node IPC:

- `discover`
- `connect`
- `disconnect`
- `status`
- `say`
- `follow`
- `collect`
- `stop`

It emits typed lifecycle, status, chat, progress, completion, and failure events.
Raw packet details and Mineflayer objects never cross the process boundary.

### Main-process manager

`MinecraftRuntimeManager` owns the child lifecycle, request correlation, command
timeouts, and the active foreground behavior. Only one Minecraft bot and one
foreground behavior exist at a time. Starting `follow` or `collect` replaces the
previous foreground behavior and reports that replacement in the tool result.

The manager records the conversation and reply target that started a bounded
collection command. Completion and failure use the existing agent wake-up route,
so desktop, Discord, WeChat claim flow, and Feishu retain their existing delivery
semantics. Following is continuous and does not generate completion wake-ups.

### Minecraft chat channel

Minecraft chat is a first-class Hiyori message channel at the same boundary as
Discord, WeChat, and Feishu. A player chat event enters the existing Hiyori
conversation with Minecraft source metadata and a compact current game-state
snapshot. Hiyori performs the normal single LLM turn; its final text is routed
back through Mineflayer chat and mirrored in the desktop conversation history.
There is no second Minecraft personality, prompt stack, or memory store.

When the room contains only the owner and Hiyori, all owner chat is accepted.
When another human player joins, ordinary messages are accepted only from the
bound owner; other players must explicitly mention Hiyori. This prevents every
public room message from creating an LLM turn while retaining natural two-player
conversation.

### Voice routing

Minecraft replies use Hiyori's existing TTS lifecycle and selected voice. Phase
1 plays speech through the computer's normal Hiyori audio output while also
sending the text to Minecraft. The Minecraft runtime never owns a TTS provider.

The channel boundary reserves an optional native Minecraft voice sink for a
future Simple Voice Chat adapter. That adapter will consume audio synthesized by
Hiyori and deliver it through the game's voice protocol; it will not introduce a
second TTS configuration or synthesis pipeline.

### Hiyori tool

Hiyori receives one high-level tool named `minecraft_companion`. It exposes only
the actions listed above and describes user-facing concepts such as room, player,
follow, and collection. It does not expose Mineflayer, pathfinder goals, packet
ids, child-process ids, or runtime-provider terminology.

Successful connection waits until the bot has spawned. Collection returns as
soon as the runtime has entered the requested collection state; Hiyori should
then reply to the user and stop the current turn. The final result arrives as a
completion event through wake-up instead of polling. `status` is for an explicit
user request, not a required workflow step.

## Connection Discovery

When `connect` has no explicit host and port, the runtime listens briefly for the
standard Minecraft Java LAN multicast announcement. A single room is selected
automatically. Multiple rooms are returned as choices and must not be selected on
the user's behalf. No room returns a clear instruction to open the single-player
world to LAN.

Explicit host and port remain available for local standalone servers. Phase 1
uses offline bot authentication and must not inspect, copy, persist, or log the
player's Microsoft access token.

## Deterministic Behaviors

### Follow

The runtime resolves the requested player by exact in-game name, follows at a
small configurable distance internal to the runtime, and continually replans as
the player moves. Losing sight of the player is reported in status but does not
cause repeated Hiyori wake-ups.

### Collection

The request contains a block name, quantity, and optional radius. The runtime
normalizes names through Minecraft registry data, rejects unknown blocks, caps
quantity at 64, and caps radius at 64 blocks. It locates reachable blocks,
collects no more than requested, and ends with a structured completed, partial,
cancelled, or failed result. It never performs unbounded exploration.

### Survival policy

Auto-eating and defense are runtime policies active only while connected.
Auto-eating uses food already present in inventory. If hunger is low and no food
is available, the runtime emits one deduplicated resource-shortage event for that
hunger episode. Hiyori may ask the owner to provide food. Automatically hunting,
harvesting crops, or taking food from containers requires a later explicit
foraging behavior and is not silently attempted in Phase 1. Defense reacts only
to nearby hostile mobs, never players or neutral entities. It yields back to the
foreground behavior after the immediate threat ends. Low health favors
disengagement over continued combat.

## Errors And Lifecycle

- Connection failures include the host, port, game version when known, and a
  concise reason suitable for Hiyori to explain.
- Unexpected disconnects clear the active behavior and wake the originating
  conversation once. There is no automatic reconnect loop in Phase 1.
- Collection emits exactly one terminal event: completed, partial, cancelled, or
  failed. The event includes requested and collected quantities and is routed to
  the channel that initiated the command.
- Low-food notifications are edge-triggered and deduplicated; they are not sent
  on every health or physics tick.
- `stop` is idempotent and leaves the bot connected.
- `disconnect` is idempotent and shuts down the child-owned bot cleanly.
- Application shutdown terminates the child process without delaying Electron
  shutdown.
- Logs redact authentication material and avoid raw protocol dumps by default.

## Dependencies

Use established PrismarineJS packages for game mechanics:

- `mineflayer`
- `mineflayer-pathfinder`
- `mineflayer-collectblock`
- `mineflayer-auto-eat`
- `mineflayer-pvp`

Dependency versions must support the verified Minecraft 1.11.2 environment. If a
plugin's current release does not, pin the newest compatible release rather than
reimplementing its domain logic.

## Testing

Automated tests cover:

- IPC request correlation, timeout, crash, and shutdown behavior with a fake
  child process.
- LAN discovery parsing and zero/one/multiple-room decisions.
- Tool schema, parameter bounds, state transitions, and user-facing results.
- Completion and disconnect wake-ups preserving the originating
  conversation.
- Minecraft chat routing, owner filtering after another human joins, desktop
  history mirroring, and use of the existing TTS output.
- Worker command dispatch using a fake Mineflayer adapter, including behavior
  replacement and idempotent stop/disconnect.

A manual smoke test uses the verified HMCL Java world:

1. Open a single-player world to LAN.
2. Ask Hiyori to join.
3. Verify the `Hiyori` player appears and can chat.
4. Verify follow and stop.
5. Request a small bounded block collection and verify one final wake-up.
6. Verify disconnect removes the player cleanly.

## Acceptance Criteria

- The Electron app remains responsive if Minecraft is absent, closes, or rejects
  the bot.
- A user can say natural-language equivalents of “join my world”, “follow me”,
  “collect ten oak logs”, “stop”, and “leave the world” without knowing a port or
  Mineflayer terminology.
- Long collection work does not keep the Hiyori tool loop polling and does not
  prevent new chat turns.
- No Microsoft or HMCL credential is read or stored.
- Existing coding-agent, scheduling, bridge, TTS, and terminal behavior remains
  unchanged.
