# Turn Interrupt Diagnostics Closure

## Problem

`mycli` can show interrupted state in the Node TUI and can record runtime
`turn_interrupted` finalization diagnostics, but the gateway-level interrupt
request is not recorded. This leaves a diagnostic gap when interruption is
requested but the worker later finishes through a different path.

## Scope

Implement a complete runtime/TUI/doctor diagnostics closure for turn interrupt
requests.

Included:

- Add a service boundary method that records accepted interrupt requests as
  local trace/log diagnostics.
- Have the Node TUI gateway call that method when `turn.interrupt` targets a
  running turn.
- Keep existing gateway event payloads and reducer behavior compatible.
- Add doctor coverage summarizing interrupt requests and finalizations.
- Add unit/integration tests for gateway invocation, trace/log persistence,
  doctor summary, and existing Node scripted smoke.
- Update runtime gateway/logging specs.

Excluded:

- No true cooperative cancellation of provider/tool execution in this slice.
- No change to the external `turn.interrupt` RPC response shape.
- No MCP/skills/subagent/ACP productization.
- No merge to `main`.

## Requirements

### A. Runtime Diagnostic

- Accepted running-turn interrupts append a `turn_interrupt_requested` trace row.
- Payload is bounded and contains only stable diagnostic fields:
  `session_id`, `client_turn_id`, `requested`, and `source`.
- A workspace log entry records the same event without user text, tool output,
  provider payloads, headers, or secrets.
- Idle interrupt requests remain no-op diagnostics and return
  `{"interrupted": false}` as before.

### B. Gateway Boundary

- `NodeTuiGateway` calls the service diagnostic method only after confirming a
  turn is currently running.
- Fake/test services without the method remain compatible.
- Existing `turn.interrupted`, `turn.status`, `status.update`, and runtime
  envelope behavior stays unchanged.

### C. Doctor

- Add `turn_interrupt_diagnostics`.
- Missing traces or no interrupt rows -> OK.
- Valid request/finalization rows -> OK with bounded counts.
- Unreadable trace files -> failed.
- Summary must not print raw payloads or user messages.

## Acceptance Criteria

- Gateway unit tests prove accepted running interrupts call the service method
  and idle interrupts do not.
- TurnService tests prove trace/log persistence for interrupt requests.
- Doctor tests prove missing/no rows, clean summary, and unreadable behavior.
- Existing interrupted Node scripted smoke still passes.
- Focused Python tests pass.
- Full Python tests pass.
- Node TUI test and typecheck pass.
- Trellis task is archived and committed on the feature branch.
