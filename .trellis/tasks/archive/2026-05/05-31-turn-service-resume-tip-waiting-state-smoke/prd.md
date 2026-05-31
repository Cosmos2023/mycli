# TurnService Resume Tip Waiting-State Smoke

## Problem

Session/resume hardening needs a real smoke proving that pending approval and
pending clarification state remain associated with the resolved lineage tip
after resuming from an ancestor session.

The lower-level pieces are tested separately, but the foundation goal calls for
real smoke coverage across resume/fork/waiting state.

## Scope

In scope:

- Add integration tests using real `TurnService` and `AgentRuntime.for_tests`.
- Cover pending approval on a forked tip resumed from root.
- Cover pending clarification on a forked tip resumed from root.
- Fix any state-binding bug found by those tests.

Out of scope:

- Changing UI behavior beyond existing gateway/reducer contract.
- Changing session lineage resolution semantics.
- Productizing MCP/skills/subagent/ACP.
- Real provider calls.

## Requirements

- Tests must use a shared `home_dir` so session state is persisted and recovered
  through SQLite.
- Tests must create a root conversation and fork to a branch/tip through the
  service layer.
- A fresh service configured with root must resume root and become active on the
  branch/tip.
- Approval resolution after resume must clear branch pending state and leave
  root pending state absent.
- Clarification resolution after resume must clear branch suspended state and
  leave root suspended state absent.

## Acceptance Criteria

- Focused integration tests fail before any required fix or prove existing
  behavior if already correct.
- `uv run pytest tests/integration/test_turn_service.py -q` passes.
- `uv run ruff check tests/integration/test_turn_service.py` passes.
- Trellis task is archived and committed.
