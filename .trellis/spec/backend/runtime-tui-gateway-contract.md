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
  - `tool.start`
  - `tool.progress`
  - `tool.complete`
  - `tool.failed`
  - `message.delta`
  - `message.complete`
  - `reasoning.delta`
  - `thinking.delta`
  - `turn.completed`
  - `turn.failed`
  - `turn.interrupted`
  - `turn.status`
  - `gateway.error`
  - `session.changed`
  - `status.changed`
- TypeScript reducer entry point:
  `reduceShellState(state: ShellState, action: ShellAction) -> ShellState`
- Scripted smoke state dump:
  `MYCLI_NODE_TUI_STATE_DUMP=/path/to/state.json node tui/node/src/index.js`

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
- `approval.respond` request payload:
  - `decision_id`: must match the active decision id. The compatibility alias
    `decision_current` remains accepted for older clients while one decision is
    pending.
  - `choice`: preferred Hermes-like choice string, such as `approve_once`,
    `reject`, or `allow_session`
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
- `turn.completed` must include `turn_state`. A response with
  `pending_decision` maps to `waiting_approval`; a turn record with
  `WAITING_CLARIFICATION` maps to `waiting_clarification`; a turn record with
  `REJECTED` maps to `rejected`; otherwise it maps to `completed`.
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
  - `turn.status(state=interrupted)` currently reports that an interrupt was
    requested; it does not guarantee that the running worker stopped before a
    later terminal event.
  - Runtime finalization of interrupted turns records local `turn_interrupted`
    trace/log diagnostics after suspended state is saved. This is not a gateway
    stream event.
- `gateway.error` payload:
  - `code`: stable short error code, for example `internal_error`
  - `message`: bounded user-facing error text
  - `detail`: optional bounded diagnostic detail
  - `method`: optional JSON-RPC request method that triggered the error
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
  - `runtime.ready` is not mirrored in this slice because it is emitted outside
    the runtime event boundary during process bootstrap.
- Tool lifecycle notifications come from real tool execution, not model-side
  tool-call request streaming:
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
  - Gateway `session.resume` must emit `session.changed` first, then a
    `status.changed` snapshot for the same active session so clients clear or
    retain pending state based on the resolved session tip.
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
- Node TUI `test` and `typecheck` commands must run `npm run verify:deps`
  first, so missing or partially installed `tui/node/node_modules` produces an
  actionable dependency message before `tsx` is imported.

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
