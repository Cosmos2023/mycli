# SQLite Session Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current per-session JSON sidecars with a global SQLite-backed session store that reliably resumes sessions, supports session listing/inspection, and keeps the existing runtime-facing `SessionService` API stable.

**Architecture:** Introduce a shared `SessionStore` abstraction plus a `SQLiteSessionStore` implementation rooted at `~/.mycli/sessions.db`. Keep `SessionService` as the typed facade over runtime/session domain objects, move session summaries out of JSON sidecars into the same store, and expose lightweight session overview queries to the CLI through `TurnService`.

**Tech Stack:** Python 3.13, standard-library `sqlite3`, dataclasses, existing runtime/session domain models, `pytest`, `ruff`, `mypy`

---

## File Structure

- Create: `src/mycli/domain/session_store.py`
  Responsibility: store protocol plus typed session overview records used by services/CLI without importing SQLite details.
- Create: `src/mycli/infrastructure/sqlite_session_store.py`
  Responsibility: schema creation, transactions, row mapping, and query helpers for session metadata, messages, history, rollouts, state payloads, and summaries.
- Create: `tests/unit/infrastructure/test_sqlite_session_store.py`
  Responsibility: low-level store round-trip and listing behavior.
- Modify: `src/mycli/services/session_service.py`
  Responsibility: keep the public session API stable while routing persistence through the shared store instead of JSON files.
- Modify: `src/mycli/services/memory_service.py`
  Responsibility: keep preferences/project notes file-backed for now, but route session summaries into the shared session store.
- Modify: `src/mycli/application/runtime/agent_runtime.py`
  Responsibility: construct one shared store instance and inject it into `SessionService` and `MemoryService`.
- Modify: `src/mycli/application/turn_service.py`
  Responsibility: create the shared store in the non-runtime path and expose `/sessions` rendering helpers.
- Modify: `src/mycli/cli/main.py`
  Responsibility: register `/sessions` in help and command routing.
- Modify: `tests/unit/services/test_session_service.py`
  Responsibility: update persistence tests to assert SQLite behavior and remove JSON fallback assumptions.
- Modify: `tests/unit/services/test_memory_service.py`
  Responsibility: verify session summaries now live in the shared SQLite session store.
- Modify: `tests/unit/cli/test_main.py`
  Responsibility: verify `/sessions` command exposure and rendering.
- Modify: `tests/integration/test_turn_service.py`
  Responsibility: verify session resume across service restarts with the same `home_dir` + `session_id`.
- Modify: `README.md`
  Responsibility: document `~/.mycli/sessions.db`, `/sessions`, and the end of JSON session-file support.

## Task 1: Introduce the Store Contract and SQLite Backend

**Files:**
- Create: `src/mycli/domain/session_store.py`
- Create: `src/mycli/infrastructure/sqlite_session_store.py`
- Test: `tests/unit/infrastructure/test_sqlite_session_store.py`

- [ ] **Step 1: Write the failing store tests**

```python
from pathlib import Path

from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore


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

    assert store.load_conversation("demo")[0]["content"] == "inspect repo"
    assert store.load_history_items("demo")[0]["type"] == "user_message"
    assert store.load_turn_rollouts("demo")[0]["turn_id"] == "turn_1"
    assert store.load_state("demo", "plan_state") == {
        "items": [{"id": "inspect", "content": "Inspect repo", "status": "completed"}]
    }
    assert store.load_session_summaries("demo") == ["Inspection complete"]


def test_sqlite_session_store_lists_recent_sessions_for_workspace(tmp_path: Path) -> None:
    db_path = tmp_path / "home" / ".mycli" / "sessions.db"
    store = SQLiteSessionStore(db_path)
    workspace = tmp_path / "workspace"

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

    overviews = store.list_sessions(workspace_root=workspace)

    assert [overview.session_id for overview in overviews] == ["newer", "older"]
    assert all(overview.workspace_root == workspace for overview in overviews)
```

- [ ] **Step 2: Run the tests to verify the backend does not exist yet**

Run: `uv run pytest tests/unit/infrastructure/test_sqlite_session_store.py -v`

