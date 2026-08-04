# Node Runtime M5 State And Recovery Design

## Status

Approved in conversation on 2026-08-04. The user selected the roadmap-defined runtime-state
milestone, transactional checkpoints with fail-closed recovery, and the memory scope that does not
depend on the later subagent runtime.

## Goal

Allow the Node backend to own durable sessions across turns, process restarts, session switches,
steering, approval suspension, context compaction, and memory injection without starting Python.
M5 must preserve the current Python-visible SQLite and gateway behavior while treating ambiguous
side effects as explicit interruptions rather than replaying them.

M5 builds on the existing Node turn reservation, canonical conversation/tool persistence,
duplicate `client_turn_id` protection, and orphaned-running-turn interruption. It extends those
primitives instead of introducing a second state store or replacing the schema.

## Scope

M5 includes:

- complete Node session catalog, bootstrap, resume, tree, canonical replay, and bounded transcript
  snapshot behavior;
- atomic active-session transitions that replace transcript, queue, approval, and runtime state as
  one gateway-visible generation;
- durable session-scoped steering, rejected-steer, and follow-up queues with idempotent submission;
- one-time file-mutation approval, rejection, suspended-turn persistence, and restart recovery;
- Responses continuation validation and Chat canonical replay after resume or compaction;
- context token accounting, trigger policy, bounded tool-result projection, L4 summarization,
  context-only replacement, and post-compaction file rehydration;
- Python-compatible session summaries and workspace-scoped Markdown memory discovery, selection,
  injection, explicit remember, and explicit forget;
- stable error kinds, fault-injection coverage, Python/Node four-way persistence fixtures, and
  end-to-end Node recovery tests.

M5 is developed in dependency-ordered internal slices, but it is accepted and rolled out only as
one complete milestone.

## Non-Goals

M5 does not implement:

- external writable roots, unrestricted filesystem mode, or approval of workspace escapes;
- remembered approval rules, command allowlists, or execpolicy writes;
- shell, PTY, process sandboxing, MCP, plugins, hooks, skills, or subagents;
- subagent-backed automatic memory extraction or dream consolidation;
- invoked-skill body rehydration before the skill runtime exists;
- database repair, destructive migration, or bulk snapshot conversion commands;
- deletion of raw history during compaction;
- automatic replay of a provider request, approval, or tool effect after an ambiguous crash;
- promotion of Node to the default backend;
- silent fallback to Python after a Node-owned turn starts.

## Considered Approaches

### Selected: extend the established package layers

Add versioned state contracts to `packages/contracts`, pure state machines to `packages/core`,
atomic persistence operations to `packages/storage`, orchestration to `packages/runtime`, approval
policy integration to `packages/tools`, and RPC/event projection to `apps/mycli`.

This keeps SQLite and the existing gateway protocol as compatibility boundaries. It also allows
queue, approval, and compaction behavior to be tested without provider or TUI dependencies.

### Rejected: one runtime state manager

A single state manager would make the first implementation appear direct, but it would combine
session IO, provider continuation, queue transitions, approval policy, compaction, memory files,
and gateway projection. Its transactions and failure semantics would be difficult to isolate or
review.

### Rejected: finish all permission and subagent work first

Moving external roots, shell policy, automatic memory agents, and general subagents into M5 would
erase the milestone boundary and delay the recovery foundation needed by those capabilities. M5
instead exposes narrow interfaces that M6 and M7 can extend.

## Architecture

```text
apps/mycli NodeGateway
  -> packages/runtime
       -> SessionCoordinator
       -> QueueCoordinator
       -> ApprovalContinuationCoordinator
       -> CompactionCoordinator
       -> MemoryContextService
       -> NodeTurnRuntime
  -> packages/storage
       -> SQLiteSessionStore
       -> TranscriptSnapshotStore
  -> packages/tools
       -> ApprovalPolicy
       -> existing Read/Edit/Patch/Write router
  -> packages/providers
       -> existing Responses and Chat adapters

packages/runtime and packages/tools
  -> packages/core pure models and state transitions

all process and persistence boundaries
  -> packages/contracts validators
```

No new catch-all state package is added. `packages/core` remains free of SQLite, filesystems,
provider SDKs, the gateway, and TUI types. `packages/runtime` does not parse SQLite rows or mutate
memory files directly.

