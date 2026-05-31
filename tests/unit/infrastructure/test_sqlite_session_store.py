from __future__ import annotations

import sqlite3
from types import SimpleNamespace
from pathlib import Path
from typing import Any

import pytest

import mycli.infrastructure.sqlite_session_store as sqlite_session_store
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore


class _ConnectionProxy:
    def __init__(self, connection: sqlite3.Connection) -> None:
        object.__setattr__(self, "_connection", connection)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)

    def __setattr__(self, name: str, value: Any) -> None:
        setattr(self._connection, name, value)

    def execute(self, sql: str, parameters: object = ()) -> sqlite3.Cursor:
        if isinstance(parameters, tuple | list):
            return self._connection.execute(sql, parameters)
        return self._connection.execute(sql)


class _FakePragmaConnection:
    def __init__(self) -> None:
        self.statements: list[str] = []
        self.row_factory: object = None

    def execute(self, sql: str, parameters: object = ()) -> object:
        del parameters
        statement = " ".join(sql.strip().split())
        self.statements.append(statement)
        if statement.upper() == "PRAGMA JOURNAL_MODE=WAL":
            raise sqlite3.OperationalError("locking protocol")
        return object()

    def executescript(self, sql: str) -> None:
        self.statements.append("executescript")

    def commit(self) -> None:
        self.statements.append("commit")

    def rollback(self) -> None:
        self.statements.append("rollback")

    def close(self) -> None:
        self.statements.append("close")


def test_sqlite_session_store_uses_wal_journal_mode(tmp_path: Path) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"

    SQLiteSessionStore(db_path)

    with sqlite3.connect(db_path) as connection:
        journal_mode = connection.execute("PRAGMA journal_mode").fetchone()
    assert journal_mode is not None
    assert journal_mode[0] == "wal"


