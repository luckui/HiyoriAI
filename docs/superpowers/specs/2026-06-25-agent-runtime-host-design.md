# Agent Runtime Host Design

Date: 2026-06-25

## Purpose

Hiyori should support seamless use of production coding agents such as Codex and Claude Code from both desktop chat and remote channels. This should not be implemented as another large embedded feature inside the current tool/manual/skill system.

The design goal is to move Hiyori toward a mainstream agent shell architecture:

- Hiyori owns the user-facing shell, Live2D companion experience, channels, transcript mirror, notifications, and lightweight local agent behavior.
- External coding agents own their native sessions, execution state, compaction, resume, tool continuation, and provider-specific control protocol.
- Skills describe behavior and workflow policy, but do not implement transport or runtime integration.
- Tools remain local atomic capabilities, not long-lived external agent session abstractions.

This design follows the pattern used by OpenClaw-style systems: channel and shell orchestration are separated from external agent runtimes and harnesses.

## Current Findings

Hiyori already has useful building blocks:

- Desktop chat and remote messages converge through `sendChatMessage()`.
- Discord and WeChat adapters already label message origin and route responses.
- `run_command` and `process` can start and interact with background processes.
- The app has SQLite persistence, task events, renderer push events, and message injection.
- The app has a local skill directory and legacy manual system.

The current architecture also has risks:

- `manual`, Markdown skills, and multi-step tools are overlapping concepts.
- `toolsets.ts` is already carrying mode, capability, and historical design concerns.
- `terminalManager` is a generic command helper under `electron/tools/`, not a stable runtime/session service.
- Existing comments describe some old concepts as advantages even when they now increase complexity.
- The Bilibili streaming feature is embedded into the core app and is a warning against adding another domain subsystem without a clean boundary.

## External Reference Model

The target direction is closer to OpenClaw than to a single all-in-one local agent:

- OpenClaw treats Codex as a native harness that owns Codex sessions and threads, while OpenClaw owns channel UX, transcript mirroring, and routing.
- OpenClaw's ACP path treats Claude Code, Gemini CLI, OpenCode, and similar coding agents as external agent sessions.
- Codex provides official integration surfaces such as app-server, non-interactive execution, and hooks.
- Claude Code provides CLI and hook mechanisms for lifecycle events and notifications.

This implies Hiyori should not automate Codex or Claude Code through screen control as the primary design. Stable protocols and runtime adapters should be the main path.

Reference sources:

- OpenClaw Codex harness: https://docs.openclaw.ai/plugins/codex-harness
- OpenClaw ACP agents: https://docs.openclaw.ai/tools/acp-agents
- OpenClaw agent harness plugins: https://docs.openclaw.ai/plugins/sdk-agent-harness
- Codex app-server: https://developers.openai.com/codex/app-server
- Codex non-interactive mode: https://developers.openai.com/codex/noninteractive
- Codex hooks: https://developers.openai.com/codex/hooks
- Claude Code hooks: https://docs.anthropic.com/en/docs/claude-code/hooks

## Recommended Architecture

Add an independent `Agent Runtime Host` layer.

Proposed ownership:

```text
User Channels
  Desktop Chat
  Discord
  WeChat
        |
        v
Hiyori Shell
  Live2D UI
  persona
  channel-aware replies
  transcript mirror
  notification policy
        |
        v
Agent Runtime Host
  runtime registry
  session lifecycle
  event stream
  transcript mapping
  interrupt/approval routing
        |
        v
Runtime Providers
  Hiyori native lightweight agent
  Codex provider
  Claude Code provider
  ACP provider
```

This is a new architectural layer, not a new toolset category. Tools may expose controlled commands to the local Hiyori agent, but the Runtime Host itself should be service code with explicit session models and events.

## Core Concepts

### Channel

A channel is a user communication endpoint:

- desktop chat
- Discord
- WeChat
- future Telegram or web UI

Channels have capabilities. For example, Discord can usually send proactive messages. WeChat through clawbot or iLink may have proactive-send limits, so it may only support response-window delivery or delayed status on the next inbound message.

Channel limitations must stay in the channel layer. They must not leak into Codex or Claude Code provider logic.

### Shell

The shell is Hiyori's user-facing experience:

- Live2D presence
- chat UI
- persona
- TTS and hearing
- transcript display
- user-visible status
- lightweight intent routing

The shell decides whether a request should go to Hiyori's native agent or an external runtime.

### Runtime

A runtime is a long-lived or resumable agent execution environment. It can accept user input and produce events.

Examples:

- Hiyori native agent
- Codex
- Claude Code
- ACP-compatible external agent

