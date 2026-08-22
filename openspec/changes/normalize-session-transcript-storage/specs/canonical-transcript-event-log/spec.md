## ADDED Requirements

### Requirement: One append-only log is the canonical transcript truth
The session store SHALL persist each semantic user, assistant, tool, context, lifecycle, and compaction event once in a typed append-only transcript log with a stable event id, session id, turn association, event type, and deterministic order.

#### Scenario: A normal turn writes one canonical sequence
- **WHEN** a user turn records user input, assistant output, tool activity, and terminal status
- **THEN** each semantic event is appended once to the canonical log and no second conversation, history, or rollout payload copy is written

#### Scenario: Tool payloads are stored once
- **WHEN** an assistant emits a multi-call tool batch and the tools return large outputs
- **THEN** each argument object and full tool output is stored once while provider and readable projections reference the same canonical event

#### Scenario: Display-only activity remains durable
- **WHEN** reasoning, plans, approval status, shell state, warnings, or other non-provider activity is recorded
- **THEN** it is appended as a typed event that is available to readable transcript projection without entering provider input unless its contract explicitly marks it model-visible

### Requirement: Provider, display, search, and artifact views are deterministic projections
The system SHALL derive provider input, `/resume` state, complete readable transcript pages, local search, and session artifacts from the canonical log without persisting independent full transcript copies.

#### Scenario: Provider projection preserves exact protocol semantics
- **WHEN** provider input is reconstructed from user messages, images, assistant text, multi-call tool batches, tool results, context items, and provider continuation metadata
- **THEN** ordering, grouping, identities, full model-visible content, and protocol state are equivalent to the pre-normalization provider projection

#### Scenario: Readable transcript preserves complete visible history
- **WHEN** a session contains provider-visible items plus reasoning, plans, approvals, clarifications, shell activity, and tool lifecycle metadata
- **THEN** paginated readable projection returns the same visible items and metadata in the same order while keeping model-only and hidden events filtered

#### Scenario: Search uses an external-content event projection
- **WHEN** canonical searchable events are inserted and a user runs session search
- **THEN** an external-content FTS projection returns equivalent bounded results without storing a second searchable content copy

#### Scenario: Regenerable artifacts remain projections
- **WHEN** `session.json`, task output, subagent snapshots, or transcript pages are rebuilt
- **THEN** they are derived from the canonical log and never become provider or recovery truth

### Requirement: Compaction and lineage use stable event boundaries
The canonical log SHALL represent compaction, rollback, and fork boundaries with stable event identities and SHALL reconstruct active provider context from the newest surviving replacement plus only its surviving suffix.

#### Scenario: Hundreds of compactions remain bounded on resume
- **WHEN** a session has hundreds of completed compaction events
- **THEN** resume locates the newest valid surviving replacement with an indexed reverse lookup and does not stack or eagerly materialize older replacement histories into provider input

#### Scenario: Complete display history survives compaction
- **WHEN** provider history has been compacted one or more times
- **THEN** readable transcript pagination can still reach visible turns on both sides of every compaction while compaction payloads remain hidden from display

#### Scenario: Fork preserves the selected canonical prefix
- **WHEN** a child session is forked from a parent event boundary
- **THEN** the child resolves exactly the selected shareable provider and display prefix without duplicating a later parent suffix or splitting a tool lifecycle

#### Scenario: Rollback removes only surviving turn segments
- **WHEN** a rollback marker removes one or more recent user turns
- **THEN** reconstruction excludes those complete turn segments while retaining older compacted history and unrelated display events

### Requirement: Legacy normalization is resumable and cuts over atomically
The v9-to-normalized migration SHALL stage deterministic canonical events without changing v9 read truth, SHALL be restartable and idempotent, and SHALL switch schema ownership only in a final atomic cutover after projection equivalence is proven.

