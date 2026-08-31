# Current Diagnostic Flow

## Scope

This note traces the existing mycli error and doctor paths before Phase 7 changes. It distinguishes
facts in the repository from design conclusions for this task.

## Existing authoritative boundaries

- `backend/packages/contracts/src/runtime-errors.ts` owns runtime error codes, public messages,
  retry semantics, bounded detail redaction, display severity, and optional recovery hints.
- Provider exceptions become a `RuntimeFailure` before they cross the runtime boundary. A terminal
  failure is durably recorded before the gateway projects `turn.failed`.
- `turn.failed` is already the sole terminal-turn content event. `turn.status` and `status.update`
  update state only. The TUI derives the stable notice id from the turn id and therefore handles
  live re-delivery and `/resume` idempotently.
- `gateway.error` is a separate request-scoped lane. The gateway emits it after a failed JSON-RPC
  request, and the TUI keeps it from terminalizing an otherwise active turn.
- `backend/packages/config/src/config-diagnostics.ts` owns configuration diagnostics including
  layer, key path, line, column, and remediation. Doctor projects those fields instead of parsing
  raw TOML errors.
- `backend/apps/mycli/src/management/doctor/` already isolates collectors, bounds their execution,
  redacts collector output, and derives human and JSON output from one report.
- `tui/mycli-shell/src/fatal-error.ts` is intentionally outside the conversation protocol and
  persists only bounded, redacted local diagnostics for fatal TUI failures.

## Remaining gaps

- Runtime hints are prose-only and cover only part of the error-code set. There is no shared typed
  category or recovery-action vocabulary that doctor, gateway request failures, and TUI surfaces
  can project consistently.
- Gateway request failures carry `{code, message, data}`. Most callers receive no safe recovery
  action, and `GatewayFailure.data` is not validated as a public diagnostic payload.
- Doctor rows expose only `name`, `status`, `message`, and one `detail` string. Category, stable code,
  remediation, duration, and multiple bounded details are not first-class fields.
- Doctor currently covers config, storage, runtime package layout, extensions, process support, and
  sandbox readiness. Credential readiness is embedded in config, while terminal and update health
  have no dedicated collector.
- Local request rejection and the gateway notification can both reach the TUI. The reducer already
  has tests for preserving distinct errors, but the identity of one request failure is not carried
  end-to-end. Deduplication therefore depends on timing and field matching in the app layer.

## Design conclusion

Phase 7 should extend the existing boundaries rather than introduce a second exception hierarchy:

1. Add a small public diagnostic contract with closed categories and recovery-action ids.
2. Map existing runtime codes and gateway failure codes into that vocabulary at their owning
   backend boundaries.
3. Enrich doctor rows with the same vocabulary while preserving config diagnostic ownership.
4. Let the TUI project the structured payload; it must never classify raw provider or Node errors.
5. Give request failures a stable occurrence id so the local response rejection and matching
   `gateway.error` notification collapse to one row without merging distinct failures.

## Relevant files

- `backend/packages/contracts/src/runtime-errors.ts`
- `backend/apps/mycli/src/node-runtime/node-gateway-errors.ts`
- `backend/apps/mycli/src/node-runtime/node-gateway.ts`
- `backend/apps/mycli/src/management/doctor/`
- `tui/mycli-shell/src/adapters/runtime-state.ts`
- `tui/mycli-shell/src/components/command-diagnostic.ts`
- `.trellis/spec/backend/error-handling.md`

