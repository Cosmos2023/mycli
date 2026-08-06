# Migrating Python Plugins To Plugin API v2

The Node runtime does not import or execute Python plugin source. A directory containing
`__init__.py`, or a legacy manifest without `api_version: 2`, is reported as
`migration_required`. Migration is explicit; doctor does not rewrite files or run conversion code.

## Mapping

| Python plugin | Plugin API v2 |
| --- | --- |
| `plugin.yaml` without an API version | `plugin.yaml` with `api_version: 2` and explicit declarations |
| `__init__.py` with `register(ctx)` | Compiled ESM entry exporting `register(context)` |
| In-process Python module | Isolated Node worker process |
| Implicit host imports | `registerTool`, `registerHook`, and `registerCommand` facades only |
| Arbitrary environment access | Names listed in `requires_env` only |
| Implicit filesystem/network/process access | Requested `capabilities` plus host sandbox enforcement |
| Python exception/traceback | Stable bounded failure category |
| Mutable registration | One immutable initialization phase |

## Migration Steps

1. Inventory the Python plugin's tools, hook points, and provider-free commands.
2. Assign a lowercase plugin id and bounded declaration names.
3. Create a TypeScript ESM project and compile to `dist/`.
4. Implement `register(context)` using only the Plugin API v2 facades.
5. Convert input validation to object JSON Schemas.
6. Convert tool, hook, and command results to the v2 result shapes.
7. Declare every registration, environment name, and required capability in `plugin.yaml`.
8. Enable the id under `[plugins]`, then run list, inspect, command, and doctor checks.
9. Remove the legacy `__init__.py` only after the Node checks and runtime behavior pass.

Starting manifest:

```yaml
api_version: 2
id: migrated-example
name: Migrated Example
entry: dist/index.js
provides:
  tools: [lookup]
  hooks: [post_tool_use]
  commands: [status]
requires_env: []
capabilities: [filesystem_read]
```

Starting entry:

```ts
import type { PluginContextV2 } from "@mycli/integrations";

export function register(context: PluginContextV2): void {
  context.registerTool(
    {
      name: "lookup",
      description: "Look up one record.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    async (input) => ({
      success: true,
      summary: "lookup complete",
      modelOutput: String(input.id),
      metadata: {},
    }),
  );

  context.registerHook(
    { name: "audit", hookPoint: "post_tool_use" },
    async () => ({ action: "allow" }),
  );

  context.registerCommand(
    {
      name: "status",
      description: "Return migration status.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => ({ ok: true, summary: "ready", metadata: {} }),
  );
}
```

## Behavior Differences

- Registration is checked against the manifest. A declaration mismatch fails startup instead of
  exposing a partial plugin.
- Tool names are projected through stable ids and provider-safe routes. Do not depend on the old
  Python module name.
- Tool execution requires normal extension approval. Hooks and commands cannot grant themselves
  broader permissions.
- A plugin receives an abort signal for cancellation. Long-running handlers should observe it and
  stop promptly.
- Output is bounded. Store large artifacts in an approved location and return a short reference,
  rather than returning an unbounded body.
- Worker globals are not a durable store. Persist explicit state through a plugin-owned approved
  path if the capability is required.

## Verification And Rollback

```bash
npm run build
mycli plugins list --json
mycli plugins inspect migrated-example --json
mycli plugins run migrated-example status --json-args '{}' --json
mycli doctor
```

The migrated plugin is ready when it reports `loaded`, every runtime registration matches the
manifest, the command succeeds, and doctor no longer reports that id as `migration_required`.

M7 keeps `python-sidecar` as the operator-controlled rollback backend. Before switching, finish or
interrupt the active Node turn and stop owned child processes. Then start a later turn with:

```bash
mycli --runtime-backend=python-sidecar --session <session-id>
```

Node never falls back to Python after accepting a turn. M8, not M7, removes the Python backend and
legacy plugin implementation. Keep the old plugin available only for rollback until the M8 release
gate is approved.

