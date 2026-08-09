# Node Agent Runtime

The Node runtime models every root and child agent as an independently durable thread. Display
names are metadata; the immutable thread id and canonical path are the routing and correlation
identities.

## Architecture

`AgentSupervisor` is the only lifecycle mutation boundary. It owns spawn, load, start, wait, idle,
unload, follow-up, interruption, terminal finalization, and runtime release. `AgentScheduler`
reserves resident capacity, `AgentRuntimePool` holds loaded runtime handles, and `AgentMailbox`
persists inter-agent communication in the receiver's session input queue.

```text
coordination tool
  -> prompt-driven coordination adapter
  -> AgentSupervisor or AgentMailbox
  -> SQLite durable transition
  -> canonical agent event
  -> parent mailbox, artifacts, gateway, usage, and TUI projections
```

Coordination adapters do not own child handles or publish lifecycle updates. Projections consume
the canonical event stream after the owning store transition. SQLite remains authoritative when a
readable projection is missing or stale.

Each agent has:

- an immutable `thread_id`;
- a `root_thread_id` and optional `parent_thread_id`;
- a canonical path such as `/root/reviewer`;
- an independent conversation, provider continuation state, cancellation boundary, queue, and
  runtime generation lease;
- a frozen spawn configuration and durable lifecycle status.

Sibling path collisions are resolved with a unique suffix. Callers must route by returned thread id
or canonical path instead of reconstructing a path from a nickname.

## Prompt-Driven Spawn Configuration

The parent assigns work directly through `task_name`, `message`, and optional `fork_turns`.
There is no agent-profile discovery, profile directory, profile-selected model, profile prompt, or
profile budget. Children inherit the parent's resolved provider/model, execution policy, and
currently exposed tools. `spawn_agent` is the only child-spawn entry point exposed to providers.

The current backend allows four resident agents in total, including the root, and defaults to one
child level. Idle least-recently-used children may unload to free a resident slot; their durable
identity and history remain available. Omitted runtime budgets remain unlimited.

Spawn freezes the effective workspace, cwd, selected environment, execution policy, provider and
model, product instruction content, tool scope, budgets, and context fork mode. A child creates its
own immutable session instruction snapshot from that inherited product content and then uses the
same layered model-input ledger, budgeting, reconstruction, and provider projection pipeline as the
parent. The runtime appends one developer `subagent_context` section containing the canonical agent
path, assigned task, effective tool scope, frozen permission/sandbox/filesystem/network policy, and
reporting contract. The parent's message remains the user task. There is no child-specific base
prompt or agent-profile prompt branch.

Legacy SQLite `profile_id` columns remain readable for existing sessions. New Node children write
the fixed compatibility value `subagent`; that value is display/storage metadata and never affects
routing, prompts, models, tools, permissions, or budgets.

`fork_turns` accepts `none`, `all`, or a positive integer string and defaults to `none`. A fork
copies only committed, shareable conversation turns. Pending input, internal notifications, tool
transport records, and provider continuation ids are not copied.

## Coordination Tools

New provider requests prefer these tools:

| Tool | Behavior |
| --- | --- |
| `spawn_agent` | Creates a durable child and returns its thread id, task name, and canonical path. |
| `send_message` | Queues an ordered durable message without starting another turn. |
| `followup_task` | Queues a message and loads/starts an eligible idle or unloaded receiver. |
| `wait_agent` | Waits for mailbox, lifecycle, user-steering, cancellation, or timeout activity without polling. |
| `interrupt_agent` | Aborts the active provider/tool/wait work and durably interrupts the target. |
| `list_agents` | Reads the durable root tree, including unloaded and terminal descendants. |

Targets may be immutable thread ids, canonical paths, or unambiguous permitted aliases. Routing is
restricted to the caller's root tree.

`Task`, legacy `SendMessage`, and `SubagentOutput` routes are not registered or exported; use
`spawn_agent`, `send_message`, automatic terminal delivery, and `wait_agent` instead.

Terminal completion is delivered automatically and idempotently to the parent mailbox. The bounded
notification contains status, report preview, and an output reference when available. Provider-only
mailbox records are not rendered as fabricated user messages.

