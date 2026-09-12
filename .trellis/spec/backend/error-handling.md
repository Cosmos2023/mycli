# Error Handling

> How errors are handled in this project.

---

## Overview

`mycli` treats errors as a cross-layer protocol rather than one catch-all
exception class. Infrastructure boundaries retain specific local exception
types, but every failed runtime turn crosses process, persistence, gateway, and
TUI boundaries as one canonical `RuntimeFailure`.

```text
provider SDK / filesystem / runtime exception
  -> boundary classifier
  -> RuntimeFailure
  -> retrying event or durable failed turn
  -> turn.failed / transcript.load
  -> TUI projection
```

Request-scoped gateway failures are a separate lane. They may reject one RPC
without changing the active turn.

---

## Error Types

- `RuntimeErrorCode` is generated from the canonical runtime-turn JSON Schema.
- `backend/packages/contracts/src/errors/` owns the versioned reason catalog,
  legacy mappings, public summaries, and bounded context validation.
- `gateway/runtime-errors.ts` remains a compatibility facade for the 17 legacy
  runtime codes, `RuntimeFailure`, redaction, and terminal message helpers.
- Version-1 `error_context` adds 66 precise reasons without expanding those
  legacy codes. It contains a stable occurrence ID, source, operation scope,
  outcome/effect evidence, reason-specific details, and at most three causal
  snapshots. Its encoded size cannot exceed 8 KiB.
- Use `errorContext` internally and `error_context` in existing snake-case
  result/metadata/gateway envelopes. The nested object is identical. Use
  `failureScope()` for opaque ownership IDs; safe IDs are retained and unsafe
  or oversized IDs become a deterministic SHA-256 identity.
- Provider-facing runtime codes are grouped by recovery semantics:
  - credentials and policy: `auth_error`, `permission_denied`
  - caller correction: `invalid_request`, `context_window_exceeded`
  - transport and service health: `connection_error`,
    `response_stream_error`, `server_overloaded`, `provider_error`
  - account and throttling: `rate_limited`, `quota_exceeded`
  - lifecycle: `retry_exhausted`, `interrupted`
  - local runtime: `config_error`, `persistence_error`,
    `unsupported_capability`, `tool_budget_exceeded`, and
    `tool_protocol_error`
- `ProviderFailure` is the provider-boundary exception. Its `Error.message` is
  internal; only `publicDetail` may become user-facing after sanitization.
  `providerFailureToRuntimeFailure()` is the only normal Provider-to-runtime
  conversion.
- `StorageFailure`, tool exceptions, and integration-specific exceptions stay
  in their owning packages. Runtime converts them at the nearest turn recovery
  boundary.
- `GatewayFailure` is an app-layer request error. It is not a `RuntimeFailure`
  and must not terminalize a turn.
- Fatal TUI rendering failures use the same context catalog in the private
  fatal-error diagnostic path, while remaining outside conversation state.

Do not duplicate the runtime error-code list or public-message switch in
providers, runtime, storage, Worker RPC, gateway, or TUI code.

---

## Error Handling Patterns

### MCP Boundary

- MCP failures use the existing `integration.*` reasons and `IntegrationErrorDetails`; do not create
  a second public error catalog. Keep operation, `connect`/`request`/`reconnect` phase, HTTP status,
  numeric JSON-RPC code, bounded timeout/recovery counts, and allowlisted transport codes.
- Capture HTTP evidence per response in the transport, not in a shared "last error" slot. Drop raw
  response bodies, URLs (including credential-bearing paths), headers, session IDs, and SDK data.
- Typed Streamable HTTP POST 404 failures with a sent session ID qualify for reinitialization
  and one replay. ModelScope's HTTP 401 with the exact top-level JSON `Code: "SessionExpired"`
  qualifies only with a sent session ID as well. Read at most 8 KiB within one second to recognize
  this machine code, then discard the body. Ordinary 401 responses, malformed/oversized bodies,
  and free-form expiry messages do not qualify. Never replay after a timeout/ambiguous disconnect
  or treat the optional GET stream's HTTP 405 as a failed tool request.
- Recovery compares connection generations. Concurrent failures reuse one replacement handshake;
  retiring a connection must not cancel other in-flight requests. A cancelled waiter must not abort
  a handshake still needed by another caller. Close or cancellation of the last waiter must stop
  further initialization/replay; old-connection cleanup must not delay joining shared recovery.
- Local stdio cancellation/timeout retires only the current connection/process generation.
  Later explicit calls can reconnect, without replaying the failed operation. Siblings affected by
  process retirement report connection failure/unknown outcome, not a false user cancellation.
