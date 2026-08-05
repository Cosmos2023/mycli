from __future__ import annotations

import json
from pathlib import Path
import subprocess
from typing import Any, cast

from mycli.domain.runtime import ExecutionPolicy, PermissionProfile
from mycli.domain.tooling.calls import ToolResult
from mycli.tools.model_output import shell_model_output
from mycli.tools.shell_output_buffer import ShellOutputBuffer
from mycli.tools.shell_output_decoder import ShellOutputDecoder

ROOT = Path(__file__).parents[2]
FIXTURE_PATH = (
    ROOT / "tests" / "fixtures" / "node_runtime_m6" / "shell_contract.json"
)
NODE_HELPER = ROOT / "tests" / "integration" / "node_runtime_m6_parity_helper.ts"


def test_m6_python_node_shell_contract_parity(tmp_path: Path) -> None:
    fixture = _fixture()

    assert _python_contract(fixture, tmp_path / "python") == _node_contract(
        tmp_path / "node"
    )


def test_m6_parity_corpus_is_complete_and_sanitized() -> None:
    fixture = _fixture()
    scenario_ids = {str(item["id"]) for item in fixture["scenarios"]}
    serialized = json.dumps(fixture, ensure_ascii=False).lower()

    assert fixture["version"] == 1
    assert scenario_ids == {
        "foreground-pipe-success",
        "foreground-pipe-failure",
        "partial-output",
        "yield-poll",
        "pty-input",
        "owner-denial",
        "approval-once",
        "approval-session",
        "approval-persistent",
        "approval-reject",
        "effect-unknown",
        "sandbox-profiles",
        "sandbox-unavailable",
        "timeout",
        "interrupt",
        "targeted-kill",
        "owner-stop",
        "gateway-close",
        "stale-restart",
        "lifecycle-order",
        "redacted-metadata",
    }
    assert {str(item["id"]) for item in fixture["buffer_cases"]} >= {
        "cursor-eviction",
        "incremental-output",
    }
    assert "api_key" not in serialized
    assert "authorization" not in serialized
    assert "bearer " not in serialized
    assert "sk-" not in serialized


def _python_contract(fixture: dict[str, Any], workspace: Path) -> dict[str, Any]:
    workspace.mkdir(parents=True)
    buffers: list[dict[str, Any]] = []
    for item in fixture["buffer_cases"]:
        buffer = ShellOutputBuffer(max_chars=int(item["max_chars"]))
        for chunk in item["chunks"]:
            buffer.append(str(chunk))
        result = buffer.read_from(int(item["cursor"]))
        snapshot = buffer.snapshot()
        buffers.append(
            {
                "id": str(item["id"]),
                "text": result.text,
                "next_cursor": result.next_cursor,
                "output_chars": snapshot.total_chars,
                "omitted_chars": result.omitted_before_chunk,
                "cursor_was_evicted": result.cursor_was_evicted,
            }
        )

    decoders: list[dict[str, Any]] = []
    for item in fixture["decoder_cases"]:
        decoder = ShellOutputDecoder()
        text = "".join(
            decoder.feed("terminal", bytes.fromhex(str(chunk)))
            for chunk in item["chunks_hex"]
        ) + decoder.flush("terminal")
        decoders.append(
            {
                "id": str(item["id"]),
                "text": text,
                "replacement_count": decoder.replacement_count,
            }
        )

    models: list[dict[str, Any]] = []
    for item in fixture["model_cases"]:
        payload = {
            "shell_id": str(item["shell_id"]),
            "chunk_id": str(item["chunk_id"]),
            "wall_time_seconds": float(item["wall_time_seconds"]),
            "terminal_state": item["terminal_state"],
            "exit_code": item["exit_code"],
            "output": str(item["output"]),
            "max_output_tokens": int(item["max_output_tokens"]),
        }
        text = shell_model_output(
            ToolResult(success=True, summary="shell fixture", raw_payload=payload)
        ).text_content()
        models.append(_normalized_model(item, text))

    permissions: list[dict[str, Any]] = []
    for raw_profile in fixture["permission_profiles"]:
        profile = PermissionProfile(str(raw_profile))
        policy = ExecutionPolicy.for_workspace(
            workspace,
            sandbox_mode=profile.sandbox_mode,
        ).sandbox
        permissions.append(
            {
                "id": profile.value,
                "mode": policy.mode.value,
                "filesystem": policy.filesystem,
                "network": policy.network,
                "writable_roots": len(policy.writable_roots),
            }
        )

    return {
        "buffers": buffers,
        "decoders": decoders,
        "models": models,
        "permissions": permissions,
        "scenarios": fixture["scenarios"],
    }


def _normalized_model(item: dict[str, Any], text: str) -> dict[str, Any]:
    status = next(line for line in text.splitlines() if line.startswith("Process "))
    return {
        "id": str(item["id"]),
        "status": status,
        "output_present": str(item["output"]) in text,
        "bounded": len(text) <= int(item["max_output_tokens"]) * 4,
    }


def _node_contract(workspace: Path) -> dict[str, Any]:
    result = subprocess.run(
        [
            "node",
            "--import",
            "tsx",
            str(NODE_HELPER),
            "probe",
            str(FIXTURE_PATH),
            str(workspace),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return cast(dict[str, Any], json.loads(result.stdout))


def _fixture() -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))
