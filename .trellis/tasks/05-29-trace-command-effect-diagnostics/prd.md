# Trace Command Effect Diagnostics

## Goal

Make `/trace` more useful for runtime diagnosis by rendering local tool execution status, duration, and effect profile fields already stored in `tool_execution` trace payloads.

## Requirements

- Render `status`, `duration_ms`, `filesystem_effect`, and `process_effect` when present.
- Preserve existing `/trace` output compatibility for events that do not include these fields.
- Do not alter trace persistence format.
- Do not alter model-visible request shape, prompts, or tool schemas.

## Non-Goals

- No TUI dashboard work.
- No new trace event type.
- No provider-visible diagnostics.
- No shell filesystem-effect detection.

## Acceptance Criteria

- `/trace` shows concise status/duration/effect diagnostics for enriched `tool_execution` events.
- Existing trace rendering tests still pass.
- Full tests, lint, and type checks pass.
