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

## Execution Adapter Rollout

	Agent-loop execution has one internal pre-turn adapter selection boundary. The compatibility gate
	is `MYCLI_AGENT_EXECUTION_ADAPTER`; `MYCLI_ROOT_AGENT_EXECUTION_ADAPTER` and
	`MYCLI_SUBAGENT_EXECUTION_ADAPTER` independently override it for staged rollout. All three accept
	only `in_process` or `worker`, and the effective default is `worker`. When either lane uses
	`worker`, the enabled lane uses the same coordinator-owned pool while the other lane remains
in-process. The gates do not change durable agent identity: sessions, turns, queues,
mailboxes, approvals, tools, artifacts, and gateway publication remain coordinator-owned in both
modes.

Adapter selection follows these invariants:

- Resolve and freeze the adapter before reserving a Worker lease or dispatching a provider or tool
  attempt.
- Use one adapter for the complete durable turn. A root approval or clarification may release its
  current lease while waiting and acquire another Worker lease for the same durable turn identity
  when the user responds.
- Never switch to the in-process adapter after Worker initialization or an external attempt begins.
- Return a typed startup or capacity failure when Worker-backed execution cannot start safely.
- Compare canonical provider manifests, transcripts, lifecycle rows, usage, mailbox delivery, and
  terminal publication ordering before changing a rollout default.
- Resolve lane overrides once during backend startup. A missing or blank lane override inherits the
  compatibility gate; an invalid value fails startup instead of silently selecting another adapter.

Rollback sets `MYCLI_AGENT_EXECUTION_ADAPTER=in_process`, drains existing Worker leases, and selects
the in-process adapter only for subsequent turns. It does
not delete or rewrite durable Worker-era metadata. The in-process adapter remains supported until
root and child Worker execution have passed parity, interruption, recovery, and memory acceptance
gates for the documented compatibility window.

Worker-backed interruption is targeted inside the backend coordinator. Its supervisor cleanup
envelope is 12 seconds and covers cooperative cancellation, effect cleanup, targeted Worker
termination, and replacement. The outer supervised-backend watchdog is 15 seconds, so an ordinary
targeted interruption keeps the coordinator generation; only an unresponsive coordinator that
misses the longer watchdog is terminated and recovered as a whole.

Root and child hard interruption are isolated in both directions. Replacing a root Worker does not
change active child Worker identities, and replacing one child Worker does not change the root or
sibling Worker identities. A sibling may therefore finish and deliver its report after another
child is interrupted, while the root continues the same durable turn.

### Root and subagent Worker acceptance evidence

The Worker default has automated coverage for:

- identical in-process and Worker-backed child provider requests, persisted manifests, usage,
  terminal task state, and parent gateway delivery;
- root provider execution through an `interactive/root` lease with root manifests, canonical tool
  calls/results, queue state, approvals, gateway events, and terminal records owned by the
  coordinator;
- the same two-step root `update_plan` turn under `in_process` and `worker`, comparing canonical
  conversation, provider request shape and manifest topology, lifecycle states, usage, terminal
  report, transcript, and terminal gateway order;
- a default Worker-completed turn followed by a backend restart with the explicit `in_process`
  rollback gate, proving the compatibility adapter can read Worker-era manifests, replay canonical
  continuation, complete the next turn, and avoid duplicate tool effects;
- Worker-backed root session new/resume/fork, provider-free slash commands, steering and queued
  follow-up, real compaction and restart, canonical Responses continuation replay, permission-frozen
  tool exposure, live/durable TUI transcript parity, and background MCP refresh reaching a later
  provider step;
- foreground and background children, approval and clarification continuation, mailbox follow-up,
  `send_message`, `wait_agent`, unload/reload, and targeted interruption;
- a live root turn with two overlapping child Worker provider streams whose contexts, tools, usage,
  and terminal reports remain isolated;
- complete provider RPC fencing by coordinator epoch, Worker generation, lease/job/session/turn,
  timeline window/version, and monotonic command/response sequences, including zero-dispatch stale
  frame tests;
- source-resolved and compiled Worker entrypoints.

