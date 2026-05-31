# Trace Payload Redaction Gap

Date: 2026-05-31

Baseline: `feature/mycli-foundation-hardening-audit`

Hermes reference: semantic maturity only. Do not copy Hermes code.

## Current Capabilities

- `TraceService` writes runtime trace rows under `~/.mycli/traces`.
- Legacy trace reads still fall back to `~/.mycli/sessions`.
- `TraceService` rejects invalid/path-like session ids.
- Trace persistence sanitizes large content fields:
  - `raw_payload.content` becomes `content_chars` and `content_preview`
  - `transcript_content` becomes count and preview
  - `instruction_contract` is redacted wholesale
  - `current_user_request` becomes count and preview
- `export_jsonl()` returns sanitized rows for slash command and gateway clients.

## Gap

Trace sanitization is mostly size/content oriented, not secret oriented. Nested
payload fields such as `headers.Authorization`, `api_key`, `token`, `secret`,
and arbitrary strings containing bearer tokens can still be persisted and
exported if they arrive in trace payloads outside the already-special-cased
content fields.

That weakens the Diagnostics / Logs / Trace foundation because trace export is
explicitly intended for future external clients. Exported trace JSONL must stay
safe even when upstream tools or runtime diagnostics include provider-like
payloads.

## This Slice

Harden `TraceService` so every persisted/exported trace event redacts:

- sensitive-key string values
- bearer token text
- OpenAI-style `sk-...` keys
- token/secret/password/API-key assignment text
- nested list/dict payloads

Keep existing large-content preview/count behavior intact.

## Non-goals

- No trace schema migration.
- No trace repair command.
- No MCP/skills/subagent/ACP productization.
- No main merge.

## Verification

- `uv run pytest tests/unit/services/test_trace_service.py -q`
- `uv run pytest tests/unit/services/test_doctor_service.py tests/unit/services/test_trace_service.py -q`
- `uv run ruff check src/mycli/services/tracing/trace_service.py tests/unit/services/test_trace_service.py`
- `uv run mycli doctor`
