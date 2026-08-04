from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import sqlite3
import subprocess
from typing import Any, Protocol, cast

from mycli.domain.tooling.calls import ToolCall
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore
from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.services.file_change_display import project_file_changes
from mycli.tools.edit import EditTool
from mycli.tools.base import ToolResult
from mycli.tools.file_snapshot import FileSnapshotStore
from mycli.tools.patch import PatchTool
from mycli.tools.read import ReadTool
from mycli.tools.write import WriteTool

ROOT = Path(__file__).parents[2]
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "node_runtime_m4" / "mutation_contract.json"
NODE_HELPER = ROOT / "tests" / "integration" / "node_runtime_m4_parity_helper.ts"


def test_python_and_node_mutations_match_shared_m4_contract(tmp_path: Path) -> None:
    fixture = _fixture()
    expected = [case["expected"] | {"name": case["name"], "tool": case["tool"]} for case in fixture["cases"]]
    node = _node("probe", tmp_path / "node", tmp_path / "node.db", FIXTURE_PATH)

    assert node["inventory"] == fixture["inventory"]["tools"]
    assert not set(node["inventory"]) & set(fixture["inventory"]["retired_tools"])
    assert node["parameters"] == fixture["inventory"]["parameters"]
    assert node["cases"] == expected
    assert _python_cases(tmp_path / "python", fixture) == expected


def test_python_and_node_read_each_others_m4_mutation_transcript(tmp_path: Path) -> None:
    fixture = _fixture()
    transcript = fixture["transcript"]
    failure = fixture["failure_transcript"]
    node_db = tmp_path / "node.db"
    _node("probe", tmp_path / "node-workspace", node_db, FIXTURE_PATH)

    node_messages = SQLiteSessionStore(node_db).load_conversation(transcript["session_id"])
    assert node_messages is not None
    assert _transcript_signature(node_messages) == _expected_transcript_signature(transcript)
    with sqlite3.connect(node_db) as connection:
        row = connection.execute(
            """
            SELECT payload_json FROM history_items
            WHERE session_id = ? AND json_extract(payload_json, '$.type') = 'tool_result'
            """,
            (transcript["session_id"],),
        ).fetchone()
    assert row is not None
    history = cast(dict[str, Any], json.loads(str(row[0])))
    assert history["metadata"]["file_changes"] == transcript["file_changes"]
    failed_messages = SQLiteSessionStore(node_db).load_conversation(failure["session_id"])
    assert failed_messages is not None
    assert _transcript_signature(failed_messages) == _expected_transcript_signature(failure)

    python_db = tmp_path / "python.db"
    raw_messages = _raw_messages(transcript)
    SQLiteSessionStore(python_db).replace_conversation(
        session_id=transcript["session_id"],
        workspace_root=tmp_path / "python-workspace",
        thread_id=transcript["session_id"],
        messages=raw_messages,
    )
    SQLiteSessionStore(python_db).replace_conversation(
        session_id=failure["session_id"],
        workspace_root=tmp_path / "python-workspace",
        thread_id=failure["session_id"],
        messages=_raw_messages(failure),
    )
    node_read = _node("read-db", python_db, transcript["session_id"])
    assert node_read["types"] == transcript["canonical_item_types"]
    assert node_read["signature"] == _expected_transcript_signature(transcript)
    failed_node_read = _node("read-db", python_db, failure["session_id"])
    assert failed_node_read["types"] == failure["canonical_item_types"]
    assert failed_node_read["signature"] == _expected_transcript_signature(failure)


@dataclass(frozen=True, slots=True)
class CaseState:
    workspace: Path
    protected: Path


class MutationTool(Protocol):
    def execute(self, arguments: dict[str, Any]) -> ToolResult: ...


