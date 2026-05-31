# Node TUI Gateway Request Error Events

## Background

The runtime/TUI contract now has typed turn lifecycle, status updates,
tool lifecycle, clarification, and runtime event envelopes. Turn worker
failures already emit `turn.failed`, `turn.status`, and `status.update`.

Request-level gateway failures are less consistent. Known validation failures
return JSON-RPC errors, but unexpected exceptions in request handlers can
escape `NodeTuiGateway.handle_request`. In the full gateway loop this can break
the process instead of returning an actionable JSON-RPC error and visible TUI
diagnostic.

## Goals

- Convert unexpected exceptions from `NodeTuiGateway.handle_request` into a
  JSON-RPC `internal_error` response.
- Emit a bounded `gateway.error` notification for unexpected request handler
  failures when an emitter is configured.
- Mirror `gateway.error` through `runtime.event` like other gateway events.
- Teach the Node TUI reducer to render `gateway.error` as an error transcript
  row.
- Preserve existing behavior for `_GatewayError`, `ValueError`, unknown
  methods, and turn worker failures.

## Non-Goals

- Do not change model-turn worker `turn.failed` semantics.
- Do not add logging or request dump files in this slice.
- Do not change the JSON-RPC protocol module shape beyond using existing
  `error_response` / notification machinery.
- Do not copy Hermes code.

## Acceptance Criteria

- A request handler that raises `RuntimeError("boom")` returns
  `{"code": "internal_error", "message": "Internal gateway error."}`.
- The same failure emits `gateway.error` with code `internal_error`, bounded
  message text, and the request method.
- `gateway.error` is mirrored as `runtime.event`.
- Node reducer appends an `error` transcript row for `gateway.error`.
- Existing `ValueError` validation still returns `invalid_params`.
- Existing turn worker failure tests still pass.

## Verification

- `uv run ruff check src/mycli/cli/node_tui tests/unit/cli/node_tui`
- `uv run mypy src/mycli/cli/node_tui tests/unit/cli/node_tui/test_gateway.py`
- `uv run pytest tests/unit/cli/node_tui/test_gateway.py`
- `npm --prefix tui/node run typecheck`
- `npm --prefix tui/node test`
- `git diff --check`
