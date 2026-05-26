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

## Notes

- Existing sessions without invoked skill snapshots resume normally and simply do not restore skill bodies until a skill is invoked again.
- `runtime_reminders` no longer carries `[Compaction rehydration]` file snapshots.
