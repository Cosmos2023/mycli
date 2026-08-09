## Why

The Node runtime currently exposes status polling for background subagents but does not deliver completion into the parent agent's provider context. This leads models to repeatedly call `SubagentOutput` and misuse persistent shell sessions as timers, wasting turns and obscuring the actual coordination lifecycle.

## What Changes

- Add a model-visible `wait_agent` tool that waits for parent-agent activity with a bounded timeout.
- Deliver terminal subagent outcomes exactly once through a durable parent-agent mailbox before the next provider step.
- Wake `wait_agent` when a subagent notification or user steering message becomes available.
- Keep `SubagentOutput` as a hidden compatibility route for explicit status inspection rather than routine synchronization.
- Restrict `WriteStdin` to persistent shell transport and prevent it from serving as a subagent waiting mechanism.
- Project subagent task, wait, message, and terminal-result lifecycle events into the transcript without rendering internal notifications as user messages.

## Capabilities

### New Capabilities

- `subagent-coordination`: Event-driven subagent completion delivery, bounded waiting, compatibility inspection, and transcript lifecycle behavior.

### Modified Capabilities

None.

## Impact

- Affects the Node runtime queue, turn execution, subagent controller integrations, tool exposure policy, session persistence, and TUI transcript projection.
- Adds a public model tool contract for `wait_agent`; existing `Task` and `SendMessage` behavior remains compatible.
- Requires focused unit and integration tests for notification durability, exactly-once delivery, wake conditions, restart behavior, and tool visibility.
- Adds no new runtime dependency and does not alter the retained Python implementation.
