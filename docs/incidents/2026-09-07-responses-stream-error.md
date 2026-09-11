# Responses Stream Error Lost Before Retry and Persistence

## Evidence

The affected turn failed on 2026-09-07 at 03:15:47 UTC. Its final provider attempt had emitted six
reasoning deltas and no text, tools, usage, or completion. The diagnostic recorded attempt 1,
`provider_error`, and `retryable=false`; HTTP status and upstream code/type/detail were absent.
The stored turn therefore contained only the generic `provider request failed` message.

The upstream events supplied during investigation were, in order:

```text
data: {"error":{"code":"stream_read_error","message":"stream_read_error","type":"upstream_error"},"sequence_number":0,"type":"error"}

event: response.failed
data: {"response":{"error":{"code":"upstream_error","message":"Upstream request failed"},"id":"resp-fixture","output":[],"status":"failed"},"type":"response.failed"}
```

The response identity above is synthetic. Replaying these error shapes through the pinned
`@earendil-works/pi-ai@0.84.4` with mocked HTTP 200 reproduced the non-retryable failure and empty
diagnostics. Replaying only `response.failed` retained the reason and was retryable. No live
provider request or user session mutation was needed for the reproduction.

## Root Cause

1. The OpenAI SDK used by pi-ai intercepts a top-level `data.error` object before pi-ai's Responses
   event handler. It throws `APIError(undefined, data.error, ...)`, so this exception has no HTTP
   error status even though its code, type, and message are available at that point.
2. Pi-ai's error formatter returns only `stream_read_error` for this error. The adapter received
   that display string rather than the structured object.
3. Mycli's fallback decoder recognized structured JSON and code-prefixed SDK strings. The bare
   message matched neither and became a generic `ProviderFailure` with `retryable=false`, no
   public detail, and no diagnostics.
4. The existing SSE boundary correctly stopped at the first terminal event. The later
   `response.failed` could not rescue details lost from the first event.
5. Runtime consequently skipped its retry paths. Storage and TUI received the already-empty
   failure, so both showed only the generic message.

This is a cross-layer contract failure and a test coverage gap: earlier tests exercised flat
`error` and `response.failed` envelopes with codes, not the SDK's nested-error interception path.
String-based decoding also lost type-only fatal errors, sometimes making them retryable.
The earlier 2 MiB Worker request limit was a separate pre-dispatch problem; it cannot explain an
attempt that already emitted six provider events.

## Fix

- Observe flat/nested `error` and `response.failed` objects at the existing SSE parser boundary,
  before SDK formatting. Immediately classify and sanitize them into a canonical `ProviderFailure`.
- Retain only bounded code/type, public reason, status, safe request id, and retry timing. Never
  retain the raw envelope, credentials, response body, or stack in attempt evidence.
- Give caller cancellation priority, then the first structured remote failure, including when
  the SDK reports an error string, throws, ends, or translates its terminal result differently.
- Keep runtime's existing bounded retry budgets, backoff, output reset, and tool commit boundary.
  Fatal authentication, permission, quota, context, and invalid-request categories still win.
- Use existing diagnostic propagation: every failed attempt writes safe trace fields; exhausted
  turns persist the last error diagnostics and `additional_details`; gateway and TUI show that
  detail both live and after session resume.

For the reported first event, the TUI can show `stream_read_error` during retry and after retry
exhaustion. The first terminal error remains authoritative; mycli does not wait for a later,
possibly friendlier error event. Existing historical rows with missing details are not rewritten.

## Regression Coverage

- Providers: the reported pair, flat/nested envelopes, missing/null/invalid codes, type-only fatal
  errors, safe redaction, first-terminal authority, and SDK terminal translation changes.
- Fetch boundary: trailing events in one network chunk, backpressure and cancellation, bounded
  evidence, and source cleanup that never acknowledges cancellation.
- Runtime: successful recovery and exhaustion after text/tool fragments or six reasoning-only
  deltas; fatal errors do not retry and successful recovery discards incomplete tool arguments.
- Worker/SQLite integration: one committed tool execution, two failed attempts with diagnostics,
  exactly one retry, one terminal notice, and identical detail after reopening and resuming.
- TUI: live and resumed notices render the safe reason at 40, 80, and 120 columns without overflow.

The upstream `stream_read_error` identifies a read failure inside the upstream service. It does
not reveal that service's underlying socket, timeout, or model error. Mycli can recover within
its retry budget and preserve the diagnosis; identifying the upstream fault further requires
the upstream service's own logs.
