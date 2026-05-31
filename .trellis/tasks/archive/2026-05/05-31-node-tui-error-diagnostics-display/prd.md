# Node TUI Error Diagnostics Display

## Background

The runtime/TUI contract now makes request-level and gateway-level failures
observable as `request.failed` and `gateway.error` transcript rows. The reducer
preserves useful metadata such as `source`, `method`, and `code`, but the
current TUI rendering only prints the user-facing message. That makes failures
visible but still weak for real debugging because users cannot tell whether the
error came from a request rejection, gateway handler failure, or another local
warning source.

Hermes-like maturity favors compact, actionable diagnostics in the UI without
dumping raw payloads.

## Goals

- Render compact diagnostic metadata for `error` and `warning` transcript rows.
- Include stable fields when present: `source`, `method`, and `code`.
- Keep diagnostics bounded and visually secondary.
- Preserve existing system notice rendering for normal notices.
- Avoid exposing raw payloads, nested objects, or secret-like values.

## Non-Goals

- Do not add file logging in this slice.
- Do not change reducer metadata shape.
- Do not change gateway or JSON-RPC behavior.
- Do not introduce a new transcript item type.
- Do not copy Hermes code.

## Acceptance Criteria

- A request failure with metadata `{source, method, code}` renders both the
  message and a compact diagnostic line.
- A gateway error with `{method, code}` renders a compact diagnostic line.
- A normal `system_notice` does not render diagnostic metadata.
- Diagnostics are bounded and include only primitive string/number/boolean
  fields from the allowlist.
- Node typecheck and tests pass.

## Verification

- `npm --prefix tui/node run typecheck`
- `npm --prefix tui/node test`
- `git diff --check`
