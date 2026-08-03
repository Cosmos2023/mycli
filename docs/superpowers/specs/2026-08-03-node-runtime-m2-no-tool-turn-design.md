# Node Runtime M2 No-Tool Turn Design

## Status

Approved for implementation on 2026-08-03 after final user review.

M2 is delivered and accepted as one complete end-to-end milestone. Work may proceed in dependency
order, but no internal M2.x slice is considered a releasable milestone on its own.

## Goal

Implement the first provider-visible turn entirely in Node.js. A user selects the Node backend,
submits a no-tool turn through the existing TUI contract, receives normalized streaming events,
and can resume the session from data written in the existing SQLite database.

The milestone supports both OpenAI Responses and OpenAI-compatible Chat Completions through one
runtime and provider boundary. A failed Node turn never falls back to Python automatically.

## Scope

M2 includes:

- side-effect-free turn state and provider request projection;
- compatible configuration and API-key loading;
- OpenAI Responses streaming;
- OpenAI-compatible Chat Completions streaming;
- normalized text, reasoning, retry, interruption, status, and terminal events;
- runtime-owned retry and cancellation policy;
- append-compatible writes to the existing SQLite session database;
- durable `client_turn_id` idempotency;
- startup recovery for orphaned running turns;
- explicit rejection of provider tool calls;
- an explicit Node backend route in the npm CLI;
- offline parity gates and minimal live API smoke tests for both protocols.

## Non-Goals

M2 does not implement tools, approvals, shell execution, MCP, plugins, hooks, subagents,
compaction, memory, queues, steering, or Anthropic Messages. Those remain assigned to later
milestones.

The Node backend does not accept local image attachments in M2. A submission containing
`local_images` fails before provider IO with `unsupported_capability`. This avoids silently
dropping input and keeps filesystem/media handling out of the first provider slice.

M2 does not make Node the default backend. It makes `--runtime-backend=node` usable for the
supported no-tool capability. Python remains the default until a separately approved rollout.

## Considered Approaches

### Selected: package-separated vertical milestone

Create focused `core`, `config`, `providers`, `storage`, and `runtime` workspace packages and
compose them in `apps/mycli`. The packages are implemented in dependency order and accepted
together after the full M2 gate passes.

This preserves clear dependency direction, gives later tool milestones stable extension points,
and keeps SDK, TOML parser, and SQLite driver types out of the runtime contract.

### Rejected: implement everything in `apps/mycli`

This reduces initial package setup but couples CLI lifecycle, provider serialization, retry,
configuration, and database logic. M3 would need to extract those boundaries while adding tools,
making the short-term saving counterproductive.

### Rejected: retain Python projection or persistence helpers

Calling Python for request construction or session writes would make the turn operationally
dependent on both runtimes. It would not satisfy the Node-native M2 boundary and would make
cancellation, idempotency, and failure ownership ambiguous.

## Architecture

```text
apps/mycli
  -> packages/runtime
       -> packages/core
       -> packages/providers
       -> packages/storage
       -> packages/config
  -> packages/contracts
```

`packages/core` contains immutable domain values, request projection, turn state transitions,
provider-neutral events, and error codes. It performs no filesystem, network, clock, random, or
database IO.

`packages/config` reads compatible TOML, environment, auth JSON, and storage paths. Parser types
and raw secret-bearing objects remain private to the package.

`packages/providers` exposes one provider-neutral streaming interface and implements Responses
and Chat adapters. OpenAI SDK types remain private to the adapters.

`packages/storage` exposes a driver-independent `SessionStore` and implements the current SQLite
format with `better-sqlite3`. Driver types remain private to the adapter.

`packages/runtime` owns orchestration, retry decisions, cancellation, event ordering,
idempotency behavior, persistence ordering, and terminal outcomes.

`apps/mycli` validates gateway input, selects the backend, owns the active `AbortController`, and
projects runtime events to the existing TUI contract.

Dependencies point toward contracts and pure domain code. `core` does not import provider,
storage, config, application, schema-validator, or third-party types. Provider and storage
packages do not import the CLI or TUI.

## Core Contracts

The pure core package defines:

- `TurnId`, `ClientTurnId`, and `SessionId` branded string types;
- `TurnStatus`: `in_progress`, `completed`, `failed`, and `interrupted` for the M2 state machine;
- `RuntimeErrorCode` with stable configuration, authentication, provider, rate-limit,
  context-window, retry-exhausted, persistence, interruption, invalid-request, conflict, and
  unsupported-capability variants;
