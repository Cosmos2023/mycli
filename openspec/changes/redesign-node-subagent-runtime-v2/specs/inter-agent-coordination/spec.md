## ADDED Requirements

### Requirement: Codex-compatible coordination tools
The provider-visible tool surface SHALL include `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `list_agents` with validated, typed arguments and results.

#### Scenario: Invalid target is rejected
- **WHEN** a coordination tool names an unknown agent path or an agent outside the caller's root tree
- **THEN** the tool returns a typed not-found or forbidden result without creating mailbox or lifecycle records

### Requirement: Distinct queue and trigger delivery
`send_message` SHALL enqueue communication without starting a turn, while `followup_task` SHALL enqueue communication and trigger a receiver turn when the receiver is eligible to run.

#### Scenario: Queue-only message reaches running child
- **WHEN** a parent calls `send_message` for a running child
- **THEN** the message is ordered in the child mailbox and no additional concurrent child turn is started

#### Scenario: Follow-up reloads idle child
- **WHEN** a parent calls `followup_task` for an idle or unloaded child
- **THEN** the message is durably enqueued and the supervisor loads and starts exactly one receiver turn

### Requirement: Durable ordered idempotent mailbox
Inter-agent communication SHALL be durably ordered per receiver and SHALL use deterministic identities or equivalent deduplication so the same logical message is committed at most once.

#### Scenario: Receiver is unloaded during delivery
- **WHEN** a valid message is sent to an unloaded child
- **THEN** the message remains ordered and durable until the child is loaded and consumes it

#### Scenario: Delivery repair runs twice
- **WHEN** restart recovery attempts to repair the same completion message more than once
- **THEN** only one logical mailbox item is available to the receiver

### Requirement: Automatic terminal notification
The system SHALL automatically send each child terminal status and bounded final report to its parent exactly once without requiring `SubagentOutput` polling.

#### Scenario: Background child completes
- **WHEN** a background child commits its completed state and final report
- **THEN** a typed completion communication is durably available to the parent before the next provider step or subsequent turn

### Requirement: Event-driven waiting
`wait_agent` SHALL wait on mailbox, lifecycle, and user-steering activity using a bounded abortable subscription and SHALL NOT poll task output or create sleeping shell commands.

#### Scenario: Activity already pending
- **WHEN** `wait_agent` starts while matching mailbox or steering activity is already pending
- **THEN** it returns immediately with the wake reason

#### Scenario: Wait is cancelled
- **WHEN** the caller's abort signal fires during `wait_agent`
- **THEN** the wait terminates promptly and releases its subscription

### Requirement: Canonical target routing
Coordination tools SHALL accept canonical agent paths and permitted task-name aliases, SHALL resolve them to immutable thread IDs, and SHALL restrict routing to the caller's root agent tree.

#### Scenario: Sibling sends a message
- **WHEN** an agent targets a sibling by an unambiguous canonical path within the same root tree
- **THEN** the mailbox records the real sender and receiver paths and delivers the message according to the selected trigger mode

### Requirement: Single canonical spawning tool
`spawn_agent` SHALL be the only provider-visible child-spawn tool, while `Task`, legacy `SendMessage`, and `SubagentOutput` routes SHALL be absent from new runtime composition and provider definitions.

#### Scenario: New provider request inspects coordination schemas
- **WHEN** a provider request is built for the Node runtime
- **THEN** it exposes prompt-driven `spawn_agent` with no `profile` property and does not expose `Task`, `SendMessage`, or `SubagentOutput`

### Requirement: Interactive child requests are non-terminal
A child agent that requests approval or user input SHALL remain active, SHALL expose the pending request with its child session identity, and SHALL resume the same child runtime after the response.

#### Scenario: Child command waits for approval
- **WHEN** a running child requests command approval
- **THEN** its thread transitions to `waiting`, its task remains running, no terminal parent mailbox item is emitted, and an approval response resumes the suspended child turn
