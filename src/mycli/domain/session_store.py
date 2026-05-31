from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, TypeAlias


JsonObject: TypeAlias = dict[str, Any]
JsonArray: TypeAlias = list[Any]


@dataclass(slots=True, frozen=True)
class SessionOverview:
    session_id: str
    workspace_root: Path
    thread_id: str
    created_at: str
    updated_at: str
    last_active_at: str
    status: str
    message_count: int
    summary_count: int


@dataclass(slots=True, frozen=True)
class SessionSearchResult:
    session_id: str
    message_index: int
    role: str
    snippet: str


@dataclass(slots=True, frozen=True)
class SessionMaintenanceReport:
    workspace_session_count: int
    empty_session_count: int
    db_size_bytes: int
    page_count: int
    freelist_count: int
    page_size: int
    dry_run: bool = True


class SessionStore(Protocol):
    def replace_conversation(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        messages: list[JsonObject],
    ) -> None: ...

    def load_conversation(self, session_id: str) -> list[JsonObject] | None: ...

    def resolve_resume_session_id(self, session_id: str) -> str: ...

    def load_conversation_lineage(self, session_id: str) -> list[JsonObject]: ...

    def search_messages(
        self,
        query: str,
        *,
        workspace_root: Path | None = None,
        limit: int = 20,
    ) -> tuple[SessionSearchResult, ...]: ...

    def save_conversation_tree(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        parent_id: str | None,
        fork_point: int | None,
    ) -> None: ...

    def load_conversation_tree(self, session_id: str) -> JsonObject | None: ...

    def append_history_items(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        items: list[JsonObject],
    ) -> None: ...

    def replace_history_items(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        items: list[JsonObject],
    ) -> None: ...

    def load_history_items(self, session_id: str) -> list[JsonObject]: ...

    def append_turn_rollout(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        rollout: JsonObject,
    ) -> None: ...

    def load_turn_rollouts(self, session_id: str) -> list[JsonObject]: ...

    def save_state(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        state_key: str,
        payload: JsonObject | JsonArray,
    ) -> None: ...

    def load_state(self, session_id: str, state_key: str) -> JsonObject | JsonArray | None: ...

    def delete_state(self, session_id: str, state_key: str) -> None: ...

    def append_session_summary(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        summary: str,
    ) -> None: ...

    def load_session_summaries(self, session_id: str) -> list[str]: ...

    def list_sessions(
        self,
        *,
        workspace_root: Path | None = None,
        limit: int = 20,
    ) -> tuple[SessionOverview, ...]: ...

    def session_maintenance_report(
        self,
        *,
        workspace_root: Path | None = None,
    ) -> SessionMaintenanceReport: ...
