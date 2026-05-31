# Runtime Contract Property Schema Parity Research

## Current State

- Python gateway contract schemas expose `required` fields plus `properties`
  with primitive type metadata and selected enums.
- Node TUI now has `GATEWAY_EVENT_PAYLOAD_CONTRACTS` and a cross-language test
  comparing required fields against Python manifest schemas.
- Node still does not compare manifest property names or enum values, so Python
  can add a known payload property or change `turn.status.state` enum values
  without a direct Node contract failure.

## Gap

Hermes-like TUI gateway parity needs clients to know not only which fields are
required, but also which payload keys and status enum values are stable. The
current Node contract bridge catches required-field drift but not property or
enum drift.

## Direction

Extend the TypeScript contract map and Node test:

- Add `properties` arrays for each gateway event payload.
- Add enum metadata for known enum-bearing fields such as `status.update.state`
  and `turn.status.state`.
- Compare TypeScript contract properties/enums with Python
  `ExtensionManifestService().manifest()` payload schemas.
- Keep the check in tests and type metadata only; do not add runtime validation
  or dependencies.
