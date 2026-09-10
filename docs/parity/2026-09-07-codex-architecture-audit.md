# Mycli Architecture Audit Against Local Codex Source

Date: 2026-09-07. Status: F1-F6 implemented and verified in this worktree; S1-S4 remain backlog.

## Implementation Status

The six reproduced behavioral findings have been addressed without restructuring packages or
replacing the existing runtime. The finding descriptions below preserve the audited failure modes
and source references; they describe the pre-fix baseline, not six still-open defects.

| Finding | Implemented behavior | Regression evidence |
| --- | --- | --- |
| F1 | Transactional checkpoint compare-and-set and guarded replacement commit; stale cleanup/success cannot mutate a successor; rehydration rechecks cancellation | Compaction coordinator races and two-connection SQLite regression |
| F2 | Committed completion survives Esc during a delayed terminal snapshot; interrupt acknowledgment rejects a completed turn | Real runtime/SQLite gateway admission integration |
| F3 | Cancelable admission before credential readiness; close drains it; late readiness/response cannot start or alter subsequent work | Cancellation, close, immediate successor, stale client interrupt, and reserved-failure cleanup regressions |
| F4 | Reserved direct and queued submissions own terminalization through setup and publication failure | SQLite reopen fault tests and queued configuration failure coverage |
| F5 | Summary calls share configured provider retries; checkpoint-owned attempt/usage journal, sanitized live/replay failures, isolated summary output | Fake provider/SQLite matrix plus actual backend/Worker/loopback SSE compaction retry and resume |
| F6 | Native Ctrl+C/EOF bypass pending ordinary input; stale queued lines do not execute after close | Deferred native submission control tests; shutdown drains manual compaction |

Summary attempts reuse `ProviderAttemptUpdate` and the common executor, but use a checkpoint-owned
append-only transcript journal. The ordinary provider-attempt table requires a normal turn and a
request manifest; manual compaction deliberately creates neither. This avoids mutating the main
instruction/tool/input timeline to represent an internal summary request. Safe attempt outcomes,
reported per-attempt usage, and final errors survive reopen. Usage absent from the upstream stream
remains unknown. Summary usage is separately recorded and added to successful owning-turn totals.

The existing S1-S4 structural/platform backlog below remains open. No live coding comparison,
installed-binary update, cross-platform certification, automatic commit, or modification of the
reported user session is part of this stabilization task.

## Stabilization Verification

- `npm test`: 352 files passed (296 unit, 22 contract, 28 integration, 5 platform,
  and 1 release file) on this macOS/Node 24 environment.
- After final ownership, replay filtering, and trace adjustments, the seven affected
  coordinator/model, gateway/admission, Worker/SSE, native input, and TUI error-display
  suites passed again: 191 tests, zero failures. The compiled CLI smoke was included.
- Final `npm run build`, `npm run lint`, `npm run typecheck`, `npm run contracts:check`,
  `npm run config:check`, and `git diff --check` passed.
- All provider execution used injected providers or loopback SSE. No live model call,
  production-session mutation, staging, or commit was performed.

The final focused run followed completion of the build. An earlier overlapping run had
three smoke failures while the build temporarily removed `dist`; those failures were
resolved by sequencing the checks, without changing business behavior.

## Assessment

Mycli has established package boundaries and substantial runtime infrastructure.
The remaining reliability problem is inconsistent enforcement of lifecycle,
ownership, and terminal-state rules across those boundaries. The local Codex
source provides useful examples of central task finalization, task-owned cleanup,
typed protocol projection, and common tool orchestration.

The highest-priority work is to make existing contracts hold across every entry
and exit path. Preserve mycli's multi-provider boundary, transactional terminal
records, request-input ledger, effect ledger, and frozen execution snapshots.
No rewrite of the package structure or adoption of Rust is indicated by this audit.

There are six behavioral findings below: four from the preceding Esc audit and
two additional reproductions from this comparison. Structural concerns and
platform capability differences are listed separately and are not additional
confirmed bugs. Historical reports from another worktree, including the older
74-item lifecycle ledger, are not a current defect count.

## Baselines And Evidence