Expected: `FAIL` with `ModuleNotFoundError: No module named 'mycli.infrastructure.sqlite_session_store'`

- [ ] **Step 3: Write the minimal store contract and SQLite implementation**

Add `src/mycli/domain/session_store.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


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


class SessionStore(Protocol):
    def replace_conversation(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        messages: list[dict[str, object]],
    ) -> None: ...

    def load_conversation(self, session_id: str) -> list[dict[str, object]] | None: ...

    def append_history_items(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        items: list[dict[str, object]],
    ) -> None: ...

    def load_history_items(self, session_id: str) -> list[dict[str, object]]: ...

    def append_turn_rollout(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        rollout: dict[str, object],
    ) -> None: ...

    def load_turn_rollouts(self, session_id: str) -> list[dict[str, object]]: ...

    def save_state(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        state_key: str,
        payload: dict[str, object] | list[object],
    ) -> None: ...

    def load_state(self, session_id: str, state_key: str) -> dict[str, object] | list[object] | None: ...

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

    def list_sessions(self, *, workspace_root: Path | None = None, limit: int = 20) -> tuple[SessionOverview, ...]: ...
```

Add `src/mycli/infrastructure/sqlite_session_store.py`:

```python
from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from mycli.domain.session_store import SessionOverview


class SQLiteSessionStore:
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

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

    def replace_conversation(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        messages: list[dict[str, object]],
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
                    (session_id, index, json.dumps(message, ensure_ascii=False))
                    for index, message in enumerate(messages)
                ],
            )

    def load_conversation(self, session_id: str) -> list[dict[str, object]] | None:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json
                FROM conversation_messages
                WHERE session_id = ?
                ORDER BY message_index
                """,
                (session_id,),
            ).fetchall()
        if not rows:
            return None
        return [json.loads(row["payload_json"]) for row in rows]

    def append_history_items(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        items: list[dict[str, object]],
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
                    (session_id, str(item["id"]), json.dumps(item, ensure_ascii=False))
                    for item in items
                ],
            )

    def load_history_items(self, session_id: str) -> list[dict[str, object]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json
                FROM history_items
                WHERE session_id = ?
                ORDER BY sequence_no
                """,
                (session_id,),
            ).fetchall()
        return [json.loads(row["payload_json"]) for row in rows]

    def append_turn_rollout(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        rollout: dict[str, object],
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
                (session_id, str(rollout["turn_id"]), json.dumps(rollout, ensure_ascii=False)),
            )

    def load_turn_rollouts(self, session_id: str) -> list[dict[str, object]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json
                FROM turn_rollouts
                WHERE session_id = ?
                ORDER BY sequence_no
                """,
                (session_id,),
            ).fetchall()
        return [json.loads(row["payload_json"]) for row in rows]

    def save_state(
        self,
        *,
        session_id: str,
        workspace_root: Path,
        thread_id: str,
        state_key: str,
        payload: dict[str, object] | list[object],
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
                    json.dumps(payload, ensure_ascii=False),
                    self._timestamp(),
                ),
            )

    def load_state(self, session_id: str, state_key: str) -> dict[str, object] | list[object] | None:
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
        return json.loads(row["payload_json"])

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
        params: list[object] = []
        if workspace_root is not None:
            query += " WHERE sessions.workspace_root = ?"
            params.append(str(workspace_root))
        query += """
            GROUP BY
                sessions.session_id,
                sessions.workspace_root,
                sessions.thread_id,
                sessions.created_at,
                sessions.updated_at,
                sessions.last_active_at,
                sessions.status
            ORDER BY sessions.last_active_at DESC
            LIMIT ?
        """
        params.append(limit)
        with self._connect() as connection:
            rows = connection.execute(query, params).fetchall()
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
```

- [ ] **Step 4: Run the store tests to verify the backend passes**

Run: `uv run pytest tests/unit/infrastructure/test_sqlite_session_store.py -v`

Expected: `PASS` for both new SQLite session store tests.

- [ ] **Step 5: Commit the store foundation**

Run:

```bash
git add src/mycli/domain/session_store.py src/mycli/infrastructure/sqlite_session_store.py tests/unit/infrastructure/test_sqlite_session_store.py
git commit -m "Establish a SQLite-backed session store foundation" \
  -m "Add a typed session-store contract and a standard-library sqlite3 backend so session persistence can move off per-file JSON sidecars without changing higher-level runtime models." \
  -m "Constraint: Must use a global SQLite file under ~/.mycli and avoid introducing new dependencies" \
  -m "Rejected: Keep JSON sidecars and add an index file | still fragments the session truth across many files" \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Reversibility: clean" \
  -m "Directive: Keep SQLite row payloads opaque JSON unless a query requires first-class columns" \
  -m "Tested: uv run pytest tests/unit/infrastructure/test_sqlite_session_store.py -v" \
  -m "Not-tested: AgentRuntime integration with the new store"
```

## Task 2: Move SessionService and Session Summaries onto SQLite

**Files:**
- Modify: `src/mycli/services/session_service.py`
- Modify: `src/mycli/services/memory_service.py`
- Modify: `tests/unit/services/test_session_service.py`
- Modify: `tests/unit/services/test_memory_service.py`

- [ ] **Step 1: Write the failing service-level tests for SQLite-backed persistence**

Add these tests.

In `tests/unit/services/test_session_service.py`:

```python
def test_session_service_persists_runtime_snapshot_without_json_sidecars(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    service = SessionService(
        home_dir=tmp_path / "home",
        workspace_root=workspace,
    )
    conversation = Conversation(session_id="demo")
    conversation.append(Message(role="user", content="hello"))

    service.save_conversation(conversation)
    service.append_history_items(
        "demo",
        (
            HistoryItem(
                id="turn_1:item:1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.USER_MESSAGE,
                text="hello",
            ),
        ),
    )

    loaded = service.load_conversation("demo")
    snapshot = service.load_runtime_snapshot("demo")

    assert loaded.messages[0].content == "hello"
    assert snapshot is not None
    assert snapshot.history_items[0].text == "hello"
    assert not (tmp_path / "home" / ".mycli" / "sessions" / "demo.json").exists()
    assert (tmp_path / "home" / ".mycli" / "sessions.db").exists()
```

In `tests/unit/services/test_memory_service.py`:

```python
def test_memory_service_stores_session_summaries_in_sqlite_session_store(tmp_path: Path) -> None:
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
    )

    service.append_session_summary("demo", "Inspected the repo root")

    assert service.load_session_summaries("demo") == ["Inspected the repo root"]
    assert (tmp_path / "home" / ".mycli" / "sessions.db").exists()
    assert not (tmp_path / "home" / ".mycli" / "sessions" / "demo-summary.json").exists()
```

- [ ] **Step 2: Run the targeted service tests to see the JSON assumptions break**

Run: `uv run pytest tests/unit/services/test_session_service.py tests/unit/services/test_memory_service.py -v`

Expected: `FAIL` because `SessionService` still writes JSON sidecars and `MemoryService` still writes `*-summary.json`.

- [ ] **Step 3: Refactor SessionService and MemoryService to use the shared store**

Update `src/mycli/services/session_service.py` constructor and state methods:

```python
from pathlib import Path
from typing import Any

from mycli.domain.session_store import SessionOverview, SessionStore
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore


class SessionService:
    def __init__(
        self,
        home_dir: Path,
        workspace_root: Path,
        session_store: SessionStore | None = None,
    ) -> None:
        self._workspace_root = workspace_root
        self._store = session_store or SQLiteSessionStore(home_dir / ".mycli" / "sessions.db")

    def save_conversation(self, conversation: Conversation) -> None:
        payload = [self._serialize_message(message) for message in conversation.messages]
        thread_id = conversation.session_id
        self._store.replace_conversation(
            session_id=conversation.session_id,
            workspace_root=self._workspace_root,
            thread_id=thread_id,
            messages=payload,
        )

    def load_conversation(self, session_id: str) -> Conversation:
        payload = self._store.load_conversation(session_id)
        conversation = Conversation(session_id=session_id)
        if payload is None:
            conversation.messages.extend(self._conversation_messages_from_history(session_id))
            return conversation
        for item in payload:
            conversation.append(self._deserialize_message(item))
        return conversation

    def append_history_items(self, session_id: str, items: tuple[HistoryItem, ...]) -> None:
        self._store.append_history_items(
            session_id=session_id,
            workspace_root=self._workspace_root,
            thread_id=session_id,
            items=[item.to_dict() for item in items],
        )

    def save_context_baseline(self, session_id: str, baseline: ContextBaseline) -> None:
        self._store.save_state(
            session_id=session_id,
            workspace_root=self._workspace_root,
            thread_id=baseline.thread_id,
            state_key="context_baseline",
            payload=baseline.to_dict(),
        )

    def save_plan_state(self, session_id: str, plan_state: PlanState) -> None:
        self._store.save_state(
            session_id=session_id,
            workspace_root=self._workspace_root,
            thread_id=session_id,
            state_key="plan_state",
            payload=[
                {"id": item.id, "content": item.content, "status": item.status.value}
                for item in plan_state.items
            ],
        )

    def clear_plan_state(self, session_id: str) -> None:
        self._store.delete_state(session_id, "plan_state")

    def save_pending_decision(self, session_id: str, decision: PendingDecision) -> None:
        self._store.save_state(
            session_id=session_id,
            workspace_root=self._workspace_root,
            thread_id=session_id,
            state_key="pending_decision",
            payload={
                "tool_call": {
                    "name": decision.tool_call.name,
                    "arguments": decision.tool_call.arguments,
                    "reason": decision.tool_call.reason,
                    "call_id": decision.tool_call.call_id,
                },
                "kind": decision.kind.value,
                "reason": decision.reason,
                "preview": decision.preview,
                "options": [option.value for option in decision.options],
                "command_pattern": decision.command_pattern,
            },
        )
```

Update `src/mycli/services/memory_service.py`:

```python
from pathlib import Path

from mycli.domain.memory import MemoryKind, MemoryRecord
from mycli.domain.session_store import SessionStore
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

    def append_session_summary(self, session_id: str, summary: str) -> None:
        self._session_store.append_session_summary(
            session_id=session_id,
            workspace_root=self._workspace_root,
            thread_id=session_id,
            summary=summary,
        )

    def load_session_summaries(self, session_id: str) -> list[str]:
        return self._session_store.load_session_summaries(session_id)
```

Then remove or rewrite tests in `tests/unit/services/test_session_service.py` that require legacy JSON-only behavior, especially the ones named around `legacy_conversation_payload`, `legacy_suspended_turn_payload`, and JSON file reconstruction. This feature explicitly cuts over to SQLite-only session persistence.

- [ ] **Step 4: Run the updated service tests and make sure they pass**

Run: `uv run pytest tests/unit/services/test_session_service.py tests/unit/services/test_memory_service.py -v`

Expected: `PASS` with session payloads stored in `~/.mycli/sessions.db` and no new session JSON files created.

- [ ] **Step 5: Commit the service migration**

Run:

```bash
git add src/mycli/services/session_service.py src/mycli/services/memory_service.py tests/unit/services/test_session_service.py tests/unit/services/test_memory_service.py
git commit -m "Consolidate session persistence behind the SQLite session store" \
  -m "Refactor SessionService and the session-summary slice of MemoryService to use the shared store while keeping existing runtime-facing APIs stable." \
  -m "Constraint: New sessions must not write legacy JSON sidecars or support JSON fallback loading" \
  -m "Rejected: Add SQLite writes alongside JSON writes during a transition period | doubles persistence paths and contradicts the clean cutover requirement" \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Reversibility: messy" \
  -m "Directive: Keep preference/project-memory storage unchanged in this change; only session-scoped state moves to SQLite" \
  -m "Tested: uv run pytest tests/unit/services/test_session_service.py tests/unit/services/test_memory_service.py -v" \
  -m "Not-tested: CLI rendering against the new session overview queries"
```

