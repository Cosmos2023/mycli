# Model Stream Diagnostics Sink

## Problem

`mycli` streams model output through `ModelTurnRequester`, but it does not
produce a structured per-stream diagnostic summary. A mature local agent
foundation needs enough model stream observability to distinguish slow first
token, sparse output, tool-call streams, normal completion, and malformed
provider events.

Hermes-agent is the maturity reference only. Do not copy Hermes code.

## Scope

Baseline branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main`.

This slice covers Diagnostics / Logs / Trace / Doctor parity by adding a
test-backed model stream diagnostics sink at the application runtime boundary.

## Requirements

- Add a typed diagnostics object for streaming requests.
- `ModelTurnRequester` accepts an optional diagnostics sink.
- The sink is called exactly once for each streaming request.
- Diagnostics include:
  - `success`
  - `elapsed_ms`
  - `ttfb_ms`
  - `provider_event_count`
  - `text_event_count`
  - `tool_call_event_count`
  - `completed_event_count`
  - `text_bytes`
  - optional `failure_kind`
  - optional bounded `failure_message`
- `ttfb_ms` is measured at the first provider event, not only first text delta.
- Diagnostics are emitted for malformed stream events and unsupported event
  types before the original `ModelResponseError` is raised.
- Diagnostics sink failures must not fail the model request.
- Non-streaming adapters do not emit stream diagnostics in this slice.
- Do not write trace/log files directly in this class.

## Acceptance Criteria

- Unit tests cover:
  - successful stream diagnostics with reasoning/text/tool/completed events
  - malformed stream event diagnostics
  - diagnostics sink failure isolation
  - non-streaming path does not emit diagnostics
- Focused tests pass:
  - `uv run pytest tests/unit/application/test_model_turn_requester.py -q`
  - `uv run ruff check src/mycli/application/runtime/model/model_turn_requester.py tests/unit/application/test_model_turn_requester.py`
- Trellis research, PRD, implementation context, check context, and check
  results are present.
- Task is archived after verification.

## Non-goals

- No provider SDK changes.
- No gateway/TUI rendering changes.
- No trace/log persistence wiring in this slice.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No merge to `main`.
