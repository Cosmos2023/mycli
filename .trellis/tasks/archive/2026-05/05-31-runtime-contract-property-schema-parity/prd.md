# Runtime Contract Property Schema Parity

## Problem

The TypeScript/Python runtime contract bridge currently checks event method
names and required payload fields. It does not check payload property names or
enum values from Python manifest schemas. That leaves a drift gap for fields
that are optional but still part of the stable contract, and for status enums
used by TUI reducers.

## Goal

Make Node tests fail when TypeScript event payload contract properties or enum
values drift from Python `extension.manifest` payload schemas.

## Scope

- Extend `GATEWAY_EVENT_PAYLOAD_CONTRACTS` with property names for every known
  gateway event.
- Add enum metadata for schema properties that define `enum`, including turn
  state fields.
- Extend the Node protocol test to compare:
  - required fields
  - property names
  - enum values
- Update runtime contract spec and check artifact.

## Non-Goals

- No generated TypeScript file.
- No new dependency.
- No hot-path runtime validator.
- No reducer behavior changes unless tests expose drift.
- No merge to `main`.

## Acceptance

- Node test fails before the TypeScript contract includes property/enum
  metadata.
- `npm --prefix tui/node test` passes after implementation.
- `npm --prefix tui/node run typecheck` passes.
- Relevant Python manifest/doctor runtime contract tests continue passing.
