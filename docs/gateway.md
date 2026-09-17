# Gateway API

`mycli app-server` serves the existing supervised agent runtime over stdin/stdout.
Each line is one JSON-RPC 2.0 message. It accepts `--session`, `--model`, and
`--profile`/`-p`; it does not require a TTY. Use `mycli exec` for one-shot tasks.

The backend owns one active session at a time. `session.new` and `session.resume`
use the same durable session coordinator as the TUI. Stdio serves one external
connection. Embedded hosts can attach multiple clients to one backend service;
there is no TCP listener, remote authentication, or cross-process discovery.

## Connect

The installed application exposes `@cosmos2023/mycli/gateway`. Its Node client
also works with `startBackend` from `@cosmos2023/mycli/backend` for an embedded
supervised backend. Internal workspaces use `@mycli/gateway` directly.

```typescript
import { spawn } from "node:child_process";
import { GatewayClient } from "@cosmos2023/mycli/gateway";

const child = spawn("mycli", ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
const client = new GatewayClient({ input: child.stdout, output: child.stdin });
client.start();
try {
  await client.waitForEvent("runtime.ready");
  const session = await client.request("session.bootstrap", { protocol_version: 1 });
  const transcript = await client.request("transcript.load", {
    session_id: session.session_id,
    limit: 100,
  });
  // Consume transcript.items in the host application.
  client.expectClose();
  await client.request("shutdown", {});
} finally {
  client.stop();
  child.stdin.end();
}
```

Register the client's `log(event)` callback before `start()` to receive validated
notifications, including approvals and streaming turn events. `waitForEvent`
has a bounded replay buffer and a timeout. `signal` cancels pending client work.
Stopping a client releases its listeners and event timers; the transport owner
remains responsible for closing the process or embedded backend.

`request(method, params)` uses generated parameter and result types and validates
both sides. The existing `send(method, params)` API remains for protocol probes
and compatibility callers: it accepts string method names and validates known
method responses. Unknown controller requests receive the server's
`method_not_found` error; observers can only use an explicit read-only allowlist.

## Embedded Service

`startBackendService` owns one supervised backend independently of its clients.
The host assigns one `controller` and any remaining clients as `observer`.
The default role is observer; roles cannot be changed by RPC parameters.

```typescript
import { startBackendService } from "@cosmos2023/mycli/backend";
import { GatewayClient } from "@cosmos2023/mycli/gateway";

const service = await startBackendService({
  cwd: process.cwd(), env: process.env, args: [],
}, { maxClients: 16 });
const control = service.attach({ role: "controller" });
const observe = service.attach();
const controller = new GatewayClient(control.transport);
const observer = new GatewayClient(observe.transport);
controller.start();
observer.start();
try {
  await Promise.all([controller, observer].map((client) =>
    client.waitForEvent("runtime.ready")));
  const session = await observer.request("session.bootstrap", { protocol_version: 1 });
  await control.close();
  controller.stop();
  // The observer and backend remain usable after the controller detaches.
  const history = await observer.request("transcript.load", { session_id: session.session_id });
} finally {
  await service.close();
  controller.stop();
  observer.stop();
}
```

Observers can bootstrap, inspect status/settings/manifests, list sessions and
resources, and read transcripts, shell output, and traces. They receive shared
events but cannot submit turns, answer decisions, run commands, change settings,
switch sessions, stop processes, or shut down the service. Denied requests return
`read_only_client` with `data.dispatched=false`. These roles constrain control
operations within a trusted local host; they are not remote authentication or
per-session data access policies.

Each attachment has its own RPC ids, output queue, and `completion` promise.
`attachment.close()`, transport EOF, invalid frame size, or output failure removes
that connection. Accepted work continues even when every client detaches. The
host must call `service.close()` when it no longer needs the backend.
`GatewayClient.stop()` only stops the local reader; close the attachment to detach.

A second controller gets `controller_attached`. After the controller disconnects,
its accepted mutating RPCs must settle before another controller can attach;
until then, attachment fails with `controller_draining`. Running turns and
processes retain their existing runtime owners. A replacement controller can
observe, approve, or interrupt that work after its original RPC has settled.
Requests and their response ids are never transferred or replayed.

New clients receive `runtime.ready` for readiness, then call `session.bootstrap`
for the current session and pending interaction. The ready event can describe the
startup session; it is not a current-session snapshot. Bootstrap explicitly
re-emits the current visible approval or clarification, including child requests,
without adding another queue entry. Other clients may see the same pending id
again. Resolved decisions and historical tool events are not replayed by the
service; `transcript.load` supplies history.