def _python_cases(root: Path, fixture: dict[str, Any]) -> list[dict[str, Any]]:
    root.mkdir(parents=True)
    results: list[dict[str, Any]] = []
    for case in fixture["cases"]:
        state = _setup_case(root / case["name"], case["setup"])
        snapshots = FileSnapshotStore()
        read = ReadTool(state.workspace, snapshot_store=snapshots)
        tools: dict[str, MutationTool] = {
            "Edit": EditTool(state.workspace, snapshot_store=snapshots),
            "Patch": PatchTool(state.workspace, snapshot_store=snapshots),
            "Write": WriteTool(state.workspace),
        }
        arguments = dict(case["arguments"])
        read_result = None
        if case.get("pre_read") is True:
            read_result = read.execute(
                {"file_path": arguments["file_path"], "offset": 1, "limit": 20}
            )
            assert read_result.success is True
        if after_read := case.get("after_read_content"):
            state.protected.write_text(str(after_read), encoding="utf-8")
        _apply_argument_factory(arguments, case.get("argument_factory"), read_result)
        before = _path_state(state.protected)
        tool = tools[case["tool"]]
        result = tool.execute(arguments)
        changes = project_file_changes(
            ToolCall(name=case["tool"], arguments=arguments, reason="fixture"),
            result,
        )
        assert all(
            len(change.diff) <= 200_000 and len(change.diff.splitlines()) <= 5_000
            for change in changes
        )
        change = changes[0] if changes else None
        raw = result.raw_payload
        results.append(
            {
                "name": case["name"],
                "tool": case["tool"],
                "success": result.success,
                "status": raw.get("status") if result.success else None,
                "error_kind": raw.get("error_kind") if not result.success else None,
                "matches": raw.get("matches") if isinstance(raw.get("matches"), int) else None,
                "receipt": ToolResultFormatter().format(case["tool"], result)
                if result.success
                else None,
                "change_kind": change.kind.value if change else None,
                "added_lines": change.added_lines if change else None,
                "removed_lines": change.removed_lines if change else None,
                "preserved": _path_state(state.protected) == before,
                "final_content": _small_text(state.protected),
            }
        )
    return results


def _setup_case(root: Path, setup: dict[str, Any]) -> CaseState:
    workspace = root / "workspace"
    workspace.mkdir(parents=True)
    kind = setup["kind"]
    raw_path = str(setup["path"])
    if kind == "outside_text":
        protected = workspace.parent / "outside.txt"
        protected.write_text(str(setup["content"]), encoding="utf-8")
        return CaseState(workspace, protected)
    if kind == "symlink_escape":
        outside = root / "outside"
        outside.mkdir()
        protected = outside / "outside.txt"
        protected.write_text(str(setup["content"]), encoding="utf-8")
        (workspace / "link").symlink_to(outside, target_is_directory=True)
        return CaseState(workspace, protected)
    protected = workspace / raw_path
    protected.parent.mkdir(parents=True, exist_ok=True)
    if kind == "text":
        protected.write_text(str(setup["content"]), encoding="utf-8")
    elif kind == "binary":
        protected.write_bytes(b"\x00\x01\x02")
    elif kind == "invalid_utf8":
        protected.write_bytes(b"\xff\xfe")
    elif kind == "directory":
        protected.mkdir()
    elif kind == "large_text":
        protected.write_text("x\n" * 500_001, encoding="utf-8")
    elif kind != "missing":
        raise AssertionError(f"unknown setup kind: {kind}")
    return CaseState(workspace, protected)


def _apply_argument_factory(
    arguments: dict[str, Any],
    factory: object,
    read_result: object,
) -> None:
    if factory == "oversized_content":
        arguments["content"] = "x" * 1_000_001
    elif factory == "secret_content":
        arguments["content"] = "api_key = 'fixture-secret-value'\n"
    elif factory == "snapshot_sha256":
        assert read_result is not None and hasattr(read_result, "raw_payload")
        arguments["expected_sha256"] = read_result.raw_payload["snapshot"]["sha256"]
    elif factory is not None:
        raise AssertionError(f"unknown argument factory: {factory}")


def _path_state(path: Path) -> tuple[str, bytes] | tuple[str]:
    if not path.exists():
        return ("missing",)
    if path.is_dir():
        return ("directory",)
    return ("file", path.read_bytes())


