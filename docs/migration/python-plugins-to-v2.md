# Migrating Python Plugins To Plugin API v2

M8 does not import or execute Python plugin source. A plugin containing `__init__.py`, or a legacy
manifest without `api_version: 2`, is reported as `migration_required`. Doctor reports the state but
does not rewrite files or run conversion code.

## Mapping

| Legacy Python plugin | Plugin API v2 |
| --- | --- |
| `plugin.yaml` without API version | `api_version: 2` with explicit declarations |
| `__init__.py` with `register(ctx)` | compiled ESM entry exporting `register(context)` |
| in-process module | isolated Node worker process |
| implicit host imports | `registerTool`, `registerHook`, and `registerCommand` facades |
| arbitrary environment access | names explicitly listed in `requires_env` |
| implicit filesystem/network/process access | declared capabilities plus host sandbox policy |
| traceback returned to host | stable bounded failure category |
| mutable registration | one immutable initialization phase |

## Migration Steps

1. Inventory the legacy plugin's tools, hook points, provider-free commands, state, and required
   environment names.
2. Assign a lowercase plugin id and bounded declaration names.
3. Create a TypeScript ESM project and compile it to `dist/`.
4. Implement `register(context)` using only Plugin API v2 facades.
5. Convert every input contract to an object JSON Schema with explicit `required` and
   `additionalProperties` behavior.
6. Convert tool, hook, and command results to bounded v2 result shapes.
7. Declare every registration, environment name, and capability in `plugin.yaml`.
8. Enable the id under `[plugins]`, then run list, inspect, command, and doctor checks.
9. Archive the legacy source outside active plugin discovery after the Node behavior passes.

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

- Registration is checked against the manifest. A mismatch fails startup instead of exposing a
  partial plugin.
- Tool names use stable provider-safe routes. Do not depend on the legacy module name.
- Tool execution follows normal extension approval. Hooks and commands cannot grant themselves
  broader permissions.
- Handlers receive an abort signal and must stop promptly on cancellation.
- Output is bounded. Store large artifacts in an approved location and return a short reference.
- Worker globals are not durable state. Persist through a plugin-owned approved path when needed.
- Plugin commands are additive and cannot override built-in slash commands or aliases.

## Verification

```bash
npm run build
npm run mycli -- plugins list --json
npm run mycli -- plugins inspect migrated-example --json
npm run mycli -- plugins run migrated-example status --json-args '{}' --json
npm run mycli -- doctor
```

The migration is ready when the plugin reports `loaded`, every runtime registration matches the
manifest, the command succeeds, and doctor no longer reports the id as `migration_required`.

## Rollback

There is no Python backend inside the M8 npm CLI, so keeping `__init__.py` beside the v2 plugin is
not an executable Node fallback. Preserve the old source in version control or an archive outside
active Node plugin discovery; it may still be used with the independently launched Python runtime.

To roll back the whole product, finish or interrupt active work, stop owned child processes, back
up `~/.mycli`, and install the previous mycli package release. Do not run the old and new releases
concurrently against the same active session database.