- canonical conversation items for user text, assistant text, reasoning, and usage;
- `ProviderRequest`, containing provider, protocol, model, instructions, projected history,
  reasoning settings, output limits, and cache-policy fields;
- `ProviderEvent`, discriminated into reasoning delta, text delta, completed item, usage,
  provider completion, and tool call;
- `RuntimeEvent`, independent of both the OpenAI SDK and gateway JSON-RPC envelope;
- pure reducers that reject invalid state transitions and return a new turn snapshot.

Request projection accepts already-loaded configuration, conversation history, and instruction
content. Responses and Chat projections are derived from the same canonical shape. The M2
projection declares an empty tool set and never places tool schemas on the wire.

Untrusted gateway and persisted records remain governed by Draft 2020-12 JSON Schemas in
`packages/contracts`. Generated TypeScript declarations stay deterministic and checked in.

## Configuration And Authentication

The Node loader preserves the current value precedence:

```text
environment
  -> ~/.mycli/config.toml
  -> <workspace>/.mycli/config.toml
  -> ~/.config/mycli/config.toml
  -> built-in default
```

M2 ports the fields needed for a provider turn: provider, protocol, model, API base URL, API-key
environment selection, `auth_ref`, reasoning effort, output limits, request retry limit, stream
retry limit, timeout values, session identifier, and storage location.

`~/.mycli/auth.json` retains its current provider-keyed `{type: "api_key", key: "..."}` shape.
Environment credentials take precedence according to the Python behavior. An absent or malformed
auth file behaves as an empty store; a turn without a usable credential terminates with
`auth_error` before network IO.

Provider/protocol compatibility and base-URL inference are ported as pure tables with parity
fixtures. Unknown providers or incompatible protocol selections fail during configuration rather
than being guessed.

Secrets are never included in public configuration snapshots, gateway errors, test snapshots,
SQLite diagnostics, or logs. Redaction covers API keys, authorization headers, cookies, raw auth
objects, and secret-like query parameters.

## Provider Boundary

The local provider interface has one streaming operation:

```ts
interface ModelProvider {
  stream(request: ProviderRequest, options: ProviderStreamOptions): AsyncIterable<ProviderEvent>;
}
```

`ProviderStreamOptions` carries an `AbortSignal` and injected diagnostics sink. Tests inject a
fake transport and replay sanitized provider event fixtures; runtime and core tests never require
network access.

The Responses adapter maps output text, reasoning summaries, completed output items, response
identity, usage, terminal status, and provider errors into `ProviderEvent`. The Chat adapter maps
content deltas, common OpenAI-compatible reasoning fields, usage, finish reasons, and streamed
tool-call fragments into the same event types.

Both adapters use the official `openai` package with an overridable base URL. SDK retries are set
to zero so the runtime is the only owner of retry count and lifecycle events. Adapters classify
HTTP status, transport failures, timeouts, rate limits, authentication failures, context-window
errors, malformed streams, and provider tool calls without exposing raw headers or request
payloads.

A tool call is parsed far enough to identify the capability violation, then discarded. The
runtime emits a terminal `unsupported_capability` failure and never invokes Python or a tool
handler.

## Turn Data Flow

```text
turn.submit
  -> validate gateway contract and M2 capability
  -> reserve (session_id, client_turn_id) and append user message
  -> emit turn.started
  -> load config, auth, and existing conversation
  -> build canonical ProviderRequest with no tools
  -> stream through Responses or Chat adapter
  -> normalize and emit runtime/TUI events
  -> append completed assistant records and terminal rollout
  -> persist terminal idempotency snapshot
  -> emit terminal turn/status events
```

The reservation and initial user-message write occur in one short `BEGIN IMMEDIATE` transaction
before provider IO. Streaming holds no database transaction. Successful assistant records and the
terminal turn state are written in a second short transaction before terminal success is emitted.

Only completed assistant blocks enter canonical conversation history. Deltas are emitted to the
TUI but are not stored as canonical messages. Interrupted or failed partial output can be
summarized in the terminal rollout, but cannot become conversation input for a later model turn.

The existing event order remains observable to the TUI:

