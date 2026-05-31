from __future__ import annotations

import json
import random
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Callable, Iterator, TypeVar, cast

from mycli.domain.session_store import (
    JsonArray,
    JsonObject,
    SessionMaintenanceCandidate,
    SessionMaintenanceReport,
    SessionOverview,
    SessionSearchResult,
)

T = TypeVar("T")


class SQLiteSessionStore:
    SCHEMA_VERSION = 2
    _SEARCH_SNIPPET_MAX_CHARS = 160
    _WAL_INCOMPATIBLE_MARKERS = (
        "locking protocol",
        "not authorized",
    )
    _WRITE_MAX_RETRIES = 15
    _WRITE_RETRY_MIN_SECONDS = 0.020
    _WRITE_RETRY_MAX_SECONDS = 0.150
    _CHECKPOINT_EVERY_N_WRITES = 50

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._write_count = 0
        self._initialize()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(
            self._db_path,
            timeout=1.0,
            isolation_level=None,
        )
        connection.row_factory = sqlite3.Row
        self._apply_wal_with_fallback(connection)
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
        finally:
            connection.close()

    def _apply_wal_with_fallback(self, connection: sqlite3.Connection) -> None:
        try:
            connection.execute("PRAGMA journal_mode=WAL")
        except sqlite3.OperationalError as exc:
            message = str(exc).lower()
            if not any(marker in message for marker in self._WAL_INCOMPATIBLE_MARKERS):
                raise
            connection.execute("PRAGMA journal_mode=DELETE")

    def _execute_write(self, operation: Callable[[sqlite3.Connection], T]) -> T:
        with self._lock:
            for attempt in range(self._WRITE_MAX_RETRIES):
                with self._connect() as connection:
                    try:
                        connection.execute("BEGIN IMMEDIATE")
                        result = operation(connection)
                        connection.commit()
                    except sqlite3.OperationalError as exc:
                        connection.rollback()
                        if self._is_locked_error(exc) and attempt < self._WRITE_MAX_RETRIES - 1:
                            time.sleep(
                                random.uniform(
                                    self._WRITE_RETRY_MIN_SECONDS,
                                    self._WRITE_RETRY_MAX_SECONDS,
                                )
                            )
                            continue
                        raise
                    except Exception:
                        connection.rollback()
                        raise
                    self._write_count += 1
                    if self._write_count % self._CHECKPOINT_EVERY_N_WRITES == 0:
                        self._try_passive_checkpoint(connection)
                    return result
        raise sqlite3.OperationalError("database is locked")

    @staticmethod
    def _is_locked_error(exc: sqlite3.OperationalError) -> bool:
        message = str(exc).lower()
        return "locked" in message or "busy" in message

    def _try_passive_checkpoint(self, connection: sqlite3.Connection) -> None:
        try:
            connection.execute("PRAGMA wal_checkpoint(PASSIVE)")
        except sqlite3.DatabaseError:
            pass

    def _timestamp(self) -> str:
        return datetime.now(UTC).isoformat()

    def _initialize(self) -> None:
        def write(connection: sqlite3.Connection) -> None:
            connection.executescript(
                """
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
                    INSERT INTO conversation_messages_fts(
                        rowid,
                        session_id,
                        message_index,
                        content
                    )
                    VALUES (
                        new.rowid,
                        new.session_id,
                        new.message_index,
                        new.payload_json
                    );
                END;

                CREATE TRIGGER IF NOT EXISTS conversation_messages_fts_delete
                AFTER DELETE ON conversation_messages BEGIN
                    DELETE FROM conversation_messages_fts WHERE rowid = old.rowid;
                END;

                CREATE TRIGGER IF NOT EXISTS conversation_messages_fts_update
                AFTER UPDATE ON conversation_messages BEGIN
                    DELETE FROM conversation_messages_fts WHERE rowid = old.rowid;
                    INSERT INTO conversation_messages_fts(
                        rowid,
                        session_id,
                        message_index,
                        content
                    )
                    VALUES (
                        new.rowid,
                        new.session_id,
                        new.message_index,
                        new.payload_json
                    );
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
                """
            )
            self._backfill_search_index(connection)
            self._record_schema_version(connection)

        self._execute_write(write)

    def _record_schema_version(self, connection: sqlite3.Connection) -> None:
        connection.execute("DELETE FROM schema_version")
        connection.execute(
            "INSERT INTO schema_version (version) VALUES (?)",
            (self.SCHEMA_VERSION,),
        )

    def _backfill_search_index(self, connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            INSERT INTO conversation_messages_fts(rowid, session_id, message_index, content)
            SELECT
                conversation_messages.rowid,
                conversation_messages.session_id,
                conversation_messages.message_index,
                conversation_messages.payload_json
            FROM conversation_messages
            LEFT JOIN conversation_messages_fts
                ON conversation_messages_fts.rowid = conversation_messages.rowid
            WHERE conversation_messages_fts.rowid IS NULL
            """
        )

    def _touch_session(
        self,
        connection: sqlite3.Connection,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
    ) -> None:
        now = self._timestamp()
        connection.execute(
            """
            INSERT INTO sessions (
                session_id,
                workspace_root,
                thread_id,
                created_at,
                updated_at,
                last_active_at,
                status
            )
            VALUES (?, ?, ?, ?, ?, ?, 'active')
            ON CONFLICT(session_id) DO UPDATE SET
                workspace_root = excluded.workspace_root,
                thread_id = excluded.thread_id,
                updated_at = excluded.updated_at,
                last_active_at = excluded.last_active_at
            """,
            (session_id, str(workspace_root), thread_id, now, now, now),
        )

    def _dump_payload(self, payload: JsonObject | JsonArray) -> str:
        return json.dumps(payload, ensure_ascii=False)

    def _load_object_rows(self, rows: list[sqlite3.Row]) -> list[JsonObject]:
        payloads: list[JsonObject] = []
        for row in rows:
            payload = json.loads(str(row["payload_json"]))
            if isinstance(payload, dict):
                payloads.append(cast(JsonObject, payload))
        return payloads

    def replace_conversation(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        messages: list[JsonObject],
    ) -> None:
        def write(connection: sqlite3.Connection) -> None:
            self._touch_session(
                connection,
                session_id=session_id,
                workspace_root=workspace_root,
                thread_id=thread_id,
            )
            connection.execute(
                "DELETE FROM conversation_messages WHERE session_id = ?",
                (session_id,),
            )
            connection.executemany(
                """
                INSERT INTO conversation_messages (session_id, message_index, payload_json)
                VALUES (?, ?, ?)
                """,
                [
                    (session_id, index, self._dump_payload(message))
                    for index, message in enumerate(messages)
                ],
            )

        self._execute_write(write)

    def load_conversation(self, session_id: str) -> list[JsonObject] | None:
        with self._connect() as connection:
            rows = self._load_conversation_rows(connection, session_id)
        if not rows:
            return None
        return self._load_object_rows(rows)

    def resolve_resume_session_id(self, session_id: str) -> str:
        with self._connect() as connection:
            return self._resolve_resume_session_id(connection, session_id)

    def load_conversation_lineage(self, session_id: str) -> list[JsonObject]:
        with self._connect() as connection:
            chain = self._conversation_lineage_root_to_tip(connection, session_id)
        return self._compose_lineage_messages(chain)

    def search_messages(
        self,
        query: str,
        *,
        workspace_root: Path | None = None,
        limit: int = 20,
    ) -> tuple[SessionSearchResult, ...]:
        match_query = self._search_match_query(query)
        if not match_query:
            return ()
        parameters: list[object] = [match_query]
        workspace_filter = ""
        if workspace_root is not None:
            workspace_filter = "AND sessions.workspace_root = ?"
            parameters.append(str(workspace_root))
        parameters.append(limit)
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT
                    conversation_messages.session_id,
                    conversation_messages.message_index,
                    conversation_messages.payload_json
                FROM conversation_messages_fts
                JOIN conversation_messages
                    ON conversation_messages.rowid = conversation_messages_fts.rowid
                JOIN sessions
                    ON sessions.session_id = conversation_messages.session_id
                WHERE conversation_messages_fts MATCH ?
                {workspace_filter}
                ORDER BY rank, sessions.last_active_at DESC, conversation_messages.message_index ASC
                LIMIT ?
                """,
                parameters,
            ).fetchall()
        return tuple(
            result
            for row in rows
            if (result := self._search_result_from_row(row, query)) is not None
        )

    def _search_result_from_row(
        self,
        row: sqlite3.Row,
        query: str,
    ) -> SessionSearchResult | None:
        payload = json.loads(str(row["payload_json"]))
        if not isinstance(payload, dict):
            return None
        role = payload.get("role")
        content = self._message_search_content(cast(JsonObject, payload))
        return SessionSearchResult(
            session_id=str(row["session_id"]),
            message_index=int(row["message_index"]),
            role=str(role) if isinstance(role, str) else "unknown",
            snippet=self._search_snippet(content, query),
        )

    @classmethod
    def _search_match_query(cls, query: str) -> str:
        tokens = re.findall(r"\S+", query.strip())
        return " ".join(cls._quote_search_token(token) for token in tokens)

    @staticmethod
    def _quote_search_token(token: str) -> str:
        escaped = token.replace('"', '""')
        return f'"{escaped}"'

    @staticmethod
    def _message_search_content(payload: JsonObject) -> str:
        content = payload.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            text_parts = [
                str(part.get("text"))
                for part in content
                if isinstance(part, dict) and isinstance(part.get("text"), str)
            ]
            return " ".join(text_parts)
        return json.dumps(payload, ensure_ascii=False)

    def _search_snippet(self, content: str, query: str) -> str:
        text = " ".join(content.split())
        if len(text) <= self._SEARCH_SNIPPET_MAX_CHARS:
            return text
        first_token = query.strip().split()[0] if query.strip() else ""
        index = text.lower().find(first_token.lower()) if first_token else -1
        if index < 0:
            return text[: self._SEARCH_SNIPPET_MAX_CHARS].rstrip()
        half_window = self._SEARCH_SNIPPET_MAX_CHARS // 2
        start = max(index - half_window, 0)
        end = min(start + self._SEARCH_SNIPPET_MAX_CHARS, len(text))
        return text[start:end].strip()

    def _resolve_resume_session_id(
        self,
        connection: sqlite3.Connection,
        session_id: str,
    ) -> str:
        if not self._session_has_resume_state(connection, session_id):
            raise ValueError(f"Conversation does not exist: {session_id}")
        current = session_id
        seen: set[str] = set()
        for _ in range(100):
            if current in seen:
                raise ValueError(f"Conversation lineage contains a cycle at {current}.")
            seen.add(current)
            child = self._latest_child_session_id(connection, current)
            if child is None:
                return current
            current = child
        raise ValueError("Conversation lineage exceeds the maximum depth.")

    def _session_has_resume_state(
        self,
        connection: sqlite3.Connection,
        session_id: str,
    ) -> bool:
        row = connection.execute(
            """
            SELECT 1
            FROM sessions
            WHERE session_id = ?
            UNION
            SELECT 1
            FROM conversation_trees
            WHERE session_id = ?
            UNION
            SELECT 1
            FROM conversation_messages
            WHERE session_id = ?
            LIMIT 1
            """,
            (session_id, session_id, session_id),
        ).fetchone()
        return row is not None

    def _latest_child_session_id(
        self,
        connection: sqlite3.Connection,
        session_id: str,
    ) -> str | None:
        row = connection.execute(
            """
            SELECT conversation_trees.session_id
            FROM conversation_trees
            JOIN sessions
                ON sessions.session_id = conversation_trees.session_id
            WHERE conversation_trees.parent_id = ?
            ORDER BY
                sessions.last_active_at DESC,
                sessions.updated_at DESC,
                conversation_trees.session_id DESC
            LIMIT 1
            """,
            (session_id,),
        ).fetchone()
        if row is None:
            return None
        return str(row["session_id"])

    def _conversation_lineage_root_to_tip(
        self,
        connection: sqlite3.Connection,
        session_id: str,
    ) -> list[JsonObject]:
        current = self._resolve_resume_session_id(connection, session_id)
        chain: list[JsonObject] = []
        seen: set[str] = set()
        for _ in range(100):
            if current in seen:
                raise ValueError(f"Conversation lineage contains a cycle at {current}.")
            seen.add(current)
            metadata = self._load_conversation_tree_row(connection, current)
            rows = self._load_conversation_rows(connection, current)
            if metadata is None and not rows and chain:
                return list(reversed(chain))
            chain.append(
                {
                    "session_id": current,
                    "parent_id": metadata.get("parent_id") if metadata else None,
                    "fork_point": metadata.get("fork_point") if metadata else None,
                    "messages": self._load_object_rows(rows),
                }
            )
            parent_id = metadata.get("parent_id") if metadata else None
            if not isinstance(parent_id, str) or not parent_id:
                return list(reversed(chain))
            current = parent_id
        raise ValueError("Conversation lineage exceeds the maximum depth.")

    def _load_conversation_rows(
        self,
        connection: sqlite3.Connection,
        session_id: str,
    ) -> list[sqlite3.Row]:
        return list(
            connection.execute(
                """
                SELECT payload_json
                FROM conversation_messages
                WHERE session_id = ?
                ORDER BY message_index
                """,
                (session_id,),
            ).fetchall()
        )

    def _load_conversation_tree_row(
        self,
        connection: sqlite3.Connection,
        session_id: str,
    ) -> JsonObject | None:
        row = connection.execute(
            """
            SELECT session_id, parent_id, fork_point
            FROM conversation_trees
            WHERE session_id = ?
            """,
            (session_id,),
        ).fetchone()
        if row is None:
            return None
        return self._conversation_tree_payload(row)

    def _compose_lineage_messages(self, chain: list[JsonObject]) -> list[JsonObject]:
        messages: list[JsonObject] = []
        for index, node in enumerate(chain):
            node_messages = node.get("messages")
            if not isinstance(node_messages, list):
                continue
            start = self._lineage_segment_start(node, index)
            end = self._lineage_segment_end(chain, index, len(node_messages))
            if start < 0 or end < start or end > len(node_messages):
                raise ValueError("Conversation lineage contains an invalid fork point.")
            self._append_lineage_segment(messages, node_messages[start:end])
        return messages

    @staticmethod
    def _lineage_segment_start(node: JsonObject, index: int) -> int:
        if index == 0:
            return 0
        fork_point = node.get("fork_point")
        return fork_point if isinstance(fork_point, int) else 0

    @staticmethod
    def _lineage_segment_end(
        chain: list[JsonObject],
        index: int,
        message_count: int,
    ) -> int:
        if index >= len(chain) - 1:
            return message_count
        next_fork_point = chain[index + 1].get("fork_point")
        return next_fork_point if isinstance(next_fork_point, int) else message_count

    def _append_lineage_segment(
        self,
        messages: list[JsonObject],
        segment: list[object],
    ) -> None:
        for item in segment:
            if not isinstance(item, dict):
                continue
            message = cast(JsonObject, item)
            if self._is_repeated_boundary_user_message(messages, message):
                continue
            messages.append(message)

    @staticmethod
    def _is_repeated_boundary_user_message(
        messages: list[JsonObject],
        message: JsonObject,
    ) -> bool:
        if not messages:
            return False
        previous = messages[-1]
        return (
            previous.get("role") == "user"
            and message.get("role") == "user"
            and previous.get("content") == message.get("content")
        )

    def save_conversation_tree(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        parent_id: str | None,
        fork_point: int | None,
    ) -> None:
        def write(connection: sqlite3.Connection) -> None:
            self._touch_session(
                connection,
                session_id=session_id,
                workspace_root=workspace_root,
                thread_id=thread_id,
            )
            connection.execute(
                """
                INSERT INTO conversation_trees (
                    session_id,
                    parent_id,
                    fork_point,
                    updated_at
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    parent_id = excluded.parent_id,
                    fork_point = excluded.fork_point,
                    updated_at = excluded.updated_at
                """,
                (session_id, parent_id, fork_point, self._timestamp()),
            )

        self._execute_write(write)

    def load_conversation_tree(self, session_id: str) -> JsonObject | None:
        with self._connect() as connection:
            row = self._load_conversation_tree_row(connection, session_id)
        if row is None:
            return None
        return row

    @staticmethod
    def _conversation_tree_payload(row: sqlite3.Row) -> JsonObject:
        fork_point = row["fork_point"]
        return {
            "session_id": str(row["session_id"]),
            "parent_id": None if row["parent_id"] is None else str(row["parent_id"]),
            "fork_point": fork_point if isinstance(fork_point, int) else None,
        }

    def append_history_items(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        items: list[JsonObject],
    ) -> None:
        def write(connection: sqlite3.Connection) -> None:
            self._touch_session(
                connection,
                session_id=session_id,
                workspace_root=workspace_root,
                thread_id=thread_id,
            )
            connection.executemany(
                """
                INSERT INTO history_items (session_id, item_id, payload_json)
                VALUES (?, ?, ?)
                """,
                [
                    (session_id, str(item["id"]), self._dump_payload(item))
                    for item in items
                ],
            )

        self._execute_write(write)

    def replace_history_items(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        items: list[JsonObject],
    ) -> None:
        def write(connection: sqlite3.Connection) -> None:
            self._touch_session(
                connection,
                session_id=session_id,
                workspace_root=workspace_root,
                thread_id=thread_id,
            )
            connection.execute(
                "DELETE FROM history_items WHERE session_id = ?",
                (session_id,),
            )
            connection.executemany(
                """
                INSERT INTO history_items (session_id, item_id, payload_json)
                VALUES (?, ?, ?)
                """,
                [
                    (session_id, str(item["id"]), self._dump_payload(item))
                    for item in items
                ],
            )

        self._execute_write(write)

    def load_history_items(self, session_id: str) -> list[JsonObject]:
        with self._connect() as connection:
            rows = list(
                connection.execute(
                    """
                    SELECT payload_json
                    FROM history_items
                    WHERE session_id = ?
                    ORDER BY sequence_no
                    """,
                    (session_id,),
                ).fetchall()
            )
        return self._load_object_rows(rows)

    def append_turn_rollout(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        rollout: JsonObject,
    ) -> None:
        def write(connection: sqlite3.Connection) -> None:
            self._touch_session(
                connection,
                session_id=session_id,
                workspace_root=workspace_root,
                thread_id=thread_id,
            )
            connection.execute(
                """
                INSERT INTO turn_rollouts (session_id, turn_id, payload_json)
                VALUES (?, ?, ?)
                """,
                (session_id, str(rollout["turn_id"]), self._dump_payload(rollout)),
            )

        self._execute_write(write)

    def load_turn_rollouts(self, session_id: str) -> list[JsonObject]:
        with self._connect() as connection:
            rows = list(
                connection.execute(
                    """
                    SELECT payload_json
                    FROM turn_rollouts
                    WHERE session_id = ?
                    ORDER BY sequence_no
                    """,
                    (session_id,),
                ).fetchall()
            )
        return self._load_object_rows(rows)

    def save_state(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        state_key: str,
        payload: JsonObject | JsonArray,
    ) -> None:
        def write(connection: sqlite3.Connection) -> None:
            self._touch_session(
                connection,
                session_id=session_id,
                workspace_root=workspace_root,
                thread_id=thread_id,
            )
            connection.execute(
                """
                INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(session_id, state_key) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at
                """,
                (
                    session_id,
                    state_key,
                    self._dump_payload(payload),
                    self._timestamp(),
                ),
            )

        self._execute_write(write)

    def load_state(self, session_id: str, state_key: str) -> JsonObject | JsonArray | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT payload_json
                FROM session_state
                WHERE session_id = ? AND state_key = ?
                """,
                (session_id, state_key),
            ).fetchone()
        if row is None:
            return None
        payload = json.loads(str(row["payload_json"]))
        if isinstance(payload, dict):
            return cast(JsonObject, payload)
        if isinstance(payload, list):
            return payload
        raise ValueError("Session state payload must deserialize to an object or list.")

    def delete_state(self, session_id: str, state_key: str) -> None:
        def write(connection: sqlite3.Connection) -> None:
            connection.execute(
                "DELETE FROM session_state WHERE session_id = ? AND state_key = ?",
                (session_id, state_key),
            )

        self._execute_write(write)

    def append_session_summary(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        summary: str,
    ) -> None:
        def write(connection: sqlite3.Connection) -> None:
            self._touch_session(
                connection,
                session_id=session_id,
                workspace_root=workspace_root,
                thread_id=thread_id,
            )
            connection.execute(
                """
                INSERT INTO session_summaries (session_id, summary_text, created_at)
                VALUES (?, ?, ?)
                """,
                (session_id, summary, self._timestamp()),
            )

        self._execute_write(write)

    def load_session_summaries(self, session_id: str) -> list[str]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT summary_text
                FROM session_summaries
                WHERE session_id = ?
                ORDER BY summary_index
                """,
                (session_id,),
            ).fetchall()
        return [str(row["summary_text"]) for row in rows]

    def list_sessions(
        self,
        *,
        workspace_root: Path | None = None,
        limit: int = 20,
    ) -> tuple[SessionOverview, ...]:
        query = """
            SELECT
                sessions.session_id,
                sessions.workspace_root,
                sessions.thread_id,
                sessions.created_at,
                sessions.updated_at,
                sessions.last_active_at,
                sessions.status,
                COUNT(DISTINCT conversation_messages.message_index) AS message_count,
                COUNT(DISTINCT session_summaries.summary_index) AS summary_count
            FROM sessions
            LEFT JOIN conversation_messages
                ON conversation_messages.session_id = sessions.session_id
            LEFT JOIN session_summaries
                ON session_summaries.session_id = sessions.session_id
        """
        parameters: list[object] = []
        if workspace_root is not None:
            query += " WHERE sessions.workspace_root = ?"
            parameters.append(str(workspace_root))
        query += """
            GROUP BY
                sessions.session_id,
                sessions.workspace_root,
                sessions.thread_id,
                sessions.created_at,
                sessions.updated_at,
                sessions.last_active_at,
                sessions.status
            ORDER BY sessions.last_active_at DESC, sessions.session_id DESC
            LIMIT ?
        """
        parameters.append(limit)
        with self._connect() as connection:
            rows = connection.execute(query, parameters).fetchall()
        return tuple(
            SessionOverview(
                session_id=str(row["session_id"]),
                workspace_root=Path(str(row["workspace_root"])),
                thread_id=str(row["thread_id"]),
                created_at=str(row["created_at"]),
                updated_at=str(row["updated_at"]),
                last_active_at=str(row["last_active_at"]),
                status=str(row["status"]),
                message_count=int(row["message_count"]),
                summary_count=int(row["summary_count"]),
            )
            for row in rows
        )

    def session_maintenance_report(
        self,
        *,
        workspace_root: Path | None = None,
        candidate_limit: int = 5,
    ) -> SessionMaintenanceReport:
        parameters: list[object] = []
        where_clause = ""
        if workspace_root is not None:
            where_clause = "WHERE sessions.workspace_root = ?"
            parameters.append(str(workspace_root))
        normalized_candidate_limit = max(candidate_limit, 0)
        with self._connect() as connection:
            session_count = int(
                connection.execute(
                    f"SELECT COUNT(*) AS count FROM sessions {where_clause}",
                    parameters,
                ).fetchone()["count"]
            )
            empty_session_count = int(
                connection.execute(
                    f"""
                    SELECT COUNT(*) AS count
                    FROM (
                        SELECT sessions.session_id
                        FROM sessions
                        LEFT JOIN conversation_messages
                            ON conversation_messages.session_id = sessions.session_id
                        LEFT JOIN session_summaries
                            ON session_summaries.session_id = sessions.session_id
                        LEFT JOIN history_items
                            ON history_items.session_id = sessions.session_id
                        LEFT JOIN turn_rollouts
                            ON turn_rollouts.session_id = sessions.session_id
                        LEFT JOIN session_state
                            ON session_state.session_id = sessions.session_id
                        {where_clause}
                        GROUP BY sessions.session_id
                        HAVING COUNT(conversation_messages.message_index) = 0
                           AND COUNT(session_summaries.summary_index) = 0
                           AND COUNT(history_items.sequence_no) = 0
                           AND COUNT(turn_rollouts.sequence_no) = 0
                           AND COUNT(session_state.state_key) = 0
                    )
                    """,
                    parameters,
                ).fetchone()["count"]
            )
            candidate_rows = connection.execute(
                f"""
                SELECT session_id, last_active_at, status
                FROM (
                    SELECT
                        sessions.session_id,
                        sessions.last_active_at,
                        sessions.status,
                        COUNT(conversation_messages.message_index) AS message_count,
                        COUNT(session_summaries.summary_index) AS summary_count,
                        COUNT(history_items.sequence_no) AS history_count,
                        COUNT(turn_rollouts.sequence_no) AS rollout_count,
                        COUNT(session_state.state_key) AS state_count
                    FROM sessions
                    LEFT JOIN conversation_messages
                        ON conversation_messages.session_id = sessions.session_id
                    LEFT JOIN session_summaries
                        ON session_summaries.session_id = sessions.session_id
                    LEFT JOIN history_items
                        ON history_items.session_id = sessions.session_id
                    LEFT JOIN turn_rollouts
                        ON turn_rollouts.session_id = sessions.session_id
                    LEFT JOIN session_state
                        ON session_state.session_id = sessions.session_id
                    {where_clause}
                    GROUP BY sessions.session_id, sessions.last_active_at, sessions.status
                    HAVING message_count = 0
                       AND summary_count = 0
                       AND history_count = 0
                       AND rollout_count = 0
                       AND state_count = 0
                )
                ORDER BY last_active_at ASC, session_id ASC
                LIMIT ?
                """,
                [*parameters, normalized_candidate_limit],
            ).fetchall()
            page_count = int(connection.execute("PRAGMA page_count").fetchone()[0])
            freelist_count = int(connection.execute("PRAGMA freelist_count").fetchone()[0])
            page_size = int(connection.execute("PRAGMA page_size").fetchone()[0])
        db_size_bytes = self._db_path.stat().st_size if self._db_path.exists() else 0
        candidates = tuple(
            SessionMaintenanceCandidate(
                session_id=str(row["session_id"]),
                last_active_at=str(row["last_active_at"]),
                status=str(row["status"]),
            )
            for row in candidate_rows
        )
        return SessionMaintenanceReport(
            workspace_session_count=session_count,
            empty_session_count=empty_session_count,
            empty_session_candidates=candidates,
            empty_session_candidates_omitted=max(empty_session_count - len(candidates), 0),
            db_size_bytes=db_size_bytes,
            page_count=page_count,
            freelist_count=freelist_count,
            page_size=page_size,
        )
