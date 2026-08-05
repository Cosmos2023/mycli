# Runtime TUI Gateway Contract

> Contract for Python runtime events consumed by the Node TUI.

## Scenario: Approval And Live Status Events

### 1. Scope / Trigger
- Trigger: Any change to `src/mycli/cli/node_tui/gateway.py`, the Node TUI
  protocol types, or the reducer state that changes runtime-to-TUI events.
- This is a cross-layer contract. Python owns runtime semantics and JSON-RPC
  emission; TypeScript owns rendering and reducer state.
- The target direction is Hermes-like channel separation, but existing mycli
  JSON-RPC method-name notifications remain compatible until a versioned
  envelope migration is introduced.

### 2. Signatures
- Python event emitter:
  `NodeTuiGateway._emit_event(method: str, params: dict[str, object]) -> None`
- Extension discovery request method: `extension.manifest`
- Turn submit request method: `turn.submit`
- Trace export request method: `trace.export`
- Approval response request methods:
  - Preferred: `approval.respond`
  - Compatibility: `decision.resolve`
- P1 server notification methods:
  - `runtime.event`
  - `turn.started`
  - `status.update`
  - `approval.request`
  - `approval.respond`
  - `clarify.request`
  - `compaction.started`
  - `compaction.completed`
  - `tool.start`
  - `tool.progress`
  - `tool.complete`
  - `tool.failed`
  - `message.delta`
  - `message.complete`
  - `reasoning.delta`
  - `thinking.delta`
  - `plan.proposed`
  - `plan.updated`
  - `turn.completed`
  - `turn.completion_suppressed`
  - `turn.failed`
  - `turn.interrupted`
  - `turn.status`
  - `gateway.error`
  - `session.changed`
  - `status.changed`
- TypeScript reducer entry point:
  `reduceShellState(state: ShellState, action: ShellAction) -> ShellState`
- Scripted smoke state dump:
  `MYCLI_NODE_TUI_STATE_DUMP=/path/to/state.json node tui/mycli-shell/test/support/scripted-client.ts`
- Scripted smoke assertion action:
  `{"type":"turn.submit_expect","message":"...","expected_state":"failed"}`
- Root Node workspace install and contract commands:
  - `npm ci`
  - `npm run contracts:generate`
  - `npm run contracts:check`
  - `npm run lint`
  - `npm test`
  - `npm run typecheck`

### 3. Contracts
- `status.update` payload:
  - `state`: one of `running`, `waiting_approval`,
    `waiting_clarification`, `completed`, `failed`, `interrupted`,
    `rejected`
  - `kind`: renderable status kind, normally the same as `state`
  - `text`: human-readable short status
  - `client_turn_id`: optional string linking the status to the submitted turn
  - `message`: optional bounded diagnostic detail for terminal or exceptional
    states, such as an interrupt request
  - `severity`: optional string for future warning/error display
- `approval.request` payload:
  - `decision_id`: stable string for the pending approval. Prefer the source
    tool call id when present; fall back to `decision_current` only when no
    stable call id exists.
  - `client_turn_id`: string for the turn that produced the approval request
  - `preview`: human-readable operation preview
  - `reason`: optional human-readable rationale
  - `tool_name`: optional tool name
  - `options`: array of `{choice, label}` rows matching runtime
    `DecisionAction` values
  - `choice` is a stable approval decision-choice value:
    `approve_once`, `reject`, or `allow_session`
  - Medium-risk local mutation tools such as `Edit`, `Write`, and `KillShell`
    emit `approval.request` when runtime config disables medium-risk
    auto-approval. These requests should normally expose only `approve_once`
    and `reject`; `allow_session` is reserved for approvals that have a stable
    `command_pattern`, such as shell command-pattern approvals.
- `approval.respond` request payload:
  - `decision_id`: must match the active decision id. The compatibility alias
    `decision_current` remains accepted for older clients while one decision is
    pending.
  - `choice`: preferred Hermes-like choice string, such as `approve_once`,
    `reject`, or `allow_session`
  - Runtime contracts and extension manifests must expose this choice taxonomy
    as machine-readable enum metadata, including `approval.request.options`
    item metadata and `approval.respond.choice`.
  - Runtime-side resolution failures and terminal decisions should be recorded
    as local `approval_resolution` trace/log diagnostics. They are not gateway
    stream events and must not be replayed into provider-visible transcripts.
- `decision.resolve` remains accepted for older clients. It shares the same
  gateway path as `approval.respond`.
- `clarify.request` payload:
  - `client_turn_id`: optional string linking the clarification to the active
    turn
  - `request_id`: stable string for this clarification request, normally the
    source tool call id
  - `tool_id`, `call_id`, and `tool_name`: diagnostic routing fields for the
    source tool request
  - `question`: bounded user-facing question text
  - `options`: bounded array of `{label, description?}` rows
  - `header`: optional short label
  - `multi_select`: boolean
  - `clarify.request` is emitted from `AskUserQuestion` tool results with
    `status == "awaiting_user_response"`. The runtime must pause the active
    turn with a persisted pending clarification instead of continuing as if the
    tool had completed normally.
  - The gateway emits `turn.status(state=waiting_clarification,
    terminal=false)` and `status.update(state=waiting_clarification)` when it
    forwards `clarify.request`, so clients can enter waiting-input UI state
    immediately instead of waiting for the later `turn.completed` compatibility
    event.
- `clarify.respond` request payload:
  - `request_id`: must match the active pending clarification.
  - `response`: non-empty user answer text. The TUI may send an option label or
    free-form text.
- `clarify.respond` notification payload:
  - `client_turn_id`: string for the clarification-resolution turn.
  - `request_id`: the resolved clarification request id.
  - `response`: bounded response preview for UI/diagnostics. Do not include
    secrets or unbounded text.
- `turn.completed` must include `client_turn_id`, `assistant_message`,
  `activity_events`, `progress_updates`, `plan_steps`, `pending_decision`,
  `turn_state`, and `usage`. A response with `pending_decision` maps to
  `waiting_approval`; a turn record with `WAITING_CLARIFICATION` maps to
  `waiting_clarification`; a turn record with `REJECTED` maps to `rejected`;
  otherwise it maps to `completed`.
- `plan.proposed` payload:
  - `client_turn_id`: string for the turn that produced the plan.
  - `text`: Markdown content extracted from a Codex-style
    `<proposed_plan>...</proposed_plan>` assistant block.
  - `source`: optional short source label, normally `assistant_message`.
  - The gateway must strip the proposed-plan XML block from
    `turn.completed.assistant_message` and final `message.complete(text)` so
    clients render the plan once as a dedicated plan item instead of duplicating
    it as ordinary assistant text.
  - Only exact standalone tag lines are treated as plan delimiters. Malformed or
    inline tags remain ordinary assistant text.
- `plan.updated` payload:
  - `client_turn_id`: string for the turn whose active plan changed.
  - `plan_steps`: array of rendered `"<status>: <content>"` rows, where status
    is normally `pending`, `in_progress`, or `completed`.
  - `source`: optional short source label, normally the tool name that updated
    the plan.
  - The runtime should emit this event immediately after the `Plan` /
    `update_plan` tool mutates plan state, before the turn completes, so clients
    can update a Claude Code-style active plan panel in place.
- `turn.status` is the normalized turn outcome/status event for clients that
  want one small routing payload instead of deriving outcomes from
  `turn.completed`, `turn.failed`, `turn.interrupted`, and `status.update`:
  - `client_turn_id`: optional string when known
  - `state`: one of `waiting_approval`, `waiting_clarification`,
    `completed`, `failed`, `interrupted`, `rejected`
  - `kind`: renderable status kind, normally same as `state`
  - `text`: human-readable short status
  - `terminal`: boolean; true for `completed`, `failed`, `interrupted`, and
    `rejected`; false for `waiting_approval` and `waiting_clarification`
  - `message`: optional failure, interruption, or rejection detail
  - Existing terminal method-name events remain the compatibility path. The
    gateway emits the existing event first, then `turn.status`, then
    `status.update` where applicable.
  - `turn.interrupted`, `turn.status(state=interrupted)`, and the matching
    `status.update(state=interrupted)` must include the active
    `client_turn_id` when a turn is running, so Node scripted smokes and future
    clients can correlate the interrupt with the active turn. The status
    payloads should include a bounded `message` such as `Interrupt requested`.
  - `turn.status(state=interrupted)` reports that an interrupt was requested
    and is terminal for that `client_turn_id` at the gateway/TUI boundary.
    If the running worker later returns a normal completed `TurnResponse` for
    the same turn, the gateway must suppress `turn.completed`,
    final `message.complete(final=true)`, `turn.status(state=completed)`, and
    `status.update(state=completed)`.
  - `turn.completion_suppressed` payload:
    - `client_turn_id`: string for the interrupted turn whose late completion
      was suppressed
    - `reason`: stable short reason, currently `interrupt_requested`
    - `suppressed_state`: terminal state that would have been emitted without
      suppression, normally `completed`
    - This event is a bounded diagnostic/runtime notification. It must not
      include raw user text, assistant text, provider payloads, tool output,
      headers, or secrets.
  - Node reducers must defensively ignore stale `turn.completed`, final
    `message.complete(final=true)`, and completed `status.update` events for a
    `client_turn_id` whose live status is already terminal `interrupted`.
  - Accepted running-turn interrupt requests are recorded as local
    `turn_interrupt_requested` trace/log diagnostics by the service boundary.
    This diagnostic is not a gateway stream event and must not include raw user
    messages, provider payloads, tool output, headers, or secrets.
  - Runtime finalization of interrupted turns records local `turn_interrupted`
    trace/log diagnostics after suspended state is saved. This is not a gateway
    stream event.
