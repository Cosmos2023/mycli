## ADDED Requirements

### Requirement: Canonical lifecycle event stream
The supervisor SHALL publish typed, ordered lifecycle and communication events that are sufficient to derive storage, transcript, usage, and TUI projections without direct controller callbacks.

#### Scenario: Child runs to completion
- **WHEN** a child is reserved, started, produces activity, and completes
- **THEN** canonical events identify its immutable thread ID, agent path, parent, timestamps, status transitions, and source tool call

### Requirement: Durable agent listing
`list_agents` SHALL read durable topology and lifecycle state, SHALL include loaded and unloaded agents, and SHALL support filtering by canonical path prefix.

#### Scenario: Process restarts with unloaded descendants
- **WHEN** `list_agents` runs after restart
- **THEN** it returns the root tree and persisted descendant statuses even when no child runtime is resident

### Requirement: Per-agent session artifact parity
Every child SHALL produce the same applicable session, event, task, subagent, transcript, and usage artifacts as a root Node session under its own thread identity.

#### Scenario: Child uses tools and spawns a descendant
- **WHEN** a child executes a provider turn, invokes tools, and spawns an allowed descendant
- **THEN** its artifacts preserve those events under the child session without overwriting or merging them into the parent artifacts

### Requirement: Visible coordination tool lifecycle
All model-visible coordination tool calls and results SHALL render in the transcript, while provider-only mailbox payloads SHALL not be rendered as user-authored messages.

#### Scenario: Completion notification enters provider context
- **WHEN** an automatic child completion notification is consumed by the parent provider
- **THEN** the parent receives the typed communication without a fabricated user message appearing in the transcript

### Requirement: TUI agent lifecycle projection
The TUI SHALL render agent spawn, status, message, wait, interruption, completion, and failure from canonical events and SHALL provide stable agent identity when display nicknames collide or change.

#### Scenario: Multiple children run concurrently
- **WHEN** several children have interleaved lifecycle events
- **THEN** each TUI row is correlated by immutable thread ID and canonical path and updates without duplicating terminal results

### Requirement: Bounded usage and report projection
Usage, progress, and terminal reports SHALL be bounded for UI and mailbox projection while full durable source records remain available through their owning thread artifacts where policy permits.

#### Scenario: Child produces a large final report
- **WHEN** a final report exceeds the provider-notification or TUI projection limit
- **THEN** the projection is deterministically truncated with a durable output reference and usage counters remain attributed to the child
