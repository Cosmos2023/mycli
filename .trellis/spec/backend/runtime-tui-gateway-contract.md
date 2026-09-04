# Runtime TUI Gateway Contract

> Contract for Node runtime events consumed by the Node TUI.

## Scenario: Durable Workspace Trust

### 1. Scope / Trigger
- Trigger: changes to the TUI trust or permission selectors, `workspace.trust.*`
  or `permissions.*` RPCs, Node runtime bootstrap/status payloads, workspace
  trust persistence, or provider-visible process-tool exposure.
- Trust is runtime-owned durable state. The TUI must not treat its local footer
  state as proof that a workspace is trusted.

### 2. Signatures
- Request: `workspace.trust.set({state})`
- Query: `workspace.trust.status({})`
- Request: `permissions.update({profile})`
- Query: `permissions.list({})`
- Notification: `workspace.trust.changed({state, workspace, source, enforced})`
- Node store:
  `WorkspaceTrustStore.load(workspaceRoot) -> Promise<WorkspaceTrustState>`
- Node store:
  `WorkspaceTrustStore.save(workspaceRoot, state) -> Promise<void>`
- Runtime policy:
  `configureExecutionPolicy({trust, permission}) -> void`
- Approval policy:
  `ApprovalPolicy.evaluate(call, frozenExecutionPolicy) -> decision`
- Turn policy:
  `ExecutionPolicyCoordinator.beginTurn(turnId) -> {toolsEnabled, profile}`
- TUI callback:
  `onTrustSelect(trusted: boolean) -> void | Promise<void>`

### 3. Contracts
- `state` is exactly `trusted`, `untrusted`, or `unknown`.
- Node decisions live under `~/.mycli/trust/`, keyed by the SHA-256 digest of
  the canonical workspace path. Do not store a trust decision in the workspace
  itself because repository content is inside the boundary being evaluated.
- Stored records contain schema version, canonical workspace, and decision.
  They are written through a mode-`0600` temporary file and atomic rename.
- Permission profile is exactly `read-only`, `workspace`, or `full-access`.
  Bootstrap, status, and `permissions.list` expose the active profile, all
  three selector rows, and the bounded session command-allowance count.
- Node bootstrap and status payloads expose `source: user_store` when the user
  store is configured. `enforced=true` means the active Node binding has the
  execution-policy coordinator and enforces trust for process-tool exposure;
  it does not claim that every non-process mutation has become read-only.
- The gateway configures the runtime after initial trust load, after successful
  trust or permission updates, and after loading trust for a resumed session.
- A trusted workspace plus a valid permission profile exposes `Shell` and
  `WriteStdin`. Unknown/untrusted workspace state or missing/invalid permission
  state keeps process tools out of the provider request.
- A turn calls `beginTurn(turnId)` once and reuses that immutable profile and
  tool list for every provider step and approval continuation. A later trust or
  permission update affects the next turn only. Terminal completion releases
  the frozen turn; a waiting approval retains it.
- The frozen provider tool list gates adapter execution. A provider call for an
  unexposed tool is persisted as a bounded failed tool result with
  `errorKind=unsupported_tool` before approval, hooks, or adapter execution, and
  the provider loop may recover on its next step instead of terminating with a
  fatal `tool_protocol_error`.
- Permission mapping is fixed: `read-only` uses read-only filesystem and no
  network/writable roots; `workspace` uses workspace-write with the canonical
  workspace writable and no network; `full-access` uses explicit
  danger-full-access with unrestricted filesystem and network.
- `full-access` skips routine approval only after valid tool parsing and
  explicit exec-policy `deny` / `ask` / `allow` evaluation. It auto-allows
  otherwise-unmatched valid Shell segments, known request-policy extensions,
  and valid file mutations inside or outside the workspace. Explicit `deny`
  remains denied; explicit `ask` becomes denied because full access never
  surfaces routine approval prompts.
- The frozen turn execution policy controls both approval and adapter path
  resolution. Full access permits outside `Read`, `Write`, `Edit`, `Patch`, and
  Shell `cwd`; workspace and read-only profiles retain workspace confinement.
- Workspace trust remains an independent precondition for process-tool
  exposure. Clarification and provider authentication are interactive flows,
  not routine security approvals, and `full-access` must not suppress them.
- The TUI waits for `workspace.trust.set` to succeed before mounting the main
  interface. Only `trusted` dismisses the startup gate. Persisted `untrusted`
  remains gated because Node mutation tools do not yet enforce a read-only
  untrusted mode.
- Session resume reloads trust for the resumed workspace before publishing its
  status snapshot; a decision from one workspace must never carry into another.

### 4. Validation & Error Matrix
- Missing or unsupported `state` -> JSON-RPC `invalid_params`.
- Missing trust record -> `unknown`.
- Missing/invalid runtime policy configuration -> no process-tool exposure.
- Unsupported permission profile -> JSON-RPC `invalid_params`; preserve the
  prior active profile and do not reconfigure the runtime.
- Malformed arguments or an unknown tool under `full-access` -> deny. An
  explicit exec-policy `deny` or `ask` -> deny without an approval request.
- Unknown or untrusted workspace with `full-access` -> keep process tools
  unexposed; permission selection must not promote workspace trust.
- Invalid JSON, schema, state, workspace mismatch, or unreadable record ->
  `unknown` (fail closed).
- Workspace canonicalization failure during load -> `unknown`.
- Workspace canonicalization or atomic write failure during save -> reject the
  RPC; do not update in-memory trust, keep the gate mounted, and show a stable
  error without raw filesystem details.
- Restricted Shell profile with a missing platform wrapper or unsafe protected
  metadata symlink -> `sandbox_unavailable` before transport start.

### 5. Good/Base/Bad Cases
- Good: choose Trust once, restart the same workspace, and enter the main TUI
  without another prompt.
- Good: submit while trust is unknown and send only file tools; set trust to
  trusted and expose `Shell`/`WriteStdin` on the next provider request.
- Good: switch an active turn from workspace to full access and keep the
  already-frozen workspace sandbox for that turn.
- Good: select `full-access` in a trusted workspace and run a valid unmatched
  Shell command without emitting `approval.request`.
- Good: use full access to Read then Patch an outside file; retain snapshot and
  stale-read validation without exposing the absolute path in mutation output.
- Base: a new workspace returns `unknown` and renders the trust selector.
- Bad: write `.mycli/config.toml` inside a repository to mark that repository
  trusted.
- Bad: dismiss the gate before the runtime confirms durable persistence.
- Bad: let persisted `untrusted` expose process tools in a Node provider request.
- Bad: treat provider tool schemas as the only authorization boundary and route
  an unexposed `Shell` call returned by the provider to an adapter; persist the
  bounded `unsupported_tool` result and let the model recover instead.
- Bad: implement `full-access` ahead of explicit exec-policy evaluation or use
  it to bypass malformed-call validation, workspace trust, clarification, or
  provider authentication.

### 6. Tests Required
- Config unit test: unknown, trusted round trip, corrupted record fail-closed,
  untrusted round trip, and unknown revocation; assert no workspace-local state.
- TUI unit test: callback is invoked and the main interface remains unmounted
  until the returned promise resolves; rejection keeps the gate mounted and
  renders a bounded error without the raw exception.
- Reducer unit test: trusted dismisses the gate; untrusted and revoked states do
  not.
- Node integration test: set trusted, close the backend, create a new backend
  with the same home/workspace, and assert bootstrap reports trusted.
- Runtime unit tests: fail-closed initial coordinator state, immutable turn
  profile across reconfiguration, terminal release, and persistence of an
  `unsupported_tool` result for an unexposed provider call before execution.
- Approval policy tests: workspace requests an unmatched routine Shell command;
  `full-access` allows it and a known request-policy extension, while explicit
  `ask` / `deny`, malformed arguments, and unknown tools are denied without a
  prompt.
- Tool tests: full access permits outside Read/Write/Edit/Patch and Shell cwd;
  restricted policies keep rejecting traversal, absolute escape, and symlink
  escape. Outside diffs and receipts remain path-safe.
- Runtime/backend integration: `permissions.update(full-access)` reaches the
  approval policy and a real PTY turn completes with zero `approval.request`
  events.
- Gateway tests: permission list/update payloads, invalid-profile rejection,
  trust reconfiguration, and complete permission state in bootstrap/status.
- Backend integration: compare provider tool names before and after durable
  trust and assert only the later turn receives `Shell`/`WriteStdin`.
- Tool tests: exact permission mapping, secret-free environment diagnostics,
  fixed platform wrapper argv, protected metadata, and missing-wrapper failure
  before manager/transport start.
- Real PTY smoke: first launch saves Trust; second launch skips the selector and
  terminal shutdown restores cursor/input modes.

### 7. Wrong vs Correct
#### Wrong
```typescript
onSelect: () => patchFooter({ trust: "trusted" });
```

#### Correct
```typescript
onSelect: async () => {
	await gateway.send("workspace.trust.set", { state: "trusted" });
	mountMainInterface();
};
```

#### Wrong
```typescript
const decision = approvalPolicy.evaluate(call);
```

#### Correct
```typescript
const decision = approvalPolicy.evaluate(call, context.executionPolicy);
```

The runtime passes the coordinator's frozen turn profile to approval evaluation
and tool execution. A later permission change does not affect a running turn.

## Scenario: Approval And Live Status Events

### 1. Scope / Trigger
- Trigger: Any change to the Node runtime gateway, TUI protocol types, or reducer state that
  changes runtime-to-TUI events.
- This is a cross-layer contract. The Node gateway owns runtime semantics and JSON-RPC emission;
  the TUI owns rendering and reducer state.
- The target direction is Hermes-like channel separation, but existing mycli
  JSON-RPC method-name notifications remain compatible until a versioned
  envelope migration is introduced.

### 2. Signatures
- Node event emitter: `NodeGateway.#emitRuntime(method, params) -> void`.
- Extension discovery request method: `extension.manifest`
- Session bootstrap request method: `session.bootstrap`
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
  - `message`: optional bounded detail for exceptional state transitions such
    as an interrupt request. Provider failure diagnostics belong exclusively to
    `turn.failed` and must not be repeated here.
  - `severity`: optional string for future warning/error display
- `turn.completed` may include authoritative `duration_ms`, measured from the
  persisted turn's `started_at` through `completed_at` and bounded to 24 hours.
  The same completion transaction appends one model-hidden `turn_completed`
  display item containing only the bounded numeric duration. Live events and
  `transcript.load` use the same stable turn-derived item id, so the TUI renders
  one static `✻ <completion phrase> ...` row separated from the preceding
  transcript by one blank row. The phrase is selected deterministically from a
  small approved set using the stable item id, so turns vary without flickering
  or changing after resume. Older gateways may fall back to the local running
  timer; replay never recalculates elapsed time from wall-clock timestamps.
- `approval.request` payload:
  - `decision_id`: stable string for the pending approval. Prefer the source
    tool call id when present; fall back to `decision_current` only when no
    stable call id exists.
  - `client_turn_id`: string for the turn that produced the approval request
  - `preview`: human-readable operation preview
  - `reason`: optional human-readable rationale
  - `tool_name`: optional tool name
  - File mutation requests may also carry either `content_preview`, `content_line_count`,
    `content_chars`, and `content_truncated` for `Write`, or `diff`, `diff_chars`, and
    `diff_truncated` for `Edit` / `Patch`. Runtime uses camel-case internally; the gateway owns the
    canonical snake-case projection. These fields describe the proposal and arrive before tool
    execution so the selector can render the exact change being approved.
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
  - `turn_id`: stable turn id used to cancel the suspended clarification with
    `turn.interrupt`
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
  - `turn_id`: stable owning turn id.
  - `request_id`: the resolved clarification request id.
  - `header`: optional bounded short label copied from the request.
  - `question`: bounded question text copied from the request.
  - `response`: bounded user response for the durable TUI transcript block.
  - `multi_select`: boolean copied from the request.
- `turn.completed` must include `client_turn_id`, `assistant_message`,
  `activity_events`, `progress_updates`, `plan_steps`, `pending_decision`,
  `turn_state`, and `usage`. A response with `pending_decision` maps to
  `waiting_approval`; a turn record with `WAITING_CLARIFICATION` maps to
  `waiting_clarification`; a turn record with `REJECTED` maps to `rejected`;
  otherwise it maps to `completed`.
- `stream.retrying` is transient status, not transcript. It carries bounded
  `attempt`, `max_retries`, delay, failure kind, and optional sanitized
  `additional_details`. A structured upstream `error.message` may appear only after control/stack
  removal, credential redaction, and length bounding; raw provider exception messages,
  response bodies, and stacks must not cross into TUI text.
- Stable Provider failure kinds distinguish credentials/policy, caller
  correction, transport/stream, service health, and account throttling. In
  particular, `connection_error` before output and `response_stream_error`
  after output remain separate so clients can explain recovery without parsing
  human text. `server_overloaded` remains retryable, while `quota_exceeded` is
  terminal and must not be rendered as a transient rate limit.
- Retry status text is taxonomy-driven: connection and response-stream recovery
  use `Reconnecting...`; overload, rate-limit, and other retryable failures use
  `Retrying...`. Gateway and TUI code must not infer this distinction from the
  rendered failure message.
- A terminal failed turn appends exactly one model-hidden `error` display item
  with a stable turn-derived id and canonical public text in the same storage
  transaction as terminalization. The main text remains concise; the same
  sanitized Provider context shown while retrying is stored separately as
  `additional_details`. Live events and `transcript.load` render the same item,
  while duplicate terminal notifications remain idempotent.
- `backend/packages/contracts/src/runtime-errors.ts` is the canonical taxonomy
  and public-message module. It also owns the exhaustive optional recovery-hint
  mapping. Provider, runtime, Worker RPC, storage, gateway, and TUI code must
  not maintain separate runtime error-code lists, fallback message switches, or
  hint maps.
- `gateway.error` is request-scoped. It may add a bounded error notice but must
  not terminalize an otherwise active turn; `turn.failed` owns terminal state
  and closes foreground tools still shown as running.
- TUI-facing error text is bounded, strips terminal controls and stack frames,
  redacts credential-shaped values, rejects failure text without the expected stable
  taxonomy prefix, and never includes raw Node internals.
- A fatal custom-TUI render error restores terminal ownership before shutdown
  and writes only a private redacted diagnostic record to
  `~/.mycli/logs/tui-errors.log`; transcript content is not copied there.
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
  - `plan.items`: structured ordered rows with `id`, `text`, and `status`.
  - `explanation`: optional bounded explanation supplied to `update_plan`.
  - `completed` and `total`: bounded task counts derived by the gateway.
  - `source`: optional short source label, normally the tool name that updated
    the plan.
  - The runtime emits this event only after the successful `update_plan` result
    and model-hidden `plan_update` history item commit atomically. The TUI appends
    an immutable plan item and derives its compact progress indicator from the
    latest item; it does not mutate an active-plan panel in place.
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
  - `message`: optional interruption or rejection detail. Provider failure
    diagnostics belong exclusively to `turn.failed`.
  - Existing terminal method-name events remain the compatibility path. The
    gateway emits the existing event first, then `turn.status`, then
    `status.update` where applicable.
  - `turn.interrupted`, `turn.status(state=interrupted)`, and the matching
    `status.update(state=interrupted)` must include the active
    `client_turn_id` when a turn is running, so Node scripted smokes and future
    clients can correlate the interrupt with the active turn. The status
    payloads should include a bounded `message` such as `Interrupt requested`.
  - `turn.status(state=interrupted)` is emitted only after the runtime has
    durably finalized the turn as interrupted. It is proof of the terminal
    runtime state, not merely proof that a cancellation signal was sent.
  - The TUI may optimistically render a local `interrupting` status immediately
    after Ctrl+C/Escape, but it must keep the turn busy and must not restore the
    composer, terminalize transcript items, or dispatch queued input until the
    confirmed `turn.interrupted` event arrives.
  - `turn.interrupt` requires the expected active `turn_id`. A mismatch returns
    `turn_id_mismatch` with the current `actual_turn_id`; the TUI may retry once
    for a lifecycle-notification race.
  - If the TUI believes a turn is active but has no local `turn_id`, it must
    recover the authoritative `turn_running` and `turn_id` through
    `status.inspect` before sending `turn.interrupt`. If the inspected status is
    idle or still has no `turn_id`, the TUI must clear its optimistic interrupt
    state and must not send an incomplete interrupt request.
  - The accepted `turn.interrupt` RPC aborts the active controller, waits up to
    100 ms for cooperative runtime settlement, and then invokes the runtime's
    forced interruption boundary. That boundary atomically closes pending tool
    results, persists the interrupted turn, writes the terminal snapshot, and
    fences all late completion writes before the gateway emits terminal events.
  - When a clarification owns a suspended turn, the gateway reconstructs the
    owning turn from the pending clarification, clears its continuation before
    finalization, and applies the same durable interrupted-turn boundary. The
    coordinator snapshot must also clear `pendingClarification` before the
    authoritative `status.changed` event so the TUI does not remount the
    selector.
  - The interrupt RPC response remains pending until the confirmed terminal
    interruption has been emitted. Multiple matching interrupt requests share
    the same in-flight interruption and resolve from the same terminal result.
  - A force-finalized in-process Promise may still unwind after the gateway has
    released the active turn, but its callbacks are generation/turn fenced and
    its storage writes cannot replace the terminal interrupted record.
  - A tool that emitted `tool.start` must emit exactly one terminal lifecycle
    event before turn finalization. Abort uses `tool.failed` with
    `error_kind=tool_interrupted`. A claimed approval effect whose outcome
    cannot be proven uses `effect_outcome_unknown` instead.
  - Storage closes every interrupted pending canonical tool call with a
    synthetic failed result using `error_kind=tool_interrupted`; ordinary turn
    failures continue to use `tool_result_unavailable`.
  - The same interrupted-turn storage transaction appends exactly one
    model-hidden `warning` display item with a stable turn-derived id and the
    canonical interrupted-turn notice. The separate `turn_aborted` context
    marker remains model-visible and hidden from readable transcript projection.
  - Live interruption and `transcript.load` resume projection render that
    display item through the ordinary warning row. Repeated terminal events or
    targeted recovery must not duplicate it.
  - Readable projection also synthesizes the same warning for historical turns
    that have an interrupted lifecycle or rollout but predate the display item.
    This compatibility projection is read-only and must deduplicate a newer
    persisted warning for the same turn.
  - Readable pagination keeps the model-visible `turn_aborted` context marker
    in its adjacent interrupted-turn group even though the marker has no
    `turn_id`; complete, recent, and paged projections must produce the same
    single warning.
  - TUI reducers defensively terminalize any foreground tool still marked
    `running` when a terminal interruption arrives. Detached background shell
    sessions remain running and continue through their own lifecycle.
  - `turn.interrupt` returns `accepted=false`, `requested=false`, plus an
    authoritative status snapshot when no active turn exists. TUI clients must
    clear optimistic interrupt state and must not render a success notice for
    that rejected request.
  - `rollback_user_input` never deletes or rewrites canonical conversation,
    history, or rollout rows. `input_rolled_back=true` is a compensating UI
    acknowledgement that the output-free submitted text may be restored to the
    composer; it is denied after visible assistant, reasoning, tool, approval,
    or clarification activity.
  - A second Ctrl+C within two seconds remains an explicit process-exit path.
    It is independent from the 100 ms forced persistence fence and does not
    claim that an externally committed side effect was reversed.
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
    `turn_in_progress`, `session_changed`, `decision_not_pending`, or
    `clarification_not_pending`, or `incompatible_protocol`
  - Canonical gateway contracts own the source taxonomy. The TUI exposes the matching
    `GATEWAY_ERROR_CODES` runtime constant and `GatewayErrorCode` type from
    `tui/mycli-shell/src/adapters/gateway-client.ts`; tests compare it with the generated schema.
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
  - Gateway code constructs this payload through the canonical event contract rather than
    duplicating incompatible local object shapes.
  - Existing method-name notifications remain the primary compatibility path.
    The gateway emits them unchanged and then emits the envelope mirror.
  - `runtime.event` must not recursively wrap another `runtime.event`.
  - `runtime.ready` is a canonical direct event whose payload requires
    `session_id`. It is not mirrored in this slice because it is emitted
    outside the runtime event boundary during process bootstrap.
- Tool lifecycle notifications come from real tool execution, not model-side
  tool-call request streaming:
	- A validated `Write`, `Edit`, or `Patch` proposal emits
	  `item.started(item.type=file_change)` before either `approval.request` or
	  `tool.start`. The item carries the stable call id, bounded target preview,
	  bounded compatibility `content_*` or `diff*` fields, and canonical
	  `file_changes[]` entries with snake-case diff metadata. Approval and
	  `full-access` execution use the same begin item; only the approval route
	  mounts the bottom selector.
	- A valid structured proposal projects directly to the file-change component:
	  `Added/Edited <path> (+N -M)` followed by the numbered diff. It must not
	  render a generic `Write/Edit/Patch <duration>` card, a raw-content detail
	  block, or a `details hidden` footer. The global tool-detail toggle never
	  hides file diffs.
	- The proposal item is a live TUI projection. It is not persisted as a
	  transcript row and is not reconstructed on resume. Later `tool.start`,
	  `tool.complete`, or `tool.failed` updates the same TUI row by call id.
	  Completion replaces the proposal with the canonical result `file_changes`;
	  rejection/failure replaces it with one bounded failed-change row.
  - Every started, completed, or failed tool remains represented in the TUI
    transcript in `default`, `focus`, and `verbose` modes. View modes may change
    history scope and detail density, and consecutive context tools may collapse
    into an expandable summary, but they must not hide a tool execution.
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
  - Node protocol code must keep a machine-readable `GATEWAY_EVENT_PAYLOAD_CONTRACTS` map whose
    required fields, known property names, and enum values match the canonical gateway-event schema
    for every known event method. Contract tests catch schema/declaration drift before runtime.
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
    `used_tokens` comes from the latest completed provider step's persisted
    `last_token_usage` (`input_tokens`, falling back to `total_tokens`), not from the
    turn's cumulative `usage`. `/usage` continues to aggregate the cumulative field.
    Legacy rollouts without `last_token_usage` remain readable with
    `source=provider_aggregate` so clients do not mistake that fallback for an exact
    active-context measurement.
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
  - After a process restart, `session.bootstrap(protocol_version=1)` must also
    re-emit the active persisted `approval.request` with its stable
    `decision_id`, session id, and generation before returning the bootstrap
    result. The earlier compatibility `initialize` request must not re-emit the
    same prompt, so the normal startup handshake exposes one actionable
    approval rather than two.
  - Restart and `session.resume` projection must not derive mutation detail from the pending
    canonical tool call. Re-emitted approvals retain identity, path preview, reason, and choices but
    omit `content_*` and `diff*`, keeping recovered TUI transcript metadata compact without adding
    preview columns or fields to durable session state.
- Running-turn queue RPCs:
  - `turn.steer` accepts `{message, expected_turn_id, client_turn_id?,
    client_user_message_id?, local_images?, session_id?, generation?}`. A matching active turn produces
    `pending_steer`; a stale or no-longer-active target produces a durable
    `rejected_steer` for the next server turn instead of losing the input.
  - `turn.follow_up` accepts `{message, client_turn_id?,
    client_user_message_id?, local_images?, session_id?, generation?}` and may race terminal completion.
    Once accepted, it remains durable until a later turn reservation succeeds.
  - `turn.queue.pop` removes only the newest ordinary follow-up and returns the
    removed structured item plus the new revision.
  - `turn.queue.clear` accepts `{restore_token, session_id?, generation?}` and atomically claims the
    returned steering and follow-up messages for composer restoration. It does not delete them.
  - `turn.queue.restore.ack` accepts the same `{restore_token, session_id?, generation?}` only after
    composer restoration and retires exactly the matching claims. Unacknowledged claims return to
    `queued` during session activation or process recovery.
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
  `turn.queue.clear`, `turn.queue.restore.ack`, and `turn.queue.migration.ack`.
- Runtime: `QueueCoordinator.enqueueSteer()`, `enqueueFollowUp()`,
  `commitPending(turnId)`, `rejectPending(turnId)`,
  `prepareInterruptedSteers(turnId)`, `next()`, `claim(queueId, turnId)`,
  `releaseClaim(queueId, turnId)`, `retireClaim(queueId, turnId)`, and
  `reconcileClaim(queueId, turnId)`, plus `claimForRestoration(token)`,
  `acknowledgeRestoration(token)`, and `releaseRestorationClaims()`.
- Storage:
  `SessionStore.saveQueueSnapshot({sessionId, workspaceRoot, threadId, snapshot}) -> QueueSnapshot`
  and
  `SessionStore.commitQueuedInputs({sessionId, turnId, records}) -> QueueSnapshot`.
- Queued turn reservation:
  `reserve({clientTurnId, clientUserMessageId, turnId, queueId, inputSource, ...}) -> TurnReservation`.
- User interrupt response may include:
  `pending_steers_resubmitted=true` and
  `resubmitted_client_user_message_ids: string[]` when the backend durably prepared the accepted
  steers for one immediate next turn.
- TUI session input ownership is split between reducer snapshots for optimistic input and shell
  snapshots for the draft, local image descriptors, last submitted input, activity signature, and
  Enter-to-`turn.started` pending state.

### 3. Contracts

- Every mutation increments a safe integer revision exactly once. A duplicate
  lost-response retry with the same `client_turn_id` and payload returns the
  existing record/revision without another write or event.
- The first persisted snapshot for a session must have revision one. Later
  writes accept only an identical idempotent payload or exactly `current + 1`.
- Persist the candidate before replacing the in-memory snapshot, emitting
  `turn.queue.updated`, or returning RPC success.
- The backend queue is the only dispatch authority. TUI local arrays are an optimistic projection
  and recovery copy; they must never form a second queue that independently races the backend.
- A queue RPC ACK proves that the backend persisted the input. The TUI may replace its optimistic
  row with the identity-matching durable preview, but the queued intent remains visible until a
  matching committed user item, explicit queue removal, or interrupt restoration proves the next
  lifecycle transition.
- Before every provider request, atomically append matching pending steers to
  canonical conversation/history and remove them from `input_queue` by
  `queue_id`; then reload canonical provider history.
- After that durable commit, publish `item.started` and `item.completed` for
  every visible committed steer before the next provider request. Reuse the
  queue record `clientTurnId` as `client_user_message_id` and the durable
  history item id as the lifecycle item id so direct/mirrored event dedup keeps
  one user transcript row and clears the matching optimistic pending preview.
- On normal completion and failure, persist remaining matching accepted steers as
  `rejected_steer` before the terminal event, then invoke the common idle scheduler.
- A user interrupt with accepted steers atomically merges only those steers, in input order, into
  one priority `rejected_steer`. It reuses the first queue/client identity, joins text with a blank
  line, concatenates image paths, and rebases each message-local `[image #n]` placeholder into the
  merged attachment order. Existing rejected steers and follow-ups remain behind it.
- Publish the merged `turn.queue.updated` revision before `turn.interrupted`. Return
  `pending_steers_resubmitted=true` plus every consumed client user-message id only after the
  durable merge. The common terminal release then schedules exactly that one merged turn.
- A user interrupt without a prepared steer does not auto-drain rejected steers or follow-ups.
  After the terminal interrupt RPC confirms, the TUI calls `turn.queue.clear` with a unique
  `restore_token`. The backend atomically claims the returned records for restoration instead of
  deleting them; restoration claims are omitted from visible queue projections. The TUI applies
  the authoritative revision, merges the returned structured records with any unacknowledged local
  copies by identity, restores them in `rejected -> pending -> follow-up` order, and only then calls
  `turn.queue.restore.ack` with the same token to retire those records. If the client exits before
  ACK, session activation or process recovery releases the orphan restoration claims back to
  `queued`, so accepted input remains recoverable.
- Runtime-originated interruption without a TUI restoration owner may continue the durable queue;
  user-requested interruption is distinguished by the active turn's latched interrupt disposition.
- After a dispatchable terminal transition, inspect at most one rejected steer/follow-up. Reuse
  its `clientTurnId` as the reservation idempotency key, persist a `claimed` queue record tied to
  the proposed turn id, then atomically reserve the turn with `queueId` and `inputSource`.
- After reservation succeeds, retire the exact matching claim and publish `item.started` and
  `item.completed` for the queued turn before provider IO. Reuse the queue
  record `clientTurnId` as `client_user_message_id`; project a rejected steer
  with `source=steer` and an ordinary follow-up with `source=submit`. This
  lifecycle lets the TUI render the user input once and clear its matching
  optimistic queue entry.
- If reservation returns an existing turn, reconcile the claim against canonical committed
  `queue_id` metadata. Retire a committed claim without executing the turn again; otherwise release
  it back to `queued`. On restart, apply the same rule to every orphan claim before scheduling.
- Completed, failed, cooperative-interrupt, and forced-interrupt paths release active execution
  through one gateway finalizer. It persists terminal state first, finalizes queue disposition,
  releases session execution ownership, publishes terminal/idle state, and only then invokes the
  idempotent scheduler. Clearing `#activeTurn` in a separate forced-interrupt branch is forbidden
  because the later task finalizer can no longer observe ownership and the queue stalls.
- Session new/resume and session-control operations are serialized with turn admission. Session
  activation releases orphan restoration claims while the transition gate is held, but queued-turn
  scheduling starts only after that gate is released; scheduling inside activation is a no-op and
  leaves an idle resumed queue stalled.
- A temporary gate that still permits durable queue mutation must treat a blocked scheduling
  attempt as a pending wake-up. Releasing a session-control gate requests the idempotent scheduler
  again after the updated configuration is fully applied, on both success and failure paths. Do not
  assume another status, queue, or terminal event will arrive to wake an idle persisted record.
- New TUI mutation requests carry the captured `session_id` and positive `generation` for
  `turn.submit`, `turn.interrupt`, `turn.steer`, `turn.follow_up`, `turn.queue.pop`,
  `turn.queue.clear`, `turn.queue.restore.ack`, and clarification responses. The gateway compares
  both values with its active session context before mutating state. Missing fields remain a
  compatibility path for older clients and resolve to the current context; a stale or cross-session
  value fails with `session_changed` and cannot affect the replacement session.
- Queue callbacks carry the captured session generation. Old-generation
  callbacks cannot replace or publish the new active session queue.
- A successful queue-mutation RPC response is also an authoritative TUI
  acknowledgement. Apply the response's monotonic queue snapshot, then remove
  the matching optimistic input by `client_user_message_id` only when that
  revision was accepted; its identity-matching durable preview remains. The
  response and `turn.queue.updated` notification may arrive in either order;
  an older response must neither remove newer terminal recovery state nor
  restore a consumed preview. An RPC failure keeps the local recovery path intact.
- Preserve unknown compatible root and record fields when rewriting the `input_queue` payload.
- Every structured queue record preserves `queue_id`, `session_id`, client identity, target turn,
  kind, delivery state, optional `claim_turn_id`, source, timestamps, text, and image descriptors.
- Session changes snapshot local pending/rejected/follow-up/submitting records before restoring the
  target session. The shell snapshots and restores the target draft and attachments before queued
  autosend; a late ACK cleans only its source session and never mutates the active session.

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
- Claim persistence failure -> leave the original record `queued`; publish no claim revision and
  start no provider request.
- Failure after claim but before/while reservation -> reconcile against committed `queue_id`;
  release an uncommitted claim or retire a committed claim.
- Interrupted-steer merge exceeds queue record/attachment capacity or cannot persist -> keep every
  original accepted steer durable, omit `pending_steers_resubmitted`, and use the ordinary
  restoration path; emit one bounded queue error.
- `turn.queue.clear` fails during ordinary interrupt restoration -> keep the durable queue and
  render one actionable request error; never pretend the queue was removed.
- `turn.queue.restore.ack` fails or the client disappears before ACK -> retain the claimed records;
  release them to `queued` on the next activation/recovery rather than silently deleting them.
- Queue event or ACK belongs to another session/generation -> ignore it for the active projection;
  a late ACK may only reconcile the stored source-session optimistic snapshot.
- Queue mutation carries a stale `session_id` or `generation`, or arrives during a session
  transition -> `session_changed`; perform no queue, turn, approval, or clarification mutation.

### 5. Good/Base/Bad Cases

- Good: a steer arriving during a tool step is committed once and appears in
  the next provider request after the tool result.
- Base: an empty queue has revision zero, empty structured arrays, and no
  legacy migration payload.
- Good: a follow-up racing turn completion is persisted, reserved with its own
  client id, then removed and run once.
- Good: two accepted steers followed by Esc become one queued turn with their text and images in
  stable order; the merge revision precedes the interrupt terminal event.
- Good: forced interruption uses the same release/finalization method as cooperative interruption
  and starts the prepared steer once even while the aborted worker settles late.
- Good: an ordinary interrupt with only follow-ups starts no next turn; queue clear returns the
  records and the TUI restores them to the composer.
- Good: a follow-up persisted while `model.select` is pending remains idle until selection
  finishes, then starts automatically with the newly selected model.
- Bad: deleting a queued record before reservation or publishing a revision
  before SQLite commit, because a crash can lose input or expose phantom state.
- Bad: treating a queue ACK as consumption, independently dispatching the TUI copy, or clearing the
  active turn in the force path without calling the shared finalizer.
- Bad: clearing a session-control gate without requesting scheduling again; the earlier scheduling
  microtask already observed the gate and no later event is guaranteed to wake the durable queue.

### 6. Tests Required

- Core/runtime tests for restore reconciliation, rejected-first order, capacity,
  idempotency, session isolation, terminal rejection, interrupt retention, and
  commit-before-provider ordering.
- Storage tests proving queue history append plus pending removal roll back together and unknown
  compatible optional fields survive snapshot CAS writes.
- Gateway tests asserting event-before-response only after persistence, stale
  steer deferral, queue RPC revisions, sanitized errors, generation fencing,
  reservation-before-removal, reservation-failure retention, and queued-turn
  user lifecycle identity/source for both rejected steers and follow-ups.
- Core/runtime tests proving interrupted steers merge once, preserve priority, rebase image
  placeholders, persist before publication, and leave internal task notifications untouched.
- Gateway regressions for cooperative and forced interrupt, multiple pending steers, ordinary
  follow-up restoration, failed-turn steer deferral, queue-update-before-terminal ordering, and
  late completion suppression.
- A controlled session-control barrier must prove queued input remains idle while the gate is held,
  starts automatically after release, and observes the newly applied session configuration.
- TUI reducer tests proving the queued-turn `item.completed` identity removes
  the matching optimistic pending input and appends one user transcript row.
- TUI reducer tests proving a successful queue RPC replaces its optimistic
  input with one durable preview, a later empty snapshot removes the preview,
  and an older notification cannot restore it.
- A real Node backend composition test must cover both steer outcomes: commit
  before a later provider step and deferral into a new queued turn. Feed the
  emitted direct/mirrored events through the production TUI deduper, reducer,
  projection, and transcript renderer; require one visible user row for each
  steering message and the same messages in durable transcript loading.
- Backend restart integration proving a queued record is readable after process
  restart without provider IO.
- Restart integration proving an orphan claim is released once, a claim with committed queue
  metadata is retired without provider IO, and queued order remains durable.
- TUI tests proving A -> B -> A restores only A's draft/attachments/optimistic inputs and that
  ordinary interrupt restoration stably rebases placeholders across multiple queued messages.

### 7. Wrong vs Correct

#### Wrong

```ts
queue.markStarted(record.queueId);
const reservation = runtime.reserve(submission);
```

#### Correct

```ts
const proposedTurnId = createTurnId();
queue.claim(record.queueId, proposedTurnId);
const reservation = runtime.reserve({
	...submission,
	clientTurnId: record.clientTurnId,
	turnId: proposedTurnId,
	queueId: record.queueId,
	inputSource: record.kind === "rejected_steer" ? "steer" : "submit",
});
queue.retireClaim(record.queueId, proposedTurnId);
```

#### Wrong: Gate Release Drops The Wake-Up

```ts
finally {
	this.#sessionControlActive = false;
}
```

#### Correct: Gate Release Replays Idempotent Scheduling

```ts
finally {
	this.#sessionControlActive = false;
	this.#requestNextQueuedTurn();
}
```

