from __future__ import annotations

import json
import tomllib
from pathlib import Path
from types import SimpleNamespace

import pytest

from mycli.application.turn_service import TurnService
from mycli.cli.main import (
    build_parser,
    build_turn_service,
    handle_mcp_command,
    handle_subagents_command,
    main,
)
from mycli.cli.node_tui import NodeTuiProcessError
from mycli.config.auth_store import AuthStore
from mycli.tools.ripgrep_prepare import RipgrepPrepareResult
from mycli.domain.runtime import (
    StopReason,
    TurnItem,
    TurnItemType,
    TurnRollout,
    TurnRolloutEvent,
    TurnResponse,
    TurnStatus,
)
from mycli.domain.runtime.tracing import RuntimeTraceEvent
from mycli.llms.adapters.native_tool_adapter import NativeToolModelAdapter
from mycli.llms.adapters.responses_adapter import ResponsesModelAdapter
from mycli.services.mcp import McpToolContributionProvider


def test_build_parser_uses_mycli_prog_name() -> None:
    parser = build_parser()
    assert parser.prog == "mycli"


def test_build_parser_reads_session_argument() -> None:
    parser = build_parser()
    args = parser.parse_args(["--session", "demo-session"])
    assert args.session == "demo-session"


def test_build_parser_leaves_session_unset_by_default() -> None:
    parser = build_parser()
    args = parser.parse_args([])

    assert args.session is None


def test_build_parser_rejects_retired_plain_flag() -> None:
    parser = build_parser()

    with pytest.raises(SystemExit):
        parser.parse_args(["--plain"])


def test_main_rejects_non_tty_conversation_before_building_runtime(
    monkeypatch,
    tmp_path: Path,
) -> None:
    outputs: list[str] = []
    monkeypatch.setattr("mycli.cli.main.stdin", SimpleNamespace(isatty=lambda: False))
    monkeypatch.setattr("mycli.cli.main.stdout", SimpleNamespace(isatty=lambda: False))
    monkeypatch.setattr(
        "mycli.cli.main.build_turn_service",
        lambda *_args, **_kwargs: pytest.fail("runtime must not be built"),
    )

    assert main([], cwd=tmp_path, home=tmp_path / "home", env={}, output_func=outputs.append) == 2
    assert outputs == ["Interactive mycli requires a terminal."]


def test_main_dispatches_utility_command_before_tty_validation(
    monkeypatch,
    tmp_path: Path,
) -> None:
    calls: list[str] = []
    monkeypatch.setattr("mycli.cli.main.stdin", SimpleNamespace(isatty=lambda: False))
    monkeypatch.setattr("mycli.cli.main.stdout", SimpleNamespace(isatty=lambda: False))
    monkeypatch.setattr(
        "mycli.cli.main.handle_doctor_command",
        lambda *_args, **_kwargs: calls.append("doctor") or 0,
    )

    assert main(["doctor"], cwd=tmp_path, home=tmp_path / "home", env={}) == 0
    assert calls == ["doctor"]


