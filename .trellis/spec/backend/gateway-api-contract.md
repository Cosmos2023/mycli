# Shared Gateway API Contract

## 1. Scope / Trigger

Changes to app-server, RPC shapes, gateway clients, transcript wire records,
or backend/TUI dependency direction must follow this contract.

## 2. Signatures

- CLI: `mycli app-server [--session id] [--model model] [--profile name]`.
- Public Node API: `@cosmos2023/mycli/backend.startBackend(options)`.
- Embedded service: `startBackendService(options, { maxClients? }) -> BackendService`.
- Attachment: `service.attach({ role?, limits? }) -> { id, role, transport, completion, close }`.
- Service lifecycle: `snapshot()`, idempotent `close()`, and `completion: Promise<number>`.
- Public client: `@cosmos2023/mycli/gateway.GatewayClient`.
- Workspace client: `@mycli/gateway`, depending only on contracts and Node APIs.
- Typed RPC: `request<M>(method: M, params: GatewayParams<M>): Promise<GatewayResult<M>>`.
- Validators: `parseGatewayParams(method, unknown)` and `parseGatewayResult(method, unknown)`.
- Tool record: `parseGatewayToolRecord(unknown): GatewayToolRecord` and
  `projectGatewayToolRecord({ text, metadata? }): GatewayToolRecord`.
- Lifecycle adapter: `gatewayToolLifecycleRecord(method, params): GatewayToolRecord`,
  with method restricted to `tool.start`, `tool.complete`, or `tool.failed`.

## 3. Contracts

- The canonical method schema lives in contracts/schemas/gateway-rpc.schema.json.
  Generated declarations and validators must share that source. The advertised
  catalog plus initialize/status.get/session.resume.preview covers every method.
- Validate parameters before controller dispatch and results before client use.
  Semantic validation and durable side effects remain with the existing owners.
- TUI and headless workflows share request correlation, notification decoding,
  event waiting, cancellation, and cleanup. Headless wraps only workflow errors.
- Runtime backend modules cannot import TUI modules. The CLI composition root may
  select the TUI. Shared transport code must not contain TUI configuration state.
- Server stdout contains JSON-RPC only. Startup failures are value-free stderr
  diagnostics. EOF/signals close the backend; startup cancellation reaches Workers.
- Typed transcript records preserve version 1 metadata. Add presentation variants
  deliberately; do not narrow legacy metadata silently.
- `gateway-tool-record.schema.json` is the shared closed schema for optional
  `tool_record` on tool lifecycle notifications, their runtime mirrors, and tool
  transcript items. Generate types and register external schema references in
  both RPC and event validators. Reject malformed records before client delivery.
- Records require version 1, kind `tool_execution`, name, canonical status
  (`running|success|error|cancelled`), and mutating. Previews are at most 8192
  characters; counts are nonnegative safe integers and durations are finite and
  nonnegative. Shell process facts use the closed nested shell record. No raw
  argument/payload objects or private rationale enter the record.
- Event record name and call_id must agree with outer tool identity when supplied.
  Normalize only selected legacy fields; absent optionals are omitted so in-memory
  records and JSON round trips merge identically. The backend projects from
  allowlisted runtime metadata or readable storage views, without persistence changes.
- The TUI prefers typed records over conflicting legacy metadata. Canonical call
  identity takes precedence over legacy tool_id matching; shell identity and
  restored sequence participate in lifecycle reconciliation. Tool returns cannot
  overwrite newer shell lifecycle output or terminal status. Legacy summary/detail
  coalescing and polling must retain canonical identity and process facts.
- `transcript.load` defaults to at most 500 items and a 6 MiB encoded result budget,
  leaving room under the 8 MiB frame limit. If necessary, reload with the same
  cursor and a halved limit; never slice a storage page while retaining its original
  continuation. Clients follow next_before even when a page is short. A single
  oversized item produces a bounded gateway_message_too_large RPC error.
- Committed provider attempts cross the gateway as `provider.attempt.updated` and its identical
  runtime mirror. Validate canonical record semantics, safe failure normalization, and matching
  outer session/turn ownership. Preserve legacy retry notifications, but reset partial output once.
- Initial transcript pages include at most 200 recent provider attempts. The read-only
  `provider.attempts.load` RPC caps pages at 500 records and 1 MiB; session/turn reads select the
  newest records in chronological order, while per-request reads use ascending sequence and
  `after_sequence`. Session/turn history uses a scoped `before_event_id` cursor, mutually exclusive
  with request sequence pagination. Return continuation when truncated and keep earlier retries
  reachable after message history ends. Loading history must never dispatch or alter retry budgets.
- TUI live and restored attempt records share a stable per-request projection. Deduplicate sequence
  and event identity, fence session/turn ownership, retain bounded expandable diagnostics, and
  calculate countdowns from committed `retryAt` using the existing activity timer. Recovery state
  never terminalizes a turn or adds a second final error notice. Restored pending records are paused
  unless the gateway also establishes their owning active turn.
- When required fields are expressed inside anyOf/allOf, include their property
  schemas in that branch. A bare required list can validate at runtime while the
  declaration generator loses the constraint; cover these cases with type errors.