- Node workspace dependency layout:
  - The repository root `package.json` is the workspace composition root for
    `backend/packages/*` and `tui/*`; the root `package-lock.json` is authoritative.
  - Run `npm ci` from the repository root. Do not restore or depend on a nested
    `tui/mycli-shell/package-lock.json`.
  - Workspace tooling such as `tsx` and `typescript` may resolve from the root
    `node_modules`; diagnostics and process launch code must recognize that
    layout instead of requiring duplicate nested installations.
  - Canonical hand-edited schemas live under `backend/packages/contracts/schemas`. Generated
    TypeScript declarations must pass `npm run contracts:check`.
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
  - An accepted `clarify.respond` replaces the transient question row with one
    resolved clarification transcript block containing the original header,
    question, and answer. It is not rendered as an ordinary user message or a
    generic `AskUserQuestion` tool row.
  - Clarification resolution is persisted as model-hidden display activity in
    the same transaction as the model-visible original tool result. Live and
    resumed sessions therefore render the same resolved block without adding
    display-only text to provider context.
  - In the clarification selector, `Esc`/the cancel key interrupts the owning
    suspended turn (the custom-answer subview uses `Esc` first to return to the
    option list). The selector remains mounted until the confirmed interrupted
    status clears `pendingClarification`.
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
	- `item.started(item.type=file_change)` creates that same matched row before
	  execution. Valid top-level `file_changes` are authoritative even for a
	  contributed mutation tool name; the row projects as a file change while
	  its approval is pending and throughout full-access execution.
  - Live and resumed transcript projection preserve the same semantic order when an assistant
    preamble accompanies tool calls: one assistant row, then the tool rows, then later assistant
    text. A resumed tool row must not reuse the assistant preamble as its target or arguments.
  - Resumed Skill rows display an allowlisted `skill_name` projected from the structured call. The
    adapter may accept legacy `arguments.name`, but must prefer explicit safe target metadata and
    must never expose raw argument objects or private tool rationale.
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
  - `turn.failed` is the sole live terminal-failure content event. It appends
    the recoverable error row and closes foreground tools. `turn.status` and
    `status.update` update state only and never append transcript errors or
    repeat Provider diagnostics. Once the terminal error is in the transcript,
    the idle status surface must not echo the same failure below it.
  - `gateway.error` appends an `error` transcript row without mutating turn
    status unless a separate `turn.failed` or `status.update` also arrives.
  - `error` and `warning` transcript rows may render a secondary diagnostic line
    from allowlisted metadata (`additional_details`, `source`, `method`, `code`).
    `additional_details` is error-only, sanitized, and capped at 1,000 characters.
    A validated runtime `code` may additionally derive a non-persisted recovery
    hint through `runtimeErrorRecoveryHint()`. The reducer must not parse
    Provider text to invent guidance. When a hint exists, the one logical
    secondary line shows the hint and safe detail instead of repeating
    technical code/source labels; those fields remain available in structured
    state.
    These rows must not dump
    raw payloads, nested objects, request bodies, headers, or secret-like
    values.
  - Runtime error display severity is derived from the shared error code, not
    Provider text. A terminal `server_overloaded` row renders as one warning
    notice, while its turn state remains failed. Live events and resumed error
    items must project the same severity and stable notice identity.
  - JSON-RPC response errors from `GatewayClient.send(...)` reject with a
    request error carrying the original request method and error code. The
    RuntimeApp dispatches those as local `request.failed` actions so request
    failures such as rejected `approval.respond`, `clarify.respond`, or
    `command.run` calls become visible error transcript rows even when no
    separate `gateway.error` notification is emitted.
  - If a local `request.failed` action and a `gateway.error` notification carry
    the same `code`, `method`, and `message` close together, the reducer keeps
    one visible error row to avoid double-reporting the same request failure.
  - The input area should render compact context-sensitive hints derived from
    local TUI state. Completion popup, approval, clarification, and running-turn
    modes expose the actions needed for the active interaction. Normal idle
    input omits permanent `enter send` and `ctrl+p commands` footer text; the
    cwd/session context remains on the left while context/model status is
    right-aligned on the same row. The header, command palette, and `/help`
    retain command discoverability without spending a persistent footer row on
    obvious actions.
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
- `session.bootstrap(protocol_version=1)` with a recovered pending approval ->
  emit one concrete `approval.request` before the successful response;
  `initialize` exposes no approval event.
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
- Turn raises -> emit `turn.failed` with the complete bounded `code`, canonical
  `message`, and optional sanitized `additional_details`, then state-only
  `turn.status(state=failed, terminal=true)` and
  `status.update(state=failed)` notifications without Provider diagnostics.
- Unexpected request-handler exception outside a turn worker -> return
  JSON-RPC `internal_error`, emit `gateway.error`, and mirror it through
  `runtime.event`.
- JSON-RPC error response for a TUI-originated request -> reject
  `GatewayClient.send(...)` with code, message, and method; RuntimeApp renders
  the failure as a local error row.
- Scripted Node smoke clients must reduce expected request failures through the
  same `request.failed` state action before dumping state, so no-pending or
  wrong-decision approval errors remain testable as visible TUI diagnostics.
- User interrupt with the matching active `turn_id` -> enter local
  `interrupting`, abort the runtime signal, wait for cooperative cleanup or the
  100 ms force boundary, then emit `turn.interrupted`, `turn.status` with
  `state=interrupted`, `terminal=true`, and `status.update` with `interrupted`.
- Missing active turn -> `accepted=false`; stale `turn_id` ->
  `turn_id_mismatch` with bounded `actual_turn_id` and no cancellation.
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
- Good: after the response is accepted, TUI retains one compact header,
  question, and answer block; reopening the session produces the same block.
- Good: TUI lets a user type `1` or `TUI` for a single-select clarification
  option and sends the canonical option label in `clarify.respond`.
- Good: TUI pressing `Esc` while the clarification options are visible sends
  `turn.interrupt` with the request's `turn_id`; the runtime clears the durable
  continuation and restores the editor only after `turn.interrupted` and
  `status.changed(pending_clarification=false)` arrive.
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
- Good: Restarting a Node-owned waiting-approval session and calling
  `session.bootstrap` produces one actionable `approval.request`, after which
  `approve_once` continues the original turn without another reservation.
- Good: A `rejected_steer` queue item survives schema validation and remains
  available for the next server turn.
- Base: `npm ci` at the repository root installs both `@mycli/contracts` and
  `mycli-shell-tui` from the single root lockfile.
- Bad: Editing a generated TypeScript declaration by hand causes the drift check to fail.
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
- Good: Generic running and thinking labels use a short phrase selected
  deterministically for the active turn. Spinner frames, elapsed-time updates,
  and redraws keep that phrase stable; explicit phases such as
  `Compressing context`, approval waits, and reconnecting remain unchanged.
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
- Bad: Returning only `status.pending_decision=true` from restart bootstrap;
  the TUI cannot reconstruct the stable decision id needed by
  `approval.respond`.
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
- Bad: Adding new untyped event fields without updating TypeScript payload types, canonical schemas,
  and reducer tests.
- Bad: Changing schema `required`, `properties`, or enum values without updating the TypeScript
  protocol contract map and contract tests.
- Bad: Feeding both direct method-name notifications and their `runtime.event`
  mirrors into the same visible reducer path without deduplication.
- Bad: Emitting `turn.status(state=interrupted)` or resolving the interrupt RPC
  before the runtime has persisted its terminal interrupted record.
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
  `GATEWAY_EVENT_PAYLOAD_CONTRACTS` stay aligned with canonical event streams and schema required
  fields, property names, and enum values.
- Reducer/rendering/status tests proving Node TUI consumes `clarify.request`,
  stores `pendingClarification`, renders a distinct clarification row, supports
  `runtime.event` envelope unwrap, and shows `clarification pending` metadata.
- Reducer and readable-transcript tests proving `clarify.respond` becomes one
  resolved clarification block in both the live event order (`turn.started`
  before `clarify.respond`) and session resume projection.
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
- Provider failure tests proving a sanitized upstream detail renders identically
  from live terminal events and durable resume projection, while arbitrary exception
  text, stacks, controls, and credentials remain hidden.
- Contracts/reducer/rendering tests proving recovery hints are exhaustive,
  code-derived, non-persisted, identical live and after `/resume`, and safe at
  narrow terminal widths. Exact SDK `status code (no body)` text is hidden while
  structured status/request-id detail remains visible.
- Reducer tests proving `server_overloaded` remains one terminal notice, uses
  warning severity, and has identical live and resumed projection.
- Rendering tests proving contextual input hints change with completion,
  approval, clarification, and running modes, while normal idle input omits
  permanent send/command footer hints and aligns context/model status at the
  right edge of the cwd/session row.
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
- Node M5 integration proving restart bootstrap re-emits one persisted strict
  Write approval, `approve_once` executes the mutation exactly once, and the
  original turn completes once.
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
- Gateway and reducer tests proving `turn.failed` alone carries and renders the
  Provider diagnostic while the following failed status notifications remain
  state-only.
- Storage and reducer tests proving the interrupted-turn warning is model-hidden,
  appears exactly once live, and is restored by `transcript.load` after resume.
- Storage, gateway, reducer, and rendering tests proving completed-turn duration
  is model-hidden, appears exactly once live, and is restored with the same
  formatting by `transcript.load` after resume.
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
- Run Node `lint`, `typecheck`, contracts check, and tests for protocol/reducer/rendering changes.
- Root Node `test` and `typecheck` commands must resolve workspace tooling from
  the root installation. Direct TUI source launch may use its local `tsx` only
  as a compatibility fallback; missing dependencies should produce an
  actionable root `npm ci` message.
- Contract catalog tests proving `runtime.ready` is present in the canonical
  event list and its payload requires `session_id`.
- Contract fixture tests proving valid `runtime.ready` and `rejected_steer` payloads pass Ajv while
  malformed boundary payloads fail without leaking their content.

- Workspace tests proving the root lockfile owns both packages, no nested TUI
  lockfile is required, and generated outputs pass `npm run contracts:check`.

### 7. Wrong vs Correct

Wrong:
```typescript
emit("turn.completed", { pendingDecision: response.pendingDecision !== undefined });
```

Correct:
```typescript
if (response.pendingDecision) emit("approval.request", approvalPayload);
emit("turn.completed", { turnState: "waiting_approval" });
emit("status.update", { state: "waiting_approval", text: "Waiting approval" });
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

Wrong:
```typescript
return { ...bootstrap, status: { pending_decision: true } };
```

Correct:
```typescript
if (method === "session.bootstrap" && session.pendingApproval) {
	emit("approval.request", approvalRequest(session.pendingApproval, session.generation));
}
return bootstrap;
```

## Scenario: Provider-Free Node Management CLI And Setup

### 1. Scope / Trigger
- Trigger: Changes to Node CLI parsing, `setup`, `config`, `doctor`, hooks/plugins/MCP management,
  user provider config writes, auth writes, or the setup TUI entrypoint.
- Utility commands are a control-plane path. They must remain outside interactive backend,
  provider, turn-runtime, and gateway/TUI startup unless `setup` explicitly opens its own TUI.

### 2. Signatures
- Parser:
  `parseCliMode(argv) -> {kind: "interactive", runtimeArgs} | {kind: "management", command}`.
- Executor: `ManagementExecutor.execute(command, signal?) -> Promise<ManagementResponse>`.
- Configuration service:
  `ConfigManagementService.validate(signal)` and `ConfigManagementService.show(signal)`.
- Auth writer:
  `writeApiKey({homeDir, authRef, apiKey}) -> Promise<void>`.
- Config writer:
  `writeUserProviderConfig({homeDir, provider, protocol, model, apiBaseUrl, authRef,
  cacheRetention, thinkingEnabled?, reasoningEffort?}) -> Promise<string>`.
- Setup TUI:
  `runSetupTui({state, terminal?, signal?}) -> Promise<SetupWizardResult | undefined>`.
- Doctor runner:
  `runDoctor(options, signal?) -> Promise<DoctorReport>` and
  `runDoctorCollectors(collectors, signal?, {collectorTimeoutMs?, cleanupTimeoutMs?})`.
- Doctor report:
  `{checks: readonly DoctorCheck[], okCount, warningCount, failedCount}`, where each check is
  `{name, status: "ok" | "warning" | "failed", message, detail?}`.
- Commands:
  `setup`, `config validate|show [--json]`, `doctor [--json]`, `hooks list|inspect|approve|revoke`,
  `plugins list|inspect|run`, and `mcp list|inspect`.

### 3. Contracts
- Parse management commands before TTY validation, Node backend/provider construction, gateway
  transport configuration, or TUI import.
- Command types are action-specific closed unions. Required ids, command names, and parsed JSON
  arguments are required fields on the corresponding union member, not optional fields recovered
  with non-null assertions.
- `--json` serializes the typed service response directly. Human renderers consume the same
  response object and do not scrape JSON or provider/runtime output.
- Plugin `--json-args` accepts one JSON object only. Arrays, scalars, malformed JSON, duplicates,
  and missing values are invalid usage.
- Management rows expose bounded metadata only. Hook rows omit command/env values; no response
  includes API keys. Agent-profile management commands and profile discovery are disabled.
- Configuration management loads workspace trust first and calls the canonical metadata resolver.
  `validate` returns only bounded typed diagnostics. `show` uses a versioned explicit setting
  allowlist, stable layer ids, `default` origins, and `present|missing` credential status; it never
  serializes the resolved config, internal layer source paths, raw TOML, or environment values.
- Setup builds provider rows from Node provider profiles and auth presence, including Anthropic.
  TTY setup calls the in-process setup TUI; non-TTY setup and TUI startup failures use the plain
  interaction. A user cancel does not fall through from TUI to plain setup.
- The setup TUI returns its result in memory and releases terminal ownership. The npm CLI does not
  use `MYCLI_SETUP_STATE`, `MYCLI_SETUP_RESULT_PATH`, or an out-of-process result file.
- Auth/config updates create a mode-`0700` user directory, write and fsync a sibling mode-`0600`
  temporary file under a short exclusive lock, rename atomically, fsync the directory where
  supported, and remove temporary/lock files. Concurrent auth merges serialize.
- User config writing preserves unrelated TOML values/tables, updates `[model]` and canonical
  `request.cache_retention`, normalizes trailing base-URL slashes, removes legacy cache booleans, and
  removes legacy root or `[model]` `api_key` values.
- Node doctor runs independent collectors in stable config, storage, runtime, extensions, and
  process order. Collector exceptions and collector-local `AbortError` values become one failed
  check and later collectors continue. Caller cancellation aborts the whole command.
- Every collector has a bounded deadline (30 seconds by default) and receives an abort signal.
  Timeout handling waits for bounded cleanup (2 seconds by default) before continuing so MCP and
  plugin probes can close through their normal lifecycle.
- Doctor opens an existing SQLite database through `node:sqlite` with `readOnly: true`. It must not
  construct `SQLiteSessionStore`, create directories, migrate schema, repair state, delete rows, or
  run `VACUUM`.
- Human and JSON doctor output consume the same sanitized `DoctorReport`. Warnings keep `ok=true`
  and exit `0`; any failed check sets `ok=false` and exits `1`.
- Secret scanning detects unredacted credential-shaped values and values under credential,
  header, or environment fields. The mere presence of benign `content`, `stderr`, or
  `provider_payload` keys is not a leak. Reports expose counts and bounded references only, never
  the matched value.
- Doctor never constructs or calls a model provider. Enabled MCP/plugin health probes may start
  only through management lifecycles that enforce sandbox, timeout, cancellation, redaction, and
  deterministic close.

### 4. Validation & Error Matrix
- Unknown command/action, missing id/value, duplicate flags, or unsupported interactive option ->
  exit `2` with a stable `invalid_arguments` message; no management/backend factory runs.
- Malformed or non-object `--json-args` -> exit `2` with `invalid_json_arguments`; do not include
  the raw argument in diagnostics.
- Management service response with `ok=false` -> exit `1`, except setup cancellation -> exit `130`.
- Configuration warnings -> `ok=true`, exit `0`; fatal typed config diagnostics -> `ok=false`,
  exit `1`; invalid config action/flags -> exit `2` before management construction.
- Non-TTY interactive mode -> exit `2` with `tty_required`; provider-free management remains valid.
- TUI setup cancellation or interrupt -> `undefined`, no config/auth write.
- TUI startup failure -> plain setup fallback without the raw import/startup error.
- Invalid setup provider or blank endpoint/model/key -> bounded `setup_invalid_result`, no key output.
- Atomic config/auth failure -> preserve the old target, clean temporary files, and return only
  `config_write_failed`, `auth_write_failed`, or `setup_write_failed` stable diagnostics.
- Existing malformed user TOML -> fail the write and preserve the old file. Malformed legacy auth
  JSON is treated as an empty auth store when replacing credentials.
- Doctor collector throws -> `status=failed`, `message="diagnostic failed"`; do not include the raw
  exception, and continue with the next collector.
- Doctor collector exceeds its deadline -> abort it, wait for bounded cleanup, emit
  `message="diagnostic timed out"`, then continue. Parent abort -> stop the whole management
  command as `interrupted`.
- Missing sessions DB/log directory -> warnings; missing traces/artifacts -> healthy lazy state.
  Existing invalid schema/recovery/lineage or unreadable diagnostic storage -> failed.
- Python plugin candidate -> `plugin_migration=warning` with the migration guide and no import or
  conversion attempt.
- Redacted marker or benign provider-content field -> no redaction finding. Unredacted credential,
  header, or environment value -> `logs_redaction=failed` without the value in output.

### 5. Good/Base/Bad Cases
- Good: `mycli mcp list --json` succeeds with piped stdio and starts zero backends/providers/TUIs.
- Good: `mycli config show --json` succeeds with piped stdio, reports effective origins without
  secret/path values, and starts zero backends/providers/TUIs.
- Good: `mycli setup` consumes pre-buffered piped answers, writes private config/auth files, and
  never writes the API key to stdout or the response object.
- Base: doctor reports `subagents=ok mode=prompt_driven profiles=disabled` without scanning profile
  directories or constructing a provider.
- Good: Compiled `mycli doctor --json` on a fresh temporary home returns one parseable report,
  warning-only exit `0`, empty stderr, zero backend/provider/TUI starts, and does not create
  `.mycli`.
- Good: An MCP/plugin health probe is aborted by its collector deadline, closes its client/worker,
  and the next collector still runs.
- Base: A fresh home has no sessions DB, logs, traces, or extensions; doctor reports bounded lazy
  state without creating any of them.
- Bad: Checking TTY or starting the Node backend before recognizing `hooks list`.
- Bad: Reuse the runtime config object itself as the `config show` JSON response.
- Bad: Returning the setup wizard result as JSON, printing the API key, or writing it through a
  world-readable temporary result file.
- Bad: Reintroducing `subagents list|inspect` or exposing profile-selected prompts, tools, models,
  or budgets.
- Bad: Treating every JSON `content`/`stderr` key as a secret leak, which makes correctly redacted
  model diagnostics fail permanently.
- Bad: Racing a timeout and returning before the normal MCP/plugin close path has observed abort.

### 6. Tests Required
- Parser unit tests cover every command/action, interactive flags, usage failures, duplicate flags,
  and object-only plugin JSON arguments.
- CLI tests run JSON management under non-TTY streams and assert backend/provider/TUI factory call
  counts remain zero; test default hooks/plugins/MCP composition as well as injected fakes.
- Configuration-management tests assert deterministic setting/layer projection, trust gating,
  warning/fatal exit semantics, no file creation on a fresh home, and sentinel absence from human
  and JSON output.
- Config tests cover auth merge/replacement, concurrent writers, mode `0600`, TOML preservation,
  inline-key removal, pre-rename failure preservation, redacted errors, and temp cleanup.
- Setup tests cover all provider rows, stored-auth presence, success persistence, cancellation,
  TUI-to-plain fallback, pre-buffered pipe input, and key absence from output/response.
- TUI tests assert direct submit/cancel Promise results, terminal cleanup, and in-memory setup
  completion without an out-of-process result file.
- Parser tests assert retired subagent-profile commands fail as unsupported arguments.
- Doctor runner tests assert collector order, exception isolation, timeout cancellation plus
  cleanup, later-collector progress, stable counts, shared human/JSON data, and exit semantics.
- Doctor redaction tests assert config/header/environment/plugin/provider secrets never appear,
  references are bounded, and benign payload keys do not create findings.
- Doctor integration tests use malformed hooks/skills, a Python plugin candidate, and real
  plugin/MCP management lifecycles; assert prompt-driven subagent status, migration status, zero
  provider calls, and one deterministic close per started probe.
- Storage tests assert missing-state checks create nothing and an existing SQLite database keeps the
  same modification time after read-only validation.

### 7. Wrong vs Correct

Wrong:
```typescript
if (!stdin.isTTY) return 2;
const backend = await startNodeBackend();
if (argv[0] === "mcp") return runMcp(argv);
```

Correct:
```typescript
const mode = parseCliMode(argv);
if (mode.kind === "management") {
	const response = await management.execute(mode.command, signal);
	return response.exitCode ?? (response.ok ? 0 : 1);
}
if (!stdin.isTTY) return 2;
```

Configuration projection remains explicit:

```typescript
// Wrong: crosses the credential and local-path boundary.
return { ...resolved.config, layers: resolved.layers };

// Correct: closed, versioned, and secret-safe.
return configShowResponseFromResolved(resolved, workspaceTrust);
```

Doctor collector isolation follows the same control-plane boundary:

```typescript
// Wrong: leaks the exception and aborts all later checks.
for (const collector of collectors) checks.push(...await collector.collect(signal));

// Correct: bound each collector, sanitize its result, and preserve caller cancellation.
const report = await runDoctorCollectors(collectors, signal, {
	collectorTimeoutMs: 30_000,
	cleanupTimeoutMs: 2_000,
});
```

## Scenario: Node-Only npm Composition Root

### 1. Scope / Trigger
- Trigger: Changes to `backend/apps/mycli`, `startNodeBackend`, gateway transport injection, process
  signals, package exports, or npm startup.
- The npm CLI owns the terminal and process lifecycle and starts exactly one Node backend. No
  alternate product runtime, probe, spawn, or fallback path exists.

### 2. Signatures
- Node CLI: `mycli [--session <id>] [--model <model>]`.
- Composition root: `runCli(options?: RunCliOptions) -> Promise<number>`.
- Backend factory:
  `startNodeBackend({cwd, env, args, maxOutputTokens?}) -> Promise<NodeBackend>`.
- Backend lifecycle: `NodeBackend = {transport, completion, diagnostic(), close(), kill()}`.
- Gateway module startup: `gatewayStartup: Promise<void>`
- Gateway module shutdown: `gatewayShutdown() -> Promise<void>`

### 3. Contracts
- Help, version, and provider-free management commands resolve before TTY checks or backend/TUI
  construction. Interactive mode accepts only `--session` and `--model` runtime options.
- `--runtime-backend` is invalid usage. Retired environment values such as
  `MYCLI_RUNTIME_BACKEND`, `MYCLI_PYTHON`, and `MYCLI_SIDECAR_START_TIMEOUT_MS` cannot change npm
  startup, trigger an executable lookup, or create a fallback path.
- Interactive startup validates terminal stdin/stdout, constructs one Node backend, configures its
  transport, and only then imports the TUI gateway. No turn may start before gateway startup and
  `session.bootstrap(protocol_version=1)` complete.
- The Node backend owns provider, storage, tools, integrations, gateway, and child-process cleanup.
  Its `close()` and `kill()` operations are idempotent and must close all Node-owned resources.
- The first SIGINT before TUI ownership requests bounded shutdown and exit `130`; after ownership,
  SIGINT belongs to the TUI. SIGTERM requests gateway shutdown. A parent `exit` synchronously calls
  backend `kill()` when completion has not settled.
- The repository contains no second runtime source, packaging metadata, compatibility test suite,
  or language-specific release gate.
- Production package exports and the `mycli` bin point only to compiled ESM and
  declarations under `dist`; production execution never requires `tsx`.

### 4. Validation & Error Matrix
- `--help` / `--version` -> exit `0`, no TTY check and no backend/provider/TUI startup.
- `--runtime-backend`, an unknown option, duplicate/missing runtime value, or malformed management
  command -> exit `2` with bounded `invalid_arguments`; do not start the backend.
- Non-TTY interactive launch -> exit `2` with `tty_required`; management commands remain available.
- Node backend construction/configuration failure -> exit `2` with a stable bounded diagnostic.
- TUI import/startup or unexpected Node backend completion -> exit `1`; do not retry through another
  implementation or replay an accepted turn.
- Normal gateway/TUI shutdown plus Node backend completion `0` -> exit `0`.
- SIGINT before TUI ownership -> bounded cleanup and exit `130`.
- SIGINT after TUI ownership -> leave the first interrupt to the active TUI.
- SIGTERM -> request gateway shutdown and close Node-owned resources.
- Missing canonical manifest method/event or wrong schema version -> `incompatible_protocol` before
  session bootstrap.

### 5. Good/Base/Bad Cases
- Good: Start `startNodeBackend`, configure its transport, dynamically import
  `mycli-shell-tui/gateway`, and await the exported startup promise.
- Good: A packed npm installation starts an interactive Node backend with a failing Python marker
  on `PATH` and in `MYCLI_PYTHON`; the marker is never read or executed.
- Base: a source checkout and packed install both start the same compiled Node composition.
- Bad: Spawn a separate TUI child that owns terminal input; this breaks Windows
  raw-TTY ownership and splits signal handling.
- Bad: Probe Python at npm startup even when the probe is described as diagnostics or rollback
  preparation.
- Bad: Retry a failed Node operation through another implementation; model requests and tool effects
  could be duplicated.

### 6. Tests Required
- CLI tests prove help/version and management do not start a backend, TTY validation precedes Node
  construction, retired flags fail, retired environment selectors are inert, transport
  configuration precedes TUI import, and exit codes follow the matrix.
- Lifecycle tests cover normal shutdown, startup failure, unexpected completion, pre-ownership
  SIGINT, TUI-owned SIGINT, SIGTERM, parent exit, and idempotent close/kill.
- Gateway tests cover schema mismatch, missing canonical RPCs/events, shutdown, and additive future
  manifest names entirely inside the Node composition.
- Build/package tests prove compiled help/version and provider-free smoke run without Python and
  `npm pack --dry-run` excludes source, fixtures, credentials, and local files.
- Packed smoke installs all published workspaces in a clean temporary directory, scans package
  contents/startup imports, plants failing Python probes, and starts the packed Node backend.
- Run lifecycle tests on Node 22.19 across macOS, Linux, and Windows.

### 7. Wrong vs Correct

Wrong:
```typescript
const backend = selectRuntimeBackend(process.env.MYCLI_RUNTIME_BACKEND);
if (backend === "legacy-sidecar") await startLegacySidecar();
await import("mycli-shell-tui/gateway");
```

Correct:
```typescript
const backend = await startNodeBackend({ cwd, env, args });
configureGatewayTransport(backend.transport);
const { gatewayStartup } = await import("mycli-shell-tui/gateway");
await gatewayStartup;
```

## Scenario: Gateway Controller Ownership And Typed Event Projection

### 1. Scope / Trigger
- Trigger: changing JSON-RPC transport, Gateway request routing, session or turn admission,
  interactive presentation, shell/settings control, runtime-event mapping, or Gateway event
  ownership fields.
- This boundary keeps `InProcessNodeGateway` as a composition root instead of a second owner of
  controller lifecycle state. It does not define TUI decoding, reduction, or transcript rendering.

### 2. Signatures
- Transport: `NodeGatewayRpcTransport` in `node-gateway-rpc-transport.ts`.
- Protocol projection: `NodeGatewayEventProjector.emitDirect` and
  `NodeGatewayEventProjector.emitRuntime` in `node-gateway-event-projector.ts`.
- Session lifecycle: `NodeGatewaySessionController` in `node-gateway-session-controller.ts`.
- Turn lifecycle: `NodeGatewayTurnController` in `node-gateway-turn-controller.ts`.
- Interactive FIFO: `NodeGatewayInteractiveController` in
  `node-gateway-interactive-controller.ts`.
- Settings and shell ownership: `NodeGatewaySettingsController` and
  `NodeGatewayShellController`.
- Shared app-facing types: `node-gateway-types.ts`.

### 3. Contracts
- `InProcessNodeGateway` constructs controllers, routes canonical RPC methods, composes status and
  bootstrap payloads, binds integration subscriptions, and owns shutdown order. It must not retain
  duplicate active-turn, session-transition, session-control, interactive-queue, shell, or settings
  mutation state.
- `NodeGatewayRpcTransport` exclusively owns line-oriented JSON-RPC parsing, request/response
  correlation, request-failure mapping, and transport close. Domain controllers neither parse raw
  lines nor write unvalidated JSON-RPC objects.
- `NodeGatewaySessionController` exclusively owns Gateway-local transition/control admission and
  the active queue subscription. Admission is one discriminated `idle | transitioning |
  controlling` state; release requires the exact claim and is idempotent. Queue callbacks retain
  their captured `SessionGenerationContext` and cannot publish after a session switch.
- `NodeGatewayTurnController` exclusively owns temporary turn admission, `ActiveTurn`, its task and
  abort controller, the exact session execution claim, continuation resume, durable queue dispatch,
  interruption, and stateful `RuntimeEvent` handling. Its options expose only the dependencies and
  session/settings capabilities it consumes, not the complete Gateway object.
- `NodeGatewayInteractiveController` owns one root/child presentation FIFO. It retains the source
  ownership snapshot with each queued request so resolving or cancelling one request cannot
  re-stamp a later presentation with the then-current session.
- Shell and settings controllers own their mutable projections and side-effect adapters. Session
  or turn controllers call them through explicit narrow methods; they do not reproduce permission,
  trust, model, or shell lifecycle decisions.
- `NodeGatewayEventProjector` is the single schema-validation and ownership-stamping boundary for
  runtime-owned notifications. It writes the validated compatibility notification first, then one
  `runtime.event` envelope with the same owned payload and a monotonic sequence.
- Every runtime-owned direct notification and its `runtime.event` envelope carry the owning root
  `session_id` and positive `generation`. A notification with an explicit matching `turn_id` keeps
  it; a notification whose `client_turn_id` matches the active turn inherits that active turn id.
  An explicit child routing `session_id` remains on the direct payload while the envelope retains
  root ownership; root generation must never be copied into an unrelated child payload.
- Stateful runtime-event decisions remain in `NodeGatewayTurnController`, as Codex keeps state
  checks and side effects at the caller around stateless event mapping. Every resulting public
  notification still passes through `NodeGatewayEventProjector`; controllers must not bypass it.
- A pre-activation credential, reservation, turn-id creation, or runtime-configuration failure
  clears temporary admission and releases only that attempt's execution claim. A late event or
  completion is accepted only while both the `ActiveTurn` object and captured session generation
  still own the controller.
- Gateway close marks the root closed, unsubscribes external producers, aborts the active turn,
  awaits its tracked task, then closes backend resources and transport. Repeated close calls share
  the root close promise; no controller event may publish after close completes.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Malformed JSON-RPC line or params | Return one mapped request failure; do not enter a controller |
| Credential/reservation/configuration fails before active installation | Release admission and the exact execution claim; publish no committed user lifecycle |
| Runtime callback has an old session generation | Drop it without active-session state or event mutation |
| Completed turn callback arrives after a successor starts | Drop it; do not clear or terminalize the successor |
| Interactive request waits across another request's resolution | Preserve its captured ownership and FIFO position |
| Child payload names another session | Preserve child routing directly; stamp root ownership only on the envelope |
| Close begins with an active task | Abort first and keep close pending until the task settles |
| Schema rejects a projected notification | Contain the request/turn failure at the existing boundary; never emit unchecked JSON |

### 5. Good/Base/Bad Cases
- Good: submit claims execution, reserves durably, installs one active turn, handles typed runtime
  events, releases the exact claim, publishes idle status, then schedules the next durable item.
- Good: a queued child approval retains its child session while the mirrored envelope identifies
  the current root session and generation.
- Base: a provider-free status event has root session/generation and no turn id when it does not
  belong to a matching active turn.
- Bad: pass all `CreateNodeGatewayOptions` into every controller and let each discover unrelated
  services or mutate shared Gateway fields.
- Bad: stamp events in controllers and again in the transport, or let a controller write directly
  to the output stream.
- Bad: move active-turn mutation into a nominally stateless event mapper merely to shrink a file.

### 6. Tests Required
- RPC transport tests cover parsing, async response correlation, mapped failures, and close.
- Event projector tests cover direct-before-mirror order, monotonic sequence, schema validation,
  explicit stale-source ownership, active turn-id inference, and child/root routing separation.
- Session controller tests cover transition/control exclusion, identity-based idempotent release,
  failed-resume admission cleanup, and stale queue callback fencing.
- Turn controller tests cover pre-activation cleanup, stale-generation event rejection, late-event
  isolation from a successor, exact active cleanup, close abort-and-await, and ownership resolution.
- Existing Gateway and backend integration tests remain the payload/order compatibility gate for
  submit, queue, continuation, interrupt, resume, Worker, and SQLite behavior.

### 7. Wrong vs Correct

Wrong:
```typescript
gateway.activeTurn = active;
gateway.transport.write({ method, params });
gateway.activeTurn = null;
```

Correct:
```typescript
const controller = new NodeGatewayTurnController({
  dependencies: narrowTurnDependencies,
  session,
  settings,
  publish: (method, params) => eventProjector.emitRuntime(method, params),
});
```

## Scenario: Ownership-Fenced TUI Runtime Projection

### 1. Scope / Trigger
- Trigger: changing a gateway event, TUI runtime state, session/turn lifecycle projection,
  transcript projection, interactive selector lifecycle, native chat input, or local follow-up
  dispatch.
- The TUI is a projection client. It may keep optimistic presentation state, but it must not
  accept an event or trigger scheduling side effects before runtime ownership is decoded and
  validated.

### 2. Signatures
- Decoder:
  `decodeGatewayRuntimeEvent(event) -> DecodedRuntimeEvent | null` in `runtime-events.ts`.
- Ownership fence:
  `runtimeEventBelongsToActiveOwner(state, event) -> boolean` in
  `runtime-event-ownership.ts`.
- Reduction boundary:
  `reduceDecodedRuntimeEventWithOutcome(state, event) -> {state, applied}`.
- Lifecycle reduction:
  `reduceRuntimeLifecycle(previous, reduced, event) -> RuntimeShellState`.
- Transcript projection:
  `RuntimeTranscriptProjector.project(state, sessions, updateKind) -> MycliShellState`.
- Shared input boundary:
  `MycliUiActionDispatcher.dispatch(action) -> Promise<unknown>`.
- Child cancellation event:
  `interactive.cancelled({session_id, child_session_id, generation, client_turn_id, turn_id,
  decision_id | request_id})`.

### 3. Contracts
- `GatewayClient` validates the canonical notification schema before the runtime decoder sees an
  event. The decoder's accepted direct-event method set derives from
  `gatewayContractCatalog.eventStreams`; it must not be maintained as another handwritten list.
- A decoded event retains normalized `sessionId`, `generation`, `turnId`, and `clientTurnId`, plus
  its `direct | envelope | synthetic` source. All reducer and gateway scheduling decisions use
  this decoded value rather than reading the unchecked transport object again.
- A mirrored child event has two identities: the `runtime.event` envelope owns the active root
  session/generation, while its payload names the child subject. The direct child payload is not
  allowed to mutate root TUI state; the root-owned envelope is. Direct/mirror deduplication includes
  normalized ownership so rejecting the child direct event does not also discard its valid mirror.
- Session-scoped events require the active root session and exact generation. A terminal turn event
  additionally requires at least one explicit identity that equals a known active turn or client
  turn identity. An anonymous or uncorrelated terminal event cannot release newer work.
- Feature-specific reduction runs only after ownership validation. `reduceRuntimeLifecycle` is the
  final authority for `turnRunning`, active turn identities, active assistant cleanup, reasoning
  cleanup, and retry restoration across lifecycle events. Gateway-local effects run only when the
  reduction returns `applied=true`.
- A child approval, clarification, response, or cancellation never changes the root turn lifecycle.
  It changes only the matching selector/transient row. Matching includes request kind, child
  session, request/decision id, and child generation when both sides provide it.
- `subagent.updated` presents task progress only. It must not infer release of pending interactive
  ownership from a child terminal status; the matching response or `interactive.cancelled` event
  owns that transition.
- When the visible child request is cancelled, the Gateway publishes `interactive.cancelled` with
  the request's captured root ownership before publishing the next FIFO request. Cancelling an
  unseen queued request emits no TUI cancellation because the client never observed that request.
- `session.changed` clears prior-session dispatch/interrupt state. Resume reduction must not apply
  `session.changed` twice after activation events have already restored a concrete approval or
  clarification.
- Incremental transcript caching lives in `runtime-transcript-projector.ts`; the runtime state model
  lives in `runtime-state-model.ts`. Projection must preserve stable prefixes and fall back to a
  complete projection when transcript identity or presentation context no longer matches.
- Full-screen TUI and native chat route submit, follow-up, commands, interrupt, approval,
  clarification, dequeue, and exit through the same `MycliUiAction` dispatcher. Adapter-specific
  callbacks may remain only as compatibility fallbacks, not as the production Gateway wiring.
- A local follow-up blocked by an interactive selector remains dispatch-eligible. Any later applied
  state change may wake the scheduler when the backend is idle and no interrupt is settling; the
  final dispatch guard rechecks turn, selector, and queue state before sending.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Unknown nested `runtime.event.type` | Decode to `null`; perform no state or scheduling mutation |
| Session or generation does not own the active root | Return `{state: previous, applied: false}` |
| Terminal event has no identity while active identity is known | Reject without clearing running state or tools |
| Terminal event identifies only an uncorrelated turn/client turn | Reject even when the other active identity is unavailable |
| Direct child event arrives before its mirror | Reject the direct event; accept the root-owned envelope |
| Child response/cancellation has stale generation or wrong id | Preserve the current selector and transient row |
| Child emits terminal `subagent.updated` before cancellation | Update task presentation; retain interactive ownership |
| Stale `status.changed(turn_running=false)` arrives | Do not clear Gateway busy state or dispatch local input |
| Resume RPC returns after activation events | Preserve the already projected actionable request |
| Shared action rejects | Restore selector/composer affordances and keep later actions serializable |

### 5. Good/Base/Bad Cases
- Good: a running root receives a child approval, keeps its root turn identity, then removes only
  that approval when the root-owned cancellation envelope arrives.
- Good: an idle root responds to a child clarification and remains idle while the child continues.
- Good: a local follow-up waits behind a child selector and dispatches after the selector is
  resolved or cancelled without waiting for an unrelated status event.
- Base: an envelope-only gateway sends a valid runtime event with no preceding compatibility event;
  decode and apply it once.
- Bad: clear `turnRunning` from a terminal event carrying an unrelated identity merely because the
  corresponding active client id is unknown.
- Bad: clear a child selector from `subagent.updated(status=failed)` or reconstruct root ownership
  from the child payload.

### 6. Tests Required
- Decoder/deduper tests compare the accepted runtime method surface with the canonical catalog,
  cover direct-plus-mirror and envelope-only delivery, and prove child direct rejection does not
  suppress the valid mirror.
- Pure ownership/lifecycle tests cover stale sessions and generations, exact and partial matching
  terminal identities, anonymous terminals, and uncorrelated partial identities.
- Reducer tests cover active and idle root state across child request/response/cancellation, stale
  child generation, exact transient-row removal, status/bootstrap/resume ordering, and workspace
  trust fencing.
- Gateway/controller tests cover visible cancellation-before-next ordering, silent removal of an
  unseen request, preserved captured ownership, and schema-valid direct/mirrored cancellation.
- Shared action tests exercise every action through the full TUI and native chat, including
  response rejection, Ctrl+C/EOF, serialized input, and attachment-preserving queue restoration.
- Transcript projector tests cover unchanged state, tail append/replacement, active assistant and
  reasoning invalidation, long-history bounded work, and full-projection fallback.

### 7. Wrong vs Correct

#### Wrong

```typescript
const next = reduceRuntimeEvent(state, event.method, event.params);
if (event.params.turn_running === false) backendTurnBusy = false;
```

#### Correct

```typescript
const decoded = eventDeduper.consume(event);
if (!decoded) return;
const reduction = reduceDecodedRuntimeEventWithOutcome(state, decoded);
if (!reduction.applied) return;
setRuntimeState(reduction.state, { eventType: decoded.method });
```

## Scenario: Atomic Node Session Transitions

### 1. Scope / Trigger
- Trigger: Changes to Node `session.list`, `session.new`, `session.resume`, `session.tree`,
  `transcript.load`, session-scoped status projection, or turn acceptance.
- This boundary coordinates SQLite state preparation, runtime binding, and TUI
  visibility. A target session must never become partially visible.

### 2. Signatures
- `SessionCoordinator.resume(sessionId) -> Promise<ActiveSessionSnapshot>`
- `SessionCoordinator.startNew() -> Promise<ActiveSessionSnapshot>`
- `SessionCoordinator.context() -> SessionGenerationContext`
- `SessionCoordinator.claimExecution(context) -> SessionExecutionClaim | undefined`
- `SessionCoordinator.releaseExecution(claim) -> boolean`
- Pure runtime transitions: `createSessionOperationState`, `claimSessionExecution`,
  `releaseSessionExecution`, `beginSessionTransition`, `commitSessionTransition`, and
  `abortSessionTransition`.
- `SessionLeaseStore.acquireSessionLease(sessionId) -> boolean` (`true` only for a newly acquired or
  stale-owner takeover lease; `false` for the same backend owner)
- `SessionLeaseStore.releaseSessionLease(sessionId) -> void`
- Gateway RPCs: `session.list`, `session.new`, `session.resume`, `session.tree`,
  `transcript.load`, `turn.submit`, `approval.respond`, `clarify.respond`, and `turn.interrupt`.
- Gateway events: `session.changed`, `status.changed`, and
  `approval.request`.

### 3. Contracts
- Resume uses prepare/commit: load and validate transcript, queue, suspended
  approval, compaction state, continuation state, workspace, and runtime
  binding before incrementing the active generation.
- Every live backend owns an operational SQLite lease for every root session runtime loaded by that
  window. Initial startup acquires the lease before recovery or preparation. Cross-session resume
  acquires the target before preparation and releases a newly acquired target on preparation
  failure. A successful switch retains the source lease because its background Shells, subagents,
  mailbox deliveries, and cached runtime may still write; backend close releases all owned sessions.
  Same-session resume is idempotent.
- Lease ownership is backend-window-scoped. A different live process cannot acquire the same session;
  a stale owner PID may be atomically replaced after an abnormal exit. Releases are conditional on
  both session id and owner id so an old process cannot delete a successor's lease.
- Fork and subagent-child creation acquire the target session lease in the same SQLite transaction
  that first exposes the target. A live `agent_runtime_leases` owner also blocks root-session
  acquisition of that child, including from another backend in the same OS process.
- Session operation ownership is one discriminated `idle | executing | transitioning` state. Do
  not retain independent executing and transitioning booleans in `SessionCoordinator`; they admit
  impossible combinations and allow one callback to clear another operation.
- Execution and transition claims are frozen objects created by the pure transition functions.
  Completion, release, and abort compare the exact object identity, not only session id,
  generation, kind, or structural equality. A stale callback from an earlier execution in the same
  generation therefore cannot release a newer execution.
- New-session creation uses the same transition claim and generation commit. It installs a fresh
  backend runtime binding with an empty transcript and queue; the TUI must not clear local arrays
  or fabricate a session id independently.
- `transcript.load` for the current writable virtual session returns an empty writable page without
  creating a durable session row. Missing non-current ids and missing `/resume` targets still fail.
- The coordinator holds a transition claim across the entire asynchronous
  prepare. A gateway turn must acquire the matching generation's execution
  claim before reserving a durable turn. Transition commit advances the operation context by
  exactly one generation and returns it to idle before any asynchronous source-lease cleanup.
- Gateway `ActiveTurn` retains the exact execution claim acquired by ordinary submit, queued-turn
  dispatch, approval continuation, clarification continuation, or reconstructed clarification
  interrupt. The common terminal finalizer returns that same claim. A reservation or runtime
  configuration failure before `ActiveTurn` installation returns only the claim acquired by that
  attempt and leaves a pending approval/clarification available for retry.
- The Gateway's temporary turn-admission, session-control, and session-activation gates are not a
  second session-operation owner. They cover request validation and post-commit publication that
  can outlive the coordinator transition claim; Phase 1 keeps them as compatibility gates until
  their owning controllers are extracted.
- Successful resume emits `session.changed` first, one complete
  `status.changed` snapshot second, then the pending `approval.request` when
  present. Failed preparation emits none of these target-session events.
- A readable snapshot without usable canonical SQLite state is display-only;
  `turn.submit` fails closed and the snapshot is never provider context.
- Writable resume preparation retains only the bounded recent transcript snapshot. `transcript.load`
  independently rebuilds complete filtered history and supports an opaque versioned `before` cursor
  plus `limit` pagination, so old visible turns remain reachable without pinning every tool output
  in `PreparedSession`. Initial bootstrap/resume requests ask for at most 500 projected items. The
  TUI stores `next_before` and prepends one older page only when the transcript viewer reaches its
  current top; it preserves the visible scroll position, deduplicates stable item ids, and prevents
  concurrent duplicate page loads.
- Legacy queue text arrays project pending steers as `queued_steering` and
  rejected steers plus ordinary follow-ups as `queued_follow_up`. Typed
  `queue_items` preserves separate `pending_steers`, `rejected_steers`, and
  `follow_ups` arrays.
- Runtime callbacks carry `{sessionId, generation}` and stale callbacks do not
  mutate or emit active-session TUI state.

### 4. Validation & Error Matrix
- Missing resume target -> `session_not_found`; do not create a session.
- Session owned by another live mycli process -> `session_in_use`; keep the active generation and
  emit no target-session events.
- Missing new-session factory -> `session_state_invalid`; keep the active generation unchanged.
- Invalid or cross-session queue, suspended turn, approval, transcript, or
  continuation identity -> `session_state_invalid` with a fixed message.
- Unsupported persisted state version ->
  `session_state_version_unsupported` with a fixed message.
- Executing turn, concurrent resume, or turn submission during prepare ->
  `turn_in_progress` before a new reservation is written.
- Structurally copied, already released, or stale execution/transition claim -> reject the release,
  commit, or abort without changing the current operation.
- Stale session id or generation context -> reject execution/transition acquisition and all
  coordinator snapshot mutations.
- Approval/clarification turn-context configuration failure -> release the newly acquired execution
  claim, retain the pending continuation, and return the bounded Gateway request failure.
- Queued-turn reservation/configuration failure before activation -> reconcile the durable queue
  claim, release the session execution claim, emit bounded `queue_worker_start_failed`, and start no
  provider IO.
- Snapshot-only degraded session turn submission -> `session_state_invalid`.
- Same-session idle resume -> return the current generation without preparing
  or incrementing it.

### 5. Good/Base/Bad Cases
- Good: Claim transition, prepare target state, commit one generation, then
  emit the ordered target snapshot events.
- Good: two windows share one sessions database; the first owns session A, the second receives
  `session_in_use`, and can acquire A after the first window closes.
- Good: window one switches from A to B while an A background Shell completes; window two remains
  unable to resume A until window one closes, so only one backend can persist A lifecycle events.
- Good: `/new` creates a distinct backend session id, emits `session.changed`, and becomes durable
  on its first accepted turn.
- Good: Claim execution for the current generation, reserve the turn, and
  release the claim if reservation fails.
- Good: an approval continuation holds its exact execution claim until completion; a failed
  pre-activation configuration releases it and the same pending decision can be retried.
- Good: an interrupt first fences the pending clarification turn id, then claims execution and uses
  the common forced-interrupt finalizer to release ownership.
- Base: A configured but not-yet-persisted initial session is an empty virtual
  session and becomes durable on its first accepted turn.
- Bad: Check `executing` before `await prepare` but allow a turn to reserve
  during the await; the resumed generation can then replace a running source.
- Bad: release execution with only `{sessionId, generation}` or a copied claim; an old completion in
  the same generation can clear a newer active turn.
- Bad: acquire a continuation claim before validating its turn id, then leak ownership when the
  request is rejected.
- Bad: Merge rejected steers into legacy steering text; the TUI displays a
  deferred input as if it can still steer the active turn.
- Bad: clear only TUI messages and replace the footer session label while the backend continues to
  submit into the previous session.

### 6. Tests Required
- Pure coordinator tests for failed prepare, fresh-session creation, same-session idempotency,
  monotonic generation, stale context rejection, exact claim identity, stale-claim release
  rejection, executing-turn rejection, transition/execution mutual exclusion across an async
  prepare, and lease cleanup plus operation rollback on every pre-commit failure.
- Gateway tests for session catalog/tree/transcript responses, ordered resume
  events, sanitized state errors, read-only turn rejection, stale callback
  filtering, and no reservation during target preparation. Submit, queued-turn, approval,
  clarification, and pending-clarification interrupt tests assert execution is held during work and
  idle after terminal or pre-activation failure paths.
- Queue projection tests must assert legacy text arrays and counts plus all
  three typed `queue_items` arrays.
- Backend integration must use real SQLite state to prove target runtime
  rebinding, v1 snapshot import, invalid-state atomicity, and provider context
  sourced from the target's canonical conversation. It must also prove that two live backend
  instances cannot own the same root session, switching retains source ownership, and normal
  shutdown releases every session owned by the window.

### 7. Wrong vs Correct

Wrong:
```typescript
if (!coordinator.executing()) runtime.reserve(submission);
coordinator.markExecuting(context, true);

