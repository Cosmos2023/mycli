# Runtime TUI Gateway Contract

> Contract for Python and Node runtime events consumed by the Node TUI.

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
- The frozen provider tool list is also an execution authorization set. A
  provider call for an unexposed tool fails with `tool_protocol_error` before
  assistant tool-call persistence or adapter execution.
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
  an unexposed `Shell` call returned by the provider.
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
  profile across reconfiguration, terminal release, and rejection of an
  unexposed provider tool call before persistence/execution.
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
- Trigger: Any change to `src/mycli/cli/node_tui/gateway.py`, the Node runtime
  gateway, the Node TUI protocol types, or the reducer state that changes
  runtime-to-TUI events.
- This is a cross-layer contract. Python owns runtime semantics and JSON-RPC
  emission; TypeScript owns rendering and reducer state.
- The target direction is Hermes-like channel separation, but existing mycli
  JSON-RPC method-name notifications remain compatible until a versioned
  envelope migration is introduced.

### 2. Signatures
- Python event emitter:
  `NodeTuiGateway._emit_event(method: str, params: dict[str, object]) -> None`
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
  - The accepted `turn.interrupt` RPC aborts the active controller, waits up to
    100 ms for cooperative runtime settlement, and then invokes the runtime's
    forced interruption boundary. That boundary atomically closes pending tool
    results, persists the interrupted turn, writes the terminal snapshot, and
    fences all late completion writes before the gateway emits terminal events.
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
- After that durable commit, publish `item.started` and `item.completed` for
  every visible committed steer before the next provider request. Reuse the
  queue record `clientTurnId` as `client_user_message_id` and the durable
  history item id as the lifecycle item id so direct/mirrored event dedup keeps
  one user transcript row and clears the matching optimistic pending preview.
- On normal completion, persist remaining matching pending steers as
  `rejected_steer` before terminal success. Interruption retains pending steers.
- After a completed turn, inspect at most one rejected steer/follow-up. Reuse
  its `clientTurnId` as the reservation idempotency key, reserve first, and call
  `markStarted()` only after reservation succeeds.
- After reservation and `markStarted()` succeed, publish `item.started` and
  `item.completed` for the queued turn before provider IO. Reuse the queue
  record `clientTurnId` as `client_user_message_id`; project a rejected steer
  with `source=steer` and an ordinary follow-up with `source=submit`. This
  lifecycle lets the TUI render the user input once and clear its matching
  optimistic queue entry.
- Queue callbacks carry the captured session generation. Old-generation
  callbacks cannot replace or publish the new active session queue.
- A successful queue-mutation RPC response is also an authoritative TUI
  acknowledgement. Remove the matching optimistic input by
  `client_user_message_id` before applying the response's monotonic queue
  snapshot. The response and `turn.queue.updated` notification may arrive in
  either order; an older revision must not restore a consumed preview. An RPC
  failure keeps the local recovery path intact.
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
  reservation-before-removal, reservation-failure retention, and queued-turn
  user lifecycle identity/source for both rejected steers and follow-ups.
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
    `backend/packages/*` and `tui/*`; the root `package-lock.json` is authoritative.
  - Run `npm ci` from the repository root. Do not restore or depend on a nested
    `tui/mycli-shell/package-lock.json`.
  - Workspace tooling such as `tsx` and `typescript` may resolve from the root
    `node_modules`; diagnostics and process launch code must recognize that
    layout instead of requiring duplicate nested installations.
  - Canonical hand-edited schemas live under `backend/packages/contracts/schemas`.
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
- Good: Restarting a Node-owned waiting-approval session and calling
  `session.bootstrap` produces one actionable `approval.request`, after which
  `approve_once` continues the original turn without another reservation.
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
- Bad: Adding new untyped event fields in Python without updating TypeScript
  payload types and reducer tests.
- Bad: Adding or changing Python `payload_schema.required`, `properties`, or
  enum values without updating the TypeScript protocol contract map and
  cross-language Node test.
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
- Node M5 integration proving restart bootstrap re-emits one persisted strict
  Write approval, `approve_once` executes the mutation exactly once, and the
  original turn completes without starting Python.
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
- Trigger: Changes to Node CLI parsing, `setup`, `doctor`, hooks/plugins/MCP management,
  user provider config writes, auth writes, or the setup TUI entrypoint.