- Submit images are paths (`string[]`). The TUI converts its attachment objects
  at submission; steer/follow-up retain their existing object-or-path compatibility.
- Client stop is idempotent and removes listeners/timers. The caller owns backend
  closure. A server request with a matching id is never a client-request response.
- `BackendService` owns one supervised backend and one active session, reusing the
  existing session/runtime registries. Each stream attachment has a separate
  `NodeGatewayRpcTransport`; one upstream `GatewayClient` owns correlation,
  validation, and the aggregate request budget. Never transfer response ids.
- Host-assigned roles are immutable: one controller and multiple observers.
  The default role is observer. Use an explicit read-only method allowlist and
  deny unknown methods for observers. JSON parameters cannot grant control.
  Roles restrict operations, not access to individual sessions' readable data.
- Client detach, EOF, frame overflow, and output failure close only that attachment.
  Accepted operations continue without replay, even with no remaining clients.
  Keep a detached controller reserved until its accepted mutations settle; release
  ownership only if its record is still current. The host closes the service.
- An accepted controller shutdown immediately closes admission, enqueues its reply
  before cleanup, and remains effective after disconnect. Observer shutdown is
  denied. Global close drains bounded output, closes the backend once, and awaits
  all attachment cleanup. Preserve nonzero exit codes and surface cleanup failure.
- Late attachment replays only runtime.ready. Bootstrap supplies current state
  and explicitly re-emits the interactive queue's visible request without queuing
  another copy. Ordinary event deduplication remains intact. Rehydrate durable
  pending state only when the live interaction queue is empty. Never replay old
  approvals, clarifications, or tool events from a service cache.
- Default service capacity is 16 attachments, configurable from 1 to 64. Each
  attachment has independent framing/admission/output limits; upstream capacity
  stays shared. A slow observer cannot hold the entire service output open.
- `@mycli/gateway/flow-control` owns frame assembly, request admission, and ordered
  stream writing. Enforce the 8 MiB frame limit on bytes before decoding a whole
  line, and preserve UTF-8 across fragmented input.
- Bound ordinary pending requests to 64 / 16 MiB, with 8 / 256 KiB reserved for
  interrupt, interactive replies, shell stop, and shutdown. Count in-flight writes
  in the 256-write / 16 MiB output budget. Stop writing on false; resume on drain.
- Worker input acknowledgements release delivery credit, not RPC reservations.
  Worker output has one unacknowledged write, which may contain multiple NDJSON frames. Fence credits and output by Worker
  identity, generation, and sequence. Shutdown messages bypass input credit.
- During replacement, reject new requests with gateway_overloaded and
  dispatched=false; allow shutdown. Never replay buffered mutations. Bound the
  wait for recovered terminal publication to the 15-second output stall interval.
- `GatewayWriteQueue.enqueue(frame, {coalesce: {key, merge}})` may replace an unsent
  frame, move the replacement to the queue tail, and recalculate its byte charge.
  Never replace an in-flight write or a frame with a delivery acknowledgement.
  Both original and merged frames retain size limits; replacement cannot reset
  the write-progress timeout. Failed admission leaves the queued prefix intact.
- `enqueue(frame, {batch: true})` concatenates adjacent unsent frames up to 64 KiB
  (capped by maxFrameBytes + 1) and schedules a flush for the next event-loop turn.
  Large individual frames stay standalone. Batching preserves every byte and frame
  order; it does not coalesce event payloads. Count batches as writes and charge all
  their bytes until completion. Do not batch delivery-acknowledged or coalesced
  writes. A nonbatched write flushes the prefix, and end flushes any scheduled batch.
  Disposal cancels the pending flush. Appending cannot renew the stall deadline.
- RPC notifications opt into lossless batching, except Shell output that uses its
  existing coalescing path. Validate/frame-decode every NDJSON message individually
  downstream; never assume one stream chunk or Worker delivery is one JSON object.
- The RPC transport opts in only `shell.output` and its `runtime.event` mirror,
  independently keyed by delivery surface, session, generation, turn, Shell, and
  call. Merge contiguous cursor ranges, remove overlaps, retain a bounded suffix
  of at most 10,000 UTF-16 code units, and account for discarded text and gaps in
  `omitted_output_chars`. A cursor gap keeps only the newer suffix. Never split a
  surrogate pair at the suffix boundary. Moving merged events to the queue tail
  preserves increasing runtime envelope sequences and final lifecycle ordering.
- Durable Shell chunks remain append-only and unaffected by delivery coalescing.
  Reliable events, including assistant text, requests/replies, approvals and terminal
  events, are never coalesced or silently dropped. Remaining output overflow or
  15 seconds without write progress fails the connection. Graceful close drains the accepted output
  prefix, has a bounded failure path, and waits for owned Worker termination.
  The stdio adapter must also await readable EOF and a destination write callback
  before unpiping on normal exit; bound that drain and preserve caller stream ownership.
