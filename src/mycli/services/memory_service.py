from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

from mycli.domain.memory import MemoryKind, MemoryRecord
from mycli.domain.session_store import SessionStore
from mycli.infrastructure.filesystem import read_json, write_json
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore


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
        payload = read_json(self._project_notes_path, [])
        lowered = query.lower()
        matches: list[MemoryRecord] = []
        for item in payload:
            if lowered in item["key"].lower() or lowered in item["value"].lower():
                matches.append(
                    MemoryRecord(
                        kind=MemoryKind(item["kind"]),
                        key=item["key"],
                        value=item["value"],
                        tags=tuple(item.get("tags", [])),
                    )
                )
        return matches

    def append_session_summary(self, session_id: str, summary: str) -> None:
        self._session_store.append_session_summary(
            session_id=session_id,
            workspace_root=self._workspace_root,
            thread_id=session_id,
            summary=summary,
        )

    def load_session_summaries(self, session_id: str) -> list[str]:
        return self._session_store.load_session_summaries(session_id)

    def list_records(self, session_id: str | None = None) -> tuple[MemoryRecord, ...]:
        records: list[MemoryRecord] = [
            MemoryRecord(kind=MemoryKind.PREFERENCE, key=key, value=value)
            for key, value in self.load_preferences().items()
        ]
        records.extend(self.search_project_notes(""))
        if session_id is not None:
            records.extend(
                MemoryRecord(
                    kind=MemoryKind.SESSION_SUMMARY,
                    key="recent",
                    value=value,
                )
                for value in self.load_session_summaries(session_id)
            )
        return tuple(records)

    def query_records(
        self,
        query: str,
        *,
        session_id: str | None = None,
        kinds: tuple[MemoryKind, ...] | None = None,
        limit: int | None = None,
    ) -> tuple[MemoryRecord, ...]:
        lowered = query.lower().strip()
        terms = tuple(term for term in lowered.split() if term)
        matches: list[MemoryRecord] = []
        for record in self.list_records(session_id):
            if kinds is not None and record.kind not in kinds:
                continue
            if not terms:
                matches.append(record)
                continue
            searchable = " ".join((record.key, record.value, *record.tags)).lower()
            if any(term in searchable for term in terms):
                matches.append(record)
        if limit is not None:
            matches = matches[:limit]
        return tuple(matches)

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
        return preference_records + project_records