- Mycli: `refactor/mycli-runtime-architecture`, HEAD
  `1598f84ba11e5274b54404d104e9a0da2ec62e04`, including the current working tree.
  There were 658 dirty entries at audit start; HEAD alone does not identify the
  implementation reviewed here.
- Codex: local source at `/Users/cosmos/Downloads/codex-main`. It is an unpacked
  source tree without `.git`; its workspace version is `0.0.0`. An upstream commit
  or release version cannot be established. Key source hashes appear below.
- This compares inspected implementation paths, not the latest released Codex
  product. The OpenAI Docs search/fetch service and direct official-page request
  returned HTTP 403, so no current online documentation claim is made.
- Mycli behavior was checked using temporary SQLite, fake providers, deferred
  operations, and in-memory terminal streams. The user's real session was not
  changed. No live provider calls or Codex build/test run was needed or performed.
- This is an architecture survey with targeted reproductions, not an exhaustive
  security review or verification of every provider, platform, and extension.

Paths prefixed with `M/` are relative to this mycli repository. Paths prefixed
with `C/` are relative to the local Codex directory.

## Confirmed Findings

### F1. P1: Old Compaction Cleanup Can Delete A Successor's Checkpoint

Trigger: interrupt a compaction whose summary request remains pending, then admit
later work in the same session. `compact_checkpoint` is session-wide. The next
compaction deletes an existing in-progress checkpoint and returns `interrupted`
even with an uncanceled signal. If another compaction creates a checkpoint, the
old request's eventual cleanup can delete that newer checkpoint too.

- Mycli: `M/backend/packages/runtime/src/context/compaction-coordinator.ts:291`
  and `:387`. The cleanup checks the session key, not the owning turn/window.
- Codex reference: `C/codex-rs/core/src/tasks/compact.rs:17` represents manual
  compaction as a `SessionTask`; `C/codex-rs/core/src/tasks/mod.rs:825` owns task
  cancellation and cleanup. This does not establish that every Codex storage
  operation is race-free.
- Evidence: the preceding offline coordinator test observed an unexpected
  interrupted result and deletion of the successor's `checkpoint-2`.
- Required change: conditional checkpoint deletion and installation using owner
  and window identity. Recovery of abandoned work must not cancel fresh work.
- Acceptance: late success, failure, or abort of A cannot delete or replace B's
  checkpoint; restart recovery preserves completed windows and fresh input.

### F2. P1: Gateway Can Reinterpret A Committed Completion As Interruption

Trigger: Esc after the runtime commits `completed` but before the terminal
snapshot finishes. The gateway receives the committed completion and substitutes
an interrupted event because the abort signal is set. Its terminal-emitted flag
then prevents correction from the stored result. Live UI and resumed history disagree.

- Mycli: `M/backend/packages/runtime/src/turns/node-turn-runtime.ts:1702` and
  `:1735`; `M/backend/apps/mycli/src/node-runtime/node-gateway-turn-controller.ts:1318`.
- Codex reference: `C/codex-rs/core/src/tasks/mod.rs:426` centralizes task finish;
  `C/codex-rs/app-server/src/request_processors/turn_processor.rs:1291` rejects
  already terminal targets and correlates interruption responses with core events.
- Evidence: real mycli runtime/SQLite test produced durable `completed`, an
  accepted interrupt response, one interrupted event, and zero completed events.
- Required change: project the committed terminal result. Cancellation intent
  cannot override it. Keep terminal commitment and resource release explicit.
- Acceptance: test both orderings of completion and interruption around commit,
  delayed snapshot, duplicate events, and immediate follow-up. Live/replay agree.

### F3. P2: Pending Admission Escapes Cancellation And Close

Trigger: credential readiness is pending when the user cancels or the controller
closes. Admission has only a pending flag; the active cancellation controller is
installed later. Interrupt finds no active turn. Close returns without draining
admission, which subsequently reserves and starts without rechecking closed state.

- Mycli: `M/backend/apps/mycli/src/node-runtime/node-gateway-turn-controller.ts:191`,
  `:257`, and `:265`; `M/tui/mycli-shell/src/gateway.ts:753`.
