# Current State: Session Recovery Payload Diagnostics

## Finding

`DoctorService._check_sessions_db()` validates the sessions DB at the schema and
lineage levels:

- required tables
- SQLite foreign key violations
- legacy orphan rows
- missing lineage parents
- lineage cycles
- invalid `conversation_trees.fork_point`

It does not parse key `session_state` payloads used for recovery:

- `pending_decision`
- `suspended_turn`
- `turn_record`
- `responses_continuation_state`

`SessionService.load_suspended_turn()` and related loaders expect these payloads
to be JSON objects with specific nested fields. Invalid JSON, non-object JSON,
or malformed nested objects can make approval/clarification/resume recovery fail
at runtime even though `mycli doctor` reports the DB as openable.

## Impact

For a Hermes-like local agent foundation, waiting approval, waiting
clarification, interrupted turns, and resume state need to be diagnosable before
the user attempts to continue the session.

## Proposed Slice

Add a bounded doctor validation pass for session recovery state rows. It should
parse critical `session_state` keys and fail `sessions_db` with bounded
`session_id:state_key` references when payloads are corrupt or structurally
invalid.

The slice should not migrate or delete data automatically. It is diagnostics
only.