The real-provider runner uses the production default without injecting adapter gates when no adapter
option is supplied. It also accepts the legacy `--adapter` option plus independent `--root-adapter`
and `--subagent-adapter` options, and keeps its summary credential-free. On 2026-08-13, the local
DeepSeek `chat_completions` configuration completed both `worker` root plus `in_process` child and
all-`worker` topologies. Each run exercised two spawns, send, follow-up, two waits, targeted
interruption, list, child file reads, completion delivery, mailbox/tree persistence, and session and
backend reload without starting Python. This is real-provider rollout evidence for the Worker
default.

On the same date, an environment-provided OpenAI-compatible Responses endpoint completed the
expanded default-Worker runner with four background spawns, two overlapping children, three waits,
root steering, send/follow-up, targeted interruption, durable listing, child reads, and session and
backend reload. The foreground compatibility path separately completed through
`SubagentController.start(mode="foreground")` using a Worker lease and durable provider manifest.
The M7 and M4 live runners supplied two approval continuations plus MCP/plugin/tool execution and a
persisted file mutation. All summaries excluded credentials, endpoint details, prompts, responses,
and local paths. An unavailable or skipped run is never acceptance evidence.

### Worker memory limits and diagnostics

Each Agent Worker is created with measured V8 defaults: 192 MiB old generation, 16 MiB young
generation, 64 MiB code range, and a 4 MiB stack. The pool validates any internal override before
spawning. These limits bound the isolate heap but do not replace process RSS governance; native
provider libraries and structured-clone buffers may live outside V8 old generation.

The production defaults retain at most four Agent Workers and retire an idle Worker after 30
seconds. Memory-constrained installations may lower both bounds before startup:

```bash
MYCLI_AGENT_WORKER_MAX=2 \
MYCLI_AGENT_WORKER_IDLE_TIMEOUT_MS=5000 \
npm run mycli
```

`MYCLI_AGENT_WORKER_MAX` accepts integers from 2 through 4 and
`MYCLI_AGENT_WORKER_IDLE_TIMEOUT_MS` accepts 1,000 through 600,000 milliseconds. Blank values use
the defaults; invalid nonblank values fail startup without echoing their contents. Two is the
minimum because a Worker-backed root may retain one lease while waiting for a foreground child.
Lower capacity reduces peak isolate residency but queues concurrent root/child work sooner, and a shorter idle
timeout trades more Worker startup latency after quiet periods for faster memory recovery.

Coordinator-to-Worker messages are serialized and byte-checked before `postMessage`. The shared
transport ceiling is 2 MiB; the internal coordination protocol remains capped at 1 MiB per envelope
and 512 KiB per payload. Provider commands and responses are parsed at both the sending and receiving
boundaries. Immutable instruction/tool cache defaults are eight entries and 512 KiB total with
content-hash verification and deterministic LRU eviction.

`AgentWorkerPool.metrics()` samples each isolate through Node's coordinator-side Worker APIs. It
returns only opaque Worker identity/generation, thread id, state, configured resource limits, heap
used/total/limit/external byte counts, current numeric message-listener count, and event-loop
active/idle/utilization numbers. Normal release clears the listener set defensively even when the
provider executor already unsubscribed. Metrics exclude lease/job/session/turn ids, paths,
credentials, prompts, conversation, and tool output, and are never added to transcript or provider
input.

Reusable Workers have four soft recycling defaults: 100 completed jobs, 30 minutes of Worker age,
a 1 MiB largest message during one job, or 32 MiB retained heap growth relative to the post-startup
baseline. The pool evaluates these thresholds only after the Worker acknowledges release and the
coordinator clears the lease. Crossing a threshold never interrupts or reclaims an active lease;
the idle generation is terminated and warm capacity is restored before another job is assigned.
Malformed or oversized protocol traffic is a correctness failure rather than a soft memory signal:
the coordinator fences any active lease and replaces that Worker immediately.

The coordinator samples process RSS once per second and uses 1.5 GiB soft and 2 GiB hard defaults.
Under soft pressure it retires idle Workers, disables warm-capacity creation and crash replacement,
keeps background requests in the bounded queue, and still permits interactive work to reuse or
create capacity. Under hard pressure it also disables all Worker expansion, rejects new or queued
background requests, and rejects an interactive request when there is no idle Worker to reuse. The
typed outcome is `agent_worker_pool_memory_pressure`; `hard_capacity` reports unavailable hard-state
capacity, while `soft_queue_timeout` reports a background request that remained queued for the
30-second default. Both include only pressure state, RSS, and the relevant configured limit in
bytes. Active leases are never interrupted for process pressure, and committed provider context is
never truncated to satisfy either threshold. When RSS falls below the soft limit, the periodic
monitor resumes queued work and restores configured warm capacity.

