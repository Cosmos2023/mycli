## ADDED Requirements

### Requirement: Versioned bounded Worker protocol
Every Coordinator-Agent Worker message SHALL use a versioned discriminated schema with bounded payloads and SHALL reject unknown versions, kinds, malformed identities, and oversized data before processing side effects.

#### Scenario: Unknown message version arrives
- **WHEN** a Worker sends a message with an unsupported protocol version
- **THEN** the coordinator rejects the message, records a redacted protocol diagnostic, fences the lease, and produces no durable or external effect from that message

### Requirement: Compound lease fencing
Every job message SHALL identify coordinator epoch, Worker identity and generation, lease and job identity, session and turn identity, timeline window and version, and monotonic per-job sequence; the coordinator SHALL validate the complete active fence before accepting the message.

#### Scenario: Terminated Worker sends a late result
- **WHEN** a message arrives with a stale Worker generation or released lease after targeted termination
- **THEN** the coordinator ignores or rejects it without appending conversation, completing a tool, replacing a terminal turn, or publishing model-visible output

#### Scenario: Prior job message arrives after Worker reuse
- **WHEN** a Worker has a new lease and receives or emits a message carrying the previous job or lease identity
- **THEN** the message is rejected even if session, turn, sequence, or visible content otherwise appears valid

### Requirement: ABA-safe timeline concurrency
Timeline versions SHALL be monotonic within an immutable timeline window identity, reset or compaction SHALL create a distinct window identity, and content hashes SHALL supplement rather than replace identity and version checks.

#### Scenario: Context returns to equivalent visible content
- **WHEN** durable timeline state changes from A to B and later produces content equivalent to A
- **THEN** the later state has a different version or window identity and a Worker based on the original A cannot commit against it

#### Scenario: Compaction replaces the timeline window
- **WHEN** compaction installs a new provider-visible window
- **THEN** the coordinator issues a new timeline window identity, the Worker discards its old working set, and messages based on the previous window are rejected

### Requirement: Strict per-job message sequencing
Each lease SHALL begin with a defined sequence origin and SHALL accept only the next expected sequence for effect-producing messages, with duplicate read-only acknowledgements handled idempotently where explicitly supported.

#### Scenario: Messages arrive out of order
- **WHEN** sequence 12 arrives while sequence 11 is required
- **THEN** the coordinator produces no side effect for sequence 12 and resynchronizes or terminates the lease according to protocol policy

#### Scenario: Effect request is duplicated
- **WHEN** the same effect-producing message identity and sequence is delivered twice
- **THEN** the coordinator returns the previously committed outcome or rejects the duplicate and does not execute the effect twice

### Requirement: Coordinator-exclusive durability and effects
Agent Workers SHALL NOT directly mutate SQLite, session state, approvals, mailboxes, artifacts, gateway state, or external tool processes; all such operations SHALL be requested through the coordinator broker.

#### Scenario: Worker requests a shell command
- **WHEN** an Agent Worker proposes a shell tool call
- **THEN** the coordinator evaluates policy and approval, persists the tool lifecycle, owns the process tree, and returns only the committed bounded result to the Worker

#### Scenario: Worker requests an approval
- **WHEN** a proposed tool call requires user approval
- **THEN** the coordinator owns the pending approval identity and TUI routing and resumes only the matching active lease after a valid response

### Requirement: Durable model input precedes provider dispatch
The coordinator SHALL atomically commit the canonical instruction/tool snapshots, timeline events, request manifest, logical request, and prepared lifecycle event before the Agent Worker dispatches the corresponding provider request.

#### Scenario: Commit succeeds
- **WHEN** the Worker proposes a provider step based on the current timeline and its logical hash matches the coordinator's canonical input
- **THEN** the coordinator returns the committed request identity, advanced timeline version, and logical hash, after which the Worker may dispatch the provider request

#### Scenario: Commit or hash validation fails
- **WHEN** persistence fails, the base timeline is stale, the lease fence is invalid, or logical hashes disagree
- **THEN** the Worker does not issue the provider request and the turn follows a typed conflict, protocol, or persistence outcome

### Requirement: Safe optimistic resynchronization
The coordinator SHALL resynchronize a Worker from committed state only before an ambiguous external action and SHALL NOT blindly replay provider requests or mutating tools after a conflict or crash.

#### Scenario: Steering advances the timeline before provider dispatch
- **WHEN** a steering item is committed after Worker bootstrap but before its next provider proposal
- **THEN** the stale proposal is rejected and the Worker receives the committed delta or replacement window before recomputing the next step

#### Scenario: Mutating tool outcome is unprovable
- **WHEN** a Worker or coordinator interruption prevents the system from proving whether a started mutating tool completed
- **THEN** the tool terminalizes exactly once as `effect_outcome_unknown` and is not automatically replayed

### Requirement: Idempotent provider and tool attempt identities
Every provider dispatch and external tool attempt SHALL use a coordinator-issued durable unique identity in addition to provider or model call identifiers.

#### Scenario: Completion acknowledgement is retried
- **WHEN** a Worker retries acknowledgement for an already terminal provider or tool attempt
- **THEN** the coordinator returns or confirms the committed terminal state without appending another terminal event

### Requirement: Terminal persistence precedes publication
The coordinator SHALL persist tool terminal states and the turn terminal state before publishing the terminal gateway, parent-mailbox, or Agent lifecycle event.

#### Scenario: Child turn completes
- **WHEN** a child Agent Worker reports successful completion
- **THEN** the coordinator validates the lease, persists terminal usage and turn state, releases the lease, and only then publishes the parent-visible bounded report