1. `turn.started` and running status;
2. zero or more `reasoning.delta` plus compatibility `thinking.delta` events;
3. zero or more `message.delta`, `stream.retrying`, `message.reset`, or `stream.recovered` events;
4. `message.complete` for a completed assistant item;
5. exactly one terminal `turn.completed`, `turn.failed`, or `turn.interrupted` family and matching
   status updates.

Every emitted turn event carries the original `client_turn_id`. Existing event names and required
fields remain compatible; M2 adds only optional terminal error/idempotency fields and any new
stable error enum values required by the Node runtime.

## Idempotency And Recovery

An additive `runtime_turns` table records durable reservations:

```sql
CREATE TABLE IF NOT EXISTS runtime_turns (
  session_id TEXT NOT NULL,
  client_turn_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  result_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (session_id, client_turn_id),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
```

The request fingerprint covers behavior-affecting submission fields without containing raw
secret configuration. For an existing `(session_id, client_turn_id)`:

- the same fingerprint returns the existing `turn_id`, status, and terminal result when present;
- a running duplicate returns the existing running state;
- a different fingerprint fails with `message_id_conflict`;
- no duplicate path sends a provider request, including failed and interrupted turns.

The table is additive and ignored safely by the Python schema-v2 store. Existing `sessions`,
`conversation_messages`, `history_items`, and `turn_rollouts` retain their current structures and
payload shapes. The schema version is not bumped for the additive private reservation table. For
a new database, Node creates the complete existing schema-v2 structure plus this table, so a fresh
Node installation never depends on Python to initialize storage.

When the Node store opens, it marks its orphaned `in_progress` rows `interrupted` in a short
transaction and records a terminal rollout if one is not already present. Recovery never issues a
provider request. Python/Node compatibility tests prove that both implementations can read the
canonical records written by the other.

## Retry, Cancellation, And Errors

The runtime retries only failures classified as retryable and only before the first valid provider
event. Retry count, clamping, `Retry-After`, exponential backoff, and jitter semantics are ported
from the current Python policy and tested with injected clock, sleep, and random functions.

Once a valid stream event is observed, the runtime does not resubmit the full request. M2 does not
implement a provider continuation protocol, so a retryable failure after that point is terminal.
Before-event retries emit `stream.retrying`; an attempt reset emits `message.reset`; recovery emits
`stream.recovered`.

`turn.interrupt` aborts the active request through `AbortController`. A late provider completion
after abort cannot overwrite the interrupted terminal state. Cancellation, retry sleep, provider
iteration, and persistence boundaries all check the abort signal.

Accepted-turn failures include a stable `code` on `turn.failed`; interruption carries the same
typed code on `turn.interrupted`. M2 defines these terminal codes:

- `config_error`
- `auth_error`
- `provider_error`
- `rate_limited`
- `context_window_exceeded`
- `retry_exhausted`
- `persistence_error`
- `interrupted`
- `unsupported_capability`

Boundary validation and duplicate-payload conflicts continue to use gateway errors before a new
turn is accepted. Public error messages are bounded and sanitized. Raw diagnostics may record
provider request IDs and status codes, but never credentials, auth headers, or full secret-bearing
payloads.

If the initial reservation transaction fails, no provider request starts. If final persistence
fails after provider completion, the turn is marked failed where possible and success is not
reported. It is never replayed automatically.

## SQLite Compatibility

`packages/storage` uses `better-sqlite3` behind `SessionStore`. Connections enable foreign keys,
retain the current WAL/busy-timeout behavior, and use explicit short transactions.

Node writes canonical JSON with deterministic UTF-8 serialization and payload shapes accepted by
the Python dataclasses. Ordering uses the existing message indexes and autoincrement sequence
columns. Reads validate JSON shape and fail with `persistence_error` rather than returning partial
or guessed state.

Compatibility fixtures cover:

1. Python write, Python read;
2. Python write, Node read;
3. Node write, Python read;
4. Node write, Node read;
5. Unicode and empty content;
6. duplicate reservation and payload conflict;
7. interrupted running-turn recovery;
8. malformed JSON and busy/locked database failures.

No transaction remains open while awaiting provider or TUI activity.

## Application Routing

`RuntimeBackend` expands to `"python-sidecar" | "node"`. CLI and environment backend selectors
retain conflict and unknown-value validation. The default remains `python-sidecar`.