The redacted `metrics()` pressure block reports state (`normal`, `soft`, or `hard`), RSS and limit
bytes, whether speculative warming is enabled, and numeric idle-retirement/rejection counters. It
contains no session, turn, prompt, provider, tool-output, path, or credential data.

Resumable session state and regenerable session/subagent artifacts use a SQLite tail projection
capped at 2,000 raw history rows, 2,000 rollout rows, and 500 projected transcript items.
Schema-v8-compatible
`(session_id, sequence_no)` indexes support both tail queries and are added once when missing
without changing the version marker. If the raw history boundary cuts through a turn, that
incomplete earliest turn is omitted from the readable projection so a tool result is not shown
without its call.

`transcript.load` does not inherit that 500-item snapshot limit. It filters complete canonical
history and supports an opaque versioned `before` cursor with a maximum requested `limit` of 500, so
turns before repeated compactions remain reachable while internal boundary replacements stay hidden.
A complete turn is never split across pages, so one exceptional tool-heavy turn may exceed the
requested projected-item target. The TUI initially requests one page and fetches an older page only
when the full transcript viewer reaches its current top, preserving the visible rows after prepend.
Legacy writable sessions that contain only `conversation_messages` still use the existing legacy
projection on the first page; canonical history pages never mix with that fallback.
Provider reconstruction is independent: it selects the latest completed replacement plus later
conversation rows. Provider manifests, model-input ledger reconstruction, `promptCacheKey`, and
`previousResponseId` continuation therefore follow the effective compacted window and are not
affected by transcript paging. When memory is enabled, session-summary context reads only the latest
eight indexed summaries before applying the existing 5,000-token aggregate bound.

### Worker memory benchmark

Run `npm run benchmark:agent-workers -- --output agent-worker-memory.jsonl` to measure ten isolated
scenarios: zero, one, and four idle Workers; one and four active Workers; a large history; a large
coordinator-owned tool output with a bounded Worker projection; 120 fixture leases; a 1,000-lease
production-entrypoint Responses soak against a loopback SSE server; and post-idle recovery. The soak
uses forced-GC checkpoints every 25 turns, discards the first eight checkpoints as warmup, validates
zero released-lease listeners, and gates the steady-state coordinator heap, coordinator external,
and Worker heap slopes. RSS remains observational because V8 and the system allocator may retain
released pages. Each scenario runs in a fresh process and emits one schema-versioned JSONL row
containing only platform/runtime metadata, numeric memory/count/timing samples, and scenario
dimensions. The cross-platform workflow uploads separate Linux, macOS, and Windows artifacts under
Node 24.

One local macOS arm64 run on Node 24.14.1 measured RSS deltas of about 9.0 MiB for one idle Worker,
51.7 MiB for four idle Workers, 9.6 MiB for one active Worker, and 50.4 MiB for four active Workers.
The 1.2 MB history scenario measured about 10.2 MiB, while an 8 MiB coordinator tool output with a
480 KiB Worker projection measured about 18.1 MiB. After four 256 KiB active payloads were released
and the idle timeout elapsed, the pool reported zero resident Workers. These values are evidence
from one machine, not portable pass/fail thresholds; compare CI artifacts before tuning defaults.
The complete 29-case Worker-backed backend integration sequence reached about 1.79 GiB process RSS
in the same environment while still completing under the soft-pressure policy. The hard threshold
therefore leaves headroom above this accumulated development/test workload. Tune from
whole-coordinator workloads rather than multiplying the microbenchmark alone.

The local macOS soak completed 1,000 Responses requests across 10 Worker generations in about four
seconds. All 40 release checkpoints reported zero message listeners. After warmup, coordinator heap
grew about 12.8 KiB per 25-turn checkpoint, coordinator external memory was flat, and the Worker
heap regression slope was negative; closing the pool reported zero Workers. This rules out a clear
linear per-turn leak in that bounded workload, but it is not a proof against every long-running
workload or native provider implementation.