// A later callback can clear an unrelated execution in the same generation.
coordinator.markExecuting(context, false);
```

Correct:
```typescript
const executionClaim = coordinator.claimExecution(context);
if (!executionClaim) {
  throw new GatewayFailure("turn_in_progress", "Session transition in progress.");
}
try {
  const reservation = runtime.reserve(submission);
  activeTurn = { ...activeTurnInput, reservation, executionClaim };
} catch (error) {
  coordinator.releaseExecution(executionClaim);
  throw error;
}

// The common terminal finalizer returns the exact claim held by this turn.
coordinator.releaseExecution(activeTurn.executionClaim);
```

## Scenario: Credential Readiness And Recovery

### 1. Scope / Trigger

- Trigger: changing interactive bootstrap, workspace trust completion, credential storage,
  session new/resume, model selection, `turn.submit`, login selectors, or gateway request errors.
- Credential readiness is startup guidance plus a backend acceptance invariant. A TUI-only check
  is stale and bypassable; a backend-only check leaves the first composer apparently usable.

### 2. Signatures

- Backend control:
  `credentialReadiness() -> Promise<{ready, providerId, authRef, source}>`.
- Source: `environment | stored | legacy_config | missing`.
- Bootstrap and session-transition payload:
  `auth_status {ready, provider_id, auth_ref, source}` plus `auth_providers[]`.
- Credential write:
  `auth.api_key.save {provider_id, api_key, auth_ref?}`.
- Rejection:
  JSON-RPC `auth_required` with bounded `auth_status` data.
- TUI state: `authReadiness {ready, providerId, authRef, source}`.

### 3. Contracts

- Bootstrap resolves readiness without constructing or calling a Provider. The TUI sequences
  unresolved workspace trust before authentication and focuses the composer only after both gates
  are complete.
- Readiness is recomputed immediately before `turn.submit` accepts work. A missing credential must
  reject before session-preference persistence, turn reservation, user-item lifecycle publication,
  transcript mutation, runtime submission, or Provider IO.
- `auth_required` is a recoverable request error. It returns one JSON-RPC failure and must not also
  publish `gateway.error` or terminalize a turn.
- The TUI removes its optimistic local user item, restores exactly one draft, opens login directly
  on `provider_id`/`auth_ref`, and does not render a generic submission-failure notice.
- Startup login cancellation exits. Recovery cancellation returns to the composer with the draft.
  Successful recovery stores the credential and keeps the draft for deliberate resubmission; it
  never automatically sends the retained text.
- API-key input remains masked. Responses may expose the bounded provider id, auth reference, and
  source only; they never expose a key, submitted prompt, provider body, stack, or absolute path.
- A caller-provided custom `auth_ref` is accepted only when it equals the current resolved
  credential identity for that provider. A provider-default reference remains backward compatible.
- Model selection and session new/resume refresh the same readiness projection. They do not invent
  independent configured booleans.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Active credential source is missing | Reject `turn.submit` with `auth_required` and bounded readiness data |
| Environment, stored, or supported legacy credential exists | Permit normal acceptance and report its source without the value |
| `auth_ref` is blank, over 512 characters, or contains a line/NUL control | Reject `auth.api_key.save` with `invalid_params` before storage |
| Non-default `auth_ref` does not match the active provider identity | Reject with `invalid_params`; do not echo the reference or key |
| Credential save fails | Keep login mounted, display one sanitized selector error, and preserve the draft |
| Startup login is canceled | Exit without config/auth writes |
| Later recovery is canceled | Restore editor focus and retain one unsent draft |

### 5. Good / Base / Bad Cases

- Good: bootstrap reports a missing custom reference, trust completes, login stores that reference,
  and the user deliberately submits the retained draft once.
- Good: a credential is deleted while the TUI is open; `turn.submit` rejects before reservation and
  recovery opens without a transcript error.
- Base: `MYCLI_API_KEY` is present; startup remains offline and reaches the composer without login.
- Bad: reserve a turn, persist the user prompt, then discover the missing key during Provider
  construction.
- Bad: save recovery credentials under the provider id when the active catalog/session uses a
  different `auth_ref`.

### 6. Tests Required

- Gateway tests assert bootstrap projection, pre-reservation rejection, zero runtime submissions,
  zero user lifecycle events, no `gateway.error`, and normal acceptance when ready.
- Backend integration uses a temporary HOME/config/auth store and asserts `missing`, `stored`,
  `environment`, and `legacy_config` sources, custom-reference saving, unrelated-reference
  rejection, empty transcript after rejection, and sentinel redaction.
- TUI tests assert trust-to-login ordering, startup cancellation, masked input, visible save errors,
  custom-reference forwarding, one restored draft, no generic error notice, no automatic resend,
  and a fully mounted composer after success.
- Session transition and model-selection tests assert refreshed `auth_status` reaches the adapter.

### 7. Wrong vs Correct

#### Wrong

```typescript
const reservation = runtime.reserve(submission);
await runtime.submit(submission); // Provider construction discovers the missing key later.
```

#### Correct

```typescript
const readiness = await credentialReadiness();
if (!readiness.ready) throw new GatewayFailure("auth_required", PUBLIC_MESSAGE, readinessPayload);
const reservation = runtime.reserve(submission);
```

## Scenario: Session-Scoped Runtime Preferences

### 1. Scope / Trigger

- Trigger: changing model selection, reasoning effort, collaboration mode, session bootstrap/new/
  resume/fork, provider construction, or session preference persistence.
- This flow crosses user config, auth storage, SQLite session state, runtime bindings, gateway status,
  and subagent provider inheritance.

### 2. Signatures

- Persisted state key: `session_state.state_key = 'session_preferences'`.
- Payload v1: `{state_version: 1, provider, protocol, model, api_base_url, auth_ref,
  reasoning_effort, collaboration_mode, permission_profile?}`.
- Runtime helpers: `loadSessionPreferences`, `saveSessionPreferences`,
  `sessionPreferencesFromConfig`, and `sameSessionPreferences`.
- Config resolution: `resolveConfig({overrides: {provider, protocol, model, apiBaseUrl, authRef,
  reasoningEffort, thinkingEnabled, session}})`.
- Gateway binding: `NodeGatewayRuntime.sessionPreferences()`, `setSessionPreferences(...)`, and
  `ensureSessionPreferences(...)`.

### 3. Contracts

- `sessions.workspace_root` remains the authoritative per-session workdir. Do not duplicate workdir
  inside `session_preferences`.
- User/project/environment config is the fallback for a new session or a legacy session without
  `session_preferences`. Once the state exists, its provider, protocol, model, endpoint identity,
  reasoning effort, and collaboration mode are authoritative for that session.
- Activating a session must load and validate its preference before publishing `session.changed`
  and `status.changed`. A session with no preference must actively restore the current default
  config; it must not inherit the previously active session's fields.
- A virtual/new session remains unpersisted until an accepted turn, model selection, or mode change
  needs a snapshot. Before provider IO, `turn.submit` ensures that the target session has one complete
  preference snapshot matching the frozen turn model and collaboration mode.
- Successful model selection always persists the active session preference. It updates the
  user-owned default config and new-session fallback only for explicit `user` scope; omitted or
  explicit `session` scope must not rewrite that default. Restoring another session changes only
  active runtime config.
- `reasoning_effort='none'` restores with `thinkingEnabled=false`; every other supported effort
  restores with `thinkingEnabled=true`.
- `auth_ref` identifies the credential lookup. API keys remain in the auth store or process
  environment and must never be serialized into `session_state`, gateway status, or diagnostics.
- `permission_profile`, when present, is the session-selected `read-only`, `workspace`, or
  `full-access` preset. Legacy snapshots may omit it and then use the current runtime fallback.
  Changing permissions persists the active-session preference before reconfiguring the next turn.
- A child agent inherits the parent session preference used for the spawn. A fork copies only
  `session_preferences`; it does not copy queues, approvals, suspended turns, or continuation state.

### 4. Validation & Error Matrix

| State | Required behavior |
| --- | --- |
| No preference row | Resolve current default config and use `collaboration_mode=default` |
| Valid v1 row | Restore every field before status publication or provider construction |
| Unsupported version, provider/protocol pair, effort, mode, URL, or identity | Fail with `session_state_invalid`; keep the source session active |
| Base URL contains credentials or is not HTTP(S) | Fail with `session_state_invalid` |
| Preference has `reasoning_effort='none'` | Disable thinking without a config conflict |
| Model selection fails validation or auth lookup | Mutate neither user config nor session preference |

### 5. Good/Base/Bad Cases

- Good: session A resumes `model-a/high/plan/full-access`, session B resumes
  `model-b/none/default/read-only`, and a new session uses current defaults without changing either
  stored snapshot.
- Base: a pre-feature session has no preference and receives a snapshot on its next accepted action.
- Bad: keep model/mode only in Gateway fields, or let resuming A change the fallback later used by
  an unrelated new session.
- Bad: store `apiKey`, an auth-store record, or provider headers beside `auth_ref`.

### 6. Tests Required

- Config tests prove a complete session override beats environment/user values and that `none` plus
  disabled thinking restores successfully.
- Runtime/gateway integration creates two sessions with different model/effort/mode/permission
  values, resumes each, restarts the backend, and asserts status plus subsequent submission use the
  target snapshot.
- A new or legacy session activated after a stored session must use the current default config,
  not the source session preference.
- Invalid persisted payload tests assert `session_state_invalid`, no target `session.changed` or
  `status.changed`, and unchanged active-session status.
- Fork tests for both storage implementations assert only `session_preferences` is inherited.
- Persistence tests inspect serialized state and assert no API key or secret value is present.

### 7. Wrong vs Correct

#### Wrong

```typescript
gateway.model = resumedPreference?.model ?? gateway.model;
activeModelOverride = resumedPreference?.model;
```

#### Correct

```typescript
const stored = runtime.sessionPreferences();
const active = stored
	? await resolveModelRuntimeConfig(sessionPreferenceOverrides(sessionId, stored))
	: await resolveModelRuntimeConfig(sessionPreferenceOverrides(sessionId, defaultPreferences));
gateway.applySessionPreferences(stored ?? sessionPreferencesFromConfig(active, "default"));
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
- Internal approval detail:
  `ApprovalPreviewDetails = {contentPreview?, contentLineCount?, contentChars?,
  contentTruncated?, diff?, diffChars?, diffTruncated?}` plus canonical bounded
  `fileChanges`; gateway output uses the corresponding snake-case field names and
  `previous_path` for moves.
- Node M5 choices: `approve_once` and `reject` only.

### 3. Contracts

- `autoApproveMedium=true` remains the legacy-compatible default behavior.
  Strict policy requests one-time approval for a valid workspace-local medium
  risk mutation and denies workspace escape before suspension.
- Persist the assistant tool-call batch before policy evaluation. When approval
  is required, atomically save `pending_decision`, `suspended_turn`,
  `turn_record`, and a `waiting` effect checkpoint before emitting
  `approval.request`.
- For the initial live request, prepare the mutation before policy resolution and emit its bounded
  `fileChanges`. `Write` also publishes bounded compatibility content/count fields; `Edit` may
  publish compatibility diff fields. Do not execute the router or emit `tool.start` until the user
  approves. Do not reconstruct proposal details during restart or session recovery.
- Mutation approval stores one host-only prepared guard under pending-decision metadata. It does not
  duplicate content, diffs, absolute paths, or the guard into the suspended turn. The guard binds
  effect identity, not a filesystem baseline. Approval execution rebuilds the semantic mutation
  from the canonical call against current filesystem state while retaining path-confinement checks.
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
- Restart with `waiting` -> re-emit an actionable compact approval without `content_*` or `diff*`;
  keep the stored canonical tool call only for the eventual approved execution.
- Ordinary turn submission or session resume while approval owns the session ->
  `turn_in_progress` before a new reservation or generation is created.

### 5. Good/Base/Bad Cases

- Good: Approve `Write`, commit its result once, execute later calls from the
  same provider batch in order, finalize the checkpoint, then continue the
  provider request.
- Good: A resolution persistence failure shows a bounded error and immediately
  restores the same actionable approval prompt.
- Good: The TUI displays the prepared Write/Edit/Patch file changes for the initial live request;
  a recovered request shows the compact path-level prompt and remains actionable without persisting
  a second proposal copy.
- Base: Default policy auto-allows a workspace-local mutation and creates no
  approval continuation.
- Bad: Delete pending state before provider IO; a crash then loses the only
  safe continuation point.
- Bad: Retry an orphaned `executing` effect; the original mutation may already
  have reached the filesystem.
- Bad: Emit terminal `turn.failed` while restoring pending approval; the TUI
  clears the decision details and cannot perform the safe retry.
- Bad: Send raw camel-case runtime fields or the full arguments object through the gateway; clients
  either miss the preview or receive data outside the allowlisted approval contract.

### 6. Tests Required

- Policy unit tests for default allow, strict request, escape denial, malformed
  calls, bounded path-only policy previews, and bounded detailed mutation approval previews.
- Runtime tests for approve, reject, identical/conflicting responses, multiple
  approvals in one batch, original-user dedupe, completed effect reuse, and
  interruption during claimed execution. Assert lifecycle start precedes the
  router call and lifecycle completion follows it.
- Storage tests proving suspension rows and tool-result/checkpoint commits roll
  back together at failpoints.
- Gateway tests for decision/session/generation ownership, pending-state
  exclusion, camel-case-to-snake-case mutation preview projection, sanitized resolution failure,
  re-emitted approval, and absence of terminal failure while retry remains possible.
- Backend restart integration proving `executing` becomes
  `effect_outcome_unknown` without provider IO or tool replay, and a second
  restart finds no approval continuation to recover.
- Backend restart integration proving a `waiting` Write re-emits its decision/path/options without
  any `content_*` or `diff*` fields and still executes the persisted call exactly once after approval.
- Run tools, runtime, storage, app, and M4 Node integration suites when this boundary changes.

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

#### Wrong

```typescript
emitRuntime("approval.request", { ...event });
```

#### Correct

```typescript
emitRuntime("approval.request", {
	...approvalIdentity,
	...approvalPreviewPayload(event),
});
```

#### Wrong

```typescript
const recoveredApproval = {
	...approvalIdentity,
	...fileMutationApprovalPreview(persistedCall),
};
```

#### Correct

```typescript
const recoveredApproval = approvalIdentity;
// persistedCall remains in suspended state for approved execution, not TUI reconstruction.
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
- Terminal runtime event:
  `compaction_completed { status: "compressed" | "skipped" | "failed", beforeTokens, afterTokens }`.
- Storage: `saveState(... compact_checkpoint ...)`, `loadHistoryItems(sessionId)`, and
  `commitCompaction({sessionId, replacementMessages, summary, checkpoint})`.
- Gateway events: `compaction.started` and `compaction.completed`.

### 3. Contracts

- `TokenCounter` uses `js-tiktoken` with `o200k_base`. Encoder initialization failure uses
  `ceil(ascii_chars / 4) + non_ascii_chars`, with zero for empty input and a bounded LRU cache.
- Node accepts the legacy flat or sectioned compaction settings. In particular,
  `[memory].enabled` maps to `memory_enabled`, `[context]` owns compaction fields, and an empty
  user `compaction_l4_trigger_ratios_by_model` table falls through to the project table.
- The runtime commits queued steers before compaction. The reserved user history id and committed
  queue ids define the fresh suffix; the complete current turn is excluded from summary input.
- Before summary provider IO, persist an `in_progress` checkpoint with a deterministic request
  fingerprint. A completed checkpoint increments `window_number`; `history_item_count` is the raw
  durable history length, not provider-projection length.
- The local summary request output budget is
  `min(model_max_output, max(4096, compaction_l4_expected_summary_tokens))` when a model output
  limit exists, otherwise `max(4096, compaction_l4_expected_summary_tokens)`. The 4096-token floor
  leaves room for reasoning-model internal tokens while the generated summary remains bounded.
- A successful compact uses one `commitCompaction()` transaction for replacement messages,
  summary, completed checkpoint, and Responses continuation invalidation. Raw history and rollouts
  are never deleted.
- Resume treats display history and provider history as independent projections. Display replay
  filters all raw history without injecting `compaction_boundary.replacement_messages`; provider
  replay selects the newest valid boundary replacement and appends only later conversation rows.
  Multiple completed boundaries therefore preserve old visible turns without stacking old summary
  windows into the next provider request.
- Rehydration reuses the M4 real-workspace read policy, prefers successful Edit/Write/Patch paths
  over Read paths, excludes runtime state and plan prefixes, and enforces file count, item-token,
  total-token, byte, UTF-8, binary, and symlink bounds.
- `compaction.started` is published only after the trigger enters compaction.
  `compaction.completed` is published after a successful compact commit, a minimum-savings skip,
  or a summary-generation failure/interruption. Failed summaries report `status=failed` with
  unchanged before/after token counts so the TUI closes the running lifecycle item. A commit
  failure does not publish completion because durable replacement state is uncertain.
- Each successful provider step with usage emits internal `provider_usage`. During an active turn,
  `status.changed.context_window` prefers this latest step and reports `source=provider_live`.
  Before the first live usage, a prior rollout is labeled `source=provider_previous`; it must not
  be presented as current-turn usage.
- Compaction lifecycle events temporarily project their before/after counts with
  `source=runtime_estimate`; the next provider usage replaces that estimate. The TUI keeps the
  existing footer layout and renders estimates with `~` and previous-turn values with `prev`.

### 4. Validation & Error Matrix

- Non-finite, fractional, negative, or out-of-range compaction settings -> bounded
  `config_error` before provider IO.
- `compaction_token_limit > max_prompt_tokens` or rehydration item budget above total budget ->
  bounded `config_error`.
- Existing `in_progress` checkpoint -> delete the stale attempt, return `interrupted`, and send no
  summary request.
- Aborted summary request -> clear the current attempt, publish failed completion, return
  `interrupted`, and do not continue the provider turn.
- Empty, over-budget, tool-calling, incomplete, or failed summary -> keep the prior provider
  projection and publish failed completion with no raw provider error detail.
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
- Bad: derive `history_item_count` from compacted provider items; replay would append raw history
  from the wrong offset.
- Bad: publish `compaction.completed` before SQLite commit; the TUI would display state that cannot
  survive restart.

### 6. Tests Required

- Config tests for resolved defaults, sectioned memory/context fields, model-ratio precedence,
  finite ranges, threshold/window relation, and rehydration budget relation.
- Token tests against the fixed `o200k_base` corpus, fallback estimator, and LRU bound.
- Coordinator tests for fresh suffix exclusion, tail bounds, minimum savings, raw history
  preservation/count, window increment, provider summary validation, abort classification,
  stale in-progress recovery, commit failure, and secure bounded rehydration.
- Storage and gateway tests for multiple completed boundaries, latest-window provider replay,
  complete filtered transcript visibility, hidden replacement payloads, and pagination beyond the
  bounded session snapshot.
- Runtime tests for queue-before-compact ordering, config-per-turn coordinator creation,
  zero-event overflow retry, continuation invalidation, and no retry after provider output.
- Gateway tests must parse both lifecycle payloads through the canonical event validator.
- Gateway and TUI tests must accept `compaction.completed(status=failed)` and close the running
  compaction item without changing provider history.
- Backend integration tests assert the summary request receives the resolved 4096-token default
  budget rather than the former 600-token hard-coded cap.
- Run full Node build/test/lint/typecheck/contracts gates plus M4 integration regressions.

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

#### Wrong: Leave a failed summary lifecycle open

```typescript
catch {
	return result("failed", originalHistory, beforeTokens);
}
```

#### Correct: Close the failed lifecycle without replacing history

```typescript
catch {
	emit(completedEvent("failed", beforeTokens, beforeTokens));
	return result("failed", originalHistory, beforeTokens);
}
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
- Backend integration uses real SQLite and a fake HTTP provider to assert schema-v2 snapshot output,
  workspace memory composition, and complete continuation fields.
- Gateway queue tests assert reservation before removal and at-most-one terminal drain.
- Run core/runtime/app tests, M4 integration, lint, typecheck, contracts drift, and build.

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

## Scenario: M5 Node Recovery Fault Injection

### 1. Scope / Trigger

- Trigger: changes to M5 session state serialization, recovery ordering, SQLite transactions,
  transcript snapshots, workspace memory writes, or session generation commits.
- Fault injection must exercise the real owning store or coordinator instead of a duplicate
  test-only state machine.

### 2. Signatures

- Frozen audit fixture: `tests/fixtures/node_runtime_m5/state_recovery_contract.json`.
- Runtime injection: `RuntimeFailpointHook = (name: RuntimeFailpoint) => void` on queue, approval,
  compaction, memory, and session coordinators. The default hook is a no-op.
- Storage injection: `SQLiteSessionStoreOptions.stateFailpoint(name)` covers reservation and
  transaction-internal state boundaries.

### 3. Contracts

- Node storage/runtime tests cover catalog/replay/summaries, pending and reconciled queues, waiting and
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
- Failure before reservation/save/prepare -> zero new durable records and no publication.
- Failure after effect claim -> one `effect_outcome_unknown` result, zero tool retries.
- Failure after tool result append inside its SQLite transaction -> roll back result and
  checkpoint together, then recover one unknown result.
- Failure before snapshot rename -> prior complete snapshot remains readable.

### 5. Good/Base/Bad Cases

- Good: inject after queue save, reopen from the durable snapshot, and observe one pending record
  with no pre-crash publication.
- Good: write compatible unknown fields through the Node store, reload them, and report only a
  `preserved=true` structural assertion.
- Base: with no failpoint callback, normal runtime behavior and event ordering are unchanged.
- Bad: catch an injected crash as an ordinary summary failure and delete its in-progress
  checkpoint; restart could resend an already completed provider request.
- Bad: print raw state, prompt, provider output, memory content, endpoint, or credentials from test
  diagnostics.

### 6. Tests Required

- The M8 audit must continue checksum-verifying the frozen sanitized fixture.
- Storage tests assert before/after reservation, queue history/removal rollback, approval
  suspension/result rollback, compact rollback, orphan interruption, and one synthetic unmatched
  tool result.
- Runtime tests assert queue publication ordering, approval/effect recovery, filesystem-commit
  ambiguity, no compaction-summary replay, snapshot rename preservation, memory topic/index
  recovery, and session generation isolation.
- Run storage/runtime package tests, lint, typecheck, contracts drift, and the M4/M5 regression
  gates.

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

## Scenario: Node-Owned Persistent Shell And Native PTY Lifecycle

### 1. Scope / Trigger

- Trigger: changes to Node shell tools, process transport, approval/sandbox enforcement,
  background-process RPCs, shell lifecycle persistence, backend shutdown, `node-pty`, or the M6
  live smoke.
- The process owner spans provider, runtime, tool, storage, gateway, and TUI boundaries. A shell
  must outlive one provider tool call without becoming global or crossing session ownership.

### 2. Signatures

- Backend composition:
  `startNodeBackend({cwd, env, args, maxOutputTokens?}) -> Promise<NodeBackend>`.
- Process owner:
  `ShellSessionManager.start(request)`, `interact(request)`, `resize(owner, shell, rows, columns)`,
  `terminate(owner, shell)`, `terminateOwner(owner)`, `list(owner)`, and `close()`.
- Transport boundary:
  `startPipeTransport(request)` for `tty=false`; `startNodePtyTransport(request)` for `tty=true`.
- Provider tools: visible `Shell` and `WriteStdin`; hidden compatibility routes `Bash`,
  `ShellOutput`, `BashOutput`, and `KillShell`.
- Gateway control: `shell.list`, `shell.stop`, `shell.stop_all`; command routes `/ps` and `/stop`.
- Lifecycle events: `shell.started`, `shell.output`, `shell.completed`, `shell.removed`, and
  `shell.list.updated`; each may carry the optional bounded display-only `description` from the
  originating `Shell` call.
- Durable history item: `type="shell_session"` with bounded sanitized metadata and output.
- TUI command projection:
  `commandDisplayLines(command, headerPrefix, suffix, width) -> string[]`, with two continuation
  rows before an omission row.
