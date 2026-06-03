from __future__ import annotations

import re
import sqlite3
import threading
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable, Iterator

from mycli.domain.memory import MemoryKind, MemoryRecord
from mycli.domain.session_store import SessionStore
from mycli.infrastructure.filesystem import read_json, write_json
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore


_TOKEN_PATTERN = re.compile(r"[a-z0-9_./-]+")
_SHORT_TERM_LIMIT = 100


class MemoryService:
    def __init__(
        self,
        home_dir: Path,
        workspace_root: Path,
        session_store: SessionStore | None = None,
    ) -> None:
        self._workspace_root = workspace_root
        self._preferences_path = home_dir / ".mycli" / "preferences.json"
        self._project_notes_path = workspace_root / ".mycli" / "project_memory.json"
        self._session_store = session_store or SQLiteSessionStore(home_dir / ".mycli" / "sessions.db")
        self._short_term_db_path = home_dir / ".mycli" / "memory.db"
        self._short_term_db_path.parent.mkdir(parents=True, exist_ok=True)
        self._transient_records: dict[str, list[MemoryRecord]] = {}
        self._transient_lock = threading.Lock()
        self._initialize_short_term_store()

    def _initialize_short_term_store(self) -> None:
        with self._connect_short_term() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS short_term_memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    key TEXT NOT NULL,
                    value TEXT NOT NULL,
                    tags TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_short_term_memories_session
                ON short_term_memories(session_id, id)
                """
            )

    def _connect_short_term(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._short_term_db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _timestamp(self) -> str:
        return datetime.now(UTC).isoformat()

    def load_preferences(self) -> dict[str, str]:
        return dict(read_json(self._preferences_path, {}))

    def save_preference(self, key: str, value: str) -> None:
        payload = self.load_preferences()
        payload[key] = value
        write_json(self._preferences_path, payload)

    def save_project_note(self, record: MemoryRecord) -> None:
        payload = list(read_json(self._project_notes_path, []))
        payload.append(asdict(record))
        write_json(self._project_notes_path, payload)

    def search_project_notes(self, query: str) -> list[MemoryRecord]:
        records = self._load_project_notes()
        if not query.strip():
            return list(records)
        return list(self._rank_records(query, records))

    def remember_transient(self, session_id: str, record: MemoryRecord) -> None:
        with self._transient_lock:
            records = self._transient_records.setdefault(session_id, [])
            records.append(record)

    def remember_short_term(self, session_id: str, record: MemoryRecord) -> None:
        with self._connect_short_term() as connection:
            connection.execute(
                """
                INSERT INTO short_term_memories (session_id, kind, key, value, tags, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    record.kind.value,
                    record.key,
                    record.value,
                    "\n".join(record.tags),
                    self._timestamp(),
                ),
            )
            connection.execute(
                """
                DELETE FROM short_term_memories
                WHERE session_id = ?
                  AND id NOT IN (
                      SELECT id
                      FROM short_term_memories
                      WHERE session_id = ?
                      ORDER BY id DESC
                      LIMIT ?
                  )
                """,
                (session_id, session_id, _SHORT_TERM_LIMIT),
            )
            connection.commit()

    def remember_short_term_async(self, session_id: str, record: MemoryRecord) -> threading.Thread:
        thread = threading.Thread(
            target=self.remember_short_term,
            args=(session_id, record),
            daemon=True,
        )
        thread.start()
        return thread

    def append_session_summary(self, session_id: str, summary: str) -> None:
        self._session_store.append_session_summary(
            session_id=session_id,
            workspace_root=self._workspace_root,
            thread_id=session_id,
            summary=summary,
        )

    def load_session_summaries(self, session_id: str) -> list[str]:
        return self._session_store.load_session_summaries(session_id)

    def _load_project_notes(self) -> tuple[MemoryRecord, ...]:
        payload = read_json(self._project_notes_path, [])
        records: list[MemoryRecord] = []
        for item in payload:
            records.append(
                MemoryRecord(
                    kind=MemoryKind(item["kind"]),
                    key=item["key"],
                    value=item["value"],
                    tags=tuple(item.get("tags", [])),
                )
            )
        return tuple(records)

    def _load_transient_records(self, session_id: str | None) -> tuple[MemoryRecord, ...]:
        if session_id is None:
            return ()
        with self._transient_lock:
            return tuple(self._transient_records.get(session_id, ()))

    def _load_short_term_records(self, session_id: str | None) -> tuple[MemoryRecord, ...]:
        if session_id is None:
            return ()
        with self._connect_short_term() as connection:
            rows = connection.execute(
                """
                SELECT kind, key, value, tags
                FROM short_term_memories
                WHERE session_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (session_id, _SHORT_TERM_LIMIT),
            ).fetchall()
        return tuple(
            MemoryRecord(
                kind=MemoryKind(str(row["kind"])),
                key=str(row["key"]),
                value=str(row["value"]),
                tags=tuple(tag for tag in str(row["tags"]).splitlines() if tag),
            )
            for row in rows
        )

    def _session_summary_records(self, session_id: str | None) -> tuple[MemoryRecord, ...]:
        if session_id is None:
            return ()
        return tuple(
            MemoryRecord(
                kind=MemoryKind.SESSION_SUMMARY,
                key="recent",
                value=value,
            )
            for value in self.load_session_summaries(session_id)
        )

    def list_records(self, session_id: str | None = None) -> tuple[MemoryRecord, ...]:
        records: list[MemoryRecord] = [
            MemoryRecord(kind=MemoryKind.PREFERENCE, key=key, value=value)
            for key, value in self.load_preferences().items()
        ]
        records.extend(self._load_transient_records(session_id))
        records.extend(self._load_short_term_records(session_id))
        records.extend(self._load_project_notes())
        records.extend(self._session_summary_records(session_id))
        return self._deduplicate(records)

    def query_records(
        self,
        query: str,
        *,
        session_id: str | None = None,
        kinds: tuple[MemoryKind, ...] | None = None,
        limit: int | None = None,
    ) -> tuple[MemoryRecord, ...]:
        candidates: list[MemoryRecord] = []
        for record in self.list_records(session_id):
            if kinds is not None and record.kind not in kinds:
                continue
            candidates.append(record)
        matches = self._rank_records(query, candidates)
        if limit is None:
            return matches
        return matches[:limit]

    def collect_runtime_context(
        self,
        *,
        user_message: str,
        session_id: str,
    ) -> tuple[MemoryRecord, ...]:
        preference_records = tuple(
            MemoryRecord(kind=MemoryKind.PREFERENCE, key=key, value=value)
            for key, value in self.load_preferences().items()
        )
        project_records: tuple[MemoryRecord, ...] = ()
        lowered = user_message.lower()
        if any(token in lowered for token in ("repo", "repository", "project", "entrypoint")):
            project_records = self.query_records(
                "entry",
                session_id=session_id,
                kinds=(MemoryKind.PROJECT_NOTE,),
                limit=5,
            )
        session_summary_records = self._session_summary_records(session_id)
        return self._deduplicate(
            (*preference_records, *project_records, *session_summary_records)
        )

    def _rank_records(
        self,
        query: str,
        records: Iterable[MemoryRecord],
    ) -> tuple[MemoryRecord, ...]:
        query_tokens = self._tokens(query)
        deduplicated = self._deduplicate(records)
        if not query_tokens:
            return deduplicated
        scored: list[tuple[float, int, MemoryRecord]] = []
        for index, record in enumerate(deduplicated):
            score = self._score_record(query_tokens, record)
            if score > 0:
                scored.append((score, index, record))
        scored.sort(key=lambda item: (-item[0], item[1]))
        return tuple(record for _, _, record in scored)

    def _score_record(self, query_tokens: frozenset[str], record: MemoryRecord) -> float:
        key_tokens = self._tokens(record.key)
        value_tokens = self._tokens(record.value)
        tag_tokens = frozenset(token for tag in record.tags for token in self._tokens(tag))
        record_tokens = key_tokens | value_tokens | tag_tokens
        if not record_tokens:
            return 0
        key_matches = self._field_matches(query_tokens, key_tokens)
        value_matches = self._field_matches(query_tokens, value_tokens)
        tag_matches = self._field_matches(query_tokens, tag_tokens)
        overlap = key_matches | value_matches | tag_matches
        if not overlap:
            return 0
        coverage = len(overlap) / len(query_tokens)
        density = len(overlap) / len(record_tokens)
        weighted_fields = (
            2.0 * len(key_matches)
            + 1.5 * len(tag_matches)
            + len(value_matches)
        )
        return coverage * 10.0 + density + weighted_fields

    def _field_matches(
        self,
        query_tokens: frozenset[str],
        field_tokens: frozenset[str],
    ) -> frozenset[str]:
        return frozenset(
            query_token
            for query_token in query_tokens
            if any(
                query_token == field_token
                or query_token in field_token
                or field_token in query_token
                for field_token in field_tokens
            )
        )

    def _deduplicate(self, records: Iterable[MemoryRecord]) -> tuple[MemoryRecord, ...]:
        seen: set[tuple[MemoryKind, str, str]] = set()
        deduplicated: list[MemoryRecord] = []
        for record in records:
            identity = (
                record.kind,
                self._normalize_text(record.key),
                self._normalize_text(record.value),
            )
            if identity in seen:
                continue
            seen.add(identity)
            deduplicated.append(record)
        return tuple(deduplicated)

    def _tokens(self, text: str) -> frozenset[str]:
        return frozenset(_TOKEN_PATTERN.findall(text.lower()))

    def _normalize_text(self, text: str) -> str:
        return " ".join(self._token_iterator(text))

    def _token_iterator(self, text: str) -> Iterator[str]:
        return iter(_TOKEN_PATTERN.findall(text.lower()))
