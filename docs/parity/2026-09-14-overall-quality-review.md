# Mycli Overall Quality Review

Date: 2026-09-14. Baseline: `de0df111` on `refactor/mycli-runtime-architecture`.

## Scope And Assessment

The core coding-agent capabilities are implemented: provider routing, tools and approvals,
persistent sessions, compaction, worker execution, MCP, plugins, skills, and interactive slash
workflows. The next investment should improve reliability and delivery evidence across these
boundaries.

This was a targeted source review across runtime composition, provider streams, extension
management, TUI state, diagnostics, and release tooling. It was not an exhaustive review of every
source file. No P0 issue was confirmed in the inspected paths. The P1 findings below include two
new isolated reproductions and one already documented release blocker. Recommendations are
distinguished from reproduced failures.

The resolved F1-F6 findings in the September 7 runtime and September 11 MCP audits are not counted
again. Historical audit line numbers and architecture descriptions are not assumed current.

The findings describe the baseline above. The accepted P1 batch is resolved below; P2/P3 work
remains outside this batch.

## Prioritized Findings

| ID | Priority | Evidence | Improvement |
| --- | --- | --- | --- |
| F1 | P1 | Reproduced | Keep default Doctor and repair preview free of extension process startup |
| F2 | P1 | Reproduced | Bound the hosted-search stream queue and respect downstream demand |
| F3 | P1 | Existing reproduced failure | Restore the provider-free startup boundary and pass packed release smoke |
| F4 | P2 | Verified tooling gap | Include TUI in the lint gate with terminal-specific rule configuration |
| F5 | P2 | Reproduced output | Give failed diagnostics an actionable recovery path |
| R1 | P2 | Source inspection; product improvement | Preserve unsent input across an unexpected process exit |
| R2 | P2 | Source inspection; architecture debt | Retain typed events and reduce composition hotspots |
| R3 | P2 | Corpus and evidence inspection | Expand workflow and provider compatibility evaluation |
| R4 | P2 | Documented and code-enforced limitation | Complete platform-specific constrained networking when supporting those deployments |

### F1. Default Doctor Starts Configured MCP Processes

`collectExtensionChecks()` calls `McpManagementService.list()`, whose discovery path starts the
configured MCP clients. `DoctorManagementService.execute()` runs this report before choosing
between ordinary checks, repair preview, and support output. Plugin management also loads an
enabled Plugin API v2 runtime during listing.

An isolated compiled-CLI probe configured one local MCP command that wrote a marker and exited.
Running ordinary `mycli doctor --json` created that marker. The command finished in under a second;
no user configuration, actual MCP endpoint, or model request was involved. The unsuccessful MCP
handshake does not change the conclusion: the configured command executed during diagnostics.

This conflicts with the repository's default-Doctor contract in
`.trellis/spec/backend/quality-guidelines.md` and the read-only repair-preview behavior documented
in `docs/diagnostics-and-updates.md`. A configured launcher can have startup side effects even
without calling an MCP tool, such as package installation or creation of server state.

Separate metadata/configuration checks from an explicit live probe. Keep ordinary Doctor and
repair preview on the metadata path; give a live check clear process ownership, timeouts, and
cleanup. Cover the real compiled CLI with a configured process-start marker, in addition to
injected client tests.

Sources: `backend/apps/mycli/src/management/doctor/check-extensions.ts:124`,
`backend/apps/mycli/src/management/doctor/service.ts:69`,
`backend/packages/integrations/src/mcp/management.ts:163`, and
`backend/packages/integrations/src/plugins/management.ts:142`.

### F2. Hosted Search Eagerly Buffers The Upstream Stream

When `webSearchMode` is `live`, `PiAiWebSearchStream.merge()` starts a producer that continuously
calls `iterator.next()` and enqueues every SDK event. `highWaterMark: 0` does not enforce a bound
when that producer calls `enqueue()` without checking demand. The search-call count limit does
not limit the queued text or tool events.

A finite, provider-free probe supplied 1,000 SDK text events. After the consumer read exactly one
event and yielded to the event loop, the bridge had consumed all 1,000 and retained 999. This
confirms missing backpressure; an out-of-memory crash was not reproduced or claimed.

For a fast upstream and a slow downstream, retained events can grow with the response. Preserve
the existing native-search/text ordering with a demand-aware merger or an explicitly bounded
queue, including a byte bound and well-defined cancellation and overflow behavior. Add slow-reader
coverage; retain the existing order, UTF-8, early close, and cancellation tests.

Sources: `backend/packages/providers/src/pi-ai/pi-ai-web-search.ts:68`,
`backend/packages/providers/src/pi-ai/pi-ai-web-search.ts:130`, and
`backend/packages/providers/src/pi-ai/pi-ai-provider.ts:123`.

### F3. Packed Release Smoke Is Still Failing

The September 12 installed-package verification completed runtime bootstrap but failed the final
assertion that provider-free startup does not load curated pi-ai provider modules. Both the fixed
MCP package and an isolated package with the two pre-fix MCP implementations restored loaded the
same 12 curated provider/model modules. The stale slash count was corrected separately to 42.

