## Why

The Node runtime persists canonical session, shell, and subagent state in SQLite but only projects
`session.json` into `~/.mycli/sessions/<session-id>/`. Python-created sessions also expose
`events.jsonl`, `tasks/<task-id>/output.txt`, and `subagents/<run-id>.json`, so Node sessions are
missing readable artifacts used for inspection, compatibility, and task-result discovery.

## What Changes

- Add a Node session-artifact projector for Python-compatible session events, task output files,
  and parent-owned subagent snapshots.
- Project terminal subagent reports to `tasks/<task-id>/output.txt` and reference that file from the
  automatic task notification.
- Project subagent lifecycle state and transcript data to `subagents/<run-id>.json`, and include a
  bounded subagent index in the parent `session.json` snapshot.
- Keep SQLite as the canonical recovery source. Artifact projection is atomic where files are
  replaced, append-only for events, and cannot roll back already committed runtime state.
- Preserve the retained Python implementation and existing Python-created session directories.

## Capabilities

### New Capabilities

- `session-artifact-projection`: Python-compatible readable session events, task outputs, subagent
  snapshots, parent snapshot indexes, and recovery-safe projection behavior for the Node runtime.

### Modified Capabilities

None.

## Impact

- Affects Node storage utilities, terminal snapshot construction, runtime lifecycle integration,
  subagent notification serialization, and backend integration tests.
- Writes additive files beneath `~/.mycli/sessions/<session-id>/`; no SQLite migration or new npm
  dependency is required.
- Existing `session.json` readers remain compatible because new metadata fields are additive.