- Verification commands: `npm run test:m6` and, only after offline gates, `npm run smoke:m6`.

### 3. Contracts

- One `ShellSessionManager` is created by `startNodeBackend` and shared by every runtime binding
  for that backend. It is not created per turn, per tool call, or as a mutable global singleton.
- Approval and execution-policy checks complete before `manager.start()` reserves or spawns a
  process. The durable M5 effect claim still precedes process creation, so ambiguous recovery
  reports `effect_outcome_unknown` and never replays a spawn.
- `tty=false` uses the native pipe transport. `tty=true` uses `node-pty` and reports
  `unix_pty` on macOS/Linux or `windows_conpty` on Windows. PTY startup failure does not fall back
  to pipe.
- The exact `node-pty` dependency remains pinned to `1.2.0-beta.15` until packed-install and native
  lifecycle lanes approve a replacement. Stable `1.1.0` is not acceptable because its verified
  macOS ARM64 package installed `spawn-helper` without execute permission.
- A foreground process may complete or atomically yield into the background without respawn or
  cursor reset. `WriteStdin` accepts non-empty input only for PTY/ConPTY, uses empty input as a
  bounded poll, and maps the interrupt character to process interruption.
- Default `Shell` and `WriteStdin` model results are bounded to 2,000 characters per call, including
  response metadata and the head/tail truncation marker. Model-requested `max_output_tokens` may
  lower but must not raise that default. Each poll returns only output newer than the model cursor;
  retained incremental results still accumulate in provider history until compaction.
- Manager methods require `ownerSessionId`. A session cannot list, read, write, resize, interrupt,
  or stop another session's shell.
- `read-only` and `workspace-write` require the platform sandbox wrapper/helper and fail with
  `sandbox_unavailable` when it cannot be applied. `full-access` maps explicitly to
  `danger-full-access`; there is no implicit unsandboxed fallback.
- Lifecycle payloads and durable `shell_session` metadata may contain only bounded structural
  fields such as shell id, state, transport, TTY/yield flags, sequence, timestamps, counters,
  terminal state, exit code, cleanup result, sanitized command preview, and bounded output.
  Diagnostics exclude raw command, stdin, environment values, provider payloads, and secrets.
- The optional Shell `description` travels through the in-memory session snapshot, live lifecycle,
  gateway notification, and active-background bootstrap only. The durable `shell_session` snapshot
  must omit it; the canonical tool call already owns provider replay, and restart/resume must not
  synthesize a second description-bearing transcript record.
- The collapsed Shell card renders the complete retained command preview when it fits the terminal.
  It wraps by terminal cell width, keeps the first row beside `Running` or `Ran`, renders at most two
  `  │ ` continuation rows, and only then emits `  │ … +N lines`. It must not apply a fixed
  character limit such as 72 characters before width-aware wrapping. Global tool-detail expansion
  continues to render every retained logical command line.
- A Shell description is model-supplied runtime metadata and must not replace or duplicate the
  command in the TUI. Collapsed and expanded headers always render `Running <command>` or
  `Ran <command>` with the same width-aware bounds whether or not a description exists. Expanded
  detail continues to render the complete `Command:` block.
- Shell command continuations, terminal status, retained output, and expanded command details share
  one cell-relative gutter: continuation rows use `  │ `, the first result row uses `  └ `, and
  later result rows use four spaces. A component-level horizontal padding must be applied equally
  outside those prefixes; it must not be encoded into only one branch.
- Top-level transcript headers for assistant messages, generic tools, collapsed context groups,
  file changes, and Shell `Running` / `Ran` rows place their `•` marker in the same component-relative
  column. Shared transcript-gutter constants own the zero-cell header indent, two-cell branch
  indent, and four-cell detail indent; individual tool components must not add a private leading
  cell.
- A collapsed-output omission is a subsequent output row, not a card-level notice. Render it between
  the retained head and tail as `    … +N lines (ctrl+t to view transcript)`, using the configured
  `app.transcript.open` binding. `Ctrl+O` remains the main-view tool-detail toggle. Apply the same
  placement and prefix whether `N` comes from viewport truncation or persisted `hiddenLineCount`
  metadata.
- Backend close aborts the active turn, terminates every owned live process tree, closes each
  transport, drains lifecycle persistence, and only then closes SQLite. Historical records remain
  durable, but live OS processes are never reconstructed after restart.
- The M6 live smoke uses `gpt-5.5`, Responses, a disposable home/workspace/session, zero retries,
  `maxOutputTokens=64`, and one 30-second deadline. It persists trust, selects full access,
  approves one PTY launch, completes it through `WriteStdin`, verifies cleanup/persistence and
  `python_started=false`, and prints one structural JSON line only.

### 4. Validation & Error Matrix

- Missing required sandbox wrapper/helper -> `sandbox_unavailable`; spawn count remains zero.
- `tty=true` plus unavailable/broken native PTY -> explicit shell failure; do not retry with pipe or
  another runtime.
- Unknown shell id -> `shell_not_found`; wrong owner -> `shell_session_forbidden`.
- Input after terminal completion -> `shell_already_completed`.
- Shell or WriteStdin requests an output budget above the default -> clamp the model-visible result
  to 2,000 characters while retaining the original/omitted output counters.
- Retained command fits the available terminal width -> show it completely with no omission marker.
- Wrapped command exceeds the two-row continuation budget -> show the first two continuation rows
  plus an omission row with the hidden visual-row count; expanded detail remains complete.
- Description present -> preserve it across subsequent output/completion events for that live
  process, but render the same command-first Shell cell as the no-description path.
- Description absent or unavailable after durable resume -> render the existing command title and
  do not reconstruct description metadata from persisted shell snapshots.
- Completed output exceeds the five-row budget or carries `hiddenLineCount` -> retain head and tail,
  place one omission row between them, and align its ellipsis with subsequent output text.
- Resize on pipe or closed terminal -> `shell_resize_failed`.
- Timeout -> terminal `timed_out`; interrupt -> `interrupted`; targeted/global stop -> `killed`.
- Backend/gateway close with live children -> terminate the complete owned process tree and publish
  terminal lifecycle before store close.
- Orphaned claimed effect on restart -> one `effect_outcome_unknown` result and zero process
  launches.
- Missing live-smoke credentials, official endpoint selection, or unavailable compatible service
  -> one sanitized summary and exit `77`. Successful structural smoke -> `0`; completed provider
  flow with failed structural assertions -> `1`; invalid arguments -> `64`.

### 5. Good/Base/Bad Cases

- Good: approve one `Shell(tty=true)`, observe one PTY start and yield, send input through
  `WriteStdin`, observe one completion, persist one shell transcript, and close with zero active
  shells.
- Good: an empty `WriteStdin` polls only output newer than the model cursor while lifecycle and
  model cursors remain independent.
- Base: a short `tty=false` command completes through pipe without entering the background list.
- Base: a command longer than 72 characters remains fully visible on a wide terminal.
- Good: a multiline or narrow-terminal command wraps under a stable `  │ ` gutter and only hides
  rows after the Codex-style continuation budget is exhausted.
- Good: a weather preview renders `  └ <head>`, then `    … +17 lines (...)`, then
  `    <tail>` with the omission and tail starting in the same terminal column.
- Bad: create a manager inside `NodeTurnRuntime` or a tool adapter; yielded processes disappear
  when the provider step ends or a session binding is recreated.
- Bad: catch native PTY failure and retry through another transport/runtime; the command may run
  with different semantics or be duplicated.
- Bad: print an endpoint, API key, prompt, command, stdin, provider text, raw shell output, or local
  path from the live smoke.
- Bad: call a fixed-length `shortPreview(command)` before terminal layout; ordinary commands become
  unreadable even when the viewport has enough space.

### 6. Tests Required

- Tools unit tests cover bounded output/cursor eviction, invalid UTF-8 replacement, environment,
  approval proposals, owner isolation, yield/poll/input/resize, timeout, interrupt, targeted stop,
  capacity eviction, lifecycle ordering, default 2,000-character Shell/WriteStdin model output, and
  close cleanup with fake transports.
- Native integration tests cover pipe IO/process trees plus Unix PTY or Windows ConPTY input,
  resize, interrupt, exit, and orphan cleanup on Node 22.19 and Node 24.
- Backend integration uses a fake Responses provider to assert approval before spawn, exactly one
  PTY start/completion, `WriteStdin`, `max_output_tokens=64` on every request, durable shell state,
  and shutdown cleanup.
- Smoke tests assert missing credentials exit `77`, fake-provider success uses exactly three
  provider requests, stdout is exactly one JSON line, stderr is empty, and secrets/endpoints/
  commands/stdin/provider output do not appear.
- Node tests assert output buffers, decoder behavior, model result bounds, and permission profiles;
  the M8 audit checksum-verifies the sanitized M6 corpus.
- TUI component tests cover short commands, commands over 72 characters on wide terminals,
  multiline commands, very long single-line commands, exact omission counts, expanded full detail,
  CJK/long-token width safety, and equal terminal columns for continuation `│` and result `└`
  gutters, including truncated running output. Completed-output tests assert both viewport-derived
  and persisted omission markers remain between retained head/tail rows and share the tail column.
- Cross-layer description tests cover trimmed Shell input, in-memory session/lifecycle forwarding,
  schema-valid gateway events, active-background bootstrap, reducer preservation, command-first
  collapsed and expanded rendering, and omission from durable shell snapshots.
- TUI component tests assert assistant, generic-tool, collapsed-group, file-change, and Shell
  top-level markers begin in the same component-relative column.
- Run `npm run contracts:check`, `npm run typecheck`, `npm run lint`, `npm run test:m5`,
  `npm run test:m6`, `npm test`, `npm run smoke:package`, and `git diff --check` before one
  authorized `npm run smoke:m6`.

### 7. Wrong vs Correct

#### Wrong

```typescript
const runtime = new NodeTurnRuntime({
	toolRouter: shellRouter(new ShellSessionManager({ transportFactory: startPipeTransport })),
});
// A tty request silently receives pipe semantics and the manager dies with the runtime binding.
```

#### Correct

```typescript
const shellManager = new ShellSessionManager({
	transportFactory: (request) => request.tty
		? startNodePtyTransport(request)
		: startPipeTransport(request),
});
const runtime = new NodeTurnRuntime({ toolRouter: shellRouter(shellManager) });
await gatewayClose({ shellManager, drainLifecycle, closeStore });
```

Shell command layout is width-aware before it is bounded:

```typescript
const segments = wrapTextWithAnsi(command, availableWidth);
const shown = segments.slice(0, 3);
return segments.length > shown.length
	? [...shown, `  │ … +${segments.length - shown.length} lines`]
	: shown;
```

## Scenario: Codex-Style Full Transcript Viewer

### 1. Scope / Trigger

- Trigger: changes to Shell lifecycle output, readable transcript projection, `shell.output.load`,
  terminal alternate-screen ownership, `app.transcript.open`, or transcript viewer rendering.
- The viewer is a local diagnostic projection. Full Shell output must not become provider input or
  enlarge ordinary session bootstrap payloads.

### 2. Signatures

- Database table:
  `shell_output_chunks(session_id, shell_id, call_id, event_sequence, cursor_start, cursor_end,
  omitted_before, output_text)` with primary key `(session_id, shell_id, event_sequence)`.
- Shared chunk bound: `SHELL_LIFECYCLE_OUTPUT_CHUNK_MAX_CHARS=16_384` in `@mycli/core`.
- Storage reader:
  `loadShellOutputPage({sessionId, shellId, callId?, afterSequence?, limitChars?}) -> ShellOutputPage`.
- Gateway RPC:
  `shell.output.load({session_id?, shell_id, call_id?, after_sequence?, limit_chars?})`.
- TUI loader:
  `loadFullShellOutput(send, {sessionId, shellId, callId?}) -> MycliShellTranscriptOutput`.
- Terminal lifecycle:
  `enterAlternateScreen()`, `leaveAlternateScreen()`, `captureScreen()`, and `restoreScreen(snapshot)`.
- Viewer entry:
  `MycliShellRuntime.showTranscriptViewer()` through `app.transcript.open` / `Ctrl+T`.

### 3. Contracts

- The inline Shell card keeps a bounded head/tail output projection. `Ctrl+O` toggles retained
  main-view tool details; `Ctrl+T` opens the independent full-session viewer.
- The viewer enters the alternate screen, owns input while open, renders canonical committed
  transcript blocks plus the current live tail, and restores the captured inline render baseline
  and editor focus on every close path.
- `Esc` and `q` close. Arrows and `j`/`k` move one line; PageUp/PageDown move one viewport; Home/End
  and `g`/`G` jump to the start/end. Resize reflows at the new cell width without resuming tail
  following after a user has scrolled away. Live appends remain visible only while following tail.
- Reaching the current top with Up/PageUp/Home/`g` requests the next older transcript page only when
  `next_before` is present. The viewer renders bounded loading/failure state, suppresses concurrent
  requests, prepends successful pages, and keeps the previously visible rows stationary.
- Shell manager output-event bounds split one retained output read into multiple consecutive
  lifecycle events. They must not discard characters merely because one 50 ms batch exceeds the
  shared per-event/persistence chunk bound. Only output evicted from the manager's bounded buffer
  is omitted; manager configuration above the shared maximum is rejected at construction.
- The lifecycle projector persists each non-empty `outputDelta` as one append-only chunk in the same
  transaction as the bounded `shell_session` snapshot, before publishing the event to listeners.
- `shell.output.load` is paginated by event sequence. A non-terminal page returns
  `next_after_sequence` equal to its last chunk sequence; chunk cursors and sequences are monotonic.
  Cursor gaps and incomplete aggregate metadata produce visible unavailable-output markers.
- Full output is fetched only after the viewer opens. It is absent from `transcript.load`,
  `session.bootstrap`, readable bounded snapshots, provider transcript replay, and model input.
- A session without chunk rows returns `available=false`; the viewer keeps its bounded saved output
  and renders an explicit older-session notice instead of claiming the output is complete.
- `shell_output_chunks` rejects updates. Session deletion may cascade to its diagnostic chunks under
  the existing storage-retention boundary.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Missing/invalid `shell_id`, cursor, or page limit | Gateway `invalid_params`; no storage read |
| Runtime has no Shell output reader | Gateway `unavailable_feature` |
| No chunk rows for the requested Shell | Empty page, `available=false`, `complete=false` |
| Duplicate event sequence or chunk update | SQLite constraint/append-only failure; preserve prior rows |
| Shell lifecycle event bound exceeds 16,384 characters | Reject manager configuration before execution |
| Chunk cursor range does not equal output length | Reject before persistence or viewer assembly |
| Page cursor stalls, regresses, or differs from its last chunk sequence | Abort hydration with a bounded viewer error |
| Persisted cursor gap or incomplete aggregate totals | Render an explicit unavailable-output marker |
| Viewer closes, runtime shuts down, or PTY exits | Leave alternate screen once and restore normal terminal state |

### 5. Good/Base/Bad Cases

- Good: a 100 KiB command result stays compact inline, opens complete in `Ctrl+T`, and never appears
  in the next provider request.
- Good: a large output burst becomes several ordered lifecycle chunks with continuous cursors.
- Base: an older session shows its saved tail plus an explicit full-output-unavailable notice.
- Bad: include chunk rows in session bootstrap so the viewer opens without an RPC.
- Bad: truncate a lifecycle batch to the newest 4,096 characters and label the discarded prefix as
  a storage gap even though it was still retained by the Shell manager.
- Bad: leave `?1049h` active after `Esc`, shutdown, an exception, or PTY completion.

### 6. Tests Required

- Tools tests assert oversized lifecycle batches split into ordered deltas with continuous
  `nextCursor` values and zero false omissions.
- Runtime/storage tests assert snapshot-plus-chunk transaction ordering, append-only failures,
  schema migration, pagination, call filtering, cursor gaps, and bounded normal history.
- Gateway tests assert RPC catalog presence, payload mapping, defaults, invalid parameters, and no
  eager inclusion in bootstrap/transcript responses.
- TUI tests cover `Ctrl+T`, `Esc`/`q`, focus restoration, line/page/start/end navigation, live-tail
  following, manual-scroll retention across resize, legacy fallback, and on-demand hydration.
- PTY smoke asserts one ordered `?1049h` / `?1049l` pair while native scrollback, final frame,
  bracketed paste, cursor visibility, and clean exit remain intact.

### 7. Wrong vs Correct

#### Wrong

```typescript
const outputDelta = retained.slice(-OUTPUT_EVENT_MAX_CHARS);
bootstrap.shell_output = store.loadAllShellOutput(sessionId);
```

#### Correct

```typescript
for (const outputDelta of splitRetainedOutput(retained, OUTPUT_EVENT_MAX_CHARS)) {
	publishShellOutput({ outputDelta, nextCursor: cursor += outputDelta.length });
}
const fullOutput = await send("shell.output.load", pageRequest); // Viewer only.
```

## Scenario: Node Integration Composition And Session-Owned Subagents

### 1. Scope / Trigger

- Trigger: changes to Node integration composition, extension tool approval metadata, the
  `spawn_agent` / `send_message` / `followup_task` / `wait_agent` / `interrupt_agent` /
  `list_agents` tools, durable child-task ownership, `subagent.updated`, or TUI
  consumers of generated gateway event types.
- This is a cross-layer contract spanning tool execution, integrations, SQLite task records, the
  gateway, generated contracts, and the existing TUI task surfaces.

### 2. Signatures

- Composition:
  `createRuntimeIntegrationComposition(options) -> Promise<RuntimeIntegrationComposition>`.
- Tool execution ownership:
  `ToolExecutionOptions = {ownerSessionId: string, ownerTurnId?: string, ...}`.
- Child start:
  `SubagentControlContract.start({parentSessionId?, parentTurnId?, prompt, ...})`.
- Codex-style spawn:
  `AgentCoordinationControlContract.spawnAgent({ownerSessionId, ownerTurnId?, taskName, message, forkTurns?})`.
- Internal projection:
  `{parent_session_id, run_id, child_session_id, role, status, summary, progress}`.
- Public notification:
  `subagent.updated({subagent: {run_id, child_session_id, role, status, summary, progress}})`.
- TUI reducer:
  `reduceRuntimeEvent(state, method, input: object) -> RuntimeShellState`.

### 3. Contracts

- Integration sources start in `skill -> mcp -> plugin -> subagent` order. Closable sources stop in
  reverse order, shutdown is idempotent and bounded, and partial startup failure closes every source
  that already initialized.
- Interactive runtime startup may reuse a bounded, short-lived MCP tool catalog keyed by a
  digest of the complete effective server configuration. Cache records contain descriptors and the
  digest only; they never persist resource URIs, endpoints, commands, arguments, headers,
  environment values, or credentials in recoverable form. `mcp list|inspect` and doctor remain live
  probes and never use the interactive startup cache.
- Interactive startup never waits for MCP network discovery. A valid cache snapshot is exposed
  immediately; a missing, expired, malformed, oversized, or configuration-mismatched cache starts
  with no MCP routes. In both cases live discovery runs in the background, starts servers
  concurrently, and requests each server's tools and resources concurrently.
- A successful live result atomically replaces only the MCP portion of the integration snapshot and
  emits one direct `extension.updated({version})` notification. The TUI coalesces that notification,
  refreshes `extension.manifest` and `resource.list`, and appends no transcript item. A failed live
  refresh retains a valid cached MCP snapshot when one exists, otherwise it publishes only bounded
  diagnostics. Shutdown aborts discovery, awaits every started cache-load/live-refresh promise,
  and closes every initialized client. `close()` must not resolve while a refresh can still create
  or replace cache files, publish a snapshot, or register a client.
- Provider-visible definitions, tool-search candidates, approval metadata, adapter routes, and
  parallel-call capability are frozen together at turn start. A background MCP refresh affects the
  next turn only; it cannot change schemas or adapters inside a running or approval-suspended turn.
- The built-in manifest stays immutable. The combined manifest rejects duplicate provider routes
  before a turn can execute and does not create a `runtime <-> integrations` package cycle.
- Extension approval policy is explicit. Skill and local subagent control tools are auto-allowed;
  MCP and plugin tools request one-time approval; an extension route absent from registered approval
  metadata fails closed.
- `NodeTurnRuntime` and approval continuation both pass the executing session and turn through
  `ToolExecutionOptions`. Every coordination adapter, including `spawn_agent`, forwards those
  values instead of using the backend startup session or a placeholder turn id.
- Each child freezes its parent session at start. Reservation, factory input, progress, completion,
  failure, interruption, mailbox delivery, and shutdown cleanup use that same owner.
- Child runtimes reuse the real Node runtime through `ChildRuntimeFactory`, inherit the parent's
  currently exposed tools, and remove coordination routes only when the configured depth disallows
  descendants. No agent profile can override model, prompt, tool scope, or budget.
- Internal subagent updates carry `parent_session_id` only for gateway filtering. The gateway drops
  stale-session events, strips the ownership field, bounds every public field, and never projects raw
  child reports, provider payloads, tool output, or private process data.
- Canonical `subagent.updated` schemas remain closed with `additionalProperties: false`. Generated
  TypeScript event parameter interfaces therefore need not satisfy `Record<string, unknown>`.
  Generic consumers accept `object` or `unknown` and normalize at their dynamic inspection boundary;
  they must not loosen the schema or add unsafe casts merely to obtain an index signature.

### 4. Validation & Error Matrix

- Source startup throws -> close initialized sources in reverse order, then return
  `integration_start_failed` without the raw exception.
- MCP catalog cache read/write fails -> continue with live discovery or the already discovered live
  result; cache failure never disables MCP or fails runtime startup by itself.
- Shutdown races an in-flight MCP cache save -> abort discovery, wait for that save promise to
  settle, then finish client cleanup; no cache write may begin or complete after close resolves.
- Duplicate source id -> `duplicate_integration_source`; duplicate tool route ->
  `duplicate_tool_route`; neither may mutate the built-in manifest.
- Unknown extension approval route -> deny before adapter execution.
- Child message with a mismatched root session -> typed unavailable/forbidden result, with no child
  handle call and no cross-session record exposure.
- Parent shutdown with a running child -> abort, persist interruption with the child's frozen owner,
  close within the configured bound, and remain idempotent.
- Internal update owner differs from the active resumed session -> drop the event. Missing/invalid
  required public fields -> do not emit `subagent.updated`.
- Public subagent event contains an undeclared field -> canonical contract validation fails.
- A newly generated closed event parameter type lacks a string index signature -> fix the generic
  consumer boundary; do not change `additionalProperties` to make TypeScript compile.

### 5. Good/Base/Bad Cases

- Good: resume session B, call `spawn_agent`, persist the child under B and its real parent turn, deliver
  output/messages only through B, and emit running/completed updates only while B is active.
- Good: an old background child from session A completes after resuming B; its durable A record is
  updated but its UI event is filtered from B.
- Base: no MCP/plugin config exists; built-in skills and prompt-driven subagent controls still
  compose, and close remains a no-op-safe ordered lifecycle.
- Good: close begins while an empty-config refresh is saving its catalog; close stays pending until
  save settlement, then no later filesystem activity occurs.
- Bad: keep `parentSessionId` only in controller constructor state; children started after resume are
  persisted under the backend's original session.
- Bad: expose `parent_session_id`, child report text, or provider response fields in
  `subagent.updated`.
- Bad: add `[key: string]: unknown` or open `additionalProperties` to a security-bounded event solely
  because a generic reducer expects `Record<string, unknown>`.
- Bad: make temporary-directory cleanup retry `ENOTEMPTY` while the owner still permits refresh work
  after `close()` resolves.

### 6. Tests Required

- Composition tests assert deterministic start/reverse-close, idempotent bounded shutdown, partial
  failure cleanup, built-in manifest immutability, collision rejection, and package DAG direction.
- MCP manager tests assert cross-server and per-server discovery concurrency, deterministic result
  order, cache hit without directory RPCs, configuration/TTL/corruption invalidation, private file
  permissions, absence of endpoint/header/environment secret values from cache content, and that
  close waits for an explicitly held in-flight cache save.
- Backend startup tests hold an uncached MCP server open and assert `runtime.ready` arrives before
  discovery completes; shutdown must abort and clean the background client. Tool/runtime tests
  assert old and new turns retain their matching MCP catalog, route, and approval snapshot.
- Runtime/tool tests assert `ownerSessionId` and `ownerTurnId` on ordinary execution and approval
  continuation, plus `spawn_agent` forwarding into the supervisor.
- Controller tests use real SQLite task storage to assert dynamic session/turn ownership across
  start, progress, terminal state, output, messaging, interruption, and close.
- Backend integration runs a real parent/child/parent provider sequence, asserts the child sees only
  its frozen tools, checks durable parent ownership, and proves execution stays in the worker pool.
- Gateway/contract tests assert bounded `subagent.updated`, stale-session filtering, undeclared-field
  rejection, resource/command projection, and no raw child report/provider payload.
- TUI tests assert one existing task row updates in place and actions route by child session id.
- Run a fresh contracts build before TUI build/typecheck so closed generated interfaces cannot be
  hidden by stale `dist` declarations.

### 7. Wrong vs Correct

#### Wrong

```typescript
const parentSessionId = controllerOptions.parentSessionId;
store.updateProgress({ taskId, parentSessionId, childSessionId, sequence, summary });

// Weakening the public schema only to satisfy a generic consumer is also wrong.
const params: Record<string, unknown> = event.params as Record<string, unknown>;
```

#### Correct

```typescript
const parentSessionId = input.parentSessionId?.trim() || controllerOptions.parentSessionId;
const owned = { taskId, parentSessionId, childSessionId };
store.updateProgress({
	taskId: owned.taskId,
	parentSessionId: owned.parentSessionId,
	childSessionId: owned.childSessionId,
	sequence,
	summary,
});

export function reduceRuntimeEvent(state: RuntimeShellState, method: string, input: object) {
	const params = Object.fromEntries(Object.entries(input));
	if (method === "subagent.updated") return applySubagentUpdate(state, params);
	return state;
}
```

Background work is part of owner shutdown:

```typescript
// Wrong: close can return while refresh is still persisting cache state.
async function closeAll() {
	await closeClients();
}

// Correct: cancellation happens at the composition boundary, then manager close drains started work.
async function closeAll() {
	await Promise.allSettled([
		...(cachePromise ? [cachePromise] : []),
		...(refreshPromise ? [refreshPromise] : []),
	]);
	await closeClients();
}
```

## Scenario: Node Subagent Interactive Continuation

### 1. Scope / Trigger

- Trigger: changes to child approval or clarification suspension, child runtime continuation,
  gateway response routing, TUI interactive request state, or subagent terminal projection.

### 2. Signatures

- Broker open:
  `openTurn({sessionId, agentPath, workerName, runtime, signal, emitLifecycle, emitRuntime})`.
- Broker ownership snapshot:
  `pending() -> readonly AgentInteractiveRequestSnapshot[]` in stable registration order.
- Internal cancellation lifecycle:
  `interactive.cancelled({session_id, child_session_id, generation, client_turn_id, turn_id,
  decision_id | request_id})`.
- Approval request/response identity:
  `{session_id, child_session_id, generation, decision_id, client_turn_id, turn_id}`.
- Clarification request/response identity:
  `{session_id, child_session_id, generation, request_id, client_turn_id, turn_id}`.
- Gateway presentation queue:
  `QueuedInteractiveRequest = {method, params, identity}` where identity contains request kind,
  session, generation, and decision/request id.

### 3. Contracts

- A child `approval_requested` or `clarification_requested` event transitions the agent thread to
  `waiting` while its durable subagent task remains `running`; it does not emit completion mail or
  any terminal `subagent.updated` event.
- The gateway and TUI preserve the child `session_id` and broker `generation` on the pending
  request. Responses route by that pair and resume the same resident child runtime and suspended
  turn, not a root runtime or a newly constructed child.
- Child mutation approvals preserve the same bounded `content_*` or `diff*` proposal fields as root
  approvals. The broker projects those fields to snake case without persisting another copy.
- A response may begin continuation before the initial suspended `submit()` returns
  `status=in_progress`. The broker treats that result as valid while continuation is active and
  waits for the continuation result.
- Only a completed, failed, or interrupted continuation terminalizes the child task and parent
  mailbox delivery. A continuation that suspends again must register another interactive request.
- The broker is the source of truth for child interactive ownership. It keeps at most one pending
  request per child session, publishes every newly registered request immediately, and replays all
  pending requests in insertion order to a new subscriber. It must not contain TUI visibility,
  current-request, or presentation-queue state.
- Root and child approval/clarification requests share one gateway FIFO presentation queue. Only
  the head is published to the TUI; a matching response removes it and publishes the next request.
  A later request must never overwrite an earlier unresolved request in the TUI's single selector.
- Approval and clarification selectors display a non-terminal `Submitting...` state while the
  response RPC is in flight. They display success only after the RPC resolves; rejection restores
  the choices so the user can retry instead of leaving a false `Approved.` or `Answered:` state.
- A waiting child that fails or is interrupted emits `interactive.cancelled` from the broker. The
  gateway removes the exact matching presentation entry before publishing the next request; queue
  cleanup must not be inferred from a later `subagent.updated` projection.
- Session resume consults the broker pending snapshot in addition to the presentation queue and is
  rejected while any agent request owns the terminal. Gateway close discards presentation state
  after unsubscribing from request producers.
- Spawn freezes the parent runtime's current execution-policy snapshot. A Full Access child keeps
  `permission=full-access`, `sandboxMode=danger-full-access`, `filesystem=unrestricted`, and enabled
  network, so ordinary permitted child tools do not emit approval requests.

### 4. Validation & Error Matrix

- Unknown child `session_id` -> `approval_not_pending` or `clarification_not_pending`.
- Stale or mismatched `generation` -> reject without consuming the current pending request.
- Wrong decision/request id or unsupported approval choice -> reject without resuming the child.
- `status=in_progress` with neither a pending request nor an active continuation ->
  `child_runtime_suspended_without_interactive_request`.
- Duplicate request identity -> keep the existing queue position and do not publish a second row.
- A second pending request from the same child session ->
  `agent_interactive_request_already_pending`; do not replace the original continuation.
- Approval or clarification response RPC rejection -> keep the request pending, restore selector
  input, and render the bounded gateway error; do not display success.
- Session resume with a queued child interaction -> `turn_in_progress`; preserve the active session
  and request ordering.
- Child failure or interruption while waiting -> broker removes ownership and publishes an exact
  internal cancellation; gateway removes only the matching request and advances without a
  synthetic user response.

### 5. Good/Base/Bad Cases

- Good: child Shell requests approval, TUI responds immediately, the initial suspended submit then
  returns, and the already active continuation completes the same child session.
- Base: one child waits for approval while another queued child waits for clarification; resolving
  the announced request publishes the next one without changing either child identity.
- Good: two children register synchronously; the broker publishes both independent requests, while
  the gateway exposes only the first to the shared selector and retains the second in order.
- Good: root and three children request Shell approval concurrently; the TUI shows one identified
  request at a time and advances exactly once after each accepted response.
- Good: a Full Access root spawns a child that runs Shell with the frozen unrestricted profile and
  produces zero approval events.
- Bad: mark the task failed as soon as the initial child submit returns `in_progress`, or route the
  approval to the currently active root session.
- Bad: replace the visible root approval with a later child approval, or lock the selector on
  `Approved.` before the gateway accepts the response.
- Bad: serialize requests inside both the broker and gateway, or remove broker ownership by
  observing an unrelated terminal UI projection.

### 6. Tests Required

- Broker unit tests cover normal approval, the response-before-suspended-submit race, independent
  child publication, ordered subscription replay, stale generations, exact cancellation, and
  same-runtime completion.
- Gateway and TUI tests assert child identity survives request projection and response submission.
- Gateway tests enqueue simultaneous root and child requests and assert only the head is published
  before its response, reject session resume while a child request is pending, and advance after a
  terminal child update; TUI tests reject approval and clarification responses and assert choices
  become actionable again.
- A backend integration test uses a real child Shell approval path and asserts `running` task plus
  `waiting` thread before approval, no terminal event, same child provider continuation, tool replay,
  and final completed report after approval.
- A Full Access backend integration asserts the persisted child spawn snapshot remains unrestricted,
  the real child Shell output reaches provider replay, and no approval event is emitted.

### 7. Wrong vs Correct

#### Wrong

```typescript
pendingApproval = latestApproval;
selector.showApproved();
void respondApproval(activeRootSessionId, decision);
```

#### Correct

```typescript
broker.register(childSessionId, pending);
gatewayPresentationQueue.push(pending);
await respondApproval({ sessionId: pending.childSessionId, generation: pending.generation, decision });
gatewayPresentationQueue.publishNext();
```

## Scenario: Node M7 Extension Gateway Surface And Ownership Boundary

### 1. Scope / Trigger

- Trigger: changes to Node `extension.manifest`, resource/command RPCs, integration composition,
  `subagent.updated`, extension shutdown, or the M7/M8 rollout boundary.
- M7 exposes Node-native integrations through the existing gateway; it does not introduce a second
  runtime loop or permit silent fallback after a Node turn is accepted.

### 2. Signatures

- `extension.manifest({}) -> {schema_version, agent, rpc_methods, event_streams, capabilities,
  tool_manifest?}`.
- `resource.list({}) -> {resources}`.
- `command.list({}) -> {commands}` and `command.run({command, arguments?}) -> CommandResult`.
- `subagent.updated({subagent: {run_id, child_session_id, role, status, summary, progress}})`.
- `createRuntimeIntegrationComposition(options) -> Promise<RuntimeIntegrationComposition>`.
- Shutdown: `RuntimeIntegrationComposition.close() -> Promise<void>`.

### 3. Contracts

- `extension.manifest` is provider-free and uses the generated gateway catalog as the source of RPC
  and event names. M7 requires `extension.manifest`, `resource.list`, `command.list`, `command.run`,
  and the `subagent.updated` stream to remain advertised and routable by the compiled Node CLI.
- `agent.runtime` is `node`. The optional `tool_manifest` is the frozen combined built-in/extension
  discovery view; requesting it does not execute tools or start a provider.
- Resource and command responses contain only bounded allowlisted display fields. They do not expose
  MCP headers/config argv, plugin environment, hook commands, raw tool output, provider payloads, or
  private child reports.
- Integration sources initialize in `skill -> mcp -> plugin -> subagent` order and close in reverse.
  Startup failure closes every initialized source; close is bounded and idempotent.
- For each hook point, the stable source order is built-in hooks, configured command hooks, then
  Plugin API v2 hooks. Argument modifications are chained in that order. A deny/error stops
  fail-closed points; post-operation points contain errors without rewriting persisted tool results.
- `subagent.updated` filters events whose internal `parent_session_id` is not the active resumed
  session, removes that internal owner field, and bounds the closed public payload before emission.
- M8 removed the runtime selector, and the current repository has only the Node implementation.
  Accepted turns never fall back across runtimes; rollback means installing an earlier npm release
  between turns.

### 4. Validation & Error Matrix

- Unknown gateway request -> `method_not_found`; invalid command/resource arguments ->
  `invalid_params` without provider startup.
- Duplicate integration source or tool route -> fail composition before a turn is accepted and close
  initialized sources.
- Resource/command provider throws -> return a bounded structured failure; do not emit raw exception
  text or partially mutate another source.
- Stale subagent parent session -> drop the public event while retaining its durable task update.
- Invalid/oversized subagent fields -> do not emit `subagent.updated`.
- Extension close timeout/failure -> continue reverse cleanup and keep shutdown idempotent.

### 5. Good/Base/Bad Cases

- Good: the compiled gateway lists a skill resource, MCP resource, plugin command, and subagent
  profile, then runs the extension chain through one Node-owned turn and closes all child processes.
- Base: no user extensions still exposes built-in skills/profiles and an empty bounded MCP/plugin
  management surface.
- Bad: hand-maintain a second list of M7 RPC/event names outside the generated catalog.
- Bad: publish internal parent ids, prompts, reports, commands, headers, endpoint data, or tool output
  in gateway extension payloads.
- Bad: catch a failed Node extension turn and transparently retry it through another implementation.

### 6. Tests Required

- Gateway tests assert catalog-backed manifest names, combined tool manifest projection, bounded
  resources/commands, command dispatch, stale-session filtering, and closed `subagent.updated` shape.
- Composition tests assert ordered startup/reverse close, partial-failure cleanup, route collision
  failure, package DAG direction, and built-in manifest immutability.
- Hook manager/runtime tests assert built-in/configured/plugin order, chained modifications,
  fail-closed pre-hook behavior, and contained post-hook errors.
- M7 integration drives Skill -> MCP -> plugin -> foreground Task -> final text, verifies durable
  context/tool/task records, and proves MCP/plugin cleanup.
