# mycli Node Runtime Rewrite Design

Date: 2026-08-03
Status: Approved

## Summary

mycli will migrate from its current Python runtime and TypeScript terminal UI to a completely
Node.js/TypeScript product. The final npm package will require Node.js 22.19 or newer and will not
start, bundle, probe for, or depend on Python.

The migration will not translate the Python package file by file. It will use the existing
Python-to-Node JSON-RPC boundary as the starting point for a strangler migration. Node becomes the
parent process early, while Python temporarily runs as an RPC sidecar for capabilities that have
not migrated. Each capability moves to Node as an independently testable vertical slice. The
sidecar surface may only shrink and is deleted after parity is complete.

Existing configuration, authentication data, SQLite sessions, CLI behavior, and configured
command hooks remain compatible. Python plugin source is not compatible with the final runtime;
plugin authors migrate to a process-isolated TypeScript Plugin API v2.

## Goals

- Ship one npm CLI implemented in TypeScript and compiled to ESM JavaScript.
- Remove the Python interpreter and Python package dependency from installation and execution.
- Preserve the existing Node TUI and its observable behavior.
- Preserve supported configuration, auth, model catalog, SQLite session, and CLI contracts.
- Support OpenAI Responses and OpenAI-compatible Chat in the first provider milestone.
- Restore all other supported product capabilities in Node before Python retirement, including
  Anthropic, tools, sandboxing, sessions, compaction, memory, shell, MCP, plugins, hooks,
  subagents, and diagnostics.
- Keep each migration stage releasable, explicitly selectable, testable, and rollbackable.
- Preserve macOS, Linux, and Windows behavior.

## Non-goals

- A line-by-line translation of `src/mycli`.
- A redesign of the existing TUI solely because the runtime language changes.
- New unrelated agent capabilities during the migration.
- Silent runtime fallback from a failed Node operation to Python.
- Source compatibility for Python plugins in the Node-only release.
- Standalone platform executables that bundle Node.js.
- A local runtime daemon shared by multiple CLI processes.

## Current State

The production baseline contains approximately 78,000 lines of Python and 24,000 lines of
TypeScript. Python owns provider clients, turn orchestration, tool execution, approval and sandbox
policy, session persistence, compaction, memory, MCP, plugins, hooks, subagents, and diagnostics.
The Node package owns the terminal UI and talks to Python through line-delimited JSON-RPC.

The existing boundary is substantial: it contains session, turn, approval, command, model,
settings, resource, trace, and workspace methods plus normalized streaming and lifecycle events.
This boundary is useful for migration, but its current ownership is inverted relative to the
target because Python launches Node.

The current Node package already uses ESM, strict TypeScript, npm, `package-lock.json`, and the
Node test runner. Production currently runs TypeScript through a source loader; the final package
must instead execute compiled JavaScript.

## Architectural Decisions

### Node is the parent process

After the contract and launcher foundation is ready, the npm executable becomes the composition
root. It owns terminal streams, the TUI, signal handling, backend routing, child lifecycle, and
process exit codes.

Python becomes an on-demand compatibility sidecar. It communicates only over dedicated pipes,
never owns the TTY, and is not started when the requested capability is fully implemented in
Node. Sidecar stderr is captured as sanitized diagnostics and never parsed as protocol input.

```text
Node npm CLI (parent)
|
|-- TUI and terminal ownership
|-- capability/backend router
|-- native TypeScript runtime
|   |-- providers
|   |-- tools
|   |-- storage
|   `-- integrations
|
`-- Python sidecar (temporary, RPC only)
```

### A turn uses exactly one backend

The backend router assigns a turn before the first provider request or side effect. A turn cannot
switch backend after it starts. A Node failure is returned as a Node failure; the runtime does not
replay the turn through Python.

This prevents duplicate provider charges, duplicate file mutations, inconsistent approval state,
and divergent session histories. Rollback means selecting Python before a later turn or installing
an earlier release, not replaying a failed operation automatically.

### JSON Schema is the contract source of truth

Versioned JSON Schema Draft 2020-12 documents define RPC envelopes, requests, responses,
notifications, errors, turn state, tool data, and persisted records. TypeScript types are generated
artifacts. Node validates all process-boundary and untrusted persisted payloads at runtime. The
Python sidecar consumes or validates against the same schemas.

Contract generation must be deterministic and checked for drift in CI. A protocol handshake
exchanges the schema/protocol version and advertised capabilities before any turn starts.
Incompatible peers fail with a stable protocol error.

### Existing SQLite data remains shared

The required SQLite schema remains frozen while Python and Node coexist. Node reads and writes the
existing database directly. Interim changes may only be additive and must be safely understood or
ignored by both implementations.

