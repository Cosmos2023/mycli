# Esc Interruption Leaves Root Turn Admission Occupied

## Historical Evidence

Read-only inspection of the reported session found this sequence on 2026-09-07:

| UTC | Durable state |
| --- | --- |
| 05:50:32.267 | The active turn terminalized as interrupted |
| 05:50:32.945 | A new user turn was reserved |
| 05:50:38.794 | Another user turn was reserved |
| 05:50:39.870 | Another user turn was reserved |
| 06:00:01.049-054 | Restart recovery interrupted all three unfinished reservations |

The three new turns had no provider diagnostics or assistant/tool events. The same pattern appeared
after an earlier interruption. This points to failure before ordinary provider execution, separate
from the earlier upstream SSE error. The old gateway discarded the underlying exception, so its
exact historical class cannot be recovered from this session's logs. No user text, credentials,
live process, or canonical session data was copied into a fixture or modified.

## Reproduced Cause

A deterministic root Worker test reproduced `root_agent_runtime_already_running` after successful
forced interruption:

1. The gateway aborts the active turn and escalates after its cooperative grace interval.
2. The root wrapper fences and terminates the Worker and obtains a durable interrupted turn.
3. Its old delegate operation can still be pending. The wrapper previously cleared `#activeRun`
   only in the `finally` attached to that operation.
4. The gateway releases its own execution claim and accepts the next user message. Reservation
   commits before the wrapper notices its old `#activeRun` and throws.
5. The gateway catches that exception as a generic persistence failure. Because execution never
   entered `NodeTurnRuntime.submit`, its normal failure terminalization did not run. Repeating the
   input created more orphan reservations until process restart.

There was a second release gap: a previously published terminal event caused the gateway's
interruption timeout path to skip cleanup, even though the Worker-backed submission had not settled.

## Fix

- Race the owned root submission against its forced durable result. Resolve the forced result only
  after fencing, terminalization/recovery, and Worker termination.
- Clear the exact run's provider executor and ownership before resolving its release promise;
  interruption acknowledgment waits for this release. Late delegate settlement cannot run wrapper
  cleanup again against a successor.
- Keep the gateway cleanup barrier even if the terminal event was already published.
- Recheck cancellation after Worker acquisition, release late leases, and clean up executor setup
  failures through the same owned-run finalizer.
- Terminalize Worker startup failures after reservation through `failReservedTurn`. Cancellation
  stays interrupted, local startup failures use the canonical config-error fallback, and storage
  failures retain their separate classification. Existing terminal records remain authoritative.

The original Worker fix did not change provider retry rules or TUI layout. Retrying a model request cannot repair stale local
runtime ownership, and interruption recovery must not replay already committed tool effects.

## Follow-Up Stabilization

The architecture audit identified additional boundaries beyond Worker cleanup. These are now
implemented in the same worktree: cancelable credential admission; durable completion authority
during delayed snapshots; terminalization of direct and queued setup/publication failures;
transactional compaction checkpoint ownership; shared summary retries with safe durable evidence;
and native control input that bypasses pending ordinary RPCs. An original client identity also
fences retried interruption so a stale request cannot cancel a successor admission.

See `docs/parity/2026-09-07-codex-architecture-audit.md` for the implementation status, validation,
and remaining structural backlog. This does not attribute historical upstream errors to compaction;
the reported session and its historical records were not modified.

## Validation

- The new hard-interruption/immediate-resubmission regression failed on the old implementation with
  `root_agent_runtime_already_running` and passed after the fix.
- Focused tests cover cooperative/hard cancellation, late operation settlement, durable recovery
  after cleanup timeout, canceled lease assignment, and gateway acknowledgment after terminal events.
- SQLite tests verify startup failure/cancellation terminal records survive reopen without exposing
  internal error text or dispatching a provider request.
- A loopback-SSE integration test covers repeated streaming interruption and immediate follow-up,
  including live and reopened attempt history.

All 350 repository test files passed across the completed gate runs, along with build, lint,
typecheck, contract drift, config drift, and whitespace checks. Detailed results and the corrected
integration-test readiness precondition are recorded with the local task. No live provider request
or mutation of the reported session was needed. Existing processes must restart onto the rebuilt
application to use the fix; historical orphan recovery records are preserved.