- Packed smoke resolves M7 assets/dependencies and runs compiled management commands. CI config runs
  the M7 lifecycle gate on macOS/Linux/Windows with Node 22.19 and 24.

### 7. Wrong vs Correct

#### Wrong

```typescript
try {
	return await nodeRuntime.run(turn);
} catch {
	return fallbackRuntime.run(turn);
}
```

#### Correct

```typescript
return nodeRuntime.run(turn);
```

## Scenario: Node Slash Command Behavioral Contract

### 1. Scope / Trigger

- Trigger: adding or changing a retained slash command, its backing service, gateway RPC, TUI
  action, or persistence path.
- Registry names and dispatch metadata are discovery contracts, not proof of end-to-end behavior.

### 2. Signatures

- Node registry: `node-slash-command-registry.ts`.
- Node execution: `command.run`, command-specific RPCs, and TUI client actions.
- Model catalog: `provider.list` -> `model.list({provider})` -> provider-scoped TUI model selector
  -> `model.select({provider, protocol, model, base_url, reasoning_effort?, scope})` -> active
  session preferences, with user config mutation only for explicit `user` scope.
- Visual settings: TUI settings selector -> `settings.save` -> `saveShellSettings` ->
  `~/.mycli/config.toml`.

### 3. Contracts

- A retained command is complete only when its data source, argument semantics, validation, side
  effects, persistence, restart behavior, error behavior, and user-visible result agree across the
  Node service, gateway, and TUI paths.
- Metadata hashes may freeze command names, aliases, surfaces, and presentation, but must not be
  described as full behavioral evidence without end-to-end tests.
- Node `/model` resolves explicitly activated routes from `provider.list`; built-in route/model
  metadata comes from the lazily loaded, exactly pinned pi-ai catalog, and user `models.json`
  declarations override or extend only the exact owning route. Catalog-backed routes inherit new
  matching-protocol models by default; only `model_policy: "subset"` narrows a route. Discovery
  never creates or rewrites `models.json` merely because it is missing.
- `model.list` requires one validated activated route and returns `{provider, models}` for only that
  route, with the exact current entry first. Public payloads include selection metadata but exclude
  `auth_ref`, API keys, headers, and other credentials.
- `session.bootstrap` carries current provider/model status and auth readiness, but no global model
  catalog. The TUI stores a model array only together with its `modelsProvider` owner and replaces
  both from a matching `model.list` result.
- Opening bare TUI `/model` loads `provider.list`, resolves the current or explicitly preferred
  route, and immediately requests `model.list({provider})`. With no resolvable current route it opens
  the searchable provider list. A configured route without credentials remains visible and opens
  login before model traffic.
- While viewing or loading models, `tui.select.previousGroup` and `tui.select.nextGroup` load the
  adjacent provider directly. Esc opens the provider list when multiple routes are usable and closes
  the selector otherwise. Every load carries a generation; a late response for a superseded route
  is discarded without replacing the current provider's rows.
- `model.select` resolves `auth_ref` on the backend from the selected catalog entry, verifies the
  credential exists, and validates provider/protocol/base URL and supported reasoning effort before
  changing state. Scope is exactly `session` or `user`; missing scope defaults to `session`.
- `session` scope saves and activates only the current session preferences. `user` scope first
  atomically persists the complete model/request/reasoning group through the config package's
  lossless batch editor, then saves and activates the same current-session preferences and updates
  model defaults used by new sessions. It does not promote the active session's collaboration mode
  into the new-session default.
- `model.select` and `settings.save` pass the active session workspace, process environment, and
  persisted workspace-trust decision to the typed config writer. The gateway/TUI never submits TOML
  paths, credentials, or arbitrary tables.
- `settings.save` persists one complete normalized `ShellSettings` object. Its config wrapper owns
  camelCase/snake_case compatibility input and canonical root keys such as `view_mode`,
  `statusline_enabled`, `tui_statusbar_mode`, and `tui_theme`. It preserves unrelated TOML,
  comments, and newline style rather than serializing the complete user document.
- Bare TUI `/model`, direct `model.list`/`model.select`, and inline `/model <name>` share the same
  provider-scoped catalog and exact-identity selection path. Enter on a model is the common path: it
  submits session scope with the catalog's valid default reasoning effort, or the first supported
  effort when no valid default exists. `tui.select.options` (Tab by default) opens reasoning when
  applicable and then the scope stage, where the user can make the selection their user default.
  Inline `/model <name>` searches only the active provider and is session-local; it never falls back
  to another route containing the same model name.
- A failed selection leaves the active provider/model, session preferences, and durable config
  unchanged. A successful session selection is visible in `/status`, subsequent turns, subagents,
  and resume without changing defaults for new sessions. A successful user selection additionally
  survives as the default for new sessions.
- Explicitly retired commands remain absent. Behavioral parity must not reintroduce retired
  surfaces such as agent-profile management.
- Interactive input classifies a Slash command only when its canonical name or alias appears in the
  backend-provided routing-name set. Root absolute paths such as `/tmp` remain user messages;
  direct `command.run` still returns bounded `unknown_command` errors.
- `Ctrl+P` owns the searchable command palette. `?` and bare `/help` open unified shortcut and
  command help. Running-turn availability and argument hints come from registry metadata.

### 4. Validation & Error Matrix

- Missing `models.json` -> use the pinned pi-ai catalog plus built-in route declarations without
  writing a file.
- Catalog-backed v2 declaration with `models` and no `model_policy` -> merge those entries as
  provider-local overrides/additions while retaining the rest of the installed catalog.
- `model_policy: "subset"` without non-empty `models`, an unknown policy, or a catalog policy on an
  explicitly declared custom route -> bounded catalog/config error.
- Invalid JSON, duplicate exact identity, incomplete custom route, unsupported provider/protocol,
  invalid URL, repeated reasoning effort, or unlisted default effort -> bounded catalog/config error.
- Missing, malformed, inactive, or unserviceable `model.list.provider` -> `invalid_params`; return no
  models from another route.
- Model absent from the selected route, endpoint mismatch, unsupported effort, or missing selected
  credential -> reject before config mutation and provider startup.
- Provider/model load fails or a quick selection is rejected -> keep the selector open, show one
  bounded redacted error, release the submission fence, and allow exactly one request on retry.
- A provider response arrives after a newer provider generation -> discard it without mutating the
  visible route, cached model owner, or current selection.
- Model without a reasoning effort -> persist thinking disabled and remove stale active thinking
  effort while retaining a valid base reasoning setting for future models.
- Public model payload or error -> no API key, bearer token, raw auth-store content, or private
  absolute path.
- Invalid visual setting -> reject before config mutation with the existing bounded settings error.
- Model or settings candidate/atomic write failure -> leave the prior user TOML, active runtime,
  and session preferences unchanged; keep the selector open and return one bounded gateway error
  without source text, paths, credentials, or raw submitted values.

### 5. Good/Base/Bad Cases

- Good: `/model` opens the current provider's models, one Enter applies the highlighted model to the
  session, and Tab still reaches custom reasoning plus user-default scope.
- Good: upgrading the pinned pi-ai package adds a newly catalogued model to an existing
  catalog-backed route even when that route already has local model metadata overrides.
- Good: cycling providers replaces the list with only the adjacent route's models; an older response
  that completes afterward cannot replace them.
- Good: a visual settings save changes only owned root compatibility keys while preserving provider
  comments and plugin tables; a later model selection preserves those TUI keys.
- Base: a provider-scoped catalog with no exact current entry is returned intact with no row marked
  current.
- Bad: synthesize one default model per provider and call it catalog parity.
- Bad: concatenate every provider's models, filter by credential presence, or switch provider on a
  same-name match.
- Bad: accept arbitrary `model.select` input or trust `auth_ref` supplied by the TUI.
- Bad: let `model.select` or `settings.save` parse/stringify the whole TOML document in the gateway.
- Bad: freeze only the slash registry checksum while command services use different data sources.

### 6. Tests Required

- Config and provider-directory unit tests cover exact route ownership, provider-local overrides,
  custom routes, duplicate/reasoning validation, lazy pi-ai loading, and credential-free payloads.
- Gateway tests cover required provider input, inactive/malformed routes, same-name route isolation,
  missing-scope session defaulting, invalid-scope rejection, explicit user scope, structured
  failures, current `/status` projection, and the next turn's model/reasoning overrides.
- TUI tests cover current-provider auto-load, one-confirmation Enter, default-effort fallback, Tab
  reasoning/scope, user/session callbacks, bracket provider cycling, Esc provider back-navigation,
  login, loading/empty/error/retry states, stale-response fencing, inline errors, and narrow widths.
- TUI adapter tests associate each catalog with `modelsProvider`, reject malformed provider
  directories, preserve unrelated state across status updates, and replace the owned catalog only
  from a matching `model.list` result.
- Backend integration tests use a temporary HOME with a real catalog and auth store, verify
  catalog-owned `auth_ref`, session-only config isolation, resume persistence, user-default
  persistence, failed-write atomicity, and absence of credentials in responses.
- Config and backend tests assert model and settings writers share the user-config lock, retain
  comments/CRLF and unrelated keys, skip byte-identical replacement, and preserve the previous file
  after validation or atomic-write failure.
- Every other retained slash command changed in the future requires an equivalent behavioral test;
  updating only the registry hash is insufficient.

### 7. Wrong vs Correct

#### Wrong

```typescript
const models = allProviderModels.filter((model) => hasAnyCredential(model.provider));
const selected = models.find((model) => model.model === requestedModel);
```

#### Correct

```typescript
const routes = await providerModelDirectory.load(currentConfig);
const route = routes.requireActive(request.provider);
const catalog = route.models();
const selected = validateCatalogSelection(catalog, request);
const active = sessionCoordinator.snapshot();
const preferences = sessionPreferencesFromSelection(selected, active);
if (request.scope === "user") await writeUserProviderConfig({ ...selected, homeDir });
saveSessionPreferences(active, preferences);
active.binding.setSessionPreferences(preferences);
```

## Scenario: Transcript And Content-Blob Maintenance With Backend Restart

### 1. Scope / Trigger

- Trigger: changing `/session maintenance`, transcript/content-blob migration or GC routing,
  backend resource shutdown, cutover result delivery, or command availability during a turn.
- The command is a coordinator-owned storage operation and never enters provider input or a Worker.

### 2. Signatures

- Registry command: `/session maintenance
  [--apply-empty|--apply-payloads|--apply-orphans|--apply-vacuum|--apply-transcript-normalization|--apply-content-blobs|--apply-content-blob-gc]`.
- Gateway action: `sessionCommands.maintenance("transcript_normalization", workspaceRoot)`.
- Content actions: `sessionCommands.maintenance("content_blobs", workspaceRoot)` and
  `sessionCommands.maintenance("content_blob_gc", workspaceRoot)`.
- Backend composition: `prepareTranscriptNormalization`, shared idempotent resource shutdown, then
  `cutoverTranscriptNormalization`.
- Content composition: `prepareContentBlobMigration`, the same shutdown path, then
  `cutoverContentBlobMigration`; v11 GC calls `collectSessionContentBlobOrphans` without shutdown.

### 3. Contracts

- The command is unavailable while any turn is running. The default form remains read-only and may
  include bounded normalization readiness fields.
- Each apply request either stages one bounded batch, reports an active-session block, reports an
  already-normalized database, or performs a final cutover that was ready before the request.
- The first staging response that reaches the tail reports `ready_for_cutover`; only a second
  explicit request may start either v9-to-v10 or v10-to-v11 cutover.
- Before cutover, the backend closes integrations, Agent Workers, Shell resources, artifact queues,
  and the active v9/v10 store through one idempotent shutdown path. No stale old-version store may
  survive marker 10 or 11.
- The gateway keeps its response transport open long enough to return the bounded cutover result.
  It schedules backend close only when its internally produced response corresponds to
  `backend_restart_required=true`; no caller-provided JSON field can request shutdown.
- A successful or failed post-shutdown cutover result requires backend restart. Results contain no
  content, ids, paths, source identities, manifest hashes, provider payloads, or credentials.
- Normalization never invokes vacuum or reports physical shrinkage. Operators restart and validate
  the database before issuing the separate explicit vacuum command.
- Content-blob GC is v11-only, deletes only blobs unreachable from transcript and model-input
  references, reports logical raw/stored bytes plus freelist bytes, stays idempotent, and neither
  closes the backend nor invokes vacuum.

### 4. Validation & Error Matrix

| Request/result | Required behavior |
| --- | --- |
| Maintenance during active turn | Reject with `unavailable_during_turn` before storage work |
| Default maintenance | Return read-only list fields; keep backend running |
| Staging or active-session block | Return notice with bounded progress; keep backend running |
| First `ready_for_cutover` staging result | Return notice; require another explicit request |
| Successful marker-10 or marker-11 cutover | Return notice, then close backend and require restart |
| Cutover fails after resources close | Return bounded `persistence_error`, then close backend |
| Content apply on v9 | Return `requires_transcript_normalization`; preserve marker 9 |
| Content apply on v11 | Return `already_blob_backed`; do not stage or restart |
| Blob GC on v9/v10 | Return `not_blob_backed`; do not delete rows |
| Blob GC on v11 | Delete only proven orphans; return counts; keep backend running |
| Public result contains a lookalike restart field | Do not close unless the response object was internally marked |

### 5. Good/Base/Bad Cases

- Good: v9 reaches marker 10, restarts, v10 reaches marker 11 through a second explicit workflow,
  restarts, and later GC keeps every reachable blob and the backend process.
- Base: a fresh v11 database reports `already_blob_backed` without staging or rewriting data.
- Bad: cut over while a turn is active, close the gateway before writing the response, leave an old
  store open after cutover, collect blobs automatically, or trust a serialized restart field.

### 6. Tests Required

- Registry/completion fixtures cover the full argument hint and `availableDuringTurn=false`.
- Gateway tests cover action routing, bounded extra fields, active-turn rejection, internal
  close-after-response marking, and rejection of public-field shutdown control.
- Backend integration uses a temporary v9 database, proves staging-ready then second-request
  cutover, waits for automatic backend completion, and reopens the result as v10.
- Backend integration repeats the workflow from v10 to v11, then restarts and proves explicit GC
  removes an orphan without deleting reachable content or closing the backend.
- Maintenance service tests assert report reads preserve `mtimeMs`, result fields are bounded, active
  recovery blocks, and normalization never claims physical shrinkage.

### 7. Wrong vs Correct

#### Wrong

```typescript
if (result.backend_restart_required) await closeBackend(); // trusts public JSON for every action
store.contentBlobs.collectOrphans(); // runs from a report or startup path
```

#### Correct

```typescript
if (action === "content_blobs" && internallyProducedResult.backend_restart_required === true) {
	closeAfterResponses.add(response);
}
if (action === "content_blob_gc" && report.contentBlobs) {
	return store.collectSessionContentBlobOrphans();
}
```

## Scenario: Supervised Node Turn Interruption

### 1. Scope / Trigger

- Trigger: changing Node backend process ownership, Worker Thread transport,
  `turn.interrupt`, pending tool-call recovery, interrupted-turn provider replay,
  or TUI terminal-interruption ordering.
- This contract spans CLI, Worker supervision, Gateway JSON-RPC, runtime,
  SQLite, canonical context, and the next provider request.

### 2. Signatures

- Default CLI boundary:
  `startSupervisedNodeBackend(options: StartNodeBackendOptions) -> Promise<NodeBackend>`.
- Direct integration-test boundary:
  `startNodeBackend(options: StartNodeBackendOptions) -> Promise<NodeBackend>`.
- Targeted recovery:
  `SQLiteSessionStore.recoverInterruptedTurn(sessionId, turnId, userInitiated?) -> RuntimeTurnRecord | undefined`.
- Recovery startup descriptor:
  `RecoverInterruptedTurnOptions { sessionId, turnId, inputRolledBack?, userInitiated }`.
- Canonical replay marker:
  `turnAbortedContextItem(turnId) -> { itemId, item }`, where `item` has
  `role=developer`, `kind=turn_aborted`, `cacheClass=dynamic`,
  `durability=persistent`, and `scope=transcript`.

### 3. Contracts

- Interactive CLI startup hosts the whole Node backend in one supervised Worker
  Thread. Provider adapters, tools, shell ownership, subagents, Gateway, and
  SQLite are constructed inside that Worker because those live objects are not
  structured-cloneable.
- `turn.interrupt` first uses the existing cooperative `AbortSignal` path. The
  Gateway waits 100 ms and durably force-finalizes a responsive asynchronous
  in-process turn. Worker-backed Agent turns use the coordinator-owned targeted
  interruption path, whose complete supervisor cleanup envelope is 12 seconds.
- The parent supervisor independently applies a 15 second coordinator watchdog.
  This outer bound must remain greater than the complete inner targeted cleanup
  envelope. Only when the backend coordinator fails to answer within that longer
  bound may the parent call `Worker.terminate()` and start a fresh backend Worker
  for the same active session.
- The supervisor keeps the same parent-owned `GatewayTransport` streams across
  restart, queues new client input while restarting, and ignores output from a
  stale Worker generation. A restarted Worker must not require the TUI to
  remount its transport.
- Hard recovery uses the exact active `sessionId + turnId`. It atomically
  appends one synthetic `tool_interrupted` result for every pending canonical
  tool call, appends the deterministic `<turn_aborted>` context marker for a
  user-initiated interrupt, appends the interrupted rollout, and changes the
  turn to `interrupted`. Repeating the recovery is idempotent.
- The recovery marker text warns that a command may have partially executed.
  Terminating JavaScript cannot prove that an external process or side effect
  was reversed. Hard recovery therefore reports `input_rolled_back=false`
  unless rollback safety was independently proven.
- A fresh Worker publishes `turn.interrupted`, terminal `turn.status`,
  `status.update`, and idle `status.changed` from the recovered durable record.
  The supervisor returns `accepted=true` for the original interrupt RPC only
  after it has observed the matching recovered terminal notification.
- The `<turn_aborted>` item is projected into the next provider request as a
  developer-visible canonical context item. It must be persisted before it can
  enter provider context. Ordinary crash/startup orphan recovery does not append
  this user-intent marker because it cannot truthfully claim an intentional
  user interruption.
- Direct `startNodeBackend()` remains available for focused integration tests;
  production interactive CLI startup uses the supervised boundary.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Targeted Agent Worker interruption answers within 12 seconds | Keep the backend coordinator generation; forward its terminal events and RPC response |
| Backend coordinator remains blocked past the 15 second watchdog | Terminate it, recover the exact turn, restart, then resolve the RPC |
| Recovery descriptor session differs from startup session | Fail startup with `recovered_interrupt_session_mismatch` and publish no success |
| Target turn is missing or no recovered terminal event is published | Return a bounded `internal_error`; never claim `accepted=true` |
| Stale Worker emits after replacement | Drop the message by Worker identity/generation |
| Client writes during restart | Queue and forward to the fresh Worker after startup |
| User recovery repeats | Reuse the interrupted record and deterministic marker; append no duplicate marker/result |
| Non-user orphan recovery | Interrupt pending work without appending `<turn_aborted>` |

### 5. Good/Base/Bad Cases

- Good: a synchronous infinite loop blocks the Worker, the parent watchdog
  terminates it, SQLite closes the pending call and appends one marker, and the
  TUI sees `turn.interrupted` before the interrupt RPC response.
- Base: a targeted Agent Worker interruption answers after the former 250 ms
  boundary but within 12 seconds and the backend coordinator generation does
  not change.
- Good: a second recovery attempt finds an already interrupted turn and leaves
  exactly one `<turn_aborted>` item.
- Bad: emit `turn.interrupted` from the parent immediately after
  `Worker.terminate()` without first recovering SQLite.
- Bad: reuse `process.pid` liveness to detect a terminated Worker; Worker
  Threads share the parent PID, so targeted `sessionId + turnId` recovery is
  required.

### 6. Tests Required

- Core unit tests assert deterministic marker identity, exact metadata, and
  developer-role projection into the next provider request.
- Storage tests assert targeted recovery closes pending calls, marks the turn
  interrupted, appends the marker exactly once, and leaves terminal turns
  unchanged.
- Gateway tests assert recovered terminal event order and active turn ids.
- A real Worker Thread regression must synchronously block the first Worker,
  assert the watchdog replaces it, assert two `runtime.ready` notifications,
  and assert `turn.interrupted` precedes the synthesized interrupt response.
- A responsive Worker Thread regression must return the interrupt response after
  250 ms but within the outer default, assert exactly one `runtime.ready`, and
  assert the coordinator generation is unchanged across ready, terminal, and
  response messages.
- Source-mode and compiled-package smokes must both locate their corresponding
  `.ts` or `.js` Worker entry and receive `runtime.ready` from that worker.

### 7. Wrong vs Correct

#### Wrong

```typescript
controller.abort();
setTimeout(() => emit("turn.interrupted"), 100);
```

#### Correct

```typescript
controller.abort();
const settled = await settlesWithin(turnTask, 15_000);
if (!settled && coordinatorIsUnresponsive) {
  await worker.terminate();
  await restartWithRecovery({ sessionId, turnId, userInitiated: true });
}
// Resolve only after the fresh Gateway publishes the durable terminal record.
```

## Scenario: Targeted Agent Worker Interruption

### 1. Scope / Trigger

- Trigger: changing Worker-backed child execution, `interrupt_agent`, Agent Worker lease fencing,
  coordinator-owned cleanup, child terminalization, or Worker replacement.
- This is the inner Agent Worker path inside the backend coordinator. It is distinct from the
  outer supervised-backend watchdog described above and must not restart the coordinator for an
  ordinary child interruption.

### 2. Signatures

- Runtime handle:
  `AgentThreadRuntimeHandle.interrupt(reason) -> Promise<void>`.
- Durable cleanup confirmations:
  `forceInterrupt?(reason, turnId) -> Promise<boolean>` and
  `recoverInterrupt?(reason, turnId) -> Promise<boolean>`.
- Effect recovery:
  `AgentEffectLedgerStore.recoverInterruptedTools({ sessionId, turnId, completedAt })`
  returns every terminal tool attempt for the target turn.
- Lease controls: `AgentWorkerLease.fence(reason) -> Promise<void>` and
  `AgentWorkerLease.terminate(reason) -> Promise<void>`.
- Supervisor result: `AgentSupervisor.interrupt(childSessionId, reason?) -> Promise<boolean>`.
- Defaults: 250 ms cooperative grace, 1 second coordinator cleanup bound, and a 12 second
  Worker-mode supervisor cleanup envelope.

### 3. Contracts

- The runtime first requests cooperative cancellation. If the active run settles within the grace
  period, it waits for lease release acknowledgement and keeps the Worker generation.
- A still-active run is fenced before force cleanup. Fencing changes the Worker record out of the
  leased state and clears message listeners, so provider frames, tool completions, and other late
  messages have zero durable, external, or gateway effect.
- The coordinator then calls `forceInterrupt()` for the exact turn. A `true` result confirms that
  runtime/tool cleanup and interrupted-turn persistence are durable; timeout, rejection, `false`,
  or a missing cleanup capability is unconfirmed.
- After bounded cleanup, only the target lease is terminated. The pool waits for replacement
  creation before the interrupt operation completes; root and sibling leases retain their Worker
  identities and continue running.
- When force cleanup is unconfirmed, replacement occurs first and `recoverInterrupt()` performs the
  SQLite fallback. The interrupt succeeds only when one cleanup path returns `true` for the exact
  turn. Missing or failed confirmation is fail-closed.
- Every coordinator-brokered tool reserves an immutable effect attempt before execution. Turn
  interruption closes all still-reserved tool attempts, appends canonical results for every pending
  call, and changes the turn to `interrupted` inside one SQLite write transaction.
- A started read-only/cancellable attempt becomes `interrupted`; a started mutating attempt whose
  outcome cannot be proven becomes `effect_outcome_unknown`; a batch call with no effect attempt
  becomes `tool_interrupted`. A previously completed attempt supplies its verified committed result
  to canonical recovery instead of being downgraded.
- Effect outcomes are append-only. Repeated recovery returns the same rows, and a tool completion
  arriving after interruption cannot replace an interrupted or unknown terminal outcome.
- `AgentSupervisor` persists child task/thread interruption and publishes parent/gateway terminal
  state only after cleanup confirmation. On unconfirmed cleanup it returns `false`, leaves the
  durable child running, does not close the runtime, and publishes no interrupted terminal.
- Completion or failure may win the race with interruption. A real runtime terminal result remains
  authoritative, is published once, and must not be overwritten by a synthetic interruption.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Cooperative run settles and durable recovery confirms interruption | Release normally; keep the Worker generation; persist and publish once |
| Runtime completes or fails before interruption applies | Preserve that terminal result; return `false` for interruption; allow normal follow-up rules |
| Run remains active after 250 ms | Fence first, bound coordinator cleanup, terminate only the target, and replace its generation |
| `forceInterrupt()` returns `false`, rejects, or times out | Terminate/replace, then require `recoverInterrupt()` confirmation |
| Both cleanup paths are unavailable or unconfirmed | Return `false`; do not terminalize, publish, close, or release supervisor ownership |
| Fenced or stopping Worker emits a late frame | Drop it without invoking a listener or failing another lease |
| Target replacement is created | Root and sibling lease identities and execution remain unchanged |
| Duplicate interrupt targets an already terminal child | Keep the existing terminal row and publish no duplicate event |
| Started read-only attempt has no committed result | Persist one `interrupted` effect and one canonical `tool_interrupted` result |
| Started mutating attempt has no provable result | Persist one `effect_outcome_unknown` effect and matching canonical result |
| Effect completed before canonical result persistence | Reuse the verified completed result during turn recovery |
| Tool reports completion after recovery | Reject the conflicting terminal write and preserve the interruption outcome |

### 5. Good/Base/Bad Cases

- Good: an abort-aware child settles, acknowledges release, persists one interrupted turn, and
  reuses the same Worker.
- Good: an abort-ignoring child is fenced, its coordinator-owned effects are closed, only its
  Worker generation is replaced, and its parent continues to completion.
- Base: a child completes while cancellation is being requested; completed state wins and a later
  follow-up can use the idle durable thread.
- Bad: mark the task interrupted before cleanup confirmation, or treat a timed-out cleanup promise
  as proof that persistence succeeded.
- Bad: terminate before fencing, accept a late provider/tool frame during cleanup, or restart the
  whole backend coordinator for a routine child interruption.

### 6. Tests Required

- Runtime tests cover cooperative release without replacement, non-cooperative fencing and targeted
  replacement, cleanup timeout/rejection fallback, and failure when no cleanup path confirms.
- Pool tests inject late malformed frames after fencing and assert no listeners or unrelated leases
  are affected; replacement must increment only the targeted Worker generation.
- Supervisor tests assert cleanup precedes task/thread terminal writes, close, and publication;
  unconfirmed cleanup preserves running state; a completed-result race remains completed and can
  accept a follow-up.
- Storage tests assert one interrupted turn, one terminal result per pending call, one
  `turn_aborted` marker for user intent, mutation-aware effect outcomes, completed-result reuse,
  append-only late-completion rejection, and idempotent repeated recovery.
- A real backend integration must interrupt a Worker-backed child while the parent coordinator
  continues, then assert one child task/thread terminal, one marker, and no coordinator restart.
- The fault matrix must also inject provider delta/completion after interruption, tool completion
  after durable recovery, approval response after cancellation, duplicate terminal frames, a
  leased Worker crash, and reuse of the replacement generation. Each late or duplicate input must
  have zero additional persistence, lifecycle, usage, publication, or external-effect impact.

### 7. Wrong vs Correct

#### Wrong

```typescript
taskStore.interrupt(task);
publishInterrupted(task);
await lease.terminate(reason);
```

#### Correct

```typescript
await lease.fence(reason);
const cleaned = await boundedForceInterrupt(turnId);
await lease.terminate(reason);
const confirmed = cleaned || await recoverInterrupt(reason, turnId);
if (!confirmed) return false;
terminalizeTaskAndThread();
await publishTerminal();
```

## Scenario: Shared Root And Child Agent Worker Pool

### 1. Scope / Trigger

- Trigger: changing root `turn.submit`, root approval or clarification continuation, Agent Worker
  adapter selection, shared pool scheduling, root provider dispatch, or coordinator ownership.
- The Worker boundary covers provider-loop execution only. The backend coordinator continues to
  own root session generations, reservations, queue state, SQLite, tools, approvals, artifacts,
  gateway events, and TUI projection.

### 2. Signatures

- Adapter gates: `MYCLI_AGENT_EXECUTION_ADAPTER=in_process|worker` is the compatibility base;
  `MYCLI_ROOT_AGENT_EXECUTION_ADAPTER=in_process|worker` and
  `MYCLI_SUBAGENT_EXECUTION_ADAPTER=in_process|worker` independently override their lanes. The
  effective default is `worker`; explicit `in_process` remains the rollback adapter.
- The real-provider agent smoke may report only an allowlisted `failure_stage` boundary. It must not
  include raw errors, prompts, responses, paths, credentials, or provider payloads.
- Resolver:
  `resolveAgentExecutionAdapters(env) -> {root: AgentExecutionAdapterKind,
  subagent: AgentExecutionAdapterKind}`.
- Root adapter:
  `WorkerLeasedRootTurnRuntime({ pool, runtime, sessionId, recoverInterrupt? })`.
- Continuation identity: `NodeTurnRuntime.continuationTurnId() -> string | undefined`.
- Root lease request:
  `AgentWorkerPool.acquire({ priority: "interactive", source: "root", sessionId, turnId, signal })`.
- Resource metrics:
  `AgentWorkerPool.metrics() -> Promise<AgentWorkerResourceMetrics>`.
- Worker limits: `DEFAULT_AGENT_WORKER_RESOURCE_LIMITS` is 192 MiB old generation, 16 MiB young
  generation, 64 MiB code range, and 4 MiB stack.
- Transport/cache bounds: `AGENT_WORKER_TRANSPORT_MAX_BYTES=2 MiB`,
  `AGENT_WORKER_SNAPSHOT_CACHE_MAX_ENTRIES=8`, and
  `AGENT_WORKER_SNAPSHOT_CACHE_MAX_BYTES=512 KiB`.
- Idle recycling options: `maxJobsPerWorker`, `maxWorkerAgeMs`, `largeContextBytes`, and
  `maxHeapGrowthBytes`. Defaults are 100 jobs, 30 minutes, 1 MiB, and 32 MiB respectively.
- Process pressure options: `rssSoftLimitBytes`, `rssHardLimitBytes`, `rssPollIntervalMs`, and the
  injectable `readProcessRssBytes()`. Defaults are 1.5 GiB, 2 GiB, and 1 second.
- Soft queue option: `softPressureQueueTimeoutMs`, default 30 seconds.
- Pressure failure:
  `AgentWorkerPoolMemoryPressureError { code="agent_worker_pool_memory_pressure",
  pressure="soft"|"hard", outcome="soft_queue_timeout"|"hard_capacity", rssBytes, limitBytes }`.
- Benchmark command:
  `npm run benchmark:agent-workers -- --output <jsonl-path>`. It emits schema-versioned, redacted
  per-scenario rows and runs each scenario in a separate process.

### 3. Contracts

- Selection precedence is lane override, then compatibility base, then `worker`. Missing or blank
  lane overrides inherit the compatibility base. Unknown non-blank values fail backend startup and
  do not echo their raw value in the error.
- Adapter selection is resolved once during backend startup and captured by root runtime composition
  and child runtime factory composition. A running backend does not reread these environment keys,
  so an active turn cannot switch adapters.
- If either effective lane is `worker`, create one shared coordinator-owned pool. Only enabled lanes
  acquire from it: root requests use interactive priority and child requests use background priority.
- Each root submit execution segment acquires one exclusive Worker lease using the already durable
  reserved turn id, binds one `WorkerProviderStepExecutor`, and releases the lease after the segment
  settles. Existing idempotent reservations do not acquire a new lease.
- A root approval or clarification wait retains its durable suspended turn but no Worker. The
  response execution segment reads the same durable continuation turn id, acquires a new lease
  fenced to that id, and never reserves a second user turn.
- Approval and clarification share the durable `suspended_turn` key. Continuation identity lookup
  must probe clarification state before approval state because the approval coordinator treats a
  clarification-only suspension as an incomplete approval and fails closed. A valid clarification
  must therefore acquire its Worker lease without touching the approval probe.
- Provider I/O runs in the leased Agent Worker only after the coordinator commits canonical model
  input. SQLite, tool execution, approval policy, queue mutation, artifacts, gateway publication,
  and TUI state remain in the coordinator.
- Root, child, and sibling leases share capacity without sharing conversation state, provider
  continuation state, tool state, or credentials beyond the active job.
- Cooperative root interruption releases the lease without changing its generation. A root run
  still active after the grace period is fenced, durably force-finalized by the coordinator, and
  has only its leased Worker terminated and replaced.
- Root and child hard interruption are symmetric isolation boundaries. Replacing a root Worker
  leaves every child lease id and generation unchanged; replacing one child Worker leaves the root
  and every sibling lease id and generation unchanged. Parent-child lifecycle policy may still
  terminalize related logical work separately, but Worker termination itself is never propagated.
- Session new/resume/fork, provider-free slash commands, root steering/follow-up, compaction,
  Responses continuation replay, MCP refresh, permissions, and TUI transcript projection remain
  coordinator-owned and must produce the same durable and gateway results when root provider steps
  use Worker leases.
- A provider stream final message is not the synchronization boundary for accepting another
  independent root turn. Tests and clients that immediately submit another turn must wait for the
  coordinator's terminal lifecycle and idle `status.changed(turn_running=false)` snapshot so the
  prior generation's execution claim has been released.
- Child spawn configuration persists only allowlisted environment values that are non-empty, do
  not contain NUL, and contain at most 32,768 characters. Invalid optional ambient values are
  omitted rather than making durable child reservation fail.
- Every Worker uses validated V8 resource limits. Coordinator messages are stable-serialized and
  byte-checked before structured clone; provider command/response parsers run on both send and
  receive boundaries. Immutable instruction/tool cache entries remain content-addressed and LRU
  bounded, while complete conversation state is cleared on release.
- `metrics()` reads heap and event-loop numbers through coordinator-side Node Worker APIs. Its
  projection contains only Worker id/generation, thread id, state, numeric limits, heap byte counts,
  and event-loop numbers. It excludes lease/job/session/turn ids and all content, credentials,
  paths, provider input, and tool output, and is not model-visible.
- Job-count, age, largest-job-message, and retained-heap-growth thresholds are soft recycling
  signals. The pool evaluates them only after the Worker acknowledges release, while its state is
  `releasing` and its lease reference is cleared. A matching Worker is stopped before it can return
  to `idle`; configured warm capacity is then restored with a new generation.
- Threshold sampling never reclaims an `assigning`, `leased`, or `fenced` Worker. The heap check
  repeats the idle-only state/lease guard after its asynchronous sample so a race cannot recycle a
  reassigned Worker. Protocol validation failures remain hard correctness failures: they fence and
  replace the affected Worker immediately instead of waiting for ordinary idle recycling.
- At or above the RSS soft limit, the pool retires idle Workers, disables warm-capacity and crash
  replacement spawning, and holds background requests in the existing bounded priority queue.
  Interactive requests may reuse idle capacity or expand up to the configured maximum.
- At or above the RSS hard limit, the pool disables all expansion. Interactive work may reuse an
  existing idle Worker; an interactive request with no idle capacity, and every new or queued
  background request, fails with `AgentWorkerPoolMemoryPressureError`. Existing active leases are
  never reclaimed. The periodic RSS monitor resumes queued work and restores warm capacity only
  after RSS falls below the soft limit.
- A background request that remains queued throughout the soft-pressure timeout fails as
  `soft_queue_timeout`. This prevents an interactive parent that is waiting on a child from hanging
  indefinitely while process pressure remains elevated.
- The periodic RSS monitor may be unreferenced while the lease queue is empty, but it must keep the
  event loop referenced while any acquisition is queued. Every queued acquisition must therefore
  settle through dispatch, abort, explicit pressure rejection, timeout, or pool close even when no
  Worker or other referenced handle remains.
- Memory pressure changes scheduling only. It never compacts, removes, slices, or silently truncates
  committed provider context. The metrics pressure projection contains state, RSS/limit bytes,
  warming state, and numeric retirement/rejection counters only; it remains non-model-visible.
- Memory benchmarks compare RSS deltas from a same-process baseline and never enforce one platform's
  observed byte values as another platform's pass/fail threshold. The output allowlist is platform,
  architecture, Node version, scenario, duration, RSS/heap/external/Worker counts, and numeric
  scenario dimensions; it excludes payload bodies, paths, identities, prompts, tools, and secrets.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| All adapter gates are absent | Root and child provider steps use the shared Worker pool |