- Client RPCs time out after 120 seconds by default, close the connection, and
  report unknown execution outcome. Do not automatically retry. Replay has both
  a 256-event and 8 MiB bound; event waiters have a 256-entry bound. Deliver live
  callbacks/waiters before replay caching and remove all timers on close.
- Preserve the first transport failure's stable code through gateway, Worker
  completion, supervisor, and the optional in-process transport `diagnostic()`.
  TUI disconnect handling logs the original client error with session identity and
  the backend code after cleanup, even if cleanup fails. Use private redacted
  diagnostics; do not copy raw frames or transcript state into the record.

## 4. Validation & Error Matrix

| Input / State | Result |
| --- | --- |
| Known method with malformed params | invalid_params before dispatch |
| Known method with malformed result | internal_error, no successful response |
| Unknown controller method | Existing method_not_found behavior |
| Observer mutation or unknown method | read_only_client with dispatched=false |
| Another controller is attached / its mutations are draining | controller_attached / controller_draining |
| Client capacity exhausted / service closing | client_limit_exceeded / service_closed |
| Attachment EOF or transport failure | Detach only that client; accepted work is not canceled or replayed |
| Reconnect while a decision is pending | Bootstrap re-emits the current visible decision with its original identity |
| Malformed notification or response at client | Reject pending work before consumption |
| Client abort | Reject pending requests and event waiters; remove owned listeners |
| stdio EOF | Close backend, normal exit |
| SIGINT / SIGTERM | Close backend, exit 130 / 143 |
| Startup / pipe failure | Close owned resources, bounded diagnostic, exit 1 |
| Ordinary request or Worker delivery budget exhausted | gateway_overloaded with dispatched=false; no dispatch |
| Input frame exceeds size bound before newline | Fail connection immediately; no subsequent frame dispatch |
| Attachment output queue exhausted or stops draining | Fail that connection; no silent event loss |
| Upstream or stdio-host transport failure | Close the owned backend and service |
| Duplicate pending request id | Fail connection; never replace the original reservation |
| Client RPC timeout | gateway_request_timeout, reject pending work, unknown mutation outcome |
| Recovery never publishes terminal event | Bounded restart failure, no successful interrupt acknowledgement |
| Replay cache or waiter budget exhausted | Evict cached oldest events / reject new waiter; live delivery continues |
| Unknown tool record field, invalid status/count, or conflicting event identity | Reject at contract boundary |
| Tool record absent on an older payload | Shared legacy normalization, existing presentation preserved |
| Typed shell restored before stale or duplicate lifecycle delivery | Ignore sequence at or below the restored record |
| Tool invocation returns after a shell lifecycle update | Preserve newer process status/output and merge invocation timing |
| Transcript page exceeds 6 MiB | Reload smaller page with original cursor; no skipped items |
| One transcript item exceeds 6 MiB | gateway_message_too_large RPC error; connection remains usable |

## 5. Good / Base / Bad Cases

- Good: TUI and exec observe the same validated bootstrap and terminal events.
- Base: a stdio client reads a session and shuts down without provider traffic.
- Good: live and restored tools render equal targets, statuses, and output from
  the same typed record while retaining local folding and path choices.
- Bad: accepting a malformed result as a successful empty object, keeping stream
  listeners after stop, or moving session lifecycle state into the RPC client.

## 6. Tests Required

- Compile all method schemas and check complete catalog/compatibility coverage.
- Assert malformed mutations never invoke dispatch, and invalid responses never
  reach consumers or include private values in diagnostics.
- Assert request correlation, typed input, cancellation, and listener cleanup.
- Exercise real supervised stdio bootstrap/shutdown and signal-during-startup.
- Exercise two independent clients with equal RPC ids, shared current session,
  observer mutation denial, controller draining and handoff, late response
  isolation, slow/malformed client isolation, and no-client backend survival.
- Drive a real pending approval and running command across controller replacements;
  assert one provider continuation, one execution, and one persisted tool result.
  Cover accepted shutdown with immediate disconnect and exactly-once cleanup.
- Assert live/mirrored/history tool records validate and produce equal TUI semantics;
  private metadata remains absent from records. Cover legacy Write/Skill/shell
  normalization, sparse completion, restored shell sequencing, and polling merges.
- Page through long typed tool history with both opaque and legacy cursors; assert
  bounded frames and complete ordered coverage. Oversized single items must not
  kill the connection or emit an invalid gateway.error notification.
- Run exec/review regression, full tests, lint/typecheck, contract/config drift,
  and packed application smoke including the public backend/gateway exports.

## 7. Wrong vs Correct

```typescript
// Wrong: the TUI request sends presentation objects to a path-only method.
await client.send("turn.submit", { message, client_turn_id, local_images: attachments });

// Correct: a generated contract checks the model-facing request.
await client.request("turn.submit", {
  message, client_turn_id, local_images: attachments.map((item) => item.path),
});

// Wrong: old metadata overrides a canonical call identity after resume.
const callId = item.metadata.call_id ?? item.tool_record?.call_id;

// Correct: use legacy identity only when the typed record is absent.
const callId = item.tool_record ? item.tool_record.call_id : item.metadata.call_id;
```