- Initialization failures and confirmed request rejection mean `not_started` with no tool effects.
  Timeouts and ambiguous post-dispatch failures retain `unknown` outcomes and possible tool effects.
  Resource reads/discovery have no mutation effects. Parallel-call permission alone is not evidence
  that a tool is read-only.
- Adapters attach scoped `errorContext` and `metadata.error_context` only for negotiated v1 callers;
  the router preserves the occurrence. Aggregate resource failures keep bounded per-server details
  and explicit omitted counts. Model output, persistence, and TUI presentation must keep safe codes.
- Regression tests cover SDK HTTP/RPC errors and redaction, stateful loopback HTTP expiry, concurrent
  recovery, cancellation/close, retry bounds, non-replay after ambiguous failures, and stored errors.

### Plugin Boundary

- Plugin API v2 workers use `PluginHostError` and host-owned `integration.*` contexts. Keep safe
  operation (`tools/call`, `hooks/run`, `commands/run`, `initialize`, `shutdown`), phase, timeout,
  exit code, and allowlisted signal/errno evidence; omit raw worker diagnostics and environment.
- The first terminal failure remains available when later callers encounter `host_closed`.
  Retain at most one bounded prior failure; do not build unbounded exception chains across restarts.
- An unavailable worker may be replaced for a new invocation, with a shared cancellable handshake
  and identical registrations. An ambiguous already-dispatched invocation is never replayed.
- Plugin tool contexts are negotiated per session. Strip plugin-provided `metadata.error_context`
  before attaching the host context, and preserve the occurrence through router, storage, and TUI.
- Pre-hook failure blocks tool dispatch with `not_started/none`, retaining the separately scoped
  hook failure as a cause. Completed tool effects remain authoritative after post-hook failures.

### Provider Boundary

- Classify SDK/HTTP errors once with `classifyProviderError()`.
- Classification uses structured status, Provider code/type tokens, SDK error
  class names, and an allowlist of transport cause codes. Arbitrary exception
  text is not classification input except for the existing bounded context
  overflow signatures.
- Classification precedence is semantic: context overflow before invalid
  request, quota before rate limit, and explicit overload before generic 429 or
  5xx handling.
- Preserve only allowlisted bounded diagnostics such as status, request id,
  provider error code/type, transport error class, and transport cause code.
- Normalize retry delays from `retry-after-ms`, numeric or HTTP-date
  `Retry-After`, and the structured `rate_limit_exceeded` message form used by
  Responses. Provider and runtime boundaries both cap the delay at one hour.
- HTTP success is not stream success. Capture structured Responses `error` (flat or nested) and
  `response.failed` objects at the existing SSE boundary before the SDK reduces them to text.
  Immediately classify and sanitize this evidence; retain only the canonical failure, never the
  whole envelope. It takes precedence over SDK translation, with caller cancellation still first.
  Capture response-body transport causes similarly. Fatal code/type tokens work without an HTTP
  error status or code; only remaining remote stream failures use the retryable fallback.
- SDK error-string decoding is a compatibility fallback, not the primary Responses error contract.
  Do not add exact-message whitelists to fix unrecognized remote error formats. The first terminal
  event owns the outcome; a following `response.failed` must not replace its detail or delay shutdown.
- Treat HTTP 413 and 415 as caller-correctable `invalid_request` failures when
  no more specific context-window signature applies.
- Never promote an arbitrary local `Error.message`, stack, raw body, header, or
  credential into `publicDetail`.
- Remove exact SDK empty-response boilerplate such as
  `401 status code (no body)` from public detail while retaining the structured
  status and request id. Do not use this presentation cleanup for
  classification.
- Convert with `providerFailureToRuntimeFailure()` before runtime retry or
  terminal handling.

### Runtime Boundary

- A policy block with no user decision maps to `permission_denied` / `policy.access_denied`.
  An unregistered tool maps to `unknown_tool` / `tool.not_found`, and malformed arguments map to
  `invalid_arguments`. Reserve `approval_rejected` / `policy.approval_denied` for an actual rejected
  approval; do not infer user intent from an internal `deny` decision.

- `RuntimeFailure.message` is the concise canonical public text, not a raw
  exception message. Sanitized upstream context belongs only in the optional
  `additionalDetails` field and is capped at 1,000 characters.
- Retry policy consumes structured `retryable`, `retryAfterSeconds`, and
  diagnostics. It does not infer retryability from rendered text.
