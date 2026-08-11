## Context

The Node composition root currently registers all built-in and integration adapters in one `ToolRouter`, and it also exposes every model-visible integration schema on every provider step. `NodeTurnRuntime` calculates that exposure once at turn start. Tool results are append-only and persisted before the next provider request, but there is no durable effect for changing the provider-visible schema during a turn.

The new web capability crosses network, parsing, policy, tool-manifest, and provider-output boundaries. The new discovery capability crosses integration registration, routing, runtime orchestration, provider projection, and SQLite recovery. Both must preserve the existing rule that data is durable before it enters provider context.

## Goals / Non-Goals

**Goals:**

- Fetch bounded public HTTP(S) content without permitting local-network access, DNS rebinding, unsafe redirects, unbounded downloads, or unbounded model output.
- Keep MCP and plugin adapters routable while deferring their schemas until a successful `tool_search` result selects them.
- Make selected schemas visible on the next provider step in the same turn, including after an approval continuation reconstructs the runtime context.
- Keep the stable direct tool surface deterministic and preserve append-only provider replay.

**Non-Goals:**

- General browser automation, JavaScript execution, authenticated browsing, cookies, arbitrary headers, uploads, or non-HTTP protocols.
- A web search provider, hosted index, or page cache shared across sessions.
- Deferring built-in tools, the stable `Skill` route, or subagent coordination routes.
- Deleting or importing the retained Python implementation.

## Decisions

### Use a pinned Node HTTP transport for `web_fetch`

`WebFetchTool` will use `node:http`, `node:https`, and `node:dns` through an injectable transport boundary. It will parse only `http:` and `https:` URLs, reject credentials, resolve the hostname, reject the request if any answer is non-public, and pin the connection lookup to a validated answer. Redirects are handled manually and repeat the full validation before the next request.

This is preferred over global `fetch`, because its default dispatcher does not give this package a simple per-request DNS pinning boundary. URL-only preflight validation would leave a DNS-rebinding interval between validation and connection.

### Bound every network and content stage

The tool will use one overall abortable timeout, at most five redirects, a one MiB response-byte ceiling, and the shared 8,000-character tool-output ceiling. Declared oversize responses fail before streaming; streamed oversize responses are destroyed. Only HTML, JSON, and textual media types are accepted. Compressed content is not requested and unsupported content encodings fail closed.

HTML is parsed with a declared lightweight HTML parser and projected into bounded readable text. Script, style, template, SVG, and other non-content nodes are omitted. JSON is parsed and stably pretty-printed when valid; other accepted text is normalized. Every successful output is fenced and labelled as untrusted external content with the final public source URL.

### Honor runtime network policy inside the adapter

The manifest marks `web_fetch` as a low-risk, network-effect tool, but the adapter still requires `ToolExecutionOptions.executionPolicy.network` to be `enabled`. Approval policy alone cannot grant network access that the active execution policy forbids. This keeps read-only and workspace profiles network-disabled and permits the tool in full-access or another explicitly network-enabled profile.

### Defer MCP and plugin schemas, not their routes

Integration composition continues to create and register every adapter. The direct provider exposure contains built-ins, `Skill`, and subagent coordination registrations. MCP and plugin definitions form a frozen deferred catalog. Route conflicts still fail during combined-manifest/router construction; search never overrides a route.

This preserves a small stable provider prefix while keeping selected tools executable without rebuilding integration processes.

### Search a generic immutable catalog with deterministic lexical ranking

`ToolSearchTool` receives generic candidates containing a definition, source, and bounded origin metadata, avoiding a dependency from `@mycli/tools` back to `@mycli/integrations`. It searches normalized route names, descriptions, source names, and origin values. Exact and prefix name matches outrank token matches; ties use the provider route name and id. The result count defaults to eight and is capped at sixteen.

A compact deterministic scorer is preferred over adding a search-engine dependency for the expected local catalog size. The catalog is built once during composition, so each search is bounded by configured integration count and output limits.

### Persist a dedicated activation effect before applying it

A successful search returns `ToolActivationEffect { names }` in addition to model-readable result text. Storage validates that the effect belongs to a successful `tool_search` result, bounds and deduplicates the names, and writes it into allowlisted tool-result metadata in the same append transaction.

Only after `appendToolResult` returns does `NodeTurnRuntime` refresh its mutable turn-local exposure. At provider-loop entry it also loads durable activations for the current turn and resolves them against the allowed deferred catalog. Unknown, stale, duplicate, or no-longer-allowed names are ignored. Definitions are never injected as synthetic provider messages; they appear only in `ProviderRequest.tools` and its durable model-input manifest.

This is preferred over mutating runtime state inside the adapter, which could expose a schema even when persistence fails, and over parsing human-readable tool output during recovery.

### Invalidate provider continuation when the tool schema changes

Activating a new schema changes the request signature. The runtime will invalidate any provider continuation state before the next provider step and send canonical replay with the expanded tool list. Repeated searches that activate only already-visible names do not change the schema or force another invalidation.

## Risks / Trade-offs

- [Public DNS can change between redirects or retries] -> Resolve and pin independently for every network hop; never reuse an unvalidated redirect target.
- [Blocking all hostnames with any private answer is stricter than browsers] -> Fail closed because mixed public/private DNS answers are unsafe for an agent-side fetcher.
- [Text extraction loses visual layout and client-rendered content] -> Keep browser automation explicitly out of scope and return a clear unsupported/empty-content result.
- [Lexical ranking is less sophisticated than BM25] -> Weight route-name matches heavily, keep deterministic ordering, and cover representative MCP/plugin queries; the implementation can later swap scorers behind the same catalog contract.
- [A catalog changes across process restart] -> Restore names only through the current frozen catalog and ignore unavailable entries rather than replaying stale schemas.
- [Dynamic tools reduce cross-step schema-prefix stability after discovery] -> Change the schema only when discovery succeeds; the larger schema is then stable for the remainder of that turn.

## Migration Plan

1. Add both built-ins and their manifest entries without changing Python.
2. Split direct and deferred integration exposure in the Node composition root while retaining all adapters in the router.
3. Add durable activation metadata and recovery, then enable mutable turn-local provider exposure.
4. Verify provider requests, SQLite replay, approvals, child runtimes, and existing M7/M8 extension behavior.

Rollback consists of restoring eager integration exposure and removing the new built-ins/effect projection. Existing tool-result metadata is additive and can be ignored by older readers.

## Open Questions

None for this implementation slice.
