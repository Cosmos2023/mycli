## ADDED Requirements

### Requirement: Node sessions expose compatible readable artifacts
The Node runtime SHALL project readable session artifacts beneath
`~/.mycli/sessions/<session-id>/` while retaining SQLite as the canonical session store.

#### Scenario: A Node turn reaches a terminal state
- **WHEN** a Node turn completes, fails, or is interrupted after durable state is committed
- **THEN** the session directory SHALL contain an updated `session.json` and a complete
  `conversation.saved` row in `events.jsonl`

#### Scenario: Existing Python session artifacts are present
- **WHEN** Node prepares or updates a session directory that already contains compatible artifact
  files
- **THEN** it SHALL preserve unrelated existing files and SHALL NOT require those files for normal
  provider recovery

### Requirement: Task outputs are readable files
The Node runtime SHALL project retained terminal background task output to
`tasks/<safe-task-id>/output.txt` beneath the owning parent session.

#### Scenario: A background subagent terminates
- **WHEN** a background subagent completes, fails, or is interrupted
- **THEN** its bounded report or terminal error SHALL be atomically written to the parent session's
  task output path before its automatic terminal notification is queued

#### Scenario: A background shell terminates
- **WHEN** a background Shell session reaches its completed lifecycle event
- **THEN** its retained accumulated output SHALL be atomically written to the owner session's task
  output path

#### Scenario: A foreground shell terminates
- **WHEN** a non-background Shell command completes
- **THEN** the compatibility projector SHALL NOT create a background task output directory for it

### Requirement: Parent sessions expose subagent snapshots
The Node runtime SHALL project each durable subagent task into a deterministic JSON snapshot under
the parent session and SHALL expose a bounded index in the parent `session.json`.

#### Scenario: A subagent lifecycle update is persisted
- **WHEN** a queued subagent becomes running or reaches a terminal state
- **THEN** Node SHALL atomically write `subagents/<deterministic-run-id>.json`, refresh the parent
  `session.json` subagent index, and append a `subagent.updated` event

#### Scenario: A child has canonical history
- **WHEN** a subagent snapshot is written and the child session has canonical history items
- **THEN** the snapshot SHALL include those items as its readable `messages` collection and SHALL
  include parent, child, profile, status, timing, description, mode, and report metadata when present

#### Scenario: Session preparation finds missing files
- **WHEN** durable subagent task rows exist but their task output or subagent snapshot files are
  missing
- **THEN** session preparation SHALL reconstruct the missing projections from the task rows and
  child history before returning the writable prepared session

### Requirement: Artifact paths and writes are safe
Session artifact projection SHALL validate storage identities, use private bounded writes, and keep
auxiliary projection failures from corrupting canonical runtime state.

#### Scenario: An artifact identity attempts path traversal
- **WHEN** a session or task identity is blank, path-like, or traversal-like
- **THEN** projection SHALL reject it before creating or modifying a file outside the session root

#### Scenario: Atomic replacement fails
- **WHEN** task-output or subagent-snapshot replacement fails before rename
- **THEN** the previous complete target SHALL remain intact and temporary files SHALL be cleaned up

#### Scenario: Auxiliary projection fails after SQLite commit
- **WHEN** an event, task-output, or subagent file cannot be written after canonical state is durable
- **THEN** the canonical turn or task state SHALL remain committed and later session preparation
  SHALL be able to retry derivable projections

### Requirement: Snapshot metadata remains safe for degraded recovery
Node schema-v2 transcript snapshots SHALL accept and preserve validated optional subagent index and
event-link metadata without preserving unknown or malformed private fields.

#### Scenario: A valid enriched snapshot is loaded without SQLite
- **WHEN** SQLite is unavailable and a valid schema-v2 snapshot contains `subagents` and
  `links.events`
- **THEN** degraded read-only loading SHALL retain the validated metadata and sanitized transcript

#### Scenario: Enriched metadata is malformed
- **WHEN** a schema-v2 snapshot contains malformed subagent index or event-link values
- **THEN** the snapshot SHALL be treated as invalid rather than exposing unchecked metadata
