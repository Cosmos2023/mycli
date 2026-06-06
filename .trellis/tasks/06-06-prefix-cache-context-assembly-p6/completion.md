# Prefix Cache Context Assembly P6 Completion

## Summary

Completed Provider Adapter / Replay Hardening P6. Responses, Chat
Completions, and Anthropic Messages now have stricter provider-private state
boundaries: Responses can replay same-issuer opaque reasoning/message state,
Chat adapters recursively strip unsupported provider fields, and Anthropic
ignores Responses-private reasoning while preserving Anthropic-native thinking
metadata and wire-only `cache_control`.

## Main Changes

- Added provider replay helpers for deterministic provider ids, Responses
  replay item filtering, and recursive provider-private field sanitization.
- Extended Responses input serialization to replay same-issuer
  `codex_reasoning_items` and `codex_message_items`.
- Filtered foreign issuer encrypted reasoning before Responses request
  serialization.
- Added deterministic fallback ids for replayed Responses items and Anthropic
  tool_use ids.
- Hardened OpenAI-compatible Chat message sanitization for nested
  Responses/Anthropic/private fields.
- Hardened Anthropic serialization so Responses-private reasoning state does
  not become Anthropic thinking blocks.
- Updated backend context-management spec with the P6 provider adapter replay
  hardening contract.

## Verification

- `uv run ruff check .`
- `uv run mypy src/mycli`
- `uv run pytest -q` (`1409 passed`)
- `uv run python evaluation/provider_cache_policy_smoke.py`
- `uv run python evaluation/context_smoke.py`
- `uv run python evaluation/subagent_smoke.py`
- `uv run python evaluation/mcp_smoke.py`
- `uv run python evaluation/plugin_runtime_smoke.py`
- `uv run python evaluation/hook_smoke.py`

## Remaining Scope

- P7a still owns compact cheap pruning and tail protection.
- P7b still owns canonical compact summary and rehydration lifecycle.
- P8 still owns recovery policy and productized observability.
