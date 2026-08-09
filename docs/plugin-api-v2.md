# Plugin API v2

Plugin API v2 is the Node runtime's local extension boundary. Each enabled plugin runs in a
separate Node child process and communicates with mycli through a validated, bounded JSON-lines
protocol. Plugins cannot receive host service objects, mutate registrations after initialization,
or import mycli runtime internals at execution time.

## Package Layout

Repository plugins live at `<workspace>/.mycli/plugins/<plugin-id>/`; user plugins live at
`~/.mycli/plugins/<plugin-id>/`.

```text
example-plugin/
  plugin.yaml
  package.json
  tsconfig.json
  src/
    index.ts
  dist/
    index.js
```

mycli loads only the compiled `dist/index.js` or `.mjs` entry. The entry must remain inside the
plugin directory. Raw `.ts`, CommonJS-only entries, absolute entries, and paths containing `..` are
rejected.

## Manifest

```yaml
api_version: 2
id: example
name: Example Plugin
version: 1.0.0
description: Local example capabilities.
entry: dist/index.js
provides:
  tools: [lookup]
  hooks: [pre_tool_use]
  commands: [status]
requires_env: [EXAMPLE_ENDPOINT]
capabilities: [filesystem_read, network]
```

Required fields are `api_version`, `id`, `name`, `entry`, `provides`, `requires_env`, and
`capabilities`. Plugin ids are lowercase and bounded to 64 characters. Declaration names begin
with a letter and contain only letters, digits, `_`, or `-`.

Supported capabilities are:

- `filesystem_read`
- `filesystem_write`
- `network`
- `process_spawn`

Capabilities select the host sandbox profile; they do not bypass normal tool approval. Every
environment name must be explicitly declared. A missing declared value fails startup with a stable
error category and does not expose the value or other inherited environment entries.

Enable or disable ids in user or repository config:

```toml
[plugins]
enabled = ["example"]
disabled = []
```

Plugins are opt-in and `disabled` wins. When repository and user plugins share an id, the user
candidate wins and the duplicate remains diagnostic-visible.

## TypeScript Entry

The runtime calls one exported `register(context)` function during initialization:

```ts
import type { PluginContextV2 } from "@mycli/integrations";

export async function register(context: PluginContextV2): Promise<void> {
  context.registerTool(
    {
      name: "lookup",
      description: "Look up one local record.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    async (input, signal) => {
      signal.throwIfAborted();
      return {
        success: true,
        summary: "record found",
        modelOutput: String(input.id),
        metadata: { source: "local" },
      };
    },
  );

  context.registerHook(
    { name: "guard", hookPoint: "pre_tool_use" },
    async () => ({ action: "allow" }),
  );

  context.registerCommand(
    {
      name: "status",
      description: "Return plugin status.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    async () => ({ ok: true, summary: "ready", metadata: {} }),
  );
}
```

Every runtime registration must match the manifest declaration. Tool and command input schemas
must describe an object with `properties`. Duplicate tokens/names, undeclared registrations, late
registration, or registration after initialization fails closed.

Tool results use `success`, `summary`, `modelOutput`, optional `errorKind`, and bounded `metadata`.
Hook results use `allow`, `deny`, `modify`, or `error`; modified arguments must be a bounded object.
Command results use `ok`, `summary`, optional bounded `content`, bounded `metadata`, and an optional
stable `error` code.

## Build Contract

A minimal ESM build can use TypeScript directly:

```json
{
  "type": "module",
  "scripts": {"build": "tsc -p tsconfig.json"},
  "devDependencies": {"typescript": "^5.9.0"}
}
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "declaration": true
  },
  "include": ["src/**/*.ts"]
}
```

Run the plugin build before enabling it. Do not point `entry` at a source loader or rely on mycli's
development `tsx` dependency.

## Process Protocol

Every JSON-lines message includes `version: 2`, a bounded `request_id`, and one explicit type:

```text
host -> initialize -> worker
host <- registered <- worker
host -> invoke     -> worker
host <- result     <- worker
host <- error      <- worker
host -> shutdown   -> worker
host <- shutdown_complete <- worker
```

The host validates every inbound and outbound message against the schemas under
`backend/packages/contracts/schemas/`. It enforces one initialization phase, immutable registrations,
bounded line/stderr size, bounded outstanding requests, startup/call/shutdown timeouts,
cancellation, and process-tree cleanup. A crash fails that plugin's pending calls and does not
corrupt the parent turn or another plugin.

Protocol JSON is an implementation boundary, not a direct author API. Authors implement
`register(context)` and let the supplied worker bootstrap own transport messages.

## Security And Diagnostics

Plugin tools request one-time approval through the normal extension approval policy. Plugin hooks
run at their declared hook point and cannot bypass the pre-operation fail-closed policy. Plugin
commands run without a model provider.

Host diagnostics may expose plugin id, source, lifecycle status, declared registration names,
counts, and stable failure categories. They never include environment values, headers, raw
stdin/stdout/stderr, plugin exception messages, stack traces, provider payloads, prompts, tool
arguments, or file contents.

Validate an installation with:

```bash
npm run build
mycli plugins list --json
mycli plugins inspect example --json
mycli plugins run example status --json-args '{}' --json
mycli doctor --json
```