- `gateway.error` payload:
  - `code`: stable short error code from the gateway request-error taxonomy:
    `internal_error`, `invalid_params`, `method_not_found`,
    `turn_in_progress`, `decision_not_pending`, or
    `clarification_not_pending`, or `incompatible_protocol`
  - Python exposes the source taxonomy as `GATEWAY_ERROR_CODES` from
    `mycli.domain.runtime.gateway_contract`; Node TUI exposes the matching
    `GATEWAY_ERROR_CODES` runtime constant and `GatewayErrorCode` type from
    `tui/mycli-shell/src/adapters/gateway-client.ts`. Node tests must compare the TypeScript
    constant against the Python extension manifest schema.
  - `message`: bounded user-facing error text
  - `detail`: optional bounded diagnostic detail
  - `method`: optional JSON-RPC request method that triggered the error
  - Request-scoped gateway failures must both return the existing JSON-RPC
    error response and emit `gateway.error` when an event sink exists, so
    passive TUI/extension clients can observe the same failure surface without
    parsing response-only state.
  - Unexpected request-handler exceptions must return a JSON-RPC error
    response and emit `gateway.error`; they must not escape the gateway loop.
  - Turn-worker failures still use `turn.failed` / `turn.status` /
    `status.update`, not `gateway.error`.
- `runtime.event` is the versioned envelope mirror for runtime notifications:
  - `version`: integer envelope contract version, currently `1`
  - `sequence`: monotonically increasing integer per gateway instance
  - `type`: original event method, for example `message.delta`
  - `payload`: original event params object
  - `timestamp`: UNIX timestamp seconds from the gateway process
  - Python code should construct this payload through the runtime domain
    contract `RuntimeEventEnvelope` and `RUNTIME_EVENT_ENVELOPE_VERSION` rather
    than duplicating gateway-local dict literals.
  - Existing method-name notifications remain the primary compatibility path.
    The gateway emits them unchanged and then emits the envelope mirror.
  - `runtime.event` must not recursively wrap another `runtime.event`.
  - `runtime.ready` is a canonical direct event whose payload requires
    `session_id`. It is not mirrored in this slice because it is emitted
    outside the runtime event boundary during process bootstrap.
- Tool lifecycle notifications come from real tool execution, not model-side
  tool-call request streaming:
  - All `tool.*` lifecycle payloads must include `client_turn_id` so clients
    can correlate tool timeline rows with the active turn.
  - `tool.start` payload includes `client_turn_id`, `tool_id`, `call_id`,
    `name`, compact `context`, and optional bounded `args_preview`.
  - `tool.progress` payload includes `client_turn_id`, `tool_id`, `call_id`,
    `name`, `stage`, bounded `message`, and optional bounded `args_preview`.
    The first implemented progress stage is `executing`, emitted after
    `tool.start` and before `tool.complete` / `tool.failed`.
  - `tool.complete` payload includes `client_turn_id`, `tool_id`, `call_id`,
    `name`, `duration_s`, bounded `summary`, `summary_chars`,
    `summary_truncated`, and `success: true`.
  - `tool.failed` payload includes the same completion fields with
    `success: false` plus optional bounded `error`, `error_chars`, and
    `error_truncated`.
  - Bounded lifecycle text fields must expose whether they were truncated; TUI
    and extension clients must not infer completeness from preview length.
  - `tool_id` is the model/provider `call_id` when available; runtimes may use
    a deterministic local fallback when a call id is absent.
  - Lifecycle payloads are UI/diagnostic signals only. They must not be written
    into provider transcript content or stable request-shape inputs.
- Compaction lifecycle notifications are turn-internal activity events, not
  terminal turn outcomes:
  - `compaction.started` is emitted only when the runtime actually enters a
    compression path after the threshold check. It includes `client_turn_id`,
    `source`, `before_tokens`, and `max_tokens`.
  - `compaction.completed` includes `client_turn_id`, `source`, `status`,
    `before_tokens`, `after_tokens`, `max_tokens`, and `duration_s`.
    `status` is one of `compressed`, `skipped`, or `failed`.
  - These payloads are bounded diagnostics only. They must not include raw
    prompt text, tool output, provider payloads, headers, or secrets.
  - After `compaction.completed`, the active turn remains running and continues
    to the next model request unless another runtime condition terminates it.
- Message and reasoning stream notifications are typed gateway projections of
  runtime model stream events:
  - `message.delta` is emitted for assistant text deltas and includes
    `client_turn_id` and bounded raw `text`.
  - `reasoning.delta` is emitted for reasoning chunks and includes
    `client_turn_id` and bounded raw `text`.
  - `thinking.delta` is emitted as a compatibility alias for the same current
    reasoning chunks. It must not invent separate model semantics while mycli
    only has one reasoning stream.
  - `message.complete` is emitted for model stream completion metadata and
    includes `client_turn_id` plus bounded metadata from the runtime stream
    event. This stream-time form does not include `final: true`.
  - When a turn reaches a completed terminal response, a final
    `message.complete` is emitted after `turn.completed` with
    `client_turn_id`, bounded `text`, `final: true`, and
    `source: "turn_response"`.
  - Waiting-approval turns must not emit a final-text `message.complete`
    because the assistant answer is not complete yet.
  - `turn.completed.assistant_message` remains the compatibility authoritative
    final assistant text until TUI clients migrate finalization to
    `message.complete`.
  - Existing generic `turn.event` notifications must continue to be emitted
    alongside these typed message/reasoning notifications until Node TUI
    clients have migrated.
- `extension.manifest` is a read-only discovery RPC for external clients:
  - Response payload includes `schema_version`, `agent`, `rpc_methods`,
    `event_streams`, and `capabilities`.
  - `rpc_methods` names must match
    `mycli.cli.node_tui.gateway.supported_rpc_methods()`.
  - `event_streams` names must match
    `mycli.cli.node_tui.gateway.supported_event_streams()`.
  - Each `event_streams` entry must include `payload_schema`, a lightweight
    JSON-schema-like object generated from the runtime domain contract. The
    schema object includes:
    - `name`: event stream name, matching the entry name
    - `type: "object"`
    - `required`: stable required payload fields
    - `properties`: known payload fields and primitive/enum type metadata
  - `payload_schema` is a discovery and compatibility surface, not a full
    runtime validator. It must cover every supported gateway event stream so
    external clients can inspect required fields without scraping prose docs.
  - Node protocol code must keep a machine-readable
    `GATEWAY_EVENT_PAYLOAD_CONTRACTS` map whose required fields, known
    property names, and enum values match the Python manifest
    `payload_schema` object for every known event method. Node tests should
    compare that map against the live Python
    `ExtensionManifestService().manifest()` output so Python/TypeScript drift is
    caught before runtime.
  - It must list machine-readable integration methods such as `trace.export`.
  - It must list runtime stream discovery surfaces such as `runtime.event`,
    `message.delta`, `tool.start`, `turn.status`, and `session.changed`.
  - It must not claim dynamic extension lifecycle or ACP server support until
    those capabilities exist.
  - `mycli doctor` validates the manifest against gateway-advertised RPC names,
    event stream names, and event payload schema names through a read-only
    `runtime_contract` check. This check must not start runtime turns, call
    providers, or run Node.
- `session.changed` payload:
  - `session_id`: the active session id after `/resume`, `/fork`, or
    `session.resume`.
  - `session.changed` is a direct gateway notification and is not currently
    mirrored through `runtime.event` when emitted outside `_emit_event`.
- `status.changed` payload:
  - `session_id`: the active session id for the snapshot.
  - `workspace`, `model`, and `provider`: bounded display metadata for the
    active runtime context.
  - `context_window`: object with `used_tokens`, `max_tokens`, and `source`.
  - `pending_decision`: boolean indicating whether the active session has a
    persisted pending approval.
  - `suspended_turn`: boolean indicating whether the active session has a
    persisted suspended turn.
  - `turn_running`: boolean indicating whether the gateway currently has an
    accepted turn worker in progress.
  - `queued_steering`: array of queued steering messages for the active turn.
  - `queued_follow_up`: array of queued follow-up messages waiting for the
    active turn to finish.
  - `has_pending_input`: boolean derived from the queue snapshot.
  - `queue_activity`: object with `kind`, `has_pending_input`,
    `steering_count`, and `follow_up_count`. It is the compact Codex-like
    pending-input signal clients can render without inspecting message text.
  - `status.changed` is a snapshot event. It is not a replacement for
    `status.update`, and booleans alone are not enough to recover a pending
    approval or clarification.
  - Gateway `session.resume` must emit `session.changed` first, then a
    `status.changed` snapshot for the same active session so clients clear or
    retain pending state based on the resolved session tip.
  - If the resolved active session has a persisted pending approval or pending
    clarification, `session.resume` must then re-emit the concrete
    `approval.request` or `clarify.request` payload. A boolean
    `status.changed.pending_decision` / `suspended_turn` flag is not enough for
    clients to respond because they need the stable `decision_id` or
    `request_id`.
- Running-turn queue RPCs:
  - `turn.steer` accepts `{message, expected_turn_id, client_turn_id?,
    client_user_message_id?, local_images?}`. A matching active turn produces
    `pending_steer`; a stale or no-longer-active target produces a durable
    `rejected_steer` for the next server turn instead of losing the input.
  - `turn.follow_up` accepts `{message, client_turn_id?,
    client_user_message_id?, local_images?}` and may race terminal completion.
    Once accepted, it remains durable until a later turn reservation succeeds.
  - `turn.queue.pop` removes only the newest ordinary follow-up and returns the
    removed structured item plus the new revision.
  - `turn.queue.clear` accepts `{}` and returns the cleared steering and
    follow-up messages so the TUI can restore them into the editor.
  - `turn.queue.migration.ack` accepts a bootstrap migration `token` and removes
    exactly the matching visible user records. A stale token is `queue_conflict`.
  - `local_images` is an array of `{path, placeholder}` local image attachment
    descriptors. Runtime-compatible clients must keep these descriptors with
    queued inputs instead of treating `[image #n]` as plain text only.
- `turn.queue.updated` payload:
  - `steering`: array of currently queued steering messages.
  - `follow_up`: array of currently queued follow-up messages.
  - `has_pending_input`: boolean derived from the current queue snapshot.
  - `activity`: object with `kind`, `has_pending_input`, `steering_count`, and
    `follow_up_count`.
  - `steering_items`: optional typed array of currently queued steering inputs.
  - `follow_up_items`: optional typed array of currently queued follow-up
    inputs.
  - Typed queue items include `kind`, `message`, `text`, `source`,
    optional `client_turn_id`, and optional `local_images`. New clients should
    prefer typed arrays and fall back to string arrays for older gateways.
  - The persisted typed queue-item `kind` enum is `pending_steer`,
    `rejected_steer`, or `follow_up`. Contract schemas must retain
    `rejected_steer` because a steer rejected at an unsafe injection point is
    preserved for a later server turn rather than discarded.
  - Emit after successful queue mutation and after runtime drains queued
    messages, so the footer and pending-message area stay synchronized with the
    backend instead of relying on local-only queue state.
  - Structured events include the active `session_id`, `generation`, and
    monotonic `queue_revision`. Legacy arrays and item arrays are projections of
    the same structured snapshot; `task_notification` records remain durable but
    are hidden from visible legacy projections.