def test_sqlite_session_store_falls_back_to_delete_when_wal_is_unsupported(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    fake_connection = _FakePragmaConnection()

    def fake_connect(*args: object, **kwargs: object) -> _FakePragmaConnection:
        del args, kwargs
        return fake_connection

    monkeypatch.setattr(sqlite_session_store.sqlite3, "connect", fake_connect)

    SQLiteSessionStore(tmp_path / "home" / ".mycli" / "sessions.db")

    assert "PRAGMA journal_mode=WAL" in fake_connection.statements
    assert "PRAGMA journal_mode=DELETE" in fake_connection.statements


def test_sqlite_session_store_retries_locked_write_transactions(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"
    store = SQLiteSessionStore(db_path)
    real_connect = sqlite_session_store.sqlite3.connect
    begin_attempts = 0

    class FlakyBeginConnection(_ConnectionProxy):
        def execute(self, sql: str, parameters: object = ()) -> sqlite3.Cursor:
            nonlocal begin_attempts
            if sql.strip().upper() == "BEGIN IMMEDIATE":
                begin_attempts += 1
                if begin_attempts < 3:
                    raise sqlite3.OperationalError("database is locked")
            return super().execute(sql, parameters)

    def flaky_connect(*args: object, **kwargs: object) -> FlakyBeginConnection:
        connection = real_connect(*args, **kwargs)
        return FlakyBeginConnection(connection)

    monkeypatch.setattr(sqlite_session_store.sqlite3, "connect", flaky_connect)
    monkeypatch.setattr(
        sqlite_session_store,
        "time",
        SimpleNamespace(sleep=lambda _seconds: None),
        raising=False,
    )

    store.replace_conversation(
        session_id="demo",
        workspace_root=tmp_path / "workspace",
        thread_id="thread_demo",
        messages=[],
    )

    assert begin_attempts == 3


def test_sqlite_session_store_checkpoints_wal_after_successful_writes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"
    store = SQLiteSessionStore(db_path)
    real_connect = sqlite_session_store.sqlite3.connect
    checkpoint_count = 0

    class CheckpointTrackingConnection(_ConnectionProxy):
        def execute(self, sql: str, parameters: object = ()) -> sqlite3.Cursor:
            nonlocal checkpoint_count
            if " ".join(sql.strip().split()).upper() == "PRAGMA WAL_CHECKPOINT(PASSIVE)":
                checkpoint_count += 1
            return super().execute(sql, parameters)

    def tracking_connect(*args: object, **kwargs: object) -> CheckpointTrackingConnection:
        connection = real_connect(*args, **kwargs)
        return CheckpointTrackingConnection(connection)

    monkeypatch.setattr(sqlite_session_store.sqlite3, "connect", tracking_connect)
    monkeypatch.setattr(SQLiteSessionStore, "_CHECKPOINT_EVERY_N_WRITES", 2, raising=False)

    for session_id in ("one", "two"):
        store.replace_conversation(
            session_id=session_id,
            workspace_root=tmp_path / "workspace",
            thread_id=f"thread_{session_id}",
            messages=[],
        )

    assert checkpoint_count == 1


def test_sqlite_session_store_records_schema_version(tmp_path: Path) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"

    SQLiteSessionStore(db_path)

    with sqlite3.connect(db_path) as connection:
        row = connection.execute("SELECT version FROM schema_version").fetchone()
    assert row is not None
    assert row[0] == SQLiteSessionStore.SCHEMA_VERSION


def test_sqlite_session_store_adds_schema_version_to_legacy_db_without_losing_messages(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"
    db_path.parent.mkdir(parents=True)
    with sqlite3.connect(db_path) as connection:
        connection.executescript(
            """
            CREATE TABLE sessions (
                session_id TEXT PRIMARY KEY,
                workspace_root TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_active_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active'
            );

            CREATE TABLE conversation_messages (
                session_id TEXT NOT NULL,
                message_index INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                PRIMARY KEY (session_id, message_index),
                FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
            );
            """
        )
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
            VALUES ('legacy', '/tmp/workspace', 'legacy', 'now', 'now', 'now', 'active')
            """
        )
        connection.execute(
            """
            INSERT INTO conversation_messages (session_id, message_index, payload_json)
            VALUES ('legacy', 0, ?)
            """,
            ('{"role": "user", "content": "hello"}',),
        )

    store = SQLiteSessionStore(db_path)

    assert store.load_conversation("legacy") == [{"role": "user", "content": "hello"}]
    with sqlite3.connect(db_path) as connection:
        row = connection.execute("SELECT version FROM schema_version").fetchone()
    assert row is not None
    assert row[0] == SQLiteSessionStore.SCHEMA_VERSION


def test_sqlite_session_store_resolves_resume_session_to_descendant_tip(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"
    workspace = tmp_path / "workspace"
    store = SQLiteSessionStore(db_path)

    for session_id, parent_id in (
        ("root", None),
        ("child", "root"),
        ("grandchild", "child"),
    ):
        store.replace_conversation(
            session_id=session_id,
            workspace_root=workspace,
            thread_id=session_id,
            messages=[],
        )
        store.save_conversation_tree(
            session_id=session_id,
            workspace_root=workspace,
            thread_id=session_id,
            parent_id=parent_id,
            fork_point=None,
        )

    assert store.resolve_resume_session_id("root") == "grandchild"
    assert store.resolve_resume_session_id("child") == "grandchild"
    assert store.resolve_resume_session_id("grandchild") == "grandchild"


def test_sqlite_session_store_loads_fork_lineage_without_duplicating_parent_prefix(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"
    workspace = tmp_path / "workspace"
    store = SQLiteSessionStore(db_path)
    store.replace_conversation(
        session_id="root",
        workspace_root=workspace,
        thread_id="root",
        messages=[
            {"role": "user", "content": "one"},
            {"role": "assistant", "content": "two"},
            {"role": "user", "content": "root-only"},
        ],
    )
    store.save_conversation_tree(
        session_id="root",
        workspace_root=workspace,
        thread_id="root",
        parent_id=None,
        fork_point=None,
    )
    store.replace_conversation(
        session_id="branch",
        workspace_root=workspace,
        thread_id="branch",
        messages=[
            {"role": "user", "content": "one"},
            {"role": "assistant", "content": "two"},
            {"role": "user", "content": "branch-only"},
        ],
    )
    store.save_conversation_tree(
        session_id="branch",
        workspace_root=workspace,
        thread_id="branch",
        parent_id="root",
        fork_point=2,
    )

    assert store.load_conversation_lineage("root") == [
        {"role": "user", "content": "one"},
        {"role": "assistant", "content": "two"},
        {"role": "user", "content": "branch-only"},
    ]


def test_sqlite_session_store_lineage_deduplicates_repeated_boundary_user_message(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"
    workspace = tmp_path / "workspace"
    store = SQLiteSessionStore(db_path)
    store.replace_conversation(
        session_id="root",
        workspace_root=workspace,
        thread_id="root",
        messages=[{"role": "user", "content": "continue this"}],
    )
    store.save_conversation_tree(
        session_id="root",
        workspace_root=workspace,
        thread_id="root",
        parent_id=None,
        fork_point=None,
    )
    store.replace_conversation(
        session_id="child",
        workspace_root=workspace,
        thread_id="child",
        messages=[
            {"role": "user", "content": "continue this"},
            {"role": "assistant", "content": "continued"},
        ],
    )
    store.save_conversation_tree(
        session_id="child",
        workspace_root=workspace,
        thread_id="child",
        parent_id="root",
        fork_point=None,
    )

    assert store.load_conversation_lineage("root") == [
        {"role": "user", "content": "continue this"},
        {"role": "assistant", "content": "continued"},
    ]


def test_sqlite_session_store_lineage_detects_cycles(tmp_path: Path) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"
    workspace = tmp_path / "workspace"
    store = SQLiteSessionStore(db_path)
    for session_id, parent_id in (("one", "two"), ("two", "one")):
        store.replace_conversation(
            session_id=session_id,
            workspace_root=workspace,
            thread_id=session_id,
            messages=[],
        )
        store.save_conversation_tree(
            session_id=session_id,
            workspace_root=workspace,
            thread_id=session_id,
            parent_id=parent_id,
            fork_point=None,
        )

    with pytest.raises(ValueError, match="cycle"):
        store.load_conversation_lineage("one")


def test_sqlite_session_store_lineage_rejects_child_fork_beyond_parent_messages(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"
    workspace = tmp_path / "workspace"
    store = SQLiteSessionStore(db_path)
    store.replace_conversation(
        session_id="root",
        workspace_root=workspace,
        thread_id="root",
        messages=[{"role": "user", "content": "root only"}],
    )
    store.save_conversation_tree(
        session_id="root",
        workspace_root=workspace,
        thread_id="root",
        parent_id=None,
        fork_point=None,
    )
    store.replace_conversation(
        session_id="child",
        workspace_root=workspace,
        thread_id="child",
        messages=[
            {"role": "user", "content": "root only"},
            {"role": "assistant", "content": "child branch"},
        ],
    )
    store.save_conversation_tree(
        session_id="child",
        workspace_root=workspace,
        thread_id="child",
        parent_id="root",
        fork_point=2,
    )

    with pytest.raises(ValueError, match="invalid fork point"):
        store.load_conversation_lineage("root")


def test_sqlite_session_store_searches_backfilled_conversation_messages(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"
    workspace = tmp_path / "workspace"
    store = SQLiteSessionStore(db_path)
    store.replace_conversation(
        session_id="demo",
        workspace_root=workspace,
        thread_id="demo",
        messages=[
            {"role": "user", "content": "inspect database migrations"},
            {"role": "assistant", "content": "WAL checkpoint configured"},
        ],
    )

    matches = store.search_messages("checkpoint", workspace_root=workspace)

    assert len(matches) == 1
    assert matches[0].session_id == "demo"
    assert matches[0].message_index == 1
    assert matches[0].role == "assistant"
    assert matches[0].snippet == "WAL checkpoint configured"


def test_sqlite_session_store_search_backfills_legacy_messages(tmp_path: Path) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"
    db_path.parent.mkdir(parents=True)
    workspace = tmp_path / "workspace"
    with sqlite3.connect(db_path) as connection:
        connection.executescript(
            """
            CREATE TABLE sessions (
                session_id TEXT PRIMARY KEY,
                workspace_root TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_active_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active'
            );

            CREATE TABLE conversation_messages (
                session_id TEXT NOT NULL,
                message_index INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                PRIMARY KEY (session_id, message_index),
                FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
            );
            """
        )
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
            VALUES ('legacy', ?, 'legacy', 'now', 'now', 'now', 'active')
            """,
            (str(workspace),),
        )
        connection.execute(
            """
            INSERT INTO conversation_messages (session_id, message_index, payload_json)
            VALUES ('legacy', 0, ?)
            """,
            ('{"role": "user", "content": "legacy searchable message"}',),
        )

    store = SQLiteSessionStore(db_path)

    matches = store.search_messages("searchable", workspace_root=workspace)

    assert [match.session_id for match in matches] == ["legacy"]


def test_sqlite_session_store_search_returns_bounded_snippets(tmp_path: Path) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"
    workspace = tmp_path / "workspace"
    store = SQLiteSessionStore(db_path)
    store.replace_conversation(
        session_id="demo",
        workspace_root=workspace,
        thread_id="demo",
        messages=[
            {
                "role": "user",
                "content": f"{'prefix ' * 40}needle {'suffix ' * 40}",
            },
        ],
    )

    matches = store.search_messages("needle", workspace_root=workspace)

    assert len(matches) == 1
    assert "needle" in matches[0].snippet
    assert len(matches[0].snippet) <= 160


def test_sqlite_session_store_search_escapes_quoted_query_tokens(tmp_path: Path) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"
    workspace = tmp_path / "workspace"
    store = SQLiteSessionStore(db_path)
    store.replace_conversation(
        session_id="demo",
        workspace_root=workspace,
        thread_id="demo",
        messages=[{"role": "user", "content": 'quoted "needle" phrase'}],
    )

    matches = store.search_messages('"needle"', workspace_root=workspace)

    assert len(matches) == 1
    assert matches[0].snippet == 'quoted "needle" phrase'


def test_sqlite_session_store_round_trips_runtime_payloads(tmp_path: Path) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"
    store = SQLiteSessionStore(db_path)

    store.replace_conversation(
        session_id="demo",
        workspace_root=tmp_path / "workspace",
        thread_id="thread_demo",
        messages=[
            {
                "role": "user",
                "content": "inspect repo",
                "tool_call_id": None,
                "response_id": None,
                "blocks": [],
                "tool_calls": [],
            }
        ],
    )
    store.save_conversation_tree(
        session_id="demo",
        workspace_root=tmp_path / "workspace",
        thread_id="thread_demo",
        parent_id="root",
        fork_point=2,
    )
    store.append_history_items(
        session_id="demo",
        workspace_root=tmp_path / "workspace",
        thread_id="thread_demo",
        items=[
            {
                "id": "turn_1:item:1",
                "thread_id": "thread_demo",
                "turn_id": "turn_1",
                "type": "user_message",
                "text": "inspect repo",
                "tool_name": None,
                "call_id": None,
                "metadata": {},
            }
        ],
    )
    store.append_turn_rollout(
        session_id="demo",
        workspace_root=tmp_path / "workspace",
        thread_id="thread_demo",
        rollout={
            "thread_id": "thread_demo",
            "turn_id": "turn_1",
            "status": "completed",
            "started_at": "2026-04-22T00:00:00+00:00",
            "completed_at": "2026-04-22T00:00:01+00:00",
            "stop_reason": "assistant_completed",
            "events": [],
            "continuation_state": {"response_id": "resp_1", "eligible": True},
        },
    )
    store.save_state(
        session_id="demo",
        workspace_root=tmp_path / "workspace",
        thread_id="thread_demo",
        state_key="plan_state",
        payload={"items": [{"id": "inspect", "content": "Inspect repo", "status": "completed"}]},
    )
    store.append_session_summary(
        session_id="demo",
        workspace_root=tmp_path / "workspace",
        thread_id="thread_demo",
        summary="Inspection complete",
    )

    assert store.load_conversation("demo") == [
        {
            "role": "user",
            "content": "inspect repo",
            "tool_call_id": None,
            "response_id": None,
            "blocks": [],
            "tool_calls": [],
        }
    ]
    assert store.load_conversation_tree("demo") == {
        "session_id": "demo",
        "parent_id": "root",
        "fork_point": 2,
    }
    assert store.load_history_items("demo") == [
        {
            "id": "turn_1:item:1",
            "thread_id": "thread_demo",
            "turn_id": "turn_1",
            "type": "user_message",
            "text": "inspect repo",
            "tool_name": None,
            "call_id": None,
            "metadata": {},
        }
    ]
    assert store.load_turn_rollouts("demo") == [
        {
            "thread_id": "thread_demo",
            "turn_id": "turn_1",
            "status": "completed",
            "started_at": "2026-04-22T00:00:00+00:00",
            "completed_at": "2026-04-22T00:00:01+00:00",
            "stop_reason": "assistant_completed",
            "events": [],
            "continuation_state": {"response_id": "resp_1", "eligible": True},
        }
    ]
    assert store.load_state("demo", "plan_state") == {
        "items": [{"id": "inspect", "content": "Inspect repo", "status": "completed"}]
    }
    assert store.load_session_summaries("demo") == ["Inspection complete"]


def test_sqlite_session_store_lists_recent_sessions_for_workspace(tmp_path: Path) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"
    store = SQLiteSessionStore(db_path)
    workspace = tmp_path / "workspace"
    other_workspace = tmp_path / "other-workspace"

    store.replace_conversation(
        session_id="older",
        workspace_root=workspace,
        thread_id="thread_older",
        messages=[],
    )
    store.replace_conversation(
        session_id="newer",
        workspace_root=workspace,
        thread_id="thread_newer",
        messages=[],
    )
    store.replace_conversation(
        session_id="ignored",
        workspace_root=other_workspace,
        thread_id="thread_ignored",
        messages=[],
    )

    overviews = store.list_sessions(workspace_root=workspace)
    limited_overviews = store.list_sessions(workspace_root=workspace, limit=1)

    assert [overview.session_id for overview in overviews] == ["newer", "older"]
    assert all(overview.workspace_root == workspace for overview in overviews)
    assert [overview.session_id for overview in limited_overviews] == ["newer"]


def test_sqlite_session_store_reports_session_maintenance_dry_run(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"
    store = SQLiteSessionStore(db_path)
    workspace = tmp_path / "workspace"
    other_workspace = tmp_path / "other-workspace"

    store.replace_conversation(
        session_id="empty",
        workspace_root=workspace,
        thread_id="empty",
        messages=[],
    )
    store.replace_conversation(
        session_id="with-message",
        workspace_root=workspace,
        thread_id="with-message",
        messages=[{"role": "user", "content": "hello"}],
    )
    store.replace_conversation(
        session_id="with-summary",
        workspace_root=workspace,
        thread_id="with-summary",
        messages=[],
    )
    store.append_session_summary(
        session_id="with-summary",
        workspace_root=workspace,
        thread_id="with-summary",
        summary="summary",
    )
    store.replace_conversation(
        session_id="other-empty",
        workspace_root=other_workspace,
        thread_id="other-empty",
        messages=[],
    )

    report = store.session_maintenance_report(workspace_root=workspace)

    assert report.dry_run is True
    assert report.workspace_session_count == 3
    assert report.empty_session_count == 1
    assert [candidate.session_id for candidate in report.empty_session_candidates] == ["empty"]
    assert report.empty_session_candidates[0].status == "active"
    assert report.empty_session_candidates[0].last_active_at
    assert report.empty_session_candidates_omitted == 0
    assert report.db_size_bytes > 0
    assert report.page_count > 0
    assert report.freelist_count >= 0
    assert report.page_size > 0


def test_sqlite_session_store_bounds_session_maintenance_candidates(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"
    store = SQLiteSessionStore(db_path)
    workspace = tmp_path / "workspace"
    other_workspace = tmp_path / "other-workspace"

    for session_id in ("newer-empty", "older-empty", "newest-empty"):
        store.replace_conversation(
            session_id=session_id,
            workspace_root=workspace,
            thread_id=session_id,
            messages=[],
        )
    store.replace_conversation(
        session_id="with-message",
        workspace_root=workspace,
        thread_id="with-message",
        messages=[{"role": "user", "content": "hello"}],
    )
    store.replace_conversation(
        session_id="other-empty",
        workspace_root=other_workspace,
        thread_id="other-empty",
        messages=[],
    )
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            "UPDATE sessions SET last_active_at = '2026-01-02T00:00:00+00:00' "
            "WHERE session_id = 'newer-empty'"
        )
        connection.execute(
            "UPDATE sessions SET last_active_at = '2026-01-01T00:00:00+00:00' "
            "WHERE session_id = 'older-empty'"
        )
        connection.execute(
            "UPDATE sessions SET last_active_at = '2026-01-03T00:00:00+00:00' "
            "WHERE session_id = 'newest-empty'"
        )

    report = store.session_maintenance_report(
        workspace_root=workspace,
        candidate_limit=2,
    )

    assert report.empty_session_count == 3
    assert [candidate.session_id for candidate in report.empty_session_candidates] == [
        "older-empty",
        "newer-empty",
    ]
    assert [candidate.last_active_at for candidate in report.empty_session_candidates] == [
        "2026-01-01T00:00:00+00:00",
        "2026-01-02T00:00:00+00:00",
    ]
    assert report.empty_session_candidates_omitted == 1