- `providerAttemptRetryAllowed()` checks attempt completion, cancellation and
  dispatch evidence before applying those budgets. `resolveErrorRecovery()`
  additionally checks current session ownership, activity, capabilities and
  prior effects. A retryable provider attempt never authorizes whole-turn replay.
- Retry exhaustion retains the last concrete cause. User cancellation is
  `runtime.user_cancelled` only when the owning interrupt boundary supplies
  explicit evidence. Legacy `interrupted` remains unspecified.
- Connection failures before the first Provider event may consume the request
  retry budget. Once output has started, a connection failure is reclassified
  as `response_stream_error`, rolls back that incomplete visible attempt, and
  consumes the stream retry budget.
- An ordinary local exception without a recognized transport identity or
  structured retryable server response is not retryable merely because it has
  no HTTP status.
- A typed Worker request byte-limit rejection before dispatch is a local
  `context_window_exceeded` result with zero observed provider events, not an
  upstream provider failure. Preserve `error_source=worker_rpc` and safe numeric
  limits, publish the failed attempt diagnostic, and use the existing single
  reactive compaction attempt. Do not classify oversized inbound Worker traffic
  or arbitrary protocol exceptions as recoverable input overflow.
- Other typed Worker provider-RPC failures remain non-retryable local failures.
  Preserve `error_source=worker_rpc` and a fixed safe explanation to restart mycli
  and reload matching runtime modules. Do not expose the raw exception in public
  detail or spend a remote retry budget on an already successful remote attempt.
  Optional diagnostic payload incompatibility alone cannot cause this failure;
  its envelope, identity, sequence, and byte bounds still require validation.
- A retry publishes transient `stream.retrying`; it does not persist a terminal
  error or fail the turn.
- Both request and stream retries honor bounded `retryAfterSeconds`. Retrying a provider step must
  never re-execute tools from an earlier committed step or publish incomplete tool-call arguments.
- Retry exhaustion or a non-retryable failure is persisted atomically with the
  terminal turn and its model-hidden display item before `turn.failed` is
  projected.
- On the normal terminal path, the same transaction also appends the durable
  `turn_lifecycle` outbox. Runtime projection consumes the committed
  `{ turn, outbox }` result; it must not rebuild the terminal code, message,
  safe detail, usage, or kind from request-local values after commit.
- `turn.failed` owns terminal failure content. `turn.status` and
  `status.update` update state only.
- Failed terminal commits emit an uncommitted `runtime_error`, projected as
  `gateway.error`, with unknown outcome and the original failure as a cause.
  Never recursively persist that emergency failure or publish a committed
  `turn.failed`. Readable snapshot write failures are private diagnostics and
  cannot replace an already committed successful/failed outcome.
- Keep notification delivery outside the terminal-commit catch. A disconnect
  after commit must retain the committed outcome and occurrence, without a
  second storage error or request replay. Preserve structured SQLite lock and
  capacity reasons when the commit itself fails.

### Storage And Resume

- Storage applies `canonicalRuntimeFailureMessage()` and
  `sanitizeRuntimeErrorDetail()` again at the persistence boundary.
- A failed turn and its readable error item share a stable turn-derived id.
- `/resume` restores the persisted error item with the same main message and
  optional `additional_details` metadata as the live failure. Neither display
  field is injected into model context.
- Database format 14 fences enriched writes. The v12/v13 forward migration is
  transactional and preserves existing transcript bytes. Writers obtain
  `errorContextVersion: 1` from the store; legacy stores reject enriched data.
- Provider attempt, effect ledger, lifecycle outbox, and turn results retain the
  same occurrence. Runtime-state closed payloads do not gain a second copy.
  Snapshot v2 already has extensible transcript metadata; its version remains
  2, with bounded context parsing before read-only recovery.

### Gateway And TUI

- `gateway.error` represents one failed RPC. It must not stop an otherwise
  active turn.
- RPC error codes outside the closed event enum project to `internal_error`
  using `isGatewayErrorCode()`, while the RPC code and enriched reason remain
  intact. Preserve invalid-context markers and resolved empty action lists.
  Legacy projection removes version-1 recovery actions as well as contexts.
- Distinct gateway failures remain distinct even when their text matches.
- Re-delivery of the same terminal turn failure is idempotent by stable
  identity, not by adjacent-text comparison.
