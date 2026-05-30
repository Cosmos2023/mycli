# Node TUI Tool Lifecycle Scripted Smoke

## Problem

Tool lifecycle events already have Python gateway unit tests and Node reducer
tests, but there is no real stdio smoke proving the Node scripted client can
consume `tool.start`, `tool.progress`, `tool.complete`, and `tool.failed`
notifications through the Python gateway in one turn. Hermes-like TUI parity
requires this path to be end-to-end reliable because tool activity is one of the
most important live runtime signals.

## Goal

Add a focused integration smoke that runs the real Node entrypoint through
`run_node_tui_gateway(...)` and verifies tool lifecycle notifications become
the expected reducer transcript state.

The smoke should cover:

1. A successful tool row moving from `tool.start` to `tool.progress` to
   `tool.complete` without duplicate rows.
2. A failed tool row from `tool.start` to `tool.failed`.
3. Final assistant text reconciliation still works after lifecycle events.
4. Final state dump contains bounded metadata needed for TUI diagnostics.

## Non-Goals

- Do not change production gateway event names or payload fields.
- Do not add new scripted-client command syntax unless needed for the smoke.
- Do not change model-visible transcript or stable request shape.
- Do not copy Hermes code; only match the semantic maturity of live tool
  activity reporting.

## Acceptance Criteria

- `tests/integration/test_node_tui_gateway.py` includes a real Node scripted
  client integration test where the fake service emits both successful and
  failed tool lifecycle streams.
- The test asserts the fake service received the user message.
- The dumped reducer state proves:
  - exactly one final row exists for the successful tool id,
  - the successful tool row has `status="done"`, duration, summary, and
    progress stage metadata,
  - exactly one final row exists for the failed tool id,
  - the failed tool row has `status="failed"` and bounded error metadata,
  - assistant final output is not duplicated.
- Existing scripted smoke behavior remains compatible.
- Targeted Python and Node checks pass, or missing dependency limitations are
  documented.

## Risks

- The reducer matches tool rows by `tool_id` first and `call_id` second; the
  fake service must emit stable ids to prove deduplication rather than creating
  accidental fallback rows.
- Fresh worktrees may lack `tui/node/node_modules`; Node verification may need
  the established temporary dependency-copy workaround, followed by deletion
  before commit.
