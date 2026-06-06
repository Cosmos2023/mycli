# Prefix Cache Context Assembly P4

## Problem

P1/P2/P3 now give mycli a cache-aware request shape, provider wire cache hints,
redacted diagnostics, doctor triage, and provider-free dry-run comparison. The
remaining gap is operational adoption: cache hint capability is an explicit
builder argument rather than provider/config driven, dry-run diagnostics are a
library helper/smoke artifact rather than a user-facing local surface, and real
provider cache telemetry can be recorded only indirectly through existing usage
metadata.

## Goal

Turn the P3 observability primitives into a configured runtime policy surface:
derive cache hint capability from provider profile/config, expose redacted
dry-run diagnostics through local commands/doctor or equivalent provider-free
surfaces, and normalize provider cache usage telemetry into trace/doctor without
performing real external provider calls in tests.

## In Scope

- Provider profile/config cache policy:
  - Add provider/profile capability metadata for `prompt_cache_key` and
    Anthropic `cache_control`.
  - Keep safe defaults for OpenAI Responses, OpenAI-compatible Chat, Anthropic
    Messages, and compatible/fake providers.
  - Allow config or provider profile to disable unsupported hints.
  - Ensure `RequestPipeline` / `RequestShapeBuilder` receives the resolved
    capability automatically rather than relying only on ad hoc builder args.
- Dry-run user surface:
  - Add a provider-free dry-run command/service, doctor detail, or equivalent
    local diagnostic surface that renders `ProviderRequestDryRun` safely.
  - Include provider lane, section boundary hash, prompt-cache-key hash,
    first-changed cache class, wire hint state, and payload snapshot counts.
  - Do not include raw prompt text, raw tool output, secrets, full
    `prompt_cache_key`, or provider wire payload bodies.
- Provider cache usage telemetry normalization:
  - Normalize cached-token fields from Responses/Chat/Anthropic-style usage
    metadata into existing `CacheShapeDiagnostics`.
  - Trace and doctor should report bounded latest/max cached-token values and
    missing telemetry status.
  - Tests must use fake/local usage payloads only.
- Config/doctor validation:
  - Doctor should warn when cache policy says hints are enabled but the provider
    lane cannot emit the corresponding hint.
  - Doctor should report disabled hints as deliberate policy, not failure.
- Documentation/spec update:
  - Document provider profile capability resolution.
  - Document dry-run output contract.
  - Document telemetry normalization and redaction boundaries.

## Out of Scope

- Merging to main.
- New third-party dependencies.
- Real external provider API calls.
- ACP, remote agent, swarm, or gateway productization.
- Full memory system, background maintenance, or multimodal tool result
  envelope.
- Provider-specific compact engines.
- `/responses/compact` default path.
- Copying Hermes-agent or Codex source.

## Requirements

1. Provider cache hint capability is resolved from provider profile/config and
   passed into request shape assembly in normal runtime paths.
2. Legacy/fake clients remain compatible and never fail because a provider does
   not accept `prompt_cache_key`.
3. Dry-run diagnostics can be produced without a model request and remain
   redacted.
4. Cache usage telemetry is normalized from fake Responses/Chat/Anthropic usage
   payloads into cache diagnostics/doctor summaries.
5. Doctor distinguishes enabled, disabled, missing, and unsupported cache hint
   states using bounded messages.
6. P1/P2/P3 cache stability, provider cache, context, subagent, MCP, plugin,
   and hook smokes continue to pass.

## Acceptance

- Unit tests cover provider profile/config capability resolution.
- Unit tests cover runtime request assembly using resolved capability.
- Unit tests cover dry-run diagnostic rendering/redaction.
- Unit tests cover cache usage telemetry normalization for supported provider
  usage shapes.
- Unit tests cover doctor cache policy validation and disabled/missing hint
  reporting.
- Provider-free cache smoke passes and includes the P4 policy/dry-run fields.
- context/subagent/MCP/plugin/hook smokes pass.
- `uv run ruff check .`, `uv run mypy src/mycli`, and full
  `uv run pytest -q` pass.
- Trellis research, PRD, implementation, tests, archive, and journal are
  complete.
- Final report includes branch, commits, completed content, test results,
  remaining Hermes/Codex cache gaps, and next recommendations.