The current code still connects startup preference resolution with provider-directory capture;
`ProviderModelDirectory.load()` loads the complete pi-ai directory. The release smoke still
requires that directory to remain unloaded during the provider-free startup journey. Align the
implementation and intended startup contract, then run the installed-artifact gate. Do not
describe unit-test success as successful release validation or simply remove the assertion.

This review reused the existing comparison evidence at the unchanged implementation baseline.
It did not repeat dependency downloads or rerun the complete packaging pipeline.

Sources: `backend/apps/mycli/src/node-runtime/node-backend.ts:1779`,
`backend/apps/mycli/src/node-runtime/provider-model-directory.ts:110`, and
`scripts/smoke_packed_cli.mjs:923`.

### F4. The Root Lint Gate Omits TUI

The root `lint` script selects only `backend/apps/**/*.ts` and `backend/packages/**/*.ts`.
The TUI workspace has type checking and tests, but no separate lint command. CI invokes the root
lint script, so a successful lint check does not cover TUI code.

Running the existing ESLint configuration explicitly against TUI checked 251 files and reported
161 errors in 39 files. These are not 161 product bugs: 111 concern control-character regexes and
26 concern repeated spaces in regexes, both common in terminal code and rendering assertions.
Configure narrow, justified terminal exceptions before treating the remaining findings as work.
Then include the workspace in the normal gate, along with suitable dependency-boundary checks.

Sources: `package.json:22`, `eslint.config.js:8`, and `tui/mycli-shell/package.json`.

### F5. Diagnostic Recovery Can Point Back To The Same Failed Diagnostic

The F1 probe returned an MCP transport failure whose sole recovery action was `mycli doctor`,
even though the user had just run Doctor. `recoveryActionsFor()` supplies that action to every
otherwise-unmapped failed check. The MCP row aggregates counts and failure classes without a
specific next action for the affected server.

Retain bounded, redacted output while distinguishing configuration, missing executable, startup,
transport, authentication, and tool-call failures. Give each an applicable inspection or recovery
action; do not generate a self-referential Doctor action within Doctor itself. Existing error
taxonomy can support this without adding a parallel error system.

Source: `backend/apps/mycli/src/management/doctor/runner.ts:302`.

## Further Improvements

### R1. Protect Unsent Input Across Crashes

Composer drafts and attachment/skill references are saved in an in-memory per-session map when
switching sessions. Unexpected gateway closure stops the local UI and exits with diagnostics.
There is no durable draft recovery in this path. This is an input-recovery feature gap, not
evidence that committed conversation history is lost.

Add bounded, private draft persistence and an explicit restore action after reopening. Preserve
the existing rule that restoring a session does not revive approvals, questions, or old live
Shell processes, and never automatically resubmit a possibly dispatched operation.

Sources: `tui/mycli-shell/src/application/shell-runtime.ts:193`,
`tui/mycli-shell/src/application/shell-runtime.ts:2325`, and
`tui/mycli-shell/src/application/gateway-session.ts:1319`.

### R2. Preserve Types And Reduce Composition Hotspots

`DecodedRuntimeEvent` retains a method but erases its associated payload into
`Readonly<Record<string, unknown>>`. Reducers then parse fields again. This loses compile-time
coverage for missing or mismatched event fields; it does not demonstrate that wire validation
has been bypassed. Retain a discriminated event union through decoding and isolate synthetic and
legacy compatibility inputs.

Several production modules remain large despite the existing package separation:

| Module | Lines at this baseline |
| --- | ---: |
| `backend/packages/storage/src/transcript/transcript-event-repository.ts` | 4,785 |
| `tui/mycli-shell/src/application/shell-runtime.ts` | 2,977 |
| `backend/apps/mycli/src/node-runtime/node-backend.ts` | 2,961 |
| `backend/packages/storage/src/sessions/sqlite-session-store.ts` | 2,895 |

Size alone is not a defect. The concern is responsibility concentration: `startNodeBackend()`
spans roughly 2,000 lines of provider, session, worker, extension, and gateway assembly. Extract
one ownership boundary at a time, backed by existing integration tests. Avoid a wholesale rewrite
or file movement without a corresponding reduction in responsibility.

Sources: `tui/mycli-shell/src/state/runtime-events.ts:3`,
`tui/mycli-shell/src/state/runtime-events.ts:27`, and
`backend/apps/mycli/src/node-runtime/node-backend.ts:311`.

### R3. Broaden Evidence For Actual Agent Quality

The coding corpus contains three small tasks; the prompt corpus contains seven next-response
scenarios. They provide useful deterministic harness coverage, but do not establish broad coding
quality, multi-turn reliability, or compatibility with every advertised provider/model.

Extend the isolated corpus with multi-file changes, failed-tool recovery, interruption and resume,
approval rejection, MCP reconnection, browser workflows, compaction, and provider switching.
Keep live provider checks separately authorized and bounded. Record success, duration, tool calls,
and provider-reported token/cache usage without equating missing measurements with zero.

