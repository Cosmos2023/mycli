# Tool Execution Observability Standardization

## Goal

Make local tool execution telemetry easier to diagnose and compare across tools by standardizing trace payload fields and basic duration/status metadata, while preserving mycli's append-only and prefix-cache behavior.

## Requirements

- Record a consistent local trace payload for every executed tool call.
- Include at least:
  - `tool_name`
  - `tool_call_id`
  - `status`
  - `success`
  - `duration_ms`
  - `path`
  - `error_kind`
  - `summary`
  - stdout/stderr previews when present
- Keep trace and observability metadata local-only.
- Do not add this metadata to stable system instructions, model-visible tool schema, or deterministic tool order.
- Preserve existing activity events, turn items, conversation transcript behavior, and `/trace` UX compatibility.
- Use focused tests before implementation.

## Non-Goals

- No dashboard or TUI analytics screen.
- No provider-visible telemetry prompt.
- No new dependency.
- No schema migration for historical trace files.
- No Bash filesystem-effect tracking.

## Acceptance Criteria

- Tool trace payloads include standardized status and duration fields for success and failure.
- Duration is non-negative and deterministic enough for tests by injecting a clock.
- Error classification is preserved through `error_kind` when available.
- Request-shape stable hashes do not change because of local telemetry.
- Existing full test suite remains green.

## Cache Contract

This slice only writes local runtime trace/event metadata after tool execution. It must not alter `RequestShapeBuilder` stable fragments, model tool definitions, or tool ordering.
