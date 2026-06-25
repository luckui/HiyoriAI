# Coding Agent Interaction Design

## Goal

Hiyori should let users work with Codex and future coding agents from normal chat without learning runtime/provider/session internals. This follows the OpenClaw model: Codex owns native execution, threads, compaction, and tool continuation; Hiyori owns user-visible routing, channel binding, approvals, transcript mirroring, and result delivery.

## User Experience

Users can say natural language requests:

- "Ask Codex to fix the build failure in this project."
- "Continue the Codex task."
- "What did Codex finish?"
- "Stop Codex."

Advanced users can use compact commands:

- `/codex start <task>`
- `/codex continue <message>`
- `/codex status`
- `/codex stop`
- `/codex sessions`

Users must not need to say `runtime_start`, `provider_id`, or `session_id` except in debug modes.

## Session Routing

Each Hiyori conversation or remote channel can bind one active coding-agent session. A new explicit Codex task creates or reuses a Codex session depending on the user wording:

- "ask Codex", "let Codex", "use Codex" starts a new session unless the user says continue.
- "continue", "status", "stop", "done?" routes to the active session.
- If there is no active session, Hiyori asks for enough context instead of guessing.

The router stores only Hiyori-side binding metadata. Codex remains the source of truth for native thread state.

## Result Delivery

Hiyori must not stop at "sent to Codex." It mirrors useful Codex events back to the user:

- session started
- assistant messages
- command/tool/file-change summaries
- approval requests
- failures
- final completion

Desktop and Discord can receive updates immediately when the channel supports outgoing messages. WeChat may need pending updates because clawbot may not be able to push proactively; in that case Hiyori stores updates and reports them on the user's next message.

## Tools

`runtime_*` tools are internal/debug controls. They stay in `agent-debug` and `developer`.

The user-facing entry point is a coding-agent tool:

- `coding_agent`: start, continue, status, stop, list sessions.

This tool uses the existing RuntimeHost and Codex provider. It hides provider/session terminology from the user-facing prompt.

## Prompt Contract

Agent and developer prompts must teach the model:

- Explicit Codex/coding-agent requests should call `coding_agent`.
- Do not use TTS, terminal, or generic runtime discovery for Codex delegation.
- Reply in user language with visible state and results.
- Keep `runtime_*` out of normal explanations.

## Initial Implementation Scope

This phase implements in-memory session binding for desktop chat and tool-loop use. Persistent database storage, Discord/WeChat proactive delivery, approval UI, and Claude Code provider are later phases, but the interfaces must not block them.