## Scenario: Durable Node Queue And Steering

### 1. Scope / Trigger

- Trigger: any Node runtime change to steering, follow-up input, queue replay,
  terminal queue draining, or queue RPC/event projection.
- This flow crosses TUI RPC, gateway generation ownership, runtime orchestration,
  and SQLite state/history transactions.

### 2. Signatures

- Gateway RPCs: `turn.steer`, `turn.follow_up`, `turn.queue.pop`,
  `turn.queue.clear`, and `turn.queue.migration.ack`.
- Runtime: `QueueCoordinator.enqueueSteer()`, `enqueueFollowUp()`,
  `commitPending(turnId)`, `rejectPending(turnId)`, `next()`, and
  `markStarted(queueId)`.
- Storage:
  `SessionStore.saveQueueSnapshot({sessionId, workspaceRoot, threadId, snapshot}) -> QueueSnapshot`
  and
  `SessionStore.commitQueuedInputs({sessionId, turnId, records}) -> QueueSnapshot`.

### 3. Contracts

- Every mutation increments a safe integer revision exactly once. A duplicate
  lost-response retry with the same `client_turn_id` and payload returns the
  existing record/revision without another write or event.
- The first persisted snapshot for a session must have revision one. Later
  writes accept only an identical idempotent payload or exactly `current + 1`.
- Persist the candidate before replacing the in-memory snapshot, emitting
  `turn.queue.updated`, or returning RPC success.
- Before every provider request, atomically append matching pending steers to
  canonical conversation/history and remove them from `input_queue` by
  `queue_id`; then reload canonical provider history.
- On normal completion, persist remaining matching pending steers as
  `rejected_steer` before terminal success. Interruption retains pending steers.
- After a completed turn, inspect at most one rejected steer/follow-up. Reuse
  its `clientTurnId` as the reservation idempotency key, reserve first, and call
  `markStarted()` only after reservation succeeds.
- Queue callbacks carry the captured session generation. Old-generation
  callbacks cannot replace or publish the new active session queue.
- Preserve unknown compatible Python root and record fields when rewriting the
  `input_queue` payload.

### 4. Validation & Error Matrix

- Missing/blank message, expected turn id, migration token, or malformed image
  descriptor -> `invalid_params`; no queue write.
- Same client id with different payload -> `queue_conflict`; original record
  remains.
- Record/text/attachment bounds exceeded -> `queue_capacity`; no event.
- Snapshot session mismatch or stale revision -> `queue_conflict`.
- SQLite write/transaction failure -> RPC `persistence_error` with a bounded
  message; do not expose paths, SQL, payloads, or exception text.
- Next-turn reservation failure -> retain the record and emit bounded
  `queue_worker_start_failed`; do not start provider IO.

### 5. Good/Base/Bad Cases

- Good: a steer arriving during a tool step is committed once and appears in
  the next provider request after the tool result.
- Base: an empty queue has revision zero, empty structured arrays, and no
  legacy migration payload.
- Good: a follow-up racing turn completion is persisted, reserved with its own
  client id, then removed and run once.
- Bad: deleting a queued record before reservation or publishing a revision
  before SQLite commit, because a crash can lose input or expose phantom state.

### 6. Tests Required

- Core/runtime tests for restore reconciliation, rejected-first order, capacity,
  idempotency, session isolation, terminal rejection, interrupt retention, and
  commit-before-provider ordering.
- Storage tests proving queue history append plus pending removal roll back
  together and Python optional fields survive snapshot CAS writes.
- Gateway tests asserting event-before-response only after persistence, stale
  steer deferral, queue RPC revisions, sanitized errors, generation fencing,
  reservation-before-removal, and reservation-failure retention.
- Backend restart integration proving a queued record is readable after process
  restart without provider IO.

### 7. Wrong vs Correct

#### Wrong

```ts
queue.markStarted(record.queueId);
const reservation = runtime.reserve(submission);
```

#### Correct

```ts
const reservation = runtime.reserve({
	...submission,
	clientTurnId: record.clientTurnId,
});
queue.markStarted(record.queueId);
```

- Node workspace dependency layout:
  - The repository root `package.json` is the workspace composition root for
    `packages/*` and `tui/*`; the root `package-lock.json` is authoritative.
  - Run `npm ci` from the repository root. Do not restore or depend on a nested
    `tui/mycli-shell/package-lock.json`.
  - Workspace tooling such as `tsx` and `typescript` may resolve from the root
    `node_modules`; diagnostics and process launch code must recognize that
    layout instead of requiring duplicate nested installations.
  - Canonical hand-edited schemas live under `packages/contracts/schemas`.
    Generated TypeScript declarations and Python JSON resources must be
    regenerated together and must pass `npm run contracts:check`.
- `trace.export` is a read-only pull RPC for machine-readable runtime trace
  rows:
  - Request payload accepts optional `tail`; invalid or non-positive values use
    the gateway default.
  - Response payload includes `session_id`, `format: "jsonl"`, and `rows`.
  - `rows` contains unprefixed JSONL row strings from the active session trace.
  - The slash command `/trace-jsonl` may prefix these rows for human command
    output, but RPC consumers must receive raw row strings.
- Reducer state:
  - `liveStatus` is driven by `status.update` and terminal turn events.
  - `pendingApproval` is driven by `approval.request`.
  - `pendingApproval` is cleared by `approval.respond`, terminal status, or a
    `status.changed` snapshot with `pending_decision === false`.
  - `pendingClarification` is driven by `clarify.request` and displayed as a
    distinct `clarification` transcript row. It must not reuse approval state or
    approval response keybindings.
  - `pendingClarification` is cleared by `clarify.respond`, terminal status, or
    a `status.changed` snapshot with `suspended_turn === false`.
  - While `pendingClarification` exists, plain TUI input submit sends
    `clarify.respond` with `{request_id, response}` instead of `turn.submit`.
    Slash commands remain slash commands.
  - For single-select clarification options, Node TUI input may normalize a
    numeric option index or case-insensitive option label to the exact option
    label before sending `clarify.respond`. Non-matching text remains a
    free-form response. Multi-select clarification remains free-form until a
    dedicated selector exists.
  - `tool.start`, `tool.complete`, and `tool.failed` are consumed by the Node
    TUI reducer as `tool_summary` transcript rows. The reducer matches existing
    rows by `tool_id` first and `call_id` second, so completion updates the
    running row instead of appending duplicates.
  - `tool.complete` maps the matching row to `status: "done"` and
    `tool.failed` maps it to `status: "failed"`. If completion arrives without
    a prior start, the reducer creates a compact fallback row.
  - `compaction.started` and `compaction.completed` are consumed as a matched
    in-turn activity row. They must not clear `turnRunning`, finalize assistant
    text, or render a turn-level `Completed` state.
  - `message.delta` is consumed as assistant stream text.
  - After a `message.delta` has been seen for a `client_turn_id`, the reducer
    ignores compatibility `turn.event` assistant deltas for that same
    `client_turn_id` to prevent duplicate visible answer text.
  - If no typed `message.delta` has been seen for the turn, legacy
    `turn.event` assistant deltas remain a valid fallback for older runtimes.
  - `reasoning.delta` and `thinking.delta` update compact live reasoning state
    for running-turn display. They must not append text to assistant answer
    transcript items.
  - `message.complete` is consumed as stream-completion metadata only. It may
    annotate the active streamed assistant row with bounded metadata and clear
    matching live reasoning, but it must not append a visible row, mark the turn
    terminal, or replace the final assistant answer.
  - `turn.completed.assistant_message` is authoritative for final assistant
    text only when it contains non-blank content. Waiting-state turns commonly
    complete with an empty assistant message; the reducer must not create a
    visible blank `assistant_final` row for those turns, and must remove a
    transient empty stream row if one exists.
  - `runtime.event` can be unwrapped into `{method: type, params: payload}` and
    then processed by the same reducer paths as direct method-name events.
    Production Node TUI clients should avoid feeding both direct and envelope
    mirrors into visible state until a transport preference/dedup strategy is
    introduced.
  - Terminal turn events clear live reasoning and typed-message bookkeeping.
  - `turn.status(state=failed, terminal=true)` with a bounded `message` appends
    one recoverable `error` transcript row so terminal failed `TurnResponse`
    paths remain visible after later turns. If an adjacent `turn.failed` event
    already produced the same error, the reducer must keep a single row.
  - `gateway.error` appends an `error` transcript row without mutating turn
    status unless a separate `turn.failed` or `status.update` also arrives.
  - `error` and `warning` transcript rows may render a secondary diagnostic line
    from allowlisted metadata (`source`, `method`, `code`). They must not dump
    raw payloads, nested objects, request bodies, headers, or secret-like
    values.
  - JSON-RPC response errors from `GatewayClient.send(...)` reject with a
    request error carrying the original request method and error code. The
    RuntimeApp dispatches those as local `request.failed` actions so request
    failures such as rejected `approval.respond`, `clarify.respond`, or
    `command.run` calls become visible error transcript rows even when no
    separate `gateway.error` notification is emitted.
  - If a local `request.failed` action and a `gateway.error` notification carry
    the same `code`, `method`, and `message` close together, the reducer keeps
    one visible error row to avoid double-reporting the same request failure.
  - The input area should render a compact context-sensitive hint derived from
    local TUI state. Completion popup, approval, clarification, running turn,
    and normal input modes should each expose the most relevant keyboard action
    without changing runtime or gateway semantics.
  - `/help` should be handled as a Node-local command that opens the existing
    overlay surface with static TUI key/action guidance. Non-local slash
    commands should continue to route to the gateway.
