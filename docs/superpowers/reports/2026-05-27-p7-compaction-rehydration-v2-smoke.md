# P7 Compaction Rehydration V2 Smoke

## Scope

- Dedicated `compaction_rehydration` context replaces L4 file snapshots through `runtime_reminders`.
- Invoked skill snapshots persist and restore after L4.
- Chat Completions ordering preserves DeepSeek cache prefix through compacted replay.
- Output-token recovery no longer injects internal output-budget hints into model-visible runtime reminders.

## Verification

| Command | Result |
| --- | --- |
| `uv run pytest tests/unit/services/context/compaction/test_rehydration.py tests/unit/test_l4_rehydration.py tests/unit/services/test_request_shape_builder.py tests/unit/services/test_turn_context_assembler.py tests/unit/services/test_instruction_contract_assembler.py tests/unit/services/test_session_service.py tests/unit/application/test_tool_execution_service.py -q` | PASS |
| `uv run pytest tests/unit/application/test_turn_recovery_and_budget.py::test_turn_executor_output_token_limit_escalates_and_recovers tests/unit/services/context/compaction/test_rehydration.py tests/unit/test_l4_rehydration.py tests/unit/services/test_request_shape_builder.py tests/unit/services/test_turn_context_assembler.py tests/unit/services/test_instruction_contract_assembler.py tests/unit/services/test_session_service.py tests/unit/application/test_tool_execution_service.py -q` | PASS |
| `uv run ruff check src tests` | PASS |
| `uv run mypy src/mycli` | PASS |
| `uv run pytest -q` | PASS |
| `printf '请使用 Read 工具读取 pyproject.toml，然后用一句话回答项目名和 CLI 入口点。\n/usage\n/session\n/quit\n' \| HOME="$(mktemp -d)" uv run mycli --plain --session p7-real-smoke-20260527013304` | PASS |

## Notes

- Existing sessions without invoked skill snapshots resume normally and simply do not restore skill bodies until a skill is invoked again.
- `runtime_reminders` no longer carries `[Compaction rehydration]` file snapshots.
- Real DeepSeek-backed `mycli --plain` smoke exited 0, called `Read` on `pyproject.toml`, streamed the answer, reported `/usage` for one turn, and `/session` reported no pending decision or suspended turn.
