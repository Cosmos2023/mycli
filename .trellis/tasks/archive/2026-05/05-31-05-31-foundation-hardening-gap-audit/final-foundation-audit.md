# Final Foundation Audit

Date: 2026-05-31

Worktree: `/Users/cosmos/Desktop/mycli/.worktrees/mycli-foundation-hardening-audit`

Branch: `feature/mycli-foundation-hardening-audit`

Latest implementation commit audited: `9040050 Make scripted smokes assert runtime turn states`

Final audit artifact commit: `cad2da2 Close the Hermes-like foundation hardening audit`

Baseline: `feature/mycli-hermes-parity-integration`

Merge policy: not merged to `main`.

Hermes reference policy: semantic/product reference only; no Hermes code copied.

## Verification

Current-state commands run in this worktree:

- `uv run pytest -q`
  - Result: `1200 passed in 19.85s`
- `npm --prefix tui/node run verify:deps`
  - Result: passed
- `npm --prefix tui/node test -- --runInBand`
  - Result: `137` tests passed
- `npm --prefix tui/node run typecheck`
  - Result: passed

Known verification caveat:

- Repo-wide `uv run ruff check .` is not used as the completion gate for this
  audit because unrelated pre-existing `.claude/.trellis` lint content is
  outside the foundation-hardening implementation scope. Slice-level ruff checks
  were recorded in the relevant archived Trellis task check results for changed
  Python files.

Trellis process caveat:

- This audit verifies the foundation goal against current code, tests, specs,
  and archived task evidence. It does not claim the whole repository Trellis
  tree is pristine:
  - `.trellis/tasks/` still contains older 05-29 planning/done task directories
    from prior branches.
  - An empty stale task directory exists at
    `.trellis/tasks/05-31-approval-rejection-terminal-state/research`; the real
    completed task is archived at
    `.trellis/tasks/archive/2026-05/05-31-05-31-approval-rejection-terminal-state/`.
  - Some early 05-31 archive directories predate the later check-results
    convention and do not contain `check-results.md`; their behavior is covered
    by the final full Python and Node verification commands above.

## Requirement Audit

### A. Session / State Parity

Status: achieved for the foundation goal.

Evidence:

- Root-to-tip resume and lineage behavior:
  - `src/mycli/infrastructure/sqlite_session_store.py`
  - `src/mycli/services/session_service.py`
  - `tests/unit/infrastructure/test_sqlite_session_store.py`
  - `tests/unit/services/test_session_service.py`
  - `tests/integration/test_turn_service.py`
  - `tests/integration/test_node_tui_gateway.py`
- Waiting-state recovery:
  - pending approval and pending clarification are persisted through suspended
    turn state and re-emitted through the gateway after resume.
  - real gateway smokes cover resume-tip approval and clarification response.
- Maintenance and integrity:
  - orphan cleanup, empty cleanup, explicit vacuum, lineage cycle detection,
    missing parent detection, malformed recovery payloads, unresumable pending
    approval, and unresumable pending clarification are covered by store,
    service, and doctor tests.
- Search:
  - runtime history search is backed by `history_items_fts`, service tests, and
    doctor schema checks.

Remaining Hermes gap:

- This is a durable local-agent foundation, not a full Hermes state product.
  More advanced migration UX, large-scale pruning policy, and operator tooling
  can be improved later, but the goal's required resume/fork/compaction/waiting
  and doctor coverage are present.

### B. Runtime Contract Parity

Status: achieved for the foundation goal.

Evidence:

- Stable contract surfaces:
  - `src/mycli/domain/runtime/gateway_contract.py`
  - `src/mycli/cli/node_tui/gateway.py`
  - `.trellis/spec/backend/runtime-tui-gateway-contract.md`
  - `tui/node/src/protocol/types.ts`
  - `tui/node/src/state/reducer.ts`
- Supported Hermes-like channels:
  - `runtime.event`
  - `message.delta`
  - `message.complete`
  - `reasoning.delta`
  - `thinking.delta`
  - `status.update`
  - `turn.status`
  - `tool.start`
  - `tool.progress`
  - `tool.complete`
  - `tool.failed`
  - `approval.request`
  - `approval.respond`
  - `clarify.request`
  - `clarify.respond`
  - terminal `completed`, `failed`, `interrupted`, `rejected`,
    `waiting_approval`, and `waiting_clarification` states
- Drift checks:
  - TypeScript methods match Python-supported event streams.
  - TypeScript payload contracts match Python manifest schemas.
  - Gateway error taxonomy is tested against the manifest.
- Interruption semantics:
  - `turn.interrupted` remains terminal for the same `client_turn_id`.
  - late successful completions are suppressed and recorded as
    `turn.completion_suppressed`.

Remaining Hermes gap:

- The contract is suitable for the Node TUI and future extension/ACP clients,
  but ACP productization itself is intentionally excluded from this goal.

