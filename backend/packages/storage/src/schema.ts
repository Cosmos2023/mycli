export const SCHEMA_VERSION = 7;

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