| Compatibility gate resolves to `in_process` | Root and child provider steps use the in-process adapter and create no Agent Worker pool |
| Compatibility gate is `worker` with no lane overrides | Root and child provider steps use the shared Worker pool, preserving legacy behavior |
| Root lane is `in_process` and subagent lane is `worker` | Root remains in-process; children acquire background Worker leases from the shared pool |
| Root lane is `worker` and subagent lane is `in_process` | Root acquires interactive Worker leases; children remain in-process |
| A lane override is blank | Inherit the compatibility gate; do not force `in_process` |
| Any non-blank adapter value is unknown | Fail backend startup naming only the invalid environment key; create no pool or runtime |
| Root submit reservation is new | Acquire one `interactive/root` lease with the exact session and durable turn id |
| Reservation is an existing idempotent result | Return the durable result without acquiring or dispatching a Worker |
| Root waits for approval or clarification | Release the current lease; retain coordinator-owned suspended state |
| Root continuation resumes | Acquire a new lease using the original durable turn id and commit no duplicate user turn |
| Root and children are runnable | Lease distinct Workers from the shared bounded pool according to priority and FIFO policy |
| Root Worker is non-cooperative | Fence, clean up, terminate, and replace only the root lease; keep child leases active |
| Child Worker is non-cooperative | Fence, clean up, terminate, and replace only the target child lease; keep root and sibling leases active |
| Worker startup/capacity fails before dispatch | Return the typed Worker failure and produce no provider or tool side effect |
| Root provider stream emits its final text | Keep the execution claim until coordinator terminalization and idle status publication complete |
| Allowlisted child environment value is empty, contains NUL, or exceeds 32,768 characters | Omit that optional value from the frozen spawn snapshot; persist no malformed environment field |
| Outbound or inbound Worker frame exceeds 2 MiB | Reject/fence before effect handling; do not structured-clone an oversized coordinator frame |
| V8 resource override is missing | Use the measured 192/16/64/4 MiB defaults |
| V8 resource override is invalid or transport limit exceeds 2 MiB | Reject pool construction before spawning a Worker |
| Heap sampling races with Worker exit | Omit that Worker's heap block; retain bounded identity/state and event-loop numbers |
| Worker reaches 100 jobs, 30 minutes, a 1 MiB job message, or 32 MiB heap growth while leased | Preserve the active lease and defer threshold evaluation |
| Worker acknowledges release after crossing a soft threshold | Clear the lease, stop that idle generation, and restore warm capacity before reassignment |
| Worker sends malformed or oversized protocol traffic | Fence any active lease and replace the Worker immediately with no effect handling |
| RSS is below 1.5 GiB | Dispatch by priority/FIFO and maintain configured warm capacity |
| RSS is at least 1.5 GiB but below 2 GiB | Retire idle Workers, disable speculative warming/replacement, queue background work, and permit interactive reuse or expansion |
| Background work remains in soft pressure for 30 seconds | Reject it with `soft_queue_timeout` rather than leave a dependent parent waiting indefinitely |
| RSS is at least 2 GiB with an idle Worker | Permit one interactive request to reuse it without expansion; reject background work explicitly |
| RSS is at least 2 GiB with no idle Worker | Preserve active leases and reject new work with `hard_capacity` rather than wait indefinitely |
| RSS returns below 1.5 GiB | Resume the bounded queue by normal priority/FIFO order and restore warm capacity |
| Benchmark output path is provided | Write exactly one JSON object per scenario with no raw payload or local path |
| One benchmark scenario fails | Return non-zero and emit no fabricated measurement for that scenario |

### 5. Good/Base/Bad Cases

- Good: a root uses `spawn_agent`; root and child provider requests execute on distinct shared-pool
  leases, while both manifests and the root tool call/result are committed in their own sessions.
- Good: a root approval releases its Worker while waiting, then resumes on another lease with the
  same turn id and the coordinator-owned pending decision.
- Good: an MCP background refresh updates coordinator registrations and a later Worker provider
  step receives the refreshed tool definition without moving MCP ownership into the Worker.
- Base: `in_process` preserves the canonical manifests, transcript, usage, tool, and gateway
  behavior without creating the pool.
- Good: a metrics sample during a private leased job contains numeric heap/event-loop fields but no
  session id, turn id, lease id, job id, prompt, credential, or tool output.
- Good: a default Worker-completed turn restarts with the explicit `in_process` gate and reads the old
  manifest chain, completes the next turn, and persists only one plan effect.
- Good: a Worker crosses its configured age threshold during a long provider call, completes the
  active lease normally, acknowledges release, and is replaced before it receives another job.
- Good: soft pressure queues child work while an interactive root obtains capacity; after RSS
  recovers, the child receives its unmodified committed context and executes normally.
- Base: hard pressure reuses one already idle Worker for root work without creating another isolate.
- Bad: terminate a leased Worker, trim provider-visible history, or leave an impossible expansion
  request queued indefinitely merely to move RSS below a threshold.
- Bad: move SQLite, tool adapters, queue state, approval continuations, or gateway publication into
  the root Worker.
- Bad: keep a Worker leased while waiting for user input, or reserve a new turn for a continuation.
- Bad: persist empty ambient values such as `COLORTERM=""` in a child spawn snapshot and fail the
  entire spawn at the storage validation boundary.

### 6. Tests Required

- Runtime tests assert `interactive/root` acquire input, exact session/turn fencing, executor bind
  and unbind, lease release, continuation reuse, cooperative generation reuse, targeted hard
  replacement, and completed-vs-interrupt race precedence.
- Runtime and app integration tests restart a clarification-only suspension under the default Worker
  adapter, resolve it on a new lease with the original turn id, and assert that approval probing does
  not mask the valid clarification state.
- App integration runs the same spawned-child scenario through `in_process` and `worker`, then
  reconstructs independent root and child provider manifests and asserts the root canonical
  conversation contains the coordinator-owned `assistant_tool_calls` and `tool_result`.
- App integration runs the same spawned-child scenario under legacy all-in-process, legacy
  all-Worker, in-process-root/Worker-child, and Worker-root/in-process-child topologies. Runtime unit
  tests assert precedence, blank inheritance, and fail-fast validation for each environment key.
- Shared-pool integration runs one root with multiple concurrent children and verifies isolated
  context, tools, approvals, usage, terminal reports, and gateway ordering.
- Bidirectional hard-interrupt tests hold two child leases while replacing root, then hold root and
  sibling leases while replacing one child. Every non-target Worker id, generation, and lease id
  must remain unchanged. App integration must also prove an interrupted child does not prevent a
  sibling report or the root terminal result.
- App integration with `MYCLI_AGENT_EXECUTION_ADAPTER=worker` must cover session new/resume/fork,
  provider-free slash commands, steering and queued follow-up lifecycle, real compaction and
  restart, canonical Responses tool continuation replay, permission-frozen tool exposure, live and
  durable TUI transcript parity, and background MCP refresh reaching a later provider step.
- M7 extension integration must set an allowlisted ambient value to the empty string and still
  complete child spawn, proving invalid optional environment values are omitted before durable
  spawn reservation.
- Worker test synchronization must wait for explicit `leased` state or actual delegate start;
  `activeLeaseCount` also includes `assigning` Workers and is not proof that a runtime handle has
  installed its active run.
- Run the identical two-step root tool scenario through both adapters and compare normalized
  canonical conversation, provider bodies, manifest reference topology, lifecycle payloads, usage,
  terminal report, transcript, and terminal gateway ordering.
- Restart a Worker-written session with `MYCLI_AGENT_EXECUTION_ADAPTER=in_process`, complete the next
  in-process turn, and assert old provider manifests remain reconstructable and tool effects are not
  duplicated.
- Pool tests assert actual Worker `resourceLimits`, positive heap values, event-loop utilization in
  `[0,1]`, content-free metrics serialization, pre-clone oversized-message rejection, and continued
  Worker reuse. Context tests assert the 8-entry/512-KiB cache defaults.
- Pool tests lower each recycling threshold independently and assert job-count, age, largest job
  message, and heap growth replace the Worker only after release acknowledgement. Age and heap
  tests must hold the lease past the threshold and assert its generation remains unchanged while
  active. Protocol-failure tests must continue asserting immediate affected-lease failure and
  replacement.
- RSS tests inject deterministic samples. Soft tests assert idle retirement, disabled warming,
  background queueing, bounded `soft_queue_timeout`, interactive progress, and recovery. Hard tests
  assert active generation preservation, interactive idle reuse without expansion, typed
  `hard_capacity` when no idle capacity is safe, background rejection, numeric/redacted metrics,
  and resumption below the soft threshold.
- Benchmark verification asserts all nine scenario names, 0/1/4 Worker counts, active counts,
  bounded 480 KiB tool projection beside the coordinator-owned 8 MiB output, two generations after
  120 leases, and zero Workers after post-idle recovery. CI runs the same command on Linux, macOS,
  and Windows and uploads the JSONL rather than comparing unstable absolute RSS values.

### 7. Wrong vs Correct

#### Wrong

```typescript
const worker = await pool.acquire({ source: "root", turnId: randomUUID() });
await worker.runWholeBackend({ store, tools, gateway, approval });
```

#### Correct

```typescript
const lease = await pool.acquire({
  priority: "interactive",
  source: "root",
  sessionId,
  turnId: durableTurnId,
  signal,
});
runtime.bindProviderStepExecutor(new WorkerProviderStepExecutor({ lease }));
try {
  return await runtime.submit(submission, emit, { signal, reservation });
} finally {
  runtime.bindProviderStepExecutor(undefined);
  await lease.release();
}
```

#### Wrong

```typescript
worker.postMessage(unvalidatedProviderCommand);
return { sessionId, turnId, prompt, heap: await worker.getHeapStatistics() };
```

#### Correct

```typescript
lease.postMessage(parseAgentWorkerProviderCommand(command));
return await pool.metrics(); // numeric, redacted, and non-model-visible
```

#### Wrong

```typescript
if (heapGrowthBytes >= maxHeapGrowthBytes) await lease.terminate("memory pressure");
```

#### Correct

```typescript
await lease.release(); // release ack and lease clearing happen before idle threshold recycling
```

#### Wrong

```typescript
request.items = request.items.slice(-100); // hidden truncation under process pressure
```

#### Correct

```typescript
throw new AgentWorkerPoolMemoryPressureError({
  pressure: "hard",
  outcome: "hard_capacity",
  rssBytes,
  limitBytes: hardLimitBytes,
});
```

#### Wrong

```typescript
const environment = Object.fromEntries(keys.map((key) => [key, env[key]]));
```

#### Correct

```typescript
const environment = Object.fromEntries(keys.flatMap((key) => {
  const value = env[key];
  return typeof value === "string"
    && value.length > 0
    && value.length <= 32_768
    && !value.includes("\0")
    ? [[key, value]]
    : [];
}));
```

## Scenario: Bounded Streaming Transcript Rendering

### 1. Scope / Trigger

- Trigger: changing TUI component rendering, transcript viewport bounds, assistant Markdown
  streaming, render-cache keys, or native scrollback delta collection.
- The goal is to keep a long active assistant response inside the frame budget without changing
  the visible result that a full render followed by tail slicing would produce.

### 2. Signatures

- Optional component boundary:
  `Component.renderTail?(width: number, maxRows: number) -> TailRenderResult`.
- Tail result:
  `TailRenderResult { lines: string[]; totalLines: number }`.
- Container invalidation boundary:
  `Container.markRenderDirty() -> void` for subclasses that change visible child state without
  invalidating reusable child render caches.
- Root-frame identity:
  `TUI.activeRenderFrameId -> number | null`; it is non-null only during one synchronous root
  `TUI.render(width)` call.
- Transcript viewport:
  `new TranscriptViewportComponent(content, heightForWidth, maxRenderedRows, contentRevision?)`
  and `TranscriptViewportComponent.render(width) -> string[]`; the optional callback returns an
  owner-controlled revision token for transcript-visible mutations.
- Transcript viewport change hints:
  `TranscriptViewportComponent.markContentChanged() -> void` and
  `TranscriptViewportComponent.markSectionTailChanged(section, stablePrefixLength) -> void`.
- Native table holdback boundaries:
  `Markdown.holdsStreamingTableTail() -> boolean`,
  `AssistantMessageComponent.holdsNativeScrollbackTail() -> boolean`, and
  `TranscriptViewportComponent.scrollbackPrefixBefore(section, componentIndex, width) -> string[]`.
- Full transcript projection:
  `createTranscriptProjection(blocks) -> TranscriptProjectionState`.
- Incremental tail projection:
  `projectTranscriptTail(blocks, previous) ->
  {projection, stablePrefixLength, replacedBlocks}`.
- Plain blockquote layout cache:
  `RenderedPlainBlockquoteCache {text, lastSourceLineStart,
  lastSourceLineOutputStart, sourceToken}`.
- Streaming table source cache:
  `StreamingTableInfo {headerSource, lastRowOffset}`.
- Retained table layout cache:
  `RenderedTableTokenCache {naturalWidths, minWordWidths, columnWidths,
  rowBoundaryStarts, bottomLineStart, finalRowMetrics, sourceToken}`.
- Streaming inline paragraph boundary:
  `StreamingInlineParagraphInfo {boundaryOffset, stableInlineCount}`.
- Retained rich paragraph layout cache:
  `RenderedRichParagraphCache {stableInlineCount, stableOutputLineCount,
  stableTailSource, sourceToken}`.
- Runtime update classifier:
  `classifyRuntimeTranscriptUpdate(previous, next, eventType?) ->
  "unchanged" | "tail" | "replace"`.
- Stream reducers:
  `applyAssistantDelta(items, assistantId, text) -> RuntimeTranscriptItem[]` and
  `applyReasoning(items, text, metadata) -> RuntimeTranscriptItem[]`.
- Gateway runtime projector:
  `RuntimeStateProjector.project(state, sessions, transcriptUpdate) -> MycliShellState`.
- TUI tool-detail projection:
  `MycliShellRuntime.setState(state, {transcriptUpdate}) -> void`, retaining raw and display arrays
  separately while a global `Ctrl+O` override is active.
- Stateless runtime projection oracle:
  `projectRuntimeState(state, sessions) -> MycliShellState`.
- Gateway event replay:
  `GatewayClient.waitForEvent(method, matches, timeoutMs) -> Promise<GatewayEvent>` with a default
  unmatched-event replay limit of 256.

### 3. Contracts

- `renderTail(width, maxRows).lines` is byte-for-byte equal to
  `render(width).slice(-maxRows)` for positive `maxRows`; a non-positive bound returns no lines.
- `totalLines` is the number of lines from a full render, even when only a bounded tail is
  materialized. ANSI control sequences, OSC 133 zones, CJK width, assistant role prefixes,
  thinking blocks, and spacing remain part of this equivalence.
- `TranscriptViewportComponent` calls `renderTail` only on components that implement it. Other
  components retain the compatible full-render fallback and are sliced after rendering.
- Viewport cache identity includes component render key, terminal width, and requested `maxRows`.
  A tail cached for one remaining-row budget must not be reused for another budget.
- A bounded viewport may retain its complete selected line array between frames only when the
  terminal width and owner-supplied `contentRevision` are unchanged and every selected component
  returns a defined `getRenderCacheKey()`. This skips both rendering and the otherwise linear walk
  over component cache keys.
- The owner must advance `contentRevision` before rebuilding the transcript header, reconciling
  transcript children, or mutating any selected component's visible state. The callback is omitted
  when that ownership proof is unavailable, which preserves component-level caching without
  enabling complete line-array reuse.
- A selected component whose `getRenderCacheKey()` is absent or returns `undefined` makes that
  bounded render volatile and prevents complete line-array reuse on the next frame. Running Shell
  components use this path so elapsed time and other child-owned state continue to update.
- Explicit viewport invalidation clears retained aggregate lines and component caches. Width changes
  reject aggregate reuse. An unbounded viewport preserves the existing full-render behavior even
  when a revision callback is present.
- A validated transcript tail projection passes its mounted `stablePrefixLength` into
  `markSectionTailChanged`. The viewport retains per-component line boundaries for the selected
  bounded content, reuses the prior line prefix, and renders only current section children at or
  after that boundary. It must not reread stable component keys merely to rediscover the boundary.
- Multiple section-tail hints received before one render merge to the minimum stable prefix for the
  same section. A full-content change or hints for different sections discard the tail proof. The
  incremental path applies only to the final root content section, matching the shell's header then
  chat ownership; any other shape uses the complete bounded renderer.
- Tail-line reconciliation falls back when width changes, the component boundary is invalid, or
  tail shrinkage would require rows older than the retained prefix. Line growth may roll an already
  full bounded window without a complete render: trim the displaced rows, advance a logical line
  origin, and render only components at or after the validated boundary. Native scrollback must
  still observe exactly the rows displaced by a fresh bounded render. A new volatile suffix may
  reuse already retained stable lines for that frame, but leaves aggregate reuse disabled afterward.
- Retained chunk starts use absolute logical row coordinates. The line array remains relative to
  the current logical origin, and an offset identifies the first chunk that can still intersect the
  retained window. Front trimming advances the origin and offset instead of rewriting every chunk.
  Stale chunk metadata is compacted only after a bounded minimum prefix is stale and that prefix is
  at least half the metadata array, preserving amortized append cost and absolute chunk starts.
- Retained chunk metadata also records the component's full logical `sourceStart` and the
  `renderTail.totalLines` value that produced its bounded lines. If one changed suffix component
  fills the complete row cap, layout derives its retained start as
  `sourceStart + totalLines - renderedLines.length` instead of resetting the logical lineage.
- A full-height suffix continues the prior lineage only when rendering reaches the validated
  `stablePrefixLength`, its source boundary is retained, and its next line origin still overlaps
  the prior retained window. Growth beyond that window, shrinkage before its origin, or a missing
  source boundary starts a new lineage and keeps the content-overlap fallback.
- Native scrollback watermarks use the same logical lineage and absolute row coordinates. When a
  validated bounded update retains that lineage, scrollback derives the exact uncommitted interval
  instead of inferring overlap from line text. Equal adjacent rows remain distinct history rows.
- A rendered roll may displace uncommitted rows before the next scrollback collection. Retain that
  contiguous interval with its lineage until collection, then append the still-retained prefix.
  Width changes, full bounded rebuilds, and lineage disagreement keep the content-overlap fallback
  and reset the logical watermark after collection or source-backed scrollback replacement.
- Shell chrome containers may reuse rendered lines between viewport-height measurement and their
  later layout pass only when `activeRenderFrameId` and width both match. The cache is unavailable
  outside the root render call and must not survive into the next frame.
- Assistant streaming reuses existing Markdown components and marks only the owning container
  dirty. Recursive invalidation is reserved for theme or layout invalidation because it discards
  the Markdown token cache.
- Active assistant blocks update their retained component directly. They must not serialize the
  complete block to build a change signature on each text or reasoning delta; that allocation grows
  linearly with the accumulated response before Markdown rendering even begins.
- Assistant and reasoning reducers check the active transcript tail before any history search. A
  matching `assistant_stream`, reopened `assistant_final`, or reasoning tail is replaced with one
  immutable array snapshot. They must not scan the stable prefix and then create additional prefix
  and suffix arrays. A non-tail assistant ID keeps the full-search fallback for legacy sessions.
- Runtime transcript classification owns the `tail` guarantee. It emits `tail` only for an append,
  a final-item replacement, or a reasoning update whose assistant is at the tail. Workspace,
  turn-running, and tool-detail changes force `replace`.
- The gateway passes the validated direct event type, including the inner `runtime.event.type`, to
  the classifier. A `message.delta` may bypass stable-prefix comparison only when its reducer shape
  proves that the active assistant replaced the existing tail or appended one new tail item.
  Non-tail active items, projection-context changes, and calls without a validated event type keep
  the complete classifier. The hint must not be inferred from arbitrary next-state contents.
- The gateway owns one `RuntimeStateProjector`. It computes the update kind once, projects one shell
  snapshot, and shares that snapshot with the mounted full TUI or native chat runtime. The retained
  projector is display-only state; canonical runtime transcript items remain immutable and owned by
  `RuntimeShellState`.
- An `unchanged` runtime projection reuses message, tool, bash, and shell-transcript arrays only when
  the source transcript array, active assistant, live reasoning, workspace, turn-running state, and
  tool-detail default still match the retained projection context.
- A runtime `tail` projection validates immutable source-item references at the last or penultimate
  boundary, then reparses only appended items, the replaced final item, or the active tail assistant
  affected by live reasoning. Boundary or context mismatch falls back to stateless full projection.
- Runtime projection returns new array snapshots only for transcript-derived categories affected by
  a tail change, while retaining stable block objects inside their prefix. Unchanged categories are
  reused by array identity. It must not mutate arrays held by the previous `MycliShellState`, because
  shell reconciliation and subagent detection compare previous and next snapshots.
- Combining an affected projection array uses the proof carried by its projected prefix and suffix.
  Replacing exactly the final projected item creates one immutable `with(-1, item)` snapshot; a pure
  append uses `concat(suffix)`. Context regrouping or any other general suffix replacement keeps the
  defensive `slice(0, prefixLength)` plus suffix fallback. These fast paths must not mutate the
  previous snapshot or weaken the stateless projection equivalence check.
- A global tool-detail override is a TUI display projection, not canonical runtime state. The shell
  retains the source and overridden `tools`, `bash`, and `transcript` arrays separately. With a
  validated `tail` hint, identical source arrays are reused, a final-item replacement uses `with`,
  and a pure append maps only the appended suffix. Tool and Bash objects shared between category
  arrays and transcript blocks remain shared after projection.
- Changing the global detail mode, replacing a session, shrinking an array, or failing an immutable
  tail-boundary check rebuilds the complete display projection. Internal state-only updates may
  arrive with the prior display arrays; they must be normalized back to the retained source arrays
  before reapplying the override. Previous exposed array snapshots remain immutable.
- `projectRuntimeState` remains the full stateless behavior oracle for tests, resume, and fallback.
  Incremental output must be deeply equal to this function for the same runtime state.
- Gateway event replay is a bounded race-recovery queue, not a session event log. An event that
  resolves one or more already-pending waiters is not also retained, and an unmatched early event
  may satisfy one future waiter exactly once. When the replay limit is reached, discard the oldest
  unmatched events; streamed deltas must never grow client memory without bound.
- The stateless `projectRuntimeState` path reconstructs shell block wrappers. Downstream incremental
  validation therefore compares the retained boundary by stable `id` and `kind`, not wrapper object
  identity. The runtime classifier remains responsible for proving the complete source prefix.
- Projection state retains projected blocks, ordered source spans, source length, and the final two
  source identities. A valid tail update splices only the grouping-sensitive suffix into the same
  projected arrays; it must not traverse or copy the complete stable prefix.
- An append after a non-context block starts at the prior source length. Updating the last source
  block starts at that block, unless the preceding source span is a context run. A trailing context
  run is replayed from its first source index so a second context tool can form a group and an
  expanded tool can keep the complete run ungrouped.
- Mutating tools, file changes, and subagent source blocks remain grouping boundaries. Subagent
  blocks have no main-transcript projection but their source positions still prevent context tools
  on opposite sides from being combined.
- `stablePrefixLength` identifies components that remain mounted. `replacedBlocks` contains only
  the old suffix that cache reconciliation may remove; unchanged component identity survives an
  ordinary append.
- Shell component reconciliation builds and compares only the projected suffix. When every suffix
  component is already mounted at the expected position, it retains the `Container.children` array
  itself; otherwise it splices only the changed suffix. This retained component tree is mutable UI
  cache, unlike the immutable runtime and shell state arrays. Full projection replacement may still
  rebuild the complete component suffix from index zero.
- Markdown caches top-level rendered token chunks. Reuse requires the same token type, raw source,
  next-token type, width, and reference-sensitive token context. Appending a reference-link
  definition must be able to change an earlier `[label][id]` token even when its raw source is
  unchanged.
- Markdown also retains normalized source tokens for append-only streaming. When the source has no
  reference-link syntax, it reparses from the final non-space top-level token, validates that token
  raw lengths still cover the complete source, and splices only that suffix into retained lexer and
  rendered-token arrays. Reference syntax, non-append edits, or source-coverage disagreement force
  a full lex.
- Incremental Markdown layout rechecks the rendered token immediately before the reparsed suffix
  because its `nextType` may change. It updates the retained token-line total from the removed and
  inserted suffix instead of summing every stable token on each bounded tail render.
- An append-only, top-level, unclosed backtick or tilde fence may update its final `code` token from
  the normalized appended suffix without invoking the full Markdown lexer. The retained token must
  cover the previous source tail exactly, and the appended boundary must not contain a valid closing
  fence under Marked's opening-marker plus trailing-marker grammar. Indented fences,
  carriage-return input, closing fences, and boundary disagreement fall back to Marked.
- Without syntax highlighting or code-preview truncation, rendered code tokens retain source-line
  end offsets and update only the previous final source line plus appended lines. A proven token
  lineage permits this path without rescanning complete `raw` and `text` prefixes; unproven token
  replacements keep the defensive prefix checks.
- A final paragraph that Marked tokenizes as one unstyled inline `text` token may retain its rendered
  entry and line array across an append. A single-source-line paragraph restarts layout from the
  previous final visual line. A soft-line paragraph restarts from its previous final source line and
  retains that source/output boundary in the cache. The source suffix is validated against the
  retained paragraph text. Following block tokens, default text styling, inline Markdown
  transitions, and source-line disagreement use the complete token-render path.
- A final single-line rich paragraph without reference syntax may retain complete inline tokens and
  reparse only its final context-protected inline boundary with Marked `Lexer.lexInline`. The
  boundary includes the preceding whitespace-bearing token or expands through adjacent tokens, and
  delimiter-sensitive unmatched text cannot remain in the stable prefix. Old and reparsed inline
  raw lengths must cover the paragraph exactly, and reparsing the old boundary in isolation must
  reproduce its prior AST before the fast path is enabled.
- Rich paragraph layout retains only complete byte-equal output lines. Its unstable source consists
  of the final unfinished visual line plus changed inline tokens; newly complete lines move into the
  retained prefix only when independently rendering the candidate tail matches the full replacement
  suffix byte for byte. Default text styling, following block tokens, newlines, carriage returns,
  references, unsafe boundaries, or validation disagreement use the complete Marked path. ANSI,
  OSC 8 hyperlinks, CJK width, padding, entry identity, and line-array identity remain unchanged.
- A final tight, flat list whose items contain only plain inline text may retain its item AST and
  rendered line boundaries. The lexer reparses from the cached source offset of the previous final
  item, replaces that item plus appended items, and layout rerenders the same suffix. The cached
  offset includes list-token bytes not owned by `ListItem.raw`, such as transient trailing spaces.
  Loose, nested, task, reference-sensitive, mixed-marker, or rich-inline lists fall back to Marked.
- A final top-level blockquote containing exactly one plain paragraph and one plain inline text
  token may retain its rendered entry and line array. Layout restarts from the previous final quote
  source line after Marked confirms that the complete blockquote remains plain. The replacement
  carries the same ANSI state as a continuation of earlier quote lines; independently styling the
  replacement can produce different control bytes even when it looks identical. Multiple quote
  blocks, rich inline syntax, nested blocks, reference syntax, or a following top-level token use
  the complete token-render path.
- A final table without reference syntax may retain its header and stable row AST. The lexer builds
  a synthetic boundary table from the cached header plus the previous final source row and appended
  bytes, accepts only one complete Marked table token, then replaces the prior final row plus new
  rows. Missing source coverage, carriage returns, table termination, header/alignment disagreement,
  or an invalid boundary forces a full lex.
- Table layout retains column metrics, rendered row boundaries, and the line array. It rerenders
  only changed rows when replacing the prior final row cannot reduce any cached row metric and the
  recomputed column widths remain identical. A width change or a semantic transition that can
  shrink the replaced row rebuilds the complete table; table column widths depend on every row.
- While a turn is active and the final assistant's last meaningful Markdown token is a table,
  native scrollback holds that assistant instead of committing rows whose column widths may still
  change. Detection may conservatively retain a previously rendered table for one frame, but must
  not consume or mutate Markdown render-token updates.
- A source replay or resize while a table tail is held rebuilds physical history from the bounded
  component prefix before that assistant. This removes provisional rows that terminal-native
  resize reflow may have moved into scrollback without inserting the held table into history or
  scanning content older than the replay bound. The held suffix consumes both the replay-row budget
  and live viewport height when calculating that safe prefix.
- When the table ends, the turn completes, or another transcript block becomes the tail, replace
  physical scrollback once from the complete bounded source and discard provisional logical deltas.
  Ordinary paragraph, list, quote, and code streaming keeps incremental native-scrollback commits.
- Width changes and explicit invalidation clear token layout caches. An unbounded viewport keeps
  the full-render behavior.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| `maxRows <= 0` | Return `lines=[]` while preserving the exact `totalLines` count |
| Component has no `renderTail` | Render normally and slice the returned lines |
| Width or render revision changes | Reject the cached tail and render for the new identity |
| Bounded viewport width and owner revision are unchanged, and every selected component has a defined render key | Reuse the exact retained line array without traversing component cache keys |
| Owner rebuilds header or transcript-visible content | Advance the owner revision before mutation so the next bounded render traverses and refreshes the selected components |
| A selected component has an undefined render key | Render it on every frame and disable aggregate line-array reuse for that render |
| Revision callback is omitted or viewport is unbounded | Keep component-level or full-render behavior; do not retain aggregate bounded content |
| Viewport is explicitly invalidated | Clear retained aggregate lines and component caches before rendering again |
| Validated final-section tail keeps the same bounded line count | Reuse retained prefix lines and render only components at or after `stablePrefixLength` |
| Several tail updates arrive before rendering | Merge the proofs to the minimum stable prefix for that section |
| Tail hints target different sections or a full mutation follows | Discard the tail proof and run the complete bounded renderer |
| Tail grows past a full row cap | Trim displaced rows, advance the logical origin/chunk offset, render only the validated suffix, and preserve exact native scrollback boundaries |
| One changed component's bounded tail fills the row cap | Use its retained source start plus current `totalLines` to advance the line origin without resetting lineage |
| Full-height tail no longer overlaps the prior retained window | Start a new logical lineage; do not claim rows omitted by both bounded renders |
| Native scrollback collects a retained-lineage roll | Emit the absolute interval between its committed watermark and current visible start without comparing stable line text |
| Several bounded rolls render before scrollback collection | Retain displaced uncommitted rows as one contiguous pending interval, then emit them before the current retained prefix |
| Full render, width change, or logical-lineage disagreement | Use the content-overlap compatibility path and establish a new logical watermark after collection/replacement |
| Tail shrinks and retained rows cannot fill the cap | Recompute from earlier components to expose the correct older rows |
| Tail boundary is invalid or changed section is not final | Ignore the hint and run the complete bounded renderer |
| Dynamic chrome is measured and then painted in one root frame | Render its children once and reuse the exact measured lines |
| Editor, status, or size-dependent pending content reaches the next root frame | Render again because child-owned state may change without a parent rebuild |
| Running activity receives an unrelated frame with the same width, spinner frame, and elapsed second | Reuse the component's rendered lines while the parent remains frame-local |
| Spinner frame, elapsed second, or status width changes | Reject the running-activity component cache and render fresh lines without selecting a different phrase |
| State-owned static footer or subagent chrome reaches the next root frame | Reuse lines only when the parent container revision and width are unchanged |
| Static chrome parent rebuilds or terminal width changes | Reject the cross-frame cache and render its children again |
| Assistant text appends inside the final Markdown token | Re-render the changed token and reuse stable prefix tokens |
| Append-only source has no reference-link syntax | Retain stable lexer tokens and reparse from the final non-space top-level token |
| Top-level unclosed fence receives a non-closing append | Update the final code token and retained code-line suffix without full lex or layout |
| Append closes a fence or the fence is indented | Reject the fence fast path and match a fresh Marked render |
| Code highlighting or preview truncation is configured | Use the existing complete token-render path |
| Plain final paragraph receives a plain-text append | Rewrap its previous final visual line and retain the entry and line-array identities |
| Plain soft-line paragraph receives a plain-text append | Rewrap its previous final source line and retain the entry and line-array identities |
| Paragraph append becomes a URL, code span, emphasis, link, or new block | Reject retained paragraph layout and match a fresh render |
| Final rich paragraph receives a single-line append with a proven inline boundary | Reparse only the context-protected inline suffix and rewrap only the unfinished visual tail |
| Rich inline boundary has references, unmatched stable delimiters, incomplete raw coverage, or isolated AST disagreement | Reject retained inline state and run the complete Marked path |
| Rich paragraph receives a newline, following block, or default text style | Reject retained rich layout and match a fresh render |
| Tight flat list receives a same-marker plain append | Reparse and rerender the previous final item plus appended items |
| List has unowned trailing source bytes | Start the boundary at the cached final-item source offset, not `list.raw.length - item.raw.length` |
| List becomes loose, nested, rich, task-based, mixed-marker, or ends | Reject the list fast path and match a fresh Marked render |
| Plain blockquote receives a plain append | Re-render the prior final quote source line plus the appended text and retain the entry and line-array identities |
| Blockquote receives rich inline content, a nested block, a second paragraph, or ends | Reject retained quote layout and match a fresh Marked render |
| Retained quote suffix starts after an earlier styled line | Seed the active ANSI continuation state and require byte-equal output, not merely equal visible text |
| Final table receives cells that preserve computed column widths | Reparse the final source row and render only changed/new rows plus the bottom border |
| Appended table cell changes a column width | Reject retained layout and rebuild the complete table |
| Appended table boundary ends the table or changes header/alignment semantics | Reject the boundary token and run a full lex/render |
| Active assistant ends in a Markdown table | Hold that assistant out of native scrollback while continuing to render its live viewport tail |
| Terminal resizes while the table tail is held | Replace history from the bounded component prefix before the assistant, excluding provisional table rows |
| Held table ends or the turn becomes terminal | Replace history once from the complete bounded transcript source, then resume ordinary delta collection |
| Appended reference definition resolves an earlier token | Reject that token's cached context and match a fresh render |
| Incremental token raw lengths do not cover the source | Reject retained lexer state and run a full lex |
| Tail omits the assistant's leading blank row | Do not synthesize its OSC 133 start marker in the truncated tail |
| Tail includes the first assistant content row but not the leading blank | Preserve the assistant role bullet on that content row |
| Tail source shrinks or its retained boundary `id`/`kind` changes | Reject incremental state and run a full projection |
| Tail appends after a stable non-context block | Read/project only appended source blocks and retain the complete projected prefix |
| Tail touches a context run | Replay from that run's recorded source start and preserve grouping semantics |
| Full replacement or session transition | Discard retained projection metadata and rebuild from source |
| Projected tail resolves to the same mounted components | Update component content and retain the children array without copying its stable prefix |
| Projected tail changes component identity or grouping | Splice only the changed component suffix from `stablePrefixLength` |
| Runtime status changes with the same transcript array | Reuse all four runtime projection arrays by identity |
| Runtime appends or replaces the final immutable item | Reparse a bounded source suffix, snapshot affected arrays, and reuse unaffected arrays |
| Projected suffix replaces exactly the final item | Create one immutable snapshot with `previous.with(-1, item)` and no intermediate prefix array |
| Projected suffix is a pure append | Create one result with `previous.concat(suffix)` and retain every previous item reference |
| Projected suffix regroups or replaces a general range | Use the defensive prefix-slice plus suffix fallback |
| Global tool detail mode is active and an assistant tail changes | Reuse tool/Bash projections and replace only the display transcript tail |
| Global tool detail mode is active and a tool is appended | Map the new tool/block only and retain shared object identity between both arrays |
| Tool detail mode changes or retained source boundary disagrees | Rebuild the complete display projection from source arrays |
| Active tail assistant receives live reasoning | Reproject from that assistant while retaining earlier shell blocks |
| Runtime source reference or projection context disagrees with the hint | Ignore retained state and match `projectRuntimeState` |
| Active stream, final assistant, or reasoning item is the transcript tail | Locate it in constant time and create exactly one immutable array snapshot |
| Active assistant ID exists away from the tail | Use the compatibility search and preserve its original transcript position |
| Validated `message.delta` replaces or appends the active assistant tail | Classify as `tail` without reading the stable transcript prefix |
| `message.delta` targets a non-tail assistant or changes projection context | Ignore the hint and run the safe replacement path |
| Event matches one or more pending gateway waiters | Resolve every current match and do not retain a replay copy |
| Future waiter matches one buffered early event | Remove that event and resolve the waiter exactly once |
| Unmatched event count exceeds the replay limit | Discard the oldest entries and retain the newest bounded suffix |

