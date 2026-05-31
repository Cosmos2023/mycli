# Foundation Gap Matrix

Date: 2026-05-31

Baseline: `feature/mycli-hermes-parity-integration`

Work branch: `feature/mycli-foundation-hardening-audit`

Hermes reference source: `/Users/cosmos/Desktop/mycli/hermes-agent` (read-only)

## Summary

`mycli` already has meaningful foundation work: SQLite-backed sessions, WAL
retry behavior, persisted pending decisions and suspended turns, a versioned
`runtime.event` mirror, typed message/reasoning/tool/approval/clarify events,
trace export, doctor checks, and Node reducer handling for the main runtime
states.

The remaining gap is not "missing everything"; it is reliability and contract
hardening. The highest immediate blocker is Node TUI verification repeatability:
`npm --prefix tui/node ci` was interrupted locally and left a partial
`node_modules` containing only `es-toolkit`, so `verify:deps` fails and all
later TypeScript contract checks are blocked.

## Gap Matrix

| Area | Hermes reference behavior/tests | Current mycli behavior/files/tests | Gap | Risk | First hardening slice | Verification |
| --- | --- | --- | --- | --- | --- | --- |
| Session / State | Hermes uses a single SQLite state DB with WAL, schema migration, FTS, session lineage, root-to-tip resume, and state tests such as `tests/test_hermes_state.py`. | `src/mycli/infrastructure/sqlite_session_store.py` provides SQLite sessions, WAL fallback, retry, FTS5, conversation trees, history, rollouts, state rows, and summaries. `src/mycli/state/session_service.py` persists pending decision, suspended turn, clarification, plan, continuation, history, and rollouts. | Root-to-tip resume semantics, orphan cleanup, prune/vacuum, migration inspection, and lineage-tip doctor checks are not yet fully proven by integration tests. | Long-running sessions may resume an old branch/tip or keep stale waiting/orphan state. | Later slice: session recovery hardening with resume/fork/compaction/waiting integration tests and doctor checks. | `pytest tests/unit/infrastructure/test_sqlite_session_store.py tests/unit/services/test_session_service.py tests/integration/...` plus real resume/waiting smoke. |
| Runtime Contract | Hermes TUI gateway has explicit channels for message, reasoning/thinking, status, tool lifecycle, approval, clarify, and terminal turn states. | `src/mycli/cli/node_tui/gateway.py` emits direct notifications plus `runtime.event` envelopes. `src/mycli/domain/runtime/events.py` owns envelope version. `.trellis/spec/backend/runtime-tui-gateway-contract.md` documents payloads. | Contract exists but needs schema convergence across Python constants, TypeScript types, reducer tests, extension manifest, and docs. Runtime error taxonomy is still partial. | Future TUI/extension/ACP clients can drift from Python runtime semantics. | Later slice: contract/schema convergence. | Python gateway tests, TypeScript protocol/reducer tests, manifest assertions. |
| Tool / Approval / Safety | Hermes treats tools and approvals as observable runtime lifecycle state with user decisions and recoverable failures. | `src/mycli/application/runtime/tools/tool_execution_service.py` emits tool start/progress/complete/failed lifecycle events, handles clarification requests, records raw payload metadata, snapshots file mutations, and traces outcomes. Gateway supports `approval.respond` and `clarify.respond`. | Needs stronger coverage for interrupted/cancelled tools, long-output linkage to raw payload/logs, stable tool id fallback, allow-once/session/reject consistency, and high-risk shell/file approval policy. | Tool failure or interruption can confuse visible turn state or make diagnostics hard to correlate. | Later slice: tool/approval/safety hardening. | Tool lifecycle tests for success/failure/waiting/reject/interruption/long output plus TUI reducer tests. |
| Diagnostics / Logs / Trace / Doctor | Hermes separates structured state, request dumps, rotating logs, redaction, stream diagnostics, and doctor checks. | `src/mycli/services/logging/workspace_log_service.py`, `src/mycli/services/tracing/trace_service.py`, and `src/mycli/services/diagnostics/doctor.py` provide logs, model raw payloads, trace export validation, session DB checks, file-history checks, Node TUI dependency checks, and MCP placeholder status. | Doctor checks are useful but Node TUI dependency failure is still broad; stream diagnostics are minimal; session orphan/layout checks and log redaction self-checks need more coverage. | Failures are harder to self-diagnose, especially partial TUI installs and corrupted runtime artifacts. | Current slice: make Node TUI install/test/typecheck diagnostics repeatable and actionable. Later slice: broader doctor/log/trace hardening. | `pytest tests/unit/services/test_doctor_service.py tests/unit/services/test_workspace_log_service.py tests/unit/services/test_trace_service.py`; `mycli doctor`; trace export tests. |
| Node TUI Gateway | Hermes TUI acts as a stable runtime client with typed gateway events, robust status handling, and gateway smoke tests. | `tui/node/src/state/reducer.ts` consumes direct and envelope events, handles message/reasoning/status/tool/approval/clarify/failure states, and has many tests under `tui/node/test`. `tests/integration/test_node_tui_gateway.py` covers Python gateway paths. | Local dependency install is not repeatable yet. `npm ci` was interrupted and left only `node_modules/es-toolkit`; `verify:deps` reports missing `tsx`, `tsc`, `ink`, `react`, `typescript`. | TypeScript reducer/protocol safety cannot be trusted if tests/typecheck cannot run consistently. | Current first slice. Improve verification diagnostics and run `npm ci`, `npm test`, `npm run typecheck`. | `npm --prefix tui/node ci`; `npm --prefix tui/node run verify:deps`; `npm --prefix tui/node test`; `npm --prefix tui/node run typecheck`; Python gateway tests. |

## Local Node TUI Verification Evidence

Commands already run in this worktree:

- `node --version` -> `v24.14.1`
- `npm --version` -> `11.11.0`
- `npm --prefix tui/node ci` -> interrupted by the shell/tool layer without a
  normal npm completion line.
- `npm --prefix tui/node run verify:deps` -> failed with missing:
  - `node_modules/.bin/tsx`
  - `node_modules/.bin/tsc`
  - `node_modules/ink`
  - `node_modules/react`
  - `node_modules/tsx`
  - `node_modules/typescript`
- Partial install observed:
  - `tui/node/node_modules/es-toolkit`
- Latest npm debug log:
  - `/Users/cosmos/.npm/_logs/2026-05-31T02_17_00_464Z-debug-0.log`
  - The log records npm beginning `npm ci` and fetching cached packages, but no
    normal completion line was observed in the inspected output.

## Next Action

Harden the Node TUI dependency verification path so partial interrupted
installs are explicit, actionable, and test-covered. Then retry clean
dependency installation and run Node tests/typecheck.
