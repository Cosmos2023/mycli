# Tool Lifecycle Long Output Diagnostics

## Problem

`mycli` emits Hermes-like tool lifecycle events, but long tool outputs are not
explicitly diagnosable. Summaries, errors, stdout, and stderr are previewed or
bounded, yet clients cannot tell whether they are seeing the complete text or a
truncated preview. A mature local agent foundation should make truncation and
original size machine-readable for TUI and future extension clients.

Hermes-agent is the maturity reference. This task does not copy Hermes code.

## Scope

Baseline branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main`.

This slice covers Tool / approval / safety foundation by adding long-output
diagnostic metadata to tool lifecycle and trace payloads.

## Requirements

- `tool.complete` and `tool.failed` metadata must include:
  - `summary_chars`
  - `summary_truncated`
  - `error_chars` when an error exists
  - `error_truncated` when an error exists
- Existing lifecycle `summary` and `error` fields remain bounded previews.
- `tool_execution` trace payload must include:
  - `stdout_chars`
  - `stdout_truncated`
  - `stderr_chars`
  - `stderr_truncated`
- Existing `stdout_preview` / `stderr_preview` remain bounded.
- Node reducer/transcript must preserve these metadata fields for TUI display
  or future diagnostics.
- Tests must prove long output is bounded and flagged, not silently dropped.

## Acceptance Criteria

- Python tool execution tests cover long summary/error lifecycle metadata.
- Python trace tests cover long stdout/stderr char counts and truncation flags.
- Node transcript/reducer tests cover preservation of truncation metadata.
- Python lint and Node tests/typecheck pass.
- Trellis research, PRD, implementation context, check context, and check
  results are present.
- Task is archived after verification.

## Non-goals

- No log/raw payload deep-link UX.
- No tool cancellation/interruption state machine.
- No approval policy changes.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No merge to `main`.