## Contract And Compatibility Policy

### Existing tables remain authoritative

M5 retains schema version 2 and uses the existing tables:

- `sessions`;
- `conversation_messages` and its FTS projection;
- `conversation_trees`;
- `history_items` and its FTS projection;
- `turn_rollouts`;
- `session_state`;
- `session_summaries`;
- `runtime_turns`.

No required column is removed or retyped. A new table or column is allowed only if both runtimes
can safely ignore it and the four-way fixture proves compatibility. JSON state changes prefer
optional fields or a separately versioned state key.

### Python state keys are preserved

Node reads and writes the active Python-compatible keys where the capability already has a durable
shape:

- `input_queue`;
- `pending_decision`;
- `suspended_turn`;
- `turn_record`;
- `compact_checkpoint`;
- `context_baseline`;
- `responses_continuation_state`;
- `provider_timeline`.

Node validators accept compatible unknown optional fields but reject a wrong root type, missing
identity field, invalid enum, cross-session identity, or unsupported required version. Parse
failures never silently become empty state.

### Runtime error compatibility

Terminal turn records continue using the existing `RuntimeErrorCode` enum. Detailed M5 failures
use bounded `error_kind` diagnostics. For example, an ambiguous claimed mutation stores turn code
`interrupted` with `error_kind=effect_outcome_unknown`; it does not add a Node-only terminal status
that Python cannot parse.

## Session APIs And Replay

### Session catalog

`packages/storage` adds typed methods for session listing, metadata lookup, lineage lookup, state
load/save/delete, summary append/load, canonical history loading, and bounded transcript
projection. Catalog ordering, pagination, workspace filtering, title/first-message projection, and
message/summary counts match Python.

Unknown sessions return the existing gateway error rather than creating an empty session during
`session.resume`. A new session is created only by an explicit new turn or session-create path.
Cross-session resume while a regular turn or approval resolution is executing returns
`turn_in_progress`. Same-session resume is idempotent when idle or waiting for approval.

### Canonical and display data stay separate

SQLite conversation and history rows remain the source for future model requests. Readable
`session.json` schema v2 remains a bounded TUI transcript snapshot and never becomes provider
context.

Stable save order is:

1. commit canonical SQLite changes;
2. project a bounded typed transcript;
3. write a sibling temporary snapshot;
4. flush and atomically rename it over `session.json`.

A failed snapshot write does not roll back a committed turn. A missing or malformed snapshot is
rebuilt from SQLite. If SQLite is unavailable but a snapshot is readable, the gateway may expose
read-only history with an explicit degraded-state error; it cannot resume a model turn from the
snapshot.

Schema-v1 snapshots are migrated lazily. Node first uses existing SQLite canonical data; only when
canonical data is absent may it import valid legacy messages, commit them, and atomically replace
the snapshot. A failed import preserves the original file.

### Replay normalization

Node ports the complete-history normalization used by Python before pagination. In particular,
legacy approval continuation turns omit only an unqueued synthetic user item whose turn rollout
contains an approval resolution. Identical independent user messages and queued messages remain.

Tool calls, results, file changes, and reasoning summaries use stable transcript item IDs and
bounded display projections. Provider metadata, raw reasoning, secrets, unbounded tool output, and
stream deltas do not enter the snapshot.

### Atomic session transition

`session.resume` performs a prepare/commit transition:

1. load and validate target metadata, replay, queue, approval continuation, compaction state, and
   usable provider continuation;
2. normalize stale queue and approval records without emitting target-session events;
3. create a new monotonic session generation;
4. swap the gateway's active session coordinator;
5. emit one `session.changed`, followed by the target generation's complete queue and pending
   approval projections.

Failure before step 4 leaves the source session active. Events carry or are internally guarded by
the session generation so a late event from the previous session cannot modify the new TUI state.
The gateway does not perform the swap while another generation owns an executing turn.

## Queue And Steering

### State model

The Node queue coordinator ports the current Python `QueueSnapshot` behavior. Each record contains
a stable `queue_id`, session ID, client idempotency key, optional target turn ID, class, delivery
state, bounded text, ordered local-image references, source, and timestamps.

The three active classes are:

1. pending steers accepted for a known active turn;
2. rejected steers deferred to the end of that turn;
3. ordinary follow-up inputs.

