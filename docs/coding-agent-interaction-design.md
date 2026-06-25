# Coding Agent Interaction Design

Hiyori treats Codex, Claude Code, and similar coding agents as managed background sessions, not as chat participants.

## User-Facing Flow

1. Hiyori receives a user request to use a coding agent.
2. Hiyori selects or asks for a project directory.
3. If the request depends on prior Codex context, Hiyori calls `coding_agent(action="sessions", cwd=...)` and resumes a matching session with `resume_session_id`.
4. Hiyori starts or continues the coding-agent session.
5. Runtime details are displayed in a terminal block.
6. When the coding agent completes, Hiyori receives only the final response as a wakeup payload, then decides how to summarize or relay it to the user.

## UI Boundary

Chat bubbles are for Hiyori and the user.

Terminal blocks are for coding-agent execution details:

- shell commands
- command output
- file changes
- reconnect messages
- runtime lifecycle markers

Coding-agent final responses must not be injected directly into chat bubbles. They wake Hiyori, and Hiyori speaks in its own voice.

## Codex Runtime Boundary

The Codex SDK is used through its thread model:

- `startThread()` for new conversations
- `resumeThread(id)` for persisted Codex threads in `~/.codex/sessions`
- `ThreadOptions` for `workingDirectory`, `model`, `modelReasoningEffort`, `approvalPolicy`, `sandboxMode`, and network access

The integration should not emulate the Codex desktop UI or control it through desktop automation.