- The scripted Node client is allowed to write a final reducer state snapshot
  only when `MYCLI_NODE_TUI_STATE_DUMP` is set. This is a test/smoke hook, not
  a production persistence mechanism.
  - Assistant stream text is accumulated from typed `message.delta`
    notifications. Compatibility `turn.event` `assistant_delta` notifications
    must not append assistant text in the Node TUI, because the gateway emits
    both event families during migration.
  - Reasoning/thinking display status is driven by typed `reasoning.delta` and
    `thinking.delta` notifications. These update `liveStatus` with a bounded
    `Thinking: ...` preview while the turn is running.
  - Reasoning/thinking deltas must not append transcript rows. Compatibility
    `turn.event` `reasoning` notifications must not drive transcript text or
    duplicate the typed live-status path.
  - Assistant finalization is driven by final `message.complete` events where
    `final === true`; stream-metadata `message.complete` events without
    `final: true` must not finalize transcript text.
  - `turn.completed` remains responsible for terminal turn status and pending
    approval cleanup, but the Node TUI must not append or overwrite assistant
    transcript text from `turn.completed.assistant_message`.

### 4. Validation & Error Matrix
- Unknown approval `decision_id` -> JSON-RPC error; do not resolve anything.
- Approval `decision_id` equal to the active tool call id -> accepted.
- Approval `decision_id=decision_current` -> accepted as a compatibility alias
  for the active pending decision.
- Unknown or legacy approval choice -> map through the existing decision choice
  table; reject invalid choices at the runtime decision boundary.
- Accepted `approval.respond(choice=reject)` -> persist the resolved turn as
  `TurnStatus.REJECTED` with `StopReason.APPROVAL_REJECTED`, emit
  `approval.respond`, then `turn.completed(turn_state=rejected)`, then
  `turn.status(state=rejected, terminal=true)`, then
  `status.update(state=rejected)`. Do not emit final-text `message.complete`.
- Invalid `status.update.state` in the reducer -> ignore the event and preserve
  existing state.
- `extension.manifest` -> return static capability discovery data without
  mutating runtime, session, or extension state. RPC and event names must be
  generated from gateway supported-contract constants, not from a hand-maintained
  partial list.
- Turn starts -> emit `turn.started` and live `status.update` with `running`.
- Any runtime event emitted through the gateway event boundary -> preserve the
  existing method-name notification and emit a `runtime.event` mirror with the
  next sequence number.
- `runtime.ready` with a non-object payload or without non-empty `session_id`
  -> reject at the Node process boundary as an invalid gateway notification;
  do not expose raw payload content in the error.
- Typed queue item with `kind=rejected_steer` -> accept and preserve it in the
  rejected-steer collection; any unknown queue item kind -> contract validation
  failure.
- Generated schema or declaration differs from canonical output ->
  `npm run contracts:check` exits non-zero without rewriting the worktree.
- Root workspace dependencies absent -> Node launch/doctor diagnostics point
  to root `npm ci`; do not require a nested TUI lockfile or nested-only `tsx`.
- `trace.export` -> return bounded sanitized JSONL rows without mutating trace
  files or session state.
- Turn returns `pending_decision` -> emit `approval.request`, then
  `turn.completed` with `turn_state=waiting_approval`, then `turn.status` with
  `state=waiting_approval` and `terminal=false`, then `status.update` with
  `waiting_approval`.
- Tool execution starts -> emit `tool.start` during the running turn before the
  local tool is executed.
- Pre-tool hook denial -> emit `tool.start`, `tool.progress(stage=executing)`,
  and `tool.failed` with `success=false` and bounded error metadata. The
  underlying tool must not execute, but the attempted call remains visible to
  TUI and extension clients.
- Tool execution enters the local execution phase -> emit `tool.progress` with
  `stage=executing` during the running turn after `tool.start` and before a
  terminal tool lifecycle event.
- Tool execution succeeds -> emit `tool.complete` during the running turn after
  the local `ToolResult` is known.
- Tool execution returns an unsuccessful `ToolResult` -> emit `tool.failed`
  during the running turn after the local `ToolResult` is known. Do not also
  emit `tool.complete` for the same failed result.
- `AskUserQuestion` returns a successful tool result with
  `status=awaiting_user_response` -> emit `clarify.request` after the normal
  successful tool lifecycle events, mirror it through `runtime.event`, emit
  realtime `turn.status` / `status.update` with `waiting_clarification`,
  persist a suspended turn with pending clarification, and finish the current
  turn as `waiting_clarification`.
- `clarify.respond` request with blank `response` -> JSON-RPC `invalid_params`.
- `clarify.respond` request with a non-matching `request_id` -> runtime returns
  a non-resuming response; clients must keep diagnostics visible.
- Accepted `clarify.respond` -> emit `turn.started`, `status.update(running)`,
  `clarify.respond`, `turn.completed`, `turn.status`, `status.update`, and
  `status.changed`; mirror `clarify.respond` through `runtime.event`.
- Model reasoning chunk -> emit `reasoning.delta`, `thinking.delta`, and the
  compatibility `turn.event` with phase `reasoning`.
- Model assistant text chunk -> emit `message.delta` and the compatibility
  `turn.event` with phase `assistant_delta`.
- Node TUI receives both typed and compatibility assistant chunks for a typed
  runtime -> render only the typed `message.delta` content.
- Node TUI receives only legacy assistant chunks -> render
  `turn.event phase=assistant_delta` content.
- Scripted smoke with `MYCLI_NODE_TUI_STATE_DUMP` set -> write a bounded JSON
  reducer snapshot after shutdown so cross-process tests can assert final
  transcript state without scraping terminal frames.
- Scripted smoke waiting-state actions -> read the active `decision_id` or
  `request_id` from reducer `pendingApproval` / `pendingClarification`, send
  `approval.respond` / `clarify.respond`, and wait for `turn.completed` with
  the response `client_turn_id` before continuing.
- Model stream completion metadata -> emit `message.complete` and the
  compatibility `turn.event` with phase `model_completed`.
- Completed turn response -> emit `turn.completed`, then final-text
  `message.complete` with `final: true`, then `status.update` with
  `completed`.
- Rejected approval turn response -> emit `turn.completed`, then `turn.status`
  with `state=rejected`, `terminal=true`, and a bounded `message`, then
  `status.update` with `rejected`; do not emit final-text `message.complete`.
- Waiting-approval turn response -> emit `approval.request`, then
  `turn.completed`, then `status.update` with `waiting_approval`; do not emit
  final-text `message.complete`.
- Turn completes without a pending decision -> emit `turn.completed` with
  `turn_state=completed`, then `turn.status` with `state=completed` and
  `terminal=true`, then `status.update` with `completed`.
- Turn raises -> emit `turn.failed`, then `turn.status` with `state=failed`,
  `terminal=true`, and a bounded `message`, then `status.update` with `failed`.
- Unexpected request-handler exception outside a turn worker -> return
  JSON-RPC `internal_error`, emit `gateway.error`, and mirror it through
  `runtime.event`.
- JSON-RPC error response for a TUI-originated request -> reject
  `GatewayClient.send(...)` with code, message, and method; RuntimeApp renders
  the failure as a local error row.
- Scripted Node smoke clients must reduce expected request failures through the
  same `request.failed` state action before dumping state, so no-pending or
  wrong-decision approval errors remain testable as visible TUI diagnostics.
- User interrupt while a turn is running -> emit `turn.interrupted`, then
  `turn.status` with `state=interrupted`, `terminal=true`, and a bounded
  `message`, then `status.update` with `interrupted`.
- User interrupt followed by a late normal worker completion -> preserve the
  interrupted status, emit `turn.completion_suppressed`, and do not append or
  finalize late assistant text.
- Scripted Node smoke for a single turn with known outcome -> use
  `turn.submit_expect` so the script fails if the expected runtime/TUI state is
  not observed through gateway events and reducer state. Supported
  `expected_state` values are `waiting_approval`, `waiting_clarification`,
  `completed`, `failed`, `interrupted`, and `rejected`.

### 5. Good/Base/Bad Cases
- Good: TUI renders a concrete approval prompt from `approval.request` without
  inferring details from transcript text.
- Good: TUI renders a concrete clarification request from `clarify.request`
  without conflating it with approval.
- Good: TUI sends a plain text `clarify.respond` while clarification is
  pending, and the runtime resumes the suspended turn with the answer as the
  original `AskUserQuestion` tool result.
- Good: TUI lets a user type `1` or `TUI` for a single-select clarification
  option and sends the canonical option label in `clarify.respond`.
- Good: TUI renders active tool rows from `tool.start` and final summaries from
  `tool.complete` / `tool.failed` without waiting for `turn.completed`.
- Good: TUI keeps a single row for the same tool id as it moves from running to
  done or failed.
- Good: New clients consume `message.delta` and `reasoning.delta` while older
  clients keep rendering from `turn.event`.
- Good: Future extension/ACP clients can subscribe to `runtime.event` and route
  by `type` without knowing every JSON-RPC method name ahead of time.
- Good: Future extension/ACP clients can subscribe to `turn.status` outcomes
  when they only need turn state, while current TUI clients keep rendering from
  existing terminal events and `status.update`.
- Good: A bootstrap `runtime.ready` notification with `session_id` validates as
  a direct event without producing a `runtime.event` mirror.
- Good: A `rejected_steer` queue item survives schema validation and remains
  available for the next server turn.
- Base: `npm ci` at the repository root installs both `@mycli/contracts` and
  `mycli-shell-tui` from the single root lockfile.
- Bad: Editing a generated TypeScript declaration or Python schema copy by
  hand causes the drift check to fail.
- Bad: A `runtime.ready` notification without `session_id` is not forwarded to
  the TUI reducer.
- Good: TUI shows a compact running reasoning preview without mixing reasoning
  text into the final assistant answer.
- Good: TUI records `message.complete` metadata on the active assistant stream
  while leaving final answer reconciliation to `turn.completed`.
- Good: TUI does not render a blank assistant answer for approval or
  clarification waiting turns whose `turn.completed.assistant_message` is
  empty.
- Good: Running activity prefers `liveStatus.text`, so the status line can show
  reasoning previews, `Waiting approval`, `Resolving approval`, or `Failed`.
- Good: A request-level gateway failure is visible as `gateway.error` without
  inventing a failed turn.
- Good: A rejected `approval.respond` request is visible as one error row even
  if a matching `gateway.error` event also arrives.
- Good: Error rows show compact `source`, `method`, and `code` diagnostics
  when those fields are available.
- Good: The input footer shows `Ctrl-C interrupt` while running, numeric
  response guidance while approval is pending, and reply guidance while
  clarification is pending.
