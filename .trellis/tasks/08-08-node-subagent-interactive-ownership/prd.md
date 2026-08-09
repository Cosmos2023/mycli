# Codex-style Subagent Interactive Ownership

## Goal

Make Node mycli preserve approval and clarification ownership per subagent session while keeping
the shared TUI responsible only for presentation arbitration. Remove the duplicate broker/gateway
queueing that caused requests to overwrite or strand each other, and prove that child runtimes
inherit the parent's frozen Full Access policy without routine approval prompts.

## Requirements

- The agent interactive broker owns a per-child-session pending-request registry, not a UI
  presentation queue.
- Every newly registered child request is published with its child session, generation, turn, and
  decision/request identity. The gateway is the only component that orders requests for the TUI.
- Broker subscription replays all currently pending child requests in stable registration order so
  gateway/TUI reconnection cannot lose hidden requests.
- Approval and clarification responses resolve only the matching child session, generation, and
  decision/request id, then resume that same resident runtime.
- Child interruption, failure, or completion while waiting publishes an explicit internal
  cancellation lifecycle so the gateway removes the exact request without depending on
  `subagent.updated` as queue state.
- Gateway session resume checks broker-owned pending state in addition to root continuations.
- The TUI remains a single shared selector, labels child-owned requests, and restores controls when
  response RPC submission fails.
- Child runtimes continue to freeze the parent's execution-policy snapshot at spawn. Full Access
  children execute ordinary permitted Shell calls without `approval.request`.

## Acceptance Criteria

- [x] Two children registering interactions synchronously both reach the gateway; only the gateway
      presentation head reaches the TUI until it is resolved or cancelled.
- [x] Broker tests prove ordered replay, exact response routing, stale-generation rejection, and
      explicit cancellation on abort.
- [x] Gateway tests prove root/child arbitration, exact cancellation advancement, and session-resume
      blocking based on broker state rather than incidental UI queue state.
- [x] A real Node backend integration proves a Full Access parent spawns a child that runs Shell and
      completes with zero approval events.
- [x] Existing workspace-mode child approval continuation remains non-terminal and resumes the same
      child runtime.
- [x] App/TUI type checks, contracts check, lint, full tests, and `git diff --check` pass.

## Definition of Done

- Focused broker, gateway, backend integration, and TUI regressions pass.
- Cross-layer runtime/TUI specification documents the single presentation arbiter and lifecycle.
- No retained Python runtime is removed or changed.
- No unrelated dirty-worktree changes are reverted or committed.

## Technical Approach

Use the existing `AgentInteractiveRequestBroker` as the ownership registry. Replace its
`queue`/`announcedSessionId` presentation state with insertion-ordered `pendingBySession` state and
publish every request. Add a broker snapshot and an internal cancellation notification. The gateway
subscribes to those lifecycle notifications, maintains the sole FIFO presentation queue shared with
root continuations, and routes responses through the broker before root handling. Keep the current
TUI selector and child identity fields; `/tasks` continues to show durable `waiting` agent state.

## Decision (ADR-lite)

**Context**: Both the broker and gateway serialized child requests, while the TUI had one selector.
That duplicated ownership and made cleanup depend on unrelated terminal projections.

**Decision**: Separate request ownership from presentation. The broker owns independent child
requests; the gateway owns shared TUI ordering; the TUI owns only interaction state.

**Consequences**: The current UI stays simple and safe, reconnect replay becomes deterministic, and
future `/agent` navigation can consume the same request registry. Full Codex-style per-thread
transcript switching remains a later feature.

## Out of Scope

- A new `/agent` command or per-agent transcript navigation.
- Multiple simultaneous approval modals in one terminal.
- Persisting live approval continuation handles across process restart.
- Changes to the retained Python implementation.

## Research References

- [`research/codex-interactive-ownership.md`](research/codex-interactive-ownership.md) - local Codex
  source comparison and mapping to mycli.

## Technical Notes

- Relevant code: `backend/apps/mycli/src/node-runtime/agent-interactive-requests.ts`,
  `backend/apps/mycli/src/node-runtime/node-gateway.ts`,
  `backend/apps/mycli/src/node-runtime/node-backend.ts`, and TUI runtime-state/selector modules.
- Relevant spec: `.trellis/spec/backend/runtime-tui-gateway-contract.md`, scenario
  `Node Subagent Interactive Continuation`.
- The worktree contains extensive pre-existing migration changes; edits must remain path-scoped.
