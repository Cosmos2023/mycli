from __future__ import annotations

import json
from pathlib import Path

from mycli.cli.main import build_parser, main


def test_parser_accepts_plugins_subcommand_with_json() -> None:
    args = build_parser().parse_args(["plugins", "list", "--json"])

    assert args.command == "plugins"
    assert args.utility_args == ["list"]
    assert args.json_output is True


def test_plugins_list_human_output_does_not_build_runtime(monkeypatch, tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_config(workspace, enabled=["demo"])
    _write_plugin(workspace, "demo")
    monkeypatch.setattr(
        "mycli.cli.main.build_turn_service",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("runtime should not start")),
    )
    output: list[str] = []

    exit_code = main(
        ["plugins", "list"],
        cwd=workspace,
        home=home,
        env={},
        output_func=output.append,
    )

    rendered = "\n".join(output)
    assert exit_code == 0
    assert "mycli plugins list" in rendered
    assert "plugin demo" in rendered
    assert "load_status=loaded" in rendered


def test_plugins_list_json_output(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_config(workspace, enabled=["demo"])
    _write_plugin(workspace, "demo")
    output: list[str] = []

    exit_code = main(
        ["plugins", "list", "--json"],
        cwd=workspace,
        home=home,
        env={},
        output_func=output.append,
    )

    payload = json.loads(output[0])
    assert exit_code == 0
    assert payload["plugins"][0]["plugin_id"] == "demo"
    assert payload["plugins"][0]["enabled"] is True
    assert payload["plugins"][0]["load_status"] == "loaded"
    assert payload["plugins"][0]["provided_commands"][0]["name"] == "DemoCommand"


def test_plugins_run_json_output_provider_free(monkeypatch, tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_config(workspace, enabled=["demo"])
    _write_plugin(
        workspace,
        "demo",
        register_body=(
            "def register(ctx):\n"
            "    ctx.register_command('DemoCommand', {'description': 'Demo'}, "
            "lambda args: {'summary': 'hello ' + args.get('name', 'world'), 'metadata': {'seen': True}})\n"
        ),
    )
    monkeypatch.setattr(
        "mycli.cli.main.build_turn_service",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("runtime should not start")),
    )
    output: list[str] = []

    exit_code = main(
        ["plugins", "run", "demo", "DemoCommand", "--json-args", '{"name": "codex"}', "--json"],
        cwd=workspace,
        home=home,
        env={},
        output_func=output.append,
    )

    payload = json.loads(output[0])
    assert exit_code == 0
    assert payload["command_result"]["ok"] is True
    assert payload["command_result"]["summary"] == "hello codex"


def test_plugins_run_rejects_invalid_json(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    output: list[str] = []

    exit_code = main(
        ["plugins", "run", "demo", "DemoCommand", "--json-args", "{bad", "--json"],
        cwd=workspace,
        home=home,
        env={},
        output_func=output.append,
    )

    payload = json.loads(output[0])
    assert exit_code == 1
    assert payload["message"] == "invalid JSON arguments"


def test_plugins_inspect_missing_exits_one_json(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    output: list[str] = []

    exit_code = main(
        ["plugins", "inspect", "missing", "--json"],
        cwd=workspace,
        home=home,
        env={},
        output_func=output.append,
    )

    payload = json.loads(output[0])
    assert exit_code == 1
    assert payload["ok"] is False
    assert "not found" in payload["message"]


def _workspace_home(tmp_path: Path) -> tuple[Path, Path]:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    (workspace / ".mycli" / "plugins").mkdir(parents=True)
    (home / ".mycli" / "plugins").mkdir(parents=True)
    return workspace, home


def _write_config(workspace: Path, *, enabled: list[str]) -> None:
    (workspace / ".mycli" / "config.toml").write_text(
        "[plugins]\n" f"enabled = {json.dumps(enabled)}\n",
        encoding="utf-8",
    )


def _write_plugin(workspace: Path, plugin_id: str, *, register_body: str | None = None) -> None:
    plugin = workspace / ".mycli" / "plugins" / plugin_id
    plugin.mkdir(parents=True)
    plugin.joinpath("plugin.yaml").write_text(
        "\n".join(
            [
                "name: Demo Plugin",
                "version: '1.0'",
                "kind: standalone",
                "provides_tools: []",
                "provides_hooks: []",
                "provides_commands:",
                "  - id: DemoCommand",
                "    description: Demo command",
                "    kind: slash",
                "    args_schema:",
                "      type: object",
                "requires_env: []",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    plugin.joinpath("__init__.py").write_text(register_body or "def register(ctx):\n    pass\n", encoding="utf-8")