## Task 3: Wire the Shared Store into Runtime and Add Session Listing

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/cli/main.py`
- Modify: `tests/unit/cli/test_main.py`
- Modify: `tests/integration/test_turn_service.py`

- [ ] **Step 1: Write the failing tests for restart/resume and `/sessions`**

In `tests/integration/test_turn_service.py` add:

```python
def test_turn_service_restores_conversation_from_sqlite_after_restart(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    first = build_turn_service(
        cli_args={"session": "demo"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    second = build_turn_service(
        cli_args={"session": "demo"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )

    conversation = Conversation(session_id="demo")
    conversation.append(Message(role="user", content="hello again"))
    first._session_service.save_conversation(conversation)

    loaded = second._session_service.load_conversation("demo")

    assert [message.content for message in loaded.messages] == ["hello again"]
```

In `tests/unit/cli/test_main.py` add:

```python
def test_build_command_handler_exposes_sessions_command() -> None:
    class FakeService:
        def inspect_sessions(self) -> tuple[str, ...]:
            return ("* demo active messages=3", "  backlog active messages=1")

    handler = build_command_handler(FakeService())

    assert list(handler("/sessions")) == [
        "[session] * demo active messages=3",
        "[session]   backlog active messages=1",
    ]


def test_help_lists_sessions_command() -> None:
    output = handle_slash_command("/help")

    assert "/session" in output
    assert "/sessions" in output
```

- [ ] **Step 2: Run the integration/CLI tests before wiring the shared store**

Run: `uv run pytest tests/integration/test_turn_service.py tests/unit/cli/test_main.py -v`

Expected: `FAIL` because `/sessions` is not routed and the runtime/service construction does not yet expose a shared session overview path.

- [ ] **Step 3: Inject one shared store instance and expose session inspection helpers**

Update `src/mycli/application/runtime/agent_runtime.py`:

```python
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore


class AgentRuntime:
    def __init__(self, *, model_adapter: ModelAdapter, tool_registry: ToolRegistryV2, config: AgentConfig, home_dir: Path, ... ) -> None:
        self._session_store = SQLiteSessionStore(home_dir / ".mycli" / "sessions.db")
        self._session_service = session_service or SessionService(
            home_dir=home_dir,
            workspace_root=config.workspace_root,
            session_store=self._session_store,
        )
        self._memory_service = memory_service or MemoryService(
            home_dir=home_dir,
            workspace_root=config.workspace_root,
            session_store=self._session_store,
        )
```

Update `src/mycli/application/turn_service.py`:

```python
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore


        session_store = SQLiteSessionStore(home_dir / ".mycli" / "sessions.db")
        self._memory_service = MemoryService(
            home_dir=home_dir,
            workspace_root=config.workspace_root,
            session_store=session_store,
        )
        self._session_service = SessionService(
            home_dir=home_dir,
            workspace_root=config.workspace_root,
            session_store=session_store,
        )

    def inspect_sessions(self) -> tuple[str, ...]:
        overviews = self._session_service.list_sessions(limit=10)
        if not overviews:
            return ("no saved sessions",)
        lines: list[str] = []
        for overview in overviews:
            current_marker = "*" if overview.session_id == self._config.session_id else " "
            lines.append(
                f"{current_marker} {overview.session_id} {overview.status} "
                f"messages={overview.message_count} summaries={overview.summary_count}"
            )
        return tuple(lines)
```

Add `list_sessions` to `SessionService`:

```python
    def list_sessions(self, limit: int = 20) -> tuple[SessionOverview, ...]:
        return self._store.list_sessions(workspace_root=self._workspace_root, limit=limit)
```

Update `src/mycli/cli/main.py`:

```python
def handle_slash_command(command: str) -> str:
    if command == "/help":
        return "\n".join(
            [
                "/help",
                "/skill",
                "/skills",
                "/memory",
                "/plan",
                "/trace",
                "/tools",
                "/session",
                "/sessions",
                "/quit",
            ]
        )


def build_command_handler(service: TurnService) -> Callable[[str], Iterable[str]]:
    def handle(command: str) -> Iterable[str]:
        if command == "/sessions":
            return [f"[session] {line}" for line in service.inspect_sessions()]
        if command == "/session":
            return [f"[session] {line}" for line in service.inspect_session()]
```

- [ ] **Step 4: Run the restart/session-management tests and make sure they pass**

Run: `uv run pytest tests/integration/test_turn_service.py tests/unit/cli/test_main.py -v`

Expected: `PASS`, including the new restart-resume and `/sessions` command tests.

- [ ] **Step 5: Commit runtime wiring and session listing**

Run:

```bash
git add src/mycli/application/runtime/agent_runtime.py src/mycli/application/turn_service.py src/mycli/cli/main.py tests/unit/cli/test_main.py tests/integration/test_turn_service.py
git commit -m "Expose SQLite-backed session resume and listing workflows" \
  -m "Create one shared session store per runtime/service build, keep resume behavior stable across restarts, and expose lightweight session listing through /sessions." \
  -m "Constraint: Session metadata lives in a global database, but CLI listing should stay scoped to the current workspace by default" \
  -m "Rejected: Add a new top-level CLI flag for session listing in the first pass | /sessions already covers the immediate management workflow with lower surface area" \
  -m "Confidence: medium" \
  -m "Scope-risk: moderate" \
  -m "Reversibility: clean" \
  -m "Directive: Keep /sessions rendering intentionally shallow; deeper audit queries should build on the same store later instead of adding ad-hoc tables now" \
  -m "Tested: uv run pytest tests/integration/test_turn_service.py tests/unit/cli/test_main.py -v" \
  -m "Not-tested: Interactive manual REPL walkthrough"
```

## Task 4: Update Docs and Run Full Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README for SQLite storage and session management**

Update the session persistence section in `README.md` so it says:

```md
## Sessions and Persistence

`mycli` now stores session state in a global SQLite database:

- Session database: `~/.mycli/sessions.db`
- Session selection: `uv run mycli --session demo`
- Current session summary: `/session`
- Recent sessions in the current workspace: `/sessions`

The SQLite session store persists:

- conversation messages
- structured history items
- context baselines
- turn rollouts and continuation state
- pending decisions and suspended turns
- plan state
- per-session summaries

Legacy JSON session files under `~/.mycli/sessions/` are no longer used by the runtime.
```

- [ ] **Step 2: Run the focused CLI regression after the README update**

Run: `uv run pytest tests/unit/cli/test_main.py::test_help_lists_sessions_command -v`

Expected: `PASS`

- [ ] **Step 3: Run the full quality gates**

Run: `uv run pytest -q`

Expected: `PASS`

Run: `uv run ruff check .`

Expected: `All checks passed!`

Run: `uv run mypy`

Expected: `Success: no issues found`

- [ ] **Step 4: Review the docs diff before committing**

Run: `git diff -- README.md`

Expected: the diff mentions `~/.mycli/sessions.db`, `/sessions`, and the SQLite-only cutover.

- [ ] **Step 5: Commit the docs and verification pass**

Run:

```bash
git add README.md tests/unit/cli/test_main.py
git commit -m "Document the SQLite session store cutover" \
  -m "Update the user-facing docs to point at ~/.mycli/sessions.db, advertise /sessions, and make the JSON session-file removal explicit after verification passes." \
  -m "Constraint: Documentation must match the clean-cutover decision and avoid describing unsupported JSON fallback behavior" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Reversibility: clean" \
  -m "Directive: If storage behavior changes again, update README and /help in the same change as the code" \
  -m "Tested: uv run pytest -q; uv run ruff check .; uv run mypy" \
  -m "Not-tested: Live model-provider session with a real API key"
```

## Self-Review Notes

- Spec coverage: reliable resume is handled by Tasks 1-3, session management by Task 3, and the SQLite-only cutover plus docs by Tasks 2 and 4.
- Placeholder scan: no `TODO`, `TBD`, or “similar to above” markers remain.
- Type consistency: the plan uses one shared naming scheme throughout: `SessionStore`, `SessionOverview`, `SQLiteSessionStore`, `/sessions`, and `list_sessions`.
