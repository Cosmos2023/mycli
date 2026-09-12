# MCP Architecture Audit Against Local Codex Source

Date: 2026-09-11. Status: F1-F6 implemented and verified.

## Implementation Status

The confirmed findings below describe the pre-fix baseline. The implementation now provides:

| Finding | Implemented behavior | Regression evidence |
| --- | --- | --- |
| F1 | Small catalogs are direct; larger catalogs retain validated discovery fingerprints across turns and reopen. Discovery and normal execution policy are separate. | 3-tool and 100-tool gateway/provider/approval journeys across two turns; complete tool-definition comparison; SQLite reopen and stale-definition checks |
| F2 | Stdio cancellation/timeout retires the process generation; a new explicit call can reconnect. Siblings retain an unknown connection-failure outcome. | Real SDK subprocess timeout/cancel and new PID; concurrent caller tests with no replay |
| F3 | SDK cursor preservation and bounded page aggregation | Real SDK HTTP continuation pages; cycle, duplicate, count, byte, and cancellation regressions |
| F4 | Tools/resources fail independently; incompatible schemas are isolated per tool, with partial discovery status | Healthy tool execution after resource/schema failures; bounded capability diagnostics |
| F5 | In-flight discovery is shared; later refreshes can retry. Cached/live registrations reuse the manager's client. | Concurrent refresh, independent cancellation, recovery, and close during cache save |
| F6 | Shared integration catalog normalization resolves aliases using raw identity | Raw protocol routing, discovery-order stability, reserved names, duplicate identity rejection |

`ExtensionToolCatalog` prepares routes, approval policies, and search indexes before publishing
them with the run's source snapshot. Existing MCP and Plugin API v2 tools use this boundary;
protocol and process-host ownership remain separate. Runtime snapshots retain their existing
count/byte limits and definition-matching checks.

Generic exposure uses fewer than 100 tools / 128 KiB for direct catalogs and up to 64 retained
schemas / 128 KiB for larger catalogs. OAuth, elicitation and native discovery were implemented
in the subsequent interaction phase below. Plugin package lifecycle redesign remains separate.
Matching serialized tool definitions is verified; actual remote prompt-cache hits are not claimed.

Implementation contracts and current user behavior are documented in
[MCP runtime contract](../../.trellis/spec/backend/mcp-runtime-contract.md) and
[Node extensions](../node-extensions.md).

## Policy And Management Follow-up

The next phase adds separate startup/call deadlines, working directories, required-server readiness,
raw tool filters, and server/tool approval modes. Stdio process permissions now have an explicit
startup policy and owned domain proxy. HTTP enforces the network bound and rejects redirects.
Management provides atomic user config add/remove and remembered approval inspection/revocation.
Session and persistent tool grants bind configuration and schema fingerprints, independently of
Shell rules. See Node extensions for exact semantics and platform limits.

The baseline for this phase is the local `codex-rs/config/src/mcp_types.rs`, `cli/src/mcp_cmd.rs`,
and `core/src/mcp_tool_call.rs`. Official documentation requests returned HTTP 403 during the audit;
this comparison does not assert parity with a verified latest Codex release.

## Authentication, Interaction And Native Discovery Follow-up

Explicit `mcp login/logout` now support SDK OAuth discovery, dynamic or pre-registered public
clients, PKCE/state, bounded loopback callbacks, private credential files and serialized refresh.
Runtime refresh never opens a browser. Network policy applies to authentication endpoints as well.

MCP form/URL elicitation now reaches the live gateway and the existing visible interaction queue.
Typed fields, explicit submission/decline/cancel, schema correction and connection/session cleanup
are integrated without a second model call or durable turn suspension. Waiting for user input
pauses the execution timeout; each prompt is independently bounded. Responses are not written to
the transcript by the elicitation broker. The shared client cancels requests without one unambiguous
active session/turn owner; startup/resource elicitation and task-augmented requests remain unsupported.

Discovery fingerprints now survive canonical projection, model-input ledger validation,
compaction replacement and Worker RPC.
After matching against authorized schemas, pi-ai receives `addedToolNames` at the discovery result.
It serializes native Responses tool-search/additional-tools history or Anthropic tool references
where supported, and ordinary functions elsewhere. Local search stays a regular mycli tool adapter;
the SDK supplies the native schema-load items. This does not claim an identical Codex dispatcher or
measure actual cache hits. Plugin-contributed OAuth login management remains future plugin work.