- Good: `/help` is available without a gateway round trip and documents local
  TUI commands plus modal key actions.
- Good: External/extension clients call `trace.export` instead of scraping
  human `/trace` or prefixed `/trace-jsonl` command output.
- Good: External/extension clients call `extension.manifest` before assuming
  which RPC methods, event streams, and capability families are available.
- Base: Older clients still send `decision.resolve` and receive compatible
  behavior.
- Bad: Only setting `pending_decision: true` on `turn.completed`; that tells the
  UI a gate exists but not how to render or resolve it.
- Bad: Treating model-side `RuntimeStreamEvent(kind="tool_call")` as execution
  start. That event only means the model requested a tool.
- Bad: Rendering both typed `message.delta` and compatibility `turn.event`
  assistant deltas in the same TUI path, causing duplicate text.
- Bad: Re-enabling compatibility `turn.event` assistant-delta rendering after
  typed `message.delta` consumption has landed.
- Bad: Rendering typed `reasoning.delta` or `thinking.delta` as assistant
  transcript content. Reasoning is a running-status signal until the TUI grows
  a dedicated reasoning view.
- Bad: Treating `message.complete` as final assistant content before the
  runtime emits the final form with `final: true`.
- Bad: Rendering an empty `assistant_final` row for a waiting approval or
  waiting clarification turn.
- Bad: Finalizing from both final `message.complete` and
  `turn.completed.assistant_message`, causing duplicate or stale assistant
  rows.
- Bad: Sending full file contents, raw tool JSON, or provider transcript
  messages through lifecycle notification payloads.
- Bad: Appending a new visible row on both `tool.start` and `tool.complete` for
  the same `tool_id`; that creates duplicated tool activity.
- Bad: Adding new untyped event fields in Python without updating TypeScript
  payload types and reducer tests.
- Bad: Adding or changing Python `payload_schema.required`, `properties`, or
  enum values without updating the TypeScript protocol contract map and
  cross-language Node test.
- Bad: Feeding both direct method-name notifications and their `runtime.event`
  mirrors into the same visible reducer path without deduplication.
- Bad: Treating `turn.status(state=interrupted)` as proof that runtime
  execution stopped. It is currently an interrupt-request signal.
- Bad: Returning `[trace-jsonl]` prefixes from `trace.export`; those are only
  for slash command transcript output.
- Bad: Advertising extension lifecycle or ACP server support before those
  transports are actually implemented.
- Bad: Copying Hermes implementation code. Use Hermes only as the semantic
  reference for channel separation.
- Bad: Treating `clarify.request` as `approval.request`; clarification is a
  user-input UX channel, while approval is a safety gate.
- Bad: Reusing approval keybindings or approval state for clarification
  options.
- Bad: Emitting `clarify.request` but allowing the model loop to continue
  without a user answer.
- Bad: Letting unexpected request-handler exceptions escape
  `NodeTuiGateway.handle_request`; the Node process loses a structured error
  and the TUI cannot render diagnostics.
- Bad: Reporting request-handler exceptions as `turn.failed` when no turn was
  started.
- Bad: Calling `void client.send(...)` without a rejection path in RuntimeApp;
  that turns recoverable JSON-RPC errors into invisible or unhandled Promise
  rejections.

### 6. Tests Required
- Gateway unit test for `approval.request` payload fields and option mapping.
- Gateway unit test proving `approval.respond` and `decision.resolve`
  compatibility.
- Tool execution unit tests for start, complete, and failed lifecycle sink
  events without changing normal `TurnItemType.TOOL_CALL` / `TOOL_RESULT`
  recording.
- Agent runtime test proving lifecycle events flow through
  `handle_user_turn(..., stream_sink=...)` from real execution.
- Gateway unit test proving `RuntimeStreamEvent(kind="tool_start" |
  "tool_progress" | "tool_complete" | "tool_failed")` emits `tool.start` /
  `tool.progress` / `tool.complete` / `tool.failed`, not generic
  `turn.event`.
- Tool execution unit test proving `AskUserQuestion` success emits a bounded
  `clarify_request` lifecycle event after normal tool lifecycle events.
- Gateway unit test proving `RuntimeStreamEvent(kind="clarify_request")` emits
  `clarify.request`, realtime `waiting_clarification` status updates, and a
  `runtime.event` mirror.
- Node protocol typecheck/client test proving `clarify.request` payloads narrow
  in `GatewayClient.waitForEvent(...)`.
- Node protocol test proving `KNOWN_GATEWAY_EVENT_METHODS` and
  `GATEWAY_EVENT_PAYLOAD_CONTRACTS` stay aligned with Python supported event
  streams and manifest payload-schema required fields, property names, and enum
  values.
- Reducer/rendering/status tests proving Node TUI consumes `clarify.request`,
  stores `pendingClarification`, renders a distinct clarification row, supports
  `runtime.event` envelope unwrap, and shows `clarification pending` metadata.
- Session-service test proving `SuspendedTurn` persists and reloads pending
  clarification state.
- Runtime test proving `AskUserQuestion` pauses with
  `waiting_clarification`, and `resolve_pending_clarification(...)` resumes by
  injecting the answer as the original tool result.
- Gateway tests proving `clarify.respond` validates payloads, starts a
  clarification-resolution turn, emits `clarify.respond`, and mirrors it
  through `runtime.event`.
- Node tests proving plain input routes to `clarify.respond` while
  `pendingClarification` exists and reducer clears pending state when
  `clarify.respond` is observed.
- Node tests proving single-select clarification input maps numeric indices
  and case-insensitive labels to canonical labels while preserving free-form
  answers and slash-command routing.
- Gateway tests proving unexpected request-handler exceptions return
  `internal_error`, emit `gateway.error`, and mirror it through
  `runtime.event`.
- Reducer tests proving `gateway.error` appends an error transcript row.
- Client tests proving JSON-RPC errors reject with request method and error
  code.
- Reducer tests proving local `request.failed` appends one error row and
  deduplicates a matching `gateway.error`.
- Rendering tests proving error diagnostics show only bounded allowlisted
  metadata fields.
- Rendering tests proving contextual input hints change with completion,
  approval, clarification, running, and normal modes.
- Local-command tests proving `/help` opens an overlay while non-local commands
  still route to the gateway.
- Reducer/transcript tests proving Node TUI consumes `tool.start`,
  `tool.complete`, and `tool.failed` into one matched `tool_summary` row.
- Rendering/formatter tests proving lifecycle rows show readable running, done,
  and failed summaries with bounded details.
- Reducer tests proving Node TUI consumes `message.delta`, suppresses duplicate
  compatibility assistant deltas for the same turn, and preserves legacy
  `turn.event` fallback when typed deltas are absent.
- Reducer/rendering tests proving `reasoning.delta` and `thinking.delta` update
  compact live reasoning state without mutating assistant answer text.
- Reducer tests proving direct and enveloped `message.complete` annotate the
  active assistant stream with bounded metadata, clear matching live reasoning,
  and keep `turn.completed` authoritative.
- Integration smoke proving `run_node_tui_gateway(...)` can drive the real Node
  scripted client over stdio, typed stream notifications reach the reducer, and
  final assistant state is not duplicated by compatibility `turn.event`.
- Integration smoke proving the real Node scripted client can resolve
  `approval.request` and `clarify.request` by deriving ids from reducer state,
  sending the matching gateway request, waiting for the resolution turn, and
  clearing pending state.
- Integration smoke proving the real Node scripted client can call
  `session.resume` on an ancestor, receive pending-state payloads for the
  resolved tip, respond to approval or clarification, and finish with pending
  state cleared.
- Transcript reducer test proving blank final answers do not create visible
  assistant rows.
- Gateway unit test proving `RuntimeStreamEvent(kind="text_delta")` emits
  `message.delta` and still emits compatibility `turn.event`.
- Gateway unit test proving runtime notifications emit `runtime.event` mirrors
  with version, monotonic sequence, original type, original payload, and
  timestamp.
- Gateway unit test proving `runtime.event` does not recursively wrap itself.
- Reducer unit test proving `runtime.event` can unwrap and reuse the existing
  direct-event reducer handling.
- Gateway unit test proving `RuntimeStreamEvent(kind="reasoning")` emits
  `reasoning.delta`, `thinking.delta`, and still emits compatibility
  `turn.event`.
- Gateway unit test proving `RuntimeStreamEvent(kind="completed")` emits
  `message.complete` and still emits compatibility `turn.event`.
- Gateway unit test proving completed turn responses emit a final-text
  `message.complete` with bounded `text`, `final: true`, and
  `source: "turn_response"`.
- Gateway unit test proving waiting-approval responses do not emit final-text
  `message.complete`.
- Gateway tests for `status.update` on running, waiting approval, completed,
  failed, and interrupted paths when those paths are changed.
- Gateway tests for `turn.status` on completed, waiting approval, failed,
  interrupted, and approval-resolution paths when those paths are changed.
- Gateway unit test proving `trace.export` returns unprefixed JSONL rows and
  honors bounded `tail` behavior.
- Gateway unit test proving `extension.manifest` returns the service manifest.
- Reducer unit test for `approval.request`, `approval.respond`,
  `status.update`, and terminal clearing behavior.
- Reducer unit test proving final `message.complete` reconciles the assistant
  transcript, stream-metadata `message.complete` is ignored, and
  `turn.completed` alone does not append blank final assistant rows.
- Reducer unit test proving typed `message.delta` appends assistant stream text
  and compatibility `turn.event` assistant deltas are ignored.
- Reducer unit test proving typed `reasoning.delta` and `thinking.delta`
  update live status without appending transcript text.
- Reducer unit test proving compatibility `turn.event` reasoning messages do
  not append transcript text.
- Rendering test proving live status text is displayed instead of a hardcoded
  running label when present.
- Run Python gateway tests, `ruff`, `mypy` for the changed gateway file, Node
  `typecheck`, and Node tests for protocol/reducer/rendering changes.
- Root Node `test` and `typecheck` commands must resolve workspace tooling from
  the root installation. Direct TUI source launch may use its local `tsx` only
  as a compatibility fallback; missing dependencies should produce an
  actionable root `npm ci` message.
- Contract catalog tests proving `runtime.ready` is present in the canonical
  event list and its payload requires `session_id`.
