# P8 Recovery / Productized Observability Research

## Sources Read

- `docs/prefix-cache-context-assembly-goals.md`
- `docs/prefix-cache-context-assembly-roadmap.md`
- `.trellis/spec/backend/context-management-contract.md`
- `.trellis/spec/backend/quality-guidelines.md`
- `.trellis/spec/backend/logging-guidelines.md`
- `.trellis/spec/guides/cross-layer-thinking-guide.md`
- `.trellis/spec/guides/code-reuse-thinking-guide.md`
- `src/mycli/application/runtime/recovery.py`
- `src/mycli/application/runtime/turn_executor.py`
- `src/mycli/application/runtime/request/*`
- `src/mycli/services/diagnostics/doctor.py`
- `src/mycli/services/tracing/trace_service.py`
- `evaluation/provider_cache_policy_smoke.py`

## Existing Capabilities

- `TurnExecutor` already has bounded recovery paths for context-window errors,
  output token recovery, transient transport retries, and fallback model
  attempts.
- `recovery.py` already owns retry metadata helpers and transient failure
  classification for some model errors.
- P4 already normalizes fake/local provider cached-token usage through
  cache-shape diagnostics and doctor summaries.
- `ProviderRequestDryRun` and `ProviderRequestDryRunRenderer` already compare
  provider-free request shapes and redact full prompt-cache keys.
- `TraceService` sanitizes trace payloads before disk write.
- Doctor already summarizes several trace families using bounded counts and
  redaction rules.

## Gaps For P8

- Error taxonomy is not yet expressed as a first-class classifier for the P8
  categories: invalid encrypted content, context overflow, schema rejected,
  unsupported payload, and image too large.
- Invalid encrypted reasoning recovery needs an explicit policy outcome and
  trace/diagnostic evidence without replaying or printing encrypted content.
- Schema rejected vs unsupported payload should be differentiated so only
  deterministic sanitize repairs retry.
- Doctor/dry-run/benchmark should expose P8 recovery and cache policy fields as
  stable local diagnostic surfaces.
- Redaction boundaries should be tested with representative raw prompt, tool
  output, prompt-cache-key, and provider-private state payloads.

## Recommended Implementation

- Extend `application/runtime/recovery.py` with an `ErrorClassifier` and
  `RecoveryPolicy` that produce typed/bounded decisions.
- Integrate classifier decisions into `TurnExecutor._recovery_action_for_model_error`
  without rewriting existing retry flow wholesale.
- Reuse existing trace kinds or add bounded recovery diagnostic trace events;
  avoid raw error messages, encrypted state, prompts, and tool output.
- Extend provider-free smoke or a companion local benchmark report to surface
  P8 fields.
- Extend doctor summaries using bounded counts and statuses instead of raw
  trace payloads.
- Add tests before implementation for each recovery class and the redaction
  contract.

## Risks

- Real provider error text is unstable, so tests should use fake/local
  `ModelResponseError` payloads.
- Recovery retry loops must stay bounded.
- Diagnostics can accidentally become a leakage path if they include raw trace
  payloads or provider-private state.
- P8 should not slip into implementing full multimodal recovery or
  provider-specific compact engines.
