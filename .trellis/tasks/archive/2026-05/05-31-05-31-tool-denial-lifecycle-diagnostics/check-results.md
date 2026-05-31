# Check Results

## Commands

- `uv run pytest tests/unit/application/test_tool_execution_service.py -q`
- `uv run ruff check src/mycli/application/runtime/tools/tool_execution_service.py tests/unit/application/test_tool_execution_service.py`

## Result

- 25 tests passed.
- Ruff passed.

## Acceptance Evidence

- Denied pre-tool hook calls still do not execute the underlying tool.
- Denied calls emit lifecycle events:
  `tool_start -> tool_progress -> tool_failed`.
- Denied lifecycle metadata includes stable `tool_id`/`call_id`, bounded
  summary/error fields, and `success=false`.
- Denied calls append both `TOOL_CALL` and `TOOL_RESULT` turn items.
- Denied calls append a failed `tool_execution` trace row with
  `error_kind=tool_denied_by_hook`.
