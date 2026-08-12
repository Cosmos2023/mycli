## ADDED Requirements

### Requirement: Bootstrap-plus-delta context delivery
The coordinator SHALL send one committed effective context bootstrap for a Worker lease and SHALL deliver subsequent same-window changes as ordered committed deltas rather than retransmitting the complete stable prefix.

#### Scenario: Tool result advances the same window
- **WHEN** a tool result is committed after Worker bootstrap without replacing the timeline window
- **THEN** the Worker receives the new version and bounded appended items and does not receive another copy of the unchanged conversation prefix

#### Scenario: Delta base is missing or stale
- **WHEN** the Worker cannot apply a delta contiguously to its acknowledged high-water mark
- **THEN** it rejects the delta and requests a committed resynchronization or replacement bootstrap before provider dispatch

### Requirement: Append-only context ownership
SQLite and coordinator state SHALL remain the authoritative source of conversation and model-input truth, while an Agent Worker SHALL retain only the ephemeral working set required by its active lease.

#### Scenario: Worker lease is released
- **WHEN** a turn terminalizes and its Worker returns to the pool
- **THEN** the Worker drops conversation, provider, tool-result, credential, and job-specific references before accepting another lease

#### Scenario: Worker is replaced
- **WHEN** an Agent Worker is terminated or crashes
- **THEN** no canonical context is lost because the replacement bootstraps only from committed coordinator state

### Requirement: Bounded immutable snapshot cache
Workers MAY retain immutable instruction or tool-set blobs across leases only by verified content hash and SHALL enforce configured entry-count and byte-size limits with deterministic eviction; complete conversations SHALL NOT be cached across jobs.

#### Scenario: Snapshot cache reaches its limit
- **WHEN** inserting another immutable snapshot would exceed its entry or byte budget
- **THEN** the Worker evicts eligible least-recently-used entries before accepting the snapshot and never evicts active-lease data

#### Scenario: Hash and content disagree
- **WHEN** a cached blob's recomputed content hash does not match the lease reference
- **THEN** the Worker discards the entry, rejects the bootstrap, and produces no provider request

### Requirement: Full output remains outside Agent Workers
Complete shell, hook, plugin, MCP, file, image, and other large tool outputs SHALL remain in coordinator-owned storage or artifacts, while Agent Workers receive only bounded provider-visible projections and stable references.

#### Scenario: Shell produces oversized output
- **WHEN** a shell command emits output larger than the model-visible limit
- **THEN** the coordinator preserves the complete retrievable artifact and sends the Worker a bounded projection with truncation metadata and an artifact reference

### Requirement: Elastic Worker lifecycle
The pool SHALL create Workers on demand up to configured capacity, SHALL maintain only configured warm idle capacity, and SHALL retire excess Workers after a bounded idle interval.

#### Scenario: Single-agent usage remains idle
- **WHEN** only the root Agent is active and no child work is queued
- **THEN** the pool does not keep the maximum number of fully initialized Workers resident solely because capacity permits them

#### Scenario: Burst workload subsides
- **WHEN** a burst expands the pool and Workers later remain idle beyond the configured timeout
- **THEN** excess idle Workers terminate without changing logical session or mailbox state

### Requirement: Worker resource limits and recycling
Agent Workers SHALL use configured V8 resource limits and SHALL be recycled only while idle after configured job-count, age, large-context, heap-growth, or protocol-health thresholds.

#### Scenario: Worker crosses a soft recycle threshold
- **WHEN** an idle Worker has completed the configured number of jobs or reports excessive retained heap
- **THEN** the pool replaces it before assigning another lease

#### Scenario: Worker reaches a hard V8 limit during a turn
- **WHEN** the Worker terminates because its configured isolate resource limit is exceeded
- **THEN** the coordinator treats it as a fenced Worker failure, applies durable tool/turn recovery, and does not corrupt unrelated leases

### Requirement: Process-wide memory pressure scheduling
The coordinator SHALL apply configured process RSS soft and hard pressure behavior without silently truncating committed provider context.

#### Scenario: RSS crosses the soft threshold
- **WHEN** process RSS crosses the configured soft threshold
- **THEN** the pool retires eligible idle Workers, avoids speculative warming, and queues lower-priority work while preserving active turns

#### Scenario: RSS crosses the hard threshold
- **WHEN** process RSS crosses the configured hard threshold and no safe idle reclamation restores capacity
- **THEN** the pool refuses expansion or new background leases with an explicit capacity outcome instead of deleting model-visible context

### Requirement: Memory observability is redacted and non-model-visible
The system SHALL expose bounded Worker count, lease state, heap, RSS, recycling, and pressure diagnostics for operations and tests, and SHALL exclude credentials, prompts, conversation content, tool output, paths, and session text from those diagnostics and provider context.

#### Scenario: Memory diagnostics are recorded
- **WHEN** profiling or diagnostics are explicitly enabled
- **THEN** the report contains only allowlisted numeric/resource state and opaque identities and never enters the transcript or model input