- Utility commands are a control-plane path. They must remain outside interactive backend,
  provider, turn-runtime, and gateway/TUI startup unless `setup` explicitly opens its own TUI.

### 2. Signatures
- Parser:
  `parseCliMode(argv) -> {kind: "interactive", runtimeArgs} | {kind: "management", command}`.
- Executor: `ManagementExecutor.execute(command, signal?) -> Promise<ManagementResponse>`.
- Auth writer:
  `writeApiKey({homeDir, authRef, apiKey}) -> Promise<void>`.
- Config writer:
  `writeUserProviderConfig({homeDir, provider, protocol, model, apiBaseUrl, authRef,
  promptCacheKeyEnabled, cacheControlEnabled}) -> Promise<string>`.
- Setup TUI:
  `runSetupTui({state, terminal?, signal?}) -> Promise<SetupWizardResult | undefined>`.
- Doctor runner:
  `runDoctor(options, signal?) -> Promise<DoctorReport>` and
  `runDoctorCollectors(collectors, signal?, {collectorTimeoutMs?, cleanupTimeoutMs?})`.
- Doctor report:
  `{checks: readonly DoctorCheck[], okCount, warningCount, failedCount}`, where each check is
  `{name, status: "ok" | "warning" | "failed", message, detail?}`.
- Commands:
  `setup`, `doctor [--json]`, `hooks list|inspect|approve|revoke`,
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
- Setup builds provider rows from Node provider profiles and auth presence, including Anthropic.
  TTY setup calls the in-process setup TUI; non-TTY setup and TUI startup failures use the plain
  interaction. A user cancel does not fall through from TUI to plain setup.
- The setup TUI returns its result in memory and releases terminal ownership. The npm CLI does not
  use `MYCLI_SETUP_STATE`, `MYCLI_SETUP_RESULT_PATH`, or a cross-runtime result file.
- Auth/config updates create a mode-`0700` user directory, write and fsync a sibling mode-`0600`
  temporary file under a short exclusive lock, rename atomically, fsync the directory where
  supported, and remove temporary/lock files. Concurrent auth merges serialize.
- User config writing preserves unrelated TOML values/tables, updates `[model]` and cache fields,
  normalizes trailing base-URL slashes, and removes legacy root or `[model]` `api_key` values.
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
- Non-TTY interactive mode -> exit `2` with `tty_required`; provider-free management remains valid.
- TUI setup cancellation or interrupt -> `undefined`, no config/auth write.
- TUI startup failure -> plain setup fallback without the raw import/startup error.
- Invalid setup provider or blank endpoint/model/key -> bounded `setup_invalid_result`, no key output.
- Atomic config/auth failure -> preserve the old target, clean temporary files, and return only
  `config_write_failed`, `auth_write_failed`, or `setup_write_failed` stable diagnostics.
- Existing malformed user TOML -> fail the write and preserve the old file. Malformed auth JSON
  remains Python-compatible and is treated as an empty auth store when replacing credentials.
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
- Config tests cover auth merge/replacement, concurrent writers, mode `0600`, TOML preservation,
  inline-key removal, pre-rename failure preservation, redacted errors, and temp cleanup.
- Setup tests cover all provider rows, stored-auth presence, success persistence, cancellation,
  TUI-to-plain fallback, pre-buffered pipe input, and key absence from output/response.
- TUI tests assert direct submit/cancel Promise results, terminal cleanup, and in-memory setup
  completion without a cross-runtime result file.
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

## Scenario: Node-Only npm Composition Root With Independent Python Reference

### 1. Scope / Trigger
- Trigger: Changes to `backend/apps/mycli`, `startNodeBackend`, gateway transport injection, process
  signals, package exports, npm startup, or the Node/Python runtime boundary.
- The npm CLI owns the terminal and process lifecycle and starts only the Node backend. The Python
  package remains independently launchable through `uv run mycli`; npm must never import, probe,
  spawn, or fall back to it.

### 2. Signatures
- Node CLI: `mycli [--session <id>] [--model <model>]`.
- Composition root: `runCli(options?: RunCliOptions) -> Promise<number>`.
- Backend factory:
  `startNodeBackend({cwd, env, args, maxOutputTokens?}) -> Promise<NodeBackend>`.
