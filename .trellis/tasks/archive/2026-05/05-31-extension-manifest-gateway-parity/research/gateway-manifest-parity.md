# Gateway Manifest Parity Notes

## Existing State

- `ExtensionManifestService.manifest()` returns a static discovery document.
- `NodeTuiGateway.handle_request()` supports a fixed set of JSON-RPC request
  methods through an `if request.method == ...` chain.
- `extension.manifest` is one of those methods and returns the service
  manifest.
- The recently added `/extensions` command is intentionally human-readable and
  summarizes the same manifest rather than replacing it.

## Design

Expose the gateway's supported method names through a constant or tiny helper
owned by `src/mycli/cli/node_tui/gateway.py`. Tests can then compare the
manifest's advertised method names against that gateway-owned surface.

This avoids copying the same method list into the test and gives future
gateway/manifest edits a single obvious place to keep in sync.

## Risk

- A public constant can itself drift if handlers are added without updating it.
  Keeping the helper next to `handle_request()` makes the mismatch visible, and
  the helper can later be reused by `extension.manifest` if the manifest becomes
  runtime-generated.
- This is still discovery hardening only. It must not imply extension lifecycle
  or ACP support.