Breaking schema evolution is deferred until Python retirement. Cross-backend fixtures prove that
Python-written data is readable by Node and Node-written data is readable by Python.

### Extensions stay process-isolated

Plugin API v2 uses a versioned manifest, a Node worker entry point, and a JSON Schema protocol to
register and invoke tools, hooks, and commands. It preserves timeouts, output limits, sandboxing,
secret redaction, and crash isolation.

Configured command hooks remain language-neutral external commands with their existing discovery,
allowlist, matching, timeout, result, and redaction behavior. The mycli npm package does not depend
on Python, although a user may explicitly configure a command that requires software installed
separately.

## Target Repository Structure

```text
apps/
  mycli/
    src/
      cli/
      tui/
      backend-router/
      sidecar/
packages/
  contracts/
  core/
  runtime/
  providers/
  tools/
  storage/
  config/
  integrations/
```

Ownership is as follows:

- `apps/mycli`: npm executable, existing TUI, backend selection, signals, and process lifecycle.
- `packages/contracts`: canonical schemas, generated types, validators, and version negotiation.
- `packages/core`: side-effect-free turn, event, tool, and session domain models/state machines.
- `packages/runtime`: agent loop, orchestration, cancellation, retry decisions, and runtime events.
- `packages/providers`: Responses, Chat Completions, and Anthropic protocol adapters.
- `packages/tools`: tool inventory, exposure, routing, execution, approval integration, and
  concrete adapters.
- `packages/storage`: SQLite session store, trace persistence, and structured JSONL logging.
- `packages/config`: compatible TOML config, auth, model catalog, and storage-layout loading.
- `packages/integrations`: MCP, Plugin API v2, configured hooks, and subagents.

Dependencies point from applications and adapters toward runtime and core contracts. Core does not
depend on provider SDKs, SQLite, filesystem APIs, the TUI, schema validators, or third-party types.
Ajv, SQLite-driver, provider-SDK, and PTY types stay inside their adapter packages.

The repository continues to use npm and `package-lock.json`. npm workspaces manage packages, and
TypeScript project references produce compiled ESM JavaScript. Production does not use `tsx` or a
TypeScript source loader. Ajv validates Draft 2020-12 contracts,
`json-schema-to-typescript` produces checked-in deterministic TypeScript declarations, and ESLint
with the TypeScript parser provides the TypeScript lint gate.

## First Node Runtime Slice

The first releasable capability is an end-to-end no-tool turn. Node owns:

- compatible configuration and authentication loading;
- canonical request construction;
- OpenAI Responses;
- OpenAI-compatible Chat Completions;
- streaming text and reasoning event projection;
- retry, cancellation, and terminal error handling;
- append-only writes to the current SQLite session database;
- events consumed by the existing TUI.

The slice does not declare tools to the model. If a provider nevertheless returns a tool call, the
turn terminates with `unsupported_capability`; it is not delegated to Python.

Responses is implemented first on the shared provider boundary. Chat Completions follows in the
same milestone and uses the same agent runtime rather than a separate loop. Anthropic is a later
adapter on that boundary.

## No-tool Turn Data Flow

```text
TUI submission
  -> contract validation
  -> client_turn_id reservation
  -> Node backend assignment
  -> persist user message and running turn
  -> load config/auth/session state
  -> build canonical provider request
  -> stream through Responses or Chat adapter
  -> emit normalized runtime events
  -> persist completed assistant blocks and terminal state
```

`client_turn_id` is the idempotency key. A duplicate submission returns the existing turn state
and never sends another provider request.

Before network IO, a short transaction records the user message and running turn. Streaming does
not hold a database transaction open. Assistant deltas may be written to the event ledger, but
only completed blocks enter canonical conversation history. A final short transaction persists
the completed assistant result and terminal state.

If the process exits with a running turn, startup recovery marks it interrupted. Recovery never
automatically reissues its provider request.

## Provider Boundary

A local `ModelProvider` contract isolates all provider SDKs. Provider adapters own:

- request serialization;
- SDK or HTTP stream mapping;
- provider-specific reasoning and tool-call fields;
- transport error classification;
- continuation and capability state;
- raw diagnostics with credential redaction.

The runtime owns:

- turn identity and idempotency;
- retry policy decisions;
- cancellation;
- normalized runtime events;
- persistence ordering;
- tool-loop progression after later milestones.

Tests inject fake transports and replay sanitized provider events. No provider SDK type appears in
runtime or core public interfaces.

## Retry, Interruption, And Errors

Connection failures may retry before the first valid stream event according to the existing
policy. After streaming begins, the runtime may only use an explicitly supported provider
continuation or recovery mechanism. It must not blindly resubmit the full request.