- Backend lifecycle: `NodeBackend = {transport, completion, diagnostic(), close(), kill()}`.
- Gateway module startup: `gatewayStartup: Promise<void>`
- Gateway module shutdown: `gatewayShutdown() -> Promise<void>`
- Independent Python entry point: `uv run mycli [python-runtime-options]`.

### 3. Contracts
- Help, version, and provider-free management commands resolve before TTY checks or backend/TUI
  construction. Interactive mode accepts only `--session` and `--model` runtime options.
- `--runtime-backend` is invalid usage. Retired environment values such as
  `MYCLI_RUNTIME_BACKEND`, `MYCLI_PYTHON`, and `MYCLI_SIDECAR_START_TIMEOUT_MS` cannot change npm
  startup, trigger a Python lookup, or create a fallback path.
- Interactive startup validates terminal stdin/stdout, constructs one Node backend, configures its
  transport, and only then imports the TUI gateway. No turn may start before gateway startup and
  `session.bootstrap(protocol_version=1)` complete.
- The Node backend owns provider, storage, tools, integrations, gateway, and child-process cleanup.
  Its `close()` and `kill()` operations are idempotent and must close all Node-owned resources.
- The first SIGINT before TUI ownership requests bounded shutdown and exit `130`; after ownership,
  SIGINT belongs to the TUI. SIGTERM requests gateway shutdown. A parent `exit` synchronously calls
  backend `kill()` when completion has not settled.
- Python source, packaging metadata, tests, evaluation utilities, and Python 3.13 CI remain in the
  repository. They form a separately launched reference runtime, not an npm dependency or hidden
  rollback backend.
- Production package exports and the `mycli` bin point only to compiled ESM and
  declarations under `dist`; production execution never requires `tsx`.

### 4. Validation & Error Matrix
- `--help` / `--version` -> exit `0`, no TTY check and no backend/provider/TUI startup.
- `--runtime-backend`, an unknown option, duplicate/missing runtime value, or malformed management
  command -> exit `2` with bounded `invalid_arguments`; do not start Node or Python.
- Non-TTY interactive launch -> exit `2` with `tty_required`; management commands remain available.
- Node backend construction/configuration failure -> exit `2` with a stable bounded diagnostic.
- TUI import/startup or unexpected Node backend completion -> exit `1`; do not retry through Python
  and do not replay an accepted turn.
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
- Base: `uv run mycli` starts the retained Python reference directly in a separate process chosen
  by the operator between turns.
- Bad: Spawn a separate TUI child that owns terminal input; this breaks Windows
  raw-TTY ownership and splits signal handling.
- Bad: Probe Python at npm startup even when the probe is described as diagnostics or rollback
  preparation.
- Bad: Retry a failed Node operation through Python; model requests and tool
  effects could be duplicated.

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
- The independent Python gate runs package build, ruff, mypy, pytest, and `uv run mycli --help`
  separately; it does not exercise npm fallback behavior.
- Run lifecycle tests on Node 22.19 across macOS, Linux, and Windows.

### 7. Wrong vs Correct

Wrong:
```typescript
const backend = selectRuntimeBackend(process.env.MYCLI_RUNTIME_BACKEND);
if (backend === "python-sidecar") await startPythonSidecar();
await import("mycli-shell-tui/gateway");
```