Every state change increments a monotonic revision and is persisted before an event is emitted.
Repeating `(session_id, client_turn_id)` with identical content returns the existing record;
different content is `queue_conflict`.

### Safe-boundary commit

An in-flight provider request is never mutated. At the next provider boundary, storage commits the
accepted steer as canonical user history with its `queue_id` and removes the matching pending
record in one SQLite transaction. Only after commit does the runtime emit the new queue revision
and construct the provider request.

On restart, a queue ID already present in history is treated as committed. A pending steer aimed
at a non-active historical turn becomes a rejected steer. Terminal turn scheduling selects one
oldest rejected steer before ordinary follow-ups and removes it only after the next turn
reservation succeeds.

Manual interruption and approval suspension retain queue state. Session switching swaps queue
coordinators atomically and never merges queues.

### Bounds

M5 preserves the current queue defaults: 128 active records per session, 64 KiB UTF-8 text per
record, 512 KiB aggregate active text, and 16 image references per record. Image execution remains
outside the Node M5 toolset; compatible references are preserved for later-capability replay but
are not sent to a provider unless the active provider path supports them.

## Approval Continuation

### Policy boundary

`Read` remains low risk and auto-allowed. `Edit`, `Patch`, and `Write` remain medium risk with
`auto_allow_or_request` manifests. The production default stays equivalent to
`auto_approve_medium=true`: valid workspace-local mutations run without a prompt, and workspace
escapes fail closed.

M5 adds an injectable strict-medium policy that can require a one-time choice for a workspace-local
mutation. It is used by the Node approval contract and deterministic integration tests without
opening an external root or weakening path policy. M5 advertises only approve-once and reject;
remembered rules are not offered.

### Suspension

Provider tool calls are durably appended before policy evaluation. When a call requires approval,
the runtime writes compatible `pending_decision`, `suspended_turn`, and `turn_record` state before
emitting `approval.request`. The suspended record identifies the session, client turn, server turn,
tool call, provider protocol, ordered remaining calls, bounded preview, and continuation data.

Suspension does not append another user message. Resume retains the original provider batch order
and may reach another approval in the same batch.

### Resolution and effect checkpoint

`approval.respond` validates the decision ID, active session generation, waiting turn, and current
state with compare-and-set semantics. A repeated identical response returns the stored resolution;
a conflicting or stale response fails without changing state.

Reject appends one denied tool result, records the resolution, clears that pending decision, and
continues the original tool batch or provider turn according to Python behavior.

Approve uses this sequence:

1. persist the one-time approval resolution;
2. atomically claim the effect as `executing` with call ID and argument fingerprint;
3. execute the existing mutation adapter once;
4. atomically append the bounded tool result and mark the effect `completed`;
5. clear the pending decision and continue the original batch.

The filesystem and SQLite cannot share a transaction. If the process exits after step 2 without a
durable result, startup never executes the call again. It appends or projects an interrupted
outcome with `error_kind=effect_outcome_unknown`, terminates the turn, and requires a later turn to
read the file before further mutation. This favors no duplicate side effect over speculative
continuation.

## Provider Continuation And Recovery

Responses continuation is used only when the persisted response ID, request signature, protocol,
model, session, history boundary, and eligibility flag all match the reconstructed request.
Compaction, malformed state, a provider that rejects the continuation mechanism, or an ambiguous
effect clears eligibility and records a bounded reason.

Chat Completions never relies on a provider response ID. It rebuilds the request from canonical
conversation items in stable order.

An orphaned running turn with no pending decision is interrupted as in M4. An orphaned waiting
approval turn restores and re-emits its pending choice only when all compatible state validates.
An orphaned `executing` effect is interrupted as unknown and is never restored as pending.

No recovery path automatically sends a provider request. A user-initiated approval response may
continue an unambiguous waiting turn; a later user turn may continue a completed session from its
canonical history.

A suspended turn remains owned by the backend that created it. Backend selection cannot change in
the middle of `approval.respond`; operator rollback is available only after the pending turn is
rejected, completed, or explicitly interrupted.

## Compaction

### Token counting and configuration

M5 adds `js-tiktoken` behind a small runtime interface and uses `o200k_base`, matching Python's
configured encoder. Initialization failure uses the same deterministic fallback:
`ceil(ascii_chars / 4) + non_ascii_chars`.

