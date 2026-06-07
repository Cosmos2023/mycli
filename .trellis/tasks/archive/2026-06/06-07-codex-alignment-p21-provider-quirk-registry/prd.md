# P21 PRD: Provider Quirk Registry And Eval Matrix

## Goal

Centralize provider edge quirk metadata and add local/fake tests so DeepSeek, OpenAI-compatible, Responses proxy, and Anthropic-style behavior can be reasoned about without live provider calls.

## Scope

- Add provider quirk profile model and resolver.
- Add known quirk metadata for OpenAI, compatible, Anthropic, DeepSeek chat, and DeepSeek Anthropic-style base URL.
- Add doctor provider quirk diagnostics from resolved config.
- Add provider-free eval matrix helper and tests.
- Keep provider quirks out of canonical timeline.

## Non-goals

- No real provider API calls.
- No provider-specific compact engine.
- No canonical timeline mutation.
- No compact/rehydration implementation change.

## Acceptance

- Unit tests cover quirk resolution for OpenAI, compatible, Anthropic, DeepSeek chat, and DeepSeek Anthropic-style endpoint.
- Doctor quirk diagnostics are bounded and redact secrets.
- Provider-free eval matrix test covers expected quirk rows.
- `uv run ruff check src tests evaluation`, `uv run mypy src/mycli`, and `uv run pytest -q` pass.
- Compact/rehydration diff audit remains empty.