When `node` is selected, `apps/mycli` constructs config, storage, provider registry, runtime, and
gateway handlers without spawning Python. Unsupported M2 inputs fail explicitly. Once a turn is
reserved for Node, no error can reroute it to the sidecar.

Rollback is operator-controlled: select `python-sidecar` before a later turn or install the prior
release. Shared session data remains usable by both backends.

## Dependencies

M2 adds the minimum runtime dependencies compatible with Node 22.19 or newer:

- `openai` 7.x for Responses and OpenAI-compatible Chat transport;
- `better-sqlite3` 13.x for synchronous SQLite transactions;
- `smol-toml` 1.x for compatible TOML parsing.

Exact resolved versions are committed in `package-lock.json`. Retry, cancellation, redaction,
state transitions, logging, and event projection use project code and Node standard-library APIs.
No TypeScript source loader is used in production.

## Testing Strategy

### Unit and fixture tests

- Core tests cover request projection, state transitions, fingerprints, invalid transitions, and
  error-code mapping.
- Config tests cover environment/user/project/legacy precedence, nested TOML compatibility,
  provider inference, auth references, malformed files, defaults, and secret redaction.
- Provider tests replay sanitized Responses and Chat event streams, including reasoning, usage,
  malformed events, split tool-call arguments, transport errors, rate limits, and context limits.
- Runtime tests use fake providers, storage, clocks, sleep, random, and abort signals to prove
  event order, retry limits, post-stream no-replay, interruption, persistence ordering, and one
  terminal outcome.

### Integration and parity tests

- Shared Python/Node fixtures compare canonical request projection for the supported M2 inputs.
- SQLite tests execute the four cross-backend read/write paths and recovery cases on copied
  databases.
- Real-process application tests submit JSON-RPC requests to the Node backend and assert the
  existing gateway/TUI event contract.
- Duplicate `client_turn_id` tests count provider transport invocations and require exactly one.
- A tool-call fixture requires `unsupported_capability` and zero tool/Python invocations.
- Package tests execute compiled ESM, not TypeScript source loaders.

### Repository gates

M2 must pass:

- Node contract generation drift check;
- Node build, ESLint, strict typecheck, and all workspace tests;
- Python Ruff, mypy, and pytest suites;
- minimum Node 22.19 lifecycle/integration jobs on macOS, Linux, and Windows;
- sanitized package-install smoke for the compiled npm executable.

## Live API Smoke

Live tests run only after all offline gates pass and use credentials already configured on the
machine. They never print or persist prompt text, response text, headers, API keys, or raw provider
payloads.

Responses and Chat Completions each receive one short, no-tool, low-output request with retry count
and wall-clock duration bounded. Assertions cover successful terminal state, expected normalized
event families, non-empty completed assistant output, usage shape when supplied, and persisted
session readability.

The report records only protocol, model identifier, endpoint host classification, status, event
category counts, duration, token counts, and a redacted error category. A missing eligible local
credential produces an explicit local `SKIP`; the M2 exit gate requires recorded successful smoke
evidence for both protocols before the milestone is declared complete. CI live jobs remain
secret-gated.

## Implementation Order

The implementation proceeds internally in this dependency order:

1. extend canonical contracts and add pure core types/state/projection;
2. add compatible configuration and authentication;
3. implement and fixture-test Responses, then Chat, on the shared provider boundary;
4. add SQLite compatibility and durable idempotency;
5. add runtime orchestration, retries, interruption, and failure mapping;
6. enable the Node application route and existing TUI event projection;
7. run cross-backend, real-process, packaging, cross-platform, and live API gates.

These are implementation checkpoints, not separately accepted releases. M2 is complete only when
the full definition of done passes.

## Definition Of Done

M2 is complete when all of the following are true:

- `--runtime-backend=node` completes and persists a no-tool turn without starting Python;
- Responses and Chat use the same runtime/provider contract;
- existing supported provider-turn configuration and auth data are read compatibly;
- normalized streaming and terminal events drive the existing TUI without backend-language
  branching;
- duplicate `client_turn_id` never causes a second provider request;
- interruption and startup recovery never replay a request or accept a late completion;
- unexpected tool calls fail with `unsupported_capability` and execute nothing;
- Python and Node read each other's canonical SQLite records;
- contracts, build, lint, typecheck, unit, integration, parity, packaging, and platform gates pass;
- sanitized Responses and Chat live smoke reports pass;
- rollout and rollback documentation is updated with M2 evidence.
