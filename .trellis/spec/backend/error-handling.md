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
- `backend/packages/contracts/src/runtime-errors.ts` owns:
  - `RUNTIME_ERROR_CODES`
  - the exhaustive public-message mapping
  - the exhaustive optional recovery-hint mapping
  - `RuntimeFailure`, its separate bounded `additionalDetails`, and diagnostic
    value types
  - the runtime error-code guard
  - public-detail redaction and canonical terminal messages
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
- Fatal TUI rendering failures stay outside the conversation error protocol and
  use the private fatal-error diagnostic path.

Do not duplicate the runtime error-code list or public-message switch in
providers, runtime, storage, Worker RPC, gateway, or TUI code.

---

## Error Handling Patterns

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

- `RuntimeFailure.message` is the concise canonical public text, not a raw
  exception message. Sanitized upstream context belongs only in the optional
  `additionalDetails` field and is capped at 1,000 characters.
- Retry policy consumes structured `retryable`, `retryAfterSeconds`, and
  diagnostics. It does not infer retryability from rendered text.
- Connection failures before the first Provider event may consume the request
  retry budget. Once output has started, a connection failure is reclassified
  as `response_stream_error`, rolls back that incomplete visible attempt, and
  consumes the stream retry budget.
- An ordinary local exception without a recognized transport identity or
  structured retryable server response is not retryable merely because it has
  no HTTP status.
- A retry publishes transient `stream.retrying`; it does not persist a terminal
  error or fail the turn.
- Retry exhaustion or a non-retryable failure is persisted atomically with the
  terminal turn and its model-hidden display item before `turn.failed` is
  projected.
- On the normal terminal path, the same transaction also appends the durable
  `turn_lifecycle` outbox. Runtime projection consumes the committed
  `{ turn, outbox }` result; it must not rebuild the terminal code, message,
  safe detail, usage, or kind from request-local values after commit.
- `turn.failed` owns terminal failure content. `turn.status` and
  `status.update` update state only.

### Storage And Resume

- Storage applies `canonicalRuntimeFailureMessage()` and
  `sanitizeRuntimeErrorDetail()` again at the persistence boundary.
- A failed turn and its readable error item share a stable turn-derived id.
- `/resume` restores the persisted error item with the same main message and
  optional `additional_details` metadata as the live failure. Neither display
  field is injected into model context.

### Gateway And TUI

- `gateway.error` represents one failed RPC. It must not stop an otherwise
  active turn.
- Distinct gateway failures remain distinct even when their text matches.
- Re-delivery of the same terminal turn failure is idempotent by stable
  identity, not by adjacent-text comparison.
- TUI reducers consume structured error events, finalize foreground tool rows,
  and render one notice. `runtimeErrorRecoveryHint()` derives optional recovery
  guidance only from a validated runtime code; hints are neither persisted nor
  parsed from Provider text, so live and `/resume` projection stay identical.
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

Schema validation is mandatory at external/gateway boundaries and independent
runtime validation is mandatory at Worker and storage trust boundaries.

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
