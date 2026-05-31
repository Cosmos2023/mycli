# Session State Recovery Hardening

## Problem

`mycli` already persists and resumes sessions, but the diagnostic layer does not
yet verify the storage invariants that make long-running resume/fork/waiting
state reliable. `mycli doctor` can report a session DB as healthy even when the
tables or lineage relationships required for recovery are missing or corrupt.

Hermes-agent is the maturity reference for durable local agent state. This task
does not copy Hermes code.

## Scope

Baseline branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main`.

This slice covers Session / State parity by hardening session DB diagnostics.
It is not an audit-only task: it must add executable, test-backed doctor
behavior.

## Requirements

- `mycli doctor` must keep session DB checks read-only.
- Missing `~/.mycli/sessions.db` remains a warning.
- A present DB that cannot be opened remains a failed check.
- Session DB layout validation must require the full recovery-critical table
  set:
  - `sessions`
  - `conversation_messages`
  - `conversation_trees`
  - `history_items`
  - `turn_rollouts`
  - `session_state`
  - `session_summaries`
- Foreign-key violations must fail the `sessions_db` check.
- Orphan rows in recovery-critical child tables must fail the check with bounded
  table/count detail.
- Conversation lineage cycles must fail the check with bounded session detail.
- Negative fork points or fork points beyond the child session message count
  must fail the check.
- Valid DBs created by existing test helpers must be updated to the full layout.
- Diagnostics should be actionable without printing raw session payload JSON.

## Acceptance Criteria

- Doctor tests cover:
  - valid full session DB layout
  - missing recovery-critical tables
  - orphan child rows
  - lineage cycle
  - invalid fork point
- Existing session service and SQLite store tests still pass.
- Lint passes for changed files.
- Trellis research, PRD, implementation context, check context, and check
  results are present.
- Task is archived after verification.

## Non-goals

- No automatic DB repair.
- No prune/vacuum implementation in this slice.
- No new session search product surface.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No merge to `main`.
