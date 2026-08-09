## ADDED Requirements

### Requirement: Least-authority spawn inheritance
The system SHALL freeze the child execution policy at spawn and SHALL compute effective authority as an intersection of parent authority, platform policy, and explicit spawn restrictions.

#### Scenario: Full-access parent spawns default child
- **WHEN** a full-access parent spawns a child without an explicit narrower restriction
- **THEN** the child inherits the same non-prompting full-access execution policy and does not fall back to an approval-required default

#### Scenario: Restricted parent requests broader child
- **WHEN** a restricted parent requests tools, filesystem access, network access, or approval behavior broader than the parent owns
- **THEN** the spawn is rejected or the requested authority is narrowed, and the child never receives the broader authority

### Requirement: Frozen workspace and environment context
The child spawn snapshot SHALL include workspace root, cwd, selected environment variables, runtime sandbox, network policy, approval policy, and provider/model configuration required to reproduce its execution context.

#### Scenario: Ambient process defaults change
- **WHEN** ambient configuration changes after a child has been spawned and later reloaded
- **THEN** the child reloads with its frozen spawn context unless an explicit authorized reconfiguration is performed

### Requirement: Layered child instructions
Project instructions and the generic subagent instruction SHALL be applied through system or developer instruction layers with stable precedence, and SHALL NOT be concatenated into the user's task text.

#### Scenario: Parent assigns child work
- **WHEN** the parent supplies a task through `message` or the compatibility `prompt`
- **THEN** the provider receives the generic child instruction as a higher-precedence layer while preserving the parent task as user-authored content

### Requirement: Atomic capacity and depth enforcement
The scheduler SHALL atomically reserve resident capacity before creating an agent, SHALL count root against the configured total, and SHALL enforce configured nesting depth before persisting a spawn edge.

#### Scenario: Concurrent spawns at capacity
- **WHEN** concurrent requests compete for the final resident slot
- **THEN** at most one request reserves the slot and rejected requests leave no partial agent records

#### Scenario: Spawn exceeds nesting depth
- **WHEN** an agent attempts to spawn below the configured maximum depth
- **THEN** the request returns a typed depth-limit result without creating a child

### Requirement: Boundary-enforced optional budgets
Configured turn, tool-call, token, no-progress, and wall-clock budgets SHALL be enforced by supervisor and runtime counters at their actual boundaries; an omitted budget SHALL impose no corresponding limit.

#### Scenario: Configured tool budget is exhausted
- **WHEN** a child reaches its configured maximum number of tool calls
- **THEN** no additional tool call is dispatched and the child ends with a typed budget-exhausted outcome

#### Scenario: Runtime omits turn budget
- **WHEN** a child spawn configuration does not define `maxTurns`
- **THEN** the runtime does not apply an implicit turn limit solely because the caller is a subagent

### Requirement: Real interrupt and close semantics
Interrupting an agent SHALL abort its active provider request, tool wait, mailbox wait, and cancellable tool execution, and closing an agent SHALL release runtime resources without deleting durable history.

#### Scenario: Parent interrupts running child
- **WHEN** an authorized parent calls `interrupt_agent` for a running child
- **THEN** the active child turn receives cancellation, transitions once to interrupted, releases its resident slot, and remains durably inspectable

### Requirement: Controlled recursive spawning
Nested spawning SHALL be governed by the same authority, capacity, and depth rules rather than by an unconditional global child-tool denylist.

#### Scenario: Nested spawn is allowed by configuration
- **WHEN** a child has the coordination tool scope and has not reached the configured depth or capacity limit
- **THEN** it can spawn a canonical descendant whose authority is no broader than its own
