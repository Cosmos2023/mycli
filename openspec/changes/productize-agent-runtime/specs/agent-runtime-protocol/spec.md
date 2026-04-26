## ADDED Requirements

### Requirement: Runtime protocol defines stable turn lifecycle
`mycli` MUST expose an internal runtime protocol that represents a user request as a `thread` containing one or more `turn` objects, and each `turn` MUST have an explicit lifecycle state instead of relying on implicit CLI or provider behavior.

#### Scenario: Turn enters and exits explicit states
- **WHEN** a new user request starts executing
- **THEN** the runtime MUST create a turn record with an explicit status such as `in_progress`, `waiting_approval`, `completed`, `failed`, or `interrupted`

#### Scenario: Turn completion records final status
- **WHEN** a turn stops for any reason
- **THEN** the runtime MUST persist the final turn status and completion timestamp in a form that trace, session storage, and surfaces can read consistently

### Requirement: Runtime protocol defines normalized turn items
`mycli` MUST normalize provider outputs and runtime events into explicit turn item types so that runtime orchestration, CLI rendering, trace logging, and session persistence consume the same item semantics.

#### Scenario: Provider output is normalized before rendering
- **WHEN** a provider returns messages, reasoning, tool calls, tool results, approval requests, warnings, or plan updates
- **THEN** the runtime MUST represent them as normalized turn items before any CLI or persistence layer consumes them

#### Scenario: Surface does not depend on provider wire protocol
- **WHEN** the CLI renders activity or assistant output
- **THEN** it MUST consume normalized turn items instead of provider-specific raw events

### Requirement: Runtime protocol records explicit stop reasons
Every completed or halted turn MUST include a structured `stop_reason` that explains why the runtime stopped instead of continuing execution.

#### Scenario: Turn stops after sufficient evidence
- **WHEN** the runtime decides the current evidence is sufficient to answer the user
- **THEN** the completed turn MUST record `sufficient_evidence` as its stop reason

#### Scenario: Turn stops because execution cannot continue
- **WHEN** the turn halts due to approval gating, runtime failure, model failure, detected loop, or budget exhaustion
- **THEN** the runtime MUST record the corresponding stop reason in trace and persisted turn state

### Requirement: Approval lifecycle is part of the protocol
Approval requests and approval resolutions MUST be represented as formal runtime protocol items and turn states rather than ad hoc runtime flags.

#### Scenario: Turn pauses for approval
- **WHEN** a tool invocation or action requires approval
- **THEN** the runtime MUST emit an approval request item and transition the turn to `waiting_approval`

#### Scenario: Turn resumes after approval resolution
- **WHEN** the user allows or denies the pending approval
- **THEN** the runtime MUST record the approval resolution as a protocol item and continue or terminate the turn according to policy