Deterministic coverage includes real loopback OAuth state/PKCE/rotation/logout, SDK MCP requests
through the application gateway, delayed/cancelled input, narrow/CJK TUI rendering, and real pi-ai
wire requests for native/fallback routes. See the interaction task verification record for full gates.

## Implementation Verification

The authentication/interaction/native-discovery phase passed build, lint, typecheck, contracts/config
drift and all 428 CI test files in one run (210.0 seconds): 342 unit, 29 contract, 48 integration,
8 platform and 1 release. Final review corrected a missing model-input canonical-field allowlist,
rejected malformed loopback callback URLs without throwing from the HTTP listener, and synchronized
MCP journey tests with idle notification before the next submission. Authentication and provider
fixtures were local; no live-service compatibility or prompt-cache hit rate was measured.

The final policy/management phase passed build, lint, typecheck, contracts/config drift, and all
422 CI test files in one run (226.1 seconds): 339 unit, 29 contract, 45 integration, 8 platform,
and 1 release. Real macOS MCP tests cover default networking, filesystem isolation, explicit/managed
offline behavior and proxy cleanup on exit/timeout/cancel. Serial and parallel gateway/provider/HTTP
journeys cover session grants, remembered grants, reopen, revocation, and definition changes.

Earlier F1-F6 phase evidence:

- Build, repository lint, workspace typecheck, contract generation, and configuration reference
  drift checks passed. Final test-file changes also passed focused lint and app typecheck.
- Combined coverage spans all 416 cataloged test files: 335 unit, 29 contract, 44 integration,
  7 platform, and 1 release. Suite runs were followed by focused reruns for legacy mandatory-search
  expectations in M3/M4/M7, backend/child scope, and image/resource journeys. All observed failures
  were corrected; this evidence combines those runs rather than one uninterrupted full-suite pass.
- The M7 executable smoke was exercised against a loopback fixture provider, including extension
  approvals, persistence, and process cleanup. Image/resource replay also passed after cold resume.
- The 3-tool and 100-tool journeys compare complete serialized provider tool definitions across
  two user turns and verify that each invocation still follows approval policy.
- Documentation links/fences and `git diff --check` passed. No real provider, reported session, or
  deployed MCP endpoint was used for these checks; remote cache-hit behavior remains unmeasured.

## Assessment

Mycli already has MCP transports, discovery, cached catalogs, strict tool validation,
approval integration, resource tools, and bounded HTTP session recovery. The recurring
failures come from inconsistent ownership between those parts: discovery controls
execution eligibility, cancellation can permanently close a reusable client, and
catalog publication spans several independently updated consumers.

Preserve the existing package boundaries, SDK transport, frozen run snapshots,
transcript/effect ledger, validation, and structured errors. Make MCP lifecycle and
catalog contracts explicit within those boundaries. A package rewrite is unnecessary.

The inspected Codex implementation does **not** require every MCP tool to be searched
again on every user turn. Its small-catalog direct exposure and native discovery
protocol are materially different from mycli's per-turn activation mechanism.

## Baselines And Evidence

- Mycli: branch `refactor/mycli-runtime-architecture`, HEAD
  `68fbdd820d56d493d424d8870185f03f15242170`, including existing uncommitted fixes.
  HEAD alone does not identify the reviewed implementation.
- Codex: `/Users/cosmos/Downloads/codex-main`, an unpacked source tree without
  `.git`, with workspace version `0.0.0`. Its upstream commit, release version,
  and equivalence to the installed binary cannot be established.
- Official documentation requests returned HTTP 403. Conclusions about Codex
  refer to the inspected local source, not a verified current release.
- Five isolated probes used current mycli source with fake protocol clients or
  an injected HTTP fetch. They performed no external requests. The cross-turn
  finding is supported by the runtime/storage path and existing tests.
- The initial review used documentation and offline probes only. Implementation was subsequently
  authorized and is recorded above. The reported session and MCP configuration were not modified.
  Earlier unrelated changes remain in the working tree.

`M/` paths below are relative to this repository. `C/` paths are relative to the
local Codex source directory. Line references identify the reviewed working tree.

## What Codex Actually Separates