Node loads the existing compatible compaction settings, including token limit, reserved output
budget, tail turns, tail token budget, trigger ratio/buffer, summarizer model, minimum savings, and
model-specific ratios. Invalid or impossible budgets fail configuration validation before a turn.

### Pipeline

The Node pipeline separates:

- always-on bounded projection of oversized tool results;
- trigger decisions before a turn and after a provider context-overflow signal;
- L4 summary generation through the existing provider abstraction;
- a bounded tail that preserves recent complete turn units;
- context replacement and compact checkpoint persistence;
- bounded file rehydration after replacement.

Compaction changes `conversation_messages`, the provider context projection. It does not delete
`history_items`, `turn_rollouts`, tool metadata, or session snapshots derived from raw history.

The summary request has its own deterministic fingerprint and in-progress checkpoint. A process
exit after sending it does not automatically resend it. The owning turn fails or interrupts
explicitly; a future user-initiated turn may begin a new compaction attempt.

The just-reserved current user message and newly committed steers are a fresh suffix and are never
part of the summary input. If a provider explicitly rejects a request for context overflow before
emitting model output or tool calls, the same live process may perform one bounded compaction and
retry that request. It persists the recovery decision first. No retry is allowed after output,
tool calls, interruption, process loss, or an unclassified provider failure.

After a valid summary is received, one SQLite transaction writes the summary, replacement
conversation, compact checkpoint, and ineligible Responses continuation. Only then does the runtime
emit `compaction.completed`. Failure leaves the previous provider context active.

### Rehydration

M5 restores current bounded contents for recently read or mutated workspace files after L4
compaction. Candidates are ordered with edits before reads and then by recency. Resolution reuses
the M4 real-workspace policy, excludes state and memory paths, skips content already present in the
tail, and applies per-item, total-token, and count limits.

Invoked-skill snapshots may be preserved as unknown compatible state but are not loaded or injected
until M7. Plan state and other future dedicated channels remain independent from conversation
compaction.

Provider request order is:

```text
system and stable instructions
  -> compacted replay summary and tail
  -> compaction file rehydration
  -> bounded memory context
  -> current user input or committed steers
```

Responses and Chat may encode these fragments differently, but fixtures assert equivalent model
visibility and ordering.

## Memory

### File format and isolation

Node uses the existing directory:

```text
~/.mycli/projects/<sanitized-real-workspace>/memory/
```

`MEMORY.md` is a bounded index. Topic files are UTF-8 Markdown with `name`, `description`, and
`type` frontmatter. Supported types remain `user`, `feedback`, `project`, and `reference`.

The memory adapter resolves the real configured home and workspace-derived memory root, rejects
symbolic-link escape, and performs sibling-temporary atomic writes for topic and index updates.
This dedicated trusted adapter does not grant the general file tools access outside the workspace.

Discovery is capped at 200 Markdown topic files. `MEMORY.md` is capped at 200 lines and 25,000
UTF-8 bytes with an explicit truncation notice. Individual selected content and aggregate request
injection obey configured token budgets.

### Selection and injection

When memory is enabled and topic files exist, the runtime considers the bounded index, then asks a
small model-selector request for at most five filenames. It accepts JSON only, ignores unavailable
or duplicate filenames, and never uses model-returned paths directly. Provider failure, invalid
JSON, or an empty selection falls back to the deterministic Python-compatible weighted token
match and recency ordering. Empty memory or an empty query does not issue a selector request.

Session summaries load from `session_summaries` and are deduplicated against file memory by kind,
normalized key, and normalized value. `memory_enabled=false` bypasses selection, injection, and
explicit extraction behavior.

The memory fragment is dynamic request context. It is not copied into canonical user history,
compaction rehydration, or durable session snapshots.

### Explicit remember and forget

After a successful user turn, the Node parser recognizes the same explicit remember/forget forms
as Python. Remember validates the memory kind and bounded fields, writes one uniquely named topic
file, then atomically updates the index. Forget selects exact filename/name matches first and then
bounded relevant matches, removes only files under the real memory root, and updates the index.

Partial memory-file failures are diagnostic and do not rewrite the completed provider turn. The
adapter never logs memory body content. Automatic background extraction and dream consolidation
remain deferred to M7 because they require the subagent runtime.

## Runtime Ordering