### C. Tool / Approval / Safety Foundation

Status: achieved for the foundation goal.

Evidence:

- Tool lifecycle:
  - `src/mycli/application/runtime/tools/tool_execution_service.py`
  - `tests/unit/application/test_tool_execution_service.py`
  - `tests/unit/cli/node_tui/test_gateway.py`
  - `tui/node/test/reducer.test.ts`
  - `tui/node/test/transcript.test.ts`
  - `tests/integration/test_node_tui_gateway.py`
- Approval and safety:
  - `src/mycli/services/approval/approval_service.py`
  - `src/mycli/services/safety_policy.py`
  - `tests/unit/services/test_approval_service.py`
  - `tests/unit/services/test_safety_policy.py`
- Covered behaviors:
  - stable approval decision IDs
  - `approve_once`, `reject`, and `allow_session`
  - medium-risk tool gating for local mutation tools such as `Write`, `Edit`,
    and `KillShell`
  - safe summaries for tool arguments and long output
  - tool success, failure, denial, interruption, and diagnostic trace linkage
  - TUI-visible tool timeline updates without duplicated rows

Remaining Hermes gap:

- The foundation can observe, approve, reject, interrupt, and diagnose tools.
  It does not productize external contributed tool ecosystems, MCP tools, or
  subagent tool routing in this goal.

### D. Diagnostics / Logs / Trace / Doctor Parity

Status: achieved for the foundation goal.

Evidence:

- Logging and redaction:
  - `src/mycli/utils/workspace_logger.py`
  - `src/mycli/services/logging/workspace_log_service.py`
  - `.trellis/spec/backend/logging-guidelines.md`
  - `tests/unit/services/test_workspace_log_service.py`
- Trace:
  - `src/mycli/services/tracing/trace_service.py`
  - `tests/unit/services/test_trace_service.py`
  - `/trace-jsonl` and `trace.export` coverage in CLI/gateway tests
- Doctor:
  - `src/mycli/services/diagnostics/doctor.py`
  - `tests/unit/services/test_doctor_service.py`
  - `tests/unit/cli/test_main.py`
- Covered diagnostics:
  - storage layout and logs
  - logs redaction, including nested/raw payload shapes
  - trace JSONL corruption and export behavior
  - stream diagnostics summaries
  - runtime contract/manifest drift
  - Node TUI dependency readiness
  - session DB schema, lineage, orphan, search, and recovery payload checks
  - approval, clarification, tool execution, interruption, and failed-turn
    diagnostics
  - bounded log rotation for long-running agents

Remaining Hermes gap:

- The diagnostics are actionable and local-agent ready. Hermes has a broader
  production operations surface; mycli still lacks full request-dump parity and
  long-horizon operator workflows beyond this foundation scope.

### E. Node TUI Gateway Foundation

Status: achieved for the foundation goal.

Evidence:

- Dependency and build reproducibility:
  - `tui/node/scripts/verify-deps.js`
  - `tui/node/dependency-markers.json`
  - `tui/node/.npmrc`
  - `tui/node/test/verify-deps.test.js`
- Protocol and reducer:
  - `tui/node/src/protocol/types.ts`
  - `tui/node/src/state/reducer.ts`
  - `tui/node/test/client.test.ts`
  - `tui/node/test/reducer.test.ts`
- Scripted real gateway smokes:
  - `tui/node/src/smoke/scriptedClient.ts`
  - `tests/integration/test_node_tui_gateway.py`
- Covered states:
  - streaming message/reasoning
  - final message completion
  - waiting approval
  - waiting clarification
  - approval rejection and wrong decision ID
  - strict write approval
  - tool lifecycle
  - failed turn
  - interrupted turn and late completion suppression
  - resume-tip waiting-state recovery
  - scripted expected terminal/waiting state assertions

Remaining Hermes gap:

- The Node TUI is now a stable runtime client foundation. Visual polish,
  advanced interaction design, and full Hermes-level TUI richness remain a
  later UI product track, not a blocker for this foundation goal.

## Non-Goals Confirmed

The following were intentionally not productized in this goal:

- MCP
- skills
- subagent / multi-agent
- ACP

Some existing placeholder or foundation interfaces may appear in code or
manifest surfaces, but they were not treated as complete product tracks.

## Final Status

The Hermes-like local agent foundation goal is complete for the scoped base
capabilities:

- durable and recoverable session state
- typed runtime/TUI contract
- observable tool and approval state machine
- actionable diagnostics, logs, trace, and doctor checks
- repeatably verified Node TUI gateway foundation

Recommended next goal:

1. Start MCP foundation/productization only after deciding the desired local MCP
   server/client contract.
2. Then add skills as a discoverable, testable tool-context layer.
3. Then harden subagent/multi-agent execution against the tool/approval
   foundation.
4. Finally expose ACP/extension product contracts on top of the stable runtime
   event envelope.
