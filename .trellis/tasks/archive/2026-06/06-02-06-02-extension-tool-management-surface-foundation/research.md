# Extension Tool Management Surface Foundation Research

## Current State

- Built-in, MCP, skill, and subagent tools can be represented in the combined
  tool manifest.
- `TurnService.inspect_tools()` only renders local registry specs as
  `name [risk]: description`, so users cannot see source, toolset,
  availability, or approval policy.
- There is no `/toolsets` command.
- `ExtensionManifestService` accepts contributed registrations, but the default
  service path used by `TurnService.extension_manifest()` does not receive the
  live runtime contribution registry.
- Doctor validates the static built-in manifest/toolset shape, not consistency
  between runtime-visible contributed tools and the extension manifest.

## Direction

Introduce a small management service over the existing manifest objects instead
of inventing another registry. `TurnService` should render human slash-command
output from the same extension manifest used by gateway clients.

Runtime should expose a read-only extension manifest that includes currently
visible contributed tools, so the Node gateway `extension.manifest` RPC can
report MCP/skill/subagent tools when the runtime has registered them.
