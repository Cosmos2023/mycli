export const SCHEMA_VERSION = 9;
export const SCHEMA_V10_VERSION = 10;
export const SCHEMA_V11_VERSION = 11;
export const SCHEMA_V12_VERSION = 12;
export const SCHEMA_V13_VERSION = 13;
export const SCHEMA_V14_VERSION = 14;
export const SCHEMA_V15_VERSION = 15;

export const SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    workspace_root TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS conversation_messages (
    session_id TEXT NOT NULL,
    message_index INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (session_id, message_index),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS conversation_messages_fts USING fts5(
    session_id UNINDEXED,
    message_index UNINDEXED,
    content
);

CREATE TRIGGER IF NOT EXISTS conversation_messages_fts_insert
AFTER INSERT ON conversation_messages BEGIN
    INSERT INTO conversation_messages_fts(rowid, session_id, message_index, content)
    VALUES (new.rowid, new.session_id, new.message_index, new.payload_json);
END;

CREATE TRIGGER IF NOT EXISTS conversation_messages_fts_delete
AFTER DELETE ON conversation_messages BEGIN
    DELETE FROM conversation_messages_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS conversation_messages_fts_update
AFTER UPDATE ON conversation_messages BEGIN
    DELETE FROM conversation_messages_fts WHERE rowid = old.rowid;
    INSERT INTO conversation_messages_fts(rowid, session_id, message_index, content)
    VALUES (new.rowid, new.session_id, new.message_index, new.payload_json);
END;

CREATE TABLE IF NOT EXISTS conversation_trees (
    session_id TEXT PRIMARY KEY,
    parent_id TEXT,
    fork_point INTEGER,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_trees_parent
ON conversation_trees(parent_id);

CREATE TABLE IF NOT EXISTS history_items (
    session_id TEXT NOT NULL,
    sequence_no INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS history_items_fts USING fts5(
    session_id UNINDEXED,
    item_id UNINDEXED,
    sequence_no UNINDEXED,
    content
);

CREATE TRIGGER IF NOT EXISTS history_items_fts_insert
AFTER INSERT ON history_items BEGIN
    INSERT INTO history_items_fts(rowid, session_id, item_id, sequence_no, content)
    VALUES (
        new.rowid,
        new.session_id,
        new.item_id,
        new.sequence_no,
        COALESCE(json_extract(new.payload_json, '$.text'), new.payload_json)
    );
END;

CREATE TRIGGER IF NOT EXISTS history_items_fts_delete
AFTER DELETE ON history_items BEGIN
    DELETE FROM history_items_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS history_items_fts_update
AFTER UPDATE ON history_items BEGIN
    DELETE FROM history_items_fts WHERE rowid = old.rowid;
    INSERT INTO history_items_fts(rowid, session_id, item_id, sequence_no, content)
    VALUES (
        new.rowid,
        new.session_id,
        new.item_id,
        new.sequence_no,
        COALESCE(json_extract(new.payload_json, '$.text'), new.payload_json)
    );
END;

CREATE TABLE IF NOT EXISTS turn_rollouts (
    session_id TEXT NOT NULL,
    sequence_no INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_state (
    session_id TEXT NOT NULL,
    state_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, state_key),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_summaries (
    session_id TEXT NOT NULL,
    summary_index INTEGER PRIMARY KEY AUTOINCREMENT,
    summary_text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runtime_turns (
    session_id TEXT NOT NULL,
    client_turn_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL,
    error_code TEXT,
    result_json TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    owner_id TEXT,
    owner_pid INTEGER,
    PRIMARY KEY (session_id, client_turn_id),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subagent_tasks (
    task_id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL,
    parent_turn_id TEXT NOT NULL,
    child_session_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    status TEXT NOT NULL,
    progress_sequence INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_subagent_tasks_parent
ON subagent_tasks(parent_session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_subagent_tasks_child
ON subagent_tasks(parent_session_id, child_session_id);

CREATE TABLE IF NOT EXISTS agent_threads (
    thread_id TEXT PRIMARY KEY,
    root_thread_id TEXT NOT NULL,
    parent_thread_id TEXT NOT NULL,
    agent_path TEXT NOT NULL,
    task_name TEXT NOT NULL,
    nickname TEXT,
    profile_id TEXT NOT NULL,
    status TEXT NOT NULL,
    spawn_config_json TEXT,
    source_task_id TEXT,
    terminal_summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (root_thread_id, agent_path)
);

CREATE INDEX IF NOT EXISTS idx_agent_threads_root_path
ON agent_threads(root_thread_id, agent_path);

CREATE INDEX IF NOT EXISTS idx_agent_threads_parent_status
ON agent_threads(parent_thread_id, status, last_active_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_threads_source_task
ON agent_threads(source_task_id)
WHERE source_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_spawn_edges (
    parent_thread_id TEXT NOT NULL,
    child_thread_id TEXT NOT NULL PRIMARY KEY,
    root_thread_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (child_thread_id) REFERENCES agent_threads(thread_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_spawn_edges_parent_status
ON agent_spawn_edges(parent_thread_id, status, created_at);

CREATE TABLE IF NOT EXISTS agent_runtime_leases (
    thread_id TEXT PRIMARY KEY,
    generation TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    checkpoint_json TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES agent_threads(thread_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_mailbox_items (
    message_id TEXT PRIMARY KEY,
    queue_id TEXT NOT NULL UNIQUE,
    root_thread_id TEXT NOT NULL,
    sender_thread_id TEXT NOT NULL,
    sender_path TEXT NOT NULL,
    receiver_thread_id TEXT NOT NULL,
    receiver_path TEXT NOT NULL,
    receiver_session_id TEXT NOT NULL,
    receiver_sequence INTEGER NOT NULL,
    trigger_mode TEXT NOT NULL,
    source_call_id TEXT,
    dedupe_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    queued_at TEXT,
    committed_at TEXT,
    UNIQUE (receiver_thread_id, receiver_sequence),
    UNIQUE (receiver_thread_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_mailbox_receiver_state_sequence
ON agent_mailbox_items(receiver_thread_id, state, receiver_sequence);

CREATE INDEX IF NOT EXISTS idx_agent_mailbox_root_receiver_sequence
ON agent_mailbox_items(root_thread_id, receiver_thread_id, receiver_sequence);
`;

export const BACKFILL_SEARCH_SQL = `
INSERT INTO conversation_messages_fts(rowid, session_id, message_index, content)
SELECT
    conversation_messages.rowid,
    conversation_messages.session_id,
    conversation_messages.message_index,
    conversation_messages.payload_json
FROM conversation_messages
LEFT JOIN conversation_messages_fts
    ON conversation_messages_fts.rowid = conversation_messages.rowid
WHERE conversation_messages_fts.rowid IS NULL;

INSERT INTO history_items_fts(rowid, session_id, item_id, sequence_no, content)
SELECT
    history_items.rowid,
    history_items.session_id,
    history_items.item_id,
    history_items.sequence_no,
    COALESCE(json_extract(history_items.payload_json, '$.text'), history_items.payload_json)
FROM history_items
LEFT JOIN history_items_fts
    ON history_items_fts.rowid = history_items.rowid
WHERE history_items_fts.rowid IS NULL;
`;

export const SCHEMA_V5_SQL = `
CREATE TABLE IF NOT EXISTS model_input_blobs (
    blob_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instruction_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id),
    FOREIGN KEY (blob_id) REFERENCES model_input_blobs(blob_id)
);

CREATE INDEX IF NOT EXISTS idx_instruction_snapshots_session_created
ON instruction_snapshots(session_id, created_at, snapshot_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_instruction_snapshots_one_per_session
ON instruction_snapshots(session_id);

CREATE TABLE IF NOT EXISTS tool_set_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id),
    FOREIGN KEY (blob_id) REFERENCES model_input_blobs(blob_id)
);

CREATE INDEX IF NOT EXISTS idx_tool_set_snapshots_session_created
ON tool_set_snapshots(session_id, created_at, snapshot_id);

CREATE TABLE IF NOT EXISTS model_context_events (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    provider_step INTEGER NOT NULL,
    section_key TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    supersedes_event_id TEXT,
    tombstone INTEGER NOT NULL CHECK (tombstone IN (0, 1)),
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id),
    FOREIGN KEY (blob_id) REFERENCES model_input_blobs(blob_id),
    FOREIGN KEY (supersedes_event_id) REFERENCES model_context_events(event_id)
);

CREATE INDEX IF NOT EXISTS idx_model_context_events_session_sequence
ON model_context_events(session_id, provider_step, created_at, event_id);

CREATE INDEX IF NOT EXISTS idx_model_context_events_session_section
ON model_context_events(session_id, section_key, provider_step, created_at, event_id);

CREATE TABLE IF NOT EXISTS provider_request_manifests (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    provider_step INTEGER NOT NULL,
    manifest_blob_id TEXT NOT NULL,
    logical_request_blob_id TEXT NOT NULL,
    request_signature TEXT NOT NULL,
    logical_input_sha256 TEXT NOT NULL,
    logical_request_sha256 TEXT NOT NULL,
    previous_request_id TEXT,
    boundary TEXT CHECK (boundary IN ('bootstrap', 'continuation_reset', 'compaction')),
    created_at TEXT NOT NULL,
    UNIQUE (session_id, turn_id, provider_step),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id),
    FOREIGN KEY (manifest_blob_id) REFERENCES model_input_blobs(blob_id),
    FOREIGN KEY (logical_request_blob_id) REFERENCES model_input_blobs(blob_id),
    FOREIGN KEY (previous_request_id) REFERENCES provider_request_manifests(request_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_request_manifests_session_created
ON provider_request_manifests(session_id, created_at, request_id);

CREATE TABLE IF NOT EXISTS provider_step_events (
    sequence_no INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
        'prepared', 'dispatch_started', 'acknowledged', 'failed', 'unknown'
    )),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (request_id) REFERENCES provider_request_manifests(request_id),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_step_events_request_sequence
ON provider_step_events(request_id, sequence_no);

CREATE INDEX IF NOT EXISTS idx_provider_step_events_session_sequence
ON provider_step_events(session_id, sequence_no);

CREATE TRIGGER IF NOT EXISTS model_input_blobs_no_update
BEFORE UPDATE ON model_input_blobs BEGIN
    SELECT RAISE(ABORT, 'model_input_blobs are immutable');
END;

CREATE TRIGGER IF NOT EXISTS model_input_blobs_no_delete
BEFORE DELETE ON model_input_blobs BEGIN
    SELECT RAISE(ABORT, 'model_input_blobs are append-only');
END;

CREATE TRIGGER IF NOT EXISTS instruction_snapshots_no_update
BEFORE UPDATE ON instruction_snapshots BEGIN
    SELECT RAISE(ABORT, 'instruction_snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS instruction_snapshots_no_delete
BEFORE DELETE ON instruction_snapshots BEGIN
    SELECT RAISE(ABORT, 'instruction_snapshots are append-only');
END;

CREATE TRIGGER IF NOT EXISTS tool_set_snapshots_no_update
BEFORE UPDATE ON tool_set_snapshots BEGIN
    SELECT RAISE(ABORT, 'tool_set_snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS tool_set_snapshots_no_delete
BEFORE DELETE ON tool_set_snapshots BEGIN
    SELECT RAISE(ABORT, 'tool_set_snapshots are append-only');
END;

CREATE TRIGGER IF NOT EXISTS model_context_events_no_update
BEFORE UPDATE ON model_context_events BEGIN
    SELECT RAISE(ABORT, 'model_context_events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS model_context_events_no_delete
BEFORE DELETE ON model_context_events BEGIN
    SELECT RAISE(ABORT, 'model_context_events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS provider_request_manifests_no_update
BEFORE UPDATE ON provider_request_manifests BEGIN
    SELECT RAISE(ABORT, 'provider_request_manifests are immutable');
END;

CREATE TRIGGER IF NOT EXISTS provider_request_manifests_no_delete
BEFORE DELETE ON provider_request_manifests BEGIN
    SELECT RAISE(ABORT, 'provider_request_manifests are append-only');
END;

CREATE TRIGGER IF NOT EXISTS provider_step_events_no_update
BEFORE UPDATE ON provider_step_events BEGIN
    SELECT RAISE(ABORT, 'provider_step_events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS provider_step_events_no_delete
BEFORE DELETE ON provider_step_events BEGIN
    SELECT RAISE(ABORT, 'provider_step_events are append-only');
END;
`;

export const SCHEMA_V6_SQL = `
CREATE TABLE IF NOT EXISTS provider_input_timeline_events (
    sequence_no INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    window_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    provider_step INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (
        'window_boundary', 'conversation_item', 'context_update', 'context_tombstone'
    )),
    blob_id TEXT NOT NULL,
    model_context_event_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id),
    FOREIGN KEY (blob_id) REFERENCES model_input_blobs(blob_id),
    FOREIGN KEY (model_context_event_id) REFERENCES model_context_events(event_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_input_timeline_session_sequence
ON provider_input_timeline_events(session_id, sequence_no);

CREATE INDEX IF NOT EXISTS idx_provider_input_timeline_window_sequence
ON provider_input_timeline_events(session_id, window_id, sequence_no);

CREATE TRIGGER IF NOT EXISTS provider_input_timeline_events_no_update
BEFORE UPDATE ON provider_input_timeline_events BEGIN
    SELECT RAISE(ABORT, 'provider_input_timeline_events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS provider_input_timeline_events_no_delete
BEFORE DELETE ON provider_input_timeline_events BEGIN
    SELECT RAISE(ABORT, 'provider_input_timeline_events are append-only');
END;
`;

export const SCHEMA_V7_SQL = `
CREATE TABLE IF NOT EXISTS shell_output_chunks (
    session_id TEXT NOT NULL,
    shell_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    event_sequence INTEGER NOT NULL,
    cursor_start INTEGER NOT NULL,
    cursor_end INTEGER NOT NULL,
    omitted_before INTEGER NOT NULL DEFAULT 0,
    output_text TEXT NOT NULL,
    PRIMARY KEY (session_id, shell_id, event_sequence),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shell_output_chunks_call_sequence
ON shell_output_chunks(session_id, call_id, event_sequence);

CREATE TRIGGER IF NOT EXISTS shell_output_chunks_no_update
BEFORE UPDATE ON shell_output_chunks BEGIN
    SELECT RAISE(ABORT, 'shell_output_chunks are append-only');
END;
`;

export const SCHEMA_V8_SQL = `
CREATE TABLE IF NOT EXISTS agent_effect_attempts (
    attempt_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('provider', 'tool')),
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    mutating INTEGER NOT NULL CHECK (mutating IN (0, 1)),
    request_sha256 TEXT NOT NULL,
    request_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (kind, session_id, turn_id, external_id),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_effect_attempts_session_turn
ON agent_effect_attempts(session_id, turn_id, created_at, attempt_id);

CREATE TABLE IF NOT EXISTS agent_effect_attempt_outcomes (
    attempt_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN (
        'completed', 'failed', 'interrupted', 'unknown', 'effect_outcome_unknown'
    )),
    result_sha256 TEXT NOT NULL,
    result_json TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    FOREIGN KEY (attempt_id) REFERENCES agent_effect_attempts(attempt_id)
);

CREATE TRIGGER IF NOT EXISTS agent_effect_attempts_no_update
BEFORE UPDATE ON agent_effect_attempts BEGIN
    SELECT RAISE(ABORT, 'agent_effect_attempts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS agent_effect_attempts_no_delete
BEFORE DELETE ON agent_effect_attempts BEGIN
    SELECT RAISE(ABORT, 'agent_effect_attempts are append-only');
END;

CREATE TRIGGER IF NOT EXISTS agent_effect_attempt_outcomes_no_update
BEFORE UPDATE ON agent_effect_attempt_outcomes BEGIN
    SELECT RAISE(ABORT, 'agent_effect_attempt_outcomes are immutable');
END;

CREATE TRIGGER IF NOT EXISTS agent_effect_attempt_outcomes_no_delete
BEFORE DELETE ON agent_effect_attempt_outcomes BEGIN
    SELECT RAISE(ABORT, 'agent_effect_attempt_outcomes are append-only');
END;
`;

export const SCHEMA_V9_SQL = `
DROP TRIGGER IF EXISTS conversation_messages_fts_insert;
DROP TRIGGER IF EXISTS conversation_messages_fts_delete;
DROP TRIGGER IF EXISTS conversation_messages_fts_update;
DROP TRIGGER IF EXISTS history_items_fts_insert;
DROP TRIGGER IF EXISTS history_items_fts_delete;
DROP TRIGGER IF EXISTS history_items_fts_update;

DROP TABLE IF EXISTS conversation_messages_fts;
DROP TABLE IF EXISTS history_items_fts;

CREATE VIRTUAL TABLE conversation_messages_fts USING fts5(
    payload_json,
    content='conversation_messages',
    content_rowid='rowid'
);

CREATE TRIGGER conversation_messages_fts_insert
AFTER INSERT ON conversation_messages BEGIN
    INSERT INTO conversation_messages_fts(rowid, payload_json)
    VALUES (new.rowid, new.payload_json);
END;

CREATE TRIGGER conversation_messages_fts_delete
AFTER DELETE ON conversation_messages BEGIN
    INSERT INTO conversation_messages_fts(
        conversation_messages_fts,
        rowid,
        payload_json
    ) VALUES ('delete', old.rowid, old.payload_json);
END;

CREATE TRIGGER conversation_messages_fts_update
AFTER UPDATE ON conversation_messages BEGIN
    INSERT INTO conversation_messages_fts(
        conversation_messages_fts,
        rowid,
        payload_json
    ) VALUES ('delete', old.rowid, old.payload_json);
    INSERT INTO conversation_messages_fts(rowid, payload_json)
    VALUES (new.rowid, new.payload_json);
END;

INSERT INTO conversation_messages_fts(conversation_messages_fts) VALUES ('rebuild');
`;

export const TRANSCRIPT_PROJECTION_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_history_items_session_sequence
ON history_items(session_id, sequence_no);

CREATE INDEX IF NOT EXISTS idx_turn_rollouts_session_sequence
ON turn_rollouts(session_id, sequence_no);

CREATE INDEX IF NOT EXISTS idx_turn_rollouts_session_turn_sequence
ON turn_rollouts(session_id, turn_id, sequence_no);

CREATE INDEX IF NOT EXISTS idx_session_summaries_session_sequence
ON session_summaries(session_id, summary_index);
`;

export const SESSION_RUNTIME_LEASE_SQL = `
CREATE TABLE IF NOT EXISTS session_runtime_leases (
    session_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    acquired_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_runtime_leases_owner
ON session_runtime_leases(owner_id);
`;

export const SCHEMA_V10_LEGACY_CLEANUP_SQL = `
DROP TRIGGER IF EXISTS conversation_messages_fts_insert;
DROP TRIGGER IF EXISTS conversation_messages_fts_delete;
DROP TRIGGER IF EXISTS conversation_messages_fts_update;
DROP TRIGGER IF EXISTS history_items_fts_insert;
DROP TRIGGER IF EXISTS history_items_fts_delete;
DROP TRIGGER IF EXISTS history_items_fts_update;

DROP TABLE IF EXISTS conversation_messages_fts;
DROP TABLE IF EXISTS history_items_fts;
DROP TABLE IF EXISTS conversation_messages;
DROP TABLE IF EXISTS history_items;
DROP TABLE IF EXISTS turn_rollouts;
DROP TABLE IF EXISTS session_summaries;
`;

export const SCHEMA_V10_LINEAGE_SQL = `
ALTER TABLE conversation_trees ADD COLUMN fork_event_session_id TEXT;
ALTER TABLE conversation_trees ADD COLUMN fork_event_id TEXT;

CREATE INDEX idx_conversation_trees_parent_event
ON conversation_trees(parent_id, fork_event_session_id, fork_event_id);
`;

const TRANSCRIPT_EVENTS_TABLE_SQL = `
CREATE TABLE transcript_events (
    sequence_no INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    turn_id TEXT,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'user_input',
        'assistant_output',
        'assistant_tool_call_batch',
        'tool_result',
        'context',
        'display_activity',
        'turn_lifecycle',
        'rollback',
        'compaction',
        'opaque_legacy'
    )),
    provider_index INTEGER,
    model_visible INTEGER NOT NULL CHECK (model_visible IN (0, 1)),
    payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json)
        AND COALESCE(json_extract(payload_json, '$.schemaVersion') = 1, 0)
        AND COALESCE(json_type(payload_json, '$.payload') = 'object', 0)
    ),
    created_at TEXT NOT NULL,
    UNIQUE (session_id, event_id),
    CHECK (
        (model_visible = 1 AND provider_index IS NOT NULL AND provider_index >= 0)
        OR (model_visible = 0 AND provider_index IS NULL)
    ),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX idx_transcript_events_session_sequence
ON transcript_events(session_id, sequence_no);

CREATE INDEX idx_transcript_events_session_turn_sequence
ON transcript_events(session_id, turn_id, sequence_no)
WHERE turn_id IS NOT NULL;

CREATE UNIQUE INDEX idx_transcript_events_session_provider
ON transcript_events(session_id, provider_index)
WHERE provider_index IS NOT NULL;

CREATE INDEX idx_transcript_events_session_type_sequence
ON transcript_events(session_id, event_type, sequence_no DESC);
`;

const TRANSCRIPT_EVENTS_APPEND_ONLY_SQL = `
CREATE TRIGGER transcript_events_no_update
BEFORE UPDATE ON transcript_events BEGIN
    SELECT RAISE(ABORT, 'transcript_events are append-only');
END;

CREATE TRIGGER transcript_events_no_delete
BEFORE DELETE ON transcript_events BEGIN
    SELECT RAISE(ABORT, 'transcript_events are append-only');
END;
`;

export const SCHEMA_V10_TRANSCRIPT_SQL = `
${TRANSCRIPT_EVENTS_TABLE_SQL}

CREATE VIRTUAL TABLE transcript_events_fts USING fts5(
    payload_json,
    content='transcript_events',
    content_rowid='sequence_no'
);

CREATE TRIGGER transcript_events_fts_insert
AFTER INSERT ON transcript_events
WHEN (
    new.model_visible = 1 AND new.event_type IN (
        'user_input', 'assistant_output', 'assistant_tool_call_batch', 'tool_result', 'context'
    ) AND COALESCE(
        json_extract(new.payload_json, '$.payload.readableProjection.searchVisible'), 1
    ) != 0
) OR (
    new.model_visible = 1 AND new.event_type = 'opaque_legacy'
    AND json_extract(new.payload_json, '$.payload.sourceKind') = 'conversation_messages'
) BEGIN
    INSERT INTO transcript_events_fts(rowid, payload_json)
    VALUES (new.sequence_no, new.payload_json);
END;

CREATE TRIGGER transcript_events_fts_delete
AFTER DELETE ON transcript_events
WHEN (
    old.model_visible = 1 AND old.event_type IN (
        'user_input', 'assistant_output', 'assistant_tool_call_batch', 'tool_result', 'context'
    ) AND COALESCE(
        json_extract(old.payload_json, '$.payload.readableProjection.searchVisible'), 1
    ) != 0
) OR (
    old.model_visible = 1 AND old.event_type = 'opaque_legacy'
    AND json_extract(old.payload_json, '$.payload.sourceKind') = 'conversation_messages'
) BEGIN
    INSERT INTO transcript_events_fts(transcript_events_fts, rowid, payload_json)
    VALUES ('delete', old.sequence_no, old.payload_json);
END;

CREATE TRIGGER transcript_events_fts_update
AFTER UPDATE ON transcript_events BEGIN
    INSERT INTO transcript_events_fts(transcript_events_fts, rowid, payload_json)
    SELECT 'delete', old.sequence_no, old.payload_json
    WHERE (
        old.model_visible = 1 AND old.event_type IN (
            'user_input', 'assistant_output', 'assistant_tool_call_batch', 'tool_result', 'context'
        ) AND COALESCE(
            json_extract(old.payload_json, '$.payload.readableProjection.searchVisible'), 1
        ) != 0
    ) OR (
        old.model_visible = 1 AND old.event_type = 'opaque_legacy'
        AND json_extract(old.payload_json, '$.payload.sourceKind') = 'conversation_messages'
    );
    INSERT INTO transcript_events_fts(rowid, payload_json)
    SELECT new.sequence_no, new.payload_json
    WHERE (
        new.model_visible = 1 AND new.event_type IN (
            'user_input', 'assistant_output', 'assistant_tool_call_batch', 'tool_result', 'context'
        ) AND COALESCE(
            json_extract(new.payload_json, '$.payload.readableProjection.searchVisible'), 1
        ) != 0
    ) OR (
        new.model_visible = 1 AND new.event_type = 'opaque_legacy'
        AND json_extract(new.payload_json, '$.payload.sourceKind') = 'conversation_messages'
    );
END;

${TRANSCRIPT_EVENTS_APPEND_ONLY_SQL}
`;

export const SCHEMA_V10_SQL = `
${SCHEMA_V10_LEGACY_CLEANUP_SQL}
${SCHEMA_V10_LINEAGE_SQL}
${SCHEMA_V10_TRANSCRIPT_SQL}
${SESSION_RUNTIME_LEASE_SQL}
`;

export const SCHEMA_V11_CONTENT_BLOB_SQL = `
CREATE TABLE session_content_blobs (
    blob_id TEXT PRIMARY KEY CHECK (
        length(blob_id) = 71
        AND substr(blob_id, 1, 7) = 'sha256:'
        AND substr(blob_id, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    codec TEXT NOT NULL CHECK (codec IN ('identity-v1', 'deflate-raw-v1')),
    raw_bytes INTEGER NOT NULL CHECK (raw_bytes >= 0 AND raw_bytes <= 33554432),
    stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0),
    payload_blob BLOB NOT NULL CHECK (length(payload_blob) = stored_bytes),
    created_at TEXT NOT NULL,
    CHECK (codec != 'identity-v1' OR raw_bytes = stored_bytes)
);

CREATE INDEX idx_session_content_blobs_codec
ON session_content_blobs(codec, raw_bytes);

CREATE TRIGGER session_content_blobs_no_update
BEFORE UPDATE ON session_content_blobs BEGIN
    SELECT RAISE(ABORT, 'session_content_blobs are immutable');
END;
`;

export const SCHEMA_V11_CONTENTLESS_FTS_SQL = `
CREATE VIRTUAL TABLE transcript_events_fts USING fts5(
    payload_json,
    content='',
    contentless_delete=1
);
`;

export const SCHEMA_V11_TRANSCRIPT_SQL = `
${TRANSCRIPT_EVENTS_TABLE_SQL}

${SCHEMA_V11_CONTENTLESS_FTS_SQL}

${TRANSCRIPT_EVENTS_APPEND_ONLY_SQL}
`;

export const SCHEMA_V11_CONTENT_REFERENCE_SQL = `
CREATE TABLE transcript_event_blob_refs (
    sequence_no INTEGER NOT NULL,
    json_pointer TEXT NOT NULL CHECK (
        length(json_pointer) BETWEEN 1 AND 16384
        AND substr(json_pointer, 1, 1) = '/'
    ),
    blob_id TEXT NOT NULL,
    PRIMARY KEY (sequence_no, json_pointer),
    FOREIGN KEY (sequence_no) REFERENCES transcript_events(sequence_no) ON DELETE CASCADE,
    FOREIGN KEY (blob_id) REFERENCES session_content_blobs(blob_id) ON DELETE RESTRICT
);

CREATE INDEX idx_transcript_event_blob_refs_blob
ON transcript_event_blob_refs(blob_id, sequence_no);

CREATE TABLE model_input_blob_refs (
    blob_id TEXT PRIMARY KEY,
    content_blob_id TEXT NOT NULL,
    FOREIGN KEY (blob_id) REFERENCES model_input_blobs(blob_id) ON DELETE CASCADE,
    FOREIGN KEY (content_blob_id) REFERENCES session_content_blobs(blob_id) ON DELETE RESTRICT
);

CREATE INDEX idx_model_input_blob_refs_content
ON model_input_blob_refs(content_blob_id, blob_id);
`;

export const SCHEMA_V11_SQL = `
${SCHEMA_V10_LEGACY_CLEANUP_SQL}
${SCHEMA_V10_LINEAGE_SQL}
${SCHEMA_V11_CONTENT_BLOB_SQL}
${SCHEMA_V11_TRANSCRIPT_SQL}
${SCHEMA_V11_CONTENT_REFERENCE_SQL}
${SESSION_RUNTIME_LEASE_SQL}
`;

export const SCHEMA_V12_PROVIDER_LEDGER_SQL = `
DROP TRIGGER IF EXISTS provider_step_events_no_delete;
DROP TRIGGER IF EXISTS provider_step_events_no_update;
DROP TRIGGER IF EXISTS provider_request_manifests_no_delete;
DROP TRIGGER IF EXISTS provider_request_manifests_no_update;
DROP TABLE provider_step_events;
DROP TABLE provider_request_manifests;

CREATE TABLE provider_request_manifests (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    provider_step INTEGER NOT NULL,
    manifest_blob_id TEXT NOT NULL,
    request_signature TEXT NOT NULL,
    logical_input_sha256 TEXT NOT NULL,
    logical_request_sha256 TEXT NOT NULL,
    previous_request_id TEXT,
    boundary TEXT CHECK (boundary IN (
        'bootstrap', 'legacy_bootstrap', 'continuation_reset', 'compaction', 'source_reset'
    )),
    created_at TEXT NOT NULL,
    UNIQUE (session_id, turn_id, provider_step),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id),
    FOREIGN KEY (manifest_blob_id) REFERENCES model_input_blobs(blob_id),
    FOREIGN KEY (previous_request_id) REFERENCES provider_request_manifests(request_id)
);

CREATE INDEX idx_provider_request_manifests_session_created
ON provider_request_manifests(session_id, created_at, request_id);

CREATE TABLE provider_step_events (
    sequence_no INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
        'prepared', 'dispatch_started', 'acknowledged', 'failed', 'unknown'
    )),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (request_id) REFERENCES provider_request_manifests(request_id),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE INDEX idx_provider_step_events_request_sequence
ON provider_step_events(request_id, sequence_no);

CREATE INDEX idx_provider_step_events_session_sequence
ON provider_step_events(session_id, sequence_no);

CREATE TRIGGER provider_request_manifests_no_update
BEFORE UPDATE ON provider_request_manifests BEGIN
    SELECT RAISE(ABORT, 'provider_request_manifests are immutable');
END;

CREATE TRIGGER provider_request_manifests_no_delete
BEFORE DELETE ON provider_request_manifests BEGIN
    SELECT RAISE(ABORT, 'provider_request_manifests are append-only');
END;

CREATE TRIGGER provider_step_events_no_update
BEFORE UPDATE ON provider_step_events BEGIN
    SELECT RAISE(ABORT, 'provider_step_events are immutable');
END;

CREATE TRIGGER provider_step_events_no_delete
BEFORE DELETE ON provider_step_events BEGIN
    SELECT RAISE(ABORT, 'provider_step_events are append-only');
END;
`;

export const SCHEMA_V12_SQL = `
${SCHEMA_V11_SQL}
${SCHEMA_V12_PROVIDER_LEDGER_SQL}
`;

export const SCHEMA_V13_PROVIDER_ATTEMPTS_SQL = `
CREATE TABLE provider_retry_chains (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    FOREIGN KEY (request_id) REFERENCES provider_request_manifests(request_id),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX idx_provider_retry_chains_session_turn
ON provider_retry_chains(session_id, turn_id, request_id);
CREATE TABLE provider_attempt_events (
    global_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL,
    sequence_no INTEGER NOT NULL CHECK (sequence_no BETWEEN 1 AND 1000),
    attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 201),
    state TEXT NOT NULL CHECK (state IN (
        'scheduled', 'started', 'failed', 'completed', 'recovered', 'exhausted', 'cancelled', 'unknown'
    )),
    record_json TEXT NOT NULL,
    UNIQUE (request_id, sequence_no),
    FOREIGN KEY (request_id) REFERENCES provider_retry_chains(request_id)
);
CREATE TRIGGER provider_retry_chains_no_update
BEFORE UPDATE ON provider_retry_chains BEGIN
    SELECT RAISE(ABORT, 'provider_retry_chains are immutable');
END;
CREATE TRIGGER provider_retry_chains_no_delete
BEFORE DELETE ON provider_retry_chains BEGIN
    SELECT RAISE(ABORT, 'provider_retry_chains are append-only');
END;
CREATE TRIGGER provider_attempt_events_no_update
BEFORE UPDATE ON provider_attempt_events BEGIN
    SELECT RAISE(ABORT, 'provider_attempt_events are immutable');
END;
CREATE TRIGGER provider_attempt_events_no_delete
BEFORE DELETE ON provider_attempt_events BEGIN
    SELECT RAISE(ABORT, 'provider_attempt_events are append-only');
END;
`;

export const SCHEMA_V13_SQL = `${SCHEMA_V12_SQL}\n${SCHEMA_V13_PROVIDER_ATTEMPTS_SQL}`;

/** Durable cumulative usage checkpoints for each goal/provider attempt. */
export const SESSION_GOAL_USAGE_SQL = `
CREATE TABLE IF NOT EXISTS session_goal_usage (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  goal_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  token_count INTEGER,
  PRIMARY KEY (session_id, goal_id, request_id)
);
`;
