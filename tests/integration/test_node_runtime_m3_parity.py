from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any, cast

from mycli.domain.conversation import Message
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore
from mycli.state.session_serialization import deserialize_message
from mycli.tools.read import ReadTool

ROOT = Path(__file__).parents[2]
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "node_runtime_m3" / "tool_contract.json"
NODE_HELPER = ROOT / "tests" / "integration" / "node_runtime_m3_parity_helper.ts"


def test_read_manifest_and_results_match_shared_m3_contract(tmp_path: Path) -> None:
    fixture = _fixture()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "README.md").write_text("alpha\nbeta\n", encoding="utf-8")
    node_db = tmp_path / "node-tool-transcript.db"

    node = _node("probe", workspace, node_db, FIXTURE_PATH)
    expected_cases = [case["expected"] | {"name": case["name"]} for case in fixture["read_cases"]]
    assert node["inventory"] == fixture["inventory"]["node_tools"]
    assert not set(node["inventory"]) & set(fixture["inventory"]["retired_tools"])
    assert node["parameters"] == fixture["inventory"]["parameters"]
    assert node["read_cases"] == expected_cases

    python_tool = ReadTool(workspace)
    assert python_tool.name == "Read"
    assert [parameter.name for parameter in python_tool.spec.parameters] == fixture["inventory"]["parameters"]
    python_cases = []
    for case in fixture["read_cases"]:
        result = python_tool.execute(case["arguments"])
        raw = result.raw_payload
        python_cases.append(
            {
                "name": case["name"],
                "success": result.success,
                "path": raw.get("path") if result.success else None,
                "shown_lines": raw.get("shown_lines") if result.success else None,
                "truncated": raw.get("truncated") if result.success else None,
                "error_kind": raw.get("error_kind") if not result.success else None,
            }
        )
    assert python_cases == expected_cases


def test_python_and_node_read_each_others_m3_tool_transcript(tmp_path: Path) -> None:
    fixture = _fixture()
    transcript = fixture["transcript"]
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "README.md").write_text("alpha\nbeta\n", encoding="utf-8")

    node_db = tmp_path / "node.db"
    _node("probe", workspace, node_db, FIXTURE_PATH)
    node_messages = SQLiteSessionStore(node_db).load_conversation(transcript["session_id"])
    assert node_messages is not None
    assert _transcript_shape(node_messages) == _transcript_shape(transcript["raw_messages"])

    python_db = tmp_path / "python.db"
    python_store = SQLiteSessionStore(python_db)
    python_store.replace_conversation(
        session_id=transcript["session_id"],
        workspace_root=workspace,
        thread_id=transcript["session_id"],
        messages=transcript["raw_messages"],
    )
    node_items = _node("read-db", python_db, transcript["session_id"])
    assert [item["type"] for item in node_items] == transcript["canonical_item_types"]
    assert node_items[1]["calls"] == [
        {
            "callId": transcript["call"]["call_id"],
            "name": "Read",
            "argumentsJson": json.dumps(
                transcript["call"]["arguments"], separators=(",", ":"), sort_keys=True
            ),
        }
    ]
    assert node_items[2] == {
        "type": "tool_result",
        "callId": transcript["call"]["call_id"],
        "toolName": "Read",
        "output": transcript["tool_output"],
        "success": True,
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


def _transcript_shape(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    parsed: list[Message] = [deserialize_message(message) for message in messages]
    return [
        {
            "role": message.role,
            "tool_call_id": message.tool_call_id,
            "response_id": message.response_id,
            "tool_calls": [
                {
                    "name": call.name,
                    "arguments": call.arguments,
                    "call_id": call.call_id,
                }
                for call in message.tool_calls
            ],
            "blocks": [
                {
                    "type": block.type,
                    "tool_name": block.tool_name,
                    "call_id": block.call_id,
                }
                for block in message.blocks
            ],
        }
        for message in parsed
    ]
