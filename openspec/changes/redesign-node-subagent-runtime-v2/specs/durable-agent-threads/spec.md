## ADDED Requirements

### Requirement: Durable agent identity and topology
The system SHALL assign every agent an immutable thread ID and canonical agent path, and SHALL durably record its root, parent, and spawn edge independently from display metadata.

#### Scenario: Child receives canonical identity
- **WHEN** a parent successfully spawns a child named `tests`
- **THEN** the child is durably addressable by a canonical path derived from its parent, such as `/root/tests`, even after the process restarts

#### Scenario: Duplicate sibling name is rejected atomically
- **WHEN** two concurrent spawn requests reserve the same canonical child path under one parent
- **THEN** exactly one request succeeds and no partial duplicate thread or spawn edge remains

### Requirement: Independent durable thread state
Each child agent SHALL use an independent session history, provider continuation state, transcript, event stream, cancellation boundary, task projection, and subagent projection.

#### Scenario: Child activity does not mutate parent history
- **WHEN** a child executes provider turns and tools
- **THEN** those conversation items are committed only to the child thread, except for explicitly delivered inter-agent communications and lifecycle projections

### Requirement: Explicit context forking
The system SHALL support `fork_turns` values `none`, `all`, and a positive integer string, SHALL fork only committed and shareable conversation items, and SHALL default to `none` when the value is omitted.

#### Scenario: Spawn without context fork
- **WHEN** a child is spawned without `fork_turns`
- **THEN** the child starts without copied parent conversation and receives the spawn task as its first independent communication

#### Scenario: Spawn with last-N context
- **WHEN** a child is spawned with `fork_turns` set to `3`
- **THEN** the child receives at most the latest three committed parent turns and no pending inputs, internal notifications, or provider continuation identifiers

### Requirement: Supervised lifecycle transitions
Only the agent supervisor SHALL mutate agent lifecycle state, and every transition SHALL conform to the declared lifecycle state machine.

#### Scenario: Terminal agent cannot restart implicitly
- **WHEN** an agent is completed, failed, or interrupted and a queue-only message arrives
- **THEN** its terminal status remains unchanged and no runtime starts implicitly

#### Scenario: Idle agent can unload and reload
- **WHEN** an idle agent is unloaded to free resident capacity and later receives a valid follow-up task
- **THEN** the supervisor reloads the agent from its durable history and frozen spawn configuration before starting the new turn

### Requirement: Restart recovery without unsafe replay
The system SHALL recover idle and unloaded agents after restart and SHALL NOT automatically replay an uncommitted tool call or mutation from a stale running lease.

#### Scenario: Restart with idle child
- **WHEN** mycli restarts while a child is idle with committed history
- **THEN** the child remains discoverable and can be reloaded for a follow-up task

#### Scenario: Restart during uncommitted mutation
- **WHEN** mycli restarts while a child has an uncommitted mutating tool call
- **THEN** the child becomes interrupted with a recoverable reason and the mutation is not automatically executed again

### Requirement: Backward-readable task migration
The system SHALL preserve existing terminal subagent task records and SHALL project them into the new agent topology without claiming that an active runtime can be recovered when no durable thread exists.

#### Scenario: Existing completed task is loaded
- **WHEN** a session containing a legacy completed subagent task is opened after migration
- **THEN** its status and report remain available through agent listing and compatibility output routes
