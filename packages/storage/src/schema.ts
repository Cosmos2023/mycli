export const SCHEMA_VERSION = 2;

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