Normalized events include the existing turn, message, reasoning, retry, recovery, status, and
terminal event families. The TUI does not branch on the backend implementation language.

Configuration, authentication, contract, provider, persistence, interruption, and unsupported
capability failures use stable error codes. Contract validation errors do not expose complete
secret-bearing payloads. Logs never contain credentials, auth headers, or unredacted secret
configuration.

## Persistence Driver

`packages/storage` defines a driver-independent `SessionStore`. The migration implementation uses
`better-sqlite3` because its synchronous transaction model closely matches the current Python
semantics and keeps SQL explicit. Driver types remain private to the storage adapter.

The local target environment exposes `node:sqlite`, but it remains experimental across the
supported Node range and is not selected as the migration baseline. It can be reconsidered after
its supported API is stable at the minimum Node version.

Synchronous database calls are acceptable for a local single-user CLI when transactions remain
short. Provider streams and long-running tools must never hold transactions open.

## Shell And Sandbox

Shell migration occurs after basic runtime, tool, and persistence contracts are stable.
Non-interactive processes use `node:child_process` behind explicit cancellation and process-tree
control. Persistent terminal sessions use `node-pty` behind a `ShellTransport` interface.

The existing isolation mechanisms remain conceptually unchanged:

- macOS uses Seatbelt through `sandbox-exec`;
- Linux uses Bubblewrap;
- Windows uses the packaged restricted-token helper.

These are process protocols rather than Python business logic. Node constructs the equivalent
arguments and request payloads. The Windows native helper may remain a packaged asset; removing
Python does not require rewriting it.

Sandbox, approval, and tool-effect checks happen before any side effect. Missing sandbox support,
ambiguous permission state, and invalid security contracts fail closed.

## Migration Milestones

### M0: Contract foundation

- Create npm workspaces and package boundaries.
- Extract canonical JSON Schemas from the current gateway contract.
- Generate TypeScript types and validators.
- Build sanitized golden fixtures and contract drift checks.

Exit gate: Python and Node accept and reject the same contract fixture corpus.

### M1: Node composition root

- Add the compiled npm executable.
- Move TUI, signal, exit-code, and lifecycle ownership to Node.
- Start Python as an on-demand sidecar over dedicated RPC pipes.
- Add handshake, crash, timeout, interruption, and orphan cleanup tests.

Exit gate: lifecycle tests pass on macOS, Linux, and Windows without TTY/protocol mixing.

### M2: No-tool provider turn

- Port pure request projection and turn state.
- Add compatible config/auth loading.
- Implement Responses and Chat adapters.
- Persist the no-tool turn in the existing SQLite database.
- Drive the existing TUI with normalized runtime events.

Exit gate: Responses and Chat contract, fixture, persistence, interruption, and live API smoke
tests pass.

### M3: Read-only tools

- Port the tool contract, exposure planner, and router.
- Add Read, LS, repository search, and other non-mutating tools.
- Add tool event and model-output parity fixtures.

Exit gate: read-only coding-agent turns run entirely in Node.

### M4: Mutation and security

- Port Edit, Write, Patch, execution policy, approvals, and sandbox policy.
- Add mutation target, path boundary, approval, fail-closed, and redaction tests.
- Add non-PTY process execution before persistent shell support.

Exit gate: security and side-effect regression suites pass on all supported platforms.

### M5: Runtime state and recovery

- Complete session APIs and replay.
- Port compaction, memory, queue, steering, continuation state, and recovery.
- Preserve SQLite cross-backend compatibility.

Exit gate: state, crash recovery, and four-way persistence tests pass.

### M6: Persistent shell

- Add PTY and ConPTY transport through `node-pty`.
- Port background terminals, stdin forwarding, resize, interrupt, and process-tree cleanup.
- Validate all sandbox wrappers with persistent processes.

Exit gate: shell lifecycle suites pass on macOS, Linux, and Windows.

### M7: Integrations and remaining parity

- Add Anthropic on the shared provider boundary.
- Port MCP, Plugin API v2, configured hooks, subagents, setup, management commands, and doctor.
- Add extension migration diagnostics and documentation.

Exit gate: every supported production capability has a Node implementation or an explicitly
approved removal.

### M8: Python retirement

- Make Node the only backend.
- Remove sidecar startup and compatibility routing.
- Remove Python production code, packaging, dependencies, and Python CI.
- Update installation, troubleshooting, and extension documentation.

Exit gate: a clean npm installation runs the full supported product without starting, importing,
or probing for Python.

## Verification Strategy

Every milestone must pass:

