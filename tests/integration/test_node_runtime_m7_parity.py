from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import subprocess
from typing import Any, cast

from mycli.config.settings import resolve_config
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore
from mycli.services.diagnostics.doctor import (
    DoctorCheck,
    DoctorReport,
    DoctorStatus,
    render_doctor_report,
)
from mycli.services.hooks.config import HookConfigRegistry
from mycli.services.mcp.client import load_mcp_server_configs
from mycli.services.plugins.discovery import discover_plugins
from mycli.services.skills.registry import SkillRegistry
from mycli.services.subagents.registry import SubAgentProfileRegistry

ROOT = Path(__file__).parents[2]
FIXTURE_ROOT = ROOT / "tests" / "fixtures" / "node_runtime_m7"
MANAGEMENT_FIXTURE = FIXTURE_ROOT / "management_contract.json"
EXTENSION_FIXTURE = FIXTURE_ROOT / "extension_contract.json"
NODE_HELPER = ROOT / "tests" / "integration" / "node_runtime_m7_parity_helper.ts"


def test_m7_python_node_config_extension_and_management_parity(tmp_path: Path) -> None:
    management = _fixture(MANAGEMENT_FIXTURE)
    extensions = _fixture(EXTENSION_FIXTURE)
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    builtin = tmp_path / "builtin-skills"
    _write_parity_tree(home, workspace, builtin, management)

    python_payload = _python_payload(home, workspace, builtin, management)
    node_payload = _node_command(
        "collect",
        home=home,
        workspace=workspace,
        builtin=builtin,
        management=MANAGEMENT_FIXTURE,
        extensions=EXTENSION_FIXTURE,
    )

    expected = cast(dict[str, Any], extensions["expected"])
    assert python_payload["config"] == management["config"]["expected"]
    assert node_payload["config"] == python_payload["config"]
    for key in ("skills", "hooks", "mcp"):
        assert python_payload[key] == expected[key]
        assert node_payload[key] == python_payload[key]
    expected_profile = expected["profiles"][0]
    profile_contract = {
        key: value
        for key, value in expected_profile.items()
        if key not in {"python_budget", "node_budget"}
    }
    assert python_payload["profiles"] == [
        {**profile_contract, "budget": expected_profile["python_budget"]}
    ]
    assert node_payload["profiles"] == [
        {**profile_contract, "budget": expected_profile["node_budget"]}
    ]
    assert python_payload["python_plugins"] == [
        {"id": "legacy-python", "status": "supported"}
    ]
    assert node_payload["python_plugins"] == [
        {"id": "legacy-python", "status": "migration_required"}
    ]
    assert node_payload["management"]["response"] == python_payload["management"]["response"]
    assert node_payload["management"]["human"] == python_payload["management"]["human"]
    assert json.loads(node_payload["management"]["json"]) == json.loads(
        python_payload["management"]["json"]
    )
    assert node_payload["management"]["response"] == {
        **management["doctor"]["expected"],
        "checks": management["doctor"]["checks"],
    }


def test_m7_node_subagent_records_are_additive_for_python_store(tmp_path: Path) -> None:
    extensions = _fixture(EXTENSION_FIXTURE)
    db_path = tmp_path / "sessions.db"
    node_payload = _node_command(
        "write_task",
        db_path=db_path,
        extensions=EXTENSION_FIXTURE,
    )

    store = SQLiteSessionStore(db_path)
    assert store.list_sessions() == ()
    expected = extensions["expected"]["node_task"]
    assert node_payload == expected
    with sqlite3.connect(db_path) as connection:
        row = connection.execute(
            "SELECT task_id, status, payload_json FROM subagent_tasks"
        ).fetchone()
    assert row is not None
    assert row[0] == expected["task_id"]
    assert row[1] == expected["status"]
    assert json.loads(row[2])["report"] == expected["report"]


def test_m7_parity_fixtures_are_complete_and_sanitized() -> None:
    management = _fixture(MANAGEMENT_FIXTURE)
    extensions = _fixture(EXTENSION_FIXTURE)
    serialized = json.dumps([management, extensions], ensure_ascii=False).lower()

    assert management["version"] == 1
    assert extensions["version"] == 1
    assert set(extensions["expected"]) == {
        "skills",
        "profiles",
        "hooks",
        "mcp",
        "python_plugins",
        "node_task",
    }
    for marker in ("api_key", "authorization", "bearer ", '"sk-'):
        assert marker not in serialized


