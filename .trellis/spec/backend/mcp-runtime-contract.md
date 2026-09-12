# MCP And Shared Extension Catalog Contract

## 1. Scope / Trigger

Changes to MCP discovery, connections, refresh, extension routing/approval/search publication,
or session tool exposure. MCP and Plugin API v2 share integration identities and publication;
their protocol clients and process hosts remain source-owned.

## 2. Signatures

- `McpManager.loadCached(signal)`, `discover(signal)`, `refresh(signal)`, `close()`.
- `McpConnection.run(operation, signal, request)` owns replaceable protocol generations.
- `discoverConfiguredMcpServers(options, discovery?)` unifies standalone and enabled-plugin config.
- `normalizeIntegrationToolNames(registrations, reservedNames?)` preserves raw identities.
- `ExtensionToolCatalog.replace(snapshot, policies)` publishes one prepared runtime view.
- `planExtensionToolExposure(definitions, discoveries)` selects generic provider exposure.
- `toolDiscovery(definition)` produces `{id, name, definitionSha256}`.
- Successful `tool_search` metadata: `tool_discovery: {version: 1, tools: ToolDiscovery[]}`.
- `SQLiteTranscriptEventRepository.loadToolDiscoveries(sessionId)` reads durable discoveries.

## 3. Contracts

- A manager owns one reusable client per immutable server configuration. Cached and live tool
  registrations share it. Configuration replacement belongs to the owning composition lifecycle.
- Runtime and list/inspect/login/logout/revoke use the same effective configured-server identities.
  Plugin provenance remains structured; readable selectors map to existing internal IDs. Exact
  standalone ID overrides win. Auth management never starts unrelated clients or plugin code.
- Package/config/auth changes refresh shared integration content before new-run catalog capture
  or idle inspection, after all active/suspended owners finish. Replacement discovery validates
  required servers, retains prior content on failure, and closes retired clients after publication.
  Initial optional discovery still uses the cached/background startup path. See the plugin contract.
- Coalesce in-flight refreshes only. One waiter cancellation detaches that waiter; the last waiter
  cancels discovery. Later explicit refresh can retry after failure/cancellation. Close rejects
  new work, aborts and drains owned operations/cache effects, then closes each client once.
- Stdio cancellation/timeout retires its process generation, not the entire client. Do not replay
  the canceled or uncertain operation. A later explicit call can establish a new generation.
  Siblings affected by retirement retain a connection-failure outcome, distinct from cancellation.
- Preserve bounded HTTP session recovery and error evidence from `error-handling.md`.
- `tools/list`, aggregated resources, and aggregated templates follow native cursors with limits:
  100 pages, 10,000 items, 8 MiB serialized aggregate, and 4,096-character cursors. Reject cycles;
  tool discovery also rejects repeated raw tool names. Do not publish truncated first-page success.
- Tools/resources failures are independent. Reject incompatible schemas per tool; expose usable
  siblings. `McpServerDiscovery.status` includes `partial`, with scoped capability/tool failures.
  Retain at most 20 detailed failures and expose `failureCount` for omitted diagnostics.
  Partial discovery must not overwrite a complete disk cache as if it were healthy.
- Callable aliases must be deterministic and unique across the published catalog and reserved
  built-in names. Collision suffixes derive from raw integration identity. Preserve raw routing
  and all adapter lifecycle/preview/execute hooks when changing only the model alias.
- Prepare route compilation, approval normalization, and search indexing before synchronous
  publication. The run's source snapshot changes in that same commit. Failure preserves the old
  complete snapshot. Active turns retain their already bound routes and policy.
- For generic function-calling providers, expose catalogs below 100 tools directly when their
  serialized schemas fit 128 KiB. Otherwise retain at most 64 exact matched discoveries within
  128 KiB and defer the remainder. Frozen runtime snapshot limits still apply to the full catalog.
- Persist only validated successful search discoveries, at most 16 per result. Retain no schemas,
  credentials, arguments, or external instructions in the discovery record. Query at most 512
  recent discovery results and return at most 512 identities; latest identity fingerprints win.
- Reconcile against current allowed identity, callable name, and full-definition hash at new-run
  construction. Older history without hashes has no retained exposure. Discovery never approves
  a tool, and lack of discovery never overrides a registered allowed route's normal policy.
- Exposed extension definitions sort by callable name. Search source descriptions use the entire
  allowed source catalog, so moving a discovered schema into next-turn direct exposure does not
  alter an otherwise identical request tool list. Schema changes may invalidate continuation;
  do not claim prompt-cache hits without provider usage evidence.
- Resolve MCP process policy at startup from explicit configuration plus managed bounds, independent
  of transient Shell grants. Default to workspace writes + networking; per-server mode/network
  can narrow it. A configured cwd never adds writable roots. Unsupported readable-root bounds fail
  before launch. Hooks and Plugin API v2 retain their own capability policies.
