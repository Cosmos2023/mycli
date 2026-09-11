## Why

Mycli routes model traffic through pi-ai but still duplicates pi-ai's provider compatibility decisions in static profiles, request guards, and payload rewrites. That duplicate ownership already causes valid provider switches to fail before pi-ai sees the request, so provider protocol knowledge should have one authoritative owner.

## What Changes

- Make pi-ai model metadata and `Model.compat` authoritative for provider-specific roles, reasoning fields, token-limit fields, storage support, tool-schema behavior, prompt caching, cache markers, and session affinity.
- Reduce mycli provider profiles to product identity and defaults; remove their protocol capability, hosted-search, prompt-cache, and cache-control truth tables.
- Pass provider-neutral request intent to pi-ai through `SimpleStreamOptions`, including a stable session id, cache-retention preference, reasoning level, output cap, temperature, credentials, cancellation, and transport hooks.
- Add validated route- and model-level pi-ai `compat` overrides for explicitly configured private relays whose behavior cannot be inferred from a public provider id or endpoint.
- Remove mycli payload corrections for fields pi-ai owns, including prompt-cache keys, cache retention, output-token field selection, storage defaults, strict-tool flags, DeepSeek thinking parameters, and developer-role compatibility.
- Retain narrow adapters only for canonical instruction projection, replay restoration, telemetry/error evidence, and hosted Responses search that pi-ai 0.84.2 does not expose as a first-class option.
- Keep credentials, model selection, semantic capability admission, and observable whole-request retry policy under mycli ownership; continue setting pi-ai `maxRetries: 0`.
- **BREAKING**: replace the legacy `prompt_cache_key_enabled` and `cache_control_enabled` request settings with the provider-neutral `cache_retention = "none" | "short" | "long"` preference. Legacy keys no longer affect provider requests.

## Capabilities

### New Capabilities

- `pi-ai-provider-compatibility-delegation`: Defines ownership of provider-neutral request intent, pi-ai wire compatibility, custom-relay compat overrides, caching, reasoning, retries, and the remaining narrow adapter responsibilities.

### Modified Capabilities

None.

## Impact

- Core/runtime request configuration: replace explicit cache-key and cache-control fields with stable session identity and cache retention.
- Config: simplify provider profiles, add the cache-retention setting, and validate optional pi-ai compat overrides in model/provider declarations.
- Provider integration: remove the effective compatibility policy and provider-specific payload rewrites while retaining canonical context, replay, error normalization, and hosted-search injection.
- Provider/model directory: publish pi-ai catalog capabilities directly and apply explicit custom-relay compat overrides to constructed models.
- Tests/docs: update configuration, provider payload, directory, runtime request, retry, private-relay, and migration coverage without contacting official provider endpoints.
