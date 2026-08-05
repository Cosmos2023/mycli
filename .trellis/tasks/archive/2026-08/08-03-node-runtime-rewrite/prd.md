# Migrate mycli Runtime to Node.js

## Goal

Replace the Python runtime with a Node.js/TypeScript runtime while preserving mycli as a
local-first terminal coding agent. The final distributed product must not require Python.

## What I Already Know

- The current product is a Python runtime with an existing TypeScript Node TUI.
- Production code is approximately 78,000 lines of Python and 24,000 lines of TypeScript.
- The Python and Node processes already communicate through a structured JSON-RPC gateway.
- The existing TypeScript package targets Node.js 22.19 or newer, uses ESM, strict TypeScript,
  the Node test runner, and npm.
- The Python runtime owns provider adapters, turn orchestration, tool execution, approvals,
  sandboxing, sessions, compaction, memory, MCP, plugins, hooks, and subagents.
- The user selected a Node-only end state. Python may exist only as a temporary migration
  sidecar and must be removed before the migration is complete.

## Assumptions (Temporary)

- The existing Node TUI should be retained rather than rewritten again.
- Migration should use a strangler approach with contract and behavior parity tests.
- Existing user data and configuration should remain readable unless the user explicitly
  accepts a breaking migration.
- The current npm and TypeScript toolchain should be extended conservatively rather than
  replaced without a concrete benefit.

## Open Questions

- None for the M5 design baseline.

## Requirements (Evolving)

- The final CLI and runtime must run without a Python interpreter or Python packages.
- Preserve the current Node terminal experience.
- Define one canonical, versioned contract for runtime requests, events, tools, turns, and
  persisted session records.
- Preserve compatibility with existing configuration, authentication data, SQLite sessions,
  and CLI command behavior.
- Preserve plugin and hook concepts and their manifest-level contracts, but require Python
  implementations to migrate to TypeScript rather than executing Python in the final product.
- Include both OpenAI Responses and OpenAI-compatible Chat Completions in the first provider
  migration milestone. They must share one runtime/provider contract rather than separate agent
  loops.
- Support staged releases with explicitly selectable Python and Node backends. Promote a Node
  slice to the default only after contract, parity, and integration gates pass.
- Keep rollback explicit and operator-controlled; do not silently retry a failed Node turn on
  Python because that can duplicate model requests or tool side effects.
- Freeze the existing SQLite schema's required structure while Python and Node backends coexist.
  Node must read and write the current database directly. During coexistence, schema changes must
  be additive and safely understood or ignored by both implementations.
- Make the first releasable Node slice an end-to-end no-tool turn. Node owns configuration and
  authentication loading, Responses and Chat provider calls, streaming and reasoning events,
  retries, TUI event projection, and append-only session persistence for that turn.
- Deliver M2 as one complete end-to-end milestone rather than separately released M2.x slices.
  Implementation may proceed in dependency order, but M2 is accepted only when configuration,
  authentication, both provider protocols, streaming, persistence, routing, and live smoke tests
  pass together.
- Reject tool calls explicitly in the first slice. Do not silently delegate a partially executed
  Node turn to Python.
- Distribute the final product as an npm CLI requiring Node.js 22.19 or newer.
- Compile TypeScript to publishable JavaScript. Production installation and execution must not
  depend on `tsx` or a TypeScript source loader.
- Retain npm and `package-lock.json`; use npm workspaces if multiple runtime packages are needed.
- Use Ajv for Draft 2020-12 validation, `json-schema-to-typescript` for deterministic generated
  declarations, ESLint for TypeScript linting, and `better-sqlite3` behind the storage interface.
- Make Node the parent process early in the migration, immediately after the shared contract and
  launcher foundation are ready.
- Node owns CLI/TUI streams, signals, child lifecycle, and exit codes. Python runs only as an
  on-demand sidecar for capabilities that have not yet migrated and must never own the TTY.
- Use versioned JSON Schema Draft 2020-12 documents as the canonical cross-language contract for
  requests, responses, notifications, errors, tool data, turn state, and persisted records.