### 5. Good/Base/Bad Cases

- Good: a 100k-character streamed response renders only the bounded viewport tail while reporting
  the same total line count and visible bytes as a full render.
- Good: appending to a response after hundreds of stable Markdown blocks retains their lexer and
  rendered-token identities and parses only the active suffix.
- Good: appending one line to a 10,000-line open code fence invokes code-line rendering only for
  the previous final line and the appended line.
- Good: appending words to a 10,000-word plain paragraph rewraps only its previous final visual line
  after Marked confirms that the paragraph still contains one plain inline token.
- Good: appending one line to a 5,000-line soft-line paragraph rerenders only the previous final
  source line and appended lines after the same Marked validation.
- Good: appending bold, code, emphasis, strikethrough, or URL content to a long rich paragraph keeps
  stable inline-token, rendered-entry, and line-array identities while reparsing and rewrapping only
  a bounded suffix.
- Good: wrapping a streamed URL in a hyperlink-capable terminal retains byte-identical OSC 8 open,
  close, and line-continuation sequences compared with a fresh render.
- Good: appending one item to a 2,000-item tight list reparses and rerenders only the old final item
  and the new item while retaining earlier item objects and rendered lines.
- Good: appending one line to a 2,000-line plain blockquote rerenders only the previous final source
  line and the appended line while preserving ANSI bytes and the retained line array.
- Good: appending one stable-width row to a 1,000-row table lexes the cached header plus final-row
  boundary, retains earlier row AST and rendered lines, and renders only the new suffix.
- Good: a wide row added to an active table may reflow every prior table row without leaving the
  earlier narrow layout in native scrollback; resize keeps the table held, and completion performs
  one canonical source-backed history replacement.
- Base: a small component without `renderTail` follows the existing full-render path.
- Good: a width change recomputes wrapping and remains equal to a newly constructed Markdown
  component.
- Good: 500 chrome-only frames over a 10,000-row bounded transcript reuse the retained line array
  without rereading any transcript component cache key.
- Good: 500 final-component updates over a 10,000-row bounded transcript reuse the retained line
  prefix, reducing the measured viewport work from about 150.7 ms to 6.6 ms while keeping output
  byte-identical.
- Good: 500 one-row appends that continuously roll a full 10,000-row window advance retained
  logical coordinates instead of rereading stable component keys; the measured viewport work is
  about 6.6 ms versus 357.1 ms for forced complete bounded renders.
- Good: collecting native scrollback after each of 500 one-row rolls over 10,000 retained rows uses
  logical watermarks and measures about 7.0 ms instead of 28.0 ms for content-overlap matching.
- Good: growing one full-height 10,000-row component 500 times retains its source lineage, emits all
  500 history rows, and measures about 25.5 ms instead of 48.0 ms for forced lineage rebuilds.
- Good: five identical visible strings roll by one logical row and emit one new history row; text
  equality cannot collapse distinct rows.
- Base: a running Shell in the selected transcript tail returns an undefined render key, so its
  elapsed seconds update even when the owner revision is unchanged.
- Good: a streamed paragraph crosses a wrap boundary while the replay window is full; the viewport
  drops the displaced row, advances its logical origin, and keeps suffix reuse without rescanning
  the stable component prefix.
- Good: appending one message to a 10,000-block transcript reads only the boundary and appended
  source blocks, retains the projected array, and keeps all stable components mounted.
- Good: replacing a subagent boundary with a second `Read` replays the preceding context run and
  creates the same group as a fresh full projection.
- Good: 200 assistant tail updates across 50,000 mounted blocks retain the component children array
  and update only the existing final `AssistantMessageComponent`.
- Good: a status-only gateway event reuses the complete shell transcript arrays without touching
  any runtime transcript item.
- Good: a 10,000-item final message update reads only a bounded runtime suffix, returns a new shell
  transcript array, and preserves the stable block objects inside it.
- Good: replacing the projected tail of a 50,000-item transcript creates only the immutable result
  snapshot, without also allocating a sliced 49,999-item prefix.
- Base: appending projected blocks uses `concat`, while a context-tool regroup still rebuilds the
  affected general suffix through the defensive fallback.
- Good: after `Ctrl+O`, streaming an assistant across a 10,000-block transcript reads only the
  retained boundary and preserves the overridden tool blocks in the stable prefix.
- Good: a provider delta on a 10,000-item transcript reads the active tail once, copies the array
  once, preserves every stable item reference, and leaves the previous snapshot unchanged.
- Good: the matching validated `message.delta` classification reads only the active tail instead of
  comparing all 10,000 stable item references again.
- Good: millions of streamed gateway deltas leave at most 256 unmatched replay events in the TUI
  client rather than retaining the complete session event history.
- Bad: cache by token `raw` alone; later reference definitions can change an earlier token AST.
- Bad: concatenate retained lexer tokens with an appended suffix without replaying the final
  non-space block; lists, blockquotes, fences, and tables can continue across the append boundary.
- Bad: treat a line-start closing fence as code content, or manually reproduce Marked's indented
  fence compensation; both change the parsed transcript when streaming reaches the fence boundary.
- Bad: infer that appended paragraph text remains plain from its characters alone; URL and inline
  Markdown transitions must first be accepted by Marked before retained layout is reused.
- Bad: use the complete multiline paragraph as the wrap input after every soft-line append; stable
  source lines already have byte-equal retained output.
- Bad: lex an inline suffix immediately after a stable token without carrying a whitespace-bearing
  context boundary; underscore, emphasis, autolink, and delimiter-run semantics can depend on the
  preceding source.
- Bad: compare only stripped or visible rich-paragraph output before retaining a line. ANSI resets
  and OSC 8 close/reopen sequences are part of the byte-level rendering contract.
- Bad: derive a list boundary with `list.raw.length - lastItem.raw.length`; Marked may retain trailing
  spaces in the list token while excluding them from the final item, which drops spaces on the next
  streamed character.
- Bad: render a retained styled quote line in isolation. The fresh render may canonicalize active
  cross-line ANSI state into a different escape sequence, violating byte-for-byte tail equivalence.
- Bad: append a rendered table row without recomputing column widths. One wider cell can reflow the
  header and every prior row even though their source is unchanged.
- Bad: commit active table rows to native scrollback as though they were stable prose. A later wide
  cell or terminal resize makes immutable history disagree with the canonical table layout.
- Bad: call recursive `invalidate()` for every assistant delta and erase all stable Markdown
  token chunks.
- Bad: cache one tail without including the remaining-row budget in its identity.
- Bad: retain complete bounded transcript lines from an owner revision alone while ignoring a
  selected component's undefined render key; child-owned timers would freeze.
- Bad: mutate transcript-visible state without advancing the owner revision; aggregate reuse would
  preserve stale lines even if the mutated component has a new render key.
- Bad: treat the most recent tail hint as the only pending hint; two coalesced updates can move the
  true changed boundary earlier than the last update reports.
- Bad: reuse a retained line prefix after tail shrinkage leaves fewer than `maxRenderedRows` lines;
  older components must be rendered to fill the newly exposed window.
- Bad: run the complete bounded renderer whenever growth displaces one front row; this turns steady
  streaming into a stable-prefix key scan on every frame.
- Bad: subtract the dropped-row count from every retained chunk start. Chunk starts are absolute;
  advance the logical origin and compact stale metadata only at the amortized threshold.
- Bad: use suffix/prefix text overlap as the primary scrollback identity for a retained-lineage
  update. Repeated rows can produce a full textual overlap even though the window moved.
- Bad: overwrite the last rendered bounded frame before preserving uncommitted rows it displaced;
  a later scrollback collection cannot reconstruct rows no longer present in either frame.
- Bad: reset the logical origin to zero whenever `suffixLines.length === maxRows`. A tall active
  assistant then loses coordinate continuity on every streamed line even though `totalLines`
  provides the exact retained-tail offset.
- Bad: continue a full-height lineage after its new origin advances beyond the old retained end;
  intermediate rows omitted by both bounded tails cannot be reconstructed safely.
- Bad: retain measured editor, status, or size-dependent pending lines across root frames; cursor,
  timer, input, and terminal-height state can change without a parent container rebuild.
- Bad: opt a component into cross-frame chrome caching unless all display state is owned by an
  immutable child replacement and parent-container revision. Footer and subagent task chrome meet
  that contract; dynamic children do not.
- Bad: call `JSON.stringify` on the accumulated assistant block for every streaming delta.
- Bad: validate incremental shell projection with wrapper reference equality; gateway projection
  recreates those wrappers even when the runtime transcript prefix is unchanged.
- Bad: build a new projected prefix array on each stream delta; source scanning may be gone while
  linear allocation remains.
- Bad: copy all mounted transcript components merely to put the same updated assistant component
  back at the final position.
- Bad: call `findIndex` before checking the active tail, then combine separately sliced prefix and
  suffix arrays; that adds a full history scan and multiple allocations to every provider delta.
- Bad: globally treat arrays with matching tail boundaries as append-only. Only the validated
  `message.delta` reducer shape owns that proof; session replacement and ordinary state updates do
  not.
- Bad: mutate retained `MycliShellState.transcript`, `messages`, `tools`, or `bash` arrays in place;
  the caller loses the previous snapshot needed for reconciliation.
- Bad: remap every tool, Bash item, and transcript block on every assistant delta after `Ctrl+O`;
  a display-only override must not make streaming cost grow with stable history.
- Bad: cache footer, approval, queue, permission, or session state inside the transcript projector;
  only the expensive runtime-to-shell transcript mapping is retained.
- Bad: append every gateway notification to a permanent array, or let a handled lifecycle event
  wake unrelated future waits after its original waiter has completed.

### 6. Tests Required

- Markdown tests compare incremental updates with fresh renders for paragraphs, lists, code,
  blockquotes, tables, reference definitions, and width changes.
- Markdown lexer tests assert a long append-only stable prefix retains source-token identity, while
  appended reference definitions rebuild reference-sensitive source tokens.
- Open-fence tests compare incremental and fresh full/tail rendering through character appends,
  blank lines, inline fence markers, ordinary and mixed-marker closing fences, tilde fences, and
  indented-fence fallback.
- Code-layout tests count theme `codeBlock` calls and assert a 500-line append renders exactly the
  previous final line and the new line while retaining the code entry and line-array identities.
- Plain-paragraph tests retain the rendered entry and line-array identities for both single-line and
  soft-line sources, then compare bounded output with a fresh render. Character-streamed tests cross
  URL, emphasis, code-span, CJK, long-word, list, heading, and second-paragraph boundaries to verify
  that inline and block transitions fall back without changing bytes.
- Rich-paragraph tests retain stable inline-token, rendered-entry, and line-array identities across
  bold, code, emphasis, strict strikethrough, URL, CJK, and long-word appends. Character-streamed
  differential tests cover partial delimiters, new block transitions, reference fallback, default
  text-style fallback, and both legacy URL rendering and OSC 8 hyperlink rendering.
- Flat-list tests count bullet renders and assert an append renders only the old final item and new
  items while retaining entry, line-array, and stable-item identities. Character-streamed tests
  cover trailing spaces, partial markers, rich inline content, nesting, loose lists, marker changes,
  list termination, ordered numbering, and source-marker preservation against fresh rendering.
- Plain-blockquote tests retain entry and line-array identities and compare incremental full/tail
  output with a fresh render under explicit ANSI quote styles. Character-streamed tests cover CJK,
  long words, rich inline syntax, reference links, blank quote paragraphs, nested lists, and quote
  termination.
- Table tests retain entry, line-array, and stable-row AST identities while column widths remain
  fixed. Fresh-render differential tests stream characters through wider cells, bold/code, reference
  links, escaped pipes, trailing newlines, and table termination; explicit tests assert a wider cell
  replaces the retained entry.
- Table holdback tests assert detection does not consume pending Markdown render updates, ordinary
  long prose still advances native scrollback, active table rows stay out before and after resize,
  bounded safe-prefix replay excludes the held component, and completion performs one canonical
  replacement with no duplicate table rows.
- Markdown and assistant tests assert `renderTail(...).lines` equals a full-render tail for zero,
  narrow, exact, and oversized row bounds; assert `totalLines` equals full length.
- Assistant tests include visible and hidden thinking, role prefixes, spacing, and OSC 133 markers.
- Viewport tests use a 10,000-line component with separate full/tail counters and assert the
  bounded path never calls full render.
- Viewport aggregate-cache tests use 10,000 stable components and assert unchanged owner revisions
  do not reread component keys; owner revision, width, and explicit invalidation changes must each
  traverse the selected components again.
- Volatile viewport tests assert an undefined component render key disables aggregate reuse, and a
  running Shell advances its rendered elapsed seconds across unchanged owner frames.
- Tail-reconciliation tests use 10,000 stable components, replace only the final component, and
  assert no stable component key is reread. Runtime wiring tests assert the projected stable prefix
  reaches the viewport and the changed assistant output remains visible.
- Bounded-window rolling tests fill 10,000 rows, grow the mutable tail by one row, and assert the
  first retained row advances while every stable component key is read exactly once. Native
  scrollback collection must receive the displaced visible-history row exactly once.
- Metadata-compaction tests perform more than 1,024 bounded one-row appends and assert the final
  retained window matches a fresh render while every appended component key is read exactly once;
  replacing the final component afterward must use the preserved absolute chunk boundary and read
  only that changed key again.
- Native scrollback coordinate tests roll repeated equal strings and assert one physical history row
  is emitted. Delayed-collection tests render several bounded rolls, then assert displaced and
  still-retained history rows are emitted exactly once in logical order.
- Full-height component tests grow one tail beyond the row cap with both repeated and distinct
  lines. They assert `totalLines` preserves one-row lineage, repeated rows remain distinct, and
  several rendered rolls can be collected later in exact logical order.
- Fallback tests shrink a multi-line tail inside a full bounded window and assert older rows are
  exposed exactly as a fresh bounded render. Native scrollback and resize suites remain required.
- Shell layout tests count editor child renders and assert one render inside a root frame, another
  render in the next frame, and no cache reuse for direct dynamic-container calls. Footer and
  subagent panel tests assert reuse across unrelated streaming frames, plus invalidation on parent
  rebuild and terminal-width change.
- Running-activity tests assert stable animation keys retain the exact rendered line array, while an
  elapsed-second or width transition replaces it without changing the per-turn phrase. Generic
  working and thinking states vary across turn keys; explicit phase labels remain unchanged. The
  status parent remains frame-local.
- Assistant streaming tests assert the retained component updates without consulting the generic
  serialized block-signature path.
- Projection tests count indexed source reads across 10,000 blocks and assert a final assistant
  update stays bounded, equals a fresh projection, and retains the same projected array.
- Projection boundary tests cover ordinary append, second context-tool grouping, mutating and file
  changes, subagent boundaries, expanded context tools, and invalid-boundary full fallback.
- Shell runtime tests reconstruct stable shell block wrappers as the gateway does, then assert the
  existing prefix components retain object identity after a hinted append.
- Shell runtime tests assert an assistant tail update retains both its component and the complete
  `chatContainer.children` array, while append and context regroup tests still produce correct
  suffix shape and output.
- Runtime projector tests compare every incremental result with stateless `projectRuntimeState`,
  count indexed reads for a 10,000-item final update, and assert ordinary append updates the tool
  array while retaining stable message blocks.
- Runtime projector tests assert unchanged events reuse all transcript-derived arrays and live
  reasoning replaces only the active tail assistant block. Tail replacement and pure append must
  preserve the previous snapshot, retain stable item identities, and match the stateless oracle;
  context regrouping must continue to exercise the general fallback behavior.
- Tool-detail projection tests activate `Ctrl+O` over 10,000 blocks, count source-index reads for an
  assistant tail update, and assert a following tool append remains collapsed, retains the stable
  display prefix, and shares the projected tool object with its transcript block.
- Runtime reducer tests wrap a 10,000-item transcript in an indexed-read counter and assert active
  stream, reopened final, and reasoning tail updates perform at most one complete snapshot read,
  retain stable item identity, and do not mutate the previous array.
- Classifier tests assert validated existing-tail and first-token `message.delta` updates avoid
  stable-prefix reads, while non-tail active items and projection-context changes still replace.
- Gateway client tests assert pending waiters share the live event without a replay copy, early
  events are consumed once, and overflow discards the oldest unmatched event.
- Native scrollback, resize, frame-diff, and transcript replay regressions must remain green after
  any tail-rendering change.

### 7. Wrong vs Correct

#### Wrong

```typescript
const lines = component.render(width);
return lines.slice(-remainingRows);
```

#### Correct

```typescript
const lines = component.renderTail
  ? component.renderTail(width, remainingRows).lines
  : component.render(width).slice(-remainingRows);
```

#### Wrong

```typescript
if (ownerRevision === retainedRevision) return retainedLines;
```

An owner revision cannot prove that child-owned timers or other volatile component state is stable.

#### Correct

```typescript
if (retainedCacheable && width === retainedWidth && Object.is(ownerRevision, retainedRevision)) {
  return retainedLines;
}
const rendered = renderSelectedComponents(width);
retainedCacheable = rendered.everyComponentHadStableKey;
retain(rendered.lines, width, ownerRevision);
```

Complete bounded content is retained only after every selected component opts into stable caching;
the owner revision fences transcript mutations while the width fences wrapping changes.

#### Wrong

```typescript
rebuildChat();
viewport.markContentChanged();
```

Every streamed token throws away the projection's already validated stable component boundary.

#### Correct

```typescript
const stablePrefixLength = syncChatBlocks(blocks, true);
viewport.markSectionTailChanged(chatContainer, stablePrefixLength);
```

The viewport reuses retained prefix lines only while the boundary, width, row cap, and component
cacheability proofs remain valid; otherwise it falls back to the complete bounded renderer.

#### Wrong

```typescript
if (combinedLines.length > maxRows) return renderCompleteBoundedTail();
```

#### Correct

```typescript
const trimmedRows = Math.max(0, combinedLines.length - maxRows);
const lines = combinedLines.slice(trimmedRows);
const lineOrigin = retainedLineOrigin + trimmedRows;
const chunkOffset = trimChunkPrefix(chunks, retainedChunkOffset, lineOrigin);
```

Chunk starts stay in absolute logical coordinates. The retained line array is relative to
`lineOrigin`, and stale metadata is removed only when amortized compaction is due. Shrinkage that
needs unavailable older rows still uses the complete bounded fallback.

#### Wrong

```typescript
const overlap = suffixPrefixOverlapLength(previousLines, nextLines);
const droppedRows = previousLines.length - overlap;
```

#### Correct

```typescript
if (currentLineage === committedLineage) {
  return rowsBetween(committedLogicalEnd, currentLogicalVisibleStart);
}
return overlapFallback(previousLines, nextLines);
```

Text overlap is a compatibility fallback for coordinate resets. It cannot identify repeated rows
inside a retained logical lineage, and rendered-but-uncollected displaced rows must be preserved
until the logical interval is committed.

#### Wrong

```typescript
if (suffixLines.length >= maxRows) {
  return { lines: suffixLines, lineOrigin: 0, continuesLineage: false };
}
```

#### Correct

```typescript
const lineOrigin = sourceStart + totalLines - suffixLines.length;
const continuesLineage =
  suffixCoversBoundary && lineOrigin >= previousOrigin && lineOrigin <= previousRetainedEnd;
```

`renderTail.totalLines` locates a full-height component tail without materializing its omitted
prefix. Continuity is accepted only while the new bounded tail overlaps the prior retained window;
otherwise the viewport creates a new lineage rather than inventing missing rows.

#### Wrong

```typescript
this.events.push(event);
```

#### Correct

```typescript
if (!this.resolvePendingEvents(event)) {
  this.rememberEvent(event);
}
```

#### Wrong

```typescript
const index = items.findIndex(matchesActiveAssistant);
return [...items.slice(0, index), updated, ...items.slice(index + 1)];
```

#### Correct

```typescript
const lastIndex = items.length - 1;
if (matchesActiveAssistant(items[lastIndex])) {
  return items.with(lastIndex, updated);
}
return replaceAfterCompatibilitySearch(items, updated);
```

#### Wrong

```typescript
if (previous.transcript.at(-1) === next.transcript[previous.transcript.length - 1]) {
  return "tail";
}
```

#### Correct

```typescript
if (eventType === "message.delta" && isActiveAssistantTailDelta(previous, next)) {
  return "tail";
}
return classifyTranscriptArrays(previous, next);
```

#### Wrong

```typescript
const projected = projectTranscriptBlocks(allBlocks);
const prefix = compareProjectedArrays(previous, projected);
```

Every delta scans and allocates the complete transcript before discovering that only its tail
changed.

#### Correct

```typescript
const { projection, stablePrefixLength, replacedBlocks } =
  projectTranscriptTail(allBlocks, retainedProjection);
reconcileSuffix(projection.blocks, stablePrefixLength, replacedBlocks);
```

The runtime-supplied tail classification protects the source prefix. Source spans identify the
smallest grouping-sensitive suffix, and reconciliation keeps stable components mounted.

#### Wrong

```typescript
runtimeState = nextState;
runtime.setState(projectRuntimeState(runtimeState));
```

Every status, tool-progress, and token event reparses all durable transcript items and recreates
every shell wrapper.

#### Correct

```typescript
const update = classifyRuntimeTranscriptUpdate(runtimeState, nextState);
runtimeState = nextState;
const shellState = runtimeStateProjector.project(runtimeState, sessions, update);
runtime.setState(shellState, { transcriptUpdate: update });
```

The gateway retains only display projection work, uses the stateless projector as its fallback
oracle, and passes the same update proof to downstream reconciliation.

#### Wrong

```typescript
return [...previous.slice(0, prefixLength), ...suffix];
```

Using the general combiner for a proven final-item replacement allocates both a full prefix copy and
the final result on every streamed delta.

#### Correct

```typescript
if (prefixLength === previous.length - 1 && suffix.length === 1) {
  return previous.with(-1, suffix[0]);
}
if (prefixLength === previous.length) return previous.concat(suffix);
return [...previous.slice(0, prefixLength), ...suffix];
```

The bounded projector proof selects a single-allocation immutable fast path. General regrouping
retains the safe suffix-replacement fallback.

#### Wrong

```typescript
const transcript = state.transcript?.map((block) => applyDetailMode(block, expanded));
```

This remaps stable history on every stream event while the global detail override is active.

#### Correct

```typescript
const transcript = projectDetailArray(
  sourceTranscript,
  retained.sourceTranscript,
  retained.transcript,
  transcriptUpdate,
  applyDetailMode,
);
```

The validated update hint selects bounded immutable projection; mode and boundary changes retain the
full-rebuild fallback.

#### Wrong

```typescript
const boundary = list.raw.slice(list.raw.length - lastItem.raw.length) + appended;
```

#### Correct

```typescript
const boundary = list.raw.slice(retained.lastItemOffset) + appended;
```

Marked may keep streamed trailing whitespace in `list.raw` without assigning it to
`lastItem.raw`; the retained source offset preserves those bytes for boundary reparsing.

#### Wrong

```typescript
const replacement = renderPlainQuote(nextText.slice(lastSourceLineStart));
```

#### Correct

```typescript
const replacement = renderPlainQuote(
  nextText.slice(lastSourceLineStart),
  { continuesPreviousLine: lastSourceLineStart > 0 },
);
```

The continuation flag reconstructs the ANSI state that the full multiline quote renderer carries
across literal newlines. Cache creation accepts the fast path only after its final-line suffix is
byte-equal to the full render.

#### Wrong

```typescript
cached.lines.splice(cached.bottomLineStart, 1, renderRow(appendedRow), renderBottom());
```

#### Correct

```typescript
const nextWidths = resolveTableColumnWidths(retainedMetrics, changedRowMetrics, width);
if (!arraysEqual(nextWidths, cached.columnWidths)) return renderCompleteTable(token);
replaceRenderedTableSuffix(cached, changedRows, nextWidths);
```

Column metrics are the proof that the stable rendered prefix remains valid. Marked separately proves
that the cached header plus final-row source boundary still forms exactly one complete table token.

#### Wrong

```typescript
ui.insertHistoryBeforeNextFrame(viewport.takeNewScrollbackLines(width, true));
```

#### Correct

```typescript
if (assistant.holdsNativeScrollbackTail()) {
  viewport.discardPendingScrollbackLines();
  if (sourceReplay) {
    ui.insertHistoryBeforeNextFrame(
      viewport.scrollbackPrefixBefore(chat, assistantIndex, width),
      { replaceScrollback: true },
    );
  }
  return;
}
if (tableTailWasHeld) queueNativeTranscriptHistory(true);
```

An active table is not stable history: any later row may change every column width. Resize replays
only the bounded safe prefix before the assistant; completion performs one canonical full-source
replacement before ordinary native-scrollback delta collection resumes.

## Scenario: No-Op Terminal Frame Suppression

### 1. Scope / Trigger

- Trigger: changing frame scheduling, terminal line diffing, native scrollback repainting, hardware
  cursor positioning, or repeated runtime state projection.
- The scheduler retains the Codex-compatible 120 FPS ceiling; this contract prevents a scheduled
  draw with no visible change from becoming terminal output.

### 2. Signatures

- Retained cursor state:
  `HardwareCursorUpdate { sequence: string; row: number; col: number; visible: boolean;
  positionKnown: boolean }`.
- Frame request: `TUI.requestRender(force?: boolean) -> void`.
- Terminal output boundary: `Terminal.write(data: string) -> void`.
- Retained line differ:
  `TerminalLineDiffer.diff(previousLine, nextLine, maxWidth) -> TerminalLinePatch | null`.

### 3. Contracts

- Coalesced draw requests may still evaluate the current bounded frame, but emit zero terminal
  writes when cells, Kitty image ownership, hardware cursor row/column, and cursor visibility are
  unchanged.
- Inline and native-scrollback modes apply the same no-op rule. Native mode must not emit an empty
  synchronized-output pair merely because a frame was requested.
- Hardware cursor state is retained after every full frame, cell patch, cursor-only update,
  explicit hide, terminal release, and terminal reacquisition.
- A content write without a cursor marker invalidates retained row/column certainty. The next
  marker-bearing frame must issue an absolute cursor position even when its logical position equals
  the last known marker position.
- If the cursor marker moves while rendered cells stay identical, emit one synchronized cursor
  update and preserve the screen contents. This is required for IME candidate positioning and the
  optional visible hardware cursor.
- A real content, image, or cursor change remains one atomic terminal write. Force redraw, resize,
  resume, and terminal ownership transitions continue to invalidate the appropriate baseline.
- Each `TUI` instance owns one bounded `TerminalLineDiffer`. It retains semantic terminal-cell
  snapshots across inline and native-scrollback frames so the current `nextLine` snapshot becomes
  the following frame's reusable `previousLine` snapshot.
- The snapshot-cache key is the exact normalized ANSI line. Terminal width is not part of the key
  because semantic cell snapshots are width-independent; `maxWidth` is applied only when building
  the changed suffix patch.
- The cache uses bounded least-recently-used eviction and retains both valid snapshots and `null`
  fallback results. Image lines bypass semantic snapshotting, while unsupported control sequences
  continue to return `null` and trigger a full-line repaint.
- Semantic line diffing preserves both the equal prefix and equal suffix. It emits only the middle
  changed cell interval, expands either boundary rather than splitting a wide-cell continuation,
  and replays the active ANSI/OSC state required by the replacement cells.
- A middle interval ends with the terminal segment reset but does not erase the stable suffix. When
  the changed interval reaches the new semantic line end, it additionally emits `EL` so shortened
  content cannot leave stale cells behind.
- Raw ANSI string inequality is not sufficient evidence of a changed frame. Inline and native
  rendering both precompute semantic patches for same-length frames; when every patch is empty,
  update the retained raw-line baseline and emit no content transaction. Hardware cursor movement
  remains independently eligible for one cursor-only transaction.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Repeated inline render with identical frame and cursor | Zero terminal writes |
| Repeated native-scrollback render with identical frame and cursor | Zero terminal writes |
| Same cells, different cursor column | One synchronized cursor write |
| Same cells, cursor visibility toggled | One synchronized cursor write |
| Marker returns after marker-free content repaint | Reacquire its absolute row and column |
| Changed line or removed Kitty image | One synchronized frame write |
| Forced redraw or terminal reacquisition | Rebuild the frame; never reuse stale cursor state |
| Positive safe-integer snapshot bound | Retain no more than that many exact line snapshots |
| Invalid, non-positive, or unsafe snapshot bound | Fall back to the finite default bound |
| Image line or unsupported control sequence | Bypass/fail semantic diffing and repaint the line |
| Equal semantic suffix after changed cells | Leave suffix cells untouched; do not emit `EL` |
| Changed interval reaches new line end | Reset styles and emit `EL` to clear any stale tail |
| Diff boundary intersects a wide cell | Expand to the complete grapheme cell span |
| Different SGR/OSC bytes produce equal semantic cells | Zero content writes in both render modes |

### 5. Good/Base/Bad Cases

- Good: duplicate status projection schedules a frame but produces no PTY bytes.
- Base: one streamed token changes a suffix and uses the existing ANSI-safe cell patch.
- Good: a streamed line's next snapshot is reused as the previous snapshot on the following frame;
  old snapshots are evicted at the configured bound.
- Good: a one-cell spinner change before `Working (24s · esc to interrupt)` writes only the spinner
  cell and terminal resets; the stable suffix remains in the terminal buffer.
- Good: canonical-equivalent SGR ordering updates the retained raw-line baseline without emitting
  an empty synchronized-output pair.
- Bad: write `CSI ?2026h`, cursor-hide, and `CSI ?2026l` for every unchanged state event.
- Bad: suppress a cursor-only move because the line bytes are equal; IME placement becomes stale.
- Bad: include `maxWidth` in the snapshot key or use an unbounded map, causing duplicate parsing or
  memory growth without changing terminal-cell semantics.
- Bad: append `EL` to every middle-of-line patch; it erases the suffix that the diff intentionally
  retained and produces visible flicker until another write reconstructs it.
- Bad: treat `previousLine !== nextLine` as proof that terminal cells changed and write cursor
  movement plus synchronized-output wrappers around an otherwise empty patch.

### 6. Tests Required

- Renderer tests clear captured writes after an initial frame, request an identical inline frame,
  and assert the write count remains zero.
- Repeat the same assertion after native scrollback has anchored a committed history row.
- Render an identical line with a moved `CURSOR_MARKER` and assert one synchronized absolute-column
  update plus unchanged visible cells.
- Run an xterm-headless native-scrollback stress sequence that overlaps debounced resize, assistant
  tail replacement, editor cursor movement, subagent chrome updates, and output backpressure. Assert
  the final frame and cursor are in bounds, every visible row fits the terminal width, and no
  coalesced intermediate assistant text leaks into the visible screen or scrollback.
- Repeat a blocked multi-resize burst in alternate-screen mode. It must converge to the latest frame
  with one viewport clear, no host-scrollback clear, no intermediate text write, and an in-bounds
  cursor.
- Keep a separate native `node-pty` smoke for the real `ProcessTerminal` path. Resize the child PTY
  during assistant/editor/subagent streaming, require the final content, and assert synchronized
  output plus bracketed-paste, keyboard-protocol, and cursor cleanup before the child exits.
  Reconstruct complete UI text with an xterm cell buffer that receives output and resize operations
  in order. The raw PTY stream is valid for control-sequence assertions only because a cell diff may
  preserve an unchanged prefix and emit just the replacement suffix.
- Existing atomic-frame, output-backpressure, wide-cell, resize, suspend/resume, and terminal
  cleanup tests remain green.
- Unit-test retained line snapshots with an injectable snapshot function: chained frame diffs reuse
  the shared line, configured bounds evict the least-recently-used line, and invalid bounds retain
  the finite default behavior.
- Unit-test minimal changed intervals for a spinner, style-only cells, and CJK wide cells. Assert the
  patch omits the stable suffix and `EL`; a headless terminal integration test must still converge
  to the complete expected line.
- Render semantically equal but byte-distinct SGR lines in inline and native-scrollback modes;
  clear captured writes before the second frame and assert that both modes emit zero writes.

### 7. Wrong vs Correct

#### Wrong