A regular Node turn follows this order:

```text
validate submission and reserve turn
  -> load/validate active session state
  -> commit eligible steers to canonical history
  -> evaluate compaction and commit replacement when needed
  -> collect bounded memory and rehydration context
  -> construct canonical provider request
  -> stream provider output
  -> persist tool calls
  -> evaluate approval before each effect
  -> suspend or execute with an effect checkpoint
  -> persist each tool result
  -> continue provider loop
  -> persist terminal assistant output and usage
  -> update bounded transcript snapshot
  -> perform explicit memory request handling
  -> transition remaining steers and drain at most one queued next turn
```

Provider IO, model selection, summary generation, memory file IO, and tool execution occur outside
SQLite transactions. Transactions contain only bounded local database operations.

## Failure And Recovery Matrix

| Boundary | Durable state | Restart behavior |
|---|---|---|
| Before turn reservation | None | No turn exists; a client may submit normally. |
| After reservation, before provider IO | Running turn and user input | Interrupt orphan; never auto-send provider request. |
| Queue persisted, before response/event | Queue record and revision | Duplicate RPC returns the existing record. |
| Steer history and removal transaction | Both or neither | Deliver once; reconcile by `queue_id`. |
| Approval suspension | Waiting decision and suspended turn | Re-emit the same bounded approval request. |
| Approval response, before effect claim | Approved resolution | Resume only from explicit compatible resolution state. |
| Effect claimed, no result | Ambiguous effect | Interrupt with `effect_outcome_unknown`; never execute again. |
| Tool result committed | Canonical result | Continue only from explicit user/approval action; never repeat tool. |
| Summary request in progress | Compaction attempt | Mark interrupted; do not auto-send the summary request. |
| Compaction replacement transaction | Old context or complete new checkpoint | Use one complete context generation. |
| SQLite committed, snapshot write failed | Canonical state | Rebuild the display snapshot later. |
| Memory topic written, index failed | Valid topic without index row | Rescan topics and repair index on the next explicit memory write. |
| Session prepare failed | Source generation remains active | Emit one bounded error and no partial target state. |

## Gateway And TUI Projection

M5 implements the existing catalog methods used by the TUI:

- `session.bootstrap`;
- `session.list`;
- `session.resume`;
- `session.tree`;
- `turn.steer`;
- `turn.queue.pop`;
- `turn.queue.clear`;
- `turn.queue.migration.ack` during compatibility;
- `approval.respond`;
- `turn.interrupt`.

The gateway emits the existing `session.changed`, `turn.queue.updated`, `approval.request`,
`approval.respond`, `compaction.started`, and `compaction.completed` notifications. It does not add
a second Node-only UI model.

Bootstrap and resume payloads contain only bounded projections. Queue legacy arrays remain derived
from the authoritative structured snapshot while the TUI compatibility contract needs them.
Clients ignore older revisions and generations.

## Error Handling

Expected request errors are stable and non-destructive:

- `invalid_params`;
- `turn_in_progress`;
- `turn_id_mismatch`;
- `queue_conflict`;
- `queue_capacity`;
- `approval_not_pending`;
- `approval_conflict`;
- `session_not_found`;
- `session_state_invalid`;
- `session_state_version_unsupported`.

Storage corruption and transaction failures surface as `persistence_error` at the turn boundary
with a bounded detailed `error_kind`. Compaction provider failure uses the existing provider error
classification. Memory selection failures fall back locally; memory mutation failures are bounded
diagnostics after an otherwise completed turn.

Errors never include credentials, raw provider events, memory bodies, full prompts, tool arguments,
escaped paths, transcript payloads, or SQLite row contents.

## Testing

Offline acceptance requires:

1. generated contract fixtures for all M5 state envelopes, gateway events, optional-field
   compatibility, malformed payloads, and stable errors;
2. session-store tests for catalog ordering/filtering, lineage, state CRUD, summaries, replay,
   transcript projection, snapshot migration/rebuild, and transaction rollback;
3. queue state-machine tests for every transition, FIFO priority, capacity, revision ordering,
   idempotency, conflict, restart normalization, and session isolation;
4. approval tests for auto-allow, strict-medium suspension, approve once, reject, multiple calls in
   one provider batch, stale decisions, repeated responses, restart restore, and ambiguous effect
   interruption;