- Generate TypeScript types from the canonical schemas and validate untrusted/process-boundary
  payloads at runtime. Python sidecar code must consume or validate against the same schemas.
- Introduce a process-isolated Plugin API v2 with a versioned manifest, Node worker entry point,
  and JSON Schema registration/invocation protocol for tools, hooks, and commands.
- Preserve plugin timeout, output-budget, sandbox, redaction, and crash-isolation behavior.
- Keep configured command hooks language-neutral and compatible. The npm package does not bundle
  or require Python, but users may explicitly configure commands that depend on software they
  installed separately.
- Migrate in independently testable vertical slices with an explicit rollback path.
- Keep security-sensitive tool approval and sandbox behavior fail-closed during migration.
- Preserve cross-platform support for macOS, Linux, and Windows.
- Deliver M4 as the Node-native file-mutation slice with `Write`, `Edit`, and `Patch` using the
  M3 manifest, exposure, router, provider continuation, event, and persistence boundaries.
- Preserve the active Python mutation semantics: `Edit` and `Patch` require a current `Read`
  snapshot, while `Write` may use `expected_sha256` to reject stale overwrites.
- Confine every M4 mutation to the real workspace root, including parent creation and symbolic
  link resolution. Traversal and symlink escape attempts fail before any file is changed.
- Reject directory targets, binary-looking existing files, invalid UTF-8, oversized files or
  content, and secret-like new content with stable, model-recoverable error kinds.
- Return bounded unified diffs and mutation metadata, persist ordered mutation calls/results in
  the existing SQLite transcript shape, and project the same bounded metadata to the TUI.
- Match the Python default permission behavior in M4: workspace-local mutations are auto-allowed
  and workspace escapes are denied. Interactive approval pause/resume is deferred.
- Deliver M5 as the runtime-state-and-recovery milestone defined by the approved migration design:
  complete session APIs and replay; port compaction, memory, queue, steering, continuation state,
  and crash recovery; preserve SQLite cross-backend compatibility.
- Treat Node's existing turn reservation, append-only conversation/tool persistence, duplicate
  `client_turn_id` protection, and orphaned-running-turn interruption as the M5 baseline rather
  than rebuilding them.
- Include interactive approval pause/resume and its durable continuation state in M5. Keep the
  implementation scoped to tools/capabilities already owned by Node.
- Use transactional checkpoints for session transitions, queue commits, compaction replacement,
  and approval continuation. Recovery must not repeat provider requests, user messages, tool
  results, approvals, or file mutations.
- Fail closed with stable, sanitized errors for malformed, corrupt, or unsupported persisted
  state. Preserve compatible unknown fields where the dual-runtime contract allows them; do not
  add automatic database repair or migration commands in M5.
- Keep M5 responsibilities in the established package boundaries: versioned state contracts in
  `packages/contracts`, pure state machines in `packages/core`, atomic persistence in
  `packages/storage`, orchestration in `packages/runtime`, RPC/event projection in `apps/mycli`,
  and injectable approval policy integration in `packages/tools`.
- Implement M5 in dependency-ordered internal slices: session/replay; durable queue, steering,
  and approval continuation; compaction, summaries, rehydration, and workspace memory; then
  recovery, cross-backend parity, end-to-end verification, and rollout. M5 is accepted only as a
  complete milestone, not as independently promoted partial slices.
- Resume a session only after its transcript, queue, approval continuation, and compaction state
  all load and validate. A failed load leaves the current session active and emits no partial
  session transition.
- Commit queue history and pending-record removal in one SQLite transaction keyed by `queue_id`.
  Preserve monotonic queue revisions and reconcile committed records during restart.
- Reuse Python-compatible `input_queue`, `pending_decision`, `suspended_turn`, `turn_record`,
  `compact_checkpoint`, and Responses continuation state keys and payload shapes. Add only
  optional, backward-compatible fields or separately versioned state records.
- Support one-time approval and rejection in M5, not remembered rules. Persist an effect claim
  before a mutation; an orphaned claim with no durable result becomes an explicit
  `effect_outcome_unknown` interruption and is never executed again.