| Concern | Inspected Codex implementation | Mycli reviewed baseline |
| --- | --- | --- |
| Server identity and ownership | Resolved server catalog retains source/provenance; connection manager owns managed clients | Configuration, manager, integration composition, and app assembly each own part of the published state |
| Model exposure | Filtered catalogs below 100 tools are direct unless forced deferral is enabled; deferral also requires model search support | MCP tools enter the deferred catalog and require per-turn activation |
| Discovery results | `tool_search` returns full `LoadableToolSpec` schemas in a typed `ToolSearchOutput` conversation item | Ordinary text result returns names/descriptions; a side effect adds schemas to the next request's top-level tools |
| Executable routes | Registry contains direct and deferred runtimes; discovery is separate from registry lookup and approval | Router already retains allowed deferred routes, but the runtime rejects calls absent from the current exposure list |
| Refresh | Session builds a replacement connection manager and swaps it when a pending refresh is applied at a turn boundary | Startup cache and live discovery coexist; `refresh()` itself is permanently memoized |
| Recovery | Typed expiry recovery, shared reconnection coordination, bounded discovery retries, and separate OAuth handling | HTTP generation recovery exists, including a ModelScope compatibility case; local stdio cancellation closes the entire client |
| Policy | Server/per-tool settings, annotations, session approval memory, and elicitation have distinct roles | MCP registrations receive the shared `request` policy; annotations are reduced to a parallel-call hint |

Key Codex evidence:

- `C/codex-rs/codex-mcp/src/catalog.rs`: configured sources and resolved catalog.
- `C/codex-rs/core/src/mcp_tool_exposure.rs:14`: threshold and direct/deferred
  selection. `ToolSearchAlwaysDeferMcpTools` defaults to false in
  `C/codex-rs/features/src/lib.rs:1060`.
- `C/codex-rs/core/src/tools/spec_plan.rs:232`: visible schemas are selected
  separately from construction of the executable registry at line 261.
  Search support comes from model metadata at line 328; the search executor also
  requires provider namespace support at line 941.
- `C/codex-rs/core/src/tools/handlers/tool_search.rs:118`: searches deferred
  metadata and returns loadable schemas. Its search index is reused when metadata
  is unchanged. `C/codex-rs/core/src/tools/context.rs:144` projects the result as
  `ResponseInputItem::ToolSearchOutput`, retained through the history layer.
- `C/codex-rs/core/src/tools/registry.rs:405`: dispatch uses registered identity,
  without mycli's per-turn activation gate. Normal hooks and policy still apply.
- `C/codex-rs/core/src/session/mcp.rs:306`: replacement manager ownership and
  pending refresh application. The refresh tests cover next-turn application.
- `C/codex-rs/rmcp-client/src/rmcp_client.rs:940`: bounded recovery after typed
  session expiry; concurrent callers coordinate rather than reconnect independently.
- `C/codex-rs/config/src/mcp_types.rs:130` and
  `C/codex-rs/core/src/mcp_tool_call.rs:1036`: configuration and approval decisions.

For the user's current 14-tool catalog, the inspected exposure rule would normally
choose direct tools, subject to enabled tools and feature settings. The constant
100 is a property of this source snapshot, not a universal MCP rule or an automatic
choice for every mycli provider.

Two limits to the comparison matter:

- The inspected Codex startup tool-list path also requests only the first page
  (`C/codex-rs/codex-mcp/src/rmcp_client.rs:349`). Its lower client preserves
  `next_cursor`, but this caller drops it. Tool pagination is a mycli completeness
  requirement, not demonstrated Codex parity.
- The inspected persistent/startup tool-cache special handling is for Codex Apps.
  It does not establish identical disk-cache behavior for every ordinary MCP server.

## Confirmed Problems

No P0 was established. F1 and F2 are P1 reliability problems; F3-F6 are P2
integration/lifecycle defects. F1 describes a problematic current contract, not
an accidental regression introduced by the latest fixes.

### F1. P1: Discovery Is Used As A Per-Turn Execution Gate

Trigger: a tool is discovered and used, then the model reuses that known tool on
the next user turn without searching again. The tool can still be registered and
allowed, yet execution is rejected because activation is loaded only for this turn.

- Evidence: `M/backend/packages/storage/src/transcript/transcript-event-repository.ts:2010`
  reads turn-local activations; app binding is in
  `M/backend/apps/mycli/src/node-runtime/node-backend.ts:1250`.
  `M/backend/packages/runtime/src/turns/node-turn-runtime.ts:1533` builds exposure
  from them; `M/backend/packages/runtime/src/tools/tool-batch-coordinator.ts:207`
  rejects calls outside exposure before normal execution policy.
