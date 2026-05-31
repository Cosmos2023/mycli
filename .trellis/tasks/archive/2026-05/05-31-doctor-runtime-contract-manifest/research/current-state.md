# Current State: Doctor Runtime Contract Manifest

## Finding

The runtime/TUI gateway contract has three related discovery surfaces:

- Python gateway advertised RPC/event sets (`supported_rpc_methods()` and
  `supported_event_streams()`)
- `ExtensionManifestService.manifest()`
- Node TypeScript known event methods

Unit tests already compare the manifest to gateway sets and Node event methods
to Python streams. However, `mycli doctor` does not expose a runtime-contract
health check. A local installation can therefore pass doctor even if a packaging
or runtime import issue causes manifest discovery to be missing, stale, or
internally inconsistent.

## Desired State

Doctor should add a read-only `runtime_contract` check that:

- Builds the extension manifest without starting runtime turns or model calls.
- Compares manifest RPC methods to `supported_rpc_methods()`.
- Compares manifest event streams to `supported_event_streams()`.
- Confirms key Hermes-like streams are present: `runtime.event`,
  `message.delta`, `message.complete`, `tool.start`, `tool.complete`,
  `tool.failed`, `turn.status`, `approval.request`, and `clarify.request`.

The check should report bounded, actionable failures and should not print full
manifest payloads.
