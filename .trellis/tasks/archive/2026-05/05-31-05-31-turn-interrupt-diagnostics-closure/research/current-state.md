# Turn Interrupt Diagnostics Current State

## Context

`turn.interrupt` is exposed through the Node TUI gateway. When a turn is
running, the gateway emits `turn.interrupted`, `turn.status(state=interrupted)`,
and `status.update(state=interrupted)`, and the Node scripted smoke proves the
TUI consumes that state. Runtime finalization can also record
`turn_interrupted` trace/log diagnostics when the Python runtime catches an
actual interruption and saves suspended state.

## Gap

The interrupt request itself is not persisted as local diagnostics. If a client
requests interruption and the running worker later completes normally, fails, or
never reaches runtime interruption finalization, doctor cannot distinguish:

- no interruption was requested,
- an interrupt was requested at the gateway,
- runtime finalized and saved interrupted-turn recovery state.

Hermes-like local agent foundations need this visibility because interruption
is a control-plane action that can race with runtime execution.

## Slice Direction

Record a bounded `turn_interrupt_requested` trace/log diagnostic from the
service boundary when the gateway accepts `turn.interrupt` for a running turn.
Add doctor summary coverage for requested vs finalized interruptions, and keep
Node TUI state behavior unchanged.