- Codex reference: `C/codex-rs/tui/src/app_server_session.rs:815` and
  `C/codex-rs/app-server/src/request_processors/turn_processor.rs:1297` explicitly
  represent startup cancellation separately from interruption of an existing turn.
  This is a design example, not proof of identical credential-admission semantics.
- Evidence: two real runtime/SQLite tests observed provider dispatch after an
  ignored interruption and after controller close. The latter kept storage open
  intentionally; it does not establish a permanent CLI shutdown hang.
- Required change: track a cancelable admission operation before the first await;
  revalidate session ownership and closed/canceled state before reservation.
- Acceptance: canceled preparation dispatches nothing; close drains preparation;
  stale readiness completion cannot reserve work in a closed or changed session.

### F4. P2: Post-Reservation Setup Failure Can Leave An Orphan Turn

Trigger: reservation commits, then setup throws before active execution is
installed. The catch releases the execution claim but leaves `in_progress` in
SQLite. The previous root Worker startup fix cannot catch a failure before that
wrapper is called.

- Mycli: `M/backend/apps/mycli/src/node-runtime/node-gateway-turn-controller.ts:286`,
  `:293`, and `:323`.
- Codex reference: `C/codex-rs/core/src/tasks/mod.rs:401` and `:563` illustrate
  task-owned execution/finalization. Codex's persistence design differs; it does
  not supply a directly interchangeable SQLite reservation transaction.
- Evidence: fault injection into `configureRuntimeContext` left an unfinished
  durable turn with no active gateway turn and no provider dispatch. A natural
  trigger in the default configuration path was not demonstrated.
- Required change: install terminalization ownership immediately after reservation;
  all setup failures converge on it and preserve any already committed terminal result.
- Acceptance: fail each post-reservation setup/publication boundary, reopen the
  database, and verify a terminal record, released ownership, and zero unintended calls.

### F5. P2: Compaction Bypasses Shared Model Execution And Error Evidence

The ordinary turn uses `ProviderStepExecutor` with retry policy, diagnostics,
and durable attempt updates. The actual backend compaction factory instead calls
`summarizeCompactionWithProvider`, which streams directly, ignores usage, and
returns only text. The coordinator catches a provider error and reduces it to
`failed` without retaining its structured reason. The compaction event cannot
carry that reason to the TUI.

- Mycli normal path: `M/backend/packages/runtime/src/turns/node-turn-runtime.ts:1261`;
  `M/backend/packages/runtime/src/providers/provider-agent-loop.ts:78`.
- Mycli bypass: `M/backend/apps/mycli/src/node-runtime/node-backend.ts:1142`;
  `M/backend/packages/runtime/src/context/compaction-coordinator.ts:54`, `:80`,
  and `:290`; gateway projection at
  `M/backend/apps/mycli/src/node-runtime/node-gateway-turn-controller.ts:1073`.
- Codex reference: `C/codex-rs/core/src/compact.rs:220` reuses a client session,
  retries, and reports failures; `:658` processes provider usage.
- New reproduction: a provider fails once with a retryable stream error and would
  succeed on its second call. Compaction makes one call, returns `failed`, and
  preserves neither the error code nor public detail in its result/events.
- Required change: make compaction a supported request purpose of the shared model
  execution boundary, with deliberate retry, usage, persistence, and display policy.
- Acceptance: temporary upstream failure recovers; auth failure is retained without
  retry; cancellation never starts the next attempt; sanitized errors survive resume;
  successful summaries never appear as ordinary assistant answers.

The injected provider tests the common boundary, not one vendor's wire format.
This path uses the configured provider and can affect any supported route. This
does not prove that a past error in the user's session originated in compaction.

Two other direct stream call sites were inspected: connectivity validation is a
bounded explicit probe, and `MemorySelector` has an optional deterministic fallback.
The default backend does not inject that model selector. They are not counted as
additional active-turn defects merely because they call `stream` directly.

### F6. P2: Native Chat Serializes Interrupt Behind A Pending RPC

With `MYCLI_TUI_NATIVE=1`, readline submissions and Ctrl+C both enter
`actionQueue`. A pending submit/steer/command RPC can therefore prevent its own
cancellation request from reaching the gateway until the RPC settles. EOF exit
uses the same queue and requires the same ownership review.

