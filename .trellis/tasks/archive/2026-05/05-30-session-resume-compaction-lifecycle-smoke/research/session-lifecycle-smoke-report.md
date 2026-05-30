# Session Lifecycle Smoke Report

## Scope

- Date: 2026-05-30
- Workspace: `/Users/cosmos/Desktop/mycli`
- Final smoke root session: `lifecycle-root-20260530220353`
- Final smoke branch session: `lifecycle-branch-20260530220353`
- Final CLI transcript:
  `.trellis/tasks/05-30-session-resume-compaction-lifecycle-smoke/research/real-cli-smoke-20260530220353.out`

## Baseline Verification

```text
uv run mycli doctor
```

Result:

- Summary: `10 ok, 0 warning, 0 failed`

```text
uv run pytest tests/unit/infrastructure/test_sqlite_session_store.py \
  tests/unit/services/test_workspace_log_service.py \
  tests/unit/application/test_agent_runtime.py::test_turn_service_resume_switches_runtime_session_for_follow_up_turn \
  tests/unit/application/test_agent_runtime.py::test_turn_service_resume_ancestor_switches_runtime_session_to_resolved_tip \
  tests/unit/application/test_agent_runtime.py::test_turn_service_fork_switches_active_session_to_branch \
  tests/unit/application/test_agent_runtime.py::test_agent_runtime_rebind_session_updates_workspace_log_context \
  tests/unit/application/test_agent_runtime.py::test_agent_runtime_rebind_session_clears_stale_context_compaction_metrics \
  tests/integration/test_turn_service.py::test_turn_service_compresses_older_conversation_when_threshold_is_exceeded \
  tests/unit/test_l4_rehydration.py \
  tests/unit/test_compaction_transcript_validity.py -q
```

Initial result before the fix:

- `39 passed`

## Initial Real Smoke Finding

The first real CLI smoke used:

- Root: `lifecycle-root-20260530215834`
- Branch: `lifecycle-branch-20260530215834`
- Transcript:
  `.trellis/tasks/05-30-session-resume-compaction-lifecycle-smoke/research/real-cli-smoke-20260530215834.out`

The CLI reported a successful fork:

```text
[session] forked lifecycle-root-20260530215834 -> lifecycle-branch-20260530215834
[session] fork_point=2
```

But a follow-up turn on the branch cleared `conversation_trees.parent_id` and
`fork_point`. A later `/resume <root>` therefore resumed the stale root:

```text
[session] resumed lifecycle-root-20260530215834
```

SQLite evidence from that failed run:

```text
trees|lifecycle-branch-20260530215834||
trees|lifecycle-root-20260530215834||
```

## Root Cause

`SessionService.save_conversation()` always rewrote
`conversation_trees.parent_id` and `fork_point` from the incoming
`Conversation`. Runtime turns commonly load, compact, or rebuild a plain
conversation object that does not explicitly carry lineage metadata. Saving that
plain runtime object after a fork unintentionally erased the persisted lineage.

A second preservation point also mattered: compaction copies conversations via
`_copy_conversation()`, so that copy must carry `parent_id` and `fork_point`.

## Fix

- `src/mycli/services/session_service.py`
  - `save_conversation()` now preserves existing tree metadata when the incoming
    conversation has neither `parent_id` nor `fork_point`.
  - Explicit lineage from fork/rewind still writes through normally.
- `src/mycli/services/context/compaction/pipeline.py`
  - `_copy_conversation()` now copies `parent_id` and `fork_point`.
- `tests/unit/application/test_agent_runtime.py`
  - Added regression coverage for `fork -> follow-up turn -> resume root`
    preserving branch lineage.

## Final Real Smoke Result

Command shape:

```text
printf '<scripted root/fork/resume conversation>' | \
  uv run mycli --plain --session lifecycle-root-20260530220353
```

Important CLI observations:

```text
[session] forked lifecycle-root-20260530220353 -> lifecycle-branch-20260530220353
[session] fork_point=2
[session] resumed lifecycle-branch-20260530220353
[session] session=lifecycle-branch-20260530220353
```