- Compaction changes only the provider context projection. Preserve raw history and rollouts,
  atomically commit the summary/replacement/checkpoint, and never automatically replay an
  interrupted compaction provider request.
- Load bounded workspace memory and session summaries before request projection. Fall back from a
  failed model selector to deterministic local selection. Restore only validated Responses
  continuation state; rebuild Chat requests from canonical persisted items.
- Port the Python-compatible memory file format, workspace isolation, bounded discovery,
  selection, request-context injection, session summaries, and explicit remember/forget behavior
  in M5. Defer automatic background extraction and dream consolidation until the M7 subagent
  runtime exists.

## Acceptance Criteria (Evolving)

- [ ] A clean installation can install and run mycli with Node.js only.
- [ ] The CLI can be installed from its npm package and launched through its declared executable
      on supported Node.js versions.
- [ ] No production command starts a Python process or imports Python runtime assets.
- [ ] Existing supported configuration, authentication files, and SQLite sessions can be read
      by the Node runtime without manual conversion.
- [ ] Sessions written by either backend during coexistence remain readable by the other backend.
- [ ] The Node backend can complete and persist no-tool turns through OpenAI Responses and an
      OpenAI-compatible Chat endpoint while driving the existing TUI event model.
- [ ] Streaming interruption, retry exhaustion, malformed provider events, context overflow, and
      duplicate turn submission have deterministic parity-tested outcomes.
- [ ] Each applicable migration milestone includes a minimal live API smoke test using locally
      configured credentials after all offline gates pass.
- [ ] A tool call received by the no-tool slice fails with an explicit unsupported-capability
      outcome and does not execute through another backend.
- [ ] Existing CLI commands retain their documented names and observable behavior unless a
      separately approved change deprecates them.
- [ ] Each migration slice can be selected independently and rolled back to the Python backend
      without corrupting session data or repeating side effects.
- [ ] During coexistence, Node can start, monitor, interrupt, and shut down the Python sidecar
      without leaking child processes or mixing protocol messages with terminal output.
- [ ] Contract generation is deterministic, generated files are checked for drift, and invalid
      boundary payloads fail with stable protocol errors.
- [ ] Plugin and hook authors have a documented TypeScript migration path; Python extension
      source compatibility is not required in the Node-only release.
- [ ] Plugin API v2 workers cannot write outside their granted sandbox, exceed output limits,
      block the host past their timeout, or crash the main runtime process.
- [ ] Existing configured command hooks retain discovery, allowlist, matching, timeout, result,
      and secret-redaction behavior.
- [ ] Supported providers, tools, sessions, compaction, memory, MCP, plugins, hooks, and
      subagents have Node implementations or are explicitly removed by an approved scope
      decision.
- [ ] Security and approval regression suites pass against the Node runtime.
- [ ] A Node turn can create a text file with `Write`, update a recently read file with `Edit` or
      `Patch`, continue the provider turn, and complete without starting Python.
- [ ] `Edit` and `Patch` fail with `missing_read_snapshot` before `Read`, and with
      `stale_read_snapshot` when the file changes after `Read`; no mutation occurs in either case.
- [ ] `Write` with a stale `expected_sha256` fails with `stale_write_snapshot` and preserves the
      current file contents.
- [ ] Traversal, symlink escape, binary target, directory target, invalid encoding, size-limit,
      secret-like content, repeated-match, missing-string, and no-op cases have parity fixtures
      with stable error kinds and no partial writes.
- [ ] Successful mutation results contain bounded path, status, match count where applicable,
      and unified diff metadata; calls and results remain readable by both Node and Python.
- [ ] The M4 Responses live smoke mutates only a disposable workspace, records sanitized
      lifecycle/persistence assertions, and reports `python_started=false`.
- [ ] M5 state, crash-recovery, and four-way Python/Node persistence fixtures pass without
      starting Python for Node-owned capabilities.
- [ ] Fault-injection tests at each M5 persistence boundary prove that restart either resumes from
      the last durable checkpoint or terminates explicitly without duplicate provider or tool
      side effects.