A separate source-resolved lifecycle sample compared the configurable capacity with the same
5-second idle timeout. Four simultaneous leases added about 153.1 MiB RSS, while two added about
67.5 MiB, a reduction of about 85.6 MiB for that run. Both pools reported zero Workers after the
idle timeout. macOS retained allocator pages after Worker termination, so immediate RSS recovery
remained partial and Worker count is the deterministic retirement assertion.

### Long-history resume benchmark

Run `npm run benchmark:long-history -- --profile heavy --storage-schema v9` or select `v10` for the
legacy normalization comparison. Use `--profile blob_tool_heavy --storage-schema paired` for the
schema-v10/v11 content-blob gate, or replace the profile with `blob_compact_stress` for the
500-compaction physical-size gate. The `paired` mode runs isolated v10 and v11 fixtures and exits
non-zero when a required storage, semantic, migration-headroom, startup/resume latency, or memory
gate fails. The smaller `blob_smoke` profile exercises the same harness without asserting the two
scale-specific reduction thresholds. The `heavy`, `extreme`, and `compact_stress` profiles build
an isolated SQLite fixture with three completed compaction boundaries for `heavy`/`extreme` or 500
boundaries for `compact_stress`, resume it through the real
backend RPC, load the complete filtered transcript, and submit the first Worker-backed turn against
a loopback Responses SSE server. The latest boundary retains 20 tool-heavy turns. The benchmark
fails if the first turn compacts again, includes history before the latest boundary, omits old visible
transcript turns, exposes boundary replacement payloads, or sends the wrong tool-call/result counts.
Fixture generation and provider request parsing run in separate
processes so their allocator state does not inflate the measured backend baseline. The benchmark
reports database/WAL/freelist dimensions, separate first-page and all-page transcript costs,
provider-dispatch timings, request sizes, process memory, post-idle Worker count, and transcript
row/payload-byte deltas for the measured turn without emitting fixture content. A v10 fixture is
created by running the same v9 source fixture through real bounded staging and cutover, followed by
an explicit fixture-only vacuum. The output records pre/post-vacuum bytes separately so logical
normalization is never presented as physical shrinkage.
The `compact_stress` profile uses 500 completed boundaries with approximately 8,000-character
summaries and enables memory context to exercise sessions that compact hundreds of times. It fails
if the oldest summary reaches provider input, proving the recent-eight summary read remains bounded;
`heavy` and `extreme` retain the three-boundary tool-history profiles for comparison.

The v11 acceptance profiles use deterministic repeated source and log payloads so the benchmark
measures both compression and content-addressed reuse. Output schema 5 records inline envelopes,
unique raw/stored content, logical and deduplicated reference bytes, reference metadata, model-input
rows, database/WAL/SHM/journal bytes, migration timing and measured temporary peak, explicit GC,
explicit vacuum, semantic projection digests, and baseline-relative RSS. Temporary fixture paths and
prompt-cache keys are normalized before paired semantic digests; fixture content is never emitted.

On 2026-08-15, the macOS arm64 Node 24.14.1 `blob_tool_heavy` pair stored 600 turns and 3,600 visible
items. Transcript-plus-ledger payload storage fell from 17,774,277 bytes on v10 to 2,162,355 bytes on
v11, an 88% reduction against the 35% gate. The v11 migration installed 16 unique transcript content
blobs for 1,800 transcript references, representing 13,915,200 deduplicated reference bytes; staging
and cutover took about 1.1 seconds, explicit GC found zero orphans, and explicit vacuum reduced the
v11 file to 7,180,288 bytes versus 21,991,424 bytes for vacuumed v10. Backend ready was 64.1/62.1ms,
`session.resume` was 71.0/69.1ms, complete eight-page transcript loading was 131.8/127.5ms, and the
provider turn was 608.9/667.1ms for v10/v11. Baseline-to-resume RSS was 49.1/21.4MB and both Workers
retired after idle.