- TUI reducers consume structured error events, finalize foreground tool rows,
  and render one notice. Shared summaries describe historical failure facts;
  the runtime resolves recovery against current state for live and loaded
  history. An explicit empty recovery list must remain empty. Legacy hint
  helpers are fallback facades, never authority to replay effects.
  The hint, `additional_details`, `code`, `method`, and `source` may form one
  logical secondary line; they do not become extra transcript rows. When a hint
  exists, rendering prioritizes the hint and safe detail over repeating
  technical code/source labels. Reducers do not classify Provider errors or
  invent fallback taxonomy.
- `runtimeErrorNoticeSeverity()` is the shared display-severity decision.
  `server_overloaded` ends the turn but renders as one warning notice, matching
  Codex's recoverable-capacity treatment; live and resumed projection must use
  the same decision.

Operational diagnostics follow `logging-guidelines.md` and must remain separate
from provider-visible history and readable error messages.

---

## API Error Responses

- Terminal turn event: `turn.failed` requires `client_turn_id`, `turn_id`,
  `code`, and canonical `message`; optional `additional_details` is sanitized
  and capped at 1,000 characters.
- Durable turn: `RuntimeTurnRecord.error_code` uses `RuntimeErrorCode`; the
  terminal result message is canonical public text and optional
  `additional_details` is stored separately.
- Retry event: `stream.retrying` carries recovery kind, attempt, bounded delay,
  failure kind, and sanitized additional detail.
- Request failure: JSON-RPC errors and `gateway.error` carry the request error
  code/message and do not reuse `turn.failed`.
- Diagnostics crossing Worker or storage boundaries are closed, bounded
  records containing only string, number, boolean, or null values.
- Provider attempt diagnostics may carry `failure?: RuntimeFailure` alongside the legacy
  `failureKind`. Worker parsing reuses the canonical failure validator and rejects a failed
  diagnostic marked successful or with a contradictory failure code. Trace projections retain only
  allowlisted classification fields, retryability/delay, and sanitized additional detail.

Schema validation is mandatory at external/gateway boundaries and independent
runtime validation is mandatory at Worker and storage trust boundaries.

Gateway protocol 1 negotiates `supported_error_context_versions: [1]` and replies
with `error_context_version: 1`. Missing/unsupported selection downgrades every
known nested event, RPC, history and attempt context. Only an explicit handshake
parameter rejection permits retrying bootstrap without the extension. Worker
protocol 2 rejects stale peers before dispatch. Unknown optional contexts are
quarantined with `error_context_invalid`, suppress speculative recovery, and
cannot invalidate an otherwise authoritative terminal envelope.

`tests/fixtures/error-system/` contains shared hashed presentation fixtures and
the reviewed emitter inventory. After changing a boundary, review the intended
classification and regenerate the inventory with
`node --conditions=mycli-source --import tsx scripts/error-emitter-inventory.mjs --write`.
The inventory records syntax-level emitters and explicit generic fallbacks;
integration tests remain responsible for proving their actual ownership flow.

---

## Common Mistakes

- Repeating Provider diagnostics in `turn.failed`, `turn.status`, and footer
  state, producing multiple visible errors for one failed turn.
- Deduplicating adjacent errors by message text and thereby hiding two distinct
  request failures.
- Maintaining separate error-code arrays in Worker RPC and storage parsers,
  causing schema additions to fail only on recovery paths.
- Maintaining separate public-message switches in contracts, providers, and
  runtime, causing retry and terminal messages to disagree.
- Persisting recovery prose or deriving it from Provider messages, causing live
  and resumed rendering to drift when upstream wording changes.
- Showing raw Node exception messages or Provider response bodies because they
  appear useful for debugging.
- Treating a retry notification as a durable terminal error.
- Letting `gateway.error` terminalize a running turn.
- Publishing a normal terminal event from pre-commit inputs, which can make the
  TUI report completion or failure while SQLite still owns an `in_progress`
  turn.

## Required Tests

- Contracts test the complete error taxonomy, public messages, recovery hints,
  guards, SDK-boilerplate removal, redaction, unknown-code fallback, and
  required `turn.failed` fields.
- Provider tests cover HTTP classification, retry metadata, bounded structured
  detail, retry-delay formats and bounds, classification precedence, SDK
  transport identity, redaction, and conversion to `RuntimeFailure`.
- Runtime/Worker tests cover retry versus terminal behavior and validate every
  structured failure field across the Worker boundary.
- Storage tests prove failed-turn atomicity and identical live/resume main and
  additional-detail projection, including exact reload of the terminal
  `turn_lifecycle` outbox.
- Gateway/TUI tests prove request errors remain non-terminal, terminal Provider
  diagnostics render exactly once, hints derive from runtime codes, and live
  and resumed notices remain identical and width-safe.