def test_main_contains_node_startup_failure_and_closes_runtime(
    monkeypatch,
    tmp_path: Path,
) -> None:
    outputs: list[str] = []
    calls: list[str] = []
    service = SimpleNamespace(close=lambda: calls.append("close"))
    monkeypatch.setattr("mycli.cli.main.stdin", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.stdout", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *_args, **_kwargs: service)
    monkeypatch.setattr(
        "mycli.cli.main.run_node_tui",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(NodeTuiProcessError("node failed")),
    )

    assert main([], cwd=tmp_path, home=tmp_path / "home", env={}, output_func=outputs.append) == 2
    assert outputs == ["node failed"]
    assert calls == ["close"]


def test_build_parser_accepts_doctor_command() -> None:
    parser = build_parser()
    args = parser.parse_args(["doctor"])

    assert args.command == "doctor"


def test_build_parser_accepts_setup_command() -> None:
    parser = build_parser()
    args = parser.parse_args(["setup"])

    assert args.command == "setup"


def test_build_parser_accepts_mcp_command() -> None:
    parser = build_parser()
    args = parser.parse_args(["mcp", "list"])

    assert args.command == "mcp"
    assert args.utility_args == ["list"]


def test_build_parser_accepts_subagents_command() -> None:
    parser = build_parser()
    args = parser.parse_args(["subagents", "inspect", "explore"])

    assert args.command == "subagents"
    assert args.utility_args == ["inspect", "explore"]


def test_setup_command_writes_user_config(monkeypatch, tmp_path: Path) -> None:
    home = tmp_path / "home"
    outputs: list[str] = []
    scripted_inputs = iter(["1", "3", "", "deepseek-v4-flash"])
    monkeypatch.setattr("getpass.getpass", lambda _prompt: "sk-test")
    monkeypatch.setattr(
        "mycli.cli.setup_wizard.prepare_user_ripgrep",
        lambda **_kwargs: RipgrepPrepareResult(path=tmp_path / "rg", installed=False),
    )

    exit_code = main(
        argv=["setup"],
        cwd=tmp_path,
        home=home,
        env={},
        input_func=lambda _prompt: next(scripted_inputs),
        output_func=outputs.append,
    )

    config_path = home / ".mycli" / "config.toml"
    assert exit_code == 0
    assert config_path.exists()
    config_text = config_path.read_text(encoding="utf-8")
    payload = tomllib.loads(config_text)
    assert payload["model"] == {
        "provider": "deepseek",
        "protocol": "chat_completions",
        "name": "deepseek-v4-flash",
        "api_base_url": "https://api.deepseek.com",
    }
    assert "api_key" not in config_text
    assert AuthStore.from_home(home).get_api_key("deepseek") == "sk-test"
    assert any("Saved configuration" in line for line in outputs)


def test_subagents_command_is_provider_free_and_renders_json(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    profiles = workspace / ".mycli" / "subagents"
    profiles.mkdir(parents=True)
    home.mkdir()
    profiles.joinpath("analyst.toml").write_text(
        "\n".join(
            [
                'id = "analyst"',
                'instruction = "Analyze docs."',
                'allowed_tools = ["Read"]',
            ]
        ),
        encoding="utf-8",
    )
    output: list[str] = []

    exit_code = handle_subagents_command(
        {"command": "subagents", "utility_args": ["inspect", "analyst"], "json_output": True},
        cwd=workspace,
        home=home,
        output_func=output.append,
    )

    payload = json.loads(output[0])
    assert exit_code == 0
    assert payload["profile"]["profile_id"] == "analyst"
    assert payload["profile"]["allowed_tools"] == ["Read"]
    assert payload["profile"]["source_path"].endswith(".mycli/subagents/analyst.toml")


def test_subagents_command_reports_human_issues(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    profiles = workspace / ".mycli" / "subagents"
    profiles.mkdir(parents=True)
    home.mkdir()
    profiles.joinpath("broken.toml").write_text("enabled = true\n", encoding="utf-8")
    output: list[str] = []

    exit_code = handle_subagents_command(
        {"command": "subagents", "utility_args": ["list"], "json_output": False},
        cwd=workspace,
        home=home,
        output_func=output.append,
    )

    rendered = "\n".join(output)
    assert exit_code == 1
    assert "subagent broken" in rendered
    assert "subagent_issue:" in rendered


def test_subagents_command_renders_markdown_agent_path_and_description(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    profiles = workspace / ".mycli" / "agents"
    profiles.mkdir(parents=True)
    home.mkdir()
    profiles.joinpath("planner.md").write_text(
        "\n".join(
            [
                "---",
                "name: planner",
                "description: Split work into safe implementation slices.",
                "tools: Read, Grep",
                "---",
                "You plan work.",
            ]
        ),
        encoding="utf-8",
    )
    output: list[str] = []

    exit_code = handle_subagents_command(
        {"command": "subagents", "utility_args": ["inspect", "planner"], "json_output": False},
        cwd=workspace,
        home=home,
        output_func=output.append,
    )

    rendered = "\n".join(output)
    assert exit_code == 0
    assert "subagent planner" in rendered
    assert "path=" in rendered
    assert ".mycli/agents/planner.md" in rendered
    assert "description=Split work into safe implementation slices." in rendered


def test_mcp_list_command_is_provider_free_and_redacts_failures(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    config_dir = workspace / ".mycli"
    config_dir.mkdir()
    config_dir.joinpath("mcp_servers.toml").write_text(
        "\n".join(
            [
                "[servers.disabled]",
                'transport = "stdio"',
                'command = "python"',
                "enabled = false",
                "",
                "[servers.broken]",
                'transport = "stdio"',
                'command = "/missing/mcp-secret-token-value"',
                "timeout_seconds = 0.1",
            ]
        ),
        encoding="utf-8",
    )
    output: list[str] = []

    exit_code = handle_mcp_command(
        {"command": "mcp", "utility_args": ["list"], "json_output": False},
        cwd=workspace,
        home=tmp_path / "home",
        env={},
        output_func=output.append,
    )

    rendered = "\n".join(output)
    assert exit_code == 1
    assert "mcp server disabled" in rendered
    assert "mcp server broken" in rendered
    assert "failure_category=server_startup" in rendered
    assert "secret-token-value" not in rendered


def test_mcp_inspect_command_renders_json(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    config_dir = workspace / ".mycli"
    config_dir.mkdir()
    config_dir.joinpath("mcp_servers.toml").write_text(
        "\n".join(
            [
                "[servers.disabled]",
                'transport = "stdio"',
                'command = "python"',
                "enabled = false",
            ]
        ),
        encoding="utf-8",
    )
    output: list[str] = []

    exit_code = handle_mcp_command(
        {"command": "mcp", "utility_args": ["inspect", "disabled"], "json_output": True},
        cwd=workspace,
        home=tmp_path / "home",
        env={},
        output_func=output.append,
    )

    payload = json.loads(output[0])
    assert exit_code == 0
    assert payload["server"]["server_id"] == "disabled"
    assert payload["server"]["status"] == "disabled"
    assert payload["server"]["failure_category"] is None


def test_mcp_list_command_loads_global_config(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    (home / ".mycli").mkdir(parents=True)
    (home / ".mycli" / "mcp_servers.toml").write_text(
        "\n".join(
            [
                "[mcpServers.global_disabled]",
                'type = "streamable_http"',
                'url = "https://mcp.example.test/mcp"',
                "enabled = false",
            ]
        ),
        encoding="utf-8",
    )
    output: list[str] = []

    exit_code = handle_mcp_command(
        {"command": "mcp", "utility_args": ["list"], "json_output": False},
        cwd=workspace,
        home=home,
        env={},
        output_func=output.append,
    )

    rendered = "\n".join(output)
    assert exit_code == 0
    assert "mcp server global_disabled" in rendered
    assert "transport=streamable_http" in rendered


def test_main_runs_doctor_without_leaking_api_key(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    config_dir = workspace / ".mycli"
    config_dir.mkdir()
    config_dir.joinpath("config.toml").write_text(
        "\n".join(
            [
                'api_key = "sk-doctor-secret"',
                'provider = "deepseek"',
                'protocol = "chat_completions"',
                'model = "deepseek-v4-flash"',
                'api_base_url = "https://api.deepseek.com"',
            ]
        ),
        encoding="utf-8",
    )
    output: list[str] = []

    exit_code = main(
        argv=["doctor"],
        cwd=workspace,
        home=home,
        env={},
        output_func=output.append,
    )

    rendered = "\n".join(output)
    assert exit_code == 0
    assert "mycli doctor" in rendered
    assert "provider=deepseek" in rendered
    assert "api_key: present" in rendered
    assert "sk-doctor-secret" not in rendered


def test_build_turn_service_uses_cli_and_env_configuration(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_BASE_URL": "https://example.invalid/v1",
        },
    )

    assert service._config.session_id == "demo"
    assert service._config.model == "gpt-test"
    assert service._config.api_key == "test-key"
    assert service._config.api_base_url == "https://example.invalid/v1"
    assert (
        service._runtime._workspace_log_service.error_log_path()
        == home_dir / ".mycli" / "logs" / "errors.log"
    )
    assert service._tool_registry.list_names() == [
        "AskUserQuestion",
        "Bash",
        "BashOutput",
        "Edit",
        "GitDiff",
        "GitLog",
        "GitShow",
        "GitStatus",
        "KillShell",
        "LS",
        "Lint",
        "Patch",
        "Plan",
        "Read",
        "SendMessage",
        "Shell",
        "ShellOutput",
        "Skill",
        "SubagentOutput",
        "Task",
        "WebFetch",
        "WebSearch",
        "Write",
        "WriteStdin",
    ]
    memory_dir = home_dir / ".mycli" / "projects"
    write_tool = service._tool_registry.executors["Write"]
    target = next(memory_dir.rglob("memory")) / "MEMORY.md"
    result = write_tool.execute(
        {
            "file_path": str(target),
            "content": "- [Tone](tone.md) - terse\n",
        }
    )
    assert result.success is True
    assert target.read_text(encoding="utf-8") == "- [Tone](tone.md) - terse\n"


def test_build_turn_service_defaults_to_responses_protocol(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
        },
    )

    assert isinstance(service._runtime._model_adapter, ResponsesModelAdapter)


def test_turn_service_accepts_stream_sink(tmp_path: Path) -> None:
    class Runtime:
        def __init__(self) -> None:
            self._config = SimpleNamespace(session_id="demo", workspace_root=tmp_path)
            self._tool_registry = SimpleNamespace(list_names=lambda: [])
            self.seen_sink = None

        def handle_user_turn(self, message: str, stream_sink=None) -> TurnResponse:
            self.seen_sink = stream_sink
            if stream_sink is not None:
                stream_sink(SimpleNamespace(kind="text_delta", text="hi", tool_name=None, metadata={}))
            return TurnResponse(assistant_message=f"done {message}")

    runtime = Runtime()
    service = TurnService(
        config=runtime._config,
        home_dir=tmp_path / "home",
        runtime=runtime,
    )
    events = []
    sink = events.append

    response = service.handle_user_turn("hello", stream_sink=sink)

    assert response.assistant_message == "done hello"
    assert runtime.seen_sink is sink
    assert events[0].text == "hi"


def test_build_turn_service_uses_chat_completions_when_protocol_is_explicitly_set(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROTOCOL": "chat_completions",
        },
    )

    assert isinstance(service._runtime._model_adapter, NativeToolModelAdapter)


def test_build_turn_service_uses_protocol_from_project_config_file(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (workspace / ".mycli").mkdir()
    (workspace / ".mycli" / "config.toml").write_text(
        'protocol = "chat_completions"\n',
        encoding="utf-8",
    )

    service = build_turn_service(
        cli_args={"session": "demo"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
        },
    )

    assert isinstance(service._runtime._model_adapter, NativeToolModelAdapter)


def test_build_turn_service_can_disable_memory_from_project_config(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (workspace / ".mycli").mkdir()
    (workspace / ".mycli" / "config.toml").write_text(
        "memory_enabled = false\n",
        encoding="utf-8",
    )

    service = build_turn_service(
        cli_args={"session": "demo"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
        },
    )

    assert service._config.memory_enabled is False


def test_build_turn_service_can_disable_memory_from_env(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "demo"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_MEMORY_ENABLED": "false",
        },
    )

    assert service._config.memory_enabled is False


def test_build_turn_service_loads_global_mcp_config_with_cli_env(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (home_dir / ".mycli").mkdir()
    (home_dir / ".mycli" / "mcp_servers.toml").write_text(
        "\n".join(
            [
                "[servers.fs]",
                'command = "python"',
                'args = ["server.py"]',
                "[servers.fs.env]",
                'TOKEN = "${MCP_TEST_TOKEN}"',
            ]
        ),
        encoding="utf-8",
    )

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
            "MCP_TEST_TOKEN": "from-cli-env",
        },
    )

    provider = next(
        provider
        for provider in service._runtime._contributed_tool_providers
        if isinstance(provider, McpToolContributionProvider)
    )
    client = provider.adapter._clients["fs"]
    assert client.config.env["TOKEN"] == "from-cli-env"


def test_build_turn_service_uses_stable_skill_tool_without_skill_contributions(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    skill_dir = workspace / ".mycli" / "skills"
    skill_dir.mkdir(parents=True)
    (skill_dir / "repo-skill.md").write_text(
        "---\n"
        'name = "repo-skill"\n'
        'description = "Repo skill"\n'
        'trigger_hints = ["repo"]\n'
        "---\n"
        "Use repo guidance.\n",
        encoding="utf-8",
    )

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )

    assert all(
        provider.__class__.__name__ != "SkillToolContributionProvider"
        for provider in service._runtime._contributed_tool_providers
    )
    tool_names = service._runtime._tool_registry.list_names()
    assert "Skill" in tool_names


def test_build_turn_service_discovers_shared_repo_standard_skill(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    skill_dir = workspace / ".agents" / "skills" / "shared-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        'name = "shared-skill"\n'
        'description = "Shared repository skill"\n'
        "---\n"
        "Use shared repository guidance.\n",
        encoding="utf-8",
    )

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )

    skill = service._runtime._skill_registry.load("shared-skill")
    assert skill is not None
    assert skill.source_kind == "shared_repo"
    assert skill.source_path == str(skill_dir / "SKILL.md")


def test_main_interactive_defaults_to_node_tui(monkeypatch, tmp_path: Path) -> None:
    calls: list[str] = []

    monkeypatch.setattr("mycli.cli.main.stdin", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.stdout", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: object())
    monkeypatch.setattr(
        "mycli.cli.main.run_node_tui",
        lambda *args, **kwargs: calls.append("node") or 0,
    )

    assert main([], cwd=tmp_path, home=tmp_path / "home", env={}) == 0
    assert calls == ["node"]


def test_main_interactive_missing_api_key_runs_setup_then_starts_node_tui(
    monkeypatch,
    tmp_path: Path,
) -> None:
    calls: list[str] = []
    build_calls = 0

    def fake_build_turn_service(*_args, **_kwargs):
        nonlocal build_calls
        build_calls += 1
        if build_calls == 1:
            raise RuntimeError("MYCLI_API_KEY is required")
        return object()

    monkeypatch.setattr("mycli.cli.main.stdin", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.stdout", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.build_turn_service", fake_build_turn_service)
    monkeypatch.setattr(
        "mycli.cli.main.run_setup_wizard",
        lambda **_kwargs: calls.append("setup"),
    )
    monkeypatch.setattr(
        "mycli.cli.main.run_node_tui",
        lambda *args, **kwargs: calls.append("node") or 0,
    )

    assert main([], cwd=tmp_path, home=tmp_path / "home", env={}) == 0
    assert calls == ["setup", "node"]
    assert build_calls == 2


def test_main_reports_malformed_config_without_traceback(
    monkeypatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    config_dir = workspace / ".mycli"
    config_dir.mkdir(parents=True)
    home.mkdir()
    config_path = config_dir / "config.toml"
    config_path.write_text("[model\nname = 'gpt-5'\n", encoding="utf-8")
    outputs: list[str] = []
    monkeypatch.setattr("mycli.cli.main.stdin", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.stdout", SimpleNamespace(isatty=lambda: True))

    exit_code = main(
        [],
        cwd=workspace,
        home=home,
        env={"MYCLI_API_KEY": "test-key"},
        output_func=outputs.append,
    )

    assert exit_code == 2
    assert len(outputs) == 1
    assert "Invalid mycli configuration" in outputs[0]
    assert str(config_path) in outputs[0]
    assert "Traceback" not in outputs[0]


def test_turn_service_inspect_context_reports_empty_metrics(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )

    assert service.inspect_context() == ("no context metrics available",)


def test_turn_service_inspect_status_reports_session_model_and_context(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROVIDER": "deepseek",
            "MYCLI_PROTOCOL": "chat_completions",
        },
    )
    service._observability_service.metrics.record_context_window(
        {
            "input_tokens": 300,
            "max_tokens": 1200,
            "usage_ratio": 0.25,
            "source": "provider",
        }
    )

    assert service.inspect_status() == (
        "session=demo model=gpt-test provider=deepseek/chat_completions context=25.0% tokens=300/1200 pending=no suspended=no",
    )


def test_turn_service_inspect_context_reports_budget_and_compaction(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    metrics = service._observability_service.metrics
    metrics.record_budget(total_tokens=900, max_tokens=1000)
    metrics.record_context_window(
        {
            "total_tokens": 900,
            "max_tokens": 1000,
            "usage_ratio": 0.9,
            "fresh_tokens": 700,
            "tool_result_tokens": 250,
            "duplicate_tool_result_tokens": 50,
            "evictable_tool_result_tokens": 100,
        }
    )
    metrics.record_compaction(before_tokens=1200, after_tokens=300, level="L4")
    metrics.record_l4_decision(decision="summarize", source="pre_request")

    lines = service.inspect_context()

    assert lines[0] == "budget total_tokens=900 max_tokens=1000 usage_ratio=90.0% source=estimate"
    assert (
        "context_window fresh_tokens=700 tool_result_tokens=250 "
        "duplicate_tool_result_tokens=50 evictable_tool_result_tokens=100"
    ) in lines
    assert (
        "compaction L4=1 before_tokens=1200 after_tokens=300 ratio=25.0% "
        "last_decision=summarize source=pre_request"
    ) in lines


def test_turn_service_inspect_context_uses_total_tokens_from_runtime_metrics(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    metrics = service._observability_service.metrics
    metrics.record_budget(total_tokens=100, max_tokens=1000)
    metrics.record_context_window(
        {
            "total_tokens": 900,
            "max_tokens": 1000,
            "usage_ratio": 0.9,
            "fresh_tokens": 700,
            "tool_result_tokens": 250,
            "duplicate_tool_result_tokens": 50,
            "evictable_tool_result_tokens": 100,
        }
    )

    lines = service.inspect_context()

    assert lines[0] == "budget total_tokens=900 max_tokens=1000 usage_ratio=90.0% source=estimate"


def test_turn_service_inspect_context_preserves_provider_input_token_label(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    metrics = service._observability_service.metrics
    metrics.record_context_window(
        {
            "input_tokens": 640,
            "max_tokens": 1000,
            "usage_ratio": 0.64,
            "source": "provider",
            "fresh_tokens": 500,
            "tool_result_tokens": 100,
            "duplicate_tool_result_tokens": 20,
            "evictable_tool_result_tokens": 30,
        }
    )

    lines = service.inspect_context()

    assert lines[0] == "budget input_tokens=640 max_tokens=1000 usage_ratio=64.0% source=provider"


def test_turn_service_inspect_context_uses_budget_curve_when_no_context_window(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    service._observability_service.metrics.record_budget(total_tokens=420, max_tokens=1000)

    lines = service.inspect_context()

    estimated_total_tokens = int(round(0.42 * service._config.max_prompt_tokens))
    assert lines[0] == (
        f"budget total_tokens={estimated_total_tokens} "
        f"max_tokens={service._config.max_prompt_tokens} "
        "usage_ratio=42.0% source=estimate"
    )


def test_turn_service_inspect_context_reports_l4_decision_without_compaction(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    service._observability_service.metrics.record_l4_decision(
        decision="skip",
        source="pre_request",
    )

    lines = service.inspect_context()

    assert lines != ("no context metrics available",)
    assert lines == ("l4 last_decision=skip source=pre_request",)


def test_turn_service_inspect_usage_sums_model_usage_rollouts(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_USAGE_INPUT_COST_PER_1K": "0.001",
            "MYCLI_USAGE_OUTPUT_COST_PER_1K": "0.002",
            "MYCLI_USAGE_CACHE_READ_COST_PER_1K": "0.0001",
            "MYCLI_USAGE_CACHE_WRITE_COST_PER_1K": "0.0002",
        },
    )

    usage_item = TurnItem(
        type=TurnItemType.MODEL_USAGE,
        metadata={
            "input_tokens": 1000,
            "output_tokens": 200,
            "total_tokens": 1200,
            "cache_read_tokens": 300,
            "cache_write_tokens": 100,
        },
    )
    service._session_service.append_turn_rollout(
        "demo",
        TurnRollout(
            thread_id="demo",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            started_at="2026-05-19T00:00:00Z",
            completed_at="2026-05-19T00:00:01Z",
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            events=(
                TurnRolloutEvent(
                    event_id="turn_1:trace:1",
                    kind="turn_item",
                    created_at="2026-05-19T00:00:01Z",
                    payload=usage_item.to_dict(),
                ),
            ),
        ),
    )

    lines = service.inspect_usage()

    assert lines == (
        "session=demo",
        "turns=1",
        f"current_context_window input_tokens=1000 max_tokens={service._config.max_prompt_tokens} usage_ratio=8.3% source=provider",
        "cumulative_usage input_tokens=1000 output_tokens=200 total_tokens=1200 cache_read_tokens=300 cache_write_tokens=100",
        "estimated_cost=0.00145",
    )


def test_turn_service_inspect_usage_excludes_internal_memory_usage(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )

    main_usage = TurnItem(
        type=TurnItemType.MODEL_USAGE,
        metadata={
            "input_tokens": 1000,
            "output_tokens": 200,
            "total_tokens": 1200,
            "cache_read_tokens": 300,
            "cache_write_tokens": 100,
        },
    )
    internal_usage = TurnItem(
        type=TurnItemType.MODEL_USAGE,
        metadata={
            "usage_scope": "internal",
            "child_session_id": "demo:memory:turn_1:abcd1234",
            "input_tokens": 9000,
            "output_tokens": 900,
            "total_tokens": 9900,
            "cache_read_tokens": 8000,
            "cache_write_tokens": 0,
        },
    )
    service._session_service.append_turn_rollout(
        "demo",
        TurnRollout(
            thread_id="demo",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            started_at="2026-05-19T00:00:00Z",
            completed_at="2026-05-19T00:00:01Z",
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            events=(
                TurnRolloutEvent(
                    event_id="turn_1:trace:1",
                    kind="turn_item",
                    created_at="2026-05-19T00:00:01Z",
                    payload=main_usage.to_dict(),
                ),
                TurnRolloutEvent(
                    event_id="turn_1:trace:2",
                    kind="turn_item",
                    created_at="2026-05-19T00:00:02Z",
                    payload=internal_usage.to_dict(),
                ),
            ),
        ),
    )

    lines = service.inspect_usage()

    assert (
        "cumulative_usage input_tokens=1000 output_tokens=200 "
        "total_tokens=1200 cache_read_tokens=300 cache_write_tokens=100"
    ) in lines


def test_turn_service_inspect_usage_reports_latest_context_window_separately(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "default", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )

    for turn_id, input_tokens in (("turn_1", 1000), ("turn_2", 2400)):
        usage_item = TurnItem(
            type=TurnItemType.MODEL_USAGE,
            metadata={
                "input_tokens": input_tokens,
                "budget_input_tokens": input_tokens,
                "output_tokens": 100,
                "total_tokens": input_tokens + 100,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "max_tokens": 10000,
                "usage_ratio": input_tokens / 10000,
                "source": "provider",
            },
        )
        service._session_service.append_turn_rollout(
            "default",
            TurnRollout(
                thread_id="default",
                turn_id=turn_id,
                status=TurnStatus.COMPLETED,
                started_at="2026-05-19T00:00:00Z",
                completed_at="2026-05-19T00:00:01Z",
                stop_reason=StopReason.ASSISTANT_COMPLETED,
                events=(
                    TurnRolloutEvent(
                        event_id=f"{turn_id}:trace:1",
                        kind="turn_item",
                        created_at="2026-05-19T00:00:01Z",
                        payload=usage_item.to_dict(),
                    ),
                ),
            ),
        )

    lines = service.inspect_usage()

    assert (
        "current_context_window input_tokens=2400 max_tokens=10000 "
        "usage_ratio=24.0% source=provider"
    ) in lines
    assert (
        "cumulative_usage input_tokens=3400 output_tokens=200 "
        "total_tokens=3600 cache_read_tokens=0 cache_write_tokens=0"
    ) in lines


def test_turn_service_current_context_window_metrics_prefers_latest_usage_rollout(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "default", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    service._observability_service.metrics.record_context_window(
        {
            "input_tokens": 4997,
            "max_tokens": 100000,
            "usage_ratio": 0.04997,
            "source": "estimate",
        }
    )
    usage_item = TurnItem(
        type=TurnItemType.MODEL_USAGE,
        metadata={
            "input_tokens": 8818,
            "budget_input_tokens": 8818,
            "output_tokens": 120,
            "total_tokens": 8938,
            "max_tokens": 100000,
            "usage_ratio": 0.08818,
            "source": "provider",
        },
    )
    service._session_service.append_turn_rollout(
        "default",
        TurnRollout(
            thread_id="default",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            started_at="2026-05-19T00:00:00Z",
            completed_at="2026-05-19T00:00:01Z",
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            events=(
                TurnRolloutEvent(
                    event_id="turn_1:trace:1",
                    kind="turn_item",
                    created_at="2026-05-19T00:00:01Z",
                    payload=usage_item.to_dict(),
                ),
            ),
        ),
    )

    assert service.current_context_window_metrics() == {
        "input_tokens": 8818,
        "max_tokens": 100000,
        "usage_ratio": 0.08818,
        "source": "provider",
    }


def test_turn_service_inspect_usage_reports_unavailable_cost_without_prices(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )

    assert service.inspect_usage() == (
        "session=demo",
        "turns=0",
        "current_context_window=unavailable",
        "cumulative_usage input_tokens=0 output_tokens=0 total_tokens=0 cache_read_tokens=0 cache_write_tokens=0",
        "estimated_cost=unavailable",
    )


def test_turn_service_inspect_usage_ignores_budget_input_tokens(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_USAGE_INPUT_COST_PER_1K": "0.001",
            "MYCLI_USAGE_OUTPUT_COST_PER_1K": "0.002",
        },
    )

    usage_item = TurnItem(
        type=TurnItemType.MODEL_USAGE,
        metadata={
            "input_tokens": 0,
            "budget_input_tokens": 900,
            "output_tokens": 0,
            "total_tokens": 1800,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
        },
    )
    service._session_service.append_turn_rollout(
        "demo",
        TurnRollout(
            thread_id="demo",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            started_at="2026-05-19T00:00:00Z",
            completed_at="2026-05-19T00:00:01Z",
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            events=(
                TurnRolloutEvent(
                    event_id="turn_1:trace:1",
                    kind="turn_item",
                    created_at="2026-05-19T00:00:01Z",
                    payload=usage_item.to_dict(),
                ),
            ),
        ),
    )

    assert service.inspect_usage() == (
        "session=demo",
        "turns=1",
        f"current_context_window input_tokens=900 max_tokens={service._config.max_prompt_tokens} usage_ratio=7.5% source=estimate",
        "cumulative_usage input_tokens=0 output_tokens=0 total_tokens=1800 cache_read_tokens=0 cache_write_tokens=0",
        "estimated_cost=0.00000",
    )


def test_turn_service_inspect_trace_includes_tool_summary_and_arguments(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    service._trace_service.append(
        "demo",
        RuntimeTraceEvent(
            kind="tool_execution",
            turn_id="turn_1",
            payload={
                "tool_name": "run_shell",
                "arguments": {"args": ["pwd"]},
                "summary": "Command exited with 0",
                "stdout_preview": "/Users/cosmos/Desktop/mycli",
            },
        ),
    )

    rendered = service.inspect_trace()

    assert rendered == (
        "tool_execution run_shell summary=Command exited with 0",
    )


def test_turn_service_inspect_trace_renders_runtime_policy_bounded_fields(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    service._trace_service.append(
        "demo",
        RuntimeTraceEvent(
            kind="runtime_policy_decision",
            turn_id="turn_1",
            payload={
                "tool_name": "Bash",
                "decision": "needs_approval",
                "policy": "shell_safety_analysis",
                "risk_level": "high",
                "argument_keys": ["command"],
                "argument_count": 1,
                "arguments": {"command": "git push origin main sk-do-not-print"},
                "execpolicy_decision": "ask",
                "execpolicy_rule_source": "project",
                "execpolicy_rule_pattern_hash": "hash-only",
                "execpolicy_rule_pattern_length": 2,
                "execpolicy_rule_argument_count": 5,
                "sandbox": {
                    "filesystem": "workspace_write",
                    "network": "disabled",
                    "shell": "restricted",
                },
            },
        ),
    )

    rendered = service.inspect_trace()

    assert rendered == (
        "runtime_policy_decision Bash decision=needs_approval "
        "policy=shell_safety_analysis risk=high args=1 keys=command "
        "execpolicy=ask source=project rule=hash-only "
        "sandbox=fs:workspace_write,net:disabled,shell:restricted",
    )
    assert "git push" not in str(rendered)
    assert "sk-do-not-print" not in str(rendered)


def test_turn_service_exports_trace_jsonl_for_external_consumers(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    service._trace_service.append(
        "demo",
        RuntimeTraceEvent(
            kind="tool_execution",
            turn_id="turn_1",
            payload={"tool_name": "Read"},
        ),
    )

    exported = service.export_trace_jsonl()

    assert len(exported) == 1
    assert json.loads(exported[0]) == {
        "kind": "tool_execution",
        "turn_id": "turn_1",
        "payload": {"tool_name": "Read"},
    }


def test_turn_service_inspect_extensions_summarizes_manifest(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )

    rendered = service.inspect_extensions()

    assert rendered[0].startswith("agent=mycli schema=1 ")
    assert "rpc extension.manifest" in rendered
    assert "rpc trace.export" in rendered
    assert "runtime.trace.export available" in rendered
    assert "extensions.lifecycle not_available" in rendered
    assert "acp.server not_available" in rendered


def test_turn_service_inspect_trace_includes_tool_effect_diagnostics(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    service._trace_service.append(
        "demo",
        RuntimeTraceEvent(
            kind="tool_execution",
            turn_id="turn_1",
            payload={
                "tool_name": "Bash",
                "status": "succeeded",
                "duration_ms": 12,
                "filesystem_effect": "unknown",
                "process_effect": True,
                "summary": "Command exited with 0",
            },
        ),
    )

    rendered = service.inspect_trace()

    assert rendered == (
        "tool_execution Bash status=succeeded duration_ms=12 filesystem=unknown process=true summary=Command exited with 0",
    )


def test_turn_service_inspect_trace_renders_guardrail_diagnostics(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    service._trace_service.append(
        "demo",
        RuntimeTraceEvent(
            kind="guardrail",
            turn_id="turn_1",
            payload={
                "exit_reason": "repeated_tool_failure",
                "stop_reason": "loop_detected",
                "trigger": "repeated_failed_tool_result",
                "count": 3,
                "tool_name": "Read",
                "path": "missing.py",
                "error_kind": "not_found",
            },
        ),
    )

    rendered = service.inspect_trace()

    assert rendered == (
        "guardrail Read exit_reason=repeated_tool_failure stop_reason=loop_detected trigger=repeated_failed_tool_result count=3 path=missing.py error_kind=not_found",
    )


def test_turn_service_inspect_trace_renders_tool_lifecycle_events(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    service._trace_service.append(
        "demo",
        RuntimeTraceEvent(
            kind="tool_lifecycle",
            turn_id="turn_1",
            payload={
                "route_name": "workspace_summary",
                "scope": "thread",
                "state": "completed",
                "source": "runtime",
            },
        ),
    )

    rendered = service.inspect_trace()

    assert rendered == (
        "tool_lifecycle workspace_summary scope=thread state=completed source=runtime",
    )


def test_turn_service_inspect_trace_prefers_high_signal_events_over_turn_items(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    for index in range(12):
        service._trace_service.append(
            "demo",
            RuntimeTraceEvent(
                kind="turn_item",
                turn_id="turn_1",
                payload={"index": index},
            ),
        )
    service._trace_service.append(
        "demo",
        RuntimeTraceEvent(
            kind="tool_lifecycle",
            turn_id="turn_1",
            payload={
                "route_name": "workspace_summary",
                "scope": "thread",
                "state": "completed",
                "source": "runtime",
            },
        ),
    )

    rendered = service.inspect_trace()

    assert rendered == (
        "tool_lifecycle workspace_summary scope=thread state=completed source=runtime",
    )


def test_main_routes_node_tui_flag_to_gateway(monkeypatch, tmp_path: Path) -> None:
    events: dict[str, object] = {}

    class FakeService:
        pass

    monkeypatch.setattr("mycli.cli.main.stdin", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.stdout", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: FakeService())

    def fake_run_node_tui(service, *, cwd, env):
        events["service"] = service
        events["cwd"] = cwd
        events["env"] = env
        return 0

    monkeypatch.setattr("mycli.cli.main.run_node_tui", fake_run_node_tui)

    assert main(
        ["--node-tui", "--session", "demo"],
        cwd=tmp_path,
        home=tmp_path / "home",
        env={"MYCLI_API_KEY": "x"},
    ) == 0
    assert isinstance(events["service"], FakeService)
    assert events["cwd"] == tmp_path


def test_main_routes_node_tui_env_backend(monkeypatch, tmp_path: Path) -> None:
    events: dict[str, object] = {}

    class FakeService:
        pass

    monkeypatch.setattr("mycli.cli.main.stdin", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.stdout", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: FakeService())
    monkeypatch.setattr(
        "mycli.cli.main.run_node_tui",
        lambda service, *, cwd, env: events.setdefault("called", True) and 0,
    )

    assert main(
        ["--session", "demo"],
        cwd=tmp_path,
        home=tmp_path / "home",
        env={"MYCLI_API_KEY": "x", "MYCLI_TUI_BACKEND": "node"},
    ) == 0
    assert events["called"] is True


def test_main_routes_mycli_shell_env_backend_through_node_gateway(monkeypatch, tmp_path: Path) -> None:
    events: dict[str, object] = {}

    class FakeService:
        pass

    monkeypatch.setattr("mycli.cli.main.stdin", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.stdout", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: FakeService())
    monkeypatch.setattr(
        "mycli.cli.main.run_node_tui",
        lambda service, *, cwd, env: events.setdefault("env", env) and 0,
    )

    assert main(
        ["--session", "demo"],
        cwd=tmp_path,
        home=tmp_path / "home",
        env={"MYCLI_API_KEY": "x", "MYCLI_TUI_BACKEND": "shell"},
    ) == 0
    assert events["env"]["MYCLI_TUI_BACKEND"] == "shell"
