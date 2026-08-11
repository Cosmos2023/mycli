# Enable safe parallel tool batches

## Goal

Bring the Node runtime's multi-tool execution behavior in line with Python
mycli: execute consecutive manifest-approved read-only tools concurrently while
preserving provider order, append-only durability, approvals, clarification,
hooks, interruption, and deterministic provider replay.

## What I Already Know

- The Node provider parser already accepts several tool calls in one response
  and persists the complete assistant tool-call batch before execution.
- `NodeTurnRuntime.#processToolBatch()` currently executes every call through a
  sequential `for...of` loop.
- The built-in manifest already marks `Read`, `web_fetch`, and `tool_search` as
  `supports_parallel_tool_calls=true`; mutation, interaction, planning, and
  shell tools are false.
- The manifest flag is currently declarative only and has no runtime consumer.
- Python mycli partitions tool calls into consecutive parallel-safe phases,
  uses a thread pool for each safe phase, treats non-parallel calls as barriers,
  and applies results in provider order.
- The Node active-tool lifecycle map currently stores only one tool per turn and
  must support several simultaneously active calls before parallel execution is
  safe.

## Requirements

- Use `supports_parallel_tool_calls` from the built-in manifest as the source of
  truth for Node tool concurrency.
- Execute consecutive parallel-safe tool calls concurrently.
- Flush a safe batch before every non-parallel tool, then execute that barrier
  tool alone before collecting the next safe batch.
- Keep unclassified and extension-provided tools sequential by default.
- Evaluate approval and pre-tool hooks before execution; an approval request,
  clarification-capable call, denied call, or modified non-parallel call must
  remain a sequential barrier.
- Emit and persist tool results in the provider's original call order even when
  actual completion order differs.
- Preserve the rule that assistant tool calls are committed before any tool
  starts and tool results are committed before the next provider request.
- Track every concurrently active call independently so interruption closes
  each started lifecycle exactly once.
- Do not persist late results after interruption or terminal failure.
- Preserve current plan updates, tool activation context, checkpoints, and hook
  context ordering.
- Do not modify Python behavior.

## Acceptance Criteria

- [x] Two consecutive parallel-safe calls both start before either is released
      by a controlled test fixture.
- [x] Parallel calls that finish in reverse order are persisted and replayed in
      original provider order.
- [x] A safe-safe-sequential-safe sequence executes as two safe phases separated
      by one single-call barrier.
- [x] Write, shell, planning, clarification, and unknown/external calls remain
      sequential unless their future manifest contract explicitly opts in.
- [x] A pending approval flushes earlier safe work and durably stores untouched
      remaining calls in original order.
- [x] Interrupting a parallel batch produces exactly one terminal lifecycle for
      every started call and no late result persistence.
- [x] Existing approval, clarification, provider replay, tool activation,
      checkpoint, and terminal recovery tests continue to pass.
- [x] Runtime, tools, app, and TUI typechecks plus targeted tests pass.

## Technical Approach

1. Extend the tool router with an optional, conservative concurrency query.
   `ToolRouter` receives the built-in manifest-approved name set; absent metadata
   means false.
2. Replace the single active-tool slot per turn with per-turn/per-call tracking.
3. Split tool execution from lifecycle completion so a parallel phase can start
   all calls, await ordered results, and only then commit terminal/result state
   in provider order.
4. Refactor `#processToolBatch()` into preparation, safe-phase flushing,
   sequential barriers, and ordered result application.
5. Add deterministic deferred-tool fixtures covering concurrency, barriers,
   reverse completion, failures, and interruption.

## Decision (ADR-lite)

**Context**: Unconditional `Promise.all` would allow write/approval tools to
race and would persist results in completion order. Keeping everything serial
wastes safe IO overlap and diverges from Python mycli.

**Decision**: Port Python's phased scheduler semantics and use manifest opt-in
as the concurrency gate. Preserve a single durable writer and ordered result
application.

**Consequences**: Read/network latency can overlap without changing canonical
conversation order. Adding future parallel external tools requires an explicit
metadata contract rather than becoming parallel accidentally.

## Out of Scope

- Agent Worker Pool implementation.
- Parallel execution of mutations, shell sessions, approvals, clarification,
  plan updates, or existing external tools.
- A configurable user-facing concurrency limit.
- Changes to provider request schemas or TUI presentation.
- Changes to Python mycli.

## Technical Notes

- Node batch loop: `backend/packages/runtime/src/node-turn-runtime.ts:1313`.
- Node manifest flags: `backend/packages/tools/src/manifest.ts:218-328`.
- Node router contract: `backend/packages/tools/src/types.ts:124-137`.
- Python phased runtime:
  `src/mycli/application/runtime/tools/tool_call_runtime.py:31-156`.
- Python assistant batch collection:
  `src/mycli/application/runtime/model/assistant_block_consumer.py:169-207`.
- Applicable specs:
  `.trellis/spec/backend/provider-tool-replay-contract.md` and
  `.trellis/spec/backend/tool-manifest-contract.md`.