Correct:
```typescript
const backend = await startNodeBackend({ cwd, env, args });
configureGatewayTransport(backend.transport);
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
  `shell.list.updated`.
- Durable history item: `type="shell_session"` with bounded sanitized metadata and output.
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
- Manager methods require `ownerSessionId`. A session cannot list, read, write, resize, interrupt,
  or stop another session's shell.
- `read-only` and `workspace-write` require the platform sandbox wrapper/helper and fail with
  `sandbox_unavailable` when it cannot be applied. `full-access` maps explicitly to
  `danger-full-access`; there is no implicit unsandboxed fallback.
- Lifecycle payloads and durable `shell_session` metadata may contain only bounded structural
  fields such as shell id, state, transport, TTY/yield flags, sequence, timestamps, counters,
  terminal state, exit code, cleanup result, sanitized command preview, and bounded output.
  Diagnostics exclude raw command, stdin, environment values, provider payloads, and secrets.
- Backend close aborts the active turn, terminates every owned live process tree, closes each
  transport, drains lifecycle persistence, and only then closes SQLite. Historical records remain
  durable, but live OS processes are never reconstructed after restart.
- The M6 live smoke uses `gpt-5.5`, Responses, a disposable home/workspace/session, zero retries,
  `maxOutputTokens=64`, and one 30-second deadline. It persists trust, selects full access,
  approves one PTY launch, completes it through `WriteStdin`, verifies cleanup/persistence and
  `python_started=false`, and prints one structural JSON line only.

### 4. Validation & Error Matrix

- Missing required sandbox wrapper/helper -> `sandbox_unavailable`; spawn count remains zero.
- `tty=true` plus unavailable/broken native PTY -> explicit shell failure; do not retry with pipe
  or Python.
- Unknown shell id -> `shell_not_found`; wrong owner -> `shell_session_forbidden`.
- Input after terminal completion -> `shell_already_completed`.
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
  shells and no Python process.
- Good: an empty `WriteStdin` polls only output newer than the model cursor while lifecycle and
  model cursors remain independent.
- Base: a short `tty=false` command completes through pipe without entering the background list.
- Bad: create a manager inside `NodeTurnRuntime` or a tool adapter; yielded processes disappear
  when the provider step ends or a session binding is recreated.
- Bad: catch native PTY failure and retry through pipe/Python; the command may run with different
  semantics or be duplicated.
- Bad: print an endpoint, API key, prompt, command, stdin, provider text, raw shell output, or local
  path from the live smoke.

### 6. Tests Required

- Tools unit tests cover bounded output/cursor eviction, invalid UTF-8 replacement, environment,
  approval proposals, owner isolation, yield/poll/input/resize, timeout, interrupt, targeted stop,
  capacity eviction, lifecycle ordering, and close cleanup with fake transports.
- Native integration tests cover pipe IO/process trees plus Unix PTY or Windows ConPTY input,
  resize, interrupt, exit, and orphan cleanup on Node 22.19 and Node 24.
- Backend integration uses a fake Responses provider to assert approval before spawn, exactly one
  PTY start/completion, `WriteStdin`, `max_output_tokens=64` on every request, durable shell state,
  shutdown cleanup, and `python_started=false`.
- Smoke tests assert missing credentials exit `77`, fake-provider success uses exactly three
  provider requests, stdout is exactly one JSON line, stderr is empty, and secrets/endpoints/
  commands/stdin/provider output do not appear.
- Python/Node M6 parity asserts output buffers, decoder behavior, model result bounds, permission
  profiles, and a sanitized scenario corpus.
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
- Bad: keep `parentSessionId` only in controller constructor state; children started after resume are
  persisted under the backend's original session.
- Bad: expose `parent_session_id`, child report text, or provider response fields in
  `subagent.updated`.
- Bad: add `[key: string]: unknown` or open `additionalProperties` to a security-bounded event solely
  because a generic reducer expects `Record<string, unknown>`.

### 6. Tests Required

- Composition tests assert deterministic start/reverse-close, idempotent bounded shutdown, partial
  failure cleanup, built-in manifest immutability, collision rejection, and package DAG direction.
- Runtime/tool tests assert `ownerSessionId` and `ownerTurnId` on ordinary execution and approval
  continuation, plus `spawn_agent` forwarding into the supervisor.
- Controller tests use real SQLite task storage to assert dynamic session/turn ownership across
  start, progress, terminal state, output, messaging, interruption, and close.
- Backend integration runs a real parent/child/parent provider sequence, asserts the child sees only
  its frozen tools, checks durable parent ownership, and proves no Python process starts.
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
  runtime loop or permit silent Python fallback after a Node turn is accepted.

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
- M8 removes the npm `python-sidecar` backend and runtime selector while retaining the Python
  implementation as an independently launched reference. Node-owned turns never fall back across
  runtimes; rollback means installing an earlier npm release or explicitly launching `uv run mycli`
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
- Bad: catch a failed Node extension turn and transparently retry it through Python.

### 6. Tests Required

- Gateway tests assert catalog-backed manifest names, combined tool manifest projection, bounded
  resources/commands, command dispatch, stale-session filtering, and closed `subagent.updated` shape.
- Composition tests assert ordered startup/reverse close, partial-failure cleanup, route collision
  failure, package DAG direction, and built-in manifest immutability.
- Hook manager/runtime tests assert built-in/configured/plugin order, chained modifications,
  fail-closed pre-hook behavior, and contained post-hook errors.
- M7 no-Python integration drives Skill -> MCP -> plugin -> foreground Task -> final text, verifies
  durable context/tool/task records, and proves MCP/plugin cleanup plus an absent Python marker.
- Packed smoke resolves M7 assets/dependencies and runs compiled management commands. CI config runs
  the M7 lifecycle gate on macOS/Linux/Windows with Node 22.19 and 24.

### 7. Wrong vs Correct

#### Wrong

```typescript
try {
	return await nodeRuntime.run(turn);
} catch {
	return pythonSidecar.run(turn);
}
```

#### Correct

```typescript
const backend = selectBackendBeforeTurn(config);
return backend.run(turn); // Ownership is fixed for the accepted turn.
```

## Scenario: Cross-Runtime Slash Command Behavioral Parity

### 1. Scope / Trigger

- Trigger: adding or changing a retained slash command, its backing service, gateway RPC, TUI
  action, persistence path, or Python-to-Node migration claim.
- Registry names and dispatch metadata are discovery contracts, not proof of behavioral parity.

### 2. Signatures

- Node registry: `node-slash-command-registry.ts`.
- Node execution: `command.run`, command-specific RPCs, and TUI client actions.
- Python reference: `slash_command_registry.py` plus `slash_command_dispatch.py` and the service
  called by the command.
- Model catalog: `~/.mycli/models.json` -> `model.list` -> TUI model selector -> `model.select` ->
  `~/.mycli/config.toml`.

### 3. Contracts

- A retained command is behaviorally compatible only when its data source, argument semantics,
  validation, side effects, persistence, restart behavior, error behavior, and user-visible result
  agree across the retained Python and Node runtimes.
- Metadata hashes may freeze command names, aliases, surfaces, and presentation, but must not be
  described as full parity evidence without behavioral tests.
- Node `/model` reads the Python-compatible user-owned `~/.mycli/models.json`. It bootstraps the
  same built-in catalog only when the file is missing and never replaces an existing registry.
- `model.list` returns every valid catalog entry with the exact current entry first. Public payloads
  include selection metadata but exclude `auth_ref`, API keys, and other credentials.
- `session.bootstrap.models` is a top-level catalog payload, not a field inside `status`. The TUI
  adapter stores it as catalog state before projecting the model selector. Later `status.changed`
  events that omit a catalog must preserve the last catalog instead of collapsing to the current
  model fallback.
- Opening the bare TUI `/model` refreshes `model.list` immediately before mounting the selector,
  and a successful `model.select` response refreshes the stored catalog so current markers and
  runtime edits to `models.json` are visible without restarting.
- `model.select` resolves `auth_ref` on the backend from the selected catalog entry, verifies the
  credential exists, validates provider/protocol/base URL and supported reasoning effort, and only
  then atomically persists model settings.
- Bare TUI `/model`, direct `model.list`/`model.select`, and inline `/model <name>` share the same
  catalog and selection path. Inline selection must not mutate only transient Gateway fields.
- A failed selection leaves the active provider/model and durable config unchanged. A successful
  selection is visible in `/status`, subsequent turns and subagents, and after restart.
- Explicitly retired commands remain absent. Behavioral parity must not reintroduce retired
  surfaces such as agent-profile management.

### 4. Validation & Error Matrix

- Missing `models.json` -> atomically create the compatible built-in registry with private
  directory/file permissions.
- Invalid JSON, missing `models`, duplicate identity, unsupported provider/protocol, invalid URL,
  repeated reasoning effort, or unlisted default effort -> bounded `model_catalog_error`.
- Model absent from the catalog, endpoint mismatch, unsupported effort, or missing catalog
  credential -> reject before config mutation and provider startup.
- Model without a reasoning effort -> persist thinking disabled and remove stale active thinking
  effort while retaining a valid base reasoning setting for future models.
- Public model payload or error -> no API key, bearer token, raw auth-store content, or private
  absolute path.

### 5. Good/Base/Bad Cases

- Good: one shared fixture produces identical Python and Node public model-catalog payloads, then a
  catalog selection survives restart and is used by the next Node turn.
- Base: an existing catalog with no exact current entry is returned intact with no row marked
  current.
- Bad: synthesize one default model per provider and call it catalog parity.
- Bad: accept arbitrary `model.select` input or trust `auth_ref` supplied by the TUI.
- Bad: freeze only the slash registry checksum while command services use different data sources.

### 6. Tests Required

- Config unit tests cover compatible loading, bootstrap, private permissions, exact current
  matching, duplicate and reasoning validation, and credential-free payloads.
- A Python/Node parity test feeds the same `models.json` to both implementations and compares all
  public fields and ordering.
- Gateway tests cover bare/inline ownership, catalog-backed inline selection, structured failures,
  current `/status` projection, and the next turn's model/reasoning overrides.
- TUI adapter tests pass a catalog through the top-level bootstrap envelope, project every entry,
  preserve it across a catalog-free `status.changed`, and replace it from a later `model.list`.
- Backend integration tests use a temporary HOME with a real catalog and auth store, verify
  catalog-owned `auth_ref`, persistence, restart recovery, and absence of credentials in responses.
- Every other retained slash command changed in the future requires an equivalent behavioral test;
  updating only the registry hash is insufficient.

### 7. Wrong vs Correct

#### Wrong

```typescript
const models = listProviderProfiles().map(defaultModelForProvider);
gateway.model = requestedModel;
```

#### Correct

```typescript
const catalog = await loadModelCatalog({ homeDir, currentConfig });
const selected = validateCatalogSelection(catalog, request);
await persistModelSelection(selected);
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
  turn. The parent supervisor independently waits 250 ms; if the Worker event
  loop is still unresponsive, it calls `Worker.terminate()` and starts a fresh
  Worker for the same active session.
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
| Turn settles within the cooperative/force boundary | Keep the Worker; forward its terminal events and RPC response |
| Worker event loop remains blocked past the watchdog | Terminate it, recover the exact turn, restart, then resolve the RPC |
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
- Base: an abort-aware provider or tool settles normally within 100 ms and no
  Worker restart occurs.
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
- Source-mode and compiled-package smokes must both locate their corresponding
  `.ts` or `.js` Worker entry and receive `runtime.ready` without Python.

