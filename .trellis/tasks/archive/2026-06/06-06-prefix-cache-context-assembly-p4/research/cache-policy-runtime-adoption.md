# Cache Policy Runtime Adoption Research

## Current P3 Baseline

- `ProviderCachePolicyCapability` exists in
  `mycli.domain.runtime.request_shape` and can disable request-level
  `prompt_cache_key` or Anthropic `cache_control`.
- `RequestShapeBuilder.build(...)` accepts an optional
  `cache_policy_capability`, but normal runtime paths do not resolve it from
  provider profile/config yet.
- `ProviderPayloadSnapshot` and `ProviderRequestDryRun` provide redacted
  provider-free diagnostics, but the primary user-facing proof is still
  `evaluation/provider_cache_policy_smoke.py`.
- `CacheShapeDiagnostics` already extracts cached token counts from common
  usage shapes:
  - direct `prompt_cache_hit_tokens`
  - `prompt_tokens_details.cached_tokens`
  - `input_tokens_details.cached_tokens`
- Doctor summarizes cache-shape rows, wire hint counts, changed cache classes,
  max/latest provider cached tokens, and bounded remediation.

## Relevant Data Flow

```text
AgentConfig / ProviderProfile
  -> RequestPipeline / RequestShapeBuilder
  -> RequestShape.provider_request_policy
  -> RequestShapePayloadFormatter
  -> Responses / Chat / Anthropic adapters
  -> CacheShapeDiagnostics
  -> Trace / Doctor / Dry-run surface
```

The P4 boundary is capability and diagnostics wiring. It should not change
canonical prompt semantics beyond using the already established
`ProviderCachePolicyCapability`.

## Implementation Candidates

### Provider capability location

`ProviderProfile` is the best long-lived source for provider defaults because
provider registry already centralizes default protocol/base URL and validation.
Adding cache hint capability there keeps request builder generic and avoids
hard-coded provider strings in the runtime pipeline.

`AgentConfig` can carry an explicit override if config needs to disable hints
for a compatible endpoint. The resolved capability should be:

```text
explicit config override
  -> provider profile default
  -> conservative fallback
```

### Runtime wiring

`RequestPipeline.build(...)` is the likely integration point because it already
owns request shape building and cache diagnostics. It can resolve capability
from config/profile and pass it to `RequestShapeBuilder`.

### Dry-run surface

A small application service can render a redacted dry-run summary from two
request shapes and can be reused by CLI/doctor/smoke. If no CLI command exists
yet, P4 can expose a service and smoke first, then wire CLI in a later phase.
The important contract is that the output stays provider-free and redacted.

### Doctor validation

Doctor should consume bounded trace/dry-run/policy diagnostics. It should not
call a provider or reconstruct raw prompts. Missing/disabled hints should be
explained as policy state:

- enabled and emitted -> ok
- disabled by capability/config -> ok/detail
- enabled but missing -> warning
- unsupported lane -> warning or bounded remediation

## Risks

- Putting provider-specific cache decisions directly in adapters would make
  trace/dry-run disagree with runtime assembly.
- Making dry-run render raw payloads would violate P3 redaction guarantees.
- Treating disabled hints as failures would punish intentionally conservative
  compatible-provider configs.
- Real provider telemetry is temporally unstable and should not be part of P4
  tests. Fake usage payloads are enough to lock normalization behavior.
