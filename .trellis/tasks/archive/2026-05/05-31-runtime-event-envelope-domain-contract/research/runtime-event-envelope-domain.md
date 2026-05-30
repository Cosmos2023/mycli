# Runtime Event Envelope Domain Research

## Existing Implementation

- `NodeTuiGateway._emit_event(...)` emits the direct JSON-RPC method-name
  notification and then emits a `runtime.event` mirror.
- `NodeTuiGateway._runtime_event_envelope(...)` currently builds the envelope
  inline with a gateway-local `RUNTIME_EVENT_ENVELOPE_VERSION` constant.
- The envelope contract is already documented in
  `.trellis/spec/backend/runtime-tui-gateway-contract.md`.
- Tests already cover the gateway behavior:
  - mirrored envelope count matches direct event count
  - sequence numbers increase monotonically
  - payload/type preserve the direct notification
  - recursive wrapping is skipped for `runtime.event`

## Recommended Approach

- Keep `NodeTuiGateway` as the sequence owner because sequencing is per gateway
  instance and depends on emission order.
- Move only the stable envelope shape into `mycli.domain.runtime.events`:
  - `RUNTIME_EVENT_ENVELOPE_VERSION = 1`
  - `RuntimeEventEnvelope`
  - `to_dict()`
- Use a frozen slotted dataclass to match existing runtime domain style and keep
  construction explicit.
- Add cheap validation in `__post_init__` for impossible values. This gives
  future ACP/extension/MCP adapters a safe constructor without changing current
  gateway behavior.
- Export the new type and constant from `mycli.domain.runtime.__init__`.

## Why This Slice Matters

- Future external clients should subscribe to a stable runtime envelope shape
  rather than duplicate gateway-local dict literals.
- A domain type makes contract drift easier to catch in unit tests and type
  checks.
- Keeping this as a small extraction avoids mixing the next runtime contract
  work with TUI rendering or ACP implementation.

## Risks

- Over-validating payload contents could break current gateway events.
  - Mitigation: only validate envelope metadata, not event payload keys.
- Moving sequence generation into the domain type could blur ownership.
  - Mitigation: keep sequence increment in the gateway and pass the value to the
    domain constructor.
- Changing emitted dict order or payload identity could create unnecessary test
  churn.
  - Mitigation: preserve the existing key order and pass the original params
    object through as `payload`.

## Out Of Scope

- No TypeScript reducer changes.
- No JSON-RPC protocol version bump.
- No runtime event registry or enum conversion for gateway method names.
- No ACP, extension, MCP, or subagent consumers.
