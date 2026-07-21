from __future__ import annotations

import json
from pathlib import Path

import pytest

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import HistoryItem, HistoryItemType
from mycli.services.session_snapshot import SessionSnapshotContext, SessionSnapshotService


def test_snapshot_writes_sparse_v3_transcript_without_runtime_messages(tmp_path: Path) -> None:
    service = SessionSnapshotService(home_dir=tmp_path)
    conversation = Conversation(
        session_id="demo",
        messages=[Message(role="user", content="inspect repo")],
    )
    history = (
        HistoryItem(
            id="user-1",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.USER_MESSAGE,
            text="inspect repo",
        ),
    )

    service.write_conversation_snapshot(
        conversation=conversation,
        history_items=history,
        context=SessionSnapshotContext(workspace_root=tmp_path),
    )

    payload = json.loads(service.snapshot_path("demo").read_text(encoding="utf-8"))
    assert payload["schema_version"] == 3
    assert "messages" not in payload
    assert payload["transcript"] == [
        {"id": "user-1", "type": "user_message", "text": "inspect repo"}
    ]
    assert "provider" not in payload
    assert "subagents" not in payload


def test_snapshot_writes_readable_indented_json(tmp_path: Path) -> None:
    service = SessionSnapshotService(home_dir=tmp_path)
    service.write_conversation_snapshot(
        conversation=Conversation(
            session_id="readable",
            messages=[Message(role="user", content="inspect repo")],
        ),
        history_items=(),
        context=SessionSnapshotContext(workspace_root=tmp_path),
    )

    persisted = service.snapshot_path("readable").read_text(encoding="utf-8")

    assert persisted.startswith("{\n")
    assert '\n  "created_at":' in persisted
    assert persisted.endswith("\n")


def test_snapshot_preserves_created_at_across_rewrites(tmp_path: Path) -> None:
    service = SessionSnapshotService(home_dir=tmp_path)
    conversation = Conversation(
        session_id="demo",
        messages=[Message(role="user", content="one")],
    )
    context = SessionSnapshotContext(workspace_root=tmp_path)

    service.write_conversation_snapshot(
        conversation=conversation,
        history_items=(),
        context=context,
    )
    first = service.read_snapshot("demo")
    service.write_conversation_snapshot(
        conversation=conversation,
        history_items=(),
        context=context,
    )
    second = service.read_snapshot("demo")

    assert first is not None
    assert second is not None
    assert second["created_at"] == first["created_at"]


def test_empty_snapshot_keeps_required_transcript_array(tmp_path: Path) -> None:
    service = SessionSnapshotService(home_dir=tmp_path)
    service.write_conversation_snapshot(
        conversation=Conversation(session_id="empty"),
        history_items=(),
        context=SessionSnapshotContext(workspace_root=tmp_path),
    )

    payload = service.read_snapshot("empty")

    assert payload is not None
    assert payload["transcript"] == []


def test_snapshot_reader_rejects_corrupt_json_without_deleting_it(tmp_path: Path) -> None:
    service = SessionSnapshotService(home_dir=tmp_path)
    path = service.snapshot_path("demo")
    path.parent.mkdir(parents=True)
    path.write_text('{"schema_version":', encoding="utf-8")

    assert service.read_snapshot("demo") is None
    assert path.read_text(encoding="utf-8") == '{"schema_version":'


def test_snapshot_reader_rejects_invalid_utf8_without_deleting_it(tmp_path: Path) -> None:
    service = SessionSnapshotService(home_dir=tmp_path)
    path = service.snapshot_path("demo")
    path.parent.mkdir(parents=True)
    invalid = b'{"schema_version":2,"transcript":[]}\xff'
    path.write_bytes(invalid)

    assert service.read_snapshot("demo") is None
    assert path.read_bytes() == invalid


