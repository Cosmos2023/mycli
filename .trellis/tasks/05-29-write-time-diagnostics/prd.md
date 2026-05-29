# Write-time diagnostics

## Goal

Add a cache-aware local diagnostics pass after successful structured file writes so mycli can surface Hermes-like write feedback without changing stable prompt or tool-schema surfaces.

## Context

- Parent task: `.trellis/tasks/05-29-mycli-hermes-agent-gap-analysis`
- Hermes has write-time diagnostics in newer releases.
- mycli already records tool execution traces, file-change metadata, and cache-shape diagnostics.
- The user explicitly cares about append-only transcript behavior and prefix-cache hit rate.

## Requirements

- Run diagnostics only after a successful structured filesystem write.
- Start with a small local diagnostics abstraction; reuse the existing lint result shape where practical.
- Do not run diagnostics for failed validation, failed tool execution, no-op writes with no retained file change, denied tools, or `Bash`.
- Diagnostics are best-effort. Diagnostic runner failures must not convert a successful write into a failed write.
- Store diagnostic output after execution in cache-volatile/local surfaces:
  - tool-result turn item metadata
  - `tool_execution` trace payload
  - tool result raw payload after the tool has already executed, if needed for downstream local formatting
- Do not change:
  - stable system instructions
  - model-visible tool specs
  - deterministic tool ordering
  - previous provider transcript messages
- Keep diagnostic payloads bounded.

## Acceptance Criteria

- A successful `Write`/write-like mutation can attach `write_diagnostics` metadata and trace count.
- Failed validation does not run diagnostics.
- No-op write does not run diagnostics.
- Diagnostic runner exceptions are captured as a diagnostic error and do not fail the write.
- Cache-sensitive stable surfaces are not modified by this feature.
- Tests cover the above behavior.

## Technical Plan

1. Add failing unit tests around `ToolExecutionService`.
2. Add an injectable write-diagnostics runner/service so tests stay deterministic and runtime wiring can remain local.
3. Trigger diagnostics from retained file changes after file-history finalization and before recording the tool outcome.
4. Attach diagnostics to the result payload and trace payload only after the write execution path.
5. Verify with focused tests, lint, type-check, and the full unit suite.

## Out of Scope

- Full LSP server integration.
- New dependencies.
- Prompt-visible proactive repair instructions.
- Bash filesystem mutation detection.
- Git-native checkpoints.
