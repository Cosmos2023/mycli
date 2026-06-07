# Codex Alignment P16 Approval Resume Enforcement Hardening

## Goal

Harden the approval and suspended-turn recovery path after P14/P15 runtime
enforcement work. A turn that is denied or paused for approval must remain
explainable, resumable, and bounded across restart, `/resume`, and root-to-tip
lineage changes.

## What I Already Know

- P14/P15c now enforce shell execpolicy and sandbox policy before tool execution.
- `TurnExecutor.execute_user_turn()` already blocks new turns while a pending
  decision exists.
- `TurnExecutor.execute_user_turn()` can synthesize a `PendingDecision` from
  `SuspendedTurn.pending_approval` for display.
- `TurnExecutor.resolve_pending_approval()` currently starts by loading only
  `pending_decision`. If the persisted `pending_decision` row is missing but a
  structured suspended turn still has `pending_approval`, the user can be shown
  a pending approval but the approval response is treated as `no_pending_decision`.
- `SessionService.reconstruct_suspended_turn(...)` can rebuild a suspended turn
  from runtime snapshot and waiting-approval rollout state when only the
  `pending_decision` row remains.
- Existing tests cover root-to-tip pending approval/clarification resume,
  missing suspended-turn reconstruction from runtime state, approval allowance,
  rejection, invalid choice, and doctor redaction for approval diagnostics.

## Requirements

- Make approval resolution use a consistent recovered approval state:
  - normal case: `pending_decision` + `suspended_turn.pending_approval`;
  - fallback A: only `suspended_turn.pending_approval` exists;
  - fallback B: only `pending_decision` exists and suspended turn can be
    reconstructed from runtime snapshot.
- Keep `needs_approval` and rejected approval states terminal: they must not be
  represented as ordinary successful tool output.
- Keep existing approval choices and session allowance semantics intact.
- Emit bounded diagnostics when approval resume state is recovered from fallback
  storage or cannot be recovered.
- Keep diagnostics out of provider-visible transcript, request shape, stable
  prompt, and provider payload snapshots.
- Preserve `/resume root -> branch tip` behavior before approval resolution.
- Do not change compact/rehydration implementation.

## Acceptance Criteria

- Regression test: approval resolution succeeds when `pending_decision` is
  missing but `suspended_turn.pending_approval` exists.
- Regression test: the recovered decision uses the actual allowed choices,
  including `ALLOW_SESSION` only when `command_pattern` exists.
- Regression test: existing pending-decision-only reconstruction still works.
- Regression test: bounded approval resume-state diagnostics do not expose raw
  command, raw tool arguments, raw user prompt, raw tool output, headers, or
  secrets.
- Doctor/trace diagnostics remain bounded and summarize recovery status without
  raw payloads.
- P14/P15 runtime policy, shell enforcement, and sandbox tests keep passing.
- Context/provider-cache smoke does not regress.
- Compact/rehydration implementation files remain untouched.

## Non-goals

- No compact/rehydration implementation changes.
- No Codex compact rehydration mimicry.
- No OS sandbox, container, firewall, or remote agent work.
- No real provider API calls.
- No new third-party dependencies.
- No broad approval UI/TUI redesign.

## Technical Notes

- Primary files:
  - `src/mycli/application/runtime/turn_executor.py`
  - `src/mycli/state/session_service.py`
  - `src/mycli/services/diagnostics/doctor.py`
  - `tests/integration/test_turn_service.py`
  - `tests/unit/services/test_doctor_service.py`
- Relevant specs:
  - `.trellis/spec/backend/context-management-contract.md`
  - `.trellis/spec/backend/quality-guidelines.md`
  - `.trellis/spec/backend/logging-guidelines.md`
  - `.trellis/spec/backend/runtime-tui-gateway-contract.md`
- Protected compact files for diff audit:
  - `src/mycli/domain/runtime/compaction_rehydration.py`
  - `src/mycli/services/context/compaction.py`
  - `src/mycli/services/context/compaction/rehydration.py`
  - `src/mycli/services/context/compaction/pipeline.py`