- Cross-language fixture tests proving valid `runtime.ready` and
  `rejected_steer` payloads pass in Ajv and Python `jsonschema`, while malformed
  boundary payloads fail without leaking their content.
- Workspace tests proving the root lockfile owns both packages, no nested TUI
  lockfile is required, and generated outputs pass `npm run contracts:check`.

### 7. Wrong vs Correct

Wrong:
```python
self._emit_event(
    "turn.completed",
    {"pending_decision": response.pending_decision is not None},
)
```

Correct:
```python
if response.pending_decision is not None:
    self._emit_event("approval.request", approval_payload)
self._emit_event("turn.completed", {"turn_state": "waiting_approval"})
self._emit_event("status.update", {"state": "waiting_approval", "text": "Waiting approval"})
```

Wrong:
```typescript
if (action.method === "status.update") {
  return { ...state, liveStatus: action.params as LiveStatus };
}
```

Correct:
```typescript
if (action.method === "status.update") {
  const liveStatus = liveStatusFromParams(action.params);
  return liveStatus ? { ...state, liveStatus } : state;
}
```

## Scenario: Node Composition Root With Python Sidecar

### 1. Scope / Trigger
- Trigger: Changes to `apps/mycli`, sidecar stdio startup, gateway transport
  injection, process signals, package exports, or Node/Python process ownership.
- During M1, Node owns the terminal and process lifecycle. Python is a
  temporary JSON-RPC sidecar and must never inherit the TTY.

### 2. Signatures
- Node CLI: `mycli [--session <id>] [--model <model>] [--runtime-backend python-sidecar]`
- Backend selector:
  `selectRuntimeBackend({argv, env}) -> "python-sidecar"`
- Sidecar controller:
  `startPythonSidecar({cwd, env, args, ...}) -> PythonSidecar`
- Sidecar command:
  `<python> -m mycli.cli.sidecar [--session <id>] [--model <model>]`
- Python entry point: `python -m mycli.cli.sidecar`
- Gateway module startup: `gatewayStartup: Promise<void>`
- Gateway module shutdown: `gatewayShutdown() -> Promise<void>`

### 3. Contracts
- `MYCLI_PYTHON` optionally overrides the Python executable. The default is
  `python` on Windows and `python3` elsewhere.
- `MYCLI_RUNTIME_BACKEND` may select `python-sidecar`; an explicit CLI value
  takes precedence over the environment.
- `MYCLI_SIDECAR_START_TIMEOUT_MS` controls readiness timeout and remains
  bounded to 1-60 seconds.
- Spawn uses `stdio: ["pipe", "pipe", "pipe"]`, `windowsHide: true`, and
  `shell: false`. Child stdout is gateway input, child stdin is gateway output,
  and child stderr is diagnostics only.
- Startup order is `runtime.ready`, `extension.manifest` compatibility, then
  `session.bootstrap(protocol_version=1)`. No turn may start first.
- Sidecar stderr retained by Node is at most 8 KiB and redacts secret-like
  assignments, bearer tokens, and API-key forms before display.
- Graceful close ends child stdin, waits two seconds, sends termination, waits
  two seconds, then performs one final kill. Close and final kill are
  idempotent.
- Production package exports and the `mycli` bin point only to compiled ESM and
  declarations under `dist`; production execution never requires `tsx`.

### 4. Validation & Error Matrix
- `--help` / `--version` -> exit `0`, no TTY check, no Python process.
- Normal TUI shutdown and sidecar exit `0` -> exit `0`.
- Sidecar crash, protocol close, readiness timeout, or internal lifecycle
  failure -> exit `1`, with no backend fallback or turn replay.
- Invalid CLI/backend/config, unavailable native Node backend, synchronous
  spawn failure, or missing protocol streams -> exit `2`.
- SIGINT before TUI ownership -> bounded cleanup and exit `130`.
- SIGINT after TUI ownership -> leave the first interrupt to the active TUI.
- SIGTERM -> request gateway shutdown and apply bounded sidecar escalation.
- Missing canonical manifest method/event or wrong schema version ->
  `incompatible_protocol` before session bootstrap.

### 5. Good/Base/Bad Cases
- Good: Configure the sidecar transport before dynamically importing
  `mycli-shell-tui/gateway`, then await its exported startup promise.
- Good: An abnormal Node exit synchronously kills the still-running child and
  a PID probe confirms no orphan remains.
- Base: `uv run mycli` remains the explicit Python-parent rollback path during
  M1.
- Bad: Spawn a separate TUI child that owns terminal input; this breaks Windows
  raw-TTY ownership and splits signal handling.
- Bad: Forward sidecar stderr into `GatewayClient`; a diagnostic line can then
  corrupt JSON-RPC framing or leak a credential.
- Bad: Retry a failed Node operation through Python; model requests and tool
  effects could be duplicated.

### 6. Tests Required
- Unit tests for POSIX/Windows command construction, piped streams, stable
  spawn errors, bounded redaction, completion codes, close escalation, and
  idempotent cleanup.
- CLI tests proving help/version do not spawn, TTY validation precedes spawn,
  transport configuration precedes TUI import, unavailable backends do not
  fall back, and exit codes follow the matrix.
- Handshake tests for ready timeout, schema mismatch, missing canonical RPCs,
  missing canonical events, and additive future manifest names.
- Real-process tests for timeout, crash before/after handshake, normal
  shutdown, SIGTERM escalation, stderr separation, and orphan PID cleanup.
- Build/package tests proving compiled help/version run without Python and
  `npm pack --dry-run` excludes source, fixtures, credentials, and local files.
- Run lifecycle tests on Node 22.19 across macOS, Linux, and Windows.

### 7. Wrong vs Correct

Wrong:
```typescript
const child = spawn("python3", args, { stdio: "inherit" });
await import("mycli-shell-tui/gateway");
```

Correct:
```typescript
const sidecar = startPythonSidecar({ cwd, env, args });
configureGatewayTransport(sidecar.transport);
const { gatewayStartup } = await import("mycli-shell-tui/gateway");
await gatewayStartup;
```

## Scenario: Atomic Node Session Resume

### 1. Scope / Trigger
- Trigger: Changes to Node `session.list`, `session.resume`, `session.tree`,
  `transcript.load`, session-scoped status projection, or turn acceptance.
- This boundary coordinates SQLite state preparation, runtime binding, and TUI
  visibility. A target session must never become partially visible.

### 2. Signatures
- `SessionCoordinator.resume(sessionId) -> Promise<ActiveSessionSnapshot>`
- `SessionCoordinator.markExecuting(context, executing) -> boolean`
- Gateway RPCs: `session.list`, `session.resume`, `session.tree`,
  `transcript.load`, and `turn.submit`.
- Gateway events: `session.changed`, `status.changed`, and
  `approval.request`.

### 3. Contracts
- Resume uses prepare/commit: load and validate transcript, queue, suspended
  approval, compaction state, continuation state, workspace, and runtime
  binding before incrementing the active generation.
- The coordinator holds a transition claim across the entire asynchronous
  prepare. A gateway turn must acquire the matching generation's execution
  claim before reserving a durable turn. Reservation failure releases the
  execution claim.
- Successful resume emits `session.changed` first, one complete
  `status.changed` snapshot second, then the pending `approval.request` when
  present. Failed preparation emits none of these target-session events.
- A readable snapshot without usable canonical SQLite state is display-only;
  `turn.submit` fails closed and the snapshot is never provider context.
- Legacy queue text arrays project pending steers as `queued_steering` and
  rejected steers plus ordinary follow-ups as `queued_follow_up`. Typed
  `queue_items` preserves separate `pending_steers`, `rejected_steers`, and
  `follow_ups` arrays.
- Runtime callbacks carry `{sessionId, generation}` and stale callbacks do not
  mutate or emit active-session TUI state.

### 4. Validation & Error Matrix
- Missing resume target -> `session_not_found`; do not create a session.
- Invalid or cross-session queue, suspended turn, approval, transcript, or
  continuation identity -> `session_state_invalid` with a fixed message.
- Unsupported persisted state version ->
  `session_state_version_unsupported` with a fixed message.
- Executing turn, concurrent resume, or turn submission during prepare ->
  `turn_in_progress` before a new reservation is written.
- Snapshot-only degraded session turn submission -> `session_state_invalid`.
- Same-session idle resume -> return the current generation without preparing
  or incrementing it.

### 5. Good/Base/Bad Cases
- Good: Claim transition, prepare target state, commit one generation, then
  emit the ordered target snapshot events.
- Good: Claim execution for the current generation, reserve the turn, and
  release the claim if reservation fails.
- Base: A configured but not-yet-persisted initial session is an empty virtual
  session and becomes durable on its first accepted turn.
- Bad: Check `executing` before `await prepare` but allow a turn to reserve
  during the await; the resumed generation can then replace a running source.
- Bad: Merge rejected steers into legacy steering text; the TUI displays a
  deferred input as if it can still steer the active turn.

### 6. Tests Required
- Pure coordinator tests for failed prepare, same-session idempotency,
  monotonic generation, stale context rejection, executing-turn rejection,
  and transition/execution mutual exclusion across an async prepare.
- Gateway tests for session catalog/tree/transcript responses, ordered resume
  events, sanitized state errors, read-only turn rejection, stale callback
  filtering, and no reservation during target preparation.
- Queue projection tests must assert legacy text arrays and counts plus all
  three typed `queue_items` arrays.
- Backend integration must use real SQLite state to prove target runtime
  rebinding, v1 snapshot import, invalid-state atomicity, and provider context
  sourced from the target's canonical conversation.

### 7. Wrong vs Correct

Wrong:
```typescript
if (!coordinator.executing()) {
  const prepared = await prepare(sessionId);
  coordinator.commit(prepared);
}
runtime.reserve(submission);
coordinator.markExecuting(context, true);
```

Correct:
```typescript
const resume = coordinator.resume(sessionId); // holds the transition claim

if (!coordinator.markExecuting(context, true)) {
  throw new GatewayFailure("turn_in_progress", "Session transition in progress.");
}
try {
  runtime.reserve(submission);
} catch (error) {
  coordinator.markExecuting(context, false);
  throw error;
}
```

## Scenario: Durable Node One-Time Approval Continuation

### 1. Scope / Trigger

