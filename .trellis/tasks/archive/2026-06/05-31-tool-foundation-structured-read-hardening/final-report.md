# Tool Foundation Structured Read Hardening

## Summary

This slice strengthens mycli's core local tool loop against Hermes-like parity
gaps without copying Hermes code. `Read` now exposes CSV/TSV data as
model-visible content, includes generic numeric profiles for structured data,
supports `offset`/`limit` for structured handlers, records snapshots from
structured reads, and returns a clear unchanged-duplicate hint for repeated
same-range reads. `Bash` reroutes common read/search/list shell commands with
actionable dedicated-tool arguments.

## Verification

- `uv run pytest tests/unit/test_read_csv.py tests/unit/tools/test_read_only_tools.py tests/unit/tools/test_run_shell.py -q`
  - 33 passed
- `uv run pytest tests/unit/tools -q`
  - 57 passed
- `uv run pytest tests/integration/test_turn_service.py -q`
  - 19 passed
- `uv run pytest tests/unit/services/test_workspace_log_service.py -q`
  - 12 passed
- `uv run ruff check ...`
  - passed
- `uv run mypy src/mycli/tools/read/csv_handler.py src/mycli/tools/read/__init__.py src/mycli/tools/bash.py src/mycli/services/context/tool_result_formatter.py`
  - passed
- `env HOME=/tmp/mycli-real-smoke-home uv run mycli --eval-scenario 03`
  - Model requests completed and all turns converged without `loop_detected`.
  - Checks improved from 3/8 to 4/8 in the second run.

## Remaining Risk

Scenario 03 still fails exact phrase and exact numeric-format checks:
`低营收`, `响应时长高`, `加班高`, and `435000`. The model's answer is
semantically correct, but it emits natural wording and comma-formatted
`435,000`. This is no longer a tool visibility or convergence failure; it needs
an eval/prompt/output-contract slice if deterministic wording is required.