- strict TypeScript type checking and linting;
- Node unit and integration tests;
- deterministic contract generation and drift detection;
- sanitized provider-event fixture replay;
- Python/Node black-box event comparison while both backends exist;
- interruption, timeout, crash, and child-process cleanup tests where applicable;
- fail-closed, approval, sandbox, path-boundary, and secret-redaction tests where applicable;
- Node 22.19 minimum-version CI and current supported Node CI;
- macOS, Linux, and Windows CI for process- or platform-sensitive behavior;
- an explicit backend switch, rollout note, and rollback note.

Persistence milestones run a four-way matrix:

1. Python writes and Python reads.
2. Python writes and Node reads.
3. Node writes and Python reads.
4. Node writes and Node reads.

Logical data, ordering, null/default behavior, Unicode, large payloads, partial turns, and recovery
are compared. Unstable timestamps and identifiers are normalized only for event comparison, not
discarded from persistence tests.

## Live API Verification

Real provider API smoke tests are authorized for each applicable milestone. They supplement rather
than replace deterministic offline tests.

- Use only credentials already configured on the machine.
- Never print, copy, persist, or commit credentials.
- Run live smoke only after offline gates pass.
- Use the smallest request that exercises the milestone's provider-visible behavior.
- Bound tokens, retries, concurrency, and wall-clock duration.
- Do not duplicate real requests solely to compare nondeterministic response text.
- Run tool-capable smoke tests only in a disposable workspace under strict sandbox and normal
  approval policy.
- Store only redacted summaries and stable diagnostics.
- For a milestone without meaningful provider-visible behavior, run a basic connectivity check or
  record why a live API assertion does not apply.

Network access or sandbox escalation required to run a live smoke remains an explicit execution
approval at the time of the test.

## Rollout And Rollback

During coexistence, backend selection is explicit. Node is promoted per capability only after its
parity gates pass. A failure never causes silent execution by the other backend.

The current SQLite schema and compatible config files allow a user to select Python for a later
turn while fallback remains available. After M8, rollback means installing the previous npm
release; the Node-only release does not retain hidden Python code.

## Python Retirement Criteria

Python can be removed only when all of the following are true:

- every retained production capability has a Node owner;
- Node is the default and only backend in verification builds;
- session/config/auth compatibility suites pass;
- provider, tool, security, shell, extension, and recovery suites pass;
- live API smoke passes for every supported provider path;
- npm clean-install tests pass on supported platforms;
- no production path starts, imports, locates, or probes a Python runtime;
- user and extension migration documentation is complete.

The retirement change removes `src/mycli`, `pyproject.toml`, `uv.lock`, Python packaging and CI,
sidecar schemas, launcher code, and compatibility-only tests in one auditable milestone.

## Principal Risks And Mitigations

### Behavioral drift

Risk: Type-correct TypeScript can still behave differently from Python.

Mitigation: contract fixtures, black-box event parity, four-way persistence tests, and vertical
slice gates treat observable behavior rather than source structure as the migration unit.

### Duplicate side effects

Risk: retries or backend fallback can duplicate model charges or tool mutations.

Mitigation: reserve `client_turn_id`, select one backend before execution, never switch mid-turn,
and prohibit blind replay after streaming begins.

### Session corruption

Risk: Node writes can make rollback to Python impossible.

Mitigation: freeze required schema structure, allow only additive compatible changes, use short
transactions, and require cross-backend read/write fixtures.

### Cross-platform process regressions

Risk: PTY, signals, process trees, and sandbox behavior differ by operating system.

Mitigation: migrate PTY late behind an interface, reuse the existing sandbox protocols, and gate
process changes on real three-platform CI.

### Extension trust

Risk: in-process plugins can crash or compromise the runtime.

Mitigation: Plugin API v2 remains out of process with schema validation, sandboxing, timeouts,
output limits, redaction, and process-tree cleanup.

### Prolonged dual-runtime maintenance

Risk: the sidecar becomes permanent or gains new responsibilities.

Mitigation: forbid new Python capabilities, track capability ownership per milestone, and make
Python deletion an explicit acceptance gate rather than an optional cleanup.

## Acceptance Criteria

- A clean npm installation can launch mycli with Node.js 22.19 or newer.
- The final product does not require or probe for Python.
- Existing supported config, auth, model catalog, and SQLite sessions remain readable.
- Existing documented CLI commands and TUI behavior remain compatible.
- Responses, Chat Completions, Anthropic, tools, approvals, sandboxing, sessions, compaction,
  memory, shell, MCP, plugins, hooks, subagents, and diagnostics run through Node.
- Plugin API v2 and configured hooks preserve the required isolation and security properties.
- Contract, parity, persistence, platform, security, recovery, and live API gates pass.
- Python runtime, packaging, sidecar, and compatibility-only implementation files are removed.