- Mycli: `M/tui/mycli-shell/src/native-chat-runtime.ts:77`, `:80`, and `:226`.
- Codex reference: `C/codex-rs/tui/src/app_server_session.rs:796` exposes a typed
  interrupt control request, with a separate startup form at `:815`.
  No claim is made that every Codex frontend wait is preemptible.
- New reproduction: a terminal stream delivered Ctrl+C while a synthetic submit
  RPC was pending. No interrupt action was dispatched until that RPC was released.
- Required change: keep normal input ordering, while giving cancellation/exit an
  independent, identified control path. Recheck queued action ownership after close.
- Acceptance: Ctrl+C reaches cancellation while submit/command/approval response
  awaits; EOF closes promptly; repeated control input does not cancel a successor.

## Comparison By Responsibility

| Area | Codex mechanism inspected | Current mycli mechanism | Assessment |
| --- | --- | --- | --- |
| Turn lifecycle | `core/src/tasks/mod.rs`: `SessionTask`, task handle, cancellation, common finish | Session execution claims, `NodeTurnRuntime`, root Worker release barrier | Foundation present; F2-F4 show incomplete coverage |
| Input and queue ownership | `core/src/session/input_queue.rs`: turn-owned pending input | `SessionCoordinator`, queue coordinator, TUI session/turn identity checks | Existing ownership model should be extended through admission, not replaced |
| Tool approval and execution | `core/src/tools/orchestrator.rs`, `parallel.rs`: approval, sandbox, runtime, parallel barriers | `ToolBatchCoordinator`, `ParallelApprovalCoordinator`, effect ledger | Substantial alignment; independent approvals and ordered durable results are implemented |
| Policy and tool catalog | `core/src/session/turn_context.rs:103`: per-turn model/policy/tool context | `run-execution-snapshot.ts:48`: deeply frozen policy and catalog identity | Existing contract and tests; no evidence for a broad policy rewrite |
| Model execution | `core/src/client.rs`, `responses_retry.rs`, `compact.rs` | Pi-ai adapter, retry loop, durable provider attempts | Ordinary path is well established; compaction is a real exception, F5 |
| Context and compaction | `core/src/context_manager/history.rs`, compact tasks, compact/resume/fork integration tests | Input assembly, append-only timeline, committed request manifests, compaction coordinator | Preserve the ledger; repair checkpoint ownership and bring summaries into execution accounting |
| Persistence and replay | Core task lifecycle, thread/rollout storage, state model/runtime separation | SQLite terminalization transaction and outbox; request/effect/attempt ledgers; derived transcript | Strong foundation; projection must respect committed authority, F2 |
| Gateway and protocol | Typed request processors and `app-server-protocol` event mapping | Shared gateway client, generated RPC types, validation, controller split, bounded transport | Major prior gaps addressed; payload typing is still weakened inside adapters |
| TUI and headless input | Typed app-server client; dedicated event consumers | Shared gateway and UI action dispatcher, default/native renderers, headless gateway client | Old native approval/action omissions are fixed; F6 remains in scheduling |
| Child agents/extensions | Agent control, thread manager, execution guard, task context | `AgentSupervisor`, scheduler, Worker pool, durable agent lifecycle and mailbox | Ownership boundaries exist; root/child/extension integration needs broader combined race coverage |
| Platform enforcement | `linux-sandbox/src/proxy_routing.rs`, network proxy, tool sandbox orchestration | macOS process-owned proxy; platform-specific shell sandbox adapters | Linux/Windows domain-constrained Shell networking remains explicitly unavailable |
| Engineering evidence | Mock SSE integration tests spanning interruption and compact/resume/fork | Node unit/integration suites, failpoints, packed smoke, platform CI, three-task coding corpus | Useful gates exist; combined interleavings and real coding capability remain incompletely measured |

## Structural Backlog

### S1. Preserve Typed Payloads Through The Whole Event Path