This live attachment differs from starting a new backend or activating a session from storage.
Cold activation holds the session lease, atomically interrupts unfinished turns, and removes old
approval and clarification continuations before publishing the session. Completed tool results
remain in history; unknown effects are not retried. The new runtime cannot restore old process
handles. Historical reads and previews do not perform this recovery.

`service.snapshot()` reports connection roles, service state, and any draining
controller. Host `close()` is idempotent. An accepted controller `shutdown`
immediately stops new admission, responds before cleanup, and closes the backend
and all attachments, even if that controller disconnects before reading its reply.
`service.completion` resolves after cleanup with the backend exit code; transport
or cleanup failure turns an otherwise successful code into 1.

## Plugin Management

`plugin.catalog` reads installed/available package metadata and registered marketplaces for an
explicit `session_id` and `generation`. An optional `marketplace` narrows the list. It starts no
plugin worker, MCP server, hook or model. `plugin.inspect` accepts a selected `target` and `revision`
and loads its declared capability names on demand. Revisions bind selection to package source,
configuration and marketplace snapshots. Catalog limits are explicit in `truncated` and issues.

`plugin.operation.start` accepts the same session ownership, a unique `operation_id`, and a closed
`change` variant: `install`, `enable`, `disable`, `update`, `remove`, `marketplace_upgrade`,
`marketplace_remove` (target/revision), or `install_source`/`marketplace_add` (source). It returns
promptly. Poll `plugin.operation.get` until `state` is `completed`, `failed` or `cancelled`, or request
`plugin.operation.cancel`. Cancellation is best effort before atomic commit; committed success wins.
Never retry a mutation automatically when its transport outcome is unknown. Refresh the catalog.

One package mutation runs per backend; overlap is rejected before dispatch. The backend retains
32 operation outcomes, deduplicates matching IDs within that window, and gives total staging five
minutes before cancellation. Existing Git subprocess limits still apply. Session transitions and
backend shutdown cancel pending work; shutdown awaits cleanup. UI closure explicitly requests
cancellation. An attachment disconnect follows normal service ownership: accepted work continues
until cancellation or backend shutdown. Poll/cancel requests retain their original session/generation.
Observers can read catalogs, inspect details and query outcomes; only the controller starts/cancels
operations. Cancellation uses reserved control admission so a full ordinary queue cannot block it.

Installation copies validated package data into immutable snapshots. Enabling/installing authorizes
declared capabilities under the existing sandbox and approval rules. Runtime activation occurs at
the next safe refresh; pending turns keep their captured configuration.

## Contract Ownership

`backend/packages/contracts/schemas/gateway-rpc.schema.json` is the canonical
source for implemented methods, including existing compatibility entries.
Run `npm run contracts:generate` after editing it; CI uses `contracts:check`.
`GatewayMethod`, `GatewayParams<M>`, `GatewayResult<M>`, and `GatewayTranscriptItem`
are available through the public gateway export.

Known request shapes are validated before controller dispatch. Permission checks,
workspace trust, generation fencing, and durable reservations remain controller
and runtime responsibilities. Invalid parameters produce `invalid_params`; a
malformed backend result produces `internal_error` without exposing its contents.
Client-side malformed results reject pending work before reaching consumers.

Protocol version 1 preserves extensible fields and historical transcript metadata.
Tool items in `transcript.load`, and `tool.start`, `tool.complete`, and `tool.failed`
notifications (including their `runtime.event` mirrors), include `tool_record`.
Its canonical schema is `gateway-tool-record.schema.json`; public exports include
`GatewayToolRecord`, `GatewayShellRecord`, and `parseGatewayToolRecord`.

Each record has `version: 1`, `kind: "tool_execution"`, `name`, `status`
(`running`, `success`, `error`, or `cancelled`), and `mutating`. Optional fields
include `call_id`, target and output previews, duration, and shell process facts.
Records reject unknown fields and bound previews to 8192 characters. They contain
selected display fields, never raw argument objects or private rationale. Existing
metadata remains available for older readers and file-change presentation.

Consumers prefer `tool_record` when present. Older payloads use the shared
`projectGatewayToolRecord` compatibility normalizer from `@mycli/contracts`.
The TUI owns folding and workspace-relative paths. It matches calls by canonical
identity and preserves newer shell lifecycle output and terminal state when the
tool invocation returns. Other transcript presentation variants remain extensible.

Readable items optionally carry `turn_id`. The storage projection and gateway preserve ownership
even when recovery moves an interruption notice beside earlier turn content. Consumers place
attempt records within that turn before using timestamps to order them; older items without
ownership retain a compatibility path based on user-message boundaries.

