# Runtime V2 Phase 5a Fragment Split Diagnostics Plan

## Goal

Split the monolithic `volatile:context` request fragment into section-level fragments so cache diagnostics can identify which volatile context slice changes first.

## Scope

- Keep provider payload text unchanged for this phase.
- Split contextual user sections into deterministic request fragments.
- Preserve current provider message/runtime item ordering.
- Add tests for memory, plan, runtime policy, and environment fragment identities.

## Non-Goals

- Do not change memory retrieval behavior yet.
- Do not remove duplicated tool evidence yet.
- Do not alter provider SDK clients.

## Acceptance Criteria

- `RequestShape.fragments` no longer uses one opaque `volatile:context` fragment when contextual sections are present.
- Memory sections use `retrieved_memory` fragment kind.
- Runtime policy, plan, environment, capability, and dynamic tool context sections receive deterministic volatile fragment ids.
- Provider payloads still include the joined volatile context after current user intent.
