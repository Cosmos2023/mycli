## 1. Storage Projection Contracts

- [x] 1.1 Add shared validated session artifact paths and a `SessionArtifactStore` for JSONL events, atomic task output, deterministic subagent snapshots, and index entries.
- [x] 1.2 Add storage unit tests for compatible paths and payloads, traversal rejection, private writes, atomic replacement cleanup, and event rows.
- [x] 1.3 Extend schema-v2 transcript snapshots with validated optional `subagents` and `links.events` metadata plus degraded-load tests.

## 2. Durable Runtime Metadata And Shell Output

- [x] 2.1 Persist backward-compatible bounded subagent mode and description metadata in durable task payloads.
- [x] 2.2 Update subagent controller and storage tests for new task metadata without changing existing task transitions or ownership.
- [x] 2.3 Project retained terminal background Shell output through `ShellLifecycleProjector` and cover success, foreground exclusion, and contained projection failure.

## 3. Backend Wiring And Recovery

- [x] 3.1 Serialize session snapshot/event/subagent projection work in the Node backend and drain it before storage shutdown.
- [x] 3.2 Write and repair subagent JSON/task output artifacts from durable task rows, refresh parent snapshot indexes, and include the output file in automatic notifications.
- [x] 3.3 Add backend integration coverage for parent and child `events.jsonl`, subagent task output, deterministic subagent JSON, parent snapshot index, and restart repair.

## 4. Documentation And Verification

- [x] 4.1 Document SQLite authority and the compatible Node session artifact layout.
- [x] 4.2 Run focused storage/runtime/integration/app tests, full Node build/typecheck/lint/contracts checks, and the complete Node test suite.
