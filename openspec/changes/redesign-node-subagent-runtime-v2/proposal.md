## Why

The Node subagent implementation can launch and observe child tasks, but active children remain process-local runtime handles with incomplete cancellation, policy inheritance, budget enforcement, and restart recovery. Promoting subagents to durable agent threads is required before mycli can safely support Codex-style multi-agent coordination without polling, hidden permission changes, or lost work.

## What Changes

- Introduce durable agent identities, canonical agent paths, parent-child spawn edges, lifecycle states, and reloadable thread history.
- Replace process-local child ownership with a central agent supervisor responsible for spawn, load, unload, resume, interrupt, completion, and recovery.
- Add Codex-compatible `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `list_agents` contracts.
- Add an ordered, idempotent, durable inter-agent mailbox with explicit queue-only and turn-triggering delivery modes.
- Freeze inherited sandbox, approval, workspace, environment, model, instruction, and tool-scope policy at spawn; child policy may narrow but never widen parent authority.
- Enforce configurable concurrency, nesting depth, turn, tool-call, token, no-progress, and wall-clock limits in runtime control code instead of prompt text.
- Support bounded context forking with `none`, `all`, and last-N-turn modes while keeping each agent's transcript, cancellation, and provider continuation independent.
- Recover durable idle threads after restart and handle interrupted in-flight side effects without blindly replaying uncommitted tool calls.
- Project canonical agent lifecycle and communication events into session artifacts and the TUI.
- Expose `spawn_agent` as the single provider-visible child-spawn tool, remove `Task`, remove agent-profile discovery and selection, and remove the legacy `SendMessage` and `SubagentOutput` routes from new runtime composition.

## Capabilities

### New Capabilities

- `durable-agent-threads`: Durable agent identity, parent-child topology, lifecycle supervision, context forking, unloading, reloading, and restart recovery.
- `inter-agent-coordination`: Codex-style agent tools, ordered mailbox delivery, automatic completion notification, event-driven waiting, and target routing.
- `subagent-execution-governance`: Authority inheritance, instruction layering, tool scope, sandbox and environment propagation, capacity reservation, nesting, budgets, and cancellation.
- `subagent-observability`: Canonical lifecycle events, per-agent artifacts, list/status projection, usage reporting, and TUI rendering.

### Modified Capabilities

None. The repository does not currently contain published base capability specs for the existing Node subagent behavior.

## Impact

- Affects Node runtime composition under `backend/apps/mycli`, agent/runtime contracts in `backend/packages/core`, subagent integrations and tool adapters, session and task persistence, provider context assembly, and TUI projections.
- Adds storage records or equivalent durable repositories for agent threads, spawn edges, mailbox items, and runtime leases/checkpoints.
- Changes the model-visible subagent tool surface to prompt-driven coordination while preserving legacy SQLite `profile_id` columns as non-routing metadata for old sessions.
- Requires migration and recovery tests, policy-inheritance tests, mailbox race tests, lifecycle integration tests, and transcript/TUI projection tests.
- Does not remove or modify the retained Python runtime and does not require distributed workers or a new external service.