- [ ] Cross-platform shell and process lifecycle tests pass on macOS, Linux, and Windows.
- [ ] Python production code and packaging metadata are removed after parity is proven.

## Definition of Done

- Tests added or migrated at unit, contract, integration, and end-to-end levels.
- TypeScript type checking and linting pass.
- Node and Python parity fixtures pass during the transition.
- Documentation and installation instructions describe the Node-only product.
- Rollout and rollback behavior is documented for each migration slice.
- Live API smoke output is sanitized, cost-bounded, and recorded without credentials or private
  provider payloads.

## Out of Scope (Explicit)

- Redesigning the existing TUI solely for the language migration.
- Adding unrelated agent capabilities during runtime migration.
- A line-by-line mechanical translation of the Python package.
- Standalone executables that bundle Node.js, including SEA-style platform artifacts.
- Interactive `approval.request` / `approval.respond`, remembered approval rules, and paused-turn
  resumption in M4; paused-turn resumption moves into M5, while remembered rules and broader
  permission surfaces remain deferred.
- External writable roots, unrestricted filesystem mode, file-history rollback, shell, MCP,
  plugins, hooks, skills, and subagents in M4.
- External writable roots, shell execution, PTY/process sandboxing, remembered approval rules,
  automatic database repair/migration tooling, MCP, plugins, hooks, skills, and subagents in M5.
- Subagent-backed automatic memory extraction and dream consolidation in M5; these move with the
  subagent runtime in M7.

## Technical Approach

Use the existing JSON-RPC boundary as a strangler seam. Extract shared contracts first, add a
native TypeScript runtime backend alongside the Python gateway backend, then transfer runtime
ownership by vertical slice. After the contract and launcher foundation, invert the current
process relationship so Node is the parent and Python is a compatibility sidecar. Remove the
sidecar after parity gates pass.

Target package ownership:

- `apps/mycli`: npm executable, current TUI, backend routing, signals, and process lifecycle.
- `packages/contracts`: canonical JSON Schema, generated TypeScript types, validators, and
  protocol-version negotiation.
- `packages/core`: side-effect-free turn, tool, event, and session domain models/state machines.
- `packages/runtime`: agent loop, orchestration, retry, cancellation, and normalized events.
- `packages/providers`: Responses, Chat Completions, and later Anthropic adapters.
- `packages/tools`: tool registry, exposure, routing, execution, approval integration, and tool
  adapters.
- `packages/storage`: SQLite session store and structured trace/log persistence.
- `packages/config`: compatible config, auth, model-catalog, and storage-layout loading.
- `packages/integrations`: MCP, Plugin API v2, configured hooks, and subagents.

Dependency direction flows from applications and adapters toward runtime/core contracts. Core
must not depend on providers, SQLite, filesystem, TUI, schema-validator, or SDK types.

A turn is assigned to exactly one backend before the first provider request or side effect. The
TUI consumes normalized runtime events and does not branch on backend language. The Python
sidecar contract may only shrink during migration; new product behavior must target Node.

### No-tool Turn Data Flow

1. Validate the TUI submission against the canonical contract.
2. Reserve `client_turn_id` as the idempotency key and select the Node backend.
3. Persist the user message and running turn in a short transaction before provider IO.
4. Load compatible config/auth/session state and build a canonical provider request.
5. Map Responses or Chat streaming output into normalized runtime events for the TUI and event
   ledger.
6. Persist completed assistant blocks and the terminal turn state in a short final transaction.

Duplicate submissions return the existing turn state and never send another provider request.
Assistant deltas may enter the event ledger, but only completed blocks enter canonical
conversation history. A process restart marks an orphaned running turn interrupted and never
automatically reissues its model request.

Connection failures may retry before the first valid stream event according to the existing
policy. After streaming begins, the runtime may only use an explicitly supported provider
continuation/recovery mechanism; it must not blindly replay the full request. The first slice
does not declare tools. An unexpected tool call terminates with `unsupported_capability` and a
sanitized diagnostic record.

Configuration, authentication, contract, provider, persistence, interruption, and unsupported
capability failures use stable error codes. Transactions never remain open across provider IO,
and logs redact credentials and secret-bearing payload fields.

