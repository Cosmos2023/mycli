from __future__ import annotations

import json
from pathlib import Path

from mycli.cli.main import build_parser, main


def test_parser_accepts_hooks_subcommand_with_json_after_action() -> None:
    args = build_parser().parse_args(["hooks", "list", "--json"])

    assert args.command == "hooks"
    assert args.utility_args == ["list"]
    assert args.json_output is True


def test_hooks_list_human_output_does_not_build_runtime(monkeypatch, tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_repo_hook(workspace, hook_id="audit")
    monkeypatch.setattr(
        "mycli.cli.main.build_turn_service",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("runtime should not start")),
    )
    output: list[str] = []

    exit_code = main(
        ["hooks", "list"],
        cwd=workspace,
        home=home,
        env={},
        output_func=output.append,
    )

    rendered = "\n".join(output)
    assert exit_code == 0
    assert "mycli hooks list" in rendered
    assert "hook repo:audit:pre_tool_use" in rendered
    assert "command_digest=sha256:" in rendered
    assert "python3" not in rendered


def test_hooks_list_json_output(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_repo_hook(workspace, hook_id="audit")
    output: list[str] = []

    exit_code = main(
        ["hooks", "list", "--json"],
        cwd=workspace,
        home=home,
        env={},
        output_func=output.append,
    )

    assert exit_code == 0
    payload = json.loads(output[0])
    assert payload["ok"] is True
    assert payload["hooks"][0]["identity"] == "repo:audit:pre_tool_use"
    assert payload["hooks"][0]["allowlist_reason"] == "allowlist_missing"


def test_hooks_inspect_not_found_exits_one_json(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    output: list[str] = []

    exit_code = main(
        ["hooks", "inspect", "repo:missing:pre_tool_use", "--json"],
        cwd=workspace,
        home=home,
        env={},
        output_func=output.append,
    )

    payload = json.loads(output[0])
    assert exit_code == 1
    assert payload["ok"] is False
    assert "not found" in payload["message"]


def test_hooks_approve_and_revoke_json(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_repo_hook(workspace, hook_id="audit")
    output: list[str] = []

    approve_exit = main(
        ["hooks", "approve", "repo:audit:pre_tool_use", "--json"],
        cwd=workspace,
        home=home,
        env={},
        output_func=output.append,
    )
    revoke_exit = main(
        ["hooks", "revoke", "repo:audit:pre_tool_use", "--json"],
        cwd=workspace,
        home=home,
        env={},
        output_func=output.append,
    )

    approve_payload = json.loads(output[0])
    revoke_payload = json.loads(output[1])
    assert approve_exit == 0
    assert approve_payload["hook"]["allowlist_status"] == "allowed"
    assert (home / ".mycli" / "hook-allowlist.json").exists()
    assert revoke_exit == 0
    assert revoke_payload["removed"] is True
    assert revoke_payload["hook"]["allowlist_status"] == "not_allowed"


def test_hooks_bad_config_visible_in_json(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    (workspace / ".mycli" / "hooks.json").write_text("{bad", encoding="utf-8")
    output: list[str] = []

    exit_code = main(
        ["hooks", "list", "--json"],
        cwd=workspace,
        home=home,
        env={},
        output_func=output.append,
    )

    payload = json.loads(output[0])
    assert exit_code == 0
    assert payload["config_issues"]
    assert "not parseable" in payload["config_issues"][0]


def _workspace_home(tmp_path: Path) -> tuple[Path, Path]:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    (workspace / ".mycli").mkdir(parents=True)
    (home / ".mycli").mkdir(parents=True)
    return workspace, home


def _write_repo_hook(workspace: Path, *, hook_id: str) -> None:
    (workspace / ".mycli" / "hooks.json").write_text(
        json.dumps(
            {
                "hooks": [
                    {
                        "id": hook_id,
                        "hook_point": "pre_tool_use",
                        "command": ["python3", "hook.py"],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
