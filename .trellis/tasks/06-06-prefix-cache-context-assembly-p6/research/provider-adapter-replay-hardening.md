# Provider Adapter Replay Hardening Research

## Current State

- P5 added canonical persistence metadata and baseline replay, but provider
  adapters still operate mostly on `RuntimeItem` wire projections.
- `ResponsesInputSerializer` serializes text/reasoning blocks as `input_text`
  and tool blocks as `function_call` / `function_call_output`. It does not yet
  replay provider-private `codex_reasoning_items` or `codex_message_items`.
- `ResponsesModelAdapter` already extracts request-level `prompt_cache_key`
  from runtime item metadata and records provider completions through
  `record_response_completion()`.
- `DefaultChatProviderAdapter.adapt_messages()` strips `metadata`,
  `cache_control`, `anthropic`, `responses`, `provider_request_policy`, and
  underscore-prefixed keys from Chat messages. This is a good base for P6 but
  needs explicit tests for P5 `provider_state` and Responses-private fields.
- `DeepSeekChatProviderAdapter` maps `developer` to `system`, merges adjacent
  system messages, and carries DeepSeek-specific `reasoning_content` only from
  `metadata.deepseek`.
- `AnthropicMessagesModelAdapter` folds `system` and `developer` runtime items
  into the Messages API `system` field. It applies `cache_control` only on
  serialized payload copies based on item metadata/policy breakpoints.
- `RequestShapeBuilder` already emits provider messages and runtime items in
  stable -> replay/dynamic -> current user/tail order, and P5 redacts raw
  `provider_state` to `provider_state_keys` in diagnostics.

## P6 Gaps

### Responses lane

- Needs an explicit projection path for same-issuer provider-private Responses
  state:
  - `codex_reasoning_items`
  - `codex_message_items`
- Foreign issuer encrypted reasoning must be filtered before provider request
  serialization.
- Responses item replay should preserve provider-supplied item shape only for
  same-shape/same-issuer states, without converting opaque encrypted reasoning
  into natural language content.

### Chat Completions lane

- Chat providers must never receive Responses or Anthropic private fields:
  - `reasoning.encrypted_content`
  - `codex_reasoning_items`
  - `codex_message_items`
  - `cache_control`
  - Anthropic `thinking` / signature metadata
  - underscore-prefixed internal fields
- Developer role fallback should remain explicit: OpenAI/Qwen-compatible lanes
  may preserve `developer`; DeepSeek maps to merged `system`.
- Deterministic fallback ids are needed when tool calls or provider output items
  lack stable ids.

### Anthropic lane

- Continue rendering canonical runtime items into `system + messages`.
- `cache_control` must remain wire-only and not mutate runtime items or
  canonical timeline state.
- Provider-private Responses fields must not appear in Anthropic content blocks.

## Implementation Notes

- Keep P6 focused on adapter projection and schema sanitization. Do not pull in
  compact/pruning/recovery behavior from P7/P8.
- Prefer extending existing serializers/adapters instead of adding a new
  provider gateway layer.
- Provider-private state should remain in `RuntimeItem.metadata` /
  `RuntimeBlock.metadata` until an adapter explicitly knows how to serialize or
  drop it.
- Full `prompt_cache_key` remains request metadata only; P6 should not move it
  into canonical items or provider messages.

## Risks

- Replaying foreign encrypted reasoning can trigger provider errors and must be
  filtered before request construction.
- Flattening opaque reasoning into text can leak provider-private state and
  corrupt Chat/Anthropic prompts.
- Over-hardening Chat sanitization could accidentally drop legitimate
  provider-specific metadata such as DeepSeek `reasoning_content`; keep
  provider-specific metadata behind the provider adapter.
