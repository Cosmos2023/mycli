from __future__ import annotations

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