Initial migration order:

1. Shared contracts and golden parity fixtures.
2. Node composition root and Python sidecar lifecycle.
3. Pure domain state and request projection.
4. Configuration, authentication, Responses and Chat provider adapters, session append, and an
   end-to-end no-tool turn.
5. Tool routing, read-only tools, mutation tools, approvals, and sandboxing.
6. Session persistence, compaction, and memory.
7. Shell/PTY, MCP, plugins, hooks, and subagents.
8. Python sidecar retirement and Python package deletion.

## Decision (ADR-lite)

**Context**: mycli already has a substantial, tested Python runtime and a production Node TUI.
A big-bang rewrite would discard behavior encoded across the runtime and its tests.

**Decision**: target a completely Node.js/TypeScript product through incremental replacement
behind versioned contracts. Python is permitted only during migration.

Compatibility policy: retain existing user data and CLI behavior. Preserve plugin and hook
manifest concepts while allowing a versioned TypeScript extension API to replace Python
implementation APIs.

The first provider milestone covers OpenAI Responses first, followed by OpenAI-compatible Chat
Completions on the same shared TypeScript provider boundary. Anthropic Messages remains a later
provider adapter unless subsequent scope decisions move it forward.

Release policy: ship both backends during migration behind an explicit backend selector. Node is
promoted per slice only after parity gates pass. A failed Node operation must return its real
error; it must not silently execute the same operation again through Python.

Persistence policy: keep the current SQLite schema compatible throughout dual-backend operation.
Do not introduce a breaking schema version until Python has been retired. Any interim additions
must be additive and covered by cross-backend read/write fixtures.

Contract policy: JSON Schema Draft 2020-12 files are the single source of truth. TypeScript types
are generated artifacts, while process and persistence boundaries perform runtime validation.

Extension policy: plugins use a process-isolated, versioned Node worker API. Existing Python
plugin modules require migration to the v2 SDK. Configured command hooks remain external-command
contracts and are not tied to the implementation language of mycli.

## Research References

- [`research/node-runtime-stack.md`](research/node-runtime-stack.md) - Recommended npm workspace,
  contract validation, provider, SQLite, PTY, sandbox, and dependency boundaries.
- [`research/migration-boundaries.md`](research/migration-boundaries.md) - Process ownership,
  vertical slices, persistence compatibility, risk ordering, and parity gates.

## Live API Verification Policy

The user authorizes real provider API smoke tests during each applicable migration milestone.
Live tests supplement rather than replace deterministic fake-transport, fixture, contract, and
cross-backend tests.

- Use only credentials already configured on the machine; never print, copy, persist, or commit
  credentials.
- Run live smoke only after offline gates pass, with the smallest request that exercises the
  milestone's new provider-visible behavior.
- Do not issue duplicate real requests merely to compare nondeterministic text. Compare structural
  invariants and use sanitized recorded fixtures for detailed parity.
- Bound token usage, retry count, concurrency, and wall-clock duration.
- Run tool-capable smoke tests only in a disposable workspace under the strict sandbox and normal
  approval policy.
- Store only redacted summaries and stable diagnostics; raw headers and secret-bearing payloads
  are prohibited.
- Milestones without provider-visible behavior may use a basic connectivity smoke or document
  that no meaningful live API assertion applies.

**Consequences**: the transition temporarily maintains two implementations and requires parity
fixtures, but every slice remains releasable and rollbackable. The final product has one runtime,
one language toolchain, and no Python installation dependency.

## Technical Notes

- `src/mycli/domain/runtime/gateway_contract.py` declares the current RPC and event surface.
- `src/mycli/cli/bootstrap.py` is the current Python composition root.
- `tui/mycli-shell` is the existing strict TypeScript/ESM package.
- `docs/code-redundancy-audit-2026-07-29.md` records the current implementation baseline and
  verification history.
- `openspec/changes/formalize-dynamic-tool-contract/` contains dynamic-tool lifecycle decisions
  and remaining open questions that should be reconciled before tool-runtime migration.
