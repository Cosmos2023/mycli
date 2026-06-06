# Cache Observability Loop Research

## Current P1/P2 Flow

### Canonical request shape

- `InstructionContract` carries base instructions, contextual sections,
  conversation replay, and current user request.
- `RequestShapeBuilder` orders fragments as:
  1. `stable:*` system/tool/static context.
  2. `replay:*` conversation/dynamic context.
  3. `intent:*` and `volatile:*` current/ephemeral context.
- `RequestShape.summary()` contains bounded hashes, section boundaries,
  provider projection, compact policy, and provider request policy diagnostics.
- Full `prompt_cache_key` is intentionally absent from summary/trace and present
  only in `to_wire_dict()` metadata for provider projection.

### Provider projection

- `RequestShapePayloadFormatter.legacy_messages()` preserves provider policy in
  message metadata for Chat Completions.
- `RequestShapePayloadFormatter.runtime_items()` preserves runtime item metadata
  for Responses and Anthropic lanes.
- Responses adapter extracts `prompt_cache_key` from runtime item metadata and
  passes it only when the client supports that kwarg.
- Chat client extracts `prompt_cache_key` from message metadata and sends it as
  a request option. Provider adapters strip provider-private message fields.
- Anthropic adapter adds `cache_control` only to serialized system/message block
  copies.

### Diagnostics

- `CacheShapeDiagnostics` reports first changed fragment/cache class, cache
  boundary, provider request policy metadata, and provider cached tokens.
- `DoctorService` summarizes context/request/cache trace rows, stable prefix
  changes, wire hint rows, prompt key hash count, Anthropic breakpoint count, and
  max provider cached tokens.
- P3 needs distributions and latest-value triage rather than only maxima.

## P3 Gaps

- Cache stability coverage exists but is not a focused regression suite.
- Provider payload projection can be inspected only by direct fake-client tests
  or smoke output; there is no reusable redacted snapshot object.
- Doctor does not yet count dynamic/ephemeral changes, first-changed-class
  distribution, latest cached tokens, missing wire hints, or remediation.
- `ProviderRequestPolicyShape` has no capability/config gate.
- Dry-run comparison is not an explicit service; tests must manually compare
  summaries.

## Proposed Design

1. Add domain/service-level cache observability helpers rather than embedding
   more provider-specific logic in clients:
   - `ProviderCacheCapability` or equivalent gate on policy generation.
   - `ProviderPayloadSnapshot` / diagnostics helper for redacted payload
     summaries.
   - `ProviderRequestShapeDryRun` or request diagnostics helper for shape
     comparison.
2. Keep wire-only full values out of trace:
   - Full `prompt_cache_key` remains available only where the provider request
     is built.
   - Snapshot/dry-run uses hash and bounded preview.
3. Extend doctor trace summarization:
   - Count first changed cache classes from cache-shape diagnostics.
   - Track max/latest provider cached tokens.
   - Count wire hint enabled/missing.
   - Emit bounded remediation strings.
4. Add tests before implementation:
   - Cache stability matrix in `tests/unit/services`.
   - Payload snapshot diagnostics in request/provider service tests.
   - Doctor trace summary fixtures.
   - Capability gate tests around `ProviderRequestPolicyShape`.
   - Dry-run comparison tests and smoke extension.

## Risks

- If snapshot diagnostics consume real provider payloads, they can accidentally
  leak raw prompt content. Prefer summarizing from request shape metadata and
  counting sanitized payload fields.
- If capability gate lives only in clients, diagnostics and dry-run will drift
  from runtime behavior. Prefer deriving it before provider metadata is attached.
- If doctor remediation includes fragment ids beyond stable/dynamic/ephemeral
  counts, it may overfit to trace internals. Keep messages bounded and generic.
