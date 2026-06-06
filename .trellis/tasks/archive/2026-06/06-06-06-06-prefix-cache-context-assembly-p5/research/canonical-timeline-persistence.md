# Canonical Timeline Persistence Research

## P4 Baseline

- `TurnContextSection` already carries `cache_class` metadata, but it has no
  explicit durability or prompt-scope contract.
- `InstructionContractAssembler` maps memory, plan, runtime reminders,
  compaction rehydration, workspace, and environment sections into
  `InstructionFragment` objects. It preserves `cache_class` in metadata but
  does not distinguish persistent vs `api_only` content.
- `RequestShapeBuilder` consumes instruction fragments and already keeps
  stable, dynamic, ephemeral, and current user input ordering. P5 should not
  reorder current user input.
- `SessionRuntimeSnapshot` and `HistoryItem` provide a durable session history
  channel, but there is no canonical item shape that records role/kind, source,
  durability, cache class, scope, and provider state in one typed contract.
- Context docs currently state the target rule: agent-visible selected
  hook/plugin/memory/plan context should become replayable context, while
  transport/cache/debug-only hints remain out of model-visible replay.

## Relevant Data Flow

```text
Runtime context sources
  -> TurnContextSection
  -> InstructionFragment / InstructionContract
  -> RequestShape fragments/provider messages/runtime items
  -> Session history / resume projection
```

P5 should add a canonical persistence contract near the domain runtime layer and
thread its metadata through existing section/fragment/request shape paths before
changing deeper session storage behavior.

## Implementation Candidates

### Canonical timeline domain model

Add a small provider-agnostic domain model such as:

```text
CanonicalTimelineItem
  role
  kind
  source
  durability
  cache_class
  scope
  content
  metadata
  provider_state
```

This makes P5 testable without forcing all runtime storage to migrate at once.
Existing `HistoryItem` can keep its current persistence layout while metadata
can carry canonical timeline summaries and future migrations can convert between
the two.

### Section metadata projection

`TurnContextSection` is the current point where memory/plan/rehydration/runtime
context enters request assembly. Adding explicit durability/scope fields there
keeps P5 behavior close to the existing pipeline:

- default durable/model-visible sections: workspace, memory, plan, compaction
  rehydration, hook/plugin context if represented as context sections.
- default ephemeral/model-visible sections: runtime reminders.
- default current user: persistent current intent, still placed last by
  `RequestShapeBuilder`.
- explicit `api_only` sections: diagnostic/transport hints, which
  `InstructionContractAssembler` should exclude from provider-visible
  fragments.

### Rehydration scope

Compaction rehydration needs a scope marker:

- durable rehydration is replayable in later turns.
- turn-scoped rehydration is model-visible for the current continuation but not
  replayed as durable context later.

P5 can express this as metadata/scope and tests can assert it flows through
request shape summaries. The actual compact engine remains P7.

## Risks

- Treating all dynamic state as durable would inflate replay and reduce cache
  usefulness.
- Treating selected memory/plan/plugin context as one-shot prompt text creates a
  transcript gap where the model saw information that cannot be replayed or
  debugged later.
- Persisting wire-only cache hints would violate P1-P4 redaction and provider
  policy invariants.
- A full session storage migration in P5 would be too broad. The safer first
  slice is a typed canonical contract plus propagation through request assembly
  and focused resume/request-shape tests.
