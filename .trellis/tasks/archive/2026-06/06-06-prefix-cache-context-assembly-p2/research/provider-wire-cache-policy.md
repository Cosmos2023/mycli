# Provider Wire Cache Policy Research

## Local Chain Map

### Canonical request shape

- `RequestShapeBuilder.build()` creates ordered request fragments:
  `stable:*` first, then `replay:*`, then `intent:*` and `volatile:*`.
- `RequestShape.summary()` already exposes P1 diagnostics:
  `section_boundaries`, `cacheable_prefix_hash`,
  `estimated_cacheable_prefix_chars`, `provider_projection`, and
  `compact_policy`.
- `ProviderRuntimeItemShape` already has `metadata`, but
  `RequestShapePayloadFormatter.runtime_items()` currently drops that metadata
  when converting to `RuntimeItem`.
- `ModelMessage` already has metadata, and
  `RequestShapePayloadFormatter.legacy_messages()` preserves model metadata.

### Responses lane

- `OpenAIResponsesClient.create_response()` delegates payload construction to
  `ResponsesRequestBuilder.build()`.
- `ResponsesRequestBuilder.build()` currently accepts model, input, tools,
  reasoning, previous response id, and diagnostics-related options, but no
  `prompt_cache_key`.
- `ResponsesInputSerializer.serialize_items()` serializes runtime items and
  blocks into Responses input dicts and does not inspect item metadata.

### Chat Completions lane

- `OpenAIChatClient._chat_payload_body()` builds a payload body from
  `ModelMessage` values and passes the body through the provider adapter.
- `DefaultChatProviderAdapter.adapt_messages()` currently strips `metadata` but
  may pass arbitrary provider-private fields if they appear in a message dict.
  P2 should explicitly sanitize cache/thinking/private projection keys.

### Anthropic lane

- `AnthropicMessagesModelAdapter._serialize_items()` converts runtime items into
  a `system` value plus `messages[]`.
- `AnthropicMessagesClient._message_payload_body()` builds the Anthropic request
  body. Today `system` is a string or absent; P2 may need list-of-blocks support
  so system text can receive block-level `cache_control`.
- Anthropic cache hints must be applied to a serialized payload copy only. The
  canonical `RuntimeItem` and `RuntimeBlock` instances must remain unchanged.

## Provider Semantics

### OpenAI Responses / Chat Completions

- `prompt_cache_key` is a request-level routing/cache hint, not canonical
  conversation content.
- For mycli P2, the key should be deterministic from provider, model, protocol,
  system hash, tool schema hash, and cacheable prefix hash.
- The key should be bounded and safe to log by exposing only a hash and short
  preview in diagnostics.

### Anthropic Messages

- Prompt caching uses block-level `cache_control` with type `ephemeral`.
- Cache breakpoint order is provider-specific; Anthropic generally considers
  tools, system, then messages. P2 will apply breakpoints to the wire projection
  for system/static prefix and dynamic boundary content when those blocks exist.
- `cache_control` is not persisted and must not leak to OpenAI-compatible
  payloads.

## Design Direction

1. Add a provider request policy object near the runtime request-shape domain so
   it can be shared by diagnostics and adapters without creating provider-client
   dependencies.
2. Derive policy from `RequestShape` and include it in `RequestShape.summary()`.
3. Preserve policy metadata through `RequestShapePayloadFormatter`:
   - runtime item metadata for Responses/Anthropic adapters.
   - message metadata for Chat Completions.
4. Provider clients/adapters consume policy metadata and emit provider-specific
   request options or content-block hints.
5. Provider-private hints are stripped from message payloads before sending to
   Chat Completions providers.
6. Diagnostics remain bounded: booleans, counts, hashes, and short previews only.

## Test Plan

- Unit test policy generation stability across ephemeral-only changes.
- Unit test `RuntimeItem` metadata preservation.
- Unit test Responses request builder/client payload includes
  `prompt_cache_key`.
- Unit test Chat payload includes request-level `prompt_cache_key` and strips
  provider-private message fields.
- Unit test Anthropic serialization adds wire-only `cache_control` and does not
  mutate canonical runtime items.
- Unit test cache diagnostics and doctor report cache policy metadata.
- Add provider-free smoke that exercises all three lanes without external model
  calls.