```typescript
terminal.write(`\x1b[?2026h${cursorHide}\x1b[?2026l`);
```

#### Correct

```typescript
if (frameChanged) writeFrame();
else positionHardwareCursorOnlyWhenChanged();
```

#### Wrong

```typescript
const previous = snapshotTerminalCells(previousLine);
const next = snapshotTerminalCells(nextLine);
```

#### Correct

```typescript
const linePatch = this.lineDiffer.diff(previousLine, nextLine, width);
```

The retained differ is owned by the `TUI`, shared by both rendering modes, and bounded independently
of terminal width.

#### Wrong

```typescript
content = `${reset}${replacement}${reset}\x1b[K`;
```

#### Correct

```typescript
content = `${reset}${replacement}${reset}${changedThroughLineEnd ? "\x1b[K" : ""}`;
```

Middle patches preserve equal suffix cells. Tail patches clear through the terminal line end.

#### Wrong

```typescript
if (previousLine !== nextLine) terminal.write(synchronizedEmptyPatch);
```

#### Correct

```typescript
if (linePatch?.content === "") updateRetainedBaselineWithoutContentWrite();
```

Cursor-only changes are evaluated after semantic content suppression, not suppressed with it.

#### Wrong

```typescript
assert.match(rawPtyOutput, /pty-ready/);
```

#### Correct

```typescript
await replayPendingOutput();
terminal.resize(columns, rows);
assert.match(readTerminalCells(terminal), /pty-ready/);
```

The renderer may transform `pty-draft` into `pty-ready` by emitting only `ready`; only the replayed
cell buffer represents the complete terminal text.

## Scenario: Unix TUI Job-Control Suspend And Resume

### 1. Scope / Trigger

- Trigger: changing terminal ownership, raw input, `Ctrl+Z`, process signals, alternate-screen
  behavior, frame scheduling, or resume-time resize handling.
- This contract applies to the interactive Node TUI on Unix. Windows has no `SIGTSTP` job control
  and retains its existing input behavior.

### 2. Signatures

- TUI hooks: `TUI.onSuspend?: () -> boolean`, which requests process-group suspension, and
  `TUI.onResume?: () -> void`, which lets the owner restore source-backed terminal content after
  terminal ownership is reacquired without a resize.
- Shell option: `MycliShellRuntimeOptions.onSuspend?: () -> boolean`.
- Production callback: `process.kill(0, "SIGTSTP") -> boolean`.

### 3. Contracts

- A press event matching `Ctrl+Z` is intercepted before shell/editor input listeners only when an
  `onSuspend` hook exists. Kitty key-release events never trigger suspension.
- Before invoking the hook, the TUI stops its frame scheduler, shows the cursor, releases terminal
  ownership, disables bracketed paste and mouse modes, leaves the alternate screen when active,
  pauses input, and restores the previous raw-mode state.
- Before the hook runs, the TUI queues a zero-delay resume callback. The production hook suspends
  the complete foreground process group, not only the TUI module. A stopped process cannot execute
  that callback, so it runs only after `SIGCONT` places the job back in the foreground. If job
  control is unavailable or the signal fails, the next event-loop turn restores the TUI.
- The resume callback reacquires terminal ownership, restores its input modes and
  alternate screen, hides the cursor, reconnects output backpressure, invokes the resume hook when
  dimensions are unchanged, and forces a full frame.
- In inline native-scrollback mode, the shell resume hook replaces scrollback from the bounded
  canonical transcript source. This removes job-control text and stale pre-suspend rows before the
  live viewport is repainted. Alternate-screen mode needs only its newly entered buffer repaint.
- If columns or rows changed while suspended, the existing resize callback runs before that forced
  frame so native scrollback reflow remains debounced and source-backed.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Unix `Ctrl+Z` with suspend hook | Release terminal, suspend process group, reacquire, force redraw |
| Kitty `Ctrl+Z` key release | Ignore; do not suspend a second time |
| Windows or missing hook | Preserve the existing focused-component input path |
| Same dimensions after native-scrollback resume | Replace scrollback from transcript source, then force redraw |
| Same dimensions after alternate-screen resume | Force redraw in the newly entered buffer |
| Dimensions changed while stopped | Run resize hook, then force the resumed frame |
| Alternate-screen mode | Leave before suspend and re-enter before repaint |
| Suspend hook throws | Reacquire terminal ownership, consume the reserved key, and remain usable |

### 5. Good/Base/Bad Cases

- Good: suspend from an alternate-screen session, observe normal shell terminal state, run `fg`,
  and receive one complete fresh TUI frame.
- Good: suspend from an inline session, let the shell print job-control text, run `fg`, and receive
  exactly one canonical transcript without the shell text or stale frame rows.
- Base: resume at the same dimensions and rebuild only from bounded durable runtime/session state.
- Bad: send `SIGTSTP` while raw mode and bracketed paste remain enabled.
- Bad: resume with the old diff baseline; a newly re-entered alternate screen may remain blank.
- Bad: signal only the TUI process while the provider/runtime process continues in the background.

### 6. Tests Required

- TTY integration tests assert raw mode is false and alternate screen has been left inside the
  suspend callback, then assert modes are restored and the changed frame is rendered afterward.
- Tests assert a dimension change invokes the resize callback exactly once.
- A headless terminal integration test asserts same-size native resume emits `CSI 3 J`, removes
  shell job-control text, and renders each canonical transcript row once.
- Tests assert key-release and failed-signal paths cannot double-suspend or strand raw-mode state.
- Existing shutdown, resize, output-backpressure, input, native-scrollback, and frame-diff tests
  remain green.

### 7. Wrong vs Correct

#### Wrong

```typescript
process.kill(process.pid, "SIGTSTP");
```

#### Correct

```typescript
ui.onSuspend = () => process.kill(0, "SIGTSTP");
ui.onResume = () => queueNativeTranscriptHistory(true);
// TUI releases terminal ownership before suspension, then replaces inline history from source.
```

## Scenario: Codex-Style Plan Mode Proposal Handoff

### 1. Scope / Trigger

- Trigger: changing collaboration-mode instructions, per-turn tool exposure, proposed-plan parsing,
  `turn.submit`, `plan.proposed`, transcript resume projection, or the TUI implementation prompt.
- This contract covers the Plan-mode proposal handoff. It is separate from the Default-mode
  `update_plan` progress checklist contract below.

### 2. Signatures

- Runtime configuration:
  `configureRuntimeContext({collaborationMode: "default" | "plan", turnId?: string}) -> void`.
- Gateway request: `turn.submit {message, client_turn_id, client_user_message_id,
  collaboration_mode?: "default" | "plan", local_images?}`.
- Final assistant block: an exact standalone `<proposed_plan>` line, Markdown body, and exact
  standalone `</proposed_plan>` line.
- Gateway event: `plan.proposed {client_turn_id, text, source="assistant_message"}`.
- TUI update: `setState(state, {eventType?: string})`; only `eventType="plan.proposed"` may open
  the implementation selector.
- TUI implementation callback:
  `onPlanImplementation(action: "implement" | "clear_context", planMarkdown) -> Promise<void>`.
- Context projection: `status.changed.context_window {used_tokens, max_tokens, usage_ratio,
  source}` becomes TUI footer fields `contextPercent`, `contextWindow`, and `contextUsedTokens`.
- Prompt label helper:
  `planImplementationContextUsageLabel(contextPercent?, contextUsedTokens?) -> string | undefined`.

### 3. Contracts

- Each turn freezes its collaboration mode before the first provider request. A later global mode
  change cannot change that turn's instructions or tool exposure.
- Plan mode injects the Plan developer instruction but keeps the provider-visible built-in and direct
  extension schema stable across modes. `Read`, `Shell` (when the active policy exposes process
  tools), `Write`, `Edit`, and `Patch` therefore remain in the schema instead of being removed based
  on a declared filesystem effect. The instruction tells the model to use only read-only
  investigation and verification; mutation calls still follow the ordinary approval and sandbox
  policy rather than receiving a Plan-mode permission bypass.
- `update_plan` remains in the stable schema for cache compatibility, but a Plan-mode call is persisted
  as a failed result with `errorKind=tool_not_allowed_in_plan_mode` without approval, hooks, previews,
  or router execution. This is the only built-in Plan-mode tool rejection.
- The gateway recognizes exactly one non-empty proposed-plan block with exact standalone tag
  lines. It removes that block from ordinary assistant output and emits one dedicated
  `plan.proposed` event. Inline, malformed, empty, or multiple blocks remain ordinary text.
- Completion order is `message.complete`, then active-turn release and
  `status.changed(turn_running=false)`, then `plan.proposed`. This prevents an implementation
  submission from being classified as steering or queued follow-up input.
- Live `plan.proposed` opens the selector only while the current UI mode is Plan and there is no
  queued input, approval, clarification, transcript viewer, or other selector. Transcript load,
  bootstrap, session resume, and older-history pagination restore a `proposed_plan` block without
  synthesizing the live event and therefore never reopen the selector.
- The selector labels match Codex: `Yes, implement this plan`,
  `Yes, clear context and implement`, and `No, stay in Plan mode`. Direct implementation submits
  `Implement the plan.` atomically with `collaboration_mode=default`. Clear-context implementation
  creates a new session, submits the Codex carry-forward prefix plus the complete plan, and selects
  Default in the same turn. Stay/Escape closes only the prompt and leaves Plan mode active.
- The clear-context description uses `Fresh thread. Context: <usage>.` when context use is known and
  non-zero. A known percentage takes precedence over token counts and follows Codex rounding: round
  the remaining percentage first, then subtract it from 100. When no window percentage is known,
  use non-zero `contextUsedTokens` with Codex `K/M/B/T` compact formatting. Unknown or effectively
  fresh context keeps the neutral `Fresh thread with this plan.` description.
- Context usage must come from the latest provider-step `status.changed.context_window`, not
  cumulative session usage. This keeps the clear-context trade-off factual and avoids implying that
  starting fresh will discard more active context than it actually will.
- `update_plan` remains a Default-mode implementation progress tool. It neither enters nor exits
  Plan mode; it stays listed for schema stability but is rejected with a failed result during Plan
  turns.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Unsupported `turn.submit.collaboration_mode` | Reject with `invalid_params` before turn execution |
| Global mode changes during a turn | Keep the frozen turn mode and exposure |
| Provider calls `update_plan` in Plan mode | Persist a failed result; run no side-effect boundary |
| Provider calls a visible mutation tool in Plan mode | Apply ordinary approval/sandbox policy |
| One exact non-empty proposal block | Strip ordinary output and emit one live proposal after idle |
| Inline, malformed, empty, or multiple blocks | Preserve as ordinary assistant text; emit no proposal |
| Valid proposal restored by `transcript.load` | Project a plan block; emit no live event or selector |
| Live proposal while another input surface is active | Keep the existing surface; do not replace it |
| Direct implementation selected | Switch to Default and submit one implementation turn |
| Clear-context implementation selected | Create a fresh session, then submit the full plan in Default |
| Stay or Escape selected | Dismiss the selector and remain in Plan mode |
| Implementation request fails | Keep the selector usable and show the bounded error |
| Known context percentage rounds to zero used | Keep the neutral clear-context description |
| Percentage unavailable and used tokens are positive | Show compact `<tokens> used` context text |
| Context metrics are negative, non-finite, or exceed the window | Ignore non-finite values and clamp percentage to `0..100` |

### 5. Good/Base/Bad Cases

- Good: a Plan turn investigates with read-only tools, returns one complete proposal, becomes idle,
  and then presents the three Codex implementation choices.
- Good: process restart reconstructs the dedicated proposal from durable assistant text without
  adding another transcript row or prompting again.
- Good: a 73% active-context load renders `Fresh thread. Context: 73% used.` only on the
  clear-context choice.
- Base: a Plan answer without a complete proposal renders as ordinary assistant text and stays in
  Plan mode.
- Base: missing or zero context usage retains `Fresh thread with this plan.` without implying that
  context cleanup is useful.
- Bad: remove mutation schemas based on their filesystem effect and thereby change the Plan request
  shape, or send a Plan-mode `update_plan` call through approval/hooks/router before rejecting it.
- Bad: infer prompt eligibility from the presence of a historical plan item; this reopens the
  selector on every resume.
- Bad: run `/mode default` and `/new` as visible slash-command transcript entries for a selector
  action.
- Bad: use cumulative `usage.input_tokens` for the prompt label; it counts prior turns that are not
  part of the current model context.

### 6. Tests Required

- Instruction tests assert decision-complete Plan guidance and standalone proposal tags.
- Runtime tests assert frozen mode, stable built-in exposure, durable `update_plan` denial output,
  zero approval/hook/router calls for that denial, and ordinary policy handling for visible mutation
  calls.
- Parser tests cover CRLF, arbitrary stream chunking, surrounding text, unterminated candidates,
  malformed/inline/empty blocks, and multiple blocks.
- Gateway tests assert atomic `turn.submit.collaboration_mode`, stripped final output, exactly one
  proposal, `message.complete -> idle status -> plan.proposed`, and resume projection without a live
  event.
- TUI tests assert live-only prompting, resume without prompting, all three action routes, Escape,
  conflicting input surfaces, and narrow-terminal width safety.
- Reducer tests assert canonical `used_tokens/max_tokens/usage_ratio` projection, while formatter
  tests cover percentage precedence, fresh context, token fallback, compact-unit boundaries, and
  selector integration.

### 7. Wrong vs Correct

#### Wrong

```typescript
if (state.transcript.some((item) => item.type === "proposed_plan")) {
  showPlanImplementationSelector();
}
```

This reopens an action prompt while loading durable history.

#### Correct

```typescript
if (eventType === "plan.proposed" && state.footer.collaborationMode === "plan") {
  showPlanImplementationSelector();
}
```

Historical projection restores the plan block, while only the live terminal event can request a
new implementation decision.

#### Wrong

```typescript
const usageLabel = `${footer.totalInputTokens} used`;
```

This uses cumulative session traffic rather than the active context window.

#### Correct

```typescript
const usageLabel = planImplementationContextUsageLabel(
  footer.contextPercent,
  footer.contextUsedTokens,
);
```

The reducer derives both fields from `status.changed.context_window`; the prompt omits the label
when those active-context metrics do not establish a meaningful cleanup trade-off.

## Scenario: Durable Append-Only Plan Updates

### 1. Scope / Trigger

- Trigger: changing `update_plan` execution effects, runtime event ordering, plan history storage,
  transcript projection, `plan.updated`, TUI plan rendering, or resume behavior.

### 2. Signatures

- Runtime event: `plan_updated {explanation?, items: {id, text, status}[]}`.
- Durable history item: `type=plan_update`, `text="Updated Plan"`, `call_id`, `tool_name`, and
  model-hidden metadata `{source, explanation?, completed, total, items, model_visible:false}`.
- Gateway event: `plan.updated {client_turn_id, plan_steps, plan:{items}, source, completed, total,
  explanation?}`.
- TUI model: `MycliShellPlanUpdate {id, title, source?, explanation?, steps, completed, total}`.

### 3. Contracts

- A successful `update_plan` tool call/result remains in the canonical provider conversation. The
  structured `plan_update` display copy is appended to history in the same SQLite transaction as
  its tool result and never enters provider input.
- Storage accepts a plan effect only from a successful result whose tool name is `update_plan`.
  It validates item count, ids, text, statuses, explanation length, and the single-active-item
  invariant again at the durable boundary.
- Runtime emits `plan_updated` only after persistence succeeds. The gateway then derives rendered
  rows and counts without reading provider arguments or private metadata.
- Every successful call is retained as real tool activity, including an identical repeated plan.
  Append-only history is authoritative; no component rewrites an earlier plan item or silently
  removes a repeated call.
- Live TUI handling appends one immutable plan transcript item. Resume projects the model-hidden
  durable copy into the same shape, displays the optional explanation, and derives task progress
  from the latest valid plan update.
- Plan metadata has a dedicated readable-transcript allowlist. `source`, `explanation`, `completed`,
  `total`, and `items` are projected only when the item type is `plan_update`; other history types
  cannot expose those fields by supplying lookalike metadata.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Successful valid update | Commit tool result then `plan_update`; emit live event afterward |
| Failed result with a plan effect | Reject the storage write and append neither row |
| Wrong tool name with a plan effect | Reject the storage write and append neither row |
| More than 128 items, blank/oversized text, invalid status, or two active items | Reject atomically |
| Gateway/TUI receives malformed structured items | Ignore the plan update rather than partially render it |
| Resume after process restart | Restore all durable plan items without adding provider messages |
| Non-plan item contains plan-like metadata | Omit the plan-only fields from readable transcript |

### 5. Good/Base/Bad Cases

- Good: persist `tool_result` and its hidden plan display copy atomically, then publish
  `plan.updated`; a restart reconstructs the same visible plan update.
- Base: an empty plan renders a bounded cleared-plan history item and clears derived progress.
- Bad: emit the live event before the durable write and show state that resume cannot recover.
- Bad: put the structured display copy in provider conversation, rewrite an earlier history row,
  or keep a mutable active-plan panel as the source of truth.
- Bad: add plan fields to the generic transcript metadata allowlist.

### 6. Tests Required

- Tool/runtime tests assert the structured effect and persistence-before-event ordering.
- SQLite tests assert one model-visible tool result, one model-hidden history copy, atomic rejection
  of failed/spoofed effects, and bounded plan validation.
- Gateway contract tests assert structured items, explanation, source, counts, and legacy rendered
  `plan_steps` on both direct and mirrored runtime events.
- TUI reducer/component tests assert live rendering, resume rendering, explanation wrapping, empty
  plans, malformed-item rejection, immutable transcript order, and latest-plan progress derivation.
- Transcript projector tests assert the plan-only allowlist cannot leak through other item types.
- A real two-step Responses integration test asserts provider continuation contains only the tool
  call/result while `transcript.load` restores the hidden plan copy.

### 7. Wrong vs Correct

#### Wrong

```typescript
emit({ type: "plan_updated", items });
store.appendToolResult({ ...result, planUpdate: { items } });
activePlan.items = items;
```

#### Correct

```typescript
store.appendToolResult({ ...result, planUpdate: { items } });
emit({ type: "plan_updated", items });
// TUI appends the event; resume derives the same item from durable history.
```

## Scenario: Semantic Tool Row Suppression

### 1. Scope / Trigger

- Trigger: changing Node TUI projection for tool lifecycle rows that are pure coordination or have
  a dedicated semantic surface.

### 2. Signatures

- Projection predicate: `suppressGenericToolRow(tool: MycliShellTool) -> boolean`.
- Storage projection: `visibleToolMetadata(item) -> Readonly<Record<string, unknown>>`.
- Resume normalization: `coalesceResumedShellOutputItems(items) -> RuntimeTranscriptItem[]`.
- Suppressed normalized names: `askuserquestion`, `followuptask`, `interruptagent`, `killshell`,
  `listagents`, `sendmessage`, `spawnagent`, `toolsearch`, `updateplan`, and `waitagent`.

### 3. Contracts

- Suppression is display-only. Reducer state, append-only history, tool results, provider replay,
  trace data, and storage projection retain the original call and result.
- Running and successful generic rows for `AskUserQuestion`, the subagent coordination toolset,
  `KillShell`, `tool_search`, and `update_plan` are omitted. Their useful state is carried by the
  clarification selector, durable task/mailbox state, the originating Shell state, deferred-tool
  activation, live wait status, immutable `plan_update` blocks, and subagent task state.
- Failed or cancelled calls are always visible. Unknown MCP/plugin tools and tools with filesystem,
  process, or network effects remain visible by default.
- Live events and resumed transcript items pass through the same TUI projection predicate so a
  restart cannot reintroduce a generic row hidden during the original run.
- `WriteStdin`, `ShellOutput`, and `BashOutput` are polling lifecycle aliases rather than generic
  suppressed tools. Storage may derive only their bounded parent `shell_id` from structured
  `arguments.shell_id`, `arguments.session_id`, or `arguments.bash_id`; it must not expose the raw
  argument object or input text in readable snapshots.
- Successful polling rows merge into the matching Shell card and never render independently. A
  successful orphan poll is omitted as a display-only compatibility fallback; failed or cancelled
  orphan polls remain visible. A poll without terminal metadata must preserve an existing parent
  Shell terminal state and exit code instead of changing a completed Shell back to running.
- Poll merging must preserve the parent command across gateway generations. Resolve it from
  `command_preview`, then legacy `command`, then the existing display target; write the resolved
  value back as canonical `command_preview` instead of replacing it with a placeholder.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Suppressed tool is running or successful | Omit only its generic tool row |
| Suppressed tool fails or is cancelled | Render the normal error/cancelled tool row |
| Dedicated plan or subagent state exists | Preserve that semantic state |
| Unknown or side-effecting tool | Render by default |
| Transcript is resumed | Apply the same status-sensitive predicate without rewriting history |
| Poll arguments contain a recognized parent id | Project only canonical `shell_id`; drop all other arguments |
| Successful poll has no matching parent Shell | Omit the independent poll row |
| Failed or cancelled poll has no matching parent Shell | Preserve the error/cancelled row |
| Poll omits terminal state after parent Shell completed | Keep the parent's terminal state, exit code, and status |
| Resumed parent stores its command only in legacy `metadata.command` | Preserve that command on the merged Shell card |

### 5. Good/Base/Bad Cases

- Good: `update_plan` produces one `Updated Plan` block and no duplicate generic card.
- Good: repeated successful `wait_agent` calls leave the transcript stable while the footer carries
  live waiting state.
- Base: a failed `tool_search` renders a compact error row.
- Base: a legacy `WriteStdin(arguments.session_id=...)` snapshot merges into its completed Shell
  card without exposing stdin or rendering a second card.
- Bad: delete the canonical tool call/result or filter it from provider replay.
- Bad: hide every MCP/plugin tool based only on a naming convention.
- Bad: treat every projected tool carrying `shell_id` as the Shell execution itself; polling tools
  still complete independently even though their display is folded into the parent Shell card.

### 6. Tests Required

- Reducer projection tests cover running/success suppression and failed-call visibility for all ten
  normalized names.
- Resume tests feed equivalent persisted tool items through `runtimeStateFromTranscript` and assert
  the same visible tool list.
- Storage projection tests cover all three polling aliases, each accepted parent-id argument name,
  completed poll status, and exclusion of raw arguments/private stdin.
- Live and resume tests cover successful orphan suppression, failed orphan visibility, and a
  terminal parent Shell followed by a poll without terminal metadata; the legacy
  `metadata.command` value must survive unchanged.
- Plan and subagent tests assert their dedicated semantic blocks remain available.
- Existing Shell polling, mutation, Read grouping, and provider replay tests remain green.

### 7. Wrong vs Correct

#### Wrong

```typescript
history = history.filter((item) => item.toolName !== "wait_agent");
```

#### Correct

```typescript
const tool = toolFromTranscriptItem(item, workspace, detailMode);
if (suppressGenericToolRow(tool)) continue;
// Canonical history and model replay remain unchanged.
```

For Shell polling, normalize only the parent identifier and preserve terminal ownership:

```typescript
const effectiveTerminalState = incomingTerminalState ?? existingTerminalState;
const commandPreview = metadata.command_preview ?? metadata.command ?? display.target;
if (successfulPoll && !matchingShell) continue;
// Failed polling calls remain visible; append-only history remains unchanged.
```

## Scenario: Effective Permission And Sandbox Readiness Projection

### 1. Scope / Trigger

- Trigger: changing permission presets, managed/runtime execution-policy constraints, sandbox
  platform probes, `permissions.*` or status payloads, the permission selector, doctor process
  checks, or the provider-free sandbox management command.

### 2. Signatures

- Runtime truth: `ExecutionPolicyCoordinator.snapshot() -> ExecutionPolicySnapshot`.
- Read-only platform probe:
  `inspectSandboxReadiness(probes?, signal?) -> Promise<SandboxReadiness>`.
- Recovery transition:
  `runSandboxRecovery(action, confirmed, probes?, signal?) -> Promise<SandboxRecoveryResult>`.
- Management commands: `mycli sandbox status|setup|reset [--confirm] [--json]`.
- Gateway queries: `permissions.list({})`, `status.inspect({})`, and `session.bootstrap(...)`.
- TUI projection:
  `permissionStateFromUnknown(value) -> MycliShellPermissionState | null`.

### 3. Contracts

- `permissions.active` is the selected `read-only`, `workspace`, or `full-access` preset. It is not
  proof of effective access.
- `permissions.effective` is derived from the runtime snapshot and contains only bounded structural
  values: `trusted`, `valid`, `sandbox_mode`, `filesystem`, `network`, `approval_behavior`,
  `source`, `constrained`, optional `constraints_source`, root/domain counts, and grant booleans.
- Managed/runtime constraints and active grants are never recomputed by the gateway or TUI.
  `ExecutionPolicySnapshot.profile` is the authoritative effective filesystem/network boundary.
- Every profile row carries nominal `sandbox_mode`, `filesystem`, `network`, and
  `approval_behavior` effects. The TUI consumes those fields and does not maintain a second copy of
  preset semantics.
- `sandbox_readiness` uses the closed states `ready`, `setup_required`, `unavailable`, and
  `not_required`, plus the closed codes `ready`, `setup_incomplete`, `helper_missing`,
  `handshake_failed`, `enforcement_unavailable`, `unsupported_platform`, and `not_required`.
- The management readiness response may additionally project bounded `helper_version`,
  `helper_compatible`, `setup_complete`, and `sandbox_ready` facts. A protocol mismatch remains
  `handshake_failed` with `helper_compatible=false`; gateway/TUI projections may retain only the
  base readiness fields and never infer compatibility from rendered text.
- Full Access maps readiness to `not_required` only when the effective profile needs no process
  isolation. A managed network/root/domain restriction keeps platform readiness relevant.
- macOS checks the fixed Seatbelt executable. Linux first finds a fixed bubblewrap candidate and
  then runs one bounded read-only capability probe covering user, PID, and network namespaces;
  executable presence alone is not readiness. The probe has a five-second timeout and a 16-KiB
  output cap. Windows checks the packaged helper and runs only a bounded `--handshake`: five-second
  timeout, 16-KiB output cap, exact helper identity/protocol, and boolean setup/readiness fields.
- Readiness inspection never runs setup, elevation, repair, provider IO, TUI startup, or an
  interactive backend. Raw helper output, exceptions, paths, credentials, and tool arguments never
  enter the result.
- Backend startup caches one readiness result for gateway projections. `mycli sandbox status` uses
  a dedicated lazy management path; doctor calls the same classifier through its bounded collector.
- Setup/reset use the same lazy provider-free management path and typed readiness result. Both
  preview by default and require `--confirm` to execute. Windows setup declares `windows_uac`, maps
  helper exit code `2` to `operation_canceled`, and verifies readiness after execution. Windows reset
  declares no privilege, clears only mycli setup state, and preserves the account and firewall/WFP
  restrictions. macOS/Linux setup returns manual dependency guidance and never invokes a package
  manager; reset returns `no_managed_state`.
- A Windows reset is successful only when the post-operation handshake remains protocol-compatible
  and resolves to `setup_required/setup_incomplete` with both `setup_complete=false` and
  `sandbox_ready=false`. A false setup flag alone is insufficient because the helper may have become
  incompatible or malformed during the transition.
- Human and JSON rendering consume the same redacted response. Helper stdout/stderr, executable
  paths, local exceptions, stacks, credentials, and native arguments do not cross the tools boundary.
- `/permissions`, `/status`, bootstrap, `permissions.list`, and `permissions.update` project the
  same effective policy. Selecting a broader preset cannot remove managed/runtime constraints.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| macOS Seatbelt exists | `ready/ready` with the matching isolation |
| Linux bubblewrap exists and its namespace probe succeeds | `ready/ready` with `bubblewrap` isolation |
| Linux bubblewrap exists but namespace enforcement is denied or unavailable | `unavailable/enforcement_unavailable` |
| Required fixed executable is missing | `unavailable/helper_missing` |
| Windows helper reports setup incomplete | `setup_required/setup_incomplete`; do not elevate |
| Windows helper protocol version differs | `unavailable/handshake_failed` and `helper_compatible=false` |
| Windows handshake fails, times out, overflows, or is malformed | `unavailable/handshake_failed`; omit raw output |
| Windows setup exists but enforcement is unavailable | `unavailable/enforcement_unavailable` |
| Unsupported platform | `unavailable/unsupported_platform` with `isolation=none` |
| Setup/reset without `--confirm` | Return `confirmation_required` preview; perform no operation |
| Windows setup UAC canceled | Return `canceled/operation_canceled`; keep readiness bounded |
| Windows reset succeeds | Verify `setup_complete=false`; retain stricter native resources |
| Post-reset helper is incompatible or contradictory | `failed/verification_failed`, even when `setup_complete=false` |
| macOS/Linux dependency missing | Return `manual_action_required/dependency_install_required`; do not install |
| Effective profile is unrestricted filesystem and network | `not_required/not_required` |
| Selected Full Access is constrained by managed policy | Report the constrained effective profile and retained readiness |
| Gateway receives an invalid preset | `invalid_params`; keep the previous selected/effective state |
| TUI receives an older permission payload | Keep the preset rows; omit unknown effective/readiness facts |

### 5. Good/Base/Bad Cases

- Good: selected Full Access plus a managed writable-root cap renders `active=full-access`, the
  constrained effective filesystem, `constraints_source=managed`, and the platform readiness.
- Good: `mycli sandbox status --json` returns one bounded readiness object without loading config,
  extensions, a provider, the backend, or the TUI.
- Good: `mycli sandbox reset` previews one state-clearing effect, and `--confirm` removes only
  recreateable mycli state while retained restrictions remain authoritative.
- Base: an older gateway supplies only `active/profiles`; the selector remains usable without the
  TUI inventing effective-policy values.
- Bad: display `approval_behavior=never` merely because `active=full-access` after the runtime
  snapshot has constrained filesystem access.
- Bad: call the Windows setup helper, request UAC, or expose stderr while rendering status/preview.
- Bad: install a system dependency, delete the Windows sandbox account, or remove firewall rules as
  an implicit recovery action.

### 6. Tests Required

- Tools tests cover macOS/Linux ready and missing helpers, unsupported platforms, every Windows
  handshake state, malformed identity, missing helper, and exception redaction.
- Recovery tests cover no-confirm preview, setup/reset verification, UAC cancellation, version
  mismatch before and after reset, contradictory handshake state, partial enforcement, manual
  dependency guidance, unsupported platforms, and interruption.
- Gateway tests track trust/profile reconfiguration and assert bootstrap/status/permission payload
  equality, effective approval behavior, managed constraint source, and `not_required` Full Access.
- CLI tests assert status/setup/reset parsing, human/JSON rendering, stable exit codes, default
  no-mutation previews, no backend/provider/TUI start, and no helper path or native output.
- Doctor tests assert the process check uses the same readiness state/code and remains bounded.
- TUI reducer and selector tests assert typed projection, managed/readiness labels, old-payload
  fallback, and width-safe rendering.
- Full app, tools, TUI, lint, typecheck, and contract-drift suites remain green.

### 7. Wrong vs Correct

#### Wrong

```typescript
const approvalBehavior = selectedProfile === "full-access" ? "never" : "on-request";
const readiness = await runWindowsSetup();
```

#### Correct

```typescript
const snapshot = runtime.executionPolicySnapshot();
const approvalBehavior = snapshot.profile.filesystem === "unrestricted"
	? "never"
	: "on-request";
const readiness = await inspectSandboxReadiness();
```

The snapshot supplies effective authority; the readiness classifier observes platform capability
without mutating it.

For a recovery transition, verify the complete typed state rather than one native boolean:

#### Wrong

```typescript
if (after.setupComplete === false) return resetCompleted();
```

#### Correct

```typescript
const resetVerified = after.state === "setup_required"
	&& after.code === "setup_incomplete"
	&& after.helperCompatible === true
	&& after.setupComplete === false
	&& after.sandboxReady === false;
```

## Scenario: Unified Settings And Command Discovery

### 1. Scope / Trigger

- Trigger: changing `/settings`, `settings.load`, `settings.save`, slash registry discovery metadata,
  command palette/help/autocomplete behavior, or a dedicated domain selector reachable from settings.
- Settings is a bounded discovery and navigation surface. It must not become a generic config editor
  or duplicate model, credential, permission, trust, session, integration, or diagnostic ownership.

### 2. Signatures

```ts
type SettingsSaveRequest =
	| { readonly setting_id: string; readonly value: string | boolean }
	| { readonly settings: Readonly<Record<string, unknown>> }; // compatibility

interface SettingsSnapshotPayload {
	readonly settings: Readonly<Record<string, unknown>>;
	readonly sources: Readonly<Record<string, "default" | "user">>;
	readonly source: "defaults" | "user_config";
	readonly catalog: {
		readonly version: 1;
		readonly categories: readonly SettingsCategory[];
		readonly items: readonly SettingsItem[];
	};
}

interface CommandDiscoveryRow {
	readonly id: string;
	readonly name: string;
	readonly aliases: readonly string[];
	readonly category: string;
	readonly search_only: boolean;
	readonly available: boolean;
	readonly unavailable_reason?: string;
}
```

### 3. Contracts

- `settings.load` and successful `settings.save` return the same versioned snapshot shape. The seven
  categories are model, providers, permissions, appearance, sessions, integrations, and diagnostics.
- Catalog items contain stable id/category, kind, label, bounded description/value/source/scope,
  allowed values or action, lock state/reason, restart requirement, command path, and search terms.
  Credential values, raw policy/helper failures, absolute private paths, and unbounded extension text
  never enter the payload.
- The preferred save request carries exactly one visual descriptor id and typed value. Gateway
  validates against the config-owned shell descriptor catalog, rejects non-TUI ids, delegates one
  atomic write, and rebuilds the catalog from the authoritative post-write settings and sources.
- Session-scoped visual changes remain TUI-local and do not call `settings.save`. User-default changes
  show `old -> new`, require explicit scope selection, and roll back optimistic state in place if the
  request fails.
- Action rows open the existing model, login, permissions, trust, session, resource, or command flow.
  A selector stack returns one level on Esc and preserves the composer draft and focus.
- `command.list` derives aliases, category, search-only state, and availability from the canonical
  slash registry plus runtime capabilities. Default palette/help show common available commands;
  explicit fuzzy search may reveal matching search-only or unavailable rows, which cannot execute.
- Slash autocomplete excludes search-only and unavailable commands. Canonical parsing/routing stays
  independent of presentation metadata, and integration commands remain additive.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| `setting_id` is missing, unknown, or names a non-TUI config key | JSON-RPC `invalid_params`; do not echo the id or value |
| Value is not one of the descriptor's typed allowed values | JSON-RPC `invalid_params`; preserve settings and user config |
| User-default persistence fails | Keep settings selector mounted, restore prior state, preserve draft, render one bounded error |
| Session scope is selected | Apply locally and perform zero persistence RPCs |
| Catalog action capability is absent | Keep a bounded locked/searchable row or unavailable command reason; block execution |
| Esc is pressed in a nested settings selector | Return to settings before returning to the composer |
| Command is search-only or unavailable with an empty query | Omit it from default palette and autocomplete |

### 5. Good / Base / Bad Cases

- Good: search `api key`, open the existing login selector, cancel back to settings, and retain the
  unsent composer draft.
- Good: save only `tui.hide_thinking=false`; response marks that row `user` while unrelated defaults
  remain `default`.
- Base: a build has no integration resource service; direct search explains the locked resource row
  without exposing plugin/MCP errors.
- Bad: hard-code a second list of visual labels/values in the gateway or accept an arbitrary TOML path
  through `settings.save`.
- Bad: include hidden/unavailable commands in autocomplete or let a palette row bypass canonical
  command availability checks.

### 6. Tests Required

- Gateway tests assert all seven categories, bounded item fields, single-setting validation, accurate
  post-write sources, unavailable reasons, and sentinel redaction.
- Config/gateway/backend integration asserts one user-default change persists across restart without
  claiming unrelated defaults.
- TUI tests cover widths 60/80/100/140, CJK and Windows-style values, preview/scope selection, zero
  session persistence, user rollback, nested Esc, draft preservation, and blocked unavailable rows.
- Registry/docs drift tests cover canonical names, aliases, categories, search-only metadata, slash
  fixture hash, help grouping, and documented commands.

### 7. Wrong vs Correct

#### Wrong

```ts
await send("settings.save", { settings: effectiveVisualSettings });
openGenericConfigEditor(item.config_key);
```

#### Correct

```ts
await send("settings.save", {
	setting_id: item.configKey,
	value: selectedValue,
});
openExistingDomainSelector(item.action);
```

## Scenario: Unified Session Discovery And Explicit Recovery

### 1. Scope / Trigger

- Trigger: changing provider-free `session` management commands, `session.list`,
  `session.resume.preview`, `session.resume`, `/resume`, session selector rows, or status ownership
  projection.

### 2. Signatures

- Shared service: `SessionService.list`, `inspect`, `resolve`, `rename`, `archive`, `delete`,
  `fork`, `export`, `previewResume`, and `applyResumeRepair`.
- Management: `mycli session list|resume|fork|rename|archive|unarchive|delete|export`.
- Gateway: `session.list(query)`, `session.resume.preview({session_id})`, and
  `session.resume({session_id, repair_action?, metadata_revision?})`.
- Repair actions: `unarchive | fork_with_current_settings | takeover_stale_owner`.
- TUI boundary: `sessionSummaryFromUnknown`, `sessionResumePreviewFromUnknown`, and the focused
  `SessionRepairSelectorComponent`.

### 3. Contracts

- CLI and TUI use one app-owned session service for bounded filters, ordering, visibility, metadata,
  preference projection, and repair decisions. The TUI must not inspect SQLite or session files.
- A summary includes stable id/title/cwd/timestamps, model/provider/effort/mode/permission,
  lifecycle/storage status, message/summary counts, metadata revision, lease/pending states, and
  optional parent/fork relation. It excludes credentials, process ids, raw storage, and transcript
  bodies.
- Resume preview is provider-free and non-mutating. It distinguishes deleted/archived sessions,
  schema incompatibility, missing workspace/credential, unsupported model, permission conflict,
  active/stale ownership, and recoverable pending interaction.
- A ready preview resumes directly. A blocking issue with an action requires both the selected action
  and the previewed metadata revision. Preference/workspace repairs fork using current settings and
  never rewrite the source. Stale-owner confirmation leaves replacement to coordinator acquisition.
- Active owners and incompatible state without a safe action remain blocked. Expected repair errors
  do not become transcript notices. Esc cancels the TUI selector without mutation.
- Direct resume may fall through to coordinator only when the shared service reports
  `session_not_found`, preserving import of a legacy readable snapshot. Explicit preview remains
  strict and missing ordinary targets still fail in coordinator preparation.
- Successful transition publishes `session.changed`, then one complete `status.changed`, then any
  persisted approval or clarification request. Transcript reload remains canonical-event-derived.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Invalid filters/action/revision | `invalid_params`; do not mutate or switch |
| Ambiguous title | `session_ambiguous`; choose nothing |
| Blocking preview without action/revision | `session_repair_required` with bounded preview |
| Preview revision changed | `session_changed`; require a fresh preview |
| Selected action no longer available | `repair_not_available`; preserve source and active session |
| Active owner | Preview `active_owner`; no takeover action |
| Stale owner | Offer `takeover_stale_owner`; coordinator still performs atomic acquire |
| Legacy readable snapshot absent from SQLite | Direct resume delegates to coordinator import path |
| Repair or target preparation fails | Emit no target session/status events |

### 5. Good/Base/Bad Cases

- Good: select an archived session, confirm unarchive, resume its exact id, and reload one canonical
  transcript.
- Good: saved model disappeared, so create a child with current settings while source preferences
  and transcript remain byte-equivalent.
- Base: a ready session resumes without showing the repair selector.
- Bad: mutate during preview, let the TUI invent repair policy, silently displace a live owner, or
  treat `session_not_found` from every boundary as proof that a legacy snapshot exists.

### 6. Tests Required

- Storage/service tests cover every issue/action, metadata CAS, source immutability, redacted export,
  title ambiguity, archive/delete visibility, and provider-free execution.
- Gateway tests assert enriched list filters, strict preview, action/revision application, stale
  takeover handoff, legacy direct-resume fallback, event order, and source preservation on failure.
- Backend restart tests assert model/effort/mode/permission restoration and pending
  approval/clarification recovery.
- TUI parser/render tests cover malformed payloads, compact rows at narrow/CJK/Windows widths,
  keyboard repair selection, Esc cancellation, and actual repaired/forked target id.

### 7. Wrong vs Correct

#### Wrong

```ts
const selected = await tui.readSessionFiles(sessionId);
await gateway.send("session.resume", { session_id: selected.id, repair: "auto" });
```

#### Correct

```ts
const preview = await gateway.send("session.resume.preview", { session_id: sessionId });
if (preview.ready) return gateway.send("session.resume", { session_id: sessionId });
return gateway.send("session.resume", {
	session_id: sessionId,
	repair_action: selectedAction,
	metadata_revision: preview.session.metadata_revision,
});
```