## Permissions And Isolation

A child can narrow authority but cannot widen it. Effective authority is the intersection of the
parent's frozen authority, platform policy, and explicit spawn restrictions.

- A trusted `full-access` parent produces a non-prompting full-access child unless the spawn
  explicitly narrows it.
- A workspace or read-only parent cannot create a child with broader filesystem, network, shell,
  approval, or tool access.
- Reload uses the frozen spawn snapshot, not current ambient process defaults.
- Child tools still pass through normal schema validation, policy, sandbox, approval, hook, and
  execution boundaries.

An approval or clarification request does not terminalize the child. Its thread enters `waiting`
while its durable task remains `running`; the request carries the child session id and runtime
generation to the TUI. The response is routed back to that child and resumes the same resident
runtime before the thread returns to `running`.

## Durable State And Readable Artifacts

Canonical state lives in `~/.mycli/sessions.db`, including agent threads, spawn edges, tasks,
mailbox items, queues, runtime leases, checkpoints, conversation history, and usage source data.

Each child also owns a readable session directory:

```text
~/.mycli/sessions/<child-thread-id>/
  session.json
  events.jsonl
  tasks/<task-id>/output.txt
  subagents/
```

The parent session contains its own task output and subagent index/snapshot projection for the
child. Canonical event rows include `agent.lifecycle`, `agent.progress`, `agent.usage`, and
`agent.communication`. Communication rows contain bounded routing metadata, not message payload
text. Artifact writes are serialized and drained before SQLite closes; projection failure does not
roll back already committed canonical state.

Do not restore provider history from `session.json`, `events.jsonl`, task output, or subagent JSON.
Writable session preparation rebuilds derivable projections from SQLite.

## Recovery

Idle and unloaded children are rehydrated on demand from durable history and their frozen spawn
configuration. Startup reconciliation uses runtime generation leases and committed checkpoints:

- committed idle work remains reloadable;
- queued mail remains ordered and durable;
- missing terminal completion delivery is repaired with deterministic deduplication;
- stale provider work or an uncommitted mutating tool becomes recoverably interrupted;
- an uncommitted side effect is never replayed automatically;
- an explicit `followup_task` may resume an eligible recoverably interrupted child.

Terminal agents do not restart because a queue-only message arrived. Closing a runtime releases
resident resources without deleting durable thread history.

## Events And TUI

The canonical stream covers reservation, spawn, load, start, wait, communication, progress, usage,
interruption, unload, completion, and failure. The Node backend derives parent delivery, readable
artifacts, `subagent.updated`, and TUI state from this stream.

The TUI correlates rows by immutable thread id and renders canonical paths as an agent tree, so
duplicate nicknames remain distinct. All model-visible coordination tool calls and results stay in
the transcript. Progress and terminal projections update existing rows instead of duplicating them,
and provider-only mailbox payloads remain hidden from user-authored transcript history.

Use `/tasks agents` or `/agents runs` for the agent view. Use `/usage` for session usage; child usage remains
attributed to the child thread and is projected through canonical usage events.

## Operational Checks

Use provider-free diagnostics before a live run:

```bash
mycli doctor --json
```

For development, run storage, runtime, integrations, backend integration, TUI, contract drift,
lint, and typecheck gates before a credential-gated provider smoke. Never place provider credentials
in artifacts, logs, smoke output, or test fixtures.

The `model_input_ledger` doctor row validates content hashes, immutable snapshot, manifest and
provider-input timeline references, window indexes and triggers, boundary chains, and provider-step
lifecycle ordering through a read-only connection. A failure should be treated as a
provider-dispatch blocker for the affected session; doctor does not repair or rewrite the ledger.

After configuring a provider through the normal environment or auth store, run the complete live
coordination smoke with:

```bash
npm run smoke:agents
```

The command uses a disposable home and workspace, exercises child `Read`, messaging, follow-up,
waiting, completion, interruption, durable listing, and backend/session reload, then prints one
sanitized JSON summary. It exits with code `77` and `status=unavailable` when credentials are not
configured.
