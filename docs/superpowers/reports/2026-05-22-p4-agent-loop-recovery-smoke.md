# P4 Agent Loop Recovery Smoke

## Commands

- `uv run pytest tests/unit/application/test_turn_recovery_and_budget.py -q`
- `uv run pytest tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/test_openai_client.py tests/unit/infrastructure/test_anthropic_messages_client.py -q`
- `uv run ruff check src tests`
- `uv run mypy src/mycli`
- `uv run pytest -q`

## Results

- `tests/unit/application/test_turn_recovery_and_budget.py`: 14 passed.
- Provider taxonomy suites: 67 passed.
- Ruff: all checks passed.
- Mypy: success, no issues in 202 source files.
- Full pytest: 851 passed.

## Covered

- Provider failure taxonomy classifies rate limit, overload, auth, output limit, context window, and provider unavailable cases.
- Transient retry records backoff metadata.
- Explicit fallback model is attempted only after retry exhaustion and restores the primary model.
- Output token recovery uses configured limits and restores default max output tokens.
- Heartbeat progress events stay out of model-visible history.
- Interrupted turns use `StopReason.INTERRUPTED` and remain resumable.

## Not Covered

- No real provider rate-limit/auth smoke was intentionally triggered.
- No full async in-flight heartbeat timer; P4 heartbeat is loop-boundary only.
- No provider switching or OAuth refresh implementation.
