# Tool failure guardrail diagnostics

## Goal

Make repeated failed tool-call loops observable and stoppable with local guardrail diagnostics, without changing stable prompt or tool-schema surfaces.

## Context

- Parent task: `.trellis/tasks/05-29-mycli-hermes-agent-gap-analysis`
- mycli already has `TurnCheckpoint` loop/no-progress checks.
- Hermes has stronger tool guardrail and trajectory diagnostics.
- Current mycli guardrail messages are user-visible, but trace output does not explain guardrail triggers with structured evidence.

## Requirements

- Detect repeated failed tool results for the same tool/path/error signature in the current turn.
- Stop before the generic repeated-tool-call loop when repeated failures clearly indicate no progress.
- Record a local `guardrail` trace event when any checkpoint exits the turn.
- Include bounded diagnostic fields such as `exit_reason`, `stop_reason`, `trigger`, `count`, `tool_name`, `path`, and `error_kind` when available.
- Include the same diagnostic payload in the warning turn item metadata.
- Do not change stable system instructions, model-visible tool specs, tool order, or prior transcript messages.

## Acceptance Criteria

- `TurnCheckpoint` returns a repeated-tool-failure exit after the same failed tool result repeats at threshold.
- The repeated failure threshold is configurable and defaults below the generic repeated tool-call stop threshold.
- `TurnExecutor` appends a `guardrail` trace event for checkpoint exits.
- `/trace` renders guardrail trigger fields clearly.
- Tests cover checkpoint detection, runtime trace recording, and trace rendering.

## Out of Scope

- Prompt-visible self-correction instructions.
- Model/tool retry policy changes.
- External telemetry.
- Full trajectory export.
