## 1. Core Agent Contracts And Persistence

- [x] 1.1 Add typed agent IDs, canonical paths, lifecycle states, spawn configuration snapshots, commands, results, and canonical events to the Node core contracts.
- [x] 1.2 Add canonical path validation, descendant construction, same-root routing checks, and collision handling with focused unit tests.
- [x] 1.3 Add storage interfaces and implementations for durable agent thread metadata, spawn edges, runtime leases/checkpoints, and lifecycle transitions.
- [x] 1.4 Add backward-readable migration or projection from existing subagent task records and prove existing completed, failed, and interrupted reports remain accessible.
- [x] 1.5 Add persistence tests for atomic path reservation, topology queries, legal state transitions, and rollback after rejected spawns.

## 2. Supervisor And Independent Thread Runtime

- [x] 2.1 Introduce `AgentSupervisor`, `AgentRuntimePool`, and child thread runtime contracts, and make the supervisor the sole lifecycle mutation boundary.
- [x] 2.2 Replace reduced child runtime creation with normal durable session/thread construction using independent conversation, transcript, event, task, subagent, cancellation, and continuation state.
- [x] 2.3 Implement spawn, load, idle, unload, resume, terminal finalization, and resource release transitions with supervisor unit tests.
- [x] 2.4 Wire real provider, tool, queue-wait, and runtime cancellation into `interrupt_agent` and real resource cleanup into close/unload.
- [x] 2.5 Adapt the existing `Task` path to delegate to the supervisor without maintaining a second child ownership map.

## 3. Spawn Configuration And Context

- [x] 3.1 Build and persist immutable child snapshots for workspace, cwd, selected environment, sandbox, network, approval/full-access state, model/provider, tools, budgets, and instruction layers.
- [x] 3.2 Implement least-authority policy intersection and tests covering full-access inheritance, approval-required inheritance, explicit narrowing, and rejected privilege expansion.
- [x] 3.3 Apply project and the generic subagent instruction through explicit system/developer layers and keep the parent task as user content.
- [x] 3.4 Implement `fork_turns` parsing for `none`, `all`, and last-N with a default of `none`.
- [x] 3.5 Implement committed-history fork filtering and tests proving pending queue items, internal notifications, unsafe tool transport, and provider continuation IDs are not copied.

## 4. Scheduler, Nesting, And Budgets

- [x] 4.1 Add an `AgentScheduler` with atomic resident-slot reservation, a configurable total defaulting to four including root, and typed capacity errors.
- [x] 4.2 Add idle least-recently-used unload selection and prove protected, running, and waiting agents are not evicted.
- [x] 4.3 Replace the unconditional child coordination denylist with configurable tool scope and maximum-depth enforcement, initially defaulting to depth one.
- [x] 4.4 Enforce optional turn, tool-call, token, no-progress, and wall-clock budgets at runtime boundaries and return typed exhaustion outcomes.
- [x] 4.5 Add race and boundary tests for concurrent final-slot spawns, nested spawns, slot release, omitted unlimited budgets, and each configured budget.

## 5. Durable Mailbox And Coordination Tools

- [x] 5.1 Add typed inter-agent communication records to the durable session input queue with receiver ordering, sender/receiver paths, trigger mode, source call ID, and deterministic deduplication.
- [x] 5.2 Implement mailbox delivery to loaded and unloaded receivers, same-root authorization, alias resolution, and idempotent recovery repair.
- [x] 5.3 Implement and register `spawn_agent`, `send_message`, `followup_task`, `interrupt_agent`, and `list_agents` adapters with strict schemas and typed results.
- [x] 5.4 Extend `wait_agent` to subscribe to mailbox, lifecycle, completion, user-steering, cancellation, and timeout activity without polling.
- [x] 5.5 Route terminal completion through deterministic parent mailbox delivery and preserve bounded reports, output references, and at-most-once provider injection.
- [x] 5.6 Keep only profile-free `Task` as a supervisor-backed compatibility adapter; remove legacy `SendMessage`, `SubagentOutput`, and profile discovery from runtime composition and exports.
- [x] 5.7 Add integration tests for queue-only delivery, triggered follow-up, sibling routing, unloaded receivers, automatic completion, invalid targets, wait wake reasons, and legacy routes.

## 6. Reload And Restart Recovery

- [x] 6.1 Persist runtime generation leases and committed checkpoints around provider turns and tool dispatch boundaries.
- [x] 6.2 Implement on-demand rehydration of idle and unloaded agents from durable history and frozen spawn configuration.
- [x] 6.3 Implement startup reconciliation that restores safe idle state, repairs missing completion delivery, and interrupts stale uncommitted side effects without replaying them.
- [x] 6.4 Add restart integration tests for idle reload, queued mail, duplicate repair, stale provider work, uncommitted mutating tools, and follow-up after recoverable interruption.

## 7. Events, Artifacts, And TUI

- [x] 7.1 Publish the canonical typed event stream for reservation, spawn, load, start, wait, communication, interruption, unload, completion, and failure.
- [x] 7.2 Move session, transcript, task, subagent, usage, and parent-notification projections from direct controller callbacks to canonical events.
- [x] 7.3 Ensure every child generates root-session-equivalent session, event, task, subagent, transcript, and usage artifacts under its own thread identity.
- [x] 7.4 Render the agent tree and all coordination tool lifecycle rows in the TUI while suppressing provider-only mailbox payloads as user messages.
- [x] 7.5 Add projection and TUI tests for interleaved children, unload/reload, nickname collisions, bounded reports, usage attribution, and non-duplicated terminal rows.

## 8. Cutover And Verification

- [x] 8.1 Remove the old process-local controller ownership path after all gateways and adapters use `AgentSupervisor`, while retaining the documented compatibility adapters.
- [x] 8.2 Update Node architecture, configuration, tool, session-artifact, permissions, recovery, and TUI documentation for the v2 agent model.
- [x] 8.3 Run package-level lint, typecheck, unit, integration, storage migration, runtime, and TUI suites and fix all regressions.
- [x] 8.4 Run a real-provider smoke test covering spawn, read/tool work, parent messaging, follow-up, waiting, completion, interruption, list, and session reload without exposing credentials.
- [x] 8.5 Verify the retained Python runtime and existing Node non-subagent workflows remain behaviorally unchanged.
- [x] 8.6 Remove the provider-visible `Task` compatibility tool and update tool-scope, exports, documentation, and regression tests so `spawn_agent` is the only child-spawn entry point.
- [x] 8.7 Keep child approval and clarification requests non-terminal, route them by child session through the gateway/TUI, and resume the same resident runtime after a response.
- [x] 8.8 Add supervisor, gateway, TUI, and integration regressions for waiting child status, non-terminal persistence, response routing, and terminal completion after continuation.