def _python_payload(
    home: Path,
    workspace: Path,
    builtin: Path,
    management: dict[str, Any],
) -> dict[str, Any]:
    config_input = cast(dict[str, Any], management["config"])
    config = resolve_config(
        {"session": "m7-parity", "model": config_input["cli_model"]},
        cast(dict[str, str], config_input["env"]),
        workspace,
        home,
    )
    skills = SkillRegistry(
        builtin,
        home / ".mycli" / "skills",
        shared_repo_root=workspace / ".agents" / "skills",
        repo_root=workspace / ".mycli" / "skills",
    )
    profiles = SubAgentProfileRegistry(
        workspace_root=workspace,
        home_dir=home,
    ).discover()
    hooks = HookConfigRegistry(
        workspace_root=workspace,
        home_dir=home,
    ).discover()
    mcp = load_mcp_server_configs(workspace, home_dir=home, environ={})
    plugins = discover_plugins(workspace_root=workspace, home_dir=home)
    doctor_checks = tuple(
        DoctorCheck(
            name=str(item["name"]),
            status=DoctorStatus(str(item["status"])),
            message=str(item["message"]),
            detail=str(item["detail"]) if item.get("detail") else None,
        )
        for item in management["doctor"]["checks"]
    )
    report = DoctorReport(doctor_checks)
    response = {
        **management["doctor"]["expected"],
        "checks": management["doctor"]["checks"],
    }
    return {
        "config": {
            "provider": config.provider.value,
            "protocol": config.protocol.value,
            "model": config.model,
            "api_base_url": config.api_base_url,
            "auth_ref": config.auth_ref,
            "request_max_retries": config.request_max_retries,
            "stream_max_retries": config.stream_max_retries,
            "thinking_enabled": config.thinking_enabled,
        },
        "skills": [
            {"name": item.name, "source": item.source_kind}
            for item in skills.list_metadata()
        ],
        "profiles": [
            {
                "id": record.profile_id,
                "source": record.source,
                "status": record.status,
                "allowed_tools": list(record.allowed_tools),
                "budget": _python_budget(record.profile.budget if record.profile else None),
            }
            for record in profiles.records
            if record.profile_id == "parity-agent"
        ],
        "hooks": [
            {
                "id": item.hook_id,
                "source": item.source.value,
                "point": item.hook_point.value,
                "enabled": item.enabled,
                "timeout_ms": int(item.timeout_seconds * 1000),
                "working_directory": item.working_directory.value,
                "environment": item.env_policy.value,
            }
            for item in hooks.hooks
        ],
        "mcp": [
            {
                "id": item.name,
                "transport": item.transport,
                "enabled": item.enabled,
                "timeout_ms": int(item.timeout_seconds * 1000),
            }
            for item in mcp.values()
        ],
        "python_plugins": [
            {"id": item.plugin_id, "status": "supported"}
            for item in plugins.selected
            if item.manifest is not None
        ],
        "management": {
            "response": response,
            "human": "\n".join(render_doctor_report(report)) + "\n",
            "json": json.dumps(response, separators=(",", ":")) + "\n",
        },
    }


def _python_budget(value: object | None) -> dict[str, int]:
    if value is None:
        return {}
    result: dict[str, int] = {}
    for source, target in (
        ("max_turns", "maxTurns"),
        ("max_tool_calls", "maxToolCalls"),
        ("no_progress_turn_limit", "noProgressTurnLimit"),
    ):
        item = getattr(value, source, None)
        if isinstance(item, int):
            result[target] = item
    return result


def _write_parity_tree(
    home: Path,
    workspace: Path,
    builtin: Path,
    management: dict[str, Any],
) -> None:
    config = management["config"]
    _write(home / ".config" / "mycli" / "config.toml", config["legacy_toml"])
    _write(workspace / ".mycli" / "config.toml", config["repo_toml"])
    _write(home / ".mycli" / "config.toml", config["user_toml"])
    for root, description, body in (
        (builtin, "Builtin review", "Builtin instructions."),
        (home / ".mycli" / "skills", "User review", "User instructions."),
        (workspace / ".mycli" / "skills", "Repository review", "Repo instructions."),
    ):
        _write(
            root / "review.md",
            f'---\nname = "review"\ndescription = "{description}"\n---\n{body}\n',
        )
    _write(
        workspace / ".agents" / "skills" / "analyze.md",
        "---\nname: analyze\ndescription: Analyze files\n---\nAnalyze instructions.\n",
    )
    _write(
        workspace / ".mycli" / "agents" / "parity-agent.md",
        "---\nname: parity-agent\ndescription: Parity profile\ntools: [Read]\n---\nInspect files.\n",
    )
    _write(
        workspace / ".mycli" / "hooks.json",
        json.dumps(
            {
                "hooks": [
                    {
                        "id": "parity-hook",
                        "hook_point": "pre_tool_use",
                        "command": ["node", "hook.mjs"],
                        "timeout_seconds": 3,
                    }
                ]
            }
        ),
    )
    _write(
        workspace / ".mycli" / "mcp_servers.toml",
        "\n".join(
            (
                "[servers.local]",
                'transport = "stdio"',
                'command = "node"',
                'args = ["server.mjs"]',
                "timeout_seconds = 3",
                "",
                "[servers.remote]",
                'transport = "streamable-http"',
                'url = "https://mcp.example.test/rpc"',
                "enabled = false",
                "timeout_seconds = 5",
            )
        ),
    )
    plugin = workspace / ".mycli" / "plugins" / "legacy-python"
    _write(
        plugin / "plugin.yaml",
        "name: Legacy Python\nversion: 1.0.0\nprovides_tools: []\n",
    )
    _write(plugin / "__init__.py", "def register(_context):\n    return None\n")


def _node_command(action: str, **paths: Path) -> dict[str, Any]:
    command = {"action": action, **{key: str(value) for key, value in paths.items()}}
    completed = subprocess.run(
        ["node", "--import", "tsx", str(NODE_HELPER)],
        cwd=ROOT,
        input=json.dumps(command, separators=(",", ":")) + "\n",
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else ""
        raise AssertionError(
            f"node M7 parity helper failed ({completed.returncode}): {detail[:200]}"
        )
    rows = [line for line in completed.stdout.splitlines() if line.strip()]
    assert len(rows) == 1
    return cast(dict[str, Any], json.loads(rows[0]))


def _fixture(path: Path) -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(path.read_text(encoding="utf-8")))


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