The full transcript expands retained tool details. Shell output is read on viewport demand with
three concurrent loaders at most. Closing the viewer or changing sessions aborts further pages;
an already-issued page may finish, but its result is discarded. Ctrl+C and the configured transcript
shortcut close the viewer without interrupting the underlying turn.

## Provider Attempts

`provider.attempt.updated` carries a canonical `ProviderAttemptRecord` only after the
coordinator commits it. The record includes session/turn/request identity, attempt and sequence,
frozen request/stream retry budgets, state, timestamps, and bounded safe failure details. Its
`runtime.event` mirror carries the same record. The gateway validates record semantics and
ownership; it never reconstructs an attempt from a display string.

The first `transcript.load` page includes up to 200 recent `provider_attempts` in chronological
order, `provider_attempts_truncated`, and a `provider_attempts_next_before` event cursor.
The bounded read-only `provider.attempts.load` query
accepts `session_id`, optional `turn_id` or `request_id`, and `limit` from 1 to 500. Session/turn
queries return the newest records and accept `before_event_id` for older pages. Request queries
return ascending records and support `after_sequence`. Sequence pagination requires `request_id`;
it cannot be combined with the session event cursor. Results contain `session_id`, `records`,
`has_more`, and `next_before_event_id`, and remain below 1 MiB. Cursors must belong to the selected
session and turn. Loading history never dispatches a request.

The TUI presents one recovery row per request with provider/model, attempt and budgets.
The existing details toggle expands loaded states and safe diagnostics, bounded by the canonical
1000 events per request. Bootstrap and older transcript loads backfill retry records through the
displayed message range, up to eight bounded pages per interaction. Remaining retry pages stay
available through the transcript viewer's existing Home/older-history action, even after message
history ends; its footer shows available/loading state. Scheduled attempts show
a countdown from durable `retryAt`; starting or ending recovery removes that countdown. A
restored pending attempt without an active turn is shown as paused. The turn terminal event
stops Working and remains the sole owner of the final failure notice. Legacy `stream.retrying`
and `stream.recovered` notifications remain available; the TUI ignores their duplicate display
once it has a durable attempt record.

## Lifetime

`shutdown` responds before orderly backend cleanup. EOF or connection closure
ends the stdio session and closes its backend. SIGINT exits 130; SIGTERM exits
143; startup or transport failure exits 1. Normal shutdown exits 0. Startup
cancellation also terminates the owned coordinator Worker.

Stdout contains protocol data only. Startup diagnostics use stderr and exclude
raw errors and credentials. Approvals and clarifications remain explicit protocol
interactions; app-server does not grant workspace trust or answer decisions.

Live root `approval.request` notifications are answerable while the current turn
and Worker lease remain active. Each compatible tool call waits for its own
approval. After one answer, the next prompt can appear while the approved command
is still executing or waiting for output. Modern `Shell` retains its normal
`yield_time_ms`; approval does not force an immediate process-handle return.

`tool.complete` closes the invocation, which may leave a running process.
Use `shell.output` and `shell.completed` for process progress, `shell.list` and
`shell.stop` for process control, and `transcript.load` for stored history.
The TUI's `Ctrl+T` viewer expands output already retained in its transcript. Opening
or scrolling it does not fetch additional Shell output. Long output retains its
truncation markers. The diagnostic `shell.output.load` RPC remains available to
clients that explicitly need stored chunks.
The agent uses `WriteStdin` to await completion before work that depends on the
command's exit. The foreground yield window remains in effect for ordinary
Shell calls; legacy `Bash` retains its existing waiting behavior.

## Capacity And Backpressure

The shared client, RPC server, and coordinator supervisor bound message framing,
pending work, and output queues. Limits apply per connection and per queue:

| Resource | Default |
| --- | --- |
| UTF-8 frame, excluding newline | 8 MiB |
| Transcript result page / maximum requested items | 6 MiB / 500 |
| Pending ordinary RPCs / encoded request bytes | 64 / 16 MiB |
| Additional control capacity | 8 requests / 256 KiB |
| Output queue, including unfinished writes | 256 writes / 16 MiB |
| Batched notification write | Up to 64 KiB of complete frames |
| Output without write progress | 15 seconds |
| Client RPC timeout | 120 seconds |
| Client event replay | 256 events / 8 MiB |
| Client event waiters | 256 |
| Embedded service attachments | 16, configurable from 1 to 64 |

