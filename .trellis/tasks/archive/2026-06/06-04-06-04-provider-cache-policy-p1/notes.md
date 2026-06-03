# Research Notes

## Current Evidence

- `.trellis/spec/backend/context-management-contract.md` requires request
  fragments to preserve cache class/source metadata and context diagnostics to
  stay bounded.
- `InstructionContractAssembler` already copies `TurnContextSection.cache_class`
  into `InstructionFragment.metadata["cache_class"]`.
- `RequestShapeBuilder._contextual_fragments()` currently turns every contextual
  section into `FragmentStability.VOLATILE`, so static workspace/tool exposure
  metadata is not yet reflected in request-shape stability.
- `CacheShapeDiagnostics` already computes first changed fragment/message and
  provider cache usage tokens, but it lacks an explicit cache boundary and
  estimated cacheable prefix.
- `DoctorService` has a context check for context diagnostics traces. It reports
  bounded counts/tokens and avoids raw content.

## Implementation Direction

- Treat `cache_class=static` as stable request fragments, `dynamic` as replay
  fragments, and `ephemeral` as volatile fragments.
- Give contextual fragments deterministic cache-policy ordering independent of
  original assembly order when building diagnostics/provider deltas.
- Add fragment metadata fields for source, cache class, section hash, and
  provider visibility.
- Derive a cache boundary in diagnostics from the ordered stable-prefix
  fragments and provider-message/runtime-item prefix hashes.
- Keep raw content out of traces, logs, and doctor output.