def _small_text(path: Path) -> str | None:
    if not path.is_file() or path.stat().st_size > 10_000:
        return None
    try:
        text = path.read_text(encoding="utf-8")
        if any(ord(character) < 32 and character not in "\t\n\f\r\x1b" for character in text):
            return None
        return text
    except UnicodeDecodeError:
        return None


def _raw_messages(transcript: dict[str, Any]) -> list[dict[str, Any]]:
    success = "error_kind" not in transcript
    file_changes = transcript.get("file_changes")
    result_metadata: dict[str, Any] = {
        "turn_id": transcript["turn_id"],
        "source": "node_runtime",
        "tool_name": transcript["tool_name"],
        "success": success,
        "summary": transcript["summary"],
    }
    block_metadata: dict[str, Any] = {"success": success}
    if file_changes is not None:
        result_metadata["file_changes"] = file_changes
        block_metadata["file_changes"] = file_changes
    if error_kind := transcript.get("error_kind"):
        result_metadata["error_kind"] = error_kind
        block_metadata["error_kind"] = error_kind
    return [
        {
            "role": "user",
            "content": "Run the requested file tool",
            "tool_call_id": None,
            "response_id": None,
            "metadata": {
                "turn_id": transcript["turn_id"],
                "client_turn_id": transcript["client_turn_id"],
                "source": "node_runtime",
            },
            "blocks": [],
            "tool_calls": [],
        },
        {
            "role": "assistant",
            "content": "",
            "tool_call_id": None,
            "response_id": transcript["response_id"],
            "metadata": {"turn_id": transcript["turn_id"], "source": "node_runtime"},
            "blocks": [
                {
                    "type": "tool_call",
                    "text": None,
                    "tool_name": transcript["tool_name"],
                    "tool_arguments": transcript["arguments"],
                    "call_id": transcript["call_id"],
                    "provider_id": None,
                    "metadata": {},
                }
            ],
            "tool_calls": [
                {
                    "name": transcript["tool_name"],
                    "arguments": transcript["arguments"],
                    "reason": "model requested tool",
                    "call_id": transcript["call_id"],
                }
            ],
        },
        {
            "role": "tool",
            "content": transcript["receipt"],
            "tool_call_id": transcript["call_id"],
            "response_id": None,
            "metadata": result_metadata,
            "blocks": [
                {
                    "type": "tool_result",
                    "text": transcript["receipt"],
                    "tool_name": transcript["tool_name"],
                    "tool_arguments": None,
                    "call_id": transcript["call_id"],
                    "provider_id": None,
                    "metadata": block_metadata,
                }
            ],
            "tool_calls": [],
        },
        {
            "role": "assistant",
            "content": "File created.",
            "tool_call_id": None,
            "response_id": "resp-final",
            "metadata": {"turn_id": transcript["turn_id"], "source": "node_runtime"},
            "blocks": [],
            "tool_calls": [],
        },
    ]


def _transcript_signature(messages: list[dict[str, Any]]) -> dict[str, Any]:
    tool_call = messages[1]["tool_calls"][0]
    tool_result = messages[2]
    return {
        "call_id": tool_call["call_id"],
        "tool_name": tool_call["name"],
        "receipt": tool_result["content"],
        "success": tool_result["metadata"]["success"],
        "error_kind": tool_result["metadata"].get("error_kind"),
        "file_changes": tool_result["metadata"].get("file_changes"),
        "block_file_changes": tool_result["blocks"][0]["metadata"].get("file_changes"),
    }


def _expected_transcript_signature(transcript: dict[str, Any]) -> dict[str, Any]:
    return {
        "call_id": transcript["call_id"],
        "tool_name": transcript["tool_name"],
        "receipt": transcript["receipt"],
        "success": "error_kind" not in transcript,
        "error_kind": transcript.get("error_kind"),
        "file_changes": transcript.get("file_changes"),
        "block_file_changes": transcript.get("file_changes"),
    }


def _fixture() -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))


def _node(action: str, *arguments: object) -> Any:
    result = subprocess.run(
        ["node", "--import", "tsx", str(NODE_HELPER), action, *(str(value) for value in arguments)],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)
