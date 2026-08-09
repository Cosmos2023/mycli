## 1. Durable Activity Coordination

- [x] 1.1 Add deterministic, idempotent task-notification enqueue support to `QueueCoordinator` with committed-ID protection.
- [x] 1.2 Add abortable bounded queue activity waiting that resolves immediately for existing matching activity and wakes subscribers for new activity.
- [x] 1.3 Add queue coordinator unit tests for notification persistence, duplicate recovery, activity wake, timeout, cancellation, and listener cleanup.

## 2. Subagent Tool Contracts

- [x] 2.1 Implement and export the `wait_agent` tool adapter with timeout validation and owner-session activity delegation.
- [x] 2.2 Add model-visibility metadata to integration registrations, expose `Task`, `wait_agent`, and `SendMessage`, and retain `SubagentOutput` as a hidden router compatibility route.
- [x] 2.3 Update subagent tool descriptions and deny-lists so child agents use the new coordination contract and cannot recursively coordinate.
- [x] 2.4 Add integration tests for `wait_agent`, provider exposure, hidden compatibility routing, and unchanged `WriteStdin` shell-only behavior.

## 3. Runtime Delivery And Recovery

- [x] 3.1 Serialize bounded terminal task records into safe internal task notifications and route live terminal controller updates to the owning session queue.
- [x] 3.2 Repair missing terminal notifications from durable subagent task records whenever a session runtime is prepared.
- [x] 3.3 Add runtime and backend integration tests proving current-turn delivery, next-turn delivery, restart repair, at-most-once provider injection, and wake on user steering.

## 4. Transcript And Documentation

- [x] 4.1 Suppress `task_notification` user-message rows in transcript projection while retaining coordination tool call/result rows.
- [x] 4.2 Update Node runtime documentation to describe automatic completion delivery, `wait_agent`, hidden `SubagentOutput`, and the Shell-only role of `WriteStdin`.
- [x] 4.3 Run focused tests, full Node typecheck/build, and the relevant Node test suite; record any residual gaps.