- Trigger: Changes to Node tool approval policy, `approval.respond`, suspended
  tool batches, effect recovery, or the `pending_decision`, `suspended_turn`,
  `turn_record`, and `node_effect_checkpoint` SQLite state keys.
- This flow crosses tool policy, runtime orchestration, SQLite transactions,
  session-generation ownership, provider continuation, and TUI events.

### 2. Signatures

- Policy: `ApprovalPolicy.evaluate(call) -> ApprovalPolicyDecision`.
- Runtime: `ApprovalContinuationCoordinator.suspend(input)`, `pending()`,
  `resolve(input)`, `recover()`, and `finish(decisionId)`.
- Storage: `saveApprovalSuspension(input)`,
  `compareAndSetApproval(input)`, `commitApprovalResult(input)`,
  `interruptAmbiguousApproval(input)`, and
  `finalizeApprovalContinuation(input)`.
- Gateway RPC: `approval.respond` with `decision_id`, `choice`, optional
  `session_id`, and optional `generation`.
- Node M5 choices: `approve_once` and `reject` only.

### 3. Contracts

- `autoApproveMedium=true` remains the default Python-compatible behavior.
  Strict policy requests one-time approval for a valid workspace-local medium
  risk mutation and denies workspace escape before suspension.
- Persist the assistant tool-call batch before policy evaluation. When approval
  is required, atomically save `pending_decision`, `suspended_turn`,
  `turn_record`, and a `waiting` effect checkpoint before emitting
  `approval.request`.
- The tool call id is the stable `decision_id`. Gateway acceptance requires the
  active session, generation, backend binding, and decision id to match. A
  pending approval blocks ordinary `turn.submit` and `session.resume`.
- Approval transitions are monotonic: `waiting -> approved -> executing ->
  completed`. Persist `executing` before invoking a mutation. Append the tool
  result and move to `completed` in one SQLite transaction.
- Emit `tool.start` only after the `executing` claim is durable and immediately
  before router execution. A rejection or idempotent retry of an already
  completed checkpoint must not emit a false execution start.
- Rejection appends one model-visible `approval_rejected` tool result and moves
  directly from `waiting` to `rejected` without executing the tool.
- A completed or rejected checkpoint keeps its suspension payload until the
  runtime atomically finalizes the continuation before any later tool or
  provider IO. The original provider batch then resumes in order without
  reserving another turn or appending the original user message again. A crash
  after finalization explicitly interrupts the turn instead of replaying later
  calls from the old continuation.
- An orphaned `executing` checkpoint becomes an interrupted turn with
  `effect_outcome_unknown`. Commit the synthetic result and interrupted turn,
  then clear every continuation row including the effect checkpoint in the
  same transaction. The claimed mutation is never executed or recovered again.
- If asynchronous approval resolution fails while the continuation remains
  retryable, restore the same session snapshot, emit sanitized `gateway.error`,
  re-emit the same `approval.request`, then emit
  `status.update(state=waiting_approval)`. Do not emit terminal `turn.failed`
  for a turn that still owns durable pending approval state.

### 4. Validation & Error Matrix

- Missing pending approval, wrong decision id, stale generation, or wrong
  session -> `approval_not_pending`; do not mutate the checkpoint.
- Choice other than `approve_once` or `reject` -> `invalid_params`.
- A different response after a durable resolution -> `approval_conflict`;
  an identical response is idempotent and never repeats the tool effect.
- Malformed tool arguments, unsupported tools, or workspace escape -> policy
  denial; do not create a pending approval for an unsafe target.
- SQLite failure before a committed transition -> sanitized
  `persistence_error` at the runtime boundary and an actionable restored
  approval at the gateway/TUI boundary.
- Continuation finalization failure -> keep the turn running and the durable
  completed/rejected approval retryable; do not call `failTurn` or emit
  terminal turn failure.
- Restart with `waiting`, `completed`, or `rejected` -> restore the same
  continuation. Restart with `executing` -> interrupt with
  `effect_outcome_unknown` and execute zero tools.
- Ordinary turn submission or session resume while approval owns the session ->
  `turn_in_progress` before a new reservation or generation is created.

### 5. Good/Base/Bad Cases

- Good: Approve `Write`, commit its result once, execute later calls from the
  same provider batch in order, finalize the checkpoint, then continue the
  provider request.
- Good: A resolution persistence failure shows a bounded error and immediately
  restores the same actionable approval prompt.
- Base: Default policy auto-allows a workspace-local mutation and creates no
  approval continuation.
- Bad: Delete pending state before provider IO; a crash then loses the only
  safe continuation point.
- Bad: Retry an orphaned `executing` effect; the original mutation may already
  have reached the filesystem.
- Bad: Emit terminal `turn.failed` while restoring pending approval; the TUI
  clears the decision details and cannot perform the safe retry.

### 6. Tests Required

- Policy unit tests for default allow, strict request, escape denial, malformed
  calls, and bounded previews without content, hashes, or absolute paths.
- Runtime tests for approve, reject, identical/conflicting responses, multiple
  approvals in one batch, original-user dedupe, completed effect reuse, and
  interruption during claimed execution. Assert lifecycle start precedes the
  router call and lifecycle completion follows it.
- Storage tests proving suspension rows and tool-result/checkpoint commits roll
  back together at failpoints.
- Gateway tests for decision/session/generation ownership, pending-state
  exclusion, sanitized resolution failure, re-emitted approval, and absence of
  terminal failure while retry remains possible.
- Backend restart integration proving `executing` becomes
  `effect_outcome_unknown` without provider IO or tool replay, and a second
  restart finds no approval continuation to recover.
- Run tools, runtime, storage, app, M4 Node integration, and Python parity
  suites when this boundary changes.

### 7. Wrong vs Correct

#### Wrong

```typescript
await router.execute(call, { signal });
store.saveState({ key: "node_effect_checkpoint", payload: { status: "completed" } });
```

#### Correct

```typescript
store.compareAndSetApproval({
	sessionId,
	expectedStatus: "approved",
	transition: { type: "claim_effect", fingerprint },
});
const result = await router.execute(call, { signal });
store.commitApprovalResult({
	sessionId,
	expectedStatus: "executing",
	transition: { type: "complete_effect", resultCallId: result.callId },
	toolResult,
});
```

## Scenario: Recoverable Node Context Compaction

### 1. Scope / Trigger

- Trigger: changes to Node token accounting, compaction configuration, provider summary calls,
  compact checkpoints, file rehydration, or `compaction.*` gateway projection.
- This flow crosses config, runtime, provider, SQLite, file safety, gateway, and TUI boundaries.
  Raw history remains canonical; only provider conversation projection is replaced.

### 2. Signatures

- Runtime: `CompactionCoordinator.compact(input: CompactInput) -> Promise<CompactionResult>`.
- Summary adapter: `summarizeCompactionWithProvider(provider, config, input) -> Promise<string>`.
- Storage: `saveState(... compact_checkpoint ...)`, `loadHistoryItems(sessionId)`, and
  `commitCompaction({sessionId, replacementMessages, summary, checkpoint})`.
- Gateway events: `compaction.started` and `compaction.completed`.

### 3. Contracts

- `TokenCounter` uses `js-tiktoken` with `o200k_base`. Encoder initialization failure uses
  `ceil(ascii_chars / 4) + non_ascii_chars`, with zero for empty input and a bounded LRU cache.
- Node accepts the Python-compatible flat or sectioned compaction settings. In particular,
  `[memory].enabled` maps to `memory_enabled`, `[context]` owns compaction fields, and an empty
  user `compaction_l4_trigger_ratios_by_model` table falls through to the project table.
- The runtime commits queued steers before compaction. The reserved user history id and committed
  queue ids define the fresh suffix; the complete current turn is excluded from summary input.
- Before summary provider IO, persist an `in_progress` checkpoint with a deterministic request
  fingerprint. A completed checkpoint increments `window_number`; `history_item_count` is the raw
  durable history length, not provider-projection length.
- A successful compact uses one `commitCompaction()` transaction for replacement messages,
  summary, completed checkpoint, and Responses continuation invalidation. Raw history and rollouts
  are never deleted.
- Rehydration reuses the M4 real-workspace read policy, prefers successful Edit/Write/Patch paths
  over Read paths, excludes runtime state and plan prefixes, and enforces file count, item-token,
  total-token, byte, UTF-8, binary, and symlink bounds.
- `compaction.started` is published only after the trigger enters compaction.
  `compaction.completed` is published only after a successful compact commit or a minimum-savings
  skip. Summary and commit failures do not publish completion.

### 4. Validation & Error Matrix

- Non-finite, fractional, negative, or out-of-range compaction settings -> bounded
  `config_error` before provider IO.
- `compaction_token_limit > max_prompt_tokens` or rehydration item budget above total budget ->
  bounded `config_error`.
- Existing `in_progress` checkpoint -> delete the stale attempt, return `interrupted`, and send no
  summary request.
- Aborted summary request -> clear the current attempt, return `interrupted`, and do not continue
  the provider turn.
- Empty, over-budget, tool-calling, incomplete, or failed summary -> keep the prior provider
  projection and publish no completion event.
- `commitCompaction()` failure -> retain the durable `in_progress` checkpoint, keep the prior
  projection active, and publish no completion event.
- Provider `context_window_exceeded` before any event -> at most one reactive compact and retry;
  after text, reasoning, usage, or tool-call output -> no retry.

### 5. Good/Base/Bad Cases

- Good: persist the fingerprint, summarize only old turns, atomically install summary plus exact
  tail, rehydrate bounded current files, clear Responses continuation, then publish completion.
- Base: below-threshold context returns `not_needed` without checkpoint writes or lifecycle events.
- Good: a future user-initiated turn may start a new compact after an interrupted attempt, but the
  interrupted request itself is never replayed automatically.
- Bad: derive `history_item_count` from compacted provider items; Python replay would append raw
  history from the wrong offset.
- Bad: publish `compaction.completed` before SQLite commit; the TUI would display state that cannot
  survive restart.

### 6. Tests Required

- Config tests for Python defaults, sectioned memory/context fields, model-ratio precedence,
  finite ranges, threshold/window relation, and rehydration budget relation.
- Token tests against the fixed Python `o200k_base` corpus, fallback estimator, and LRU bound.
- Coordinator tests for fresh suffix exclusion, tail bounds, minimum savings, raw history
  preservation/count, window increment, provider summary validation, abort classification,
  stale in-progress recovery, commit failure, and secure bounded rehydration.
