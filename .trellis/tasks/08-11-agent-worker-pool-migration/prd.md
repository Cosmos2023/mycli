# Agent Worker Pool migration

## Goal

Move Node mycli agent execution from one backend event loop to a reusable Agent
Worker Pool so root and subagent turns can run in parallel and a blocked turn
can be terminated without restarting unrelated agents or the coordinator.

## What I already know

- Node 24 remains the runtime baseline.
- The TUI and outer backend supervisor currently run in the main Node process;
  the backend itself runs in one `worker_threads.Worker`.
- Root and subagent agent loops currently execute as Promises inside that one
  backend Worker.
- The outer supervisor terminates and restarts the whole backend Worker when a
  turn interrupt remains pending for 250 ms.
- Shell, PTY, MCP stdio, plugin, and hook effects already use OS child processes
  with process-tree cleanup.
- The current logical agent scheduler allows four resident slots including the
  root agent.
- The user accepts a substantial internal refactor and wants Codex-like precise
  per-turn cancellation and real parallel agent execution.
- Python mycli must remain in the repository.

## Requirements

- Use a coordinator-owned pool of reusable Node Workers.
- Lease one Worker to at most one active turn at a time.
- Allow a root turn and active subagent turns to occupy different Workers.
- Keep SQLite, append-only writes, turn reservation, terminal state,
  approval/clarification, queue/mailbox mutation, tool ownership, and gateway
  publication in the coordinator.
- Keep logical sessions independent of Worker lifetime; idle subagent sessions
  consume no Worker.
- Persist every model-visible input before sending the corresponding provider
  request.
- Fence every Worker message by worker generation, job, session, turn, and
  monotonic per-job sequence.
- Attempt cooperative cancellation first, then terminate and replace only the
  target Worker when it does not settle within the grace period.
- Preserve process-tree cleanup and explicit unknown-effect outcomes for tools.
- Retain whole-coordinator restart only as a final watchdog path.
- Preserve existing TUI/gateway behavior, session resume, steering, follow-ups,
  subagent mailboxes, models, slash commands, permissions, and launch command.
- Use Node built-ins rather than adding a generic Worker Pool dependency.
- Never expose API keys or secret provider configuration through diagnostics,
  persisted Worker messages, traces, or transcript rows.

## Acceptance Criteria

- [ ] Pool size four permits one root turn and three child turns to be active on
      four distinct `worker_threads.threadId` values.
- [ ] No Worker executes two active turns concurrently.
- [ ] Hard-interrupting one subagent does not interrupt the root or siblings.
- [ ] Hard-interrupting the root does not implicitly kill independently running
      children unless an explicit parent/child policy requests it.
- [ ] A blocked job receives cooperative cancellation, then only its leased
      Worker is terminated and replaced.
- [ ] Routine hard interruption does not change the coordinator Worker
      generation.
- [ ] Every accepted interrupt persists exactly one interrupted terminal turn
      and exactly one terminal result for every started tool.
- [ ] Late messages from a terminated lease cannot persist output or replace a
      terminal state.
- [ ] Mutating tools with an unprovable outcome use
      `effect_outcome_unknown`; other interrupted tools use
      `tool_interrupted`.
- [ ] Every provider request has a previously committed model-input ledger step.
- [ ] Approval, clarification, steering, follow-up, mailbox, and resume tests
      pass with Worker execution enabled.
- [ ] Shell process-tree cleanup remains correct on POSIX and Windows adapters.
- [ ] `npm run mycli` and the public TUI/gateway contract remain compatible.
- [ ] Python source and Python CLI behavior remain unchanged.

## Definition of Done

- Unit tests cover protocol validation, Worker generation fencing, pool
  scheduling, targeted termination, replacement, and shutdown.
- Integration tests cover concurrent root/child execution, interruption races,
  approvals, tools, session resume, and Worker/coordinator crashes.
- PTY and real Responses API smoke tests pass using environment-provided
  credentials without logging secrets.
- `npm run typecheck`, `npm run lint`, `npm test`, package smoke, TUI PTY smoke,
  agent smoke, and `git diff --check` pass.
- Runtime, interruption, subagent, troubleshooting, and architecture docs are
  updated.
- Rollout and rollback behavior is explicit; no silent production fallback
  changes cancellation guarantees.

## Technical Approach

The backend Worker becomes a coordinator. It owns durable state and external
effects and creates a reusable Agent Worker Pool. Each active root or subagent
turn leases one Worker for the whole provider/tool loop. Worker requests that
need persistence, tools, approval, clarification, or gateway publication are
served through a validated coordinator broker.

Implementation is staged:

1. Lock baseline contracts and tests.
2. Split `NodeTurnRuntime` into coordinator orchestration and a transport-neutral
   `AgentLoop`, retaining an in-process adapter.
3. Add the versioned Worker protocol and coordinator broker.
4. Add the single-job Worker Pool.
5. Migrate subagent execution.
6. Migrate root execution.
7. Replace routine whole-backend hard restart with targeted Worker termination.
8. Add crash recovery, observability, resource controls, docs, and cleanup.

## Decision (ADR-lite, evolving)

**Context**: A JavaScript Promise cannot be forcefully stopped. The current
whole-backend Worker restart is a hard boundary but interrupts unrelated work.

**Proposed decision**: Use one reusable Agent Worker per active turn while
keeping all durable and effectful ownership in one coordinator.

**Consequences**:

- Root and child agent JavaScript can run in parallel.
- Hard interruption becomes turn-scoped.
- The agent loop must cross an explicit asynchronous broker boundary.
- Worker protocol, sequencing, crash recovery, and backpressure become new
  correctness-critical components.
- Generic pools are insufficient because jobs are stateful and terminal
  persistence must be coordinated.

## Open Questions

- Should the first implementation scope deliver the complete root + subagent
  migration under this one Trellis task, or stop after subagents prove the
  Worker protocol and pool?

## Out of Scope

- Removing or rewriting Python mycli.
- Moving SQLite writes into Agent Workers.
- Running every tool in a Worker; Shell/MCP/plugin/hook process ownership stays
  with the coordinator.
- Changing TUI rendering or adding model-visible Worker diagnostics.
- Replacing OS child processes with Workers.

## Research References

- [`research/codex-and-node-agent-execution.md`](research/codex-and-node-agent-execution.md)
  - Codex cancellation/task architecture and the recommended Node mapping.
- [`research/pi-agent-execution-model.md`](research/pi-agent-execution-model.md)
  - pi-agent's single-loop core, process-per-subagent extension, and the parts
    worth adopting without giving up coordinator-owned durability.

## Technical Notes

- Current whole-backend watchdog:
  `backend/apps/mycli/src/node-runtime/node-backend-supervisor.ts:30-210`.
- Current gateway interruption boundary:
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:2043-2105`.
- Current combined runtime responsibilities:
  `backend/packages/runtime/src/node-turn-runtime.ts:322-390` and
  `backend/packages/runtime/src/node-turn-runtime.ts:1509-1557`.
- Current logical subagent execution:
  `backend/packages/runtime/src/agent-supervisor.ts:239-351` and
  `backend/packages/runtime/src/agent-supervisor.ts:487-550`.
- Current scheduler capacity:
  `backend/packages/runtime/src/agent-scheduler.ts:26-75`.
- Current external process cleanup:
  `backend/packages/tools/src/process-controller.ts:63-95`.
- Applicable cross-layer rules:
  `.trellis/spec/guides/cross-layer-thinking-guide.md`.