#### Scenario: Existing v9 storage remains usable before cutover
- **WHEN** the new binary opens a v9 database whose normalization is absent or partially staged
- **THEN** legacy tables remain authoritative, ordinary turns remain compatible, and maintenance reports bounded migration progress and required temporary space

#### Scenario: Interrupted staging resumes safely
- **WHEN** normalization stops after any batch before final cutover
- **THEN** the schema marker and legacy read path remain valid and a later run resumes without duplicate events or skipped legacy rows

#### Scenario: Final cutover rechecks the durable tail
- **WHEN** all staged rows appear complete
- **THEN** the final write transaction reconciles rows appended since the last batch, verifies provider/display/search/lineage/recovery manifests, installs the normalized schema marker, and removes redundant legacy tables only after every check succeeds

#### Scenario: Failed final cutover rolls back
- **WHEN** any equivalence, schema, trigger, or version-marker step fails during final cutover
- **THEN** the transaction rolls back to the legacy-authoritative state and the complete migration can be retried

#### Scenario: An abandoned ambiguous legacy database is not heuristically repaired
- **WHEN** a copied legacy database contains retired sessions whose repeated message or tool identities cannot be reconciled with exact projection parity
- **THEN** cutover fails closed, schema v9 and all source bytes remain authoritative, and fresh v10 storage may be initialized separately without deleting or rewriting the legacy database

#### Scenario: Malformed legacy rows are not discarded
- **WHEN** a legacy conversation, history, or rollout payload cannot be normalized into a current typed event
- **THEN** migration preserves its raw bytes as a bounded opaque legacy event with stable identity, retains the same projection failure classification, and reports the issue without printing its content

### Requirement: Active recovery remains atomic and transcript-referenced
Normalization SHALL preserve active turn, approval, clarification, continuation, effect, and provider-ledger recovery records, while replacing duplicated transcript snapshots in mutable state with stable canonical event references where recovery semantics allow it.

#### Scenario: Pending approval survives cutover
- **WHEN** a session has a pending decision and suspended turn during normalization
- **THEN** cutover either preserves a valid reference to the matching canonical request events or excludes the session from cutover without deleting or auto-resolving the decision

#### Scenario: Pending clarification survives cutover
- **WHEN** a suspended turn contains a pending clarification
- **THEN** its user message, request identity, provider continuation, and canonical transcript boundary remain recoverable after restart

#### Scenario: Provider ledger remains immutable
- **WHEN** transcript normalization migrates a session with committed provider request manifests
- **THEN** model-input blobs, context events, manifests, request identities, and lifecycle rows are byte-for-byte unchanged and still reconstruct the committed requests

### Requirement: Normalized storage remains cross-runtime compatible and observable
The Node and Python storage readers, doctor, maintenance commands, and benchmarks SHALL recognize the normalized schema and report bounded structural diagnostics, migration progress, write amplification, and logical versus physical savings.

#### Scenario: Python reads normalized Node sessions
- **WHEN** Node creates or migrates a normalized session database
- **THEN** the Python compatibility reader can list sessions and reconstruct supported provider/display history without requiring the removed legacy tables

#### Scenario: Older binaries reject the normalized marker
- **WHEN** a binary that supports only schema v9 opens a successfully cut-over database
- **THEN** it fails with bounded expected/actual version diagnostics and performs no writes

#### Scenario: Maintenance distinguishes normalization from vacuum
- **WHEN** transcript normalization deletes redundant logical rows
- **THEN** maintenance reports rows and bytes migrated plus reusable free pages without claiming physical shrinkage until the separate explicit vacuum action completes

#### Scenario: Supported migration and fresh-v10 benchmarks gate release
- **WHEN** normalization is evaluated against the supported migration corpus, fresh v10 storage, a synthetic tool-heavy database, and a copied retired legacy database
- **THEN** supported projections remain exact, synthetic write reduction and fresh-v10 startup/resume meet the documented thresholds, and the retired copied database demonstrates bounded fail-closed behavior without requiring compatibility repair or a successful cutover