5. continuation tests for valid and invalid Responses state, compacted history, model/protocol
   mismatch, provider rejection, and canonical Chat reconstruction;
6. token-counter fixtures against Python for ASCII, CJK, mixed text, code, and tool output;
7. compaction tests for thresholds, output reserve, summary failure, tail selection, atomic
   replacement, raw-history retention, file rehydration bounds, ordering, and event lifecycle;
8. memory tests for workspace-key parity, frontmatter, bounds, selection, fallback, deduplication,
   explicit remember/forget, symlink escape, atomic index updates, and disabled mode;
9. fault injection before and after every queue, approval, effect, compaction, snapshot, and session
   transition checkpoint;
10. a four-way persistence matrix for Python-write/Python-read, Python-write/Node-read,
    Node-write/Python-read, and Node-write/Node-read across session, replay, queue, approval,
    summaries, compact checkpoints, and continuation state;
11. gateway/TUI tests for atomic resume, stale-generation suppression, transcript normalization,
    queue revisions, approval restore, compaction events, and bounded projections;
12. Responses and Chat end-to-end turns that restart or resume at deterministic safe boundaries and
    prove `python_started=false`;
13. M4 regression, full Node tests, targeted Python parity tests, ESLint, TypeScript typecheck,
    contract drift, build, Node 22.19/current CI, cross-platform filesystem tests, and packed CLI
    smoke.

The fault suite asserts structural invariants rather than timing: one canonical user item, one
queue commit, at most one tool effect, at most one durable result, no automatic provider replay,
and no state from another session.

## Live Verification

M5 adds an opt-in sanitized Responses smoke that uses a disposable home, workspace, database, and
session. It forces a small compaction threshold or resumes a prebuilt compatible session, verifies
that bounded memory becomes model-visible, completes one Node-owned turn, reloads the session, and
reports only structural counts, terminal status, persisted state flags, and
`python_started=false`.

The smoke uses the configured `gpt-5.5` profile, zero retries, a short timeout, and bounded output.
It never prints credentials, endpoint data, prompts, memory text, summaries, tool arguments,
provider text, or raw responses. It runs only after offline gates pass. If the configured service
is unavailable, M5 records the sanitized unavailable result and does not repeat requests merely to
obtain a nondeterministic pass; offline acceptance remains authoritative until the protected live
environment is usable.

## Rollout And Rollback

The Node backend remains explicit preview after M5:

```bash
mycli --runtime-backend=node
```

Python remains the default. Backend ownership is selected before a turn or approval continuation
begins. A Node failure is returned as a Node failure and is never replayed through Python.

Rollback selects `python-sidecar` before a later turn. The four-way matrix must prove that Python
can read all Node-written compatible state needed for that session. State used only for a Node
ambiguity guard may be ignored by Python, but rollback must not cause Python to execute a claimed
or completed Node effect. A pending Node approval must first be resolved or interrupted; it cannot
be handed to Python mid-continuation.

## Exit Gate

M5 is complete when:

- Node implements the full session catalog, replay, snapshot, resume, and tree paths used by the
  TUI;
- session switching is atomic and suppresses stale source-session events;
- queue and steering records survive restart, commit exactly once, preserve priority, and never
  cross sessions;
- one-time mutation approval can suspend, survive restart, resolve, continue the original batch,
  and never replay an ambiguous effect;
- Responses continuation is validated and Chat reconstructs from canonical items;
- compaction preserves raw history, atomically replaces provider context, rehydrates bounded file
  state, and never automatically repeats an interrupted summary request;
- compatible memory files and session summaries are selected, injected, remembered, forgotten,
  isolated, and bounded without subagents;
- state corruption and unsupported versions fail closed with stable sanitized errors;
- all checkpoint fault tests and four-way persistence fixtures pass;
- both provider protocols pass the offline end-to-end M5 suite with `python_started=false`;
- the complete quality gate and M4 regressions pass;
- the sanitized live smoke succeeds when the configured protected service is available, or records
  one non-retried unavailable result;
- Node remains explicitly selectable and rollback to Python remains operator-controlled.

M6 may build persistent shell and process sandboxing on these approval and recovery contracts. M7
may add skills, subagents, automatic memory extraction, dream consolidation, MCP, plugins, and
hooks without changing M5's canonical session or checkpoint semantics.