### 7. Wrong vs Correct

#### Wrong

```typescript
controller.abort();
setTimeout(() => emit("turn.interrupted"), 100);
```

#### Correct

```typescript
controller.abort();
const settled = await settlesWithin(turnTask, 100);
if (!settled && workerIsUnresponsive) {
  await worker.terminate();
  await restartWithRecovery({ sessionId, turnId, userInitiated: true });
}
// Resolve only after the fresh Gateway publishes the durable terminal record.
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
  `TranscriptViewportComponent.render(width) -> string[]`.
- Full transcript projection:
  `createTranscriptProjection(blocks) -> TranscriptProjectionState`.
- Incremental tail projection:
  `projectTranscriptTail(blocks, previous) ->
  {projection, stablePrefixLength, replacedBlocks}`.
- Runtime update classifier:
  `classifyRuntimeTranscriptUpdate(previous, next) -> "unchanged" | "tail" | "replace"`.
- Gateway runtime projector:
  `RuntimeStateProjector.project(state, sessions, transcriptUpdate) -> MycliShellState`.
- Stateless runtime projection oracle:
  `projectRuntimeState(state, sessions) -> MycliShellState`.

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
- Shell chrome containers may reuse rendered lines between viewport-height measurement and their
  later layout pass only when `activeRenderFrameId` and width both match. The cache is unavailable
  outside the root render call and must not survive into the next frame.
- Assistant streaming reuses existing Markdown components and marks only the owning container
  dirty. Recursive invalidation is reserved for theme or layout invalidation because it discards
  the Markdown token cache.
- Active assistant blocks update their retained component directly. They must not serialize the
  complete block to build a change signature on each text or reasoning delta; that allocation grows
  linearly with the accumulated response before Markdown rendering even begins.
- Runtime transcript classification owns the `tail` guarantee. It emits `tail` only for an append,
  a final-item replacement, or a reasoning update whose assistant is at the tail. Workspace,
  turn-running, and tool-detail changes force `replace`.
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
- `projectRuntimeState` remains the full stateless behavior oracle for tests, resume, and fallback.
  Incremental output must be deeply equal to this function for the same runtime state.
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
- Width changes and explicit invalidation clear token layout caches. An unbounded viewport keeps
  the full-render behavior.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| `maxRows <= 0` | Return `lines=[]` while preserving the exact `totalLines` count |
| Component has no `renderTail` | Render normally and slice the returned lines |
| Width or render revision changes | Reject the cached tail and render for the new identity |
| Chrome is measured and then painted in one root frame | Render its children once and reuse the exact measured lines |
| Next root frame or direct container render | Render again; never reuse the prior frame's chrome lines |
| Assistant text appends inside the final Markdown token | Re-render the changed token and reuse stable prefix tokens |
| Append-only source has no reference-link syntax | Retain stable lexer tokens and reparse from the final non-space top-level token |
| Appended reference definition resolves an earlier token | Reject that token's cached context and match a fresh render |
| Incremental token raw lengths do not cover the source | Reject retained lexer state and run a full lex |
| Tail omits the assistant's leading blank row | Do not synthesize its OSC 133 start marker in the truncated tail |
| Tail includes the first assistant content row but not the leading blank | Preserve the assistant role bullet on that content row |
| Tail source shrinks or its retained boundary `id`/`kind` changes | Reject incremental state and run a full projection |
| Tail appends after a stable non-context block | Read/project only appended source blocks and retain the complete projected prefix |
| Tail touches a context run | Replay from that run's recorded source start and preserve grouping semantics |
| Full replacement or session transition | Discard retained projection metadata and rebuild from source |
| Runtime status changes with the same transcript array | Reuse all four runtime projection arrays by identity |
| Runtime appends or replaces the final immutable item | Reparse a bounded source suffix, snapshot affected arrays, and reuse unaffected arrays |
| Active tail assistant receives live reasoning | Reproject from that assistant while retaining earlier shell blocks |
| Runtime source reference or projection context disagrees with the hint | Ignore retained state and match `projectRuntimeState` |

### 5. Good/Base/Bad Cases

- Good: a 100k-character streamed response renders only the bounded viewport tail while reporting
  the same total line count and visible bytes as a full render.
- Good: appending to a response after hundreds of stable Markdown blocks retains their lexer and
  rendered-token identities and parses only the active suffix.
- Base: a small component without `renderTail` follows the existing full-render path.
- Good: a width change recomputes wrapping and remains equal to a newly constructed Markdown
  component.
- Good: appending one message to a 10,000-block transcript reads only the boundary and appended
  source blocks, retains the projected array, and keeps all stable components mounted.
- Good: replacing a subagent boundary with a second `Read` replays the preceding context run and
  creates the same group as a fresh full projection.
- Good: a status-only gateway event reuses the complete shell transcript arrays without touching
  any runtime transcript item.
- Good: a 10,000-item final message update reads only a bounded runtime suffix, returns a new shell
  transcript array, and preserves the stable block objects inside it.
- Bad: cache by token `raw` alone; later reference definitions can change an earlier token AST.
- Bad: concatenate retained lexer tokens with an appended suffix without replaying the final
  non-space block; lists, blockquotes, fences, and tables can continue across the append boundary.
- Bad: call recursive `invalidate()` for every assistant delta and erase all stable Markdown
  token chunks.
- Bad: cache one tail without including the remaining-row budget in its identity.
- Bad: retain measured editor/status/footer lines across root frames; cursor, timer, and input state
  can change without a parent container rebuild.
- Bad: call `JSON.stringify` on the accumulated assistant block for every streaming delta.
- Bad: validate incremental shell projection with wrapper reference equality; gateway projection
  recreates those wrappers even when the runtime transcript prefix is unchanged.
- Bad: build a new projected prefix array on each stream delta; source scanning may be gone while
  linear allocation remains.
- Bad: mutate retained `MycliShellState.transcript`, `messages`, `tools`, or `bash` arrays in place;
  the caller loses the previous snapshot needed for reconciliation.
- Bad: cache footer, approval, queue, permission, or session state inside the transcript projector;
  only the expensive runtime-to-shell transcript mapping is retained.

### 6. Tests Required

- Markdown tests compare incremental updates with fresh renders for paragraphs, lists, code,
  blockquotes, tables, reference definitions, and width changes.
- Markdown lexer tests assert a long append-only stable prefix retains source-token identity, while
  appended reference definitions rebuild reference-sensitive source tokens.
- Markdown and assistant tests assert `renderTail(...).lines` equals a full-render tail for zero,
  narrow, exact, and oversized row bounds; assert `totalLines` equals full length.
- Assistant tests include visible and hidden thinking, role prefixes, spacing, and OSC 133 markers.
- Viewport tests use a 10,000-line component with separate full/tail counters and assert the
  bounded path never calls full render.
- Shell layout tests count editor child renders and assert one render inside a root frame, another
  render in the next frame, and no cache reuse for direct container calls.
- Assistant streaming tests assert the retained component updates without consulting the generic
  serialized block-signature path.
- Projection tests count indexed source reads across 10,000 blocks and assert a final assistant
  update stays bounded, equals a fresh projection, and retains the same projected array.
- Projection boundary tests cover ordinary append, second context-tool grouping, mutating and file
  changes, subagent boundaries, expanded context tools, and invalid-boundary full fallback.
- Shell runtime tests reconstruct stable shell block wrappers as the gateway does, then assert the
  existing prefix components retain object identity after a hinted append.
- Runtime projector tests compare every incremental result with stateless `projectRuntimeState`,
  count indexed reads for a 10,000-item final update, and assert ordinary append updates the tool
  array while retaining stable message blocks.
- Runtime projector tests assert unchanged events reuse all transcript-derived arrays and live
  reasoning replaces only the active tail assistant block.
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

### 5. Good/Base/Bad Cases

- Good: duplicate status projection schedules a frame but produces no PTY bytes.
- Base: one streamed token changes a suffix and uses the existing ANSI-safe cell patch.
- Bad: write `CSI ?2026h`, cursor-hide, and `CSI ?2026l` for every unchanged state event.
- Bad: suppress a cursor-only move because the line bytes are equal; IME placement becomes stale.

### 6. Tests Required

- Renderer tests clear captured writes after an initial frame, request an identical inline frame,
  and assert the write count remains zero.
- Repeat the same assertion after native scrollback has anchored a committed history row.
- Render an identical line with a moved `CURSOR_MARKER` and assert one synchronized absolute-column
  update plus unchanged visible cells.
- Existing atomic-frame, output-backpressure, wide-cell, resize, suspend/resume, and terminal
  cleanup tests remain green.

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

## Scenario: Unix TUI Job-Control Suspend And Resume

### 1. Scope / Trigger

- Trigger: changing terminal ownership, raw input, `Ctrl+Z`, process signals, alternate-screen
  behavior, frame scheduling, or resume-time resize handling.
- This contract applies to the interactive Node TUI on Unix. Windows has no `SIGTSTP` job control
  and retains its existing input behavior.

### 2. Signatures

- TUI hook: `TUI.onSuspend?: () -> boolean`, which requests process-group suspension.
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
  alternate screen, hides the cursor, reconnects output backpressure, and forces a full frame.
- If columns or rows changed while suspended, the existing resize callback runs before that forced
  frame so native scrollback reflow remains debounced and source-backed.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Unix `Ctrl+Z` with suspend hook | Release terminal, suspend process group, reacquire, force redraw |
| Kitty `Ctrl+Z` key release | Ignore; do not suspend a second time |
| Windows or missing hook | Preserve the existing focused-component input path |
| Same dimensions after resume | Force redraw without source scrollback reflow |
| Dimensions changed while stopped | Run resize hook, then force the resumed frame |
| Alternate-screen mode | Leave before suspend and re-enter before repaint |
| Suspend hook throws | Reacquire terminal ownership, consume the reserved key, and remain usable |

### 5. Good/Base/Bad Cases

- Good: suspend from an alternate-screen session, observe normal shell terminal state, run `fg`,
  and receive one complete fresh TUI frame.
- Base: resume at the same dimensions and reuse the durable runtime/session state.
- Bad: send `SIGTSTP` while raw mode and bracketed paste remain enabled.
- Bad: resume with the old diff baseline; a newly re-entered alternate screen may remain blank.
- Bad: signal only the TUI process while the provider/runtime process continues in the background.

### 6. Tests Required

- TTY integration tests assert raw mode is false and alternate screen has been left inside the
  suspend callback, then assert modes are restored and the changed frame is rendered afterward.
- Tests assert a dimension change invokes the resize callback exactly once.
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
// TUI releases terminal ownership before this callback and forces a redraw after it returns.
```