The runtime owns execution state. Hiyori mirrors and routes, but should not duplicate the runtime's internal session state.

### Provider

A provider is the implementation for one runtime type.

Provider responsibilities:

- check availability
- start or resume a session
- send user input
- expose status and transcript events
- interrupt or stop a session
- normalize provider-specific output into Hiyori runtime events

Provider code belongs under a dedicated runtime area, not under `electron/tools/impl`.

### Transcript Mirror

Hiyori stores a mirror of the external agent conversation for UX continuity, search, and remote channel delivery. The mirror is not the source of truth for Codex or Claude Code execution state.

Mirror entries should include:

- Hiyori conversation id
- runtime session id
- provider id
- event type
- normalized content
- raw provider metadata when useful
- channel delivery state

## Proposed Module Layout

```text
electron/
  runtimes/
    types.ts
    runtimeHost.ts
    runtimeRegistry.ts
    transcriptMirror.ts
    notificationPolicy.ts
    providers/
      hiyoriNative.ts
      codex.ts
      claudeCode.ts
      acp.ts
  channels/
    types.ts
    channelRouter.ts
    deliveryPolicy.ts
```

`electron/bridges/` can remain initially, but its domain should be narrowed to adapter-level platform connectivity. Shared routing rules should move toward `channels/` over time.

## Runtime Interface

The first stable interface should be small:

```ts
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
```

Runtime events should be normalized:

- `session_started`
- `assistant_delta`
- `assistant_message`
- `tool_call`
- `tool_result`
- `approval_requested`
- `waiting_for_input`
- `notification`
- `completed`
- `failed`
- `interrupted`

The interface should be event-driven. Polling may exist internally for a provider, but the Runtime Host should expose events.

## Provider Strategy

### Codex Provider

Preferred order:

1. Codex app-server or official programmatic surface when available.
2. Codex CLI non-interactive execution for short one-shot tasks.
3. Codex CLI session support only if it can be controlled predictably.

The Codex provider should not use GUI automation or OCR in the first implementation.

### Claude Code Provider

Preferred order:

1. Claude Code CLI with structured output where available.
2. Claude Code hooks for lifecycle notifications and approval/waiting states.
3. Interactive CLI only if a proper PTY/session layer is introduced and tested.

The provider should treat hooks as runtime events, not as Hiyori skills.

### ACP Provider

ACP support should be a future-compatible provider, not an immediate blocker. The Runtime Host interface should be shaped so an ACP provider can map sessions and events cleanly later.

### Hiyori Native Provider

The existing Hiyori LLM tool loop should eventually be represented as a runtime provider too. This makes the system model consistent:

- chat with Hiyori native agent
- chat with Codex
- chat with Claude Code
- hand off between runtimes

This migration can be incremental. The first design step does not require rewriting `sendChatMessage()`.

## Routing Behavior

The shell should support explicit and inferred routing.

Explicit routing examples:

- "Ask Codex to fix this bug in the current project."
- "Continue the previous session with Claude Code."
- "Send this error to Codex and ask it to investigate."

Inferred routing examples:

- coding tasks in a repository may suggest Codex or Claude Code
- lightweight local file lookup may stay in Hiyori native agent
- conversational or companion tasks stay in Hiyori native agent

Routing should remain user-visible. If Hiyori delegates to Codex, the UI and remote reply should say which runtime is handling it.

## Desktop UX

Desktop chat should feel seamless:

- user can start an external coding session from normal chat
- Hiyori shows the active runtime and session state
- external agent output appears in the chat transcript
- approval requests are surfaced as normal chat prompts
- user can interrupt or continue the runtime from Hiyori
- Hiyori can summarize long output without hiding critical results

The first UI can be text-first. A polished session panel can come later.

## Remote UX

Remote channels should use the same Runtime Host.

Discord:

- can receive external runtime updates proactively
- should chunk long messages
- should include session id or short active-session label when useful

WeChat:

- if proactive sending is limited, deliver within the current response window when possible
- otherwise store pending runtime events and mention them when the user next sends a message
- do not make the runtime provider aware of WeChat limitations

Both channels should support:

- start session
- continue active session
- ask status
- interrupt session
- receive completion summary

## Persistence

Add dedicated persistence instead of overloading `tasks`.

Suggested tables:

- `runtime_sessions`
- `runtime_events`
- `runtime_channel_deliveries`

`runtime_sessions` fields:

- id
- provider_id
- hiyori_conversation_id
- provider_session_ref
- cwd
- title
- status
- created_at
- updated_at
- metadata_json

`runtime_events` fields:

