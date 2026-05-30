# Session Resume and Compaction Lifecycle Smoke

## Problem

Recent work hardened `mycli` session storage, logging, tracing, and runtime
diagnostics. Unit tests cover many individual pieces, but we still need a
realistic lifecycle smoke that proves the session identity remains coherent
across resume, fork/lineage, runtime logs, raw model payloads, traces, and
compaction-related evidence.

The key risk is not that a single table or file is missing. The risk is that
one layer silently keeps using an old session id after `/resume` or `/fork`,
causing follow-up turns, raw payloads, traces, logs, or rollouts to split across
different identities.

## Goals

- Run a real `mycli --plain` smoke that creates a root session, forks it, resumes
  through the root id, and sends a follow-up turn on the resolved tip.
- Verify SQLite rows for `sessions`, `conversation_messages`,
  `conversation_trees`, `history_items`, `turn_rollouts`, and `session_state`.
- Verify `/resume <root>` resolves to the forked descendant/tip, not the stale
  root.
- Verify user-level operational diagnostics stay under `~/.mycli/logs` and that
  raw payload buckets follow the active session after fork/resume.
- Verify preferred trace files stay under `~/.mycli/traces/<session>-trace.jsonl`
  and align with the active session.
- Verify compaction lifecycle behavior with targeted automated tests and
  persisted evidence, without forcing an expensive or flaky long-provider smoke
  unless the existing targeted coverage is insufficient.
- Write a concise evidence report under this task's `research/` directory.

## Non-goals

- Do not redesign session lineage, FTS search, handoff routing, or compaction.
- Do not add a Hermes-style separate state database or log layout.
- Do not inject logs, traces, raw payloads, or search results into
  provider-visible transcript replay.
- Do not perform destructive cleanup of existing `~/.mycli` data.

## Smoke Shape

Use unique session ids with a timestamp, for example:

- root: `lifecycle-root-<timestamp>`
- branch: `lifecycle-branch-<timestamp>`

Run a line-oriented real CLI sequence roughly shaped as:

```text
root prompt
/fork <root> <branch> <fork_point>
branch prompt
/resume <root>
/session
tip prompt
/quit
```

If forking immediately after one turn needs a concrete fork point, use the
observed root message count from `/session` or SQLite and record that choice in
the evidence report.

## Acceptance Criteria

- `uv run mycli doctor` passes without failed checks before or after the smoke.
- The real CLI smoke exits successfully.
- Root session has persisted conversation messages and at least one rollout.
- Branch session has `conversation_trees.parent_id = root` and a non-null
  `fork_point`.
- `/resume <root>` reports `resumed <branch>` when `<branch>` is the latest
  descendant.
- Follow-up messages after resume persist under the branch session, not the
  stale root session.
- `~/.mycli/logs/agent.log` contains session-tagged lifecycle lines for both the
  root and branch sessions.
- `~/.mycli/logs/model-raw/<branch>/` contains raw model payloads from the
  branch/resumed turns.
- `~/.mycli/traces/<branch>-trace.jsonl` exists and contains request/turn trace
  events from the branch/resumed turns.
- Raw payload and log evidence does not expose API keys or bearer tokens.
- Existing targeted tests for resume/fork lineage, log rebinding, SQLite store,
  and compaction pass.

## Evidence Artifact

Persist findings in:

```text
.trellis/tasks/05-30-session-resume-compaction-lifecycle-smoke/research/session-lifecycle-smoke-report.md
```

The report should include:

- Commands run.
- Session ids used.
- CLI observations.
- SQLite row counts and lineage rows.
- Log, raw payload, and trace paths inspected.
- Compaction evidence and test results.
- Findings and any follow-up recommendations.
