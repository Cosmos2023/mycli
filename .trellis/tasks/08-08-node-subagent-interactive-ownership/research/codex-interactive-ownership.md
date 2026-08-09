# Codex Interactive Ownership Research

## Sources Inspected

- `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/bottom_pane/approval_overlay.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/app/thread_routing.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/app/pending_interactive_replay.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/core/src/session/mod.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/core/src/tools/handlers/multi_agents_common.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/core/src/codex_delegate.rs`

## Findings

Codex preserves approval ownership using thread-scoped identity. Each request carries a thread id
and request id, and core stores the matching continuation by call/approval id. The shared TUI may
queue or surface requests, but a response is submitted to the owning thread rather than whichever
turn happens to be active.

Inactive threads retain pending interactive state independently. The TUI can display an
`Approval needed in <agent>` indicator and clear it from exact response or terminal-thread events.
This separates three responsibilities:

1. Core thread owns the pending continuation.
2. TUI arbitrates which request is visible.
3. The response route carries the original thread/request identity.

Codex also copies live approval and permission state into spawned-agent configuration. Full Access
therefore remains Full Access for the child instead of silently reverting to workspace mode.

The delegated one-shot path sometimes forwards approval through the parent session, but the parent
is only a transport/reviewer boundary; the main model does not become the owner of the child's tool
continuation.

## Mapping To mycli

mycli already has most ownership primitives: child session id, agent path, broker generation, and
same-runtime continuation. The mismatch is that both `AgentInteractiveRequestBroker` and
`InProcessNodeGateway` currently serialize presentation. The broker should publish all independent
request lifecycles and expose its pending snapshot; the gateway should remain the only shared-TUI
presentation arbiter.

Cancellation must originate from the broker because it owns the continuation. Inferring queue
removal from `subagent.updated` couples UI ordering to a later projection and can leave stale state
when event order changes.

## Recommended Increment

- Convert the broker into an insertion-ordered per-session registry.
- Publish request, response, and internal cancellation lifecycles.
- Replay all pending requests to new subscribers.
- Let the gateway maintain the sole root/child presentation queue.
- Keep TUI single-selector behavior and durable `/tasks` waiting projection.
- Add a real Full Access child Shell integration regression.

This increment establishes the ownership boundary needed for later agent-thread navigation without
expanding the current task into a full TUI session-switching redesign.
