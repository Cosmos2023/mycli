# Runtime Gateway Failure Recovery Smoke

## Goal

Prove the Hermes-like runtime/TUI foundation can recover across multiple
terminal and waiting states in one real Node scripted client session.

## Requirements

- Run `run_node_tui_gateway(...)` with a real `NodeTuiProcess`.
- Use the real Node scripted client entrypoint.
- Use a deterministic fake service; do not call external model providers.
- Drive these states in one script:
  - terminal failed turn
  - approval waiting then rejection
  - clarification waiting then response
  - tool lifecycle with success and failure
  - interrupted terminal turn
- Verify the dumped Node state shows:
  - no pending approval or clarification left behind
  - terminal live status is `interrupted` after the final action
  - failed and rejected terminal states appear in transcript/status evidence
  - clarification recovery produces a final assistant answer
  - tool success and failure summaries survive later turns
  - no duplicate assistant final text from typed stream compatibility paths

## Non-Goals

- Do not implement MCP, skills, subagents, or ACP.
- Do not run a real provider.
- Do not replace focused unit tests.
- Do not merge into `main`.

## Acceptance Criteria

- New cross-process integration smoke fails before implementation if the
  runtime client cannot continue after a failed turn.
- Focused Python integration test passes.
- Related Node scripted-client/reducer tests pass.
- Relevant Python lint/type checks pass for touched files.
- Trellis task is archived and the slice is committed on the feature branch.
