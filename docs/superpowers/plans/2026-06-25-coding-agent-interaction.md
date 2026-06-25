# Coding Agent Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-facing coding-agent router so users can ask Codex to start, continue, stop, and report coding tasks without knowing runtime internals.

**Architecture:** Keep RuntimeHost as the low-level harness. Add a small in-memory coding-agent session service and a `coding_agent` tool that maps user actions to RuntimeHost calls. Update prompts and toolsets so natural language Codex requests route to this tool.

**Tech Stack:** TypeScript, Vitest, existing ToolDefinition and RuntimeHost APIs.

---

### Task 1: Coding Agent Session Service

**Files:**
- Create: `electron/codingAgents/sessionRouter.ts`
- Test: `electron/codingAgents/__tests__/sessionRouter.test.ts`

- [ ] Write failing tests for start, continue, status, stop, and missing active session behavior.
- [ ] Implement in-memory conversation binding over RuntimeHost.
- [ ] Run `npm test -- electron/codingAgents`.
- [ ] Commit `feat: add coding agent session router`.

### Task 2: User-Facing Tool

**Files:**
- Create: `electron/tools/impl/codingAgent.ts`
- Test: `electron/tools/impl/__tests__/codingAgentTool.test.ts`
- Modify: `electron/tools/index.ts`
- Modify: `electron/toolsets.ts`

- [ ] Write failing tests for `coding_agent` start/continue/status/stop.
- [ ] Implement the tool with user-facing action names and default `agent=codex`.
- [ ] Register it in `agent`, `agent-debug`, and `developer`; keep `runtime_*` debug-only.
- [ ] Run tool tests.
- [ ] Commit `feat: add coding agent user tool`.

### Task 3: Prompt Contract

**Files:**
- Modify: `electron/prompts/agent.ts`
- Modify: `electron/prompts/developer.ts`
- Test: `electron/prompts/__tests__/codingAgentPrompt.test.ts`

- [ ] Write tests asserting prompts mention `coding_agent`, Codex delegation, result delivery, and not exposing `runtime_*`.
- [ ] Add concise prompt rules for Codex/coding-agent natural language routing.
- [ ] Run prompt tests.
- [ ] Commit `feat: teach prompts coding agent routing`.

### Task 4: Verification

- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Confirm `runtime_*` remains absent from `agent` and present in `agent-debug`.
- [ ] Commit fixes if needed.
