## ADDED Requirements

### Requirement: Space-efficient canonical conversation search
The session store SHALL index canonical conversation payloads with an FTS projection that does not retain a second content copy, SHALL rebuild that projection transactionally when upgrading an older supported schema, and SHALL remove the unused history-item FTS projection.

#### Scenario: Existing database upgrades to external-content search
- **WHEN** a supported pre-change database containing conversation and history rows is opened
- **THEN** the schema upgrade completes atomically, conversation search returns the same matching sessions and messages, and no `history_items_fts` content table remains

#### Scenario: Search projection follows canonical mutations
- **WHEN** a canonical conversation row is inserted, updated, or deleted after migration
- **THEN** subsequent session searches reflect that mutation without returning stale or duplicate rows

#### Scenario: Interrupted schema upgrade is retried
- **WHEN** the FTS rebuild fails before the schema-version write commits
- **THEN** the prior schema remains readable and a later open can retry the complete migration

### Requirement: Dry-run legacy payload accounting
The ordinary session-maintenance report SHALL identify safely compactable legacy rollout and state rows, SHALL report their counts and estimated removable logical bytes, and SHALL not mutate session storage.

#### Scenario: Report includes legacy payload candidates
- **WHEN** terminal legacy rollouts and inactive terminal continuation state exist
- **THEN** `/session maintenance` reports their candidate counts and estimated removable bytes while leaving every payload unchanged

#### Scenario: Active recovery rows are excluded
- **WHEN** a session has an in-progress runtime turn, pending approval, or suspended clarification
- **THEN** its rollout and continuation payloads are excluded from cleanup candidates

#### Scenario: Malformed legacy payload is skipped
- **WHEN** a rollout or state payload is not valid recognized JSON
- **THEN** maintenance does not modify it or count it as safely compactable

### Requirement: Explicit recovery-safe legacy payload compaction
The session store SHALL compact legacy payloads only through an explicit maintenance action, SHALL preserve all canonical transcript and compact records, and SHALL make repeated application idempotent.

#### Scenario: Terminal rollout events are compacted
- **WHEN** `/session maintenance --apply-payloads` processes an eligible terminal rollout
- **THEN** all top-level rollout fields remain unchanged and its event array is replaced by the minimum transcript-equivalent representation

#### Scenario: Approval suppression marker is retained
- **WHEN** an eligible rollout contains an approval-resolution turn item
- **THEN** the compacted rollout retains a minimal approval-resolution marker and readable transcript projection is identical before and after cleanup

#### Scenario: Inactive legacy state is deleted
- **WHEN** an inactive session contains a terminal `turn_record` or legacy `provider_timeline` state row
- **THEN** the explicit action deletes that row without deleting continuation, compact, transcript, summary, or provider-ledger data

#### Scenario: Repeated cleanup is a no-op
- **WHEN** the payload cleanup action is run again after all eligible rows were processed
- **THEN** it reports zero additional rows and zero additional removed payload bytes

### Requirement: Logical and physical savings remain distinct
Maintenance output SHALL distinguish bytes removed from stored payloads from physical database file size, and physical compaction SHALL remain an explicit vacuum operation.

#### Scenario: Payload cleanup precedes vacuum
- **WHEN** legacy payload cleanup succeeds without running vacuum
- **THEN** the result reports payload bytes removed but does not claim the database file was physically reduced

#### Scenario: Vacuum remains separately controlled
- **WHEN** the user chooses to reclaim SQLite free pages after payload cleanup
- **THEN** the existing explicit vacuum action reports database and page metrics before and after physical compaction
