# Node Gateway Trace Export RPC

## Problem

`/trace-jsonl` gives users and scripts a machine-readable trace export, but
Node/ACP/extension clients should not have to issue a human slash command and
strip `[trace-jsonl]` prefixes. The Node gateway needs a direct read-only RPC
for the same sanitized runtime trace rows.

## Goal

Add a `trace.export` JSON-RPC request to the Python Node TUI gateway.

## Scope

- Add `trace.export` handling in `src/mycli/cli/node_tui/gateway.py`.
- Reuse `TurnService.export_trace_jsonl()`.
- Return structured response fields suitable for external consumers.
- Update runtime gateway contract/spec docs.
- Add gateway tests.

## Requirements

- `trace.export` is read-only.
- Response includes:
  - `session_id`
  - `format: "jsonl"`
  - `rows`: array of JSON strings
- Optional `tail` parameter bounds recent rows.
- Non-positive/non-integer `tail` values use the gateway's existing bounded
  integer default behavior.
- The RPC returns unprefixed JSON rows; prefixes remain only for slash command
  output.

## Non-Goals

- No streaming subscription.
- No ACP server.
- No Node rendering changes.
- No new persistence location.
- No merge to `main`.

## Acceptance

- Gateway unit tests prove `trace.export` returns unprefixed JSONL rows and
  forwards `tail`.
- Gateway unit tests prove invalid `tail` falls back to the default.
- Existing trace JSONL tests remain green.