`M/backend/packages/gateway/src/client.ts:172` has typed requests and runtime
validation. `M/backend/apps/mycli/src/node-runtime/node-gateway-event-projector.ts:63`
validates notifications. However, `M/tui/mycli-shell/src/adapters/runtime-events.ts:30`
turns a typed notification into `{ method, params: Record<string, unknown> }`,
losing the relationship between method and payload. The reducer then parses many
fields again. Server transport dispatch also uses generic `JsonObject` contracts.

Codex's `C/codex-rs/app-server-protocol/src/protocol/event_mapping.rs:31` maps
typed `EventMsg` variants to typed notifications and `ThreadItem` variants.

This is a maintainability/type-safety gap, not proof that malformed wire events
currently bypass validation. Retain discriminated payload types through decoding
and handlers; isolate version-1 and synthetic compatibility conversion at explicit
entry points. Existing lifecycle reducers and tool-record parsers should be reused.

### S2. Make Operation Ownership A Contract At Every Async Boundary

Mycli already has `M/backend/packages/runtime/src/sessions/session-operation-state.ts:17`
and identity-checked release. Root Worker cancellation now waits for release.
Child interruption has separate residency cleanup at
`M/backend/packages/runtime/src/agents/agent-supervisor.ts:401`. F1, F3, F4,
and F6 demonstrate gaps where those rules stop before the next module.

Represent each pending operation's identity, cancellation, terminalization duty,
and release completion explicitly. Specify owners for admission, foreground turn,
manual command, child run, and background process. Shared rules should apply to
all of them without merging their different lifetimes into one giant object.
Detached Shell sessions must retain their independently defined lifecycle.

### S3. Use Cross-Module Invariants As Release Evidence

The existing 111 selected tests pass while the new two-case audit reproduces
defects. Existing tests cover each subsystem well enough to provide a foundation,
but the missing combinations require deterministic integration tests.

Codex examples include `C/codex-rs/app-server/tests/suite/v2/turn_interrupt.rs:133`
(reject interruption of a completed turn) and
`C/codex-rs/core/tests/suite/compact_resume_fork.rs:129` (preserve model-history
view across compaction, resume, and fork). These are reference scenarios, not a
claim that Codex tests prove absence of all races.

The mycli coding corpus currently contains three small tasks, as stated in
`M/docs/coding-evaluation.md:3`. It verifies its runner/scoring with a fake agent
and supports live runs, but this audit performed no live comparison. Coding quality,
task success, latency, and token-efficiency parity remain unmeasured.

### S4. Keep Platform Capability Differences Explicit

`M/backend/packages/tools/src/shell/shell-tool.ts:258` rejects domain-constrained
networking outside macOS. `C/codex-rs/linux-sandbox/src/proxy_routing.rs:73`
and `:124` provide a Linux host-to-network-namespace proxy route.

This is a known capability gap with a conservative rejection path, not a newly
found sandbox bypass. Implement and verify Linux routing in its existing planned
task; assess Windows enforcement separately. A passing macOS test cannot certify
either native platform. Do not broaden network permission as a compatibility fallback.

## Implementation Order And Acceptance

| Batch | Responsibility | Concrete outcome and acceptance |
| --- | --- | --- |
| 1. Lifecycle correctness | Runtime turns/sessions, compaction, storage repositories, gateway, native input | Resolve F1-F4 and F6. Cancel before/after reservation, delay snapshot/release, inject setup failure, deliver stale callbacks, reopen storage, then submit again. No extra dispatch, orphan turn, terminal disagreement, or successor-state mutation |
| 2. Shared model execution | Runtime provider executor, compaction, attempt/input ledgers, contracts and projection | Resolve F5. Identify request purpose and owner; persist sanitized request/attempt outcomes; account for usage; retain cancellation and configured retry rules; keep summary output separate from ordinary assistant output |
| 3. Typed projection and API | Contracts, gateway controllers/client, TUI adapters | Resolve S1 incrementally. Preserve method/payload narrowing; one explicit legacy conversion; live/resume/default/native/headless consumers agree on terminal and tool records |
| 4. Broader evidence and supported platforms | Integration tests, coding evaluation, platform helpers | Extend S3/S4 using the existing runners and CI. Add failure/interleaving matrices and platform probes. Run a comparable live coding corpus only as a separately scoped experiment with pinned tasks/model/settings |