- `M/backend/packages/tools/src/registry/tool-search-tool.ts:75` returns metadata
  and an activation side effect. The runtime invalidates provider continuation
  on changed exposure at `M/backend/packages/runtime/src/turns/node-turn-runtime.ts:1053`.
  Existing runtime tests assert activation, continuation invalidation, and the
  explicit recovery hint for unactivated calls.
- The recent hint improves recovery after rejection; it does not fix the lifecycle.
- Required contract: model discovery, allowed registered tools, and approval are
  separate decisions. Preserve the current frozen run catalog and definition
  matching in `M/backend/packages/tools/src/registry/router.ts:43`.

### F2. P1: Canceling A Local Stdio Call Permanently Closes Its Client

Trigger: cancel a pending local MCP call, then explicitly invoke another tool on
that server. The second call fails with `mcp_client_closed`.

- Evidence: `M/backend/packages/integrations/src/mcp/connection.ts:55` invokes
  permanent `close()` on stdio abort; line 63 does the same for stdio timeout.
  Existing registrations keep the same client. The probe observed one protocol
  call, one close, and a subsequent `mcp_client_closed` without a second dispatch.
- Required contract: permanent host shutdown differs from retirement of one
  connection/process generation. Cancellation must not replay the canceled call.
  If stopping the process is necessary, a later explicit call can start a new
  generation. Concurrent calls affected by that retirement need explicit outcomes.
- Existing immediate-close tests do not cover that next-call journey. This is a
  mycli lifecycle requirement; the review does not claim identical Codex stdio
  cancellation behavior was reproduced.

### F3. P2: Tool Discovery Silently Drops Additional Pages

Trigger: `tools/list` returns tools and `nextCursor`. The SDK wrapper returns
only tools, so tools on later pages never enter the catalog.

- Evidence: `M/backend/packages/integrations/src/mcp/client.ts:187`. An injected
  HTTP server returned `first` plus a cursor; the client made one list request and
  returned only `first`, although a second page contained `second`.
- Required contract: retain cursors at the protocol boundary and finish bounded
  discovery, with duplicate/cycle checks and cancellation. Resource pagination
  already provides related implementation patterns.

### F4. P2: Resource Discovery Failure Disables Healthy Tools

Trigger: a server advertises resources, returns valid tools, but fails
`resources/list`. Startup discards the tool registrations and closes the client.

- Evidence: `M/backend/packages/integrations/src/mcp/manager.ts:318` waits for
  both lists and treats either rejection as whole-server failure. The probe
  returned a healthy tool list but observed `failed` with zero tools.
- Missing resource capability is already handled as an empty list; the defect
  concerns a failure of an advertised optional capability.
- Required contract: connection health and tools/resources capability health
  are distinct. A resource-only failure must retain usable tools and its own
  diagnostic rather than report full readiness or total server failure.

### F5. P2: Refresh Cannot Retry Discovery After Its First Result

Trigger: discovery fails, the server recovers, and `refresh()` is invoked again.
The first settled promise is reused, so discovery never runs again.

- Evidence: `M/backend/packages/integrations/src/mcp/manager.ts:79` never clears
  `#refreshPromise`. The probe observed `failed` twice and one client start after
  switching the fake server into a healthy state.
- Current app composition normally performs one live refresh per manager at
  startup. This is a lifecycle/recovery gap, not evidence that every TUI refresh
  command directly hits this method. CLI inspection creates a separate manager;
  its success does not establish health of a running session's client.
- Required contract: concurrent refreshes share only the in-flight operation;
  later refreshes can create a new catalog generation. Publication, cancellation,
  and retirement of clients used by older turns must be coordinated.

### F6. P2: Normalized Name Collisions Reject A Valid Tool Batch

Trigger: one server exports both `foo-bar` and `foo_bar`. Distinct raw identities
become the same model-facing tool name, and router publication rejects the batch.

- Evidence: `M/backend/packages/integrations/src/foundation/ids.ts:26` sanitizes
  before collision handling and hashes only overlong sanitized names.
  `M/backend/packages/tools/src/registry/router.ts:157` rejects duplicates.
  The real registration/router probe produced identities `mcp:demo:foo-bar` and
  `mcp:demo:foo_bar`, both named `mcp_demo_foo_bar`, followed by
  `duplicate_tool: mcp_demo_foo_bar` and zero published routes.
- This proves batch rejection at the publication boundary, not a reproduced
  whole-process crash. Cross-server normalization can cause similar collisions.
- Codex preserves raw identity and resolves sanitized namespace/tool collisions
  using that identity: `C/codex-rs/codex-mcp/src/tools.rs:147`.
