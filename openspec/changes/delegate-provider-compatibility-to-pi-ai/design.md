## Context

The completed pi-ai transport and provider-directory changes retired direct provider SDK transports, but mycli still decides many wire details twice. `ProviderProfile` declares protocol/cache/search capabilities, `EffectivePiAiCompatibilityPolicy` derives another capability view, and `pi-ai-payload.ts` rewrites fields that pi-ai already derives from `Model.compat`. A session-scoped switch from OpenAI to DeepSeek demonstrated the failure mode: a global prompt-cache flag survived the switch and mycli rejected the request before pi-ai could omit the unsupported field.

DeepSeek Harness provides the target integration shape. It constructs or reuses pi-ai providers, passes provider-neutral `SimpleStreamOptions`, lets pi-ai serialize wire parameters, exposes strict `Model.compat` overrides only for private gateways, and sets pi-ai `maxRetries: 0` because its agent recovery layer owns visible retries.

The implementation must preserve mycli's canonical request/event boundary, secret storage, runtime retry events, replay validation, provider-free configuration commands, and hosted Responses search. Pi-ai types remain private to `@mycli/providers`.

## Goals / Non-Goals

**Goals:**

- Establish one owner for provider wire compatibility: the pinned pi-ai model and adapter.
- Express caching as a provider-neutral retention preference bound to the stable mycli session id.
- Let private relays override pi-ai compatibility without adding another built-in provider table.
- Remove pre-transport cache/storage capability failures and provider-specific payload corrections.
- Preserve explicit failures for semantic requests that cannot be silently dropped.
- Preserve runtime-owned, observable retries and safe provider error normalization.

**Non-Goals:**

- Exposing pi-ai model, message, event, auth, or compat types outside `@mycli/providers`.
- Enabling pi-ai ambient credentials, OAuth, or hidden provider retries.
- Treating a cache preference as a cache-hit guarantee; the remote provider owns actual cache storage and hits.
- Synthesizing hosted-search lifecycle events that pi-ai 0.84.2 does not expose.
- Changing the canonical conversation, replay envelope, model selector workflow, or provider activation model beyond fields made obsolete by this ownership change.

## Decisions

### 1. Separate product intent from wire compatibility

The request path will carry provider-neutral intent:

```text
mycli config/session
  -> ProviderRequest(sessionId, cacheRetention, reasoningEffort, maxOutputTokens, webSearchMode)
  -> pi-ai Model + Model.compat + SimpleStreamOptions
  -> provider wire payload
```

Mycli continues to choose the route, model, reasoning effort, output cap, cache-retention preference, and hosted-search intent. Pi-ai chooses developer versus system role, reasoning field format, max-token field name, storage default, strict-tool behavior, cache-key/retention fields, cache-control placement, and session-affinity headers.

Keeping mycli's capability policy and merely synchronizing it with pi-ai was rejected because two authorities would still drift on dependency upgrades and private relay changes.

### 2. Replace cache booleans and explicit cache keys with one retention preference

Add the canonical `CacheRetention` values `none`, `short`, and `long`. `NodeRuntimeConfig` and `ProviderRequestConfig` carry `cacheRetention`; `ProviderRequestConfig` also carries the stable mycli `sessionId`. The provider passes both directly to pi-ai.

The user setting becomes `request.cache_retention`, defaulting to `short`. `prompt_cache_key_enabled` and `cache_control_enabled` are removed from the effective setting catalog and no longer generate request fields. Unknown/deprecated-key diagnostics may still identify old configuration, but no compatibility flag is allowed to reject a provider switch.

Historical model-input and worker payload readers accept the old request field names only where needed to read already durable data, normalize them into the new vocabulary, and never emit them again. Prompt-cache keys and provider-specific cache markers are not persisted as new request authority.

Preserving the two booleans as aliases was rejected because their combined meanings differ by provider and cannot map unambiguously to one cache policy.

### 3. Let pi-ai own storage defaults

Remove model-catalog and request-level `store` controls. Pi-ai already emits `store: false` for Responses and for compatible completion endpoints whose resolved compat supports that field. Mycli no longer injects, deletes, or rejects `store`.

Supporting `store: true` through `onPayload` was rejected because pi-ai exposes no first-class storage option and mycli has no product workflow that consumes provider-stored responses. A future product requirement must first define that workflow rather than retain a transport-only switch.

### 4. Apply optional private-relay compat overrides directly to pi-ai models

The v2 `~/.mycli/models.json` provider and model declarations may contain a `compat` object. Config parsing accepts only a bounded JSON object; `@mycli/providers` validates its exact keys and value types against the selected pi-ai API. Unknown keys, invalid values, and fields belonging to another API fail route resolution with a bounded configuration error.

Effective precedence is:

```text
pi-ai detection/catalog compat < route compat < model compat
```

