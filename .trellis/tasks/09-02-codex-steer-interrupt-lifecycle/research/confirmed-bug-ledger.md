# Confirmed Lifecycle Bug Ledger

## Snapshot

- Audit date: 2026-09-03
- Mycli worktree: `/Users/cosmos/Desktop/mycli/.worktrees/mycli-agent-worker-pool`
- Codex comparison source: `/Users/cosmos/Downloads/codex-main`
- Confirmed defects: 74
- Scope: read-only source audit; this document does not claim that any item is fixed.
- Evidence rule: an item is counted only when a concrete current-code path and a user-visible failure
  mode have both been identified. Speculative risks remain outside the count.

## Confirmed Defects

### Input, steer, interrupt, and durable queue

1. `turn.submit` degrades `turn_in_progress` into a TUI-memory-only queue, bypassing the durable
   follow-up path.
2. A failed automatic queued submission can leave the record pending forever because no later wakeup
   is guaranteed.
3. `/resume` performs a second TUI reset that can erase recovery events emitted during activation.
4. A steer can be included in both the compaction summary and the next fresh request, duplicating the
   same user intent.
5. The final-answer path does not re-check newly arrived steer input before terminal completion.
6. The TUI's `turn_id_mismatch` retry path is unreachable under the state transition that is meant to
   invoke it.
7. Approval continuation recovery can reuse the wrong client user-message identity.
8. Interrupt restoration can restore the same input more than once.
9. Interrupt cleanup does not clear the root interactive-request FIFO.
10. Durable queue dispatch is not atomic with transfer of ownership to either the turn or composer.
11. Composer restoration depends on the interrupt RPC response instead of the authoritative terminal
    event.
12. Credential admission cannot be interrupted while the UI already presents the turn as cancellable.
13. Interrupt does not cover a turn suspended on approval.
14. Optimistic and durable queue projections can reverse user-message order.
15. A read-only session can bypass the intended write gate on an alternate execution path.
16. Session activation failure can leave the frontend and backend bound to different sessions.
17. A delayed interrupt RPC from an older turn can consume Esc intended for a newer turn.
18. Request-level retry and stream-level retry multiply, producing as many as 30 provider attempts.
19. After a real context-window overflow, compaction can retry with the same oversized history.
20. When durable queue clearing fails, the TUI still restores the same input into the composer,
    creating two owners.
21. A failed restore acknowledgement can leave both a durable claim and composer text owning the
    same input.
22. `session.changed` is published before session switching has committed successfully.

### Compaction, checkpoints, and command lifecycle

23. Summary generation during compaction bypasses the shared provider retry, diagnostics, and usage
    accounting path.
24. A leftover `in_progress` compaction checkpoint causes the next turn to be treated as interrupted.
25. The durable queue scheduler can start work without passing credential-readiness admission.
26. Failed compaction deletes the previous completed checkpoint, allowing the window number to move
    backwards.
27. Manual `/compact` has no Esc cancellation path.
28. Manual `/compact` can race a new turn and compact a snapshot that excludes newly accepted input.
29. Slash-command busy admission checks only `#activeTurn`, omitting other in-flight session work.
30. Shutdown neither tracks nor cancels non-turn asynchronous RPC work.
31. Shutdown can wait forever when a running turn ignores its `AbortSignal`.
32. `/fork` persists the target session before activation; activation failure leaves an orphan fork.

### Worker transport, session switching, and continuations

33. Worker IPC has an approximately 2 MiB text-message ceiling, far below supported model context
    windows, and has no in-process fallback.
34. While slash `/resume` loads a transcript asynchronously, its stale TUI snapshot can overwrite
    live events received for the newly active session.
35. `permissions`, `mode`, and `sandbox` mutations do not claim the session-control lock. They can run
    during asynchronous session activation and persist an old-session choice into the newly active
    session.
36. Clarification resolution deletes its durable continuation before resumed Worker/provider work
    succeeds. If execution then fails, the gateway restores only an in-memory pending clarification;
    a second answer reaches storage with no continuation and fails with
    `clarification_not_pending`, leaving the session stuck.
37. A late subagent runtime event is not fenced to its originating run. It can either update a
    terminal task and throw, or be attributed to a later follow-up task on the same resident.
38. `/undo` is accepted while a turn is active and can mutate workspace files without entering the
    turn/session control gate, so it races the agent's own file tools and leaves the agent unaware
    that its working tree changed underneath it.
39. Gateway event writes ignore Node stream backpressure on both direct and worker-supervised paths.
    A slow, suspended, or blocked TUI can therefore accumulate an unbounded JSON-RPC event backlog
    during streaming instead of applying flow control, coalescing, or a bounded failure policy.
40. A background subagent's approval or clarification can be projected into whichever root session
    is active after the user switches sessions, corrupting that session's visible status and
    transcript.
41. Shutdown can report success while an aborted background subagent resumes terminal cleanup after
    SQLite has closed, producing an unhandled `persistence_error`.
42. A typed `/model` command can apply its session-scoped selection to a session the user switched
    to while its model-catalog lookup was in flight.
43. A failed background-child approval or clarification continuation consumes the user's response
    and terminally fails the child instead of restoring a retryable interactive request.
44. An asynchronous slash-command completion can affect the session selected after the command was
    started, including transcript output, overlays, client actions, and request-error rows.
45. Cancelling a visible background-child approval or clarification removes it from the gateway FIFO
    but never clears the corresponding TUI approval or clarification surface.
46. A late approval or clarification event can resurrect an already aborted or terminalized
    background child as a new pending interactive request.
47. Cancelling automatic context compaction is rendered as a compaction failure, even though the
    runtime classifies it as an interruption.
48. A rejected Worker provider step can leave the durable root turn `in_progress` after the TUI has
    been told that it failed, which also suppresses queued-work scheduling.
49. A failed approval continuation can re-open an approval card after its durable continuation was
    deleted, so the user's retry is rejected as `approval_not_pending`.
50. Responding to a background child approval or clarification marks the idle root session as
    running and routes later root input as invalid steering; the child terminal event does not clear
    that false state.
51. Pressing Esc on a background child's clarification selector sends `turn.interrupt` for the
    active root session, which cannot interrupt the child continuation; the selector remains pending.
52. The opt-in native chat runtime renders an approval request but routes every typed answer through
    ordinary message submission, so an approval can never be answered from that UI.
53. The native chat runtime drops child clarification identity when forwarding an answer. Its
    callback only receives the request ID and text, so the gateway omits the required child
    `session_id` and `generation` and rejects the response as not pending.
54. Native chat input event handlers discard rejected async callbacks. A gateway or command failure
    from a submitted line therefore becomes an unhandled rejection instead of a rendered recoverable
    error.
55. A background child's approval request globally replaces the composer while its parent root turn
    is still running, so the user can neither steer nor interrupt the root; Esc instead rejects the
    child request.
56. A background child's clarification request globally replaces the composer while its parent root
    turn is still running; Esc resolves to the root turn ID and interrupts that unrelated root turn.
57. Any pending background-child approval or clarification globally blocks session navigation,
    rather than being scoped to the child or its parent session.
58. Starting a resident subagent follow-up is non-atomic: a post-reservation failure leaves a
    durable `queued` task with no worker, and a follow-up deferred until finalization can report
    success before that loss occurs.
59. Initial `spawn_agent` activation can leak a queued task and resident when durable
    `markRunning()` fails, then expose the raw storage error to the root turn.
60. Native chat accepts multiple readline lines while an earlier asynchronous submission is still
    pending, so one clarification can be answered concurrently more than once.
61. Native chat suppresses every update to an existing transcript block ID; consequently it drops
    all but the first delta of a streamed assistant response and cannot render its final revision.
62. Native chat reprints an unchanged pending approval or clarification notice on every state
    update, progressively flooding the linear transcript.
63. Native chat maps the first Ctrl+C to process exit even while a turn is active, bypassing the
    turn-interrupt lifecycle and input restoration.
64. A follow-up failure after its durable task is marked `running` leaves that task running with no
    worker or terminal event.
65. Agent-resident reload and capacity-eviction failures leak scheduler reservations; reload also
   leaks an already-created runtime handle.
66. Native chat does not handle readline EOF/Ctrl+D, leaving the logical runtime started and the
   gateway/session shutdown path uninvoked.
67. A terminal subagent task can remain permanently resident and logically running when the
   task-to-thread finalization transition fails, while later follow-ups are accepted but never run.