- Required contract: deterministic unique model aliases with reversible routing
  to raw server/tool identity. Preserve aliases across ordinary refreshes and
  reconcile any changed aliases with session history.

## Structural And Capability Gaps

These are design gaps, not additional independently reproduced defects:

- **Catalog publication:** `refreshExtensions()` in
  `M/backend/apps/mycli/src/node-runtime/node-backend.ts:1014` updates router,
  approval registrations, and search candidates separately. The recent ordering
  fix is correct, but one validated catalog version should drive all consumers.
- **Cache versus live ownership:** cached and live registrations can reference
  different client generations. `McpManager` retains them in `#lifecycles` until
  shutdown. Define when each generation can retire without invalidating active
  turns. Mycli already distinguishes `cached`, `loading`, `ready`, and `failed`
  in `integration-resource-catalog.ts`; retain that distinction.
  `integration-composition.ts:827` intentionally retains cached tools when live
  discovery fails, with a failure category. Cached metadata is not live health.
- **Schema boundaries:** retain the raw MCP schema, host validation result, and
  provider projection separately. An unsupported schema currently fails its
  whole server during registration. Prefer an explicit per-tool incompatibility
  result while preserving healthy siblings. Keep strict validation and the
  recent standard-format support; do not silently weaken input checks.
- **Configuration:** mycli has one timeout for initialization and calls, static
  headers/environment authentication, and no equivalent complete OAuth or
  elicitation lifecycle. Codex models these separately and supports required
  servers, per-server tool filters, and per-tool approval settings.
- **Local process policy:** `integration-sandbox.ts:3` always assigns local MCP
  workspace-write access with network disabled. That can prevent a local MCP
  which needs networking from functioning, even when the active agent policy
  differs. Define and document an explicit MCP process policy; do not accidentally
  inherit all Shell grants or silently disable sandboxing.
- **Annotations:** `client.ts:64` reduces MCP annotations to a parallel-call
  boolean. Preserve raw hints and let policy interpret them under explicit user
  configuration. A read-only hint is not itself a user authorization grant.

## Caching And Cross-Turn Behavior

Four distinct states must not be called simply "the cache":

| State | Purpose | Relevant invalidation |
| --- | --- | --- |
| MCP catalog cache | Reuse discovered metadata during startup | Server/config/schema identity changes |
| MCP transport session | Protocol connection and remote session ID | Expiry, transport retirement, authentication, shutdown |
| Provider continuation | Continue via an upstream response/session reference | Request compatibility changes; mycli explicitly invalidates on changed tool exposure |
| Provider prompt cache | Provider-side reuse of a matching input prefix | Changes to that provider's serialized prefix; actual reuse must be measured |

Keeping work within one turn does not by itself preserve prompt caching, and
starting another user turn does not inherently destroy it. Mycli's addition and
removal of top-level schemas can change the reusable prefix. The observed
continuation invalidation is not proof that every provider loses its entire
prompt cache.

Codex's native search path appends schema-bearing discovery items to history;
it does not use mycli's ordinary text result plus activation-driven replacement
of top-level schemas. No provider cache-hit measurement was performed here.

For mycli, use a provider-aware strategy:

1. Directly expose small allowed catalogs with stable serialization and ordering.
2. Use native tool discovery only when both model and provider protocol support
   its request/result/history representation. Mycli's current canonical/provider
   path has no equivalent typed search-output projection; adding a capability
   boolean alone cannot implement it.
3. For generic function-calling providers with large catalogs, retain selected
   schemas across the session as a fallback, reconcile them against the current
   allowed catalog, and bound the schema budget. This is a proposed mycli fallback,
   not an exact description of Codex. Adding a new schema can still alter the
   prefix; session retention avoids repeated removal and rediscovery.

Do not merely delete `turnId` from activation storage or remove all execution
checks. Disabled tools, schema changes, cold resume, provider switching, and
frozen run authority still need explicit reconciliation.

## Recommended Ownership And Delivery Order

| Existing layer | Contract it should own |
| --- | --- |
| integrations: configuration/catalog | Raw identities, provenance, aliases, per-tool compatibility, versioned catalog and capability health |
| integrations: client/connection | Initialization, live connection generations, request cancellation, expiry, retirement, permanent shutdown |
| runtime | Frozen allowed catalog for a run; session discovery state reconciled with current configuration |
| providers | Direct/native/fallback schema projection and continuation compatibility |
| tools | Registered routing, strict arguments, approval and hooks, execution outcomes |
| app/gateway/TUI | Assembly and projection of catalog/health/approval events from those owners |

