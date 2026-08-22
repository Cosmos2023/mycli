## ADDED Requirements

### Requirement: Provider requests are reconstructed from immutable prefixes
The system SHALL reconstruct each committed logical provider request from its immutable compact V3
manifest, provider configuration, instruction snapshot, tool-set snapshot, and exact append-only
timeline prefix without reading a persisted complete request payload.

#### Scenario: Tool step reconstructs exact request
- **WHEN** a tool result appends a new timeline event and the next provider step is committed
- **THEN** reconstruction returns the exact normalized request supplied at commit and its stable hash matches the manifest row

#### Scenario: Older prefix survives later appends
- **WHEN** later provider steps append events to the same timeline window
- **THEN** reconstructing an older manifest uses only its named prefix and returns its original request

#### Scenario: Compaction starts a new window
- **WHEN** compaction or source reset installs a new provider timeline window
- **THEN** reconstruction uses only the manifest's named window and never mixes an earlier window into the request

### Requirement: Full logical requests are not persisted
Schema v12 SHALL retain a stable logical request hash but SHALL NOT persist a complete logical
request blob, content reference, JSON payload, or equivalent per-step snapshot.

#### Scenario: Provider step commits atomically
- **WHEN** a valid V3 provider step is prepared
- **THEN** snapshots, new timeline events, manifest, request hash, and prepared lifecycle state commit atomically without a logical request blob reference

#### Scenario: Tool-heavy history grows by events and manifests
- **WHEN** many provider steps extend a long tool-heavy timeline
- **THEN** storage adds only new timeline/context items, constant-size manifests, hashes, and lifecycle rows rather than another complete request or id/reference prefix per step

### Requirement: Provider manifests are constant-size prefix commitments
Schema v12 SHALL use V3 manifests containing a timeline window, prefix event count, prefix hash, and
request hash, and SHALL NOT repeat complete timeline-event-id or ordered-item-reference arrays.

#### Scenario: Later step extends the same window
- **WHEN** a provider step appends events after a previously committed V3 manifest
- **THEN** the new manifest records the new prefix count and hashes without copying earlier event identities into a per-step array

#### Scenario: Prefix commitment differs
- **WHEN** the selected timeline prefix count, identity hash, or projected timeline hash differs from the V3 manifest
- **THEN** reconstruction fails closed before provider dispatch

### Requirement: Reconstruction fails closed
The ledger SHALL reject provider dispatch or recovery when a snapshot, timeline event, prefix order,
content hash, request hash, session identity, or prepared lifecycle state is missing or inconsistent.

#### Scenario: Timeline prefix is corrupt
- **WHEN** an event inside a committed manifest prefix is missing, reordered, replaced, or belongs to another session or window
- **THEN** reconstruction raises a bounded persistence error and no provider request is dispatched

#### Scenario: Projected request hash differs
- **WHEN** reconstructed request bytes do not match the committed logical request hash
- **THEN** commit or recovery fails without acknowledging or dispatching the provider step

#### Scenario: Unconfirmed step recovers after restart
- **WHEN** a prepared or dispatch-started step is loaded after process restart
- **THEN** the ledger reconstructs its exact request from durable prefixes before applying existing recovery policy

### Requirement: Schema v12 is fresh-only
Production runtime SHALL create schema v12 for an empty database, SHALL accept an existing schema-v12
database, and SHALL fail closed on schema v11 without modifying it or offering automatic migration.

#### Scenario: Empty database starts as v12
- **WHEN** mycli starts with no session database
- **THEN** it creates the complete schema-v12 shape without a logical request blob ownership column

#### Scenario: Existing v11 is rejected
- **WHEN** mycli starts against a schema-v11 database
- **THEN** startup returns bounded expected/actual version diagnostics and performs no schema or data writes

### Requirement: Request parity and storage reduction are measured
The implementation SHALL prove exact request, provider, recovery, and Worker/in-process parity while
eliminating full-request storage growth in a tool-heavy multi-agent workload.

#### Scenario: Multi-agent provider parity
- **WHEN** equivalent root and subagent turns execute through Worker and in-process adapters
- **THEN** reconstructed logical requests, provider wire requests, request hashes, lifecycle states, and terminal effects are identical

#### Scenario: Full-request bytes remain zero
- **WHEN** a fresh-v12 benchmark commits hundreds of growing provider steps
- **THEN** no model-input content blob is owned by a complete logical request and measured growth excludes repeated complete request prefixes