68. Initial subagent activation can persist a `running` task with a `queued` thread when its thread
   transition fails after task activation, while leaking the resident and exposing the raw storage error.
69. Idle subagent unload and LRU eviction silently discard runtime-close failures, reclaim capacity,
   and start replacement agents while the original runtime is no longer under shutdown ownership.
70. A failed runtime-factory fallback can leak a scheduler slot when its durable failure transition
    also fails, even though no resident runtime was ever created.
71. An idle-child unload or LRU eviction can race a follow-up, detach a newly running child from
    the resident pool, and permanently consume the replacement scheduler slot.
72. Retrying a follow-up mailbox message after its first queue projection fails can deliver the
    message durably without ever waking the target child.
73. Concurrent follow-ups can rehydrate the same unloaded child twice, corrupt its durable status,
    surface a raw duplicate-resident error, and leak the losing runtime handle.
74. Mailbox coordination tools accept terminal child targets and return successful durable delivery
    even though the resulting item has no possible execution or recovery path.

## Latest Native TUI Evidence

### Bug 52: native approval is an input dead end

- `NativeChatRuntimeOptions` exposes `onClarificationRespond` but no approval-response callback at
  `tui/mycli-shell/src/native-chat-runtime.ts:12`.
- `NativeChatRuntime.#handleLine()` checks only slash commands and pending clarification before
  unconditionally calling `onSubmit` at line 147 through line 165. It never checks
  `state.pendingApproval`.
- The native gateway bootstrap wires `onClarificationRespond` but no equivalent approval callback at
  `tui/mycli-shell/src/gateway.ts:1216` through line 1231, whereas the full-screen runtime wires
  `onApprovalRespond` at line 1257.
- The regular reducer does create a visible approval transcript item and `pendingApproval` state at
  `tui/mycli-shell/src/adapters/runtime-state.ts:1814` through line 1838, so the native UI can show
  the request even though it provides no way to resolve it.
- Controlled reproduction: instantiate `NativeChatRuntime` with `pendingApproval`, submit
  `approve_once`, and capture callbacks. Current output is
  `{\"submitted\":[\"approve_once\"],\"approvals\":[]}`.
- Failure mode: under `MYCLI_TUI_NATIVE=1`, a user sees an approval request, types an approval
  choice, and leaves the original approval pending while the choice is instead submitted as normal
  turn input or queued follow-up.

### Bug 53: native child clarification response loses routing identity

- The native callback type is only `(requestId, response)` at
  `tui/mycli-shell/src/native-chat-runtime.ts:16`, and `#handleLine()` invokes it with exactly those
  two values at line 158 through line 162.
- The gateway wires that bare callback to `respondClarification` at
  `tui/mycli-shell/src/gateway.ts:1224`. Its third `clarification` argument is what would supply
  `session_id` and `generation` to `clarify.respond` at line 891 through line 902, but native calls
  never provide it.
- The child broker requires `session_id` before it can locate a pending child request at
  `backend/apps/mycli/src/node-runtime/agent-interactive-requests.ts:147` through line 151.
- Controlled reproduction: a native runtime with a child clarification invokes its handler as
  `[[\"child-question\",\"answer\"]]`, with no child session metadata.
- Failure mode: a root clarification may work, but a background child clarification shown in native
  mode cannot be answered; the resulting RPC has no child identity and returns
  `clarification_not_pending`.

### Bug 54: native submitted-line failures are unhandled

- The native readline listener uses `void this.handleLine(line)` without a catch at
  `tui/mycli-shell/src/native-chat-runtime.ts:55` through line 57.
- `#handleLine()` awaits `onCommandSubmit`, `onClarificationRespond`, or `onSubmit` at line 156
  through line 165 and has no error boundary.
- The full-screen runtime deliberately routes analogous actions through `runAsyncAction()` at
  `tui/mycli-shell/src/shell-runtime.ts:1285` through line 1304; that helper catches and renders a
  recoverable notice at line 3698 through line 3702. The native runtime has no corresponding path.
- Controlled reproduction: start a native runtime whose `onSubmit` throws `Error(\"gateway down\")`,
  inject one input line, and listen for Node's rejection event. Current output is
  `{\"unhandled\":\"Error: gateway down\"}`.
- Failure mode: a transient provider, transport, or command failure in native mode can terminate the
  Node process under its default unhandled-rejection policy, rather than preserving the prompt and
  showing the user a retryable error.

## Latest Evidence Anchors

### Bug 35: unlocked session-scoped configuration

- Model selection demonstrates the intended lock boundary at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:991`, using
  `#claimSessionControlOperation()` from line 2097.
- `/mode` and `/plan` mutate collaboration mode without that lock at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:1794`.
- `/sandbox` mutates permission and execution-policy state without that lock at line 1811.
- The direct permissions RPC mutates the same state without that lock at line 3711.
- Failure mode: while activation awaits trust/preferences IO, one of these mutations can target the
  old runtime and then be persisted or projected as if it belonged to the new active session.

### Bug 36: clarification durability consumed too early

- `ClarificationContinuationCoordinator.resolve()` commits the response before resumed execution at
  `backend/packages/runtime/src/clarification-continuation-coordinator.ts:140`.
- `SqliteSessionState.commitClarificationResponse()` deletes the durable continuation at
  `backend/packages/storage/src/sqlite-session-state.ts:697` and line 710.
- `NodeGateway.#runClarification()` restores only `SessionCoordinator` memory after a non-abort
  execution failure at `backend/apps/mycli/src/node-runtime/node-gateway.ts:2720`.
- `WorkerProviderStepExecutor.execute()` can reject at
  `backend/packages/runtime/src/worker-provider-step-executor.ts:38`.
- `NodeTurnRuntime.#runProviderLoop()` awaits that executor outside a failure-finalization catch at
  `backend/packages/runtime/src/node-turn-runtime.ts:1126`.
- Failure mode: the selector is shown again, but its durable backing row is gone; the repeated answer
  cannot be resolved after either the immediate retry or a process restart.

### Bug 37: late child runtime events are not fenced to their originating run

- `WorkerLeasedAgentThreadRuntimeHandle.#interruptActiveRun()` terminates the provider Worker but,
  on the hard-interrupt branch, returns without awaiting `active.released` at
  `backend/packages/runtime/src/worker-leased-agent-runtime.ts:200`.
- `AgentSupervisor.interrupt()` treats the returned `handle.interrupt()` as completed cleanup and
  terminalizes/removes the resident at
  `backend/packages/runtime/src/agent-supervisor.ts:403`.
- The original child runtime callback remains live through `#runResident()` at line 522 and routes
  a later progress event to `#recordRuntimeEvent()` at line 839 without checking that the task was
  interrupted or that the resident generation is still current.
- `SubagentTaskStore.updateProgress()` only accepts a `running` task at
  `backend/packages/storage/src/subagent-task-store.ts:293`; a late event therefore throws
  `persistence_error: invalid subagent task transition`.
- Controlled reproduction: use a worker-leased handle whose `forceInterrupt()` confirms cleanup
  while its delegated `run()` remains pending; after `supervisor.interrupt()` returns `true` and
  storage reports `interrupted`, invoke the captured progress callback. Current code throws the
  persistence error above.
- The same callback closure captures only the mutable `ResidentAgent`, not a task ID or run
  generation. `#startResidentFollowUp()` overwrites that resident's `taskId`, `parentTurnId`, and
  progress sequence at `backend/packages/runtime/src/agent-supervisor.ts:753` through line 761,
  while the original callback still invokes `#recordRuntimeEvent(resident, event)` at line 522.
- Controlled reproduction completes a first run, starts a mailbox follow-up, then invokes the
  first run's retained progress callback. The event is accepted against the second durable task:
  `{ "accepted": true, "secondStatus": "running", "secondProgress": "stale first-turn progress" }`.
- Failure mode: an aborting child can surface an unhandled/stale runtime failure after the parent
  has already shown a clean interruption; a normally completed child can instead make an unrelated
  follow-up appear to have performed stale work. Neither the durable state nor the projection has a
  generation fence for that callback.

### Bug 38: `/undo` races an active coding turn

- `resolveSlashCommand({ text: "/undo", surface: "tui", turnRunning: true })` currently resolves
  successfully to the backend-owned `undo` command. `undo` inherits `availableDuringTurn: true` at
  `backend/apps/mycli/src/node-runtime/node-slash-command-registry.ts:118`; unlike destructive
  session commands, its declaration at line 242 does not override it.