- Each stdio protocol generation owns its network proxy and releases it on launch failure, timeout,
  cancellation, unexpected process exit, retirement, or permanent close. Domain restrictions use the existing macOS proxy;
  unsupported enabled-domain platforms fail closed. HTTP checks bounds for every request and rejects
  redirects, including GET and DELETE requests made by the SDK.
- Legacy timeouts remain fallback values. Separate startup and call deadlines apply consistently to
  the connection wrapper and SDK; startup bounds connection and discovery separately. Preserve SDK
  timeout error codes and unknown call outcomes, with no timeout replay.
- Apply raw tool allow/deny lists before cached/live registration. Preserve standard annotations;
  hints never grant approval. Tool settings override server approval mode: auto follows the profile,
  prompt also asks under Full Access, approve is explicit configured authorization.
- Bind extension grants to stable integration identity and server/definition/annotation fingerprints, including the effective stdio cwd.
  Keep session and remembered grants separate from Shell rules. Publish scope and approval mode in
  the atomic catalog transaction; active turns retain bound policies. Validate restored scopes
  against both persisted states and current turn policy before any effect, even for approve-once.
- Carry approval scopes in continuation metadata for serial and parallel batches. Worker IPC sends
  choices back to the owning coordinator; callers cannot supply a replacement authorization scope.
  Storage failure leaves the effect unclaimed. Reload remembered grants before extension evaluation
  so revoke applies to subsequent calls; it does not clear session grants or reverse running calls.
- Required enabled servers need live startup/tools discovery before readiness, including plugin MCP.
  Cached metadata is insufficient; optional discovery stays in the background. Required startup
  errors close clients and retain a bounded typed failure. Tool-local schema errors and resource
  failures preserve usable siblings.
- Management add/remove edit private user TOML atomically, preserve unrelated values, reject
  duplicate replacement and oversized files, and validate without executing a server. Keep argv
  after -- intact. Report trusted repository overrides. Remembered approval list/revoke contains
  identities only; never publish hashes of credentials as if they were authentication tokens.
- OAuth, live elicitation and native discovery are specified in `mcp-interaction-contract.md`.
  Plugin package lifecycle redesign remains separate. Generic function calling must not claim
  a provider-native load point unless the SDK actually emits one.

## 4. Validation & Error Matrix

| Trigger | Outcome |
| --- | --- |
| One refresh waiter cancels | That caller aborts; other callers can receive the result |
| Last waiter cancels, then refresh is called again | Old operation drains; new discovery can start |
| Stdio request times out | Unknown result; process retired; no automatic replay |
| Resource listing fails, tools succeed | Usable tools and `partial` status with scoped failure |
| One incompatible tool schema | Reject that tool; retain healthy siblings |
| Duplicate raw tool name or cursor cycle | Bounded protocol/schema error |
| Distinct raw names sanitize identically | Unique stable aliases, raw protocol routing preserved |
| Catalog preparation fails | All runtime consumers retain the previous version |
| Discovery hash no longer matches | No retained schema; current catalog remains authoritative |
| Unsearched but registered allowed tool is called | Validate arguments and apply normal approval/hooks |

## 5. Good / Base / Bad Cases

- Good: cancel `wait`, invoke `echo` explicitly, and observe a new stdio PID with one execution.
- Good: a 100-tool catalog is searched once; the next user turn retains matching schemas and
  presents the same tool definitions while each invocation still receives the configured approval.
- Base: a 14-tool catalog is callable from the first request without discovery.
- Bad: close the permanent client to cancel one operation; cache a settled refresh promise forever.
- Bad: reconstruct exposure from historical names alone, or update search before route/policy checks.

## 6. Tests Required

- Real SDK stdio timeout/cancel followed by a successful new call and deterministic PID cleanup.
- Real SDK HTTP tools pagination; protocol cycle/duplicate/count/byte/cancel bounds.
- Refresh concurrency, caller cancellation, retry after failure, close during cache save, client reuse.
- Resource/schema failure isolation and diagnostic projection; shared alias routing and lifecycle.
- Atomic publication failure, old-run binding retention, and schema-change restoration rejection.
- Small/large catalogs through gateway, runtime, provider requests, approval, and actual adapter calls
  across two user turns; compare full tool definitions, not just tool names.
- Durable discovery reconstruction after reopen; ignore failed, malformed, stale, and foreign-session
  records. Run lint, typecheck, build, full tests, contract/config drift, and diff checks.

## 7. Wrong vs Correct

```typescript
// Wrong: discoverability and execution policy can diverge when a later step fails.
search.replaceCandidates(next);
router.replaceDynamicAdapters(adapters);

// Correct: all fallible preparation finishes before any runtime consumer changes.
catalog.replace({ version, tools, skillCatalog }, policies);
```

```typescript
// Wrong: historical names are treated as current schemas or permission grants.
const exposed = historicalNames;

// Correct: current catalog identity and definition hashes constrain retention.
const exposed = planExtensionToolExposure(allowedDefinitions, store.loadToolDiscoveries(sessionId));
```
