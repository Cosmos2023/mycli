# Runtime Smoke Report

## Scope

- Date: 2026-05-30
- Workspace: `/Users/cosmos/Desktop/mycli`
- Session id: `runtime-smoke-20260530213730`
- Command shape: `printf '<prompt>\n/quit\n' | uv run mycli --plain --session runtime-smoke-20260530213730`
- Prompt: minimal no-tool response request.

## Baseline Checks

```text
uv run mycli doctor
```

Result:

- OK: config, API key presence, sessions DB openability, FileHistory, Python
  TUI import, Node TUI source, node/npm, MCP config.
- WARNING: `~/.mycli/logs/errors.log` missing.
- Summary: `9 ok, 1 warning, 0 failed`.

```text
uv run pytest tests/unit/services/test_doctor_service.py \
  tests/unit/services/test_workspace_log_service.py \
  tests/unit/infrastructure/test_sqlite_session_store.py -q
```

Result: `25 passed`.

## Real Smoke Result

The real turn completed successfully through the configured DeepSeek
chat-completions path. The assistant returned `OK`.

Observed console evidence:

- Session status used `runtime-smoke-20260530213730`.
- Provider/model: `deepseek/chat_completions`, `deepseek-v4-flash`.
- Tool exposure was rendered.
- No tool call was made by the model.

## SQLite Session Evidence

Database: `~/.mycli/sessions.db`

Rows for `runtime-smoke-20260530213730`:

- `sessions`: 1
- `conversation_messages`: 2
- `turn_rollouts`: 1
- `history_items`: 2
- `session_state`: 4

The `conversation_messages` table has columns:

```text
session_id,message_index,payload_json
```

Observed message indexes:

- `0`
- `1`

## User-level Log Evidence

User-level runtime logs were written under `~/.mycli/logs`, not the workspace
compatibility `log/` directory.

Observed files:

- `~/.mycli/logs/agent.log`
- `~/.mycli/logs/model-events.jsonl`
- `~/.mycli/logs/model-raw/runtime-smoke-20260530213730/<turn>-request.json`

`agent.log` included session-tagged rows for:

- `turn_context_assembled`
- `instruction_contract_assembled`
- `request_shape_built`
- `model_request_started`
- `model_response_received`
- `cache_shape_diagnostic`

`model-events.jsonl` included redacted model event rows for:

- `model_request_started`
- `model_response_received`

## Raw Payload Evidence

Raw model payload directory:

```text
~/.mycli/logs/model-raw/runtime-smoke-20260530213730/
```

Observed one request JSON file. Top-level keys:

```text
body,method,url
```

Request body keys:

```text
extra_body,max_tokens,messages,model,reasoning_effort,stream,stream_options,temperature,tools
```

Message count: 3.

Secret scan result:

- No `sk-...`, `Bearer ...`, or `api_key` pattern found in the raw payload text.

## Trace Evidence

Trace file:

```text
~/.mycli/traces/runtime-smoke-20260530213730-trace.jsonl
```

Trace event counts:

- `turn_item`: 19
- `tool_exposure`: 1
- `instruction_contract`: 1
- `request_shape`: 1
- `cache_shape_diagnostic`: 1
- `turn_state`: 1

## Workspace-local Log Evidence

Workspace-local files existed before the smoke:

- `log/app.log`
- `log/error.log`
- `log/model-events.jsonl`

Their modification times did not change during the smoke. This supports the
current contract: real CLI runtime writes to `~/.mycli/logs`, while workspace
`log/` is legacy/compatibility/test output.

## Post-smoke Doctor

Original post-smoke doctor output reported:

- `9 ok`
- `1 warning`
- `0 failed`

The remaining warning is still:

```text
logs: logs missing: errors.log (/Users/cosmos/.mycli/logs)
```

Follow-up fix applied afterward: doctor now reports this no-error state as
healthy when `agent.log`, `model-events.jsonl`, and `model-raw/` exist.

## Findings

1. The core runtime smoke passed.
2. SQLite session persistence, user-level operational logs, model event logs,
   raw request payloads, and trace output all matched the expected layout.
3. Workspace-local `log/*` was not touched by the real CLI smoke.
4. Raw request payload redaction looked correct for the checked secret patterns.
5. `mycli doctor` originally warned when `errors.log` was missing even after a
   successful run with no warnings/errors. This was converted into an OK state
   because `errors.log` is warning/error-driven.

## Recommendation

No further runtime smoke follow-up is required from this finding. If future
doctor checks need stricter log semantics, keep doctor read-only and prefer
interpreting optional files over creating them.