- `NodeGateway.#commandRun()` passes only `#activeTurn !== null` into that resolver at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:1243`, then calls
  `history.undo(this.#sessionId())` at line 1603 with no session-control claim or active-turn
  fencing.
- `FileHistoryStore.undoLatest()` performs real `rename()` or `rm()` workspace mutations at
  `backend/packages/tools/src/file-history-store.ts:203` and line 211.
- Failure mode: a user can undo a previous file mutation while the agent is still reasoning about or
  editing the same workspace. The current turn receives no tool result or filesystem-change event,
  so it can overwrite the undo or produce a misleading final report.

### Bug 39: unbounded gateway output under backpressure

- Direct gateway output writes through `PassThrough.write()` at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:4019` and ignores its boolean backpressure
  result. Streaming emits both direct notifications and mirrored `runtime.event` records at lines
  3974-3984.
- The worker-supervised production route repeats the same behavior at
  `backend/apps/mycli/src/node-runtime/node-backend-supervisor.ts:304`, also without a bounded
  queue, `drain` wait, or loss/coalescing policy.
- Node's writable stream contract returns `false` once its high-water mark is reached; further
  writes are buffered until a reader drains them. Here the producer keeps accepting provider text,
  reasoning, tools, plans, and mirrored events regardless.
- Failure mode: when the TUI is suspended, blocked in rendering, or otherwise slow to read, a long
  stream grows process memory and creates an ever-longer stale-event delay instead of a bounded,
  observable degraded state.

### Bug 40: child interactive requests are not scoped to the active parent session

- `spawn_agent` can leave a background child resident after its parent turn has completed; the
  gateway consequently allows a later `/new` or `/resume` once neither a root turn nor a broker
  interaction is pending at `backend/apps/mycli/src/node-runtime/node-gateway.ts:2078`.
- `AgentInteractiveRequestBroker` notifications identify the child session but carry no parent
  session identity at
  `backend/apps/mycli/src/node-runtime/agent-interactive-requests.ts:59`; child execution opens
  that request with only `input.childSessionId` at
  `backend/apps/mycli/src/node-runtime/node-backend.ts:1426`.
- `NodeGateway.#bindAgentInteractiveRequests()` forwards every broker notification directly at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:3819`, without comparing it to the active
  root session.
- The TUI applies `approval.request` and `approval.pending` without an
  `eventBelongsToActiveSession()` check at
  `tui/mycli-shell/src/adapters/runtime-state.ts:1814`, setting `waiting_approval` and adding an
  approval row.
- Controlled reproduction: after switching from parent session A to B, a child belonging to A
  requested approval. The gateway's active session was B, but the TUI received the child session's
  approval, set `waiting_approval`, and appended an approval transcript row to B.
- Failure mode: a user in session B can be asked to approve an action belonging to session A, and B
  appears blocked until that unrelated interaction resolves. Codex keeps inactive-thread approval
  state per thread rather than mutating the active thread.

### Bug 41: background subagent shutdown is not joined before SQLite closes

- `AgentSupervisor.interrupt()` awaits the runtime handle's interrupt/close sequence, terminalizes
  the resident, and removes it from the pool at
  `backend/packages/runtime/src/agent-supervisor.ts:398`; it does not await `resident.completion`.
- `#closeAll()` uses that same path for active background residents at
  `backend/packages/runtime/src/agent-supervisor.ts:996`.
- The original `#runResident()` continuation can still reach terminal storage work after its runtime
  await returns at `backend/packages/runtime/src/agent-supervisor.ts:539`.
- Backend shutdown closes integration composition and the agent worker pool before calling
  `store.close()` at `backend/apps/mycli/src/node-runtime/node-backend.ts:1667`.
- Controlled reproduction: hold a streaming background child response, request backend shutdown,
  and release the child afterward. Shutdown resolves, then the child continuation attempts to read
  its durable task and emits an unhandled
  `StorageFailure: persistence_error: subagent task read failed` after SQLite has closed.
- Failure mode: a seemingly clean exit can produce an unhandled persistence failure, and late child
  cleanup may be lost even though the parent has already been told shutdown completed.

### Bug 42: `/model` captures the active session after an unlocked catalog await

- Inline `/model <name>` is handled by the backend command path at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:1744`.
- That path awaits `#models(this.#provider)` before it enters `#selectModel()` and acquires the
  session-control lock at line 1764. A concurrent `session.resume` is therefore admissible during
  the catalog lookup.
- The production `controlCommands.selectModel()` snapshots
  `sessionCoordinator.snapshot()` only when it is eventually invoked at
  `backend/apps/mycli/src/node-runtime/node-backend.ts:1965`, then persists preferences against
  that snapshot at line 2010.
- The normal full-screen TUI dispatches slash commands through `runAsyncAction()` at
  `tui/mycli-shell/src/shell-runtime.ts:1286`, so its input loop remains able to open and use the
  session selector while a command RPC awaits.
- Controlled reproduction: hold the first `/model gpt-next` catalog lookup, complete
  `session.resume` from A to B, then release the lookup. The command succeeds and its selection
  callback observes B as the active session:
  `{ "resumeSession": "B", "activeSession": "B", "selectedSession": "B", "modelAccepted": true }`.
- Failure mode: a model intended for session A silently changes B's persisted preferences and can
  be used by B's next turn. Direct `model.select` is protected, but the typed slash command bypasses
  that protection before selection begins.

### Bug 43: failed child continuations irreversibly consume interactive requests

- `AgentInteractiveRequestBroker.respondApproval()` and `.respondClarification()` remove the pending
  request before starting the child continuation at
  `backend/apps/mycli/src/node-runtime/agent-interactive-requests.ts:126` and line 171.
- `InteractiveTurn.#resume()` converts a continuation rejection into `fail(error)` at line 344;
  `fail()` removes the already-consumed request and rejects the terminal promise at line 317.
- The child runtime wrapper awaits that promise at
  `backend/apps/mycli/src/node-runtime/node-backend.ts:1453`, and `AgentSupervisor.#runResident()`
  marks the task failed when that run rejects at
  `backend/packages/runtime/src/agent-supervisor.ts:595` and line 630.
- Unlike the root continuation paths, which restore their pending approval or clarification after a
  non-abort resume failure at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:2680` and line 2732, the child path has no
  restoration branch or durable retry state.
- Controlled reproduction: a child approval continuation throws `transient provider failure`.
  The first response is accepted, terminal completion rejects with that error, the broker has zero
  pending requests, and a second identical response returns `undefined`.
- Failure mode: a transient failure after the user approves a child operation becomes an unretryable
  failed subagent. The user cannot re-open or re-answer the original approval/clarification without
  spawning a new child and losing the original continuation context.

### Bug 44: ordinary command results are not fenced to their source session

- `runCommand()` snapshots `sourceSessionId` before awaiting `command.run` at
  `tui/mycli-shell/src/gateway.ts:1013`, but passes the then-current global `runtimeState` to
  `runtimeStateAfterCommandResult()` when the RPC finishes at line 1027.
- Its overlay and client-action branches run before that adapter and likewise do not verify that the
  source session is still current at `tui/mycli-shell/src/gateway.ts:1015`. The shared `send()`
  error handler also appends a `gateway.error` to whichever global state is current when an
  asynchronous command rejects at line 275.
- `runtimeStateAfterCommandResult()` uses `sourceSessionId` only when `result.mutated_session` is
  true. Every normal command result takes the branch at
  `tui/mycli-shell/src/adapters/runtime-state.ts:2911` and appends to the state it was passed at
  line 2917.
- The full-screen runtime permits the session selector to start its own asynchronous
  `session.resume` while a command RPC is in flight at
  `tui/mycli-shell/src/shell-runtime.ts:2038` and `tui/mycli-shell/src/gateway.ts:1058`.
- Controlled reproduction: construct state A, switch the current state to B before a simulated
  normal `/changes` response settles, and call the production adapter exactly as `runCommand()`
  does. It returned:
  `{"activeSession":"B","commandResult":{"id":"changes-A","type":"command_output","text":"A-only-result","metadata":{"command":"/changes"}}}`.
- Failure mode: transcript output, an overlay/client action, or a command failure belonging to A
  appears in B after the user switches sessions. The result is misleading even when the backend
  correctly executed the command against A.

### Bug 45: child cancellation leaves a stale interactive surface in the TUI

- A waiting child abort calls `InteractiveTurn.fail()`, which removes its broker record and emits
  `interactive.cancelled` at
  `backend/apps/mycli/src/node-runtime/agent-interactive-requests.ts:322` and line 412.
- The gateway receives that notification but only deletes its internal FIFO entry in
  `NodeGateway.#cancelInteractiveRequest()` at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:3823` and line 3960. It does not emit any
  event that tells the TUI to clear the currently visible request.
- `reduceRuntimeEvent()` has no `interactive.cancelled` branch at
  `tui/mycli-shell/src/adapters/runtime-state.ts:1257`; after an approval request it continues to
  hold `pendingApproval`, `waiting_approval`, and the transient approval row.
- Controlled reproduction: apply an actual child `approval.request` to the reducer, then its exact
  broker `interactive.cancelled` payload. The current state remained
  `{"after":"decision-A","liveState":"waiting_approval","approvalRows":1}`.
- Failure mode: cancelling or aborting a background child leaves the terminal blocked on an approval
  or clarification that no longer exists. A later response is rejected or ignored, while the stale
  card remains visible.

### Bug 46: late child interactive events resurrect terminalized requests

- `InteractiveTurn.onRuntimeEvent()` has no settled or abort fence. It forwards every event and
  registers an approval/clarification request at
  `backend/apps/mycli/src/node-runtime/agent-interactive-requests.ts:275` through line 280.
- `InteractiveTurn.fail()` marks the turn settled on abort at line 322, but a late provider/worker
  callback still holds the same `interactiveTurn.onRuntimeEvent` function from
  `backend/apps/mycli/src/node-runtime/node-backend.ts:1452`.
- This is reachable in the same hard-interrupt class already demonstrated by bug 37: a worker can
  emit after its outer task was terminalized. Here, a late `approval_requested` or
  `clarification_requested` event is accepted instead of discarded.
- Controlled reproduction: abort a real `AgentInteractiveRequestBroker` turn, then deliver a late
  `approval_requested` event. `broker.pending()` contained the new request and
  `respondApproval()` returned `accepted: true`, although the child terminal promise had already
  rejected.
- Failure mode: an interrupted or completed child can re-open a dead approval/clarification in the
  parent TUI. The user can approve it, receives an accepted response, and no child continuation can
  run; the terminal is left with a false or stuck interactive state.

### Bug 47: compaction cancellation is falsely rendered as failure

- `CompactionCoordinator.compact()` returns `status: "interrupted"` when the summary request is
  aborted, but its catch block emits `compaction_completed` with `status: "failed"` at
  `backend/packages/runtime/src/compaction-coordinator.ts:283`.
- The core event contract only admits `compressed | skipped | failed` at
  `backend/packages/core/src/types.ts:257`, so the coordinator cannot report the actual terminal
  state through the event channel.
- The existing characterization test proves the mismatch at
  `backend/packages/runtime/test/compaction-coordinator.test.ts:240`: the returned result is
  `interrupted` while the emitted `compaction_completed` event is asserted as `failed`.
- The TUI maps that emitted value to tool error state and the literal `Context compression failed`
  at `tui/mycli-shell/src/adapters/runtime-state.ts:4816` and line 4935.
- Failure mode: pressing Esc while automatic pre-turn, mid-turn, or context-overflow compaction is
  waiting on its summary provider leaves a false failure row in the transcript rather than showing a
  benign interruption (or suppressing the completed row entirely).

### Bug 48: Worker provider rejection projects a terminal failure without durable finalization

- `WorkerProviderStepExecutor.execute()` intentionally rejects when the Worker lease fails or a
  protocol frame is invalid at `backend/packages/runtime/src/worker-provider-step-executor.ts:72`
  and line 124. The worker-executor tests demonstrate this ordinary failure class through
  `lease.failure` at `backend/packages/runtime/test/worker-provider-step-executor.test.ts:189`.
- `NodeTurnRuntime.#runProviderLoop()` awaits that executor outside a terminalization catch at
  `backend/packages/runtime/src/node-turn-runtime.ts:1126`. The rejection escapes `submit()` after
  `reserveTurn()` has already persisted the turn as `in_progress`; its `finally` only releases
  in-memory tool and policy state at line 539.
- `NodeGateway.#runTurn()` catches the rejected runtime at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:2632`, but for a non-abort error it only calls
  `#emitTurnFailure()` at line 2644. That helper publishes `turn.failed`/status notifications but
  does not call `failTurn()` or `forceInterrupt()`.
- `terminalFinalized` remains false, so `#releaseActiveExecution()` does not call
  `#scheduleNextQueuedTurn()` at `backend/apps/mycli/src/node-runtime/node-gateway.ts:2768`.
- Failure mode: after a root Worker crash or protocol-fence failure, the TUI says the turn failed
  and permits new input, while SQLite still contains an `in_progress` turn and queued follow-ups do
  not advance until later recovery. Resume can then surface a contradictory interrupted/recovery
  state for the same turn.

### Bug 49: approval retry is restored only in memory after its durable continuation is finalized

- Approval resolution executes and durably records the approved tool result before it resumes the
  provider loop at `backend/packages/runtime/src/node-turn-runtime.ts:617` through line 685.
- That resumed loop calls `ApprovalContinuationCoordinator.finish()` before the next provider step
  at `backend/packages/runtime/src/node-turn-runtime.ts:885`. `finish()` deletes the pending
  decision, suspended turn, and effect checkpoint at
  `backend/packages/storage/src/sqlite-session-state.ts:742` through line 752.
- A later Worker lease/protocol failure can reject the resumed provider step (the same ordinary
  failure path described in bug 48). `NodeGateway.#runApproval()` catches it and restores only the
  in-memory `SessionCoordinator` pending approval at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:2680`, then emits a new `approval.request`
  at line 2689.
- The next `approval.respond` reaches `NodeTurnRuntime.resolveApproval()`, whose first durable
  lookup at `backend/packages/runtime/src/node-turn-runtime.ts:598` now finds no continuation and
  throws `approval_not_pending`.
- Failure mode: after the user has already approved and the side effect has completed, a transient
  Worker continuation failure shows the same approval card again. Retrying the visible action is
  rejected, while a restart has no durable state from which to recover the continuation.

### Bug 50: child interactive responses are reduced as resumed root turns

- `AgentInteractiveRequestBroker` publishes `approval.respond` or `clarify.respond` for a child
  session after accepting the user's answer at
  `backend/apps/mycli/src/node-runtime/agent-interactive-requests.ts:126` and line 171.
- The gateway forwards that notification without a root/child discriminator at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:3819`.
- The TUI uses root-turn reducer branches for every `approval.respond` and `clarify.respond` at
  `tui/mycli-shell/src/adapters/runtime-state.ts:1840` and line 1881. For a child request,
  `interactiveResponseTurnId()` correctly returns the existing root ID (normally `null`), but the
  surrounding branch unconditionally sets `turnRunning: true` and `liveStatus: Running`.
- `subagent.updated` removes the child approval card when the child is terminal, but it never
  clears `turnRunning` or `liveStatus` at `tui/mycli-shell/src/adapters/runtime-state.ts:1540`.
- Controlled reducer reproductions: parent `A` receives child `C`'s approval or clarification and
  accepts it, then receives `subagent.updated { status: completed }`. Current output remains
  `{ "turnRunning": true, "activeTurnId": null, "liveStatus": "Running" }`; calling
  `runtimeInputDisposition(state, false)` returns `steer`.
- Failure mode: after approving a background child while the root session is otherwise idle, the
  next ordinary user message is sent through `turn.steer` without an active root turn and is
  rejected. The TUI can stay visually and behaviorally stuck until a separate status refresh or
  interrupt resets it.

### Bug 51: Esc cannot cancel a background child clarification

- `ClarificationSelectorComponent` routes its cancel action to
  `MycliShellRuntime.handleInterrupt()` at
  `tui/mycli-shell/src/shell-runtime.ts:2587`; that route does not receive the clarification's
  `sessionId` or `childSessionId`.
- `interruptTurn()` snapshots `currentSessionMutationContext()` from the root TUI state at
  `tui/mycli-shell/src/gateway.ts:695` and sends that root `session_id`/`generation` along with the
  child turn ID at line 745. It does not use the pending clarification's child-session identity.
- `NodeGateway.#interrupt()` accepts only the active root session, then checks its root active turn
  or root `SessionCoordinator` clarification at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:2891`. It has no route to
  `AgentInteractiveRequestBroker` and returns `{ accepted: false, requested: false }` for an idle
  root with a child clarification.
- The broker supports answers only (`respondClarification`) and exposes no cancellation method at
  `backend/apps/mycli/src/node-runtime/agent-interactive-requests.ts:52`, so no later operation
  cancels the child as a consequence of Esc.
- Controlled path: root session `A` renders a child `C` clarification with turn `child-turn`; Esc
  issues `turn.interrupt { session_id: A, turn_id: child-turn }`. With no active root turn, the
  current gateway's branch returns `accepted: false`; `C` remains in the broker pending map and
  the selector remains pending.
- Failure mode: Esc, which users reasonably expect to cancel a clarification and which Codex binds
  to the request-owning interactive surface, cannot dismiss or interrupt a background child. The
  root may briefly show an interrupt attempt, then returns to the same unresolved child selector.

### Bug 55: a child approval preempts an active root turn

- The gateway explicitly supports a child approval arriving while its root turn is running; the
  characterization test starts root turn `root-turn`, emits `approval.request` for
  `child-session`, and accepts the child response at
  `backend/apps/mycli/test/node-gateway.test.ts:2831` through line 2890.
- The shared reducer does not distinguish that child event from a root approval. Its
  `approval.request` branch unconditionally assigns `turnRunning: false` and
  `liveStatus: waiting_approval` at
  `tui/mycli-shell/src/adapters/runtime-state.ts:1814` through line 1838, while retaining
  `activeTurnId: root-turn`.
- The full-screen runtime then sees every pending approval as an immediate modal: it calls
  `showApprovalSelector()` at `tui/mycli-shell/src/shell-runtime.ts:2488` through line 2500,
  clears the editor and gives the selector focus at line 2562 through line 2574. Its global input
  handler bypasses root controls while `selectorActive` at line 1456 through line 1458.
- Pressing Esc reaches `ApprovalSelectorComponent`, which chooses the child request's `reject`
  option at `tui/mycli-shell/src/components/approval-selector.ts:110` through line 117. It cannot
  reach `handleInterrupt()` for the still-running root. The corresponding shell test establishes
  that Esc maps to rejection and leaves this selector mounted at
  `tui/mycli-shell/test/shell-app.test.ts:4121` through line 4156.
- Controlled reducer reproduction: after `turn.started { session_id: root-session, turn_id:
  root-turn }` and an unrelated child `approval.request`, current output is
  `{ "turnRunning": false, "activeTurnId": "root-turn", "pendingApproval": "child-decision",
  "liveStatus": "waiting_approval" }`.
- Codex keeps these requests scoped to their owning thread. Its
  `PendingThreadApprovals` widget describes inactive-thread approvals as an informational list at
  `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/bottom_pane/pending_thread_approvals.rs:11`
  through line 69, and `refresh_pending_thread_approvals()` excludes the active thread before
  rendering that list at
  `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/app/thread_routing.rs:819` through line 847.
- Failure mode: a root turn can continue streaming or waiting for a steer while an unrelated child
  needs approval, but mycli removes the root composer and hijacks Esc. The user must approve or
  reject the child before they can interact with the root, and may unintentionally reject the child
  when trying to stop the root.

### Bug 56: a child clarification can interrupt its active parent root turn

- The child broker publishes clarification requests through the same unscoped gateway subscription
  as approvals at `backend/apps/mycli/src/node-runtime/node-gateway.ts:3819` through line 3829.
  The existing root-running child-approval test demonstrates that this background-notification path
  is legal while a root turn is active at
  `backend/apps/mycli/test/node-gateway.test.ts:2831` through line 2890; the broker's method union
  treats `clarify.request` identically for projection at
  `backend/apps/mycli/src/node-runtime/agent-interactive-requests.ts:30` through line 37.
- `reduceRuntimeEvent()` assigns `turnRunning: false` and `waiting_clarification` for every
  `clarify.request`, with no root/child check, at
  `tui/mycli-shell/src/adapters/runtime-state.ts:1860` through line 1879. A controlled reducer
  reproduction after root `root-turn` starts and child `child-turn` asks a question returns
  `{ "turnRunning": false, "activeTurnId": "root-turn", "pendingClarification":
  "child-question", "liveStatus": "waiting_clarification" }`.
- As with approval, the pending surface replaces the editor and focuses the clarification selector
  at `tui/mycli-shell/src/shell-runtime.ts:2488` through line 2500 and line 2587 through line 2599.
  That selector maps Esc to `handleInterrupt()` at line 2591 through line 2593; its direct test
  confirms the interrupt callback is invoked at
  `tui/mycli-shell/test/shell-app.test.ts:4244` through line 4280.
- `interruptTurn()` prefers `runtimeState.activeTurnId` over the clarification's turn ID at
  `tui/mycli-shell/src/gateway.ts:695` through line 715 and line 730. With the root still active,
  it therefore sends `turn.interrupt { turn_id: root-turn, session_id: root-session }`; the gateway
  accepts that active root turn at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:2891` through line 2943.
- This is distinct from bug 51: bug 51 covers an idle root, where the child turn ID is sent with the
  wrong root session and nothing is cancelled. Here the same action successfully aborts the wrong,
  still-running root turn.
- Failure mode: a user trying to dismiss or cancel a background child's clarification aborts the
  main agent's active work. The child question remains unresolved, while the root loses progress and
  may restore its own input unexpectedly.

### Bug 57: a background child request locks session navigation globally

- `NodeGateway.#assertSessionTransitionAvailable()` rejects a session transition whenever
  `agentInteractiveRequests.pending().length > 0` or its global interactive FIFO is nonempty at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:2078` through line 2094. The check has no
  parent-session or target-session comparison.
- The targeted current test starts a gateway with a pending child approval, attempts
  `session.resume { session_id: target }`, and receives `turn_in_progress` at
  `backend/apps/mycli/test/node-gateway.test.ts:2952` through line 2993. It passed unchanged in
  this audit.
- Codex persists inactive-thread requests into their own thread event stores rather than treating
  them as a global navigation lock: `enqueue_thread_request()` identifies inactive requests at
  `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/app/thread_routing.rs:1004` through line
  1049, and the UI separately lists non-active threads with approvals at
  `codex-rs/tui/src/bottom_pane/pending_thread_approvals.rs:11` through line 69.
- Failure mode: one long-lived child asking for approval or clarification prevents the user from
  creating, resuming, or inspecting another root session, even when that child belongs to a finished
  or unrelated parent task. This turns a background worker request into a terminal-wide modal lock.

### Bug 58: failed resident follow-up start leaves an orphan durable task

- `AgentSupervisor.#startResidentFollowUp()` reserves a new task, marks it running, transitions the
  resident thread, and launches its mailbox run as four separate operations at
  `backend/packages/runtime/src/agent-supervisor.ts:726` through line 764. Its catch at line 765
  through line 767 only returns `false`; it does not fail or interrupt a task already reserved,
  restore a pending follow-up, or publish a terminal event.
- Direct controlled reproduction uses the real `SQLiteSessionStore` with only `markRunning()`
  fault-injected. After an idle child completes, `followUp()` reserves `task-2`, the injected
  `markRunning()` fails, and current output is
  `{ "accepted": false, "mailboxRuns": 0, "thread": "idle", "tasks":
  [{ "id": "task-2", "status": "queued", "description": "continue" },
  { "id": "task-1", "status": "completed" }] }`. No resident owns or schedules `task-2`.
- The deferred path is worse. When a child is running or finalizing, `followUp()` stores one
  `pendingFollowUp` and returns `true` at
  `backend/packages/runtime/src/agent-supervisor.ts:425` through line 450. After terminalization,
  `#runResident()` invokes `void this.#startResidentFollowUp(...)` inside a microtask and discards
  its boolean result at line 653 through line 660.
- A controlled reproduction queues the follow-up while the original child is still running, then
  injects the same `markRunning()` failure after `followUp()` returned. Current output is
  `{ "accepted": true, "mailboxRuns": 0, "thread": "idle", "tasks":
  [{ "id": "task-2", "status": "queued", "description": "continue" },
  { "id": "task-1", "status": "completed" }] }`.
- Production hides even the direct `false` result from the model. The mailbox trigger awaits
  `agentSupervisor.followUp()` but discards its boolean at
  `backend/apps/mycli/src/node-runtime/node-backend.ts:546` through line 552; `AgentMailbox.send()`
  then returns a normal `enqueued` delivery at
  `backend/packages/runtime/src/agent-mailbox.ts:95` through line 144, and the
  `followup_task` adapter renders that delivery as tool success at
  `backend/packages/integrations/src/subagents/coordination-tools.ts:162` through line 186.
- `SubagentTaskStore` explicitly distinguishes `queued` from `running` at
  `backend/packages/storage/src/subagent-task-store.ts:5` through line 10, but the supervisor has
  no queued-task claimant or restart path that runs this orphaned task. Recovery eventually marks
  abandoned queued work interrupted, so it does not execute the requested follow-up.
- Failure mode: a parent agent can be told that `followup_task` was accepted even though its child
  never receives the work. The mailbox text remains stranded until an unrelated future trigger, the
  transcript/task list retains a misleading queued task, and no result asks the parent to retry.

### Bug 59: initial spawn activation leaks after durable reservation

- `AgentSupervisor.spawn()` atomically reserves the thread and task through `spawnStore.reserve()`
  at `backend/packages/runtime/src/agent-supervisor.ts:279` through line 306, but subsequently
  creates and inserts a process-local resident before calling `taskStore.markRunning()` at line 327
  through line 347. Neither that call nor the next thread transition is inside a recovery boundary.
- If `markRunning()` rejects, the error escapes the `spawn()` promise directly. The resident remains
  in `#pool`, its scheduler slot remains reserved, and no `failed` lifecycle event is emitted. This
  differs from runtime-factory failure, which uses `#failSpawn()` at line 323 through line 325.
- Controlled reproduction uses the real SQLite reservation path with only `markRunning()`
  fault-injected. The root call rejects with `Error: injected markRunning failure`, while the durable
  state is `{ "thread": "queued", "task": "queued" }`.
- Calling `supervisor.close()` does not repair the task. `#closeAll()` routes a queued resident to
  `interrupt()` at line 996 through line 1013, but `#interruptTask()` deliberately ignores any task
  not already `running` at line 851 through line 861. Current post-close state is
  `{ "thread": "interrupted", "task": "queued" }`.
- Failure mode: a transient storage failure during `spawn_agent` produces a raw tool failure and
  leaves an invisible resident consuming capacity plus a durable task that no worker can run. Later
  recovery and agent listings observe contradictory queued/interrupted state instead of one clear
  terminal failure.

### Bug 60: native readline submissions are not serialized

- `NativeChatRuntime.start()` starts every readline `line` callback with
  `void this.handleLine(line)` at `tui/mycli-shell/src/native-chat-runtime.ts:55` through line 57;
  it has no in-flight guard, input queue, or error boundary.
- `#handleLine()` reads the current `pendingClarification` and awaits the response callback only
  afterwards at line 147 through line 166. Until the first callback settles and the gateway
  projects a new state, a second line reads the same request ID and starts a second response.
- Controlled reproduction used a pending clarification with a response callback held behind a
  promise, then wrote two complete lines before releasing it. The callback captures were
  `{ "calls": [["q", "one"], ["q", "two"]] }`; both answers were dispatched for the same
  request.
- The same unbounded concurrency applies to ordinary turn submissions and slash commands. For a
  clarification, the second gateway response normally becomes `clarification_not_pending`; because
  native handlers also discard rejected promises, it joins bug 54 as an unhandled rejection.
- Failure mode: typing or pasting two lines while the first action is in flight can submit a
  duplicate decision, duplicate a command, or race two turn submissions. The full-screen runtime
  uses focused controls and its async-action boundary, whereas native mode has no equivalent
  single-flight ownership.

### Bug 61: native chat loses streaming updates for existing transcript blocks

- `NativeChatRuntime.renderInitial()` records every current block ID in `seenBlockIds` at
  `tui/mycli-shell/src/native-chat-runtime.ts:106` through line 111. Later
  `renderNewTranscriptBlocks()` prints only IDs it has never seen, at line 114 through line 126;
  it does not compare block content or type.
- The production reducer intentionally keeps one assistant ID for a live stream: `message.delta`
  reuses `activeAssistantItemId` at `tui/mycli-shell/src/adapters/runtime-state.ts:1433` through
  line 1439, and `applyAssistantDelta()` replaces that block's text in place at line 4174 through
  line 4205. `message.complete` also reconciles the same stream ID into its final form.
- The gateway forwards every state update to native mode without a transcript-update mode at
  `tui/mycli-shell/src/gateway.ts:140` through line 164, so native mode receives these revised
  blocks but discards them solely because their ID was already printed.
- Controlled reproduction started native chat with assistant block `assistant-stream` containing
  `first`, then set state with the same ID containing `second`. The second write contained no
  `second`: `{ "rendersUpdatedText": false }`.
- Failure mode: under `MYCLI_TUI_NATIVE=1`, a streamed answer commonly shows only its first token
  chunk. Subsequent text, final reconciliation, and retry/reset corrections are absent from the
  user's terminal transcript even though the canonical state is correct.

### Bug 62: native chat repeatedly appends the same pending notice

- Every gateway state transition calls `nativeRuntime.setState(shellState)` at
  `tui/mycli-shell/src/gateway.ts:140` through line 164. Native `setState()` unconditionally calls
  `renderStatusChanges()` at `tui/mycli-shell/src/native-chat-runtime.ts:64` through line 75.
- `renderStatusChanges()` has no previous-notice comparison and writes the current value every
  time at line 129 through line 135. Pending approval and clarification notices are derived from
  persistent pending state at `tui/mycli-shell/src/adapters/runtime-state.ts:3190` through line
  3197, so ordinary unrelated events do not clear them.
- Controlled reproduction applied the identical native state with
  `pendingNotice: "Retry this"` twice. The output count was
  `{ "noticeCount": 2 }`, even though no user-visible state had changed.
- Failure mode: a long-running root turn that receives a background interactive request, or any
  state that continues to receive events while a notice is pending, appends the same warning on
  every update. The linear native transcript becomes noisy and can push useful tool or assistant
  output out of the visible scrollback.

### Bug 63: native Ctrl+C exits instead of interrupting an active turn

- `NativeChatRuntime` has no `onInterrupt` callback. Its readline `SIGINT` listener always invokes
  `handleInterruptExit()` at `tui/mycli-shell/src/native-chat-runtime.ts:58` through line 60, which
  stops the interface and invokes `onInterruptExit` at line 94 through line 97.
- The native gateway wires that callback directly to `interruptExit(130)` at
  `tui/mycli-shell/src/gateway.ts:1216` through line 1229. `interruptExit()` closes the local
  gateway transport and calls `process.exit(130)` at line 1176 through line 1180; it never calls
  `interruptTurn()`.
- The behavior is currently encoded by the passing test
  `native chat runtime treats Ctrl+C as local interrupt exit` in
  `tui/mycli-shell/test/native-chat-runtime.test.ts:173` through line 198. Its controlled input
  produces `interruptExitCount: 1` and stops the runtime, with no turn-interrupt callback.
- This diverges from the full-screen runtime, where Ctrl+C checks `isTurnRunning()` and calls
  `handleInterrupt()` before an exit is allowed at
  `tui/mycli-shell/src/shell-runtime.ts:3353` through line 3383. Codex likewise sends a
  thread-scoped `turn_interrupt` for an active turn before falling back to startup interruption at
  `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/app/thread_routing.rs:518` through line 554.
- Failure mode: with `MYCLI_TUI_NATIVE=1`, pressing Ctrl+C during streaming kills the client rather
  than requesting a durable interrupt. The active turn, pending steer handling, and deterministic
  composer restoration never run; a process that owns its backend can leave the session to later
  recovery instead of reporting the same interrupted turn as the regular TUI.

### Bug 64: follow-up activation can strand a durable task in `running`

- `AgentSupervisor.#startResidentFollowUp()` reserves a task and then calls `markRunning()` before
  it transitions the thread and starts `#runResident()` at
  `backend/packages/runtime/src/agent-supervisor.ts:740` through line 764. Its encompassing catch
  at line 765 through line 767 returns `false` without compensating any completed durable step.
- This is distinct from bug 58: if `markRunning()` itself fails, the orphan stays `queued`; here,
  a failure in `threadStore.transition({ status: "running" })` occurs after the task is already
  durable `running` but before a worker exists.
- Controlled reproduction used the real `SQLiteSessionStore`: first complete an idle child, then
  inject only the follow-up thread transition failure. Current output is
  `{ "accepted": false, "followupTask": "running", "thread": "idle", "mailboxRuns": 0 }`.
  The second task has no execution promise, terminal event, or recovery claimant.
- A later follow-up can create a new task because the resident remains `idle`, leaving the prior
  `running` row permanently misleading. Restart recovery sees an apparently live task despite no
  worker lease created by this path.
- Failure mode: a transient persistence failure can make the parent see a failed follow-up while
  the durable task list reports an indefinitely running child. Subsequent work may proceed on the
  same child, but status, reporting, and recovery retain an unresolvable phantom task.

### Bug 65: reload and eviction failures leak scheduler capacity and runtime resources

- `AgentSupervisor.#loadResident()` reserves a scheduler slot, creates a runtime handle, then
  transitions the durable thread to `idle` at
  `backend/packages/runtime/src/agent-supervisor.ts:671` through line 723. The transition and
  subsequent pool insertion are outside the runtime-factory recovery block. If the transition
  fails, no code calls `handle.close()` or `scheduler.release()`; the error escapes `followUp()`.
- Controlled restart reproduction used a real unloaded SQLite child with the `idle` transition
  fault-injected. It produced
  `{ "reloadError": "injected idle transition failure", "closeCalls": 0,
  "replacement": "failed", "replacementError": "agent_capacity_exhausted: resident agent limit 2 reached" }`.
  Thus a handle exists but is not owned by the pool, and the leaked slot prevents a replacement
  from starting.
- The same reserve-before-cleanup ordering exists in initial `spawn()` at
  `backend/packages/runtime/src/agent-supervisor.ts:259` through line 278. `AgentScheduler.reserve()`
  removes the evicted idle slot and inserts the replacement before `#evictIdle()` persists the old
  thread as `unloaded`; if that transition fails, the catch returns `spawnFailure()` but never
  releases the new slot. `#evictIdle()` has already removed the old resident from the pool at
  line 794 through line 804.
- Controlled capacity-eviction reproduction fault-injected only the old thread's `unloaded`
  transition. The replacement spawn failed as expected, then a third spawn returned
  `agent_capacity_exhausted: resident agent limit 2 reached` while the old durable thread remained
  `idle` with no resident.
- Failure mode: a short-lived storage error during reload or LRU eviction permanently reduces the
  number of usable background-agent slots for that process. Reload additionally leaves a live
  runtime handle outside shutdown ownership, so it can retain worker resources after the UI reports
  the operation failed.

### Bug 66: native readline EOF/Ctrl+D does not close the runtime

- `NativeChatRuntime.start()` registers `line` and `SIGINT` listeners at
  `tui/mycli-shell/src/native-chat-runtime.ts:55` through line 60, but no `close` listener. EOF
  therefore closes readline without invoking the runtime's own shutdown path.
- `NativeChatRuntime.stop()` is the only method that clears `started`, drops the readline handle,
  and invokes `onExit` at line 79 through line 89. The gateway maps that callback to `shutdown(0)`
  at `tui/mycli-shell/src/gateway.ts:1216` through line 1229, so it is also skipped after EOF.
- The adjacent gateway-client implementation handles readline `close` explicitly at
  `tui/mycli-shell/src/adapters/gateway-client.ts:112` through line 119, and the full-screen
  editor separately handles Ctrl+D at `tui/mycli-shell/src/components/custom-editor.ts:39` through
  line 45. Native mode lacks either recovery path.
- Controlled reproduction creates a native runtime with `PassThrough` input, calls `input.end()`,
  and waits for readline to process EOF. Current output is
  `{ "started": true, "exits": 0 }`.
- Failure mode: in native mode, Ctrl+D/terminal EOF closes readline but leaves the runtime logically
  active and never invokes gateway shutdown. The process/session can remain hanging or retain local
  resources despite the user having closed input.

### Bug 67: terminal subagent finalization can strand a running resident

- `AgentSupervisor.#runResident()` first persists a successful task as `completed`, then transitions
  its thread to `idle` at `backend/packages/runtime/src/agent-supervisor.ts:551` through line 563.
  That transition is inside the broad runtime catch rather than a compensating finalization boundary.
- If `threadStore.transition({ status: "idle" })` fails, the catch sees an already completed task and
  does not make a corrective terminal transition. The `finally` block publishes completion but only
  closes/removes a resident when its in-memory thread is `failed` or `interrupted` at line 638 through
  line 646; it therefore retains the resident and scheduler reservation as `running`.
- `followUp()` treats any resident whose in-memory thread is `running` as finalizing work, assigns
  `pendingFollowUp`, and returns `true` at line 425 through line 443. There is no remaining
  `#runResident()` completion path to consume that pending follow-up after the prior run has already
  returned.
- Controlled reproduction uses the real SQLite stores and injects only the success-path `idle`
  transition failure. Current output is
  `{ "first": "completed", "durableThread": "running", "durableTask": "completed", "accepted": true, "taskCount": 1, "mailboxRuns": 0 }`.
- The failure-result branch has the same ordering: it calls `taskStore.fail()` and only then
  transitions the thread to `failed` at `backend/packages/runtime/src/agent-supervisor.ts:564`
  through line 579. If that second transition fails, the broad catch observes an already failed
  task and does not repair the live resident or scheduler slot.
- Controlled reproduction injects only that `failed` thread transition. The foreground spawn still
  returns `{ "status": "failed" }`, but durable and resident state diverge as
  `{ "durableThread": "running", "durableTask": "failed", "followUpAccepted": true, "taskCount": 1, "mailboxRuns": 0 }`.
- Failure mode: the parent receives a successful completed result, then receives a successful
  `followup_task` acknowledgement, or receives a failed result with the same stranded resident;
  in either case no second task is reserved or run. The child remains resident and consumes capacity
  with a durable thread stuck `running`, until a manual interrupt or process restart repairs the state.

### Bug 68: initial spawn can split task and thread activation

- `AgentSupervisor.spawn()` constructs and inserts the newly created resident into the process-local
  pool at `backend/packages/runtime/src/agent-supervisor.ts:327` through line 346, then calls
  `taskStore.markRunning()` before `threadStore.transition({ status: "running" })` at line 347
  through line 351. Neither operation is guarded by `#failSpawn()` or a compensating cleanup path.
- A `threadStore.transition()` failure therefore escapes `spawn()` directly after the task has
  become durable `running`; the thread remains `queued`, the just-added resident still owns a
  scheduler slot, and `#runResident()` was never started.
- This is distinct from bug 59, which covers a `markRunning()` failure before the durable task
  changes state. Here the task and thread have already diverged in the opposite direction.
- Controlled reproduction injects only the initial `running` thread transition failure using the
  real SQLite stores. Current output is
  `{ "error": "injected running transition failure", "durableThread": "queued", "durableTask": "running", "followUpAccepted": false }`.
- Failure mode: `spawn_agent` becomes a raw tool error instead of a structured failed task, while
  the task list reports running work that has no worker and follow-ups cannot revive it. It also
  consumes a resident slot until explicit interruption or process shutdown.

### Bug 69: idle unload and eviction report success after runtime close failure

- `AgentSupervisor.unload()` explicitly swallows `resident.closeOnce()` rejection, then removes the
  resident, releases its scheduler slot, and persists `unloaded` at
  `backend/packages/runtime/src/agent-supervisor.ts:453` through line 464. It returns `true` despite
  never confirming the runtime closed.
- Automatic LRU eviction uses the same pattern in `#evictIdle()` at line 793 through line 804:
  `closeOnce()` failures are ignored before the resident is removed and the durable thread becomes
  unloaded. The scheduler has already assigned the freed slot to the replacement before this path
  runs.
- Once removed, the failed handle is absent from `#pool`; later `supervisor.close()` cannot retry or
  await it. A follow-up reload can create a second runtime for the same child session while the
  original handle still owns resources.
- Controlled reproduction uses a first idle handle whose `close()` rejects and forces LRU eviction
  by starting a second child with the real SQLite stores. After a subsequent supervisor close, the
  output is
  `{ "firstCloseCalls": 1, "firstResourceOpen": true, "secondCloseCalls": 1, "firstThread": "unloaded", "secondThread": "unloaded" }`.
- Failure mode: an idle child can silently survive eviction while the scheduler treats its slot as
  free. Subsequent subagents may exceed intended process/Worker limits, and the orphaned runtime is
  no longer reachable for shutdown, interruption, or diagnostic reporting.

### Bug 70: runtime-factory fallback leaks capacity when failure finalization fails

- When `AgentSupervisor.spawn()` cannot create a child runtime, it delegates to `#failSpawn()` at
  `backend/packages/runtime/src/agent-supervisor.ts:308` through line 325. That fallback reserves
  no resident, but `#failSpawn()` still calls `taskStore.markRunning()`, thread transition, task
  failure, and terminal thread transition serially at line 770 through line 790 before it finally
  releases the scheduler slot.
- There is no `try`/`finally` or compensating branch around those four durable writes. A failure in
  the first `markRunning()` escapes from `spawn()`, leaves the just-reserved task and thread both
  `queued`, and skips `#scheduler.release()` entirely. This is distinct from bug 59: that path
  already has a successfully created runtime resident; this one has no runtime to reclaim.
- Controlled reproduction uses real SQLite repositories, forces only `runtimeFactory.create()` and
  the fallback `taskStore.markRunning()` to fail, then attempts a second spawn with two total slots
  (root plus one child). Current output is
  `{ "firstError": "injected markRunning failure", "firstThread": "queued", "firstTask": "queued", "replacementStatus": "failed", "replacementError": "agent_capacity_exhausted: resident agent limit 2 reached" }`.
- Failure mode: a routine child-runtime creation failure can turn into a raw storage error and make
  every later child spawn fail for the lifetime of the process, even though no child runtime exists
  and the durable task remains only queued.

### Bug 71: idle teardown can race a follow-up and lose runtime ownership

- `AgentSupervisor.unload()` checks that the durable thread is `idle`, then awaits
  `resident.closeOnce()` before it removes the resident or transitions the thread at
  `backend/packages/runtime/src/agent-supervisor.ts:453` through line 464. It does not reserve a
  teardown state or revalidate the thread after the await.
- During that await, `followUp()` can observe the same resident as `idle` at line 425 through line
  450. `#startResidentFollowUp()` then reserves a new task, transitions that thread to `running`,
  and starts `runMailbox()` at line 726 through line 764. When `unload()` resumes, it removes the
  now-running resident and releases its scheduler slot before its stale `unloaded` transition
  rejects. The running handle is no longer reachable through the pool.
- `#evictIdle()` has the same unfenced await and stale cleanup sequence at line 794 through line
  804. This makes the race reachable through ordinary concurrent `spawn_agent` and
  `followup_task` calls under resident-capacity pressure, without injecting a storage fault.
- Controlled reproduction used a real SQLite store, one child slot, a deferred first-child close,
  and concurrent replacement spawn plus follow-up. Current output is
  `{ "followUpAccepted": true, "secondStatus": "failed", "taskRows": [{ "id": "task-3", "status": "running", "child": "child-1" }], "threadRows": [{ "id": "child-1", "status": "running" }], "replacementStatus": "failed", "replacementError": "agent_capacity_exhausted: resident agent limit 2 reached" }`.
- Failure mode: a parent receives a successful follow-up acknowledgement, but its child has been
  removed from supervisor ownership while still running. The capacity-triggering spawn fails and
  later spawns remain capacity-blocked even after the child work completes, so the process can no
  longer start background agents until restart.

### Bug 72: recovered mailbox projection does not re-trigger a follow-up

- `AgentMailbox.send()` first persists the mailbox item, then projects it into the receiver's
  queue at `backend/packages/runtime/src/agent-mailbox.ts:95` through line 135. If projection
  throws after persistence, the item remains durable in `pending` state and the original tool call
  fails.
- Replaying the same logical call ID deliberately returns the existing item as `duplicate`, but
  still retries `#project()` at line 135. When that retry succeeds, the message becomes `queued`;
  the follow-up wakeup at line 136 through line 138 is skipped because it runs only when
  `result.disposition === "enqueued"`.
- The normal recovery path has the same omission: `repair()` projects pending records at line 192
  through line 229 but never calls `triggerReceiver`. In production that callback is the only
  bridge to `AgentSupervisor.followUp()` at
  `backend/apps/mycli/src/node-runtime/node-backend.ts:546` through line 552.
- Controlled reproduction uses a real SQLite mailbox store and makes only the first receiver-queue
  snapshot save fail. Replaying the exact same logical call produces
  `{ "firstError": "injected queue projection failure", "beforeRetry": ["pending"], "retried": { "disposition": "duplicate", "projected": true, "state": "queued" }, "triggered": [], "queuedCount": 1 }`.
- Failure mode: a retry-safe `followup_task` can report normal duplicate delivery after a transient
  queue persistence/projection failure, while the child remains idle and never consumes the
  recovered message. The durable mailbox and child queue then disagree with the actual execution
  state until unrelated work happens to wake that child.

### Bug 73: concurrent unloaded-child reloads are not serialized

- `AgentSupervisor.followUp()` observes an unloaded child and independently calls
  `#loadResident()` at `backend/packages/runtime/src/agent-supervisor.ts:425` through line 450.
  There is no per-thread load promise, pool reservation, or durable compare-and-set around that
  path.
- `AgentScheduler.reserve()` treats a second reservation for the same thread ID as successful, so
  two callers can both create a runtime handle at line 671 through line 703. The first inserts its
  resident and starts its mailbox task. The second then transitions the durable thread to `idle`
  at line 704 through line 723 even if the first has already marked it `running`, because that
  backward transition is legal in the generic state machine; only `#pool.add()` finally rejects
  with `agent_runtime_already_resident`.
- The losing handle is never closed or otherwise retained. It was not added to the pool, and the
  error escapes before either cleanup path runs. In the Node backend this can also overwrite the
  per-child runtime registration created by the second factory call.
- Controlled reproduction starts an idle child, unloads it, concurrently issues two follow-ups,
  and controls both real reload factories. Current output is
  `{ "results": [true, "agent_runtime_already_resident"], "before": { "thread": "idle", "taskRows": [{ "id": "task-2", "status": "running" }], "closed": [1] }, "after": { "closed": [1, 2] } }`.
  Handle `3`, created by the losing reload, is absent even after `supervisor.close()`.
- Failure mode: parallel `followup_task` delivery can expose a raw runtime error for one parent
  call while the other child task is still running but reported as idle. The extra runtime remains
  outside interruption and shutdown ownership, and later coordination can make decisions from the
  false idle status.

### Bug 74: mailbox delivery to terminal children becomes a successful dead letter

- `AgentMailbox.resolveTarget()` verifies only tree membership and path identity at
  `backend/packages/runtime/src/agent-mailbox.ts:147` through line 190. It accepts `completed`,
  `failed`, and ordinary `interrupted` thread records as message receivers.
- With no loaded runtime for that terminal receiver, `#project()` returns `false` at line 256
  through line 278, but `send()` still returns the durable `enqueued` result at line 135 through
  line 144. `SendAgentMessageTool` always renders that result as successful at
  `backend/packages/integrations/src/subagents/coordination-tools.ts:162` through line 183.
  This affects both `send_message` and `followup_task`: the latter calls `triggerReceiver`, but
  the production callback discards `AgentSupervisor.followUp()`'s `false` result at
  `backend/apps/mycli/src/node-runtime/node-backend.ts:546` through line 552.
- The record cannot later become executable: `AgentSupervisor.followUp()` reloads only `idle`,
  `unloaded`, or explicitly restart-recoverable interrupted threads at
  `backend/packages/runtime/src/agent-supervisor.ts:425` through line 450. An ordinary failed
  child is outside all of those states, so neither mailbox repair nor a later follow-up can
  consume it.
- Controlled reproduction first runs a real child to ordinary `failed` task/thread state, then
  sends a follow-up mailbox message. Current output is
  `{ "threadStatus": "failed", "taskStatus": "failed", "sent": { "disposition": "enqueued", "projected": false, "state": "pending" }, "triggerResults": [false] }`.
- Failure mode: a parent can receive a successful `send_message` or `followup_task` result for a
  child reported by `list_agents`, assume the instruction is durable, and continue or finish work.
  The message is a permanent dead letter unless the database is manually repaired; no child can
  ever see it.

## Not Yet Counted

Runtime event fencing remains a candidate issue, not a confirmed defect:

- `isTurnOwnershipEvent()` at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:5186` adds ownership metadata only to
  `turn.started`, terminal/status events, and not to all message, reasoning, tool, plan, retry, or
  compaction events.
- The TUI reducers for those running events do not uniformly validate session generation and turn
  identity.
- Current active-turn checks and FIFO delivery may still prevent cross-session projection on the
  ordinary path. This item must not increase the confirmed count until a concrete stale-event path
  or controlled reproduction is established.

## Follow-up Triage

- Keep the identifiers stable; do not renumber after fixes.
- Add `open`, `in_progress`, `fixed`, and `verified` status fields when remediation begins.
- Give bugs 35 and 36 controlled race/failure tests before changing production behavior.
- Audit approval continuation durability next, using bug 36 as the comparison case.
- Audit `AgentInteractiveRequestBroker` cleanup across response, abort, session switch, and gateway
  close before counting another defect.
