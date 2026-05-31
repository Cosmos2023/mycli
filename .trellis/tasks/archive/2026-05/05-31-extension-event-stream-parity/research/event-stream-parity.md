# Event Stream Parity Notes

## Existing State

- `ExtensionManifestService.manifest()` lists seven event streams:
  `status.update`, `approval.request`, `approval.respond`, `turn.event`,
  `turn.completed`, `turn.failed`, and `turn.interrupted`.
- `NodeTuiGateway` emits those methods during turn execution, approval
  resolution, and interruption paths.
- The gateway also emits implementation/compatibility notifications such as
  `turn.started` and `status.changed`; these are not currently part of the
  extension manifest.

## Design

Mirror the RPC parity approach:

- Keep the authoritative supported notification set near `NodeTuiGateway`.
- Add a small helper for tests and future manifest generation.
- Test that manifest `event_streams` is a subset of the gateway-owned set.

This gives clients a truthful discovery guard without changing runtime behavior
or making all gateway notifications part of the extension contract.

## Risk

- A supported event set can drift from `_emit_event()` calls if future handlers
  do not update it. The set should live near the RPC method set and gateway
  implementation so reviews see the contract update requirement.
- Not all emitted notifications are extension-contract events. The parity test
  intentionally checks subset, not equality.