- id
- runtime_session_id
- type
- content
- raw_json
- created_at

`runtime_channel_deliveries` fields:

- id
- runtime_event_id
- channel
- target
- status
- attempted_at
- error

This keeps runtime sessions separate from background tasks. A runtime session may create tasks later, but it is not itself a generic background task.

## Relationship To Existing Systems

### Tools

Do not add many runtime-specific tools to `toolsets.ts`.

If Hiyori native agent needs controlled access, expose a small stable tool surface:

- `runtime_start`
- `runtime_send`
- `runtime_status`
- `runtime_interrupt`
- `runtime_list`

These tools call the Runtime Host. They do not implement provider logic.

### Skills

Skills should guide behavior:

- when to delegate to Codex or Claude Code
- how to summarize external agent output
- how to ask for confirmation
- how to handle remote channel constraints

Skills should not start processes or parse provider protocol directly.

### Manual

Do not add new manual dependencies for this feature. If documentation is needed for the agent, write it as a skill. Existing manuals can remain until a separate migration plan.

### Terminal Manager

Do not expose `terminalManager` as the runtime abstraction.

It may be reused internally by a provider only for simple process spawning. If interactive CLI support becomes necessary, introduce a proper session backend with PTY semantics and event streaming instead of stretching the current helper.

### Streaming

Do not follow the embedded streaming precedent. Runtime Host should be a boundary that future domain-specific systems can also use or stay outside of.

## Non-Goals

The first design does not include:

- GUI/OCR control of Codex or Claude Code
- full ACP implementation
- replacing the existing Hiyori agent loop immediately
- migrating all manuals to skills
- redesigning Bilibili streaming
- adding a complete visual session dashboard
- making WeChat behave like a fully proactive push channel if the platform does not allow it

These are excluded to keep the runtime boundary clean.

## Migration Plan

### Phase 1: Runtime Host Skeleton

- Add runtime types, registry, host, event model, and persistence.
- Add Hiyori native provider adapter around the existing chat loop only where practical.
- Add provider availability checks.
- Add no Codex behavior until the host model is verified.

### Phase 2: Codex Provider

- Implement Codex provider using official programmatic or CLI surface.
- Support start, send, event mirror, status, interrupt where the official surface permits.
- Store provider session references for resume.
- Surface events to desktop chat first.

### Phase 3: Channel Delivery

- Route runtime events to Discord.
- Add WeChat pending-event behavior based on actual send constraints.
- Add user commands for status, continue, interrupt, and switch active runtime session.

### Phase 4: Claude Code Provider

- Add Claude Code provider with CLI and hooks.
- Normalize hook events into Runtime Host events.
- Keep provider-specific config isolated.

### Phase 5: ACP Compatibility

- Add ACP provider or ACP-shaped adapter if it becomes useful.
- Revisit runtime interface against actual ACP needs.

### Phase 6: Cleanup

- Move shared channel routing out of individual bridge adapters.
- Reduce toolset exposure for runtime control.
- Document manual-to-skill migration separately.

## Testing Strategy

Unit tests:

- runtime registry behavior
- session lifecycle transitions
- event normalization
- transcript persistence
- channel delivery policy

Integration tests:

- fake provider that emits deterministic events
- desktop chat starts a fake runtime session
- runtime completion is mirrored into chat
- Discord delivery chunking
- WeChat pending-event behavior

Provider smoke tests:

- Codex availability check
- Codex one-shot task in a temporary repo
- Codex session resume if supported by selected surface
- Claude Code hook event ingestion with a fake hook payload

Manual verification:

- desktop user starts Codex from Hiyori
- mobile user starts Codex through Discord
- mobile user asks for status
- user interrupts a running session
- external runtime asks for confirmation and Hiyori routes it back

## Risks And Controls

Risk: Runtime Host becomes another large embedded subsystem.

Control: Keep provider implementations isolated and expose only normalized events to the rest of the app.

Risk: Tools become crowded with runtime-specific commands.

Control: Keep a small generic runtime tool surface. Provider-specific operations stay inside providers.

Risk: WeChat limitations contaminate runtime logic.

Control: Put send limits in channel delivery policy only.

Risk: Interactive CLI behavior is unreliable.

Control: Avoid interactive CLI as a first-class path unless a PTY backend is introduced and tested.

Risk: Hiyori duplicates Codex or Claude Code state.

Control: Store only transcript mirror and provider session references. Provider remains source of truth.

## Approval Checkpoint

This design should be reviewed before implementation planning. If approved, the next step is a separate implementation plan that starts with Runtime Host skeleton and fake-provider tests before any real Codex integration.