def test_atomic_replace_failure_preserves_previous_snapshot(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = SessionSnapshotService(home_dir=tmp_path)
    context = SessionSnapshotContext(workspace_root=tmp_path)
    service.write_conversation_snapshot(
        conversation=Conversation(
            session_id="demo",
            messages=[Message(role="user", content="before")],
        ),
        history_items=(),
        context=context,
    )
    path = service.snapshot_path("demo")
    previous = path.read_text(encoding="utf-8")
    original_replace = Path.replace

    def fail_temporary_replace(source: Path, target: Path) -> Path:
        if source.name.startswith(".session.json."):
            raise OSError("rename failed")
        return original_replace(source, target)

    monkeypatch.setattr(Path, "replace", fail_temporary_replace)

    with pytest.raises(OSError, match="rename failed"):
        service.write_conversation_snapshot(
            conversation=Conversation(
                session_id="demo",
                messages=[Message(role="user", content="after")],
            ),
            history_items=(),
            context=context,
        )

    assert path.read_text(encoding="utf-8") == previous
    assert list(path.parent.glob(".session.json.*.tmp")) == []


def test_snapshot_tui_reader_skips_malformed_items(tmp_path: Path) -> None:
    service = SessionSnapshotService(home_dir=tmp_path)
    path = service.snapshot_path("demo")
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "session_id": "demo",
                "transcript": [
                    {"id": "user-1", "type": "user_message", "text": "hello"},
                    {"id": 42, "type": "assistant_message", "text": "invalid"},
                    "not-an-object",
                ],
            }
        ),
        encoding="utf-8",
    )

    assert service.load_tui_items("demo") == (
        {
            "id": "user-1",
            "type": "user",
            "text": "hello",
            "created_at": "",
            "folded": False,
            "metadata": {},
        },
    )


def test_v2_snapshot_requires_rebuild_but_remains_readable(tmp_path: Path) -> None:
    service = SessionSnapshotService(home_dir=tmp_path)
    path = service.snapshot_path("legacy")
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "session_id": "legacy",
                "transcript": [
                    {"id": "user-1", "type": "user_message", "text": "hello"},
                    {
                        "id": "command-1",
                        "type": "command_result",
                        "text": "transient status output",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    assert service.snapshot_requires_rebuild("legacy") is True
    assert service.load_tui_items("legacy") == (
        {
            "id": "user-1",
            "type": "user",
            "text": "hello",
            "created_at": "",
            "folded": False,
            "metadata": {},
        },
    )


def test_v3_snapshot_omits_repeated_runtime_payloads(tmp_path: Path) -> None:
    private_blob = "provider-private-reasoning-" * 2_000
    repeated_tool_output = "same shell output\n" * 2_000
    conversation = Conversation(session_id="large")
    history = (
        HistoryItem(
            id="tool-call",
            thread_id="large",
            turn_id="turn-1",
            type=HistoryItemType.TOOL_CALL,
            text="Run tests",
            tool_name="Bash",
            call_id="call-1",
            metadata={
                "arguments": {"command": "pytest -q"},
                "provider_blob": private_blob,
            },
        ),
        HistoryItem(
            id="tool-result",
            thread_id="large",
            turn_id="turn-1",
            type=HistoryItemType.TOOL_RESULT,
            text=repeated_tool_output,
            tool_name="Bash",
            call_id="call-1",
            metadata={
                "transcript_content": repeated_tool_output,
                "summary": repeated_tool_output,
                "provider_blob": private_blob,
            },
        ),
    )
    service = SessionSnapshotService(home_dir=tmp_path)

    service.write_conversation_snapshot(
        conversation=conversation,
        history_items=history,
        context=SessionSnapshotContext(workspace_root=tmp_path),
    )

    persisted = service.snapshot_path("large").read_text(encoding="utf-8")
    payload = json.loads(persisted)
    assert "messages" not in payload
    assert "provider_blob" not in persisted
    assert "transcript_content" not in persisted
    assert '"summary"' not in persisted
    assert len(payload["transcript"]) == 1
    assert len(str(payload["transcript"][0]["output"])) <= 8_000