The existing provider-catalog release report explicitly marks six provider routes as not live
verified. Those historical results should be refreshed for the actual supported release matrix;
they are not proof that the routes are broken.

Sources: `docs/coding-evaluation.md:3`, `docs/coding-evaluation.md:58`, and
`docs/parity/pi-ai-provider-catalog-release-evidence.md:18`.

### R4. Keep Platform Capability Differences Visible

Domain-constrained Shell and stdio MCP networking currently use the macOS proxy enforcement.
Linux and Windows reject an enabled nonempty domain restriction with
`network_proxy_unavailable`. This is a deliberate fail-closed capability limitation, not a
confirmed permission bypass. Complete and test native enforcement before promising that policy
on those platforms; retain clear capability reporting meanwhile.

Sources: `backend/packages/tools/src/shell/shell-tool.ts:270`,
`backend/packages/integrations/src/mcp/sdk-transport.ts:47`, and `docs/network-policy.md`.

## Lower-Priority Product Maintenance

- Include a build revision or artifact identity in version/Doctor output. The application currently
  derives its visible version from `package.json`; different local installations can all report
  `0.1.0`, making it harder to verify whether a fix is installed.
- Add reference-aware cleanup for retained plugin snapshots. The current retention policy correctly
  protects active sessions, but repeated updates consume disk until cleanup is implemented. See
  `docs/plugin-codex-parity.md:198`.
- Mark historical roadmaps clearly and maintain a current short backlog. For example,
  `docs/parity/tui-development-roadmap.md` still contains Python-as-source-of-truth execution rules,
  which conflict with the current Node runtime architecture.

## Verification And Suggested Delivery Order

This review ran two isolated probes and the existing Doctor-extension and hosted-search suites:
24 tests passed. The TUI lint run failed as described in F4. The full 445-file repository suite
passed during the preceding MCP implementation; it was not rerun during this source-only review.
No real model or user-configured extension was called.

Suggested batches:

1. Fix F1 and F2 with the missing end-to-end/slow-consumer regressions, then close F3's packed
   startup gate. These are the highest-priority reliability and release items.
2. Address F4/F5 and R1, then preserve typed events from R2. These improve maintenance feedback
   and user recovery without changing core execution behavior.
3. Extract the largest composition responsibilities incrementally and expand R3's release corpus.
   Schedule R4 against the operating systems and network policies the release promises to support.

## P1 Resolution

The three accepted P1 findings are fixed:

| Finding | Result | Regression evidence |
| --- | --- | --- |
| F1 | Doctor, repair preview, and support collection inspect metadata without starting MCP or Plugin API v2 processes; rows report `runtime=not_probed` | Compiled CLI startup markers remain absent; explicit MCP inspection discovers two tools and releases the server process; trust filtering and missing environment metadata are retained |
| F2 | SDK delivery and SSE acknowledgements honor consumer demand; pending events are capped at 64 and 8 MiB of serialized UTF-8 | The 1,000-event probe reads at most two events after consuming one; long interleaving, overflow classification, cancellation, blocked SSE, and noncooperative iterator cleanup pass |
| F3 | Startup/session configuration avoids the complete pi-ai catalog; selected native auth uses typed lazy SDK loaders | Nine compiled startup credential scenarios pass; single-model selection loads only its provider; explicit full discovery retains all routes and models |

The stream bridge retains only visible deltas, native search activity, and the terminal SDK message;
it no longer keeps mutable intermediate assistant snapshots. Oversized pending output produces a
bounded `response_stream_error` instead of silent event loss. The provider continues to own transport
abort. Lazy provider wiring contains module/factory names only; models, wire compatibility, and auth
remain SDK-owned, with loader coverage checked against the pinned SDK directory.

Validation on macOS arm64 / Node 24.14.1:

- All 448 repository test files passed across unit (354), contract (31), integration (54), platform
  (8), and release (1) suites. The reviewed error-emitter inventory includes the new stream failure.
- Lint, all-workspace type checks, contracts/config drift, and whitespace checks passed.
- Packed smoke passed with one application and the current platform package: 10 installed journeys,
  six curated providers, one custom model, full directory imported on demand, and none on startup.
- The packed protocol probe now explicitly requests full directory discovery; a single provider
  snapshot no longer implicitly imports the catalog. Startup and full-discovery assertions remain.
- The existing review/rename test now waits for the idle status after terminal output before calling
  an idle-only command, and checks the RPC error directly. Its targeted rerun passed.

All provider execution used local fixtures. No real model or user-configured MCP request was sent.
The standalone `mycli` command was updated from the new tarball. Its 13 affected runtime files
match the build hashes; two isolated installed startup scenarios and the 1,000-event streaming
probe pass, with one event read ahead. Installed Doctor, repair preview, and support collection
leave extension startup markers absent; explicit MCP inspection still starts and closes its fixture.
The previously installed MCP launch transport is unchanged. This is local macOS evidence, not
new live-provider or cross-platform browser verification.