The paired `blob_compact_stress` run stored 520 turns, 500 completed boundaries, 1,560 tool calls and
results, and 3,120 visible items. Payload storage fell by 90%, and the explicitly vacuumed v11 file
was 7,946,240 bytes versus 32,411,648 bytes for v10, a 75% physical reduction against the 30% gate.
Backend ready was 62.6/68.3ms, `session.resume` was 85.6/99.1ms, complete seven-page transcript loading
was 140.4/189.7ms, and the provider turn was 786.8/912.6ms. Both runs used only the latest boundary
plus 20 retained turns, produced identical readable/search/provider semantic digests, reconstructed
their durable provider ledger request, stayed inside measured migration headroom and runtime
latency/RSS limits, and retired the idle Worker.

On 2026-08-14, a paired macOS arm64 Node 24.14.1 `heavy` run stored 600 turns and 3,600 visible items.
The v9/v10 database files were 70.8/35.9 MB after the v10 fixture's explicit vacuum. Backend ready
was 58.5/63.8 ms, resume was 57.7/69.2 ms, all eight transcript pages were 82.7/118.7 ms, and the
Worker-backed turn was 734.3/711.7 ms. The measured turn wrote 5 rows and 1,644 transcript payload
bytes on v9 versus 3 rows and 462 bytes on v10, a 71.9% payload-byte reduction. Ready-to-resume RSS
growth was about 48.8/50.9 MB. Peak RSS after loading every transcript page and running the provider
turn was 585.3/708.9 MB, so the higher v10 end-to-end peak remains visible rather than being treated
as a resume-memory improvement.

The paired 500-boundary `compact_stress` run stored 520 turns, 1,560 tool calls/results, and 3,120
visible items. The v9/v10 files were 78.1/43.6 MB. Backend ready was 59.8/53.9 ms, resume was
73.8/78.9 ms, all seven transcript pages were 91.8/123.5 ms, and the Worker-backed turn was
874.2/912.4 ms. Both requests used only the latest summary plus 20 retained turns with 60 calls and
60 results, excluded turn zero and the oldest summary, triggered no extra compaction, and retired
the idle Worker. The same 5-row/1,644-byte versus 3-row/462-byte write delta held. Peak RSS after
explicitly loading all pages and running the turn was 574.9/727.1 MB; `/resume` itself remained
bounded, but the larger v10 post-pagination/provider peak requires continued acceptance tracking.
These local values are evidence, not portable thresholds; compare cross-platform artifacts before
tuning runtime limits.

The 2,000-turn extreme fixture stored 6,000 calls, 6,000 results, 12,000 visible transcript items,
and three boundaries in a 331.9 MiB database. With storage-backed paging, `session.resume` took
105.72 ms, the first 500-item transcript page took 14.35 ms, and explicitly following all 24 pages
took 273.20 ms. RSS was about 389.0 MiB after resume, 397.5 MiB after the first page, and 412.0 MiB
after all 12,000 items, versus about 805 MiB for the prior one-RPC complete materialization. The
first provider request began at 786.98 ms and the turn completed at 816.09 ms with the same fixed
latest-window counts. Sampled RSS later peaked near 796.8 MiB during the Worker-backed provider turn,
not during transcript paging, and the Worker count returned to zero after idle retirement. Explicitly
loaded pages remain in TUI state by design, so memory grows with user-requested history even though
initial `/resume` and the first page stay bounded.

In-progress compaction checkpoints persist only identity, counts, hashes, and an empty replacement
list; the completed atomic boundary still persists the actual compact replacement. This avoids
copying an uncompressed history into a field capped at 4,096 messages and permits tool-heavy
histories above that item count to compact.

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

The selected child environment is an allowlist, not an ambient-process dump. Optional values are
persisted only when non-empty, NUL-free, and at most 32,768 characters; invalid or oversized values
are omitted so host-only terminal metadata such as an empty `COLORTERM` cannot invalidate the
durable spawn snapshot.

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

### Fresh-only schema v12

Production startup creates schema v12 only for a missing or empty database. Existing schema v9,
v10, or v11 markers fail before a writable repository is opened; runtime startup does not scan,
stage, convert, or repair those databases. There is no v11-to-v12 migration path.

Before switching from v11, stop all mycli processes and archive `sessions.db`, `sessions.db-wal`,
and `sessions.db-shm` together. Remove the complete set from the active location and restart mycli to
create v12. Rollback requires restoring that full set with a v11-capable binary. Turns and sessions
are not converted between the two stores.