Control capacity is reserved for `turn.interrupt`, `approval.respond`,
`clarify.respond`, `shell.stop`, `shell.stop_all`, and `shutdown`. Accepted writes
retain their order, with the Shell output coalescing described below. A saturated ordinary request receives `gateway_overloaded`
with `data.dispatched=false` before execution. During coordinator recovery, new
requests receive the same error; `shutdown` remains available. Requests are never
automatically replayed into the replacement Worker.

`transcript.load` defaults to at most 500 items and may return fewer to fit its
encoded byte budget. Follow `next_before` until it is null; a short page is not
the end of history. The backend reloads smaller pages with the original cursor
so storage supplies the correct continuation. A single item exceeding the page
budget returns `gateway_message_too_large` and leaves the connection usable.

Worker input credits are released on consumption acknowledgement, independently
of RPC completion. Worker output waits for acknowledgement before sending the
next write, which can contain several newline-delimited frames. Acknowledgements carry a generation and sequence; stale Workers
cannot release current capacity. Stream writers stop on backpressure and resume
on `drain`, including during graceful shutdown.
The stdio entrypoint also waits for the final destination write, with a 15-second
drain bound; ending the internal stream alone does not count as delivery.

The RPC server batches adjacent unsent notifications for one event-loop turn.
Each batch contains at most 64 KiB, or the configured frame limit plus its newline
if smaller. Larger individual frames remain standalone. Batching preserves every
frame byte, identity, runtime sequence, and direct/envelope pair in order. RPC
replies flush the accepted prefix and keep their own write acknowledgements.
This keeps bursts of small reasoning or text deltas from exhausting the write
count while the Worker waits for acknowledgements. Byte limits and the stall
deadline still apply, including to all unfinished batches.

Unsent `shell.output` notifications for the same session, generation, turn, Shell,
and call may be combined during backpressure. Their `runtime.event` mirrors are
combined independently. A combined update retains at most 10,000 characters,
the latest sequence and cursor, and an explicit `omitted_output_chars` count.
Use cursor ranges to avoid appending overlapping text. Runtime sequence gaps are
therefore valid; sequence order remains increasing. Completed Shell events remain
ordered after their pending output. Durable output chunk capture is unchanged.

Oversized input is rejected during frame assembly, including fragments without
a newline. Oversized output, output queue exhaustion, malformed responses or
notifications at the client, or a stalled consumer fails the connection. Live approvals and terminal events
are not silently dropped to make room. An attachment failure leaves other service
clients and the backend alive. Upstream backend failures close the whole service.
The stdio host owns its backend lifetime and exits with code 1 on transport failure;
use durable session state to recover the result of already dispatched work.

In-process transports may expose `diagnostic()` for the owning backend's stable
failure code. Coordinator Workers preserve it through completion and cleanup.
An unexpected TUI disconnection reports that code when available and writes the
original client error, session id, and code to the private, redacted
`~/.mycli/logs/tui-errors.log`. It does not copy conversation content into the log.

`GatewayClient` accepts `limits`, `requestTimeoutMs`, `eventReplayLimit`,
`eventReplayBytes`, and `eventWaiterLimit` options. Client limits do not raise the
server's limits. Local admission errors use `GatewayRequestError`; framing and
write stalls use `GatewayFlowControlError`. A `gateway_request_timeout` closes
the client connection: it does not prove a mutation failed or was cancelled.
There are no automatic retries. The transport owner must still close its connection
or backend. The service uses one upstream client with a shared request budget,
in addition to the independent limits of each attachment. Upstream timeouts fail
the service because the execution outcome is unknown.

The replay cache evicts its oldest entries to meet both bounds; an event larger
than its byte budget is not cached. The live `log` callback and already registered
waiters receive events before caching. Register long-lived subscriptions through
`log`; the replay cache is not durable event history.

Remote transport, multiple simultaneously active sessions, subscription filters,
and durable event cursors remain separate work.

## Session goals

`goal.get` returns `{ session_id, generation, goal }`, where `goal` is null or the
canonical `SessionGoal` snapshot. `goal.update` accepts `action` (`create`, `edit`,
`pause`, `resume`, `clear`), optional `objective` / `token_budget` (null removes the
budget), and the usual session id / generation. An editor can supply
`expected_goal_id` and `expected_revision` to reject stale actions.

`status.changed` and bootstrap `status` carry the same `goal` snapshot.
`turn.started.source = "goal"` distinguishes automatic work; transcript replay
represents it as a system notice. Goal state changes are durable before notification.
These operations are unavailable in review and headless one-turn execution.
