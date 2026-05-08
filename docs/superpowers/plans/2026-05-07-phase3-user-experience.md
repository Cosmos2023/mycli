# Phase 3: User Experience — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** File history/undo, MCP client, streaming CLI, session resume/fork, plan mode. Features users directly see.

**Prerequisite:** Phase 2 complete (hooks system required for MCP, plan mode, undo)

**Tasks (5):**

### Task 3.1: File History & Undo
- Create: `src/mycli/services/file_history.py`
- Track edits before Write/Edit tools; v1 backup at `~/.mycli/file-history/{sessionId}/`
- Snapshot per turn; 3-layer change detection (stat → mtime → full compare)
- `rewind(message_id)` restores files; `/undo` CLI command
- See `docs/superpowers/specs/2026-05-07-mycli-implementation-plan.md` Section 3.1 for API

Status: implemented. Commit step not executed.

### Task 3.2: MCP Client
- Create: `src/mycli/services/mcp/client.py`, `tool_adapter.py`, `resource_adapter.py`
- JSON-RPC over stdio and HTTP; deferred tool loading (stub → full schema)
- Config: `.mycli/mcp_servers.toml`
- Reference: `docs/superpowers/plans/2026-04-27-mycli-mcp-host.md`

Status: implemented. Commit step not executed.

### Task 3.3: CLI Streaming
- Modify: `src/mycli/cli/rendering.py`
- Replace buffered output with `rich.live.Live` streaming
- Tool progress: `rich.status.Status` spinner + tool name
- Diff view: `rich.syntax.Syntax` + line numbers
- Syntax highlighting: `pygments`

Status: implemented with optional Rich support and stdlib fallback. Commit step not executed.

### Task 3.4: Session Resume & Fork
- Modify: `src/mycli/cli/main.py` — `/resume`, `/fork` commands
- Modify: `src/mycli/domain/conversation.py` — `parent_id`, `fork_point` fields
- See plan Section 3.4 for SQLite changes

Status: implemented. Commit step not executed.

### Task 3.5: Plan Mode
- Create: `src/mycli/services/planning/plan_mode.py`
- `EnterPlanMode` / `ExitPlanMode` as built-in tools (not runtime mode switch)
- Plan file: `docs/tasks/current.md` with `[x]`/`[~]`/`[ ]` checkboxes
- Crash recovery reads plan file as anchor

Status: implemented. Commit step not executed.