Schema v12 retains v11 content-addressed transcript leaves, deterministic raw-DEFLATE/identity
codecs, typed hydration, and contentless FTS. Model-input snapshots, context events, timeline events,
and manifests still use verified immutable content rows.

Provider request ownership changes in v12. `provider_request_manifests` keeps
`logical_request_sha256` but has no `logical_request_blob_id`. A constant-size V3 manifest stores the
timeline window, event count, prefix hash, projected timeline hash, provider configuration, and
snapshot identities. Storage selects exactly that window prefix, validates all commitments, calls
the shared core request projector, and compares the reconstructed request with the relational hash
before dispatch or recovery. Later appends and later compaction windows cannot alter an older step.

The normalization and content-blob apply actions return `already_normalized` and
`already_blob_backed` on v12. The maintenance report includes reachable raw/stored bytes, logical
reference bytes, deduplicated bytes, orphan counts/bytes, and `freelist_count * page_size`. Explicit
`--apply-content-blob-gc` deletes only content absent from both transcript and model-input reference
tables and is safe to repeat. GC reports logical raw/stored deletion and reusable pages; it does not
claim a smaller file. Only the separate `--apply-vacuum` command rewrites SQLite and may report
physical shrinkage.

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

For the subagent-first acceptance stage, run:

```bash
npm run smoke:agents -- --root-adapter in_process --subagent-adapter worker
```

The command uses a disposable home and workspace, exercises child `Read`, messaging, follow-up,
waiting, overlapping background children, root steering, completion, interruption, durable listing,
and backend/session reload, then prints one sanitized JSON summary. Run the retained foreground
compatibility path separately with:

```bash
npm run smoke:agents-foreground
```

The public `spawn_agent` tool remains background-only; the foreground runner exercises the internal
`SubagentController.start(mode="foreground")` contract through the same Worker pool and provider
broker. Both commands exit with code `77` and `status=unavailable` when credentials are not
configured. Failed runs include only an allowlisted `failure_stage` such as `provider_dispatch`,
`provider_stream`, `tool_execution`, or `gateway_terminal`; raw errors, prompts, responses, paths,
endpoint details, and credentials are never included.

## Troubleshooting Agent Workers

| Failure category | Observable outcome | Required response |
| --- | --- | --- |
| Pool queue full | `agent_worker_pool_capacity` | Wait for a lease to finish or reduce submitted concurrency; do not create a partial turn. |
| Worker startup/release timeout | `agent_worker_startup_failed` or `worker release failed` | Fence/replace that Worker and reconstruct only from committed coordinator state. |
| Sustained soft RSS | `soft_queue_timeout` after 30 seconds for background work | Let active turns finish, inspect numeric metrics, and retry later; do not trim provider context. |
| Hard RSS without reusable idle capacity | `hard_capacity` | Refuse expansion/new work explicitly while preserving active leases. |
| Malformed, stale, reordered, or oversized frame | Protocol/fence failure and affected-generation replacement | Treat the frame as zero-effect; never relax identity, hash, size, or sequence validation. |
| Worker crash or V8 limit exit | `worker_failed` and targeted recovery | Close ambiguous effects by durable policy and replace only the affected Worker. |
| Targeted interruption cleanup cannot confirm | Interruption fails closed | Use durable recovery for the exact turn; do not publish a synthetic terminal success. |
| Backend coordinator misses the 15-second watchdog | Backend Worker generation changes | Run whole-backend durable recovery; this is distinct from routine Agent Worker replacement. |
| Worker-era manifest fails after rollback | `persistence_error` during reconstruction | Keep the session untouched and inspect immutable timeline-prefix references; never rewrite history to fit the current window. |
| Real-provider runner exits 77 | Sanitized `status=unavailable` summary | Supply credentials through the environment and rerun; do not count the skipped run as rollout evidence. |
| Real-provider runner fails | Allowlisted `failure_stage` in its one-line summary | Diagnose the named boundary from local durable state; never add raw provider or prompt content to the runner output. |

`AgentWorkerPool.metrics()` and benchmark JSONL are operations-only. Do not copy them into prompts,
transcripts, tool results, or session history. Rollback changes the adapter only before a subsequent
turn; it never switches an active lease to in-process execution.
