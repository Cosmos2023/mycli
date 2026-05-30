# Runtime Event Envelope Contract Research

## Existing Findings

- The Python Node TUI gateway currently emits JSON-RPC notifications where the
  method name is the event type, for example `turn.started`, `status.update`,
  `message.delta`, `tool.start`, and `turn.completed`.
- The current method-name contract is already used by the Node reducer and
  tests, so replacing it would create unnecessary churn and break older clients.
- The runtime contract spec explicitly says method-name notifications remain
  compatible until a versioned envelope migration is introduced.
- External surfaces such as future extensions, ACP bridges, and non-TUI clients
  would benefit from a single stable event stream shape instead of subscribing
  to every method name individually.
- The gateway already has one central emission boundary:
  `NodeTuiGateway._emit_event(method, params)`.
- The Node reducer already routes all incoming server notifications through
  one action shape: `{ type: "gateway.event", method, params }`.

## Recommended Shape

- Add a mirrored `runtime.event` JSON-RPC notification for gateway runtime
  events emitted through `_emit_event(...)`.
- Preserve every existing typed method-name notification as the primary
  compatibility path for the current Node TUI.
- Envelope payload:
  - `version`: integer contract version, starting at `1`
  - `sequence`: monotonically increasing integer per gateway instance
  - `type`: original event method, for example `message.delta`
  - `payload`: original event params object
  - `timestamp`: wall-clock UNIX seconds from the gateway process
- Do not wrap infrastructure notifications such as `runtime.ready` that are
  emitted outside `_emit_event(...)` during process bootstrap.
- Guard against recursive wrapping: emitting `runtime.event` must not create
  another `runtime.event`.
- On the Node side, treat `runtime.event` as an alternate transport for the same
  reducer semantics by unwrapping `params.type` and `params.payload`, then
  feeding the existing reducer logic.

## Why Mirror, Not Migrate

- The current TUI and tests are already green on method-name notifications.
- A mirror lets future clients adopt the envelope without forcing the current
  TUI to switch all event handlers at once.
- A mirror gives realistic smoke coverage for the envelope while preserving
  rollback: deleting the mirror restores old behavior.

## Risks

- Duplicating visible state if the same Node reducer consumes both the direct
  event and the envelope for a single server notification.
  - Mitigation for this slice: the real gateway emits both, but the current
    Node client logs both. Reducer-level `runtime.event` support should be
    tested in isolation. Full dedup or client-side preference is deferred until
    the TUI switches transport.
- Ordering matters because clients may use `sequence` for diagnostics.
  - Mitigation: emit direct typed event first, then its envelope mirror with the
    next sequence number, preserving direct-event behavior.
- Payload must remain bounded and must not include provider transcript content
  beyond what the existing typed events already expose.
  - Mitigation: envelope copies the existing event params exactly and does not
    add model/runtime internals.

## Out Of Scope For This Slice

- No removal of method-name notifications.
- No protocol version bump.
- No ACP or extension implementation.
- No TUI rendering changes.
- No client-side dedup strategy beyond reducer unwrapping tests.
