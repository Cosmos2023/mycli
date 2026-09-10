## Why

mycli has 17 runtime error classes, separate free-form tool and gateway codes, and multiple recovery mappings. Specific causes are lost at conversion boundaries, so a text-only model receiving a tool image produces a generic configuration hint, while a gateway disconnection can obscure whether accepted work completed.

## What Changes

- Define one versioned error context and reason registry shared by adapters, runtime, persistence, gateway clients, and user-facing projections. Keep local exception classes and existing lifecycle ownership.
- Separate the concrete reason, reporting source, affected scope, and execution outcome. Preserve the existing runtime `code`, tool `errorKind`, and RPC `error.code` as compatibility fields.
- Centralize reason-specific public messages, allowed safe context, and recovery action definitions. Resolve recovery using execution state and current capabilities; remove competing hint mappings.
- Preserve error identity and structured causes through Worker RPC, retries, committed terminal records, session replay, headless output, and TUI notices.
- Introduce capability checks at tool exposure and dispatch. An unsupported image tool must return a recoverable tool failure before reading or attaching an image; an image-bearing historical conversation must offer an explicit supported-model recovery without modifying history.
- Keep ordinary tool/RPC failures local, cancellation separate from system failure, and unknown-effect operations protected from automatic replay.
- Add catalog coverage, compatibility, redaction, lifecycle, and rendering regression gates so new errors cannot bypass the contract.

## Capabilities

### New Capabilities

- `error-system`: A unified contract for error identity, reasons, ownership, execution outcome, recovery, diagnostics, and consistent live/restored presentation.

### Modified Capabilities

None. Existing OpenSpec capabilities cover web fetch and tool search; this cross-cutting contract is new.

## Impact

- `backend/packages/contracts`: Canonical schemas, generated types, registry validation, legacy mappings, public presentation and recovery action definitions.
- `backend/packages/providers`, `tools`, `integrations`, and `config`: Boundary-specific cause classification and capability checks; no new universal exception superclass.
- `backend/packages/runtime`: Context-aware recovery decisions, tool-local failures, retry/cancellation semantics, and Worker propagation.
- `backend/packages/storage`: Optional error context in existing durable records, round-trip validation, and legacy history compatibility. No rewriting of user history.
- `backend/apps/mycli`: Gateway/management/headless adapters, capability negotiation, operational diagnostics, and the existing supervisor failure path.
- `tui/mycli-shell`: Shared reason-specific notices, executable recovery actions using existing command handlers, stable deduplication, and private diagnostics.
- Tests and documentation: A reason coverage matrix, shared fixtures, live/resume equivalence, mixed-version behavior, and failure-injection regressions.

No new dependency is planned. Rollout is additive for existing histories and negotiated for live clients; changing the installed provider or removing persisted images remains an explicit user operation.