- Runtime tests for queue-before-compact ordering, config-per-turn coordinator creation,
  zero-event overflow retry, continuation invalidation, and no retry after provider output.
- Gateway tests must parse both lifecycle payloads through the canonical event validator.
- Run full Node build/test/lint/typecheck/contracts gates plus M4 Node/Python parity regressions.

### 7. Wrong vs Correct

#### Wrong

```typescript
const summary = await summarize(items);
emit({ type: "compaction_completed" });
store.saveConversation(replacement);
```

#### Correct

```typescript
store.saveState({ key: "compact_checkpoint", payload: inProgressCheckpoint });
const summary = await summarize(oldItems);
store.commitCompaction({
	sessionId,
	replacementMessages,
	summary,
	checkpoint: completedCheckpoint,
});
emit(completedEvent);
```

## Scenario: Validated Node Provider Continuation And HTTP Replay

### 1. Scope / Trigger

- Trigger: changes to Node provider request ordering, `responses_continuation_state`, model/tool
  request signatures, compaction invalidation, or terminal snapshot/memory/queue ordering.
- This flow crosses core request projection, runtime orchestration, SQLite session state, provider
  transport serialization, transcript snapshots, workspace memory, and gateway queue draining.

### 2. Signatures

- Core: `projectProviderRequest({history | fragments, config, instructions, tools})`.
- Runtime: `selectProviderContinuation(input) -> ContinuationDecision` and
  `ProviderContinuationCoordinator.recordSafeCompletion(input)`.
- State key: `responses_continuation_state` with `response_id`, `request_signature`,
  `request_input`, `response_output`, `eligible`, `failure_reason`, `session_id`, `protocol`,
  `model`, and `history_boundary`.
- Finalization callback: `writeTerminalSnapshot(turn) -> Promise<void>`.

### 3. Contracts

- Fragment projection order is compacted summary, retained tail, rehydration, transient memory,
  current user input, then committed steers. Tool calls and results keep canonical relative order.
- Memory is provider context only. It is not appended to canonical conversation/history or the
  transcript snapshot.
- Chat always uses canonical replay. A Responses continuation candidate requires an eligible,
  same-session state with a non-empty response id and exact request-signature, model, and
  turn-level history-boundary matches.
- The current OpenAI-compatible Responses HTTP adapter intentionally does not serialize
  `previous_response_id`. The deployed compatible endpoint reports that field as WebSocket-v2
  only, so HTTP requests replay canonical items even when runtime metadata identifies an eligible
  continuation. A future transport may consume the candidate only after an explicit capability
  contract and transport tests are added.
- Safe Responses completions persist continuation state before later tool execution or terminal
  turn persistence. State arrays are bounded to 4096 items.
- Completed and failed turns write the durable SQLite terminal state before the schema-v2
  transcript snapshot. Successful turns run explicit memory actions only after snapshot success;
  the gateway may then reserve and drain at most one queued input.

### 4. Validation & Error Matrix

- Chat protocol -> `canonical_replay/chat_replay`; never attach a response id to the request.
- Missing state -> `canonical_replay/missing_state`.
- Wrong root, missing required fields, cross-session state, or over 4096 request/output items ->
  persist ineligible `malformed_state`, then canonical replay.
- `eligible=false` -> canonical replay without reviving the prior response id.
- Signature, model, or history-boundary mismatch -> `canonical_replay/state_mismatch`.
- Compaction -> persist ineligible `compacted_history` before the next provider request.
- Terminal provider rejection or turn failure -> clear eligibility before terminal persistence.
- Snapshot failure after durable completion -> retain the completed SQLite turn, skip explicit
  memory actions, and do not attempt to fail the already completed turn.

### 5. Good/Base/Bad Cases

- Good: persist a matching Responses tool-batch continuation, execute and persist tool results in
  order, replay the canonical HTTP request, complete SQLite, write snapshot, apply explicit memory,
  then reserve one queued follow-up.
- Base: no persisted state produces one canonical request with current input exactly once.
- Good: malformed legacy state is made explicitly ineligible on first provider selection.
- Bad: send `previous_response_id` to a compatible HTTP endpoint that only supports it on
  Responses WebSocket v2.
- Bad: write memory into durable conversation history or start a queued turn before snapshot and
  memory finalization settle.

### 6. Tests Required

- Core tests assert fragment order, Responses/Chat item equivalence, current-input uniqueness,
  transient memory, and tool call/result order.
- Runtime tests assert exact continuation matching, malformed/oversized invalidation, Chat replay,
  provider rejection and compaction invalidation, approval snapshotting, and
  complete -> snapshot -> memory order.
- Backend integration uses real SQLite and a fake HTTP provider to assert no Python start,
  schema-v2 snapshot output, workspace memory composition, and complete continuation fields.
- Gateway queue tests assert reservation before removal and at-most-one terminal drain.
- Run core/runtime/app tests, M4 Node/Python parity, lint, typecheck, contracts drift, and build.

### 7. Wrong vs Correct

#### Wrong

```typescript
const body = {
	input: request.items,
	previous_response_id: persisted.response_id,
};
store.completeTurn(turn);
await memory.applyExplicitActions(message);
await snapshots.write(snapshot);
```

#### Correct

```typescript
const decision = selectProviderContinuation({
	protocol,
	persisted,
	requestSignature,
	model,
	historyBoundary,
});
const body = { input: canonicalItems }; // Compatible Responses HTTP replay.
const completed = store.completeTurn(turn);
const snapshotWritten = await writeTerminalSnapshot(completed);
if (snapshotWritten) await memory.applyExplicitActions(message);
```

## Scenario: M5 Cross-Backend Recovery Corpus And Fault Injection

### 1. Scope / Trigger

- Trigger: changes to M5 session state serialization, recovery ordering, SQLite transactions,
  transcript snapshots, workspace memory writes, or session generation commits.
- The parity gate spans Python and Node writers/readers. Fault injection must exercise the real
  owning store or coordinator instead of a duplicate test-only state machine.

### 2. Signatures

- Shared fixture: `tests/fixtures/node_runtime_m5/state_recovery_contract.json`.
- Node JSONL helper command: `{action, db_path, fixture_path}` where `action` is `write`, `read`,
  or `read_invalid`; each input line produces exactly one JSON array line.
- Runtime injection: `RuntimeFailpointHook = (name: RuntimeFailpoint) => void` on queue, approval,
  compaction, memory, and session coordinators. The default hook is a no-op.
- Storage injection: `SQLiteSessionStoreOptions.stateFailpoint(name)` covers reservation and
  transaction-internal state boundaries.

### 3. Contracts

- The four-way matrix is Python/Python, Python/Node, Node/Python, and Node/Node. Readers emit only
  normalized ids, ordering, counts, enum states, error codes, and preservation booleans.
- The shared corpus covers catalog/replay/summaries, pending and reconciled queues, waiting and
  legacy approval state, executing effects, completed compaction, ineligible Responses state,
  compatible unknown optional fields, malformed roots, and unsupported versions.
- A `*_before_*` failpoint fires before the durable operation and leaves no new durable state.
  A matching `*_after_*` failpoint fires after the durable operation but before in-memory
  publication or the next side effect.
- Reservation after-failure retains exactly one user and running turn; restart interrupts it
  without a provider replay. Queue after-save retains exactly one pending item without publishing
  the new revision in the crashed coordinator.
- Approval resolution and effect claim are separate durable boundaries. An approved checkpoint
  may retry the claim, while an executing checkpoint becomes `effect_outcome_unknown` and never
  invokes the tool again.
- A crash after a compaction summary response leaves the `in_progress` fingerprint durable. The
  next coordinator clears it as interrupted and sends no automatic summary request.
- Memory topic/index failpoints leave the atomically renamed topic discoverable through `scan()`
  without claiming an index entry that was not durably written.
- Session prepare failure keeps the source generation active. Session commit failure may expose
  the committed target generation, and same-session retry remains idempotent.

### 4. Validation & Error Matrix

- Malformed persisted root -> `session_state_invalid`; do not return a partial normalized case.
- Unsupported compact state version -> `session_state_version_unsupported` in both readers.
- Node helper emits zero or multiple JSONL rows -> helper protocol failure.
- Failure before reservation/save/prepare -> zero new durable records and no publication.
- Failure after effect claim -> one `effect_outcome_unknown` result, zero tool retries.
- Failure after tool result append inside its SQLite transaction -> roll back result and
  checkpoint together, then recover one unknown result.
- Failure before snapshot rename -> prior complete snapshot remains readable.

### 5. Good/Base/Bad Cases

- Good: inject after queue save, reopen from the durable snapshot, and observe one pending record
  with no pre-crash publication.
- Good: write compatible unknown fields in Python, read them through Node, and report only a
  `preserved=true` structural assertion.
- Base: with no failpoint callback, normal runtime behavior and event ordering are unchanged.
- Bad: catch an injected crash as an ordinary summary failure and delete its in-progress
  checkpoint; restart could resend an already completed provider request.
- Bad: print raw state, prompt, provider output, memory content, endpoint, or credentials from the
  parity helper.

### 6. Tests Required

- Pytest must run the four writer/reader directions and both invalid-state readers against the
  shared sanitized fixture.
- Storage tests assert before/after reservation, queue history/removal rollback, approval
  suspension/result rollback, compact rollback, orphan interruption, and one synthetic unmatched
  tool result.
- Runtime tests assert queue publication ordering, approval/effect recovery, filesystem-commit
  ambiguity, no compaction-summary replay, snapshot rename preservation, memory topic/index
  recovery, and session generation isolation.
- Run `uv run pytest tests/integration/test_node_runtime_m5_parity.py -q`, storage/runtime package
  tests, lint, typecheck, contracts drift, and the M4 regression gate.

### 7. Wrong vs Correct

#### Wrong

```typescript
const summary = await summarize(input);
try {
	failpoint("compaction_after_summary_request");
} catch {
	store.deleteState(sessionId, "compact_checkpoint");
}
```

#### Correct

```typescript
const summary = await summarize(input);
failpoint("compaction_after_summary_request"); // Keep in_progress on injected crash.
store.commitCompaction({ sessionId, summary, replacementMessages, checkpoint });
```
