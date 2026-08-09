## ADDED Requirements

### Requirement: Terminal results are delivered automatically
The Node runtime SHALL deliver every terminal background subagent outcome to the owning parent session's provider context without requiring status polling.

#### Scenario: Child completes during the parent turn
- **WHEN** a background child reaches a completed, failed, or interrupted state while its parent turn can continue
- **THEN** the runtime SHALL queue a bounded internal task notification and commit it before the next provider step

#### Scenario: Child completes after the parent turn
- **WHEN** a background child reaches a terminal state after its originating parent turn has ended
- **THEN** the runtime SHALL retain the task notification for delivery in the parent's next turn

### Requirement: Delivery is durable and idempotent
The Node runtime SHALL use durable task state and a deterministic notification identity so each terminal child outcome is delivered to the parent provider context at most once and missing delivery is repaired when the session is prepared.

#### Scenario: Restart after notification enqueue
- **WHEN** the process restarts after a task notification was durably queued but before provider consumption
- **THEN** session recovery SHALL preserve the notification and deliver it once

#### Scenario: Restart before notification enqueue
- **WHEN** the process restarts after terminal task state was persisted but before its notification was queued
- **THEN** session preparation SHALL reconstruct and enqueue the missing notification

#### Scenario: Recovery repeats
- **WHEN** the same terminal task is inspected by multiple recovery passes
- **THEN** the deterministic notification identity SHALL prevent duplicate provider delivery

### Requirement: Parent agents can wait for activity
The Node runtime SHALL expose a model-visible `wait_agent` tool that waits for owner-session activity until activity arrives, the caller aborts, or a bounded timeout expires.

#### Scenario: Activity already exists
- **WHEN** `wait_agent` starts while a matching task notification or user steering message is pending
- **THEN** it SHALL return immediately with an activity-available outcome

#### Scenario: Activity arrives while waiting
- **WHEN** a task notification or user steering message is queued during `wait_agent`
- **THEN** it SHALL wake without waiting for the timeout

#### Scenario: Wait times out
- **WHEN** no matching activity arrives before the requested bounded timeout
- **THEN** `wait_agent` SHALL return a timeout outcome without creating a shell process or polling child status

#### Scenario: Parent turn is cancelled
- **WHEN** the owner turn's abort signal fires during `wait_agent`
- **THEN** the wait SHALL unsubscribe and terminate with the runtime's cancellation behavior

### Requirement: Tool roles are unambiguous
The provider tool set SHALL expose `Task`, `wait_agent`, and `SendMessage` for subagent coordination, SHALL keep `SubagentOutput` hidden but routable for compatibility, and SHALL use `WriteStdin` only for an existing persistent shell session.

#### Scenario: Provider tools are assembled
- **WHEN** a new parent provider request is constructed
- **THEN** it SHALL include `Task`, `wait_agent`, and `SendMessage` and SHALL exclude `SubagentOutput`

#### Scenario: Compatibility output call is resumed
- **WHEN** a stored or explicit compatibility tool call invokes `SubagentOutput`
- **THEN** the tool router SHALL still return the current durable child state or terminal report

#### Scenario: WriteStdin is called without a shell session
- **WHEN** `WriteStdin` receives an unknown or non-shell session identifier
- **THEN** it SHALL fail as shell transport and SHALL NOT wait for a subagent

### Requirement: Internal notifications do not impersonate users
The runtime SHALL provide internal task notifications to the model while excluding them from visible user-message transcript projection, and it SHALL retain normal visible lifecycle rows for all model tool calls.

#### Scenario: Transcript is projected after task delivery
- **WHEN** a committed history item has source `task_notification`
- **THEN** transcript projection SHALL omit it as a user message

#### Scenario: Coordination tools execute
- **WHEN** `Task`, `wait_agent`, `SendMessage`, or a compatibility tool is called
- **THEN** its tool call and result SHALL remain visible through the standard transcript tool projection