The normalized route snapshot carries only validated immutable override DTOs across the worker boundary. Provider construction merges them into the cloned or declared pi-ai `Model.compat`; no mycli guard interprets the result after construction.

Importing pi-ai types into `@mycli/config` was rejected because it would leak transport dependency types across the package boundary. Maintaining built-in per-provider override records was rejected because catalog providers must use the pinned pi-ai metadata unchanged.

### 5. Reduce provider profiles to product defaults

Stable profiles retain route identity, display name, default protocol, default endpoint, and optional default model. Protocol support booleans, image/search capability booleans, and cache defaults are removed. The shared protocol parser validates only the three pi-ai-backed APIs; route/model resolution then determines serviceability from the pi-ai directory and explicit declarations.

Input modality and reasoning choices come from pi-ai catalog models or explicit model declarations. Hosted search remains a mycli semantic capability because pi-ai 0.84.2 has no first-class hosted-search option; stable Responses models and explicit model declarations can advertise it without creating a general wire-compatibility table.

### 6. Collapse request conversion onto pi-ai's context and option vocabulary

Canonical instructions, configured developer instructions, and developer context items are combined into `Context.systemPrompt` in deterministic authority order. Pi-ai then selects the supported system/developer wire role from the model's reasoning state and `compat.supportsDeveloperRole`. User, assistant, image, tool-call, tool-result, tool schema, and replay projection stay structured in `Context`.

`pi-ai-payload.ts` is reduced to hosted Responses search injection only. It no longer rewrites instruction roles, token limits, temperature, storage, cache fields, strict flags, or DeepSeek thinking parameters. Unexpected hosted-search tool payloads still fail closed.

Dynamic developer context becoming part of the provider system prompt was chosen over representing it as a user message, because an adapter limitation must not lower instruction authority. Keeping marker messages and reconstructing provider payloads was rejected because that retains a second protocol serializer.

### 7. Use pi-ai metadata for reasoning admission and serialization

Catalog model reasoning levels remain sourced from pi-ai. An explicit mycli reasoning effort is checked against the selected model metadata so an unsupported semantic request fails rather than being silently disabled. Mycli may clone the per-request model to represent its `ultra` product level as pi-ai `max` with an explicit `thinkingLevelMap.max = "ultra"`; pi-ai still owns the resulting provider field and format.

For explicitly declared uncatalogued models, their configured reasoning efforts define the model's reasoning metadata. Pi-ai detection plus optional compat overrides determine how that metadata reaches the wire.

### 8. Keep runtime retries and narrow adapters under mycli ownership

Every pi-ai call continues to set `maxRetries: 0`. Runtime owns request/stream budgets, backoff, partial-output reset, cancellation, diagnostics, and recovery events. Credentials remain request-scoped mycli secrets passed as pi-ai `apiKey`.

Mycli retains only adapters pi-ai cannot replace: canonical context and replay conversion, provider event/error normalization, safe fetch evidence, early-consumer cleanup, and hosted Responses search injection. Live hosted search on a non-Responses route and image input on a non-image model remain explicit semantic errors.

## Risks / Trade-offs

- [Risk] Combining developer context into one system prompt changes exact payload ordering. -> Mitigation: freeze deterministic context fixtures and verify authority remains system/developer rather than user.
- [Risk] A private relay depended on former guessed defaults. -> Mitigation: provide validated route/model `compat` overrides and test a custom OpenAI relay without contacting official endpoints.
- [Risk] Removing cache booleans surprises existing configuration. -> Mitigation: emit bounded deprecated/unknown diagnostics, document `request.cache_retention`, and ensure old keys cannot block startup or provider switching.
- [Risk] Pi-ai changes compatibility behavior in a later release. -> Mitigation: keep the dependency exactly pinned and run payload, directory, custom-relay, retry, and packed checks on upgrades.
- [Risk] Long retention is unsupported by a selected provider. -> Mitigation: pass the preference to pi-ai and let its compat mapping downgrade or omit unsupported wire fields; do not fail the request in mycli.
- [Risk] Hosted search remains an `onPayload` exception. -> Mitigation: isolate and test only native tool insertion, with removal tied to a pi-ai first-class hosted-tool option.

## Migration Plan

1. Introduce the provider-neutral cache type/setting and compat override parsing while retaining legacy durable readers.
2. Apply compat overrides during route/model snapshot construction and cover catalog, private-relay, and worker round trips.
3. Simplify pi-ai model/context/options construction, then reduce the payload hook to hosted search.
4. Remove obsolete profile, request, model-catalog, compatibility-policy, and setting fields plus their writers and projections.
5. Update user documentation and run config, provider, runtime, storage, gateway, type, lint, contract, and packed verification.

Rollback reverts the source change and uses existing canonical conversation/replay data. No database schema migration is required; legacy durable request readers remain additive.

## Open Questions

None. The user selected the DeepSeek Harness ownership model, including direct pi-ai compat overrides for private relays and runtime-owned retries.
