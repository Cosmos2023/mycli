from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterator, cast

from mycli.domain.session_store import JsonArray, JsonObject, SessionOverview


class SQLiteSessionStore:
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self._db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def _timestamp(self) -> str:
        return datetime.now(UTC).isoformat()

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
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
        with self._connect() as connection:
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

    def load_conversation(self, session_id: str) -> list[JsonObject] | None:
        with self._connect() as connection:
            rows = list(
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
        if not rows:
            return None
        return self._load_object_rows(rows)

    def append_history_items(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        items: list[JsonObject],
    ) -> None:
        with self._connect() as connection:
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

    def replace_history_items(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        items: list[JsonObject],
    ) -> None:
        with self._connect() as connection:
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
        with self._connect() as connection:
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
        with self._connect() as connection:
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
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM session_state WHERE session_id = ? AND state_key = ?",
                (session_id, state_key),
            )

    def append_session_summary(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        summary: str,
    ) -> None:
        with self._connect() as connection:
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
