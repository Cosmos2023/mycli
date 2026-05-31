# Runtime Contract TypeScript Schema Bridge Research

## Current State

- Python owns `SUPPORTED_GATEWAY_EVENT_STREAMS` and
  `GATEWAY_EVENT_PAYLOAD_SCHEMAS` in `src/mycli/domain/runtime/gateway_contract.py`.
- `ExtensionManifestService` exposes those schemas in `extension.manifest`.
- Doctor checks manifest event names and payload schema names against Python's
  supported event streams.
- Node TUI has typed payload aliases and `KNOWN_GATEWAY_EVENT_METHODS`, and an
  existing Node test checks event method names against Python.

## Gap

The Node side does not carry a machine-readable contract map for each event's
required fields. That means Python can change manifest payload requirements
while TypeScript still compiles and Node tests still pass, unless a reducer
test happens to exercise the exact event shape.

## Direction

Add a small TypeScript runtime contract map next to protocol types:

- `GATEWAY_EVENT_PAYLOAD_CONTRACTS` maps event method to required payload keys.
- The contract map is checked locally against `KNOWN_GATEWAY_EVENT_METHODS`.
- A Node test compares the TypeScript contract map against Python
  `ExtensionManifestService().manifest()` payload schemas.
- Keep this as a test/contract bridge, not a generated file or new dependency.
