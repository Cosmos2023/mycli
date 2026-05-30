# Runtime Event Envelope Domain Contract

## Goal

Move the existing `runtime.event` envelope shape out of the Node TUI gateway
implementation and into the runtime domain layer. This keeps the Hermes-like
runtime contract as a typed, reusable boundary for future TUI, extension, ACP,
MCP, and diagnostic consumers while preserving current gateway behavior.

## Context

- The runtime gateway already mirrors method-name notifications as
  `runtime.event` envelopes with `version`, `sequence`, `type`, `payload`, and
  `timestamp`.
- The current envelope is assembled as a raw dict inside
  `NodeTuiGateway._runtime_event_envelope(...)`.
- `.trellis/spec/backend/runtime-tui-gateway-contract.md` already documents the
  envelope as a cross-layer contract.
- Future consumers should not depend on gateway-local constants or magic dict
  keys to understand the stable event stream.

## Research References

- [`research/runtime-event-envelope-domain.md`](research/runtime-event-envelope-domain.md)
  summarizes the existing envelope implementation and recommends a behavior
  preserving domain extraction.
- Archived prior slice:
  `.trellis/tasks/archive/2026-05/05-31-runtime-event-envelope-contract/`
  introduced the mirrored transport envelope.

## Requirements

- Add a domain-level runtime event envelope type/helper under
  `mycli.domain.runtime`.
- The domain contract must expose the current envelope version as a single
  shared constant.
- The domain type must serialize to the exact JSON-compatible dict shape:
  - `version`: integer, currently `1`
  - `sequence`: integer
  - `type`: original event method string
  - `payload`: original event params object
  - `timestamp`: UNIX timestamp seconds
- The domain type must reject invalid envelope construction where it can do so
  cheaply and deterministically:
  - blank event type
  - non-positive sequence
  - negative timestamp
- `NodeTuiGateway` must use the domain type/helper instead of assembling the
  envelope dict itself.
- Existing gateway emission behavior must not change:
  - direct method-name event first
  - `runtime.event` mirror second
  - monotonically increasing sequence per gateway instance
  - no recursive wrapping when method is already `runtime.event`
  - `runtime.ready` remains outside the mirrored runtime boundary
- Export the domain contract from `mycli.domain.runtime`.

## Non-Goals

- Do not remove or rename existing JSON-RPC notifications.
- Do not change Node TUI reducer/rendering behavior.
- Do not switch clients to prefer envelope-only transport.
- Do not implement ACP, extension, MCP, or multi-agent integrations in this
  slice.
- Do not copy Hermes implementation code.
- Do not merge into `main`.

## Acceptance Criteria

- Domain unit tests cover envelope serialization and validation.
- Gateway unit tests still prove mirrored envelopes preserve `version`,
  `sequence`, `type`, `payload`, and `timestamp`.
- Gateway unit tests still prove `runtime.event` does not recursively wrap
  itself.
- Focused Python tests pass for runtime domain and Node TUI gateway behavior.
- Python lint and type-check pass for the touched files.
- Trellis task is archived and work is committed only on
  `feature/mycli-runtime-event-envelope-domain`.