### Stage 1: Make Catalog And Connection Lifecycle Reliable

Address F2-F6 together around explicit ownership contracts: replaceable stdio
generations, repeatable/coalesced refresh, bounded pagination, capability-local
failure, unique aliases, and one validated catalog publication consumed by
router/search/policy. Keep clients used by frozen active runs alive until released.
Specify normal next-turn configuration adoption separately from urgent revocation.

Keep the recent ModelScope expiry compatibility fix in the transport error
normalization boundary. It recognizes a narrowly bounded `401` response with
the machine code `SessionExpired`; the inspected Codex path handles typed HTTP
404 expiry and does not demonstrate this ModelScope-specific behavior. Ordinary
401 remains authentication failure, and uncertain tool execution must not trigger
blind replay.

### Stage 2: Separate Discovery From Execution And Stabilize Exposure

Address F1 with direct exposure for small catalogs and a bounded generic-provider
fallback. Plan native discovery as an explicit canonical/provider capability.
Keep approval independent of whether the model discovered a tool in this turn.
Use captured serialized requests and provider-reported usage to evaluate prefix
stability and actual cache reuse, instead of inferring it from turn IDs.

### Stage 3: Complete Policy, Authentication, And Diagnostics

Separate startup/call timeouts, tool filters and approvals, local MCP process
permissions, auth state, capability failures, and tool business errors. Add
OAuth and elicitation through explicit capability contracts when implemented.
The TUI should project those states without inventing a second health model.

## Acceptance Journeys

Before calling the redesign complete, exercise transitions as well as isolated calls:

- Discover, call, finish the turn, then reuse the tool in the next user turn;
  validate direct, generic fallback, and supported native-provider paths separately.
- Cancel or time out a local call, then explicitly call again; canceled work is
  never replayed, and concurrent callers receive accurate outcomes.
- Fail resources while tools work; reject one incompatible schema while healthy
  sibling tools remain usable and the diagnostic identifies the failing capability.
- Load multiple tool pages, reject cursor cycles and excessive results, cancel
  discovery, and verify normalized names remain unique and deterministic.
- Refresh after failure and recovery; overlap refresh callers; change configuration
  while an older run is active; verify router, search, policy, and status refer to
  the intended catalog generation and released clients close exactly once.
- Recover concurrent confirmed session expiry once; distinguish ordinary 401,
  initialization failure, remote business error, and uncertain execution without
  indiscriminate retry.
- Resume cold, remove/disable a tool, change its schema, or switch provider; stale
  discoveries cannot grant access or silently route to a different raw tool.
- Capture serialized request prefixes and continuation decisions across turns;
  report actual cache usage only when the provider supplies evidence.

## Probe Results And Source Fingerprints

The ad hoc probes imported source using Node with `--conditions=mycli-source
--import tsx --input-type=module`. They are audit evidence, not newly committed
regression suites. The pagination probe exercised the actual MCP SDK transport
with an injected fetch; lifecycle probes used fake protocol/client implementations;
the name probe used actual tool registration and router publication.

| Probe | Observed result |
| --- | --- |
| Two-page tools list | One page requested; only `first` returned |
| Healthy tools, failed resources | Server `failed`; zero tools retained |
| Refresh after server recovery | `failed` before and after; one discovery start |
| Explicit call after stdio cancellation | One close; next call `mcp_client_closed`; no second dispatch |
| `foo-bar` and `foo_bar` | Same model alias; `duplicate_tool`; zero routes published |

SHA-256 fingerprints of inspected Codex files:

```text
C/codex-rs/core/src/mcp_tool_exposure.rs
5b88c3b62c894d19b33cb80d7328b1b55593470ef2f1fef7c0fb10e8bcb5e96d
C/codex-rs/core/src/tools/handlers/tool_search.rs
58b0222cfa2190a897feab5be9bfdf6066b323040b5b95253a5bb294de3ef5c3
C/codex-rs/core/src/tools/context.rs
b4236086a9adff8c9d221c95735609e5e8596b17442eedaf31456a213e187788
C/codex-rs/codex-mcp/src/connection_manager.rs
d66ad79181506e0938641ff35b1a00b9abeaac59494b2fda262e818dc0265879
C/codex-rs/rmcp-client/src/rmcp_client.rs
0d4463d9680adf0fd3b965954ce7a1b21d017ffd96ca7adbc98a409b6a98d3ce
```
