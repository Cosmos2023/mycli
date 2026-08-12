## Why

The Node runtime currently executes the root agent and every subagent as asynchronous Promises on one backend Worker event loop. A blocked or CPU-heavy agent can therefore delay unrelated agents, and a non-cooperative interrupt may require restarting the entire backend instead of terminating only the affected turn.

## What Changes

- Introduce a coordinator-owned elastic pool of reusable `worker_threads.Worker` execution hosts, with one active agent turn per Worker lease.
- Keep SQLite, append-only model-input commits, session state, approvals, tools, external processes, mailboxes, and gateway publication exclusively in the coordinator.
- Split the current combined turn runtime into a transport-neutral agent loop and a coordinator broker, retaining an in-process adapter during migration and rollback.
- Add a versioned Worker protocol fenced by coordinator epoch, Worker generation, lease, job, session, turn, timeline window/version, and per-job sequence.
- Require model-visible input to be durably committed and hash-acknowledged before an Agent Worker may dispatch the corresponding provider request.
- Use bootstrap-plus-delta context delivery so stable conversation prefixes are not repeatedly cloned across Worker boundaries.
- Add cooperative cancellation followed by targeted Worker termination and replacement, while retaining whole-backend restart only as a final coordinator watchdog.
- Add elastic pool growth, idle retirement, Worker recycling, bounded caches, V8 resource limits, output bounding, and process-wide memory-pressure scheduling.
- Migrate subagents first, then the root agent, without changing the public TUI/gateway behavior, launch command, Python implementation, or durable agent semantics.

## Capabilities

### New Capabilities

- `node-agent-worker-pool`: Elastic single-job Worker leasing, priority scheduling, targeted interruption, replacement, crash handling, and staged root/subagent migration.
- `agent-worker-coordination-protocol`: Coordinator ownership, provider/tool brokering, append-only commit ordering, compound fencing tokens, OCC/ABA protection, idempotency, and late-message rejection.
- `agent-worker-memory-governance`: Bootstrap-plus-delta context delivery, bounded Worker caches and outputs, elastic retirement, resource limits, recycling, and global memory-pressure behavior.

### Modified Capabilities

None. The published base specs do not yet define Node Agent Worker execution behavior.

## Impact

- Affects `backend/packages/runtime` turn execution and agent supervision, `backend/apps/mycli` runtime composition and backend supervision, storage-backed model-input coordination, provider dispatch, tool and approval brokers, and related integration tests.
- Introduces an internal versioned Worker protocol and pool implementation using Node 24 built-ins; no generic Worker Pool dependency or external service is required.
- Preserves the existing gateway/TUI contract, session and subagent persistence, tool surface, approvals, steering, follow-ups, mailbox behavior, and compiled `npm run mycli` entry.
- Requires deterministic protocol, race, crash, interruption, memory, PTY, provider, and append-only persistence tests before production rollout.
- Does not remove or modify Python mycli.
