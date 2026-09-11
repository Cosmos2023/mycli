## 1. Provider-Neutral Request And Configuration

- [x] 1.1 Add the canonical cache-retention type and replace new ProviderRequest cache/storage fields with `sessionId` and `cacheRetention`.
- [x] 1.2 Replace effective cache booleans with `request.cache_retention`, including environment, setting catalog, writer, schema, diagnostics, and reference documentation.
- [x] 1.3 Keep legacy durable request readers bounded while emitting only the new request vocabulary across runtime, Worker RPC, continuation, and storage projections.
- [x] 1.4 Remove provider storage controls from runtime and model-catalog declarations, serialization, selection, and setup output.

## 2. Pi-ai Compatibility Ownership

- [x] 2.1 Add bounded route/model `compat` declaration parsing and provider-layer API-specific validation.
- [x] 2.2 Carry validated immutable compat overrides through provider route snapshots and Worker RPC with model-over-route precedence.
- [x] 2.3 Merge compat overrides into catalog-cloned and declared pi-ai models while otherwise retaining pi-ai catalog metadata or automatic detection.
- [x] 2.4 Remove the effective mycli compatibility policy and compatibility facts that duplicate pi-ai wire behavior.

## 3. Provider Profiles And Model Metadata

- [x] 3.1 Reduce stable provider profiles to identity and defaults and remove profile-level protocol/cache/search/image capability tables.
- [x] 3.2 Source model modality and reasoning metadata from pi-ai catalog or explicit declarations, retaining hosted-search as a separate model/product capability.
- [x] 3.3 Update provider-directory and provider-scoped model payloads so they no longer publish duplicated wire-compatibility facts.

## 4. Pi-ai Request Projection

- [x] 4.1 Project ordered stable/developer instruction content into pi-ai `Context.systemPrompt` and remove marker-based role reconstruction.
- [x] 4.2 Pass cache retention, stable session id, reasoning, output cap, temperature, credentials, cancellation, and fetch/response hooks through pi-ai options.
- [x] 4.3 Use pi-ai model metadata for reasoning admission while preserving explicit `ultra` mapping and uncatalogued-model declarations.
- [x] 4.4 Reduce the payload hook to hosted Responses search insertion and remove cache, store, token, strict-tool, DeepSeek-thinking, and role rewrites.
- [x] 4.5 Preserve `maxRetries: 0`, runtime retry behavior, canonical replay, event/error normalization, and early-consumer cleanup.

## 5. Verification And Documentation

- [x] 5.1 Update config, model-catalog, provider-profile, and user-config tests for cache retention and removed legacy controls.
- [x] 5.2 Add provider tests for pi-ai-owned OpenAI/DeepSeek/Anthropic serialization, cache behavior, reasoning, and hosted-search-only payload adaptation.
- [x] 5.3 Add private-relay compat tests covering valid precedence, API-specific rejection, route snapshot immutability, and Worker round trips.
- [x] 5.4 Update runtime/storage tests for the new request vocabulary, legacy durable decoding, provider switching, and observable retries.
- [x] 5.5 Update provider/configuration documentation and the Trellis provider transport contract with the new ownership model and migration guidance.
- [x] 5.6 Run focused workspace tests, lint, typecheck, contract drift, full tests, and packed/provider smoke checks without contacting official provider endpoints.
