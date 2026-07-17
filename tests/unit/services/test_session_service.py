from datetime import UTC, datetime
import json
from pathlib import Path
import sqlite3

import pytest

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import (
    BaselineFragment,
    ContextBaseline,
    DecisionAction,
    DecisionKind,
    HistoryItem,
    HistoryItemType,
    InvokedSkillSnapshot,
    PendingApproval,
    PendingClarification,
    PendingDecision,
    PlanItem,
    PlanState,
    PlanStatus,
    RuntimeBlock,
    SessionCommandAllowance,
    ShellKind,
    StopReason,
    SuspendedTurn,
    TurnItem,
    TurnItemType,
    TurnRecord,
    TurnRollout,
    TurnRolloutEvent,
    TurnStatus,
)
from mycli.domain.tools import ToolCall
from mycli.schemas.responses_protocol import ResponsesContinuationState
from mycli.services.session_service import SessionService


def test_session_service_persists_conversation(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    conversation = Conversation(session_id="demo")
    conversation.append(Message(role="user", content="hello"))

    service.save_conversation(conversation)
    loaded = service.load_conversation("demo")

    assert loaded.session_id == "demo"
    assert loaded.messages[0].content == "hello"


def test_session_service_creates_instruction_snapshot_once(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")

    snapshot = service.load_or_create_instruction_snapshot(
        "demo",
        system_prompt="Current system prompt",
        template_hash="hash-current",
    )

    assert snapshot.system == "Current system prompt"
    assert snapshot.hash == "hash-current"

    reused = service.load_or_create_instruction_snapshot(
        "demo",
        system_prompt="New system prompt",
        template_hash="hash-new",
    )

    assert reused == snapshot


def test_session_service_preserves_legacy_instruction_snapshot(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    service._save_state(
        session_id="legacy",
        thread_id="legacy",
        state_key="instruction_snapshot",
        payload={
            "version": "legacy-v1",
            "system": "Legacy system prompt",
            "react": "Legacy react prompt",
            "source": "legacy-session",
            "hash": "legacy-hash",
        },
    )

    snapshot = service.load_or_create_instruction_snapshot(
        "legacy",
        system_prompt="Current system prompt",
        template_hash="hash-current",
    )

    assert snapshot.version == "legacy-v1"
    assert snapshot.system == "Legacy system prompt"
    assert snapshot.hash == "legacy-hash"


def test_session_service_round_trips_conversation_tree_metadata(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    conversation = Conversation(
        session_id="branch",
        parent_id="root",
        fork_point=1,
        messages=[Message(role="user", content="hello")],
    )

    service.save_conversation(conversation)
    loaded = service.load_conversation("branch")

    assert loaded.parent_id == "root"
    assert loaded.fork_point == 1
    assert loaded.messages[0].content == "hello"


def test_session_service_writes_readable_session_snapshot(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    service = SessionService(home_dir=home_dir, workspace_root=workspace)
    conversation = Conversation(
        session_id="3ff83220-447c-4b12-ab27-6e14079b39c7",
        parent_id="root",
        fork_point=2,
        messages=[
            Message(role="user", content="hello"),
            Message(role="assistant", content="hi"),
        ],
    )

    service.save_conversation(conversation)

    path = (
        home_dir
        / ".mycli"
        / "sessions"
        / "3ff83220-447c-4b12-ab27-6e14079b39c7"
        / "session.json"
    )
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == 2
    assert payload["session_id"] == "3ff83220-447c-4b12-ab27-6e14079b39c7"
    assert payload["cwd"] == str(workspace)
    assert payload["lineage"] == {
        "parent_session_id": "root",
        "fork_point": 2,
        "branch_name": "main",
    }
    assert payload["message_count"] == 2
    assert "messages" not in payload
    assert payload["transcript"] == [
        {"id": "message-1", "type": "user_message", "text": "hello"},
        {"id": "message-2", "type": "assistant_message", "text": "hi"},
    ]
    assert payload["links"]["events"] == "events.jsonl"
    assert payload["links"]["trace"] == (
        "../../traces/3ff83220-447c-4b12-ab27-6e14079b39c7-trace.jsonl"
    )


def test_history_append_refreshes_snapshot_with_visible_transcript(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    service = SessionService(home_dir=home_dir)

    service.append_history_items(
        "demo",
        (
            HistoryItem(
                id="user-1",
                thread_id="demo",
                turn_id="turn-1",
                type=HistoryItemType.USER_MESSAGE,
                text="inspect repo",
            ),
            HistoryItem(
                id="private-1",
                thread_id="demo",
                turn_id="turn-1",
                type=HistoryItemType.CONTEXT_BASELINE_UPDATE,
                text="private context",
            ),
        ),
    )

    payload = json.loads(
        (home_dir / ".mycli" / "sessions" / "demo" / "session.json").read_text(
            encoding="utf-8"
        )
    )
    assert payload["transcript"] == [
        {"id": "user-1", "type": "user_message", "text": "inspect repo"}
    ]


def test_conversation_save_writes_snapshot_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    writes = 0
    original = service._snapshot_service.write_conversation_snapshot

    def recording_write(**kwargs: object) -> None:
        nonlocal writes
        writes += 1
        original(**kwargs)

    monkeypatch.setattr(
        service._snapshot_service,
        "write_conversation_snapshot",
        recording_write,
    )
    service.save_conversation(
        Conversation(
            session_id="demo",
            parent_id="root",
            fork_point=1,
            messages=[Message(role="user", content="hello")],
        )
    )

    assert writes == 1


def test_snapshot_write_failure_does_not_rollback_sqlite_conversation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = SessionService(home_dir=tmp_path / "home")

    def fail_write(**_kwargs: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(
        service._snapshot_service,
        "write_conversation_snapshot",
        fail_write,
    )

    service.save_conversation(
        Conversation(session_id="demo", messages=[Message(role="user", content="hello")])
    )

    stored = service._store.load_conversation("demo")
    assert stored is not None
    assert stored[0]["content"] == "hello"


def test_load_conversation_imports_v1_messages_when_sqlite_is_empty(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    snapshot_path = home_dir / ".mycli" / "sessions" / "legacy" / "session.json"
    snapshot_path.parent.mkdir(parents=True)
    snapshot_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "session_id": "legacy",
                "messages": [
                    {"role": "user", "content": "hello"},
                    {"role": "assistant", "content": "hi"},
                ],
            }
        ),
        encoding="utf-8",
    )
    service = SessionService(home_dir=home_dir)

    conversation = service.load_conversation("legacy")

    assert [message.content for message in conversation.messages] == ["hello", "hi"]
    migrated = json.loads(snapshot_path.read_text(encoding="utf-8"))
    assert migrated["schema_version"] == 2
    assert "messages" not in migrated
    assert service._store.load_conversation("legacy") is not None


def test_resume_conversation_imports_v1_snapshot_before_resolution(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    snapshot_path = home_dir / ".mycli" / "sessions" / "legacy" / "session.json"
    snapshot_path.parent.mkdir(parents=True)
    snapshot_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "session_id": "legacy",
                "messages": [{"role": "user", "content": "resume me"}],
            }
        ),
        encoding="utf-8",
    )
    service = SessionService(home_dir=home_dir)

    conversation = service.resume_conversation("legacy")

    assert conversation.session_id == "legacy"
    assert [message.content for message in conversation.messages] == ["resume me"]


def test_v2_transcript_is_never_used_as_model_conversation(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    snapshot_path = home_dir / ".mycli" / "sessions" / "display-only" / "session.json"
    snapshot_path.parent.mkdir(parents=True)
    snapshot_path.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "session_id": "display-only",
                "transcript": [
                    {"id": "user-1", "type": "user_message", "text": "not canonical"}
                ],
            }
        ),
        encoding="utf-8",
    )
    service = SessionService(home_dir=home_dir)

    conversation = service.load_conversation("display-only")

    assert conversation.messages == []
    assert service._store.load_conversation("display-only") is None


def test_corrupt_snapshot_is_rebuilt_from_sqlite(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    service = SessionService(home_dir=home_dir)
    service.save_conversation(
        Conversation(session_id="demo", messages=[Message(role="user", content="hello")])
    )
    snapshot_path = home_dir / ".mycli" / "sessions" / "demo" / "session.json"
    snapshot_path.write_text("{broken", encoding="utf-8")

    loaded = service.load_conversation("demo")

    assert loaded.messages[0].content == "hello"
    repaired = json.loads(snapshot_path.read_text(encoding="utf-8"))
    assert repaired["schema_version"] == 2


def test_unknown_session_load_does_not_create_empty_snapshot(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    service = SessionService(home_dir=home_dir)

    conversation = service.load_conversation("missing")

    assert conversation.messages == []
    assert not (
        home_dir / ".mycli" / "sessions" / "missing" / "session.json"
    ).exists()


def test_session_service_appends_session_events_jsonl(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    service = SessionService(home_dir=home_dir)
    session_id = "3ff83220-447c-4b12-ab27-6e14079b39c7"

    service.save_conversation(
        Conversation(
            session_id=session_id,
            messages=[Message(role="user", content="hello")],
        )
    )
    service.save_plan_state(
        session_id,
        PlanState(items=(PlanItem(id="p1", content="Do work", status=PlanStatus.IN_PROGRESS),)),
    )

    events_path = home_dir / ".mycli" / "sessions" / session_id / "events.jsonl"
    events = [
        json.loads(line)
        for line in events_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]

    assert [event["type"] for event in events] == [
        "conversation.saved",
        "plan.updated",
    ]
    assert events[0]["session_id"] == session_id
    assert events[0]["message_count"] == 1
    assert events[1]["plan"]["items"] == [
        {"id": "p1", "status": "in_progress", "text": "Do work"}
    ]


def test_session_service_writes_subagent_snapshot_under_parent_session(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    service = SessionService(home_dir=home_dir)

    service.write_subagent_snapshot(
        parent_session_id="parent-session",
        child_session_id="parent-session:sub:turn_1:abcd1234",
        parent_turn_id="turn_1",
        agent_type="explore",
        status="completed",
        mode="sync",
        description="Inspect repo",
        report="Found README.",
        tool_calls=1,
        error=None,
        started_at="2026-06-11T00:00:00+00:00",
        completed_at="2026-06-11T00:00:01+00:00",
        context_diagnostics={"tool_count": 1},
    )

    session_dir = home_dir / ".mycli" / "sessions" / "parent-session"
    subagent_files = list((session_dir / "subagents").glob("*.json"))
    assert len(subagent_files) == 1
    payload = json.loads(subagent_files[0].read_text(encoding="utf-8"))
    assert payload["parent_session_id"] == "parent-session"
    assert payload["child_session_id"] == "parent-session:sub:turn_1:abcd1234"
    assert payload["parent_turn_id"] == "turn_1"
    assert payload["role"] == "explore"
    assert payload["status"] == "completed"
    assert payload["tool_calls"] == 1

    snapshot = json.loads((session_dir / "session.json").read_text(encoding="utf-8"))
    assert snapshot["subagents"] == [
        {
            "run_id": payload["run_id"],
            "child_session_id": "parent-session:sub:turn_1:abcd1234",
            "parent_turn_id": "turn_1",
            "role": "explore",
            "description": "Inspect repo",
            "status": "completed",
            "mode": "sync",
            "summary": "Found README.",
            "tool_calls": 1,
            "started_at": "2026-06-11T00:00:00+00:00",
            "completed_at": "2026-06-11T00:00:01+00:00",
            "path": f"subagents/{payload['run_id']}.json",
        }
    ]


def test_session_service_persists_conversation_tree_in_dedicated_table(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    service = SessionService(home_dir=home_dir)
    conversation = Conversation(
        session_id="branch",
        parent_id="root",
        fork_point=1,
        messages=[Message(role="user", content="hello")],
    )

    service.save_conversation(conversation)

    with sqlite3.connect(home_dir / ".mycli" / "sessions.db") as connection:
        row = connection.execute(
            """
            SELECT parent_id, fork_point
            FROM conversation_trees
            WHERE session_id = ?
            """,
            ("branch",),
        ).fetchone()
    assert row == ("root", 1)


def test_session_service_forks_conversation_at_requested_point(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    source = Conversation(
        session_id="root",
        messages=[
            Message(role="user", content="one"),
            Message(role="assistant", content="two"),
            Message(role="user", content="three"),
        ],
    )
    service.save_conversation(source)

    forked = service.fork_conversation("root", "branch", fork_point=2)
    loaded = service.load_conversation("branch")

    assert forked.parent_id == "root"
    assert loaded.parent_id == "root"
    assert loaded.fork_point == 2
    assert [message.content for message in loaded.messages] == ["one", "two"]


def test_session_service_fork_child_updates_do_not_pollute_parent_transcript(
    tmp_path: Path,
) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    source = Conversation(
        session_id="root",
        messages=[
            Message(role="user", content="one"),
            Message(role="assistant", content="two"),
            Message(role="user", content="root tail"),
        ],
    )
    service.save_conversation(source)

    branch = service.fork_conversation("root", "branch", fork_point=2)
    branch.append(Message(role="user", content="branch-only request"))
    branch.append(Message(role="assistant", content="branch-only answer"))
    service.save_conversation(branch)

    loaded_parent = service.load_conversation("root")
    loaded_branch = service.load_conversation("branch")

    assert [message.content for message in loaded_parent.messages] == [
        "one",
        "two",
        "root tail",
    ]
    assert [message.content for message in loaded_branch.messages] == [
        "one",
        "two",
        "branch-only request",
        "branch-only answer",
    ]
    assert loaded_branch.parent_id == "root"
    assert loaded_branch.fork_point == 2


def test_session_service_rewinds_conversation_in_place(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    conversation = Conversation(
        session_id="branch",
        parent_id="root",
        fork_point=2,
        messages=[
            Message(role="user", content="one"),
            Message(role="assistant", content="two"),
            Message(role="user", content="three"),
        ],
    )
    service.save_conversation(conversation)

    rewound = service.rewind_conversation("branch", 1)
    loaded = service.resume_conversation("branch")

    assert rewound.fork_point == 1
    assert loaded.parent_id == "root"
    assert loaded.fork_point == 1
    assert [message.content for message in loaded.messages] == ["one"]


def test_session_service_resumes_ancestor_as_current_tip_lineage(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    root = Conversation(
        session_id="root",
        messages=[
            Message(role="user", content="one"),
            Message(role="assistant", content="two"),
            Message(role="user", content="root-only"),
        ],
    )
    branch = Conversation(
        session_id="branch",
        parent_id="root",
        fork_point=2,
        messages=[
            Message(role="user", content="one"),
            Message(role="assistant", content="two"),
            Message(role="user", content="branch-only"),
        ],
    )
    service.save_conversation(root)
    service.save_conversation(branch)

    resumed = service.resume_conversation("root")

    assert resumed.session_id == "branch"
    assert resumed.parent_id == "root"
    assert resumed.fork_point == 2
    assert [message.content for message in resumed.messages] == [
        "one",
        "two",
        "branch-only",
    ]


def test_session_service_resumes_newest_child_branch_when_siblings_exist(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    service = SessionService(home_dir=home_dir)
    root = Conversation(
        session_id="root",
        messages=[
            Message(role="user", content="one"),
            Message(role="assistant", content="two"),
            Message(role="user", content="root-only"),
        ],
    )
    older = Conversation(
        session_id="older-branch",
        parent_id="root",
        fork_point=2,
        messages=[
            Message(role="user", content="one"),
            Message(role="assistant", content="two"),
            Message(role="user", content="older branch"),
        ],
    )
    newer = Conversation(
        session_id="newer-branch",
        parent_id="root",
        fork_point=2,
        messages=[
            Message(role="user", content="one"),
            Message(role="assistant", content="two"),
            Message(role="user", content="newer branch"),
        ],
    )
    service.save_conversation(root)
    service.save_conversation(older)
    service.save_conversation(newer)
    with sqlite3.connect(home_dir / ".mycli" / "sessions.db") as connection:
        connection.execute(
            "UPDATE sessions SET last_active_at = '2026-01-01T00:00:00+00:00' "
            "WHERE session_id = 'older-branch'"
        )
        connection.execute(
            "UPDATE sessions SET last_active_at = '2026-01-02T00:00:00+00:00' "
            "WHERE session_id = 'newer-branch'"
        )

    resumed = service.resume_conversation("root")

    assert resumed.session_id == "newer-branch"
    assert [message.content for message in resumed.messages] == [
        "one",
        "two",
        "newer branch",
    ]


def test_session_service_rejects_missing_resume_target(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")

    with pytest.raises(ValueError, match="Conversation does not exist: missing"):
        service.resume_conversation("missing")


def test_session_service_resumes_legacy_message_only_session(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    db_path = home_dir / ".mycli" / "sessions.db"
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
            ('{"role": "user", "content": "legacy hello"}',),
        )

    service = SessionService(home_dir=home_dir)

    resumed = service.resume_conversation("legacy")

    assert resumed.session_id == "legacy"
    assert resumed.parent_id is None
    assert resumed.fork_point is None
    assert [message.content for message in resumed.messages] == ["legacy hello"]


def test_session_service_searches_sessions_with_bounded_output(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home", workspace_root=tmp_path / "workspace")
    conversation = Conversation(
        session_id="demo",
        messages=[Message(role="assistant", content="WAL checkpoint configured")],
    )
    service.save_conversation(conversation)

    assert service.search_sessions("checkpoint") == (
        "demo#0 assistant: WAL checkpoint configured",
    )


def test_session_service_searches_runtime_history_items(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home", workspace_root=tmp_path / "workspace")
    service.append_history_items(
        "demo",
        (
            HistoryItem(
                id="hist_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.ASSISTANT_MESSAGE,
                text="runtime history has searchable state",
                metadata={"role": "assistant"},
            ),
        ),
    )

    assert service.search_sessions("searchable") == (
        "demo#1 history:assistant_message: runtime history has searchable state",
    )


def test_session_service_search_reports_empty_query(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")

    assert service.search_sessions("  ") == ("usage: /search <query>",)


def test_session_service_formats_session_maintenance_report(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    service = SessionService(home_dir=tmp_path / "home", workspace_root=workspace)
    service.save_conversation(Conversation(session_id="empty"))
    service.save_conversation(
        Conversation(
            session_id="with-message",
            messages=[Message(role="user", content="hello")],
        )
    )

    lines = service.inspect_session_maintenance()

    assert "dry_run=true" in lines
    assert "workspace_sessions=2" in lines
    assert "empty_sessions=1" in lines
    assert any(line.startswith("empty_candidate=empty status=active ") for line in lines)
    assert "empty_candidates_omitted=1" not in lines
    assert any(line.startswith("db_size_bytes=") for line in lines)
    assert any(line.startswith("page_count=") for line in lines)
    assert any(line.startswith("freelist_count=") for line in lines)
    assert any(line.startswith("page_size=") for line in lines)


def test_session_service_formats_session_maintenance_apply_result(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    service = SessionService(home_dir=tmp_path / "home", workspace_root=workspace)
    service.save_conversation(Conversation(session_id="empty"))
    service.save_conversation(
        Conversation(
            session_id="with-message",
            messages=[Message(role="user", content="hello")],
        )
    )

    lines = service.apply_session_maintenance_empty_cleanup()

    assert "dry_run=false" in lines
    assert "deleted_empty_sessions=1" in lines
    assert "deleted_session=empty" in lines
    assert "empty_sessions_remaining=0" in lines
    assert any(line.startswith("db_size_bytes=") for line in lines)
    assert service.load_conversation("with-message").messages == [
        Message(role="user", content="hello")
    ]
    assert [overview.session_id for overview in service.list_sessions()] == ["with-message"]


def test_session_service_formats_session_maintenance_orphan_cleanup(
    tmp_path: Path,
) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    service = SessionService(home_dir=home, workspace_root=workspace)
    service.save_conversation(Conversation(session_id="valid"))
    db_path = home / ".mycli" / "sessions.db"
    with sqlite3.connect(db_path) as connection:
        connection.execute("PRAGMA foreign_keys = OFF")
        connection.execute(
            """
            INSERT INTO conversation_messages (session_id, message_index, payload_json)
            VALUES ('orphan', 0, ?)
            """,
            ('{"role": "user", "content": "orphan"}',),
        )

    lines = service.apply_session_maintenance_orphan_cleanup()

    assert "dry_run=false" in lines
    assert "deleted_orphan_rows=1" in lines
    assert "deleted_orphan_table=conversation_messages rows=1" in lines
    assert service.load_conversation("valid").messages == []


def test_session_service_formats_session_maintenance_vacuum(
    tmp_path: Path,
) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    service = SessionService(home_dir=home, workspace_root=workspace)
    service.save_conversation(
        Conversation(
            session_id="with-message",
            messages=[Message(role="user", content="hello")],
        )
    )

    lines = service.apply_session_maintenance_vacuum()

    assert "dry_run=false" in lines
    assert any(line.startswith("before_db_size_bytes=") for line in lines)
    assert any(line.startswith("after_db_size_bytes=") for line in lines)
    assert any(line.startswith("before_page_count=") for line in lines)
    assert any(line.startswith("after_page_count=") for line in lines)
    assert any(line.startswith("before_freelist_count=") for line in lines)
    assert any(line.startswith("after_freelist_count=") for line in lines)
    assert any(line.startswith("page_size=") for line in lines)
    assert service.load_conversation("with-message").messages == [
        Message(role="user", content="hello")
    ]


def test_session_service_round_trips_message_metadata(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    conversation = Conversation(session_id="demo")
    conversation.append(
        Message(
            role="user",
            content="hello",
            metadata={"cache_policy": "STATIC", "source": "test"},
        )
    )

    service.save_conversation(conversation)
    loaded = service.load_conversation("demo")

    assert loaded.messages[0].metadata == {"cache_policy": "STATIC", "source": "test"}


def test_session_service_round_trips_conversation_blocks_and_response_id(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    conversation = Conversation(session_id="demo")
    conversation.append(
        Message(
            role="assistant",
            content="I can inspect the repo for you.",
            response_id="resp_123",
            blocks=(
                RuntimeBlock(
                    type="tool_call",
                    tool_name="list_directory",
                    tool_arguments={"path": "."},
                    call_id="call_001",
                    provider_id="fc_001",
                    metadata={"step": 1},
                ),
                RuntimeBlock(
                    type="text",
                    text="I can inspect the repo for you.",
                    provider_id="msg_001",
                    metadata={"segment": "final"},
                ),
            ),
        )
    )

    service.save_conversation(conversation)
    loaded = service.load_conversation("demo")

    assert loaded.messages[0].response_id == "resp_123"
    assert len(loaded.messages[0].blocks) == 2
    assert loaded.messages[0].blocks[0].type == "tool_call"
    assert loaded.messages[0].blocks[0].call_id == "call_001"
    assert loaded.messages[0].blocks[0].tool_arguments == {"path": "."}
    assert loaded.messages[0].blocks[0].provider_id == "fc_001"
    assert loaded.messages[0].blocks[0].metadata == {"step": 1}
    assert loaded.messages[0].blocks[1].type == "text"
    assert loaded.messages[0].blocks[1].provider_id == "msg_001"
    assert loaded.messages[0].blocks[1].metadata == {"segment": "final"}


def test_session_service_rebuilds_tool_call_and_tool_result_messages_from_history(
    tmp_path: Path,
) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    session_id = "demo"
    service.append_history_items(
        session_id,
        (
            HistoryItem(
                id="turn_1:item:1",
                thread_id=session_id,
                turn_id="turn_1",
                type=HistoryItemType.USER_MESSAGE,
                text="inspect the repo",
            ),
            HistoryItem(
                id="turn_1:item:2",
                thread_id=session_id,
                turn_id="turn_1",
                type=HistoryItemType.TOOL_CALL,
                text="Inspecting repository state",
                tool_name="run_shell",
                call_id="call_001",
                metadata={
                    "arguments": {"args": ["pwd"]},
                    "provider_id": "fc_001",
                },
            ),
            HistoryItem(
                id="turn_1:item:3",
                thread_id=session_id,
                turn_id="turn_1",
                type=HistoryItemType.TOOL_RESULT,
                text="Tool run_shell: /workspace",
                tool_name="run_shell",
                call_id="call_001",
                metadata={
                    "transcript_content": "/workspace",
                    "summary": "pwd completed",
                    "provider_id": "tool_001",
                },
            ),
        ),
    )

    loaded = service.load_conversation(session_id)

    assert [message.role for message in loaded.messages] == ["user", "assistant", "tool"]
    tool_call_message = loaded.messages[1]
    assert tool_call_message.tool_calls == (
        ToolCall(
            name="run_shell",
            arguments={"args": ["pwd"]},
            reason="model requested tool",
            call_id="call_001",
        ),
    )
    assert tool_call_message.blocks == (
        RuntimeBlock(
            type="tool_call",
            text="Inspecting repository state",
            tool_name="run_shell",
            tool_arguments={"args": ["pwd"]},
            call_id="call_001",
            provider_id="fc_001",
            metadata={
                "arguments": {"args": ["pwd"]},
                "provider_id": "fc_001",
            },
        ),
    )
    tool_result_message = loaded.messages[2]
    assert tool_result_message.role == "tool"
    assert tool_result_message.tool_call_id == "call_001"
    assert tool_result_message.blocks == (
        RuntimeBlock(
            type="tool_result",
            text="/workspace",
            tool_name="run_shell",
            call_id="call_001",
            provider_id="tool_001",
            metadata={
                "transcript_content": "/workspace",
                "summary": "pwd completed",
                "provider_id": "tool_001",
            },
        ),
    )


def test_session_service_normalizes_legacy_approval_replay_views(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    session_id = "approval-replay"
    history = (
        HistoryItem(
            id="user-original",
            thread_id=session_id,
            turn_id="turn-original",
            type=HistoryItemType.USER_MESSAGE,
            text="inspect cpu",
        ),
        HistoryItem(
            id="user-legacy",
            thread_id=session_id,
            turn_id="turn-approval",
            type=HistoryItemType.USER_MESSAGE,
            text="inspect cpu",
        ),
        HistoryItem(
            id="assistant",
            thread_id=session_id,
            turn_id="turn-approval",
            type=HistoryItemType.ASSISTANT_MESSAGE,
            text="CPU is idle",
        ),
    )
    service.append_history_items(session_id, history)
    service.append_turn_rollout(
        session_id,
        TurnRollout(
            thread_id=session_id,
            turn_id="turn-approval",
            status=TurnStatus.COMPLETED,
            started_at="2026-07-14T00:00:00Z",
            completed_at="2026-07-14T00:00:01Z",
            events=(
                TurnRolloutEvent(
                    event_id="approval-event",
                    kind="turn_item",
                    created_at="2026-07-14T00:00:00Z",
                    payload={"type": "approval_resolution", "text": "[decision] 1"},
                ),
            ),
        ),
    )

    assert [item.id for item in service.load_history_items(session_id)] == [
        "user-original",
        "user-legacy",
        "assistant",
    ]
    assert [item.id for item in service.load_replay_history_items(session_id)] == [
        "user-original",
        "assistant",
    ]

    runtime_snapshot = service.load_runtime_snapshot(session_id)
    assert runtime_snapshot is not None
    assert [item.id for item in runtime_snapshot.history_items] == [
        "user-original",
        "assistant",
    ]
    assert [message.content for message in service.load_conversation(session_id).messages] == [
        "inspect cpu",
        "CPU is idle",
    ]

    snapshot = service._snapshot_service.read_snapshot(session_id)
    assert snapshot is not None
    assert [item["id"] for item in snapshot["transcript"]] == [
        "user-original",
        "assistant",
    ]


def test_session_service_excludes_context_baseline_updates_from_conversation_view(
    tmp_path: Path,
) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    session_id = "demo"
    service.append_history_items(
        session_id,
        (
            HistoryItem(
                id="turn_1:environment_context",
                thread_id=session_id,
                turn_id="turn_1",
                type=HistoryItemType.CONTEXT_BASELINE_UPDATE,
                text="Runtime environment:\n- workspace_root: /repo",
                metadata={
                    "context_kind": "environment_context",
                    "model_visible": True,
                    "replayable": True,
                },
            ),
            HistoryItem(
                id="turn_1:user",
                thread_id=session_id,
                turn_id="turn_1",
                type=HistoryItemType.USER_MESSAGE,
                text="inspect the repo",
            ),
        ),
    )

    loaded = service.load_conversation(session_id)

    assert [message.role for message in loaded.messages] == ["user"]
    assert loaded.messages[0].content == "inspect the repo"


def test_session_service_rebuilds_assistant_text_metadata_from_history(
    tmp_path: Path,
) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    session_id = "demo"
    service.append_history_items(
        session_id,
        (
            HistoryItem(
                id="turn_1:item:1",
                thread_id=session_id,
                turn_id="turn_1",
                type=HistoryItemType.ASSISTANT_MESSAGE,
                text="Done.",
                metadata={
                    "provider_id": "msg_001",
                    "deepseek": {
                        "reasoning_content": "I have enough evidence to answer."
                    },
                },
            ),
        ),
    )

    loaded = service.load_conversation(session_id)

    assert loaded.messages == [
        Message(
            role="assistant",
            content="Done.",
            blocks=(
                RuntimeBlock(
                    type="text",
                    text="Done.",
                    provider_id="msg_001",
                    metadata={
                        "provider_id": "msg_001",
                        "deepseek": {
                            "reasoning_content": "I have enough evidence to answer."
                        },
                    },
                ),
            ),
        )
    ]


def test_session_service_rebuilds_assistant_text_and_tool_call_as_one_message(
    tmp_path: Path,
) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    session_id = "demo"
    service.append_history_items(
        session_id,
        (
            HistoryItem(
                id="turn_1:item:1",
                thread_id=session_id,
                turn_id="turn_1",
                type=HistoryItemType.ASSISTANT_MESSAGE,
                text="I will read README.",
                metadata={
                    "provider_id": "chatcmpl_1",
                    "deepseek": {"reasoning_content": "Need README."},
                },
            ),
            HistoryItem(
                id="turn_1:item:2",
                thread_id=session_id,
                turn_id="turn_1",
                type=HistoryItemType.TOOL_CALL,
                text="Reading README.",
                tool_name="read_file",
                call_id="call_read_1",
                metadata={
                    "arguments": {"path": "README.md"},
                    "provider_id": "chatcmpl_1",
                    "deepseek": {"reasoning_content": "Need README."},
                },
            ),
        ),
    )

    loaded = service.load_conversation(session_id)

    assert [message.role for message in loaded.messages] == ["assistant"]
    assert loaded.messages[0].content == "I will read README."
    assert loaded.messages[0].tool_calls == (
        ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="model requested tool",
            call_id="call_read_1",
        ),
    )
    assert [block.type for block in loaded.messages[0].blocks] == ["text", "tool_call"]


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


def test_session_service_round_trips_invoked_skill_snapshots(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home", workspace_root=tmp_path)
    snapshot = InvokedSkillSnapshot(
        name="code-review",
        description="Review code",
        source_path=str(tmp_path / "skills" / "code-review" / "SKILL.md"),
        body_digest="sha256:abc",
        cached_body_excerpt="Review only changed code.",
        invoked_at=datetime(2026, 5, 27, 8, 0, tzinfo=UTC),
        last_turn_id="turn_1",
    )

    service.record_invoked_skill_snapshot("demo", snapshot)
    loaded = service.load_invoked_skill_snapshots("demo")

    assert loaded == (snapshot,)
    runtime_snapshot = service.load_runtime_snapshot("demo")
    assert runtime_snapshot is not None
    assert runtime_snapshot.invoked_skills == (snapshot,)


def test_session_service_replaces_invoked_skill_by_name_with_latest(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home", workspace_root=tmp_path)
    first = InvokedSkillSnapshot(
        name="code-review",
        description="Old",
        source_path=None,
        body_digest="old",
        cached_body_excerpt="Old body",
        invoked_at=datetime(2026, 5, 27, 8, 0, tzinfo=UTC),
        last_turn_id="turn_1",
    )
    second = InvokedSkillSnapshot(
        name="code-review",
        description="New",
        source_path=None,
        body_digest="new",
        cached_body_excerpt="New body",
        invoked_at=datetime(2026, 5, 27, 9, 0, tzinfo=UTC),
        last_turn_id="turn_2",
    )

    service.record_invoked_skill_snapshot("demo", first)
    service.record_invoked_skill_snapshot("demo", second)

    assert service.load_invoked_skill_snapshots("demo") == (second,)


def test_session_service_round_trips_pending_decision(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    decision = PendingDecision(
        tool_call=ToolCall(
            name="run_shell",
            arguments={"args": ["git", "push"]},
            reason="publish branch",
            call_id="call_run_shell_1",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="Push modifies remote state.",
        preview="git push",
        options=(
            DecisionAction.APPROVE_ONCE,
            DecisionAction.REJECT,
            DecisionAction.ALLOW_SESSION,
            DecisionAction.ALWAYS_ALLOW,
        ),
        command_pattern="git push",
        proposed_execpolicy_pattern=("git", "push"),
        metadata={"risk_reason": "remote mutation", "content_preview": "unused"},
    )

    service.save_pending_decision("demo", decision)
    loaded = service.load_pending_decision("demo")

    assert loaded is not None
    assert loaded.tool_call.name == decision.tool_call.name
    assert loaded.tool_call.arguments == decision.tool_call.arguments
    assert loaded.tool_call.reason == decision.tool_call.reason
    assert loaded.tool_call.call_id == decision.tool_call.call_id
    assert loaded.kind == decision.kind
    assert loaded.reason == decision.reason
    assert loaded.preview == decision.preview
    assert loaded.options == decision.options
    assert loaded.command_pattern == decision.command_pattern
    assert loaded.proposed_execpolicy_pattern == ("git", "push")
    assert loaded.metadata == decision.metadata


def test_session_service_loads_legacy_pending_decision_without_execpolicy_proposal(
    tmp_path: Path,
) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    service._save_state(
        session_id="legacy",
        thread_id="legacy",
        state_key="pending_decision",
        payload={
            "tool_call": {
                "name": "Shell",
                "arguments": {"command": "python script.py"},
                "reason": "run script",
                "call_id": "call_shell_legacy",
            },
            "kind": "needs_choice",
            "reason": "Unknown command requires approval.",
            "preview": "python script.py",
            "options": ["approve_once", "reject"],
            "command_pattern": None,
            "metadata": {},
        },
    )

    loaded = service.load_pending_decision("legacy")

    assert loaded is not None
    assert loaded.proposed_execpolicy_pattern is None


def test_session_service_clears_pending_decision(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    decision = PendingDecision(
        tool_call=ToolCall(
            name="run_shell",
            arguments={"args": ["git", "status"]},
            reason="check state",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="Safe check required.",
        preview="git status",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )

    service.save_pending_decision("demo", decision)
    assert service.load_pending_decision("demo") is not None

    service.clear_pending_decision("demo")
    assert service.load_pending_decision("demo") is None


def test_session_service_round_trips_allowlist(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    allowance = SessionCommandAllowance(command_pattern="git push")

    service.add_command_allowance("demo", allowance)

    assert service.is_command_allowed("demo", "git push") is True
    assert service.is_command_allowed("demo", "git reset --hard") is False

    assert service.remove_command_allowance("demo", "git push") is True
    assert service.is_command_allowed("demo", "git push") is False
    assert service.remove_command_allowance("demo", "git push") is False

    service.add_command_allowance("demo", allowance)
    service.add_command_allowance(
        "demo",
        SessionCommandAllowance(command_pattern="npm test"),
    )
    assert service.clear_command_allowances("demo") == 2
    assert service.load_command_allowances("demo") == ()


def test_session_service_loads_legacy_string_allowance_as_bash(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    service._save_state(
        session_id="demo",
        thread_id="demo",
        state_key="command_allowances",
        payload=["git status"],
    )

    assert service.load_command_allowances("demo") == (
        SessionCommandAllowance(
            command_pattern="git status",
            shell_kind=ShellKind.BASH,
        ),
    )


def test_session_service_round_trips_shell_scoped_allowance(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    allowance = SessionCommandAllowance(
        command_pattern="git status",
        shell_kind=ShellKind.POWERSHELL,
    )

    service.add_command_allowance("demo", allowance)

    assert service.load_command_allowances("demo") == (allowance,)
    assert service._load_state_list("demo", "command_allowances") == [
        {"command_pattern": "git status", "shell_kind": "powershell"}
    ]


def test_session_service_round_trips_suspended_turn(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    suspended = SuspendedTurn(
        user_message="push the branch",
        conversation=(
            Message(role="user", content="push the branch"),
            Message(
                role="assistant",
                content="",
                tool_calls=(
                    ToolCall(
                        name="run_shell",
                        arguments={"args": ["git", "push", "origin", "main"]},
                        reason="publish branch",
                        call_id="call_run_shell_1",
                    ),
                ),
            ),
        ),
        plan_state=PlanState(
            items=(
                PlanItem(
                    id="push",
                    content="Push the current branch",
                    status=PlanStatus.IN_PROGRESS,
                ),
            )
        ),
        pending_approval=None,
    )

    service.save_suspended_turn("demo", suspended)
    loaded = service.load_suspended_turn("demo")

    assert loaded is not None
    assert loaded.user_message == "push the branch"
    assert loaded.plan_state.items[0].status is PlanStatus.IN_PROGRESS
    assert loaded.conversation[1].tool_calls[0].call_id == "call_run_shell_1"


def test_suspended_turn_persists_suspend_reason(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path)
    suspended = SuspendedTurn(
        user_message="inspect",
        conversation=(Message(role="user", content="inspect"),),
        suspend_reason=StopReason.INTERRUPTED,
    )

    service.save_suspended_turn("demo", suspended)
    loaded = service.load_suspended_turn("demo")

    assert loaded is not None
    assert loaded.suspend_reason is StopReason.INTERRUPTED


def test_session_service_round_trips_suspended_turn_conversation_blocks(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    suspended = SuspendedTurn(
        user_message="inspect repo",
        conversation=(
            Message(
                role="assistant",
                content="Starting analysis.",
                response_id="resp_456",
                blocks=(
                    RuntimeBlock(
                        type="tool_call",
                        tool_name="read_file",
                        tool_arguments={"path": "README.md"},
                        call_id="call_read_1",
                        provider_id="fc_read_1",
                        metadata={"origin": "model"},
                    ),
                    RuntimeBlock(
                        type="tool_result",
                        text="README contents loaded",
                        call_id="call_read_1",
                        provider_id="tr_001",
                        metadata={"ok": True},
                    ),
                ),
            ),
        ),
    )

    service.save_suspended_turn("demo", suspended)
    loaded = service.load_suspended_turn("demo")

    assert loaded is not None
    assert loaded.conversation[0].response_id == "resp_456"
    assert len(loaded.conversation[0].blocks) == 2
    assert loaded.conversation[0].blocks[0].call_id == "call_read_1"
    assert loaded.conversation[0].blocks[0].tool_arguments == {"path": "README.md"}
    assert loaded.conversation[0].blocks[0].provider_id == "fc_read_1"
    assert loaded.conversation[0].blocks[0].metadata == {"origin": "model"}
    assert loaded.conversation[0].blocks[1].type == "tool_result"
    assert loaded.conversation[0].blocks[1].call_id == "call_read_1"
    assert loaded.conversation[0].blocks[1].provider_id == "tr_001"
    assert loaded.conversation[0].blocks[1].metadata == {"ok": True}


def test_session_service_round_trips_tool_result_payload_metadata(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    conversation = Conversation(session_id="demo")
    conversation.append(
        Message(
            role="tool",
            content="Tool read_file: README contents loaded",
            tool_call_id="call_read_1",
            blocks=(
                RuntimeBlock(
                    type="tool_result",
                    text="README contents loaded",
                    call_id="call_read_1",
                    metadata={
                        "function_call_output_payload": {
                            "body": "README contents loaded",
                            "structured_content": [{"path": "README.md"}],
                            "success": True,
                        }
                    },
                ),
            ),
        )
    )

    service.save_conversation(conversation)
    loaded = service.load_conversation("demo")

    assert loaded.messages[0].blocks[0].metadata["function_call_output_payload"] == {
        "body": "README contents loaded",
        "structured_content": [{"path": "README.md"}],
        "success": True,
    }


def test_session_service_round_trips_suspended_pending_approval_call_id(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    suspended = SuspendedTurn(
        user_message="push the branch",
        conversation=(Message(role="user", content="push the branch"),),
        pending_approval=PendingApproval(
            tool_call=ToolCall(
                name="run_shell",
                arguments={"args": ["git", "push", "origin", "main"]},
                reason="publish branch",
                call_id="call_run_shell_2",
            ),
            reason="Push modifies remote state.",
            preview="git push origin main",
            command_pattern="git push",
            proposed_execpolicy_pattern=("git", "push"),
            metadata={"content_preview": "hello", "content_line_count": 1},
        ),
    )

    service.save_suspended_turn("demo", suspended)
    loaded = service.load_suspended_turn("demo")

    assert loaded is not None
    assert loaded.pending_approval is not None
    assert loaded.pending_approval.tool_call.call_id == "call_run_shell_2"
    assert loaded.pending_approval.proposed_execpolicy_pattern == ("git", "push")
    assert loaded.pending_approval.metadata == suspended.pending_approval.metadata


def test_session_service_round_trips_suspended_pending_clarification(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    suspended = SuspendedTurn(
        user_message="choose next slice",
        conversation=(Message(role="user", content="choose next slice"),),
        pending_clarification=PendingClarification(
            request_id="call_question_1",
            tool_call=ToolCall(
                name="AskUserQuestion",
                arguments={
                    "question": "Which slice should come next?",
                    "options": [{"label": "Runtime"}, {"label": "TUI"}],
                },
                reason="clarify scope",
                call_id="call_question_1",
            ),
            question="Which slice should come next?",
            options=(
                {"label": "Runtime", "description": "Only runtime contract"},
                {"label": "TUI", "description": "Render the request"},
            ),
            header="Scope",
            multi_select=False,
        ),
    )

    service.save_suspended_turn("demo", suspended)
    loaded = service.load_suspended_turn("demo")

    assert loaded is not None
    assert loaded.pending_clarification is not None
    assert loaded.pending_clarification.request_id == "call_question_1"
    assert loaded.pending_clarification.tool_call.call_id == "call_question_1"
    assert loaded.pending_clarification.question == "Which slice should come next?"
    assert loaded.pending_clarification.options[0]["label"] == "Runtime"


def test_session_service_round_trips_plan_state(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    plan_state = PlanState(
        items=(
            PlanItem(
                id="inspect",
                content="Inspect runtime entrypoints",
                status=PlanStatus.IN_PROGRESS,
                evidence=("read runtime entrypoints",),
            ),
            PlanItem(
                id="summarize",
                content="Summarize findings",
                status=PlanStatus.PENDING,
            ),
        )
    )

    service.save_plan_state("demo", plan_state)
    loaded = service.load_plan_state("demo")

    assert loaded.items[0].id == "inspect"
    assert loaded.items[0].content == "Inspect runtime entrypoints"
    assert loaded.items[0].status is PlanStatus.IN_PROGRESS
    assert loaded.items[0].evidence == ("read runtime entrypoints",)
    assert loaded.items[1].status is PlanStatus.PENDING


def test_session_service_round_trips_turn_record(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    turn = TurnRecord(
        thread_id="demo",
        turn_id="turn_1",
        status=TurnStatus.COMPLETED,
        stop_reason=StopReason.ASSISTANT_COMPLETED,
        started_at="2026-04-11T00:00:00+00:00",
        completed_at="2026-04-11T00:00:01+00:00",
        items=(
            TurnItem(type=TurnItemType.USER_MESSAGE, text="inspect repo"),
            TurnItem(
                type=TurnItemType.TOOL_RESULT,
                text="Failed to read missing.py",
                tool_name="read_file",
                call_id="call_1",
                metadata={"success": False, "error_kind": "not_found"},
            ),
        ),
    )

    service.save_turn_record("demo", turn)
    loaded = service.load_turn_record("demo")

    assert loaded is not None
    assert loaded.turn_id == "turn_1"
    assert loaded.stop_reason is StopReason.ASSISTANT_COMPLETED
    assert loaded.items[1].type is TurnItemType.TOOL_RESULT
    assert loaded.items[1].metadata["error_kind"] == "not_found"


def test_session_service_round_trips_responses_continuation_state(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    state = ResponsesContinuationState(
        response_id="resp_123",
        request_signature='{"model":"gpt-test"}',
        request_input=(
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "inspect"}],
            },
        ),
        response_output=(
            {
                "role": "assistant",
                "content": [{"type": "output_text", "text": "done"}],
            },
        ),
        eligible=True,
    )

    service.save_responses_continuation_state("demo", state)
    loaded = service.load_responses_continuation_state("demo")

    assert loaded == state


def test_session_service_round_trips_capability_turn_item(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    turn = TurnRecord(
        thread_id="demo",
        turn_id="turn_capability_1",
        status=TurnStatus.COMPLETED,
        stop_reason=StopReason.ASSISTANT_COMPLETED,
        started_at="2026-04-12T00:00:00+00:00",
        completed_at="2026-04-12T00:00:01+00:00",
        items=(
            TurnItem(
                type=TurnItemType.CAPABILITY,
                text="Capability activated: repository-analysis",
                metadata={
                    "capability_name": "repository-analysis",
                    "source": "explicit_mention",
                    "dependency_status": "ready",
                },
            ),
        ),
    )

    service.save_turn_record("demo", turn)
    loaded = service.load_turn_record("demo")

    assert loaded is not None
    assert loaded.items[0].type is TurnItemType.CAPABILITY
    assert loaded.items[0].metadata["capability_name"] == "repository-analysis"


def test_session_service_round_trips_tool_exposure_turn_item(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    turn = TurnRecord(
        thread_id="demo",
        turn_id="turn_tool_exposure_1",
        status=TurnStatus.COMPLETED,
        stop_reason=StopReason.ASSISTANT_COMPLETED,
        started_at="2026-04-12T00:00:00+00:00",
        completed_at="2026-04-12T00:00:01+00:00",
        items=(
            TurnItem(
                type=TurnItemType.TOOL_EXPOSURE,
                text="Tool exposure: tools=list_directory, run_shell, workspace_summary",
                metadata={"tool_names": ["list_directory", "run_shell", "workspace_summary"]},
            ),
        ),
    )

    service.save_turn_record("demo", turn)
    loaded = service.load_turn_record("demo")

    assert loaded is not None
    assert loaded.items[0].type is TurnItemType.TOOL_EXPOSURE
    assert loaded.items[0].metadata["tool_names"] == ["list_directory", "run_shell", "workspace_summary"]


def test_session_service_round_trips_contributed_tool_state(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    descriptors = [
        {
            "tool_id": "runtime:daily_brief:thread",
            "display_name": "daily_brief",
            "description": "Prepare a daily brief",
            "route_name": "daily_brief",
            "source": "runtime",
            "scope": "thread",
            "state": "exposed",
            "origin_metadata": {"workspace": "personal"},
        }
    ]

    service.save_contributed_tool_state("demo", descriptors)

    assert service.load_contributed_tool_state("demo") == descriptors


def test_session_service_appends_and_loads_structured_history_items(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    initial_items = (
        HistoryItem(
            id="hist_1",
            thread_id="demo",
            turn_id="turn_1",
            type=HistoryItemType.USER_MESSAGE,
            text="inspect the repo",
            metadata={"role": "user"},
        ),
        HistoryItem(
            id="hist_2",
            thread_id="demo",
            turn_id="turn_1",
            type=HistoryItemType.TOOL_CALL,
            text="Listing: .",
            tool_name="list_directory",
            call_id="call_list_1",
            metadata={"arguments": {"path": "."}},
        ),
    )
    later_items = (
        HistoryItem(
            id="hist_3",
            thread_id="demo",
            turn_id="turn_1",
            type=HistoryItemType.TOOL_RESULT,
            text="Done listing: .",
            tool_name="list_directory",
            call_id="call_list_1",
            metadata={"success": True, "path": "."},
        ),
    )

    service.append_history_items("demo", initial_items)
    service.append_history_items("demo", later_items)
    loaded = service.load_history_items("demo")

    assert [item.id for item in loaded] == ["hist_1", "hist_2", "hist_3"]
    assert loaded[1].metadata["arguments"] == {"path": "."}
    assert loaded[2].type is HistoryItemType.TOOL_RESULT


def test_session_service_rebuilds_conversation_from_structured_history_when_legacy_transcript_missing(
    tmp_path: Path,
) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    service.append_history_items(
        "demo",
        (
            HistoryItem(
                id="hist_user_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.USER_MESSAGE,
                text="inspect the repo",
                metadata={"role": "user"},
            ),
            HistoryItem(
                id="hist_assistant_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.ASSISTANT_MESSAGE,
                text="I inspected the repo and found the runtime entrypoints.",
                metadata={"role": "assistant"},
            ),
        ),
    )

    loaded = service.load_conversation("demo")

    assert [message.role for message in loaded.messages] == ["user", "assistant"]
    assert loaded.messages[0].content == "inspect the repo"
    assert loaded.messages[1].content == "I inspected the repo and found the runtime entrypoints."


def test_session_service_round_trips_context_baseline(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    baseline = ContextBaseline(
        thread_id="demo",
        fragments=(
            BaselineFragment(
                id="baseline_workspace",
                kind="workspace_instructions",
                title="Workspace instructions",
                content="Keep diffs focused and avoid hardcoded behavior.",
                source="AGENTS.md",
                metadata={"scope": "repo"},
            ),
            BaselineFragment(
                id="baseline_environment",
                kind="environment_context",
                title="Environment context",
                content="Workspace root: /repo",
                source="runtime",
            ),
        ),
    )

    service.save_context_baseline("demo", baseline)
    loaded = service.load_context_baseline("demo")

    assert loaded == baseline


def test_session_service_appends_and_loads_turn_rollouts(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    first_rollout = TurnRollout(
        thread_id="demo",
        turn_id="turn_1",
        status=TurnStatus.COMPLETED,
        stop_reason=StopReason.ASSISTANT_COMPLETED,
        started_at="2026-04-15T00:00:00+00:00",
        completed_at="2026-04-15T00:00:02+00:00",
        events=(
            TurnRolloutEvent(
                event_id="evt_1",
                kind="tool_execution",
                created_at="2026-04-15T00:00:01+00:00",
                payload={"tool_name": "list_directory", "success": True},
            ),
        ),
        continuation_state={"response_id": "resp_123", "eligible": True},
    )
    second_rollout = TurnRollout(
        thread_id="demo",
        turn_id="turn_2",
        status=TurnStatus.FAILED,
        stop_reason=StopReason.MODEL_ERROR,
        started_at="2026-04-15T00:01:00+00:00",
        completed_at="2026-04-15T00:01:01+00:00",
        events=(),
        continuation_state={"response_id": "resp_124", "eligible": False},
    )

    service.append_turn_rollout("demo", first_rollout)
    service.append_turn_rollout("demo", second_rollout)
    loaded = service.load_turn_rollouts("demo")

    assert [rollout.turn_id for rollout in loaded] == ["turn_1", "turn_2"]
    assert loaded[0].events[0].payload["tool_name"] == "list_directory"
    assert loaded[1].stop_reason is StopReason.MODEL_ERROR


def test_session_service_compacts_history_by_replacing_a_window_with_compaction_item(
    tmp_path: Path,
) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    service.append_history_items(
        "demo",
        (
            HistoryItem(
                id="hist_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.USER_MESSAGE,
                text="inspect repo",
            ),
            HistoryItem(
                id="hist_2",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.REASONING,
                text="Thinking: inspect files",
            ),
            HistoryItem(
                id="hist_3",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.TOOL_RESULT,
                text="Done reading: pyproject.toml",
                tool_name="read_file",
                call_id="call_read_1",
            ),
        ),
    )

    service.compact_history(
        "demo",
        replaced_item_ids=("hist_2", "hist_3"),
        compacted_item=HistoryItem(
            id="compact_1",
            thread_id="demo",
            turn_id="turn_compact_1",
            type=HistoryItemType.COMPACTION,
            text="Compacted reasoning and file read into a shorter history item.",
            metadata={"replaced_item_ids": ["hist_2", "hist_3"]},
        ),
    )
    loaded = service.load_history_items("demo")

    assert [item.id for item in loaded] == ["hist_1", "compact_1"]
    assert loaded[1].type is HistoryItemType.COMPACTION
    assert loaded[1].metadata["replaced_item_ids"] == ["hist_2", "hist_3"]


def test_session_service_loads_runtime_snapshot_from_durable_state(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    service.append_history_items(
        "demo",
        (
            HistoryItem(
                id="hist_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.USER_MESSAGE,
                text="inspect repo",
            ),
        ),
    )
    baseline = ContextBaseline(
        thread_id="demo",
        fragments=(
            BaselineFragment(
                id="baseline_workspace",
                kind="workspace_instructions",
                title="Workspace instructions",
                content="Keep changes focused.",
            ),
        ),
    )
    service.save_context_baseline("demo", baseline)
    rollout = TurnRollout(
        thread_id="demo",
        turn_id="turn_1",
        status=TurnStatus.COMPLETED,
        started_at="2026-04-15T00:00:00+00:00",
        completed_at="2026-04-15T00:00:01+00:00",
        stop_reason=StopReason.ASSISTANT_COMPLETED,
    )
    service.append_turn_rollout("demo", rollout)
    continuation_state = ResponsesContinuationState(
        response_id="resp_123",
        request_signature='{"model":"gpt-test"}',
        request_input=(),
        response_output=(),
        eligible=True,
    )
    service.save_responses_continuation_state("demo", continuation_state)

    snapshot = service.load_runtime_snapshot("demo")

    assert snapshot is not None
    assert snapshot.session_id == "demo"
    assert snapshot.thread_id == "demo"
    assert snapshot.history_items[0].id == "hist_1"
    assert snapshot.context_baseline == baseline
    assert snapshot.turn_rollouts[0].turn_id == "turn_1"
    assert snapshot.continuation_state == continuation_state.to_dict()


def test_session_service_recovers_continuation_state_from_latest_rollout_snapshot(
    tmp_path: Path,
) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    rollout = TurnRollout(
        thread_id="demo",
        turn_id="turn_1",
        status=TurnStatus.COMPLETED,
        started_at="2026-04-15T00:00:00+00:00",
        completed_at="2026-04-15T00:00:01+00:00",
        stop_reason=StopReason.ASSISTANT_COMPLETED,
        continuation_state={
            "response_id": "resp_from_rollout",
            "request_signature": '{"model":"gpt-test"}',
            "request_input": [],
            "response_output": [],
            "eligible": True,
            "failure_reason": None,
        },
    )
    service.append_turn_rollout("demo", rollout)

    loaded = service.load_responses_continuation_state("demo")

    assert loaded is not None
    assert loaded.response_id == "resp_from_rollout"
    assert loaded.eligible is True


def test_session_service_syncs_legacy_conversation_view_from_structured_history(
    tmp_path: Path,
) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    service.append_history_items(
        "demo",
        (
            HistoryItem(
                id="hist_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.USER_MESSAGE,
                text="inspect repo",
            ),
            HistoryItem(
                id="hist_2",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.ASSISTANT_MESSAGE,
                text="I inspected the repo root.",
            ),
            HistoryItem(
                id="hist_3",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.TOOL_RESULT,
                text="Read pyproject.toml",
                tool_name="read_file",
                call_id="call_read_1",
            ),
        ),
    )

    service.sync_conversation_view_from_history("demo")
    loaded = service.load_conversation("demo")

    assert [message.role for message in loaded.messages] == ["user", "assistant", "tool"]
    assert loaded.messages[2].tool_call_id == "call_read_1"


def test_session_service_reconstructs_suspended_turn_from_runtime_snapshot(
    tmp_path: Path,
) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    service.append_history_items(
        "demo",
        (
            HistoryItem(
                id="hist_1",
                thread_id="demo",
                turn_id="turn_waiting",
                type=HistoryItemType.USER_MESSAGE,
                text="push the branch",
            ),
            HistoryItem(
                id="hist_2",
                thread_id="demo",
                turn_id="turn_waiting",
                type=HistoryItemType.APPROVAL_REQUEST,
                text="Waiting approval: git push",
                tool_name="run_shell",
                call_id="call_push_1",
                metadata={"preview": "git push"},
            ),
        ),
    )
    service.append_turn_rollout(
        "demo",
        TurnRollout(
            thread_id="demo",
            turn_id="turn_waiting",
            status=TurnStatus.WAITING_APPROVAL,
            started_at="2026-04-15T00:00:00+00:00",
            completed_at="2026-04-15T00:00:01+00:00",
            stop_reason=StopReason.APPROVAL_REQUIRED,
        ),
    )
    service.save_turn_record(
        "demo",
        TurnRecord(
            thread_id="demo",
            turn_id="turn_waiting",
            status=TurnStatus.WAITING_APPROVAL,
            started_at="2026-04-15T00:00:00+00:00",
            completed_at="2026-04-15T00:00:01+00:00",
            stop_reason=StopReason.APPROVAL_REQUIRED,
            user_message="push the branch",
            items=(
                TurnItem(type=TurnItemType.USER_MESSAGE, text="push the branch"),
                TurnItem(
                    type=TurnItemType.APPROVAL_REQUEST,
                    text="Waiting approval: git push",
                    tool_name="run_shell",
                    call_id="call_push_1",
                    metadata={"preview": "git push"},
                ),
            ),
        ),
    )
    service.save_plan_state(
        "demo",
        PlanState(
            items=(
                PlanItem(
                    id="push",
                    content="Push the current branch",
                    status=PlanStatus.IN_PROGRESS,
                ),
            )
        ),
    )
    pending_decision = PendingDecision(
        tool_call=ToolCall(
            name="run_shell",
            arguments={"args": ["git", "push"]},
            reason="publish branch",
            call_id="call_push_1",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="Push modifies remote state.",
        preview="git push",
        options=(
            DecisionAction.APPROVE_ONCE,
            DecisionAction.REJECT,
            DecisionAction.ALLOW_SESSION,
            DecisionAction.ALWAYS_ALLOW,
        ),
        command_pattern="git push",
        proposed_execpolicy_pattern=("git", "push"),
    )

    reconstructed = service.reconstruct_suspended_turn("demo", pending_decision)

    assert reconstructed is not None
    assert reconstructed.user_message == "push the branch"
    assert reconstructed.pending_approval is not None
    assert reconstructed.pending_approval.tool_call.call_id == "call_push_1"
    assert reconstructed.pending_approval.proposed_execpolicy_pattern == ("git", "push")
    assert reconstructed.plan_state.items[0].status is PlanStatus.IN_PROGRESS