Each batch includes its regression tests; testing is not deferred to batch 4.

Batch 2 needs an explicit decision about manual compaction identity:
`M/backend/apps/mycli/src/node-runtime/node-backend.ts:1389` creates a synthetic
command ID without reserving an ordinary user turn. The attempt ledger must have
a valid durable operation owner. Simply routing this request through the ordinary
turn executor can misattribute its transcript, budget, or terminal outcome. Reuse
the existing execution service with an appropriate operation/purpose contract.

Retry policy must continue to distinguish transient errors, auth/config failures,
unknown outcomes, and cancellation for all providers. The local Codex compaction
loop is an example of coverage; its broad catch/retry behavior is not a substitute
for mycli's provider-neutral error policy.

Preserve mycli's storage guarantees. Codex's task runner warns and continues after
a rollout flush failure (`C/codex-rs/core/src/tasks/mod.rs:414` and `:871`), and
local compaction explicitly disables one inference trace path
(`C/codex-rs/core/src/compact.rs:634`). Its implementation is not evidence of
universal atomic persistence or complete tracing. Architecture comparison should
retain these limits instead of treating Codex as a specification of perfection.

## Original Audit Verification

New audit artifact: `.omx/reviews/codex-architecture-audit.test.ts`.

```sh
node --conditions=mycli-source --import tsx --test .omx/reviews/codex-architecture-audit.test.ts
```

Observed: 2/2 reproductions, one provider call with discarded compaction failure
details, and interruption dispatched only after the pending native RPC settled.
The assertions intentionally describe the defects. They must be converted into
correct-behavior regression tests when implemented.

The preceding `.omx/reviews/esc-lifecycle-followup.test.ts` supplied five completed
offline reproductions for F1-F4. It was not rerun in this comparison. Its details
are retained in `.omx/reviews/esc-lifecycle-followup.md`.

The following existing suites were run together with source resolution and
`--test-concurrency=2`: 111 tests passed, 0 failed, 0 skipped.

- `backend/packages/runtime/test/providers/provider-agent-loop.test.ts`
- `backend/packages/runtime/test/providers/provider-attempt-recovery.test.ts`
- `backend/packages/runtime/test/turns/parallel-approval-coordinator.test.ts`
- `backend/packages/runtime/test/turns/run-execution-snapshot.test.ts`
- `backend/packages/runtime/test/context/compaction-coordinator.test.ts`
- `backend/packages/storage/test/projections/provider-attempt-ledger.test.ts`
- `backend/packages/runtime/test/turns/turn-terminalization.test.ts`
- `backend/packages/gateway/test/flow-control.test.ts`
- `tui/mycli-shell/test/native-chat-runtime.test.ts`
- `tui/mycli-shell/test/provider-error-display.test.ts`

No production implementation changed during this audit. Full build/lint/typecheck
and cross-platform execution were not repeated for the documentation and local
audit artifacts. No claim is made about an installed binary matching this worktree.

## Codex Source Fingerprints

SHA-256 fingerprints identify the inspected key files in the unversioned local
archive; they are not a substitute for an upstream commit or a hash of the entire tree.

| File relative to local Codex root | SHA-256 |
| --- | --- |
| `codex-rs/core/src/tasks/mod.rs` | `8baceb8fb5aaeb44512455eee58d778d120761539b8c3db717ccd922a0092cbb` |
| `codex-rs/core/src/compact.rs` | `4dc79430eb48b87c699120ca271339a041683d5fabc8fcae92d721cf2878953f` |
| `codex-rs/core/src/tools/orchestrator.rs` | `ce75a82cf7167d5295704e3bc3a45a2fb2c489751b9169cc67e03b4d2f3f1799` |
| `codex-rs/app-server-protocol/src/protocol/event_mapping.rs` | `c38b9d2b9afb15f5f9573585b66ba88d9368f982ca5f8f5e3ba56bc8892bf502` |
| `codex-rs/app-server/src/request_processors/turn_processor.rs` | `48aec7e0b524063b268be06c07d2d38f4c36782d3e0aa2d9e1fa13789b5ea2f4` |
