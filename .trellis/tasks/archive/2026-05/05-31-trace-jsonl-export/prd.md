# Trace JSONL Export For External Consumers

## Problem

mycli has useful runtime trace data under `.mycli/traces`, but the current
human-oriented `/trace` command renders compact text. Extension, ACP, MCP, and
future multi-agent consumers need a stable, machine-readable, read-only export
surface before a full external protocol/server is worth building.

## Goal

Expose sanitized runtime trace events as bounded JSONL from the existing
TurnService/REPL command layer.

## Scope

- Add a TraceService JSONL export API that reuses existing load/sanitization
  behavior.
- Add a TurnService method that returns JSONL rows for the current session.
- Add a slash command for read-only export.
- Add slash completion for the new command.
- Add tests for TraceService, TurnService, command routing, and completion.

## Requirements

- Export format is newline-delimited JSON.
- Each row is a sanitized runtime trace event with stable fields:
  `kind`, `turn_id`, and `payload`.
- Export is read-only and does not create, mutate, or delete runtime state.
- Export supports a bounded tail limit, defaulting to a small recent window.
- Full file contents and provider transcript content remain redacted by the
  existing TraceService sanitization.
- The command has a clear prefix so humans can distinguish JSON output from
  prose command output.

## Non-Goals

- No ACP server.
- No plugin manager.
- No streaming subscription.
- No schema migration.
- No merge to `main`.

## Acceptance

- Unit tests prove JSONL export round-trips valid trace events.
- Unit tests prove redacted payloads stay redacted in exported JSONL.
- Unit tests prove `/trace-jsonl` routes through the command handler.
- Unit tests prove slash completion lists `/trace-jsonl`.
- Relevant Python tests pass.