Assistant responses:

- `ROOT_OK`
- `BRANCH_OK`
- `TIP_OK`

## SQLite Evidence

Database: `~/.mycli/sessions.db`

Final row counts and lineage:

```text
messages|lifecycle-branch-20260530220353|6
messages|lifecycle-root-20260530220353|2
trees|lifecycle-branch-20260530220353|lifecycle-root-20260530220353|2
trees|lifecycle-root-20260530220353||
history|lifecycle-branch-20260530220353|6
history|lifecycle-root-20260530220353|2
rollouts|lifecycle-branch-20260530220353|2
rollouts|lifecycle-root-20260530220353|1
state|lifecycle-branch-20260530220353|4
state|lifecycle-root-20260530220353|4
```

This proves the follow-up turn after `/resume <root>` was persisted under the
branch/tip session rather than the root.

## Log and Raw Payload Evidence

User-level operational logs were written under `~/.mycli/logs`.

Observed raw payloads:

```text
~/.mycli/logs/model-raw/lifecycle-root-20260530220353/...request.json
~/.mycli/logs/model-raw/lifecycle-branch-20260530220353/...turn_f1c2...request.json
~/.mycli/logs/model-raw/lifecycle-branch-20260530220353/...turn_0cc9...request.json
```

`agent.log` and `model-events.jsonl` contained session-tagged events for:

- root first turn
- branch turn after `/fork`
- branch/tip turn after `/resume <root>`

The searched evidence did not show `sk-...`, `Bearer ...`, or `api_key`
patterns in the inspected log/raw/trace paths.

## Trace Evidence

Preferred trace files existed:

```text
~/.mycli/traces/lifecycle-root-20260530220353-trace.jsonl
~/.mycli/traces/lifecycle-branch-20260530220353-trace.jsonl
```

File sizes from final smoke:

```text
lifecycle-root-20260530220353-trace.jsonl    13583 bytes
lifecycle-branch-20260530220353-trace.jsonl  22217 bytes
```

The larger branch trace aligns with two branch/tip turns.

## Final Verification

```text
uv run pytest tests/unit/infrastructure/test_sqlite_session_store.py \
  tests/unit/services/test_workspace_log_service.py \
  tests/unit/application/test_agent_runtime.py::test_turn_service_resume_switches_runtime_session_for_follow_up_turn \
  tests/unit/application/test_agent_runtime.py::test_turn_service_resume_ancestor_switches_runtime_session_to_resolved_tip \
  tests/unit/application/test_agent_runtime.py::test_turn_service_fork_switches_active_session_to_branch \
  tests/unit/application/test_agent_runtime.py::test_turn_service_fork_keeps_lineage_after_follow_up_turn \
  tests/unit/application/test_agent_runtime.py::test_agent_runtime_rebind_session_updates_workspace_log_context \
  tests/unit/application/test_agent_runtime.py::test_agent_runtime_rebind_session_clears_stale_context_compaction_metrics \
  tests/integration/test_turn_service.py::test_turn_service_compresses_older_conversation_when_threshold_is_exceeded \
  tests/unit/test_l4_rehydration.py \
  tests/unit/test_compaction_transcript_validity.py -q
```

Result: `40 passed`.

```text
uv run ruff check src/mycli/services/session_service.py \
  src/mycli/services/context/compaction/pipeline.py \
  tests/unit/application/test_agent_runtime.py
```

Result: `All checks passed!`

```text
uv run mypy src/mycli/services/session_service.py \
  src/mycli/services/context/compaction/pipeline.py
```

Result: `Success: no issues found in 2 source files`.

## Finding

The real smoke found and fixed a session lineage bug that the prior isolated
tests did not catch: a forked branch's persisted tree metadata could be erased
by an ordinary follow-up turn, causing root-to-tip resume to regress to the
root. The final smoke now confirms root-to-tip resume, DB lineage, logs, raw
payload buckets, traces, and rollouts align on the active branch session.
