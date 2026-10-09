## ADDED Requirements

### Requirement: Dynamic tools SHALL expose stable descriptors
The runtime SHALL represent every dynamic tool with a stable descriptor before the tool becomes callable. The descriptor MUST include a stable tool identity, source metadata, scope metadata, routing identity, input contract, and human-readable display metadata so that runtime, session persistence, and surfaces can all reference the same dynamic tool object within a general agent runtime.

#### Scenario: Runtime-generated tool is declared
- **WHEN** the runtime creates a task-scoped dynamic tool for the current turn
- **THEN** the tool SHALL receive a stable descriptor before exposure
- **AND** the descriptor SHALL include a stable `tool_id`, `route_key`, `scope`, and source metadata

#### Scenario: Capability contributes a dynamic tool
- **WHEN** an active capability contributes an additional dynamic tool
- **THEN** the contributed tool SHALL be normalized into the same descriptor contract as runtime-generated tools
- **AND** the descriptor SHALL preserve which capability or origin produced it

### Requirement: Dynamic tools SHALL follow explicit lifecycle states
The runtime SHALL track dynamic tools through explicit lifecycle states instead of treating them as ephemeral callable definitions only. At minimum, the lifecycle MUST distinguish declaration, exposure, invocation, completion or failure, and expiration so that general agent capabilities can be assembled, executed, and retired in a controlled way.

#### Scenario: Tool is declared but not yet callable
- **WHEN** a dynamic tool descriptor is created before the planner exposes it to the model
- **THEN** the runtime SHALL record the tool in a pre-exposure lifecycle state
- **AND** surfaces SHALL be able to distinguish that the tool exists but is not yet callable

#### Scenario: Tool invocation completes
- **WHEN** the model invokes a dynamic tool and the tool handler returns successfully
- **THEN** the runtime SHALL record an invoked state followed by a completed state for that tool

#### Scenario: Tool expires after its scope ends
- **WHEN** a turn-scoped dynamic tool reaches the end of its valid turn
- **THEN** the runtime SHALL mark the tool as expired
- **AND** the expired tool SHALL no longer be callable in later turns

### Requirement: Dynamic tools SHALL honor declared scope boundaries
The runtime SHALL enforce the declared scope of each dynamic tool. First-party support MUST include turn-scoped and thread-scoped dynamic tools, and the runtime MUST not silently allow a turn-scoped tool to remain callable after its turn ends.

#### Scenario: Turn-scoped tool is unavailable in later turn
- **WHEN** a dynamic tool is declared with turn scope
- **THEN** the tool SHALL be callable only within that turn
- **AND** any later turn SHALL treat the tool as expired unless a new descriptor is declared

#### Scenario: Thread-scoped tool survives across turns
- **WHEN** a dynamic tool is declared with thread scope
- **THEN** the runtime MAY reuse the tool in a later turn within the same thread
- **AND** the tool SHALL retain the same stable identity across turns

### Requirement: Dynamic tool conflicts SHALL be resolved explicitly
The runtime SHALL detect and resolve conflicts between dynamic tools explicitly rather than silently overwriting one tool with another. Conflicts MUST consider stable route identity, name collisions, scope precedence, and source origin.

#### Scenario: Route key collision is detected
- **WHEN** two dynamic tools with different identities attempt to register the same `route_key`
- **THEN** the runtime SHALL record a conflict outcome instead of silently replacing one tool
- **AND** trace or session records SHALL preserve which tools were involved in the conflict

#### Scenario: Turn-scoped tool shadows thread-scoped display name
- **WHEN** a turn-scoped dynamic tool and a thread-scoped dynamic tool share the same display name
- **THEN** the runtime SHALL preserve distinct stable identities for both tools
- **AND** the current turn MAY prioritize the turn-scoped tool for exposure without deleting the thread-scoped tool history

### Requirement: Dynamic tool lifecycle SHALL be visible to runtime surfaces
The runtime SHALL persist dynamic tool descriptors and lifecycle events into turn context, trace, and session history so that users and developers can inspect how dynamic tools entered, changed, and left the runtime as part of a general agent execution flow.

#### Scenario: Trace shows tool declaration and expiration
- **WHEN** a dynamic tool is declared, exposed, and later expired
- **THEN** the trace SHALL include structured events for the declaration, exposure, and expiration lifecycle transitions

#### Scenario: Session replay reconstructs dynamic tool state
- **WHEN** a session containing dynamic tool lifecycle records is replayed or inspected later
- **THEN** the runtime SHALL be able to reconstruct which dynamic tools were active, expired, or conflicted during that session
