# Extensions Command Discovery Notes

## Existing State

- `ExtensionManifestService.manifest()` returns a read-only discovery document.
- `TurnService.extension_manifest()` returns the service manifest.
- `NodeTuiGateway` exposes `extension.manifest` for external clients.
- Slash commands already route human-readable inspection commands such as
  `/tools`, `/subagents`, `/trace`, and `/logs`.

## Design

`/extensions` should mirror the existing inspection command pattern:

```text
[extension] agent=mycli schema=1 rpc_methods=9 event_streams=7
[extension] rpc extension.manifest
[extension] rpc trace.export
[extension] runtime.trace.export available
[extension] extensions.lifecycle not_available
```

The command should not print raw JSON because that would duplicate the
machine-readable RPC and make transcript output noisy.

## Risks

- Human output can drift from manifest shape. Tests should cover only compact
  stable fields and key capabilities, not every description string.
- This is discovery only. It must not imply extension lifecycle support.
