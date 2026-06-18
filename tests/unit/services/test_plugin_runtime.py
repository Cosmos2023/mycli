from __future__ import annotations

import json
from pathlib import Path

from mycli.domain.tooling.calls import ToolCall
from mycli.services.diagnostics.doctor import DoctorService, DoctorStatus
from mycli.services.hooks import HookAction, HookContext, HookManager, HookPoint
from mycli.services.plugins import PluginCommandRegistry, discover_plugins, load_enabled_plugins
from mycli.services.plugins.management import PluginManagementService
from mycli.tools.registry import ToolRegistry


def test_plugin_discovery_parses_manifest_and_enablement(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_config(workspace, enabled=["demo"])
    _write_plugin(workspace, "demo")

    discovery = discover_plugins(workspace_root=workspace, home_dir=home)

    assert discovery.enablement.is_enabled("demo") is True
    assert len(discovery.selected) == 1
    candidate = discovery.selected[0]
    assert candidate.plugin_id == "demo"
    assert candidate.manifest is not None
    assert candidate.manifest.name == "Demo Plugin"
    assert candidate.manifest.provides_tools == ("DemoTool",)
    assert candidate.manifest.provides_hooks == ("pre_tool_use",)
    assert candidate.manifest.provides_commands[0].name == "DemoCommand"


def test_plugin_discovery_reads_home_mycli_config_before_legacy_user_config(
    tmp_path: Path,
) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_home_config(home, enabled=["demo"])
    legacy_config_dir = home / ".config" / "mycli"
    legacy_config_dir.mkdir(parents=True)
    (legacy_config_dir / "config.toml").write_text(
        '[plugins]\nenabled = ["legacy"]\n',
        encoding="utf-8",
    )
    _write_plugin(workspace, "demo")
    _write_plugin(workspace, "legacy")

    discovery = discover_plugins(workspace_root=workspace, home_dir=home)

    assert discovery.enablement.is_enabled("demo") is True
    assert discovery.enablement.is_enabled("legacy") is False


def test_plugin_discovery_reports_bad_manifest_and_duplicate(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_config(workspace, enabled=["demo"])
    repo_plugin = workspace / ".mycli" / "plugins" / "demo"
    user_plugin = home / ".mycli" / "plugins" / "demo"
    repo_plugin.mkdir(parents=True)
    user_plugin.mkdir(parents=True)
    (repo_plugin / "plugin.yaml").write_text("[bad", encoding="utf-8")
    _write_plugin_dir(user_plugin)

    discovery = discover_plugins(workspace_root=workspace, home_dir=home)

    issue_text = "\n".join(issue.safe_line() for issue in discovery.issues)
    assert "manifest not parseable" in issue_text
    assert "duplicate plugin id" in issue_text
    assert discovery.selected[0].source.value == "user"


def test_plugin_runtime_does_not_load_disabled_plugin(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_config(workspace, enabled=["demo"], disabled=["demo"])
    marker = tmp_path / "loaded.txt"
    _write_plugin(workspace, "demo", register_body=f"from pathlib import Path\nPath({str(marker)!r}).write_text('loaded')\n")

    state = load_enabled_plugins(
        workspace_root=workspace,
        home_dir=home,
        hook_manager=HookManager(),
        tool_registry=ToolRegistry(workspace_root=workspace),
        env={},
    )

    assert state.loaded[0].status.value == "disabled"
    assert not marker.exists()


def test_plugin_runtime_registers_hook_and_tool(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_config(workspace, enabled=["demo"])
    _write_plugin(
        workspace,
        "demo",
        register_body="""
from mycli.services.hooks import HookAction, HookResult

def register(ctx):
    def pre_tool(context):
        return HookResult(action=HookAction.DENY, message='blocked by plugin')
    ctx.register_hook('pre_tool_use', pre_tool, name='plugin:demo:pre_tool')
    ctx.register_tool('DemoTool', {'description': 'Demo tool'}, lambda args: {'summary': 'demo ok'}, {'toolset': 'plugin'})
""".strip(),
    )
    manager = HookManager()
    registry = ToolRegistry(workspace_root=workspace)

    state = load_enabled_plugins(
        workspace_root=workspace,
        home_dir=home,
        hook_manager=manager,
        tool_registry=registry,
        env={},
    )

    assert state.loaded[0].status.value == "loaded"
    assert state.loaded[0].registered_hooks == ("pre_tool_use:plugin:demo:pre_tool",)
    assert "DemoTool" in registry.list_names()
    hook_result = manager.execute(HookPoint.PRE_TOOL_USE, HookContext(hook_point=HookPoint.PRE_TOOL_USE))[0]
    assert hook_result.action is HookAction.DENY
    assert registry.execute(ToolCall(name="DemoTool", arguments={}, reason="test")).summary == "demo ok"
    manifest_entry = next(item for item in registry.manifest()["tools"] if item["name"] == "DemoTool")
    assert manifest_entry["source"] == "plugin"
    assert manifest_entry["id"] == "plugin:demo:DemoTool"


def test_plugin_runtime_hook_dict_can_return_additional_contexts(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_config(workspace, enabled=["demo"])
    _write_plugin(
        workspace,
        "demo",
        register_body="""
def register(ctx):
    def post_tool(context):
        return {
            'action': 'allow',
            'additional_contexts': ['Use this result; do not repeat the same call.'],
        }
    ctx.register_hook('post_tool_use', post_tool, name='plugin:demo:post_tool')
""".strip(),
    )
    manager = HookManager()

    state = load_enabled_plugins(
        workspace_root=workspace,
        home_dir=home,
        hook_manager=manager,
        tool_registry=ToolRegistry(workspace_root=workspace),
        env={},
    )

    assert state.loaded[0].status.value == "loaded"
    result = manager.execute(
        HookPoint.POST_TOOL_USE,
        HookContext(hook_point=HookPoint.POST_TOOL_USE, tool_name="Read"),
    )[0]
    assert result.action is HookAction.ALLOW
    assert result.additional_contexts == (
        "Use this result; do not repeat the same call.",
    )


def test_plugin_runtime_registers_and_executes_command(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_config(workspace, enabled=["demo"])
    _write_plugin(
        workspace,
        "demo",
        register_body="""
def register(ctx):
    ctx.register_command(
        'DemoCommand',
        {'description': 'Demo command', 'args_schema': {'type': 'object'}},
        lambda args: {'ok': True, 'summary': 'hello ' + args.get('name', 'world'), 'content': 'done'},
        {'kind': 'slash'}
    )
""".strip(),
    )
    command_registry = PluginCommandRegistry()

    state = load_enabled_plugins(
        workspace_root=workspace,
        home_dir=home,
        hook_manager=HookManager(),
        tool_registry=ToolRegistry(workspace_root=workspace),
        command_registry=command_registry,
        env={},
    )

    assert state.loaded[0].registered_commands == ("plugin:demo:DemoCommand",)
    entries = command_registry.list_entries(plugin_id="demo")
    assert entries[0]["id"] == "plugin:demo:DemoCommand"
    result = command_registry.execute("demo", "DemoCommand", {"name": "codex"})
    assert result.ok is True
    assert result.summary == "hello codex"
    assert result.content == "done"


def test_plugin_command_registry_reports_duplicate_and_handler_failure(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_config(workspace, enabled=["demo"])
    _write_plugin(
        workspace,
        "demo",
        register_body="""
def register(ctx):
    def explode(args):
        raise RuntimeError('secret should not show')
    ctx.register_command('DemoCommand', {'description': 'first'}, explode)
    ctx.register_command('DemoCommand', {'description': 'second'}, lambda args: 'second')
""".strip(),
    )
    command_registry = PluginCommandRegistry()

    state = load_enabled_plugins(
        workspace_root=workspace,
        home_dir=home,
        hook_manager=HookManager(),
        tool_registry=ToolRegistry(workspace_root=workspace),
        command_registry=command_registry,
        env={},
    )

    assert state.loaded[0].registered_commands == ("plugin:demo:DemoCommand",)
    assert "duplicate command id" in "\n".join(command_registry.issues())
    result = command_registry.execute("demo", "DemoCommand", {})
    assert result.ok is False
    assert result.error == "RuntimeError"
    assert "secret should not show" not in result.summary


def test_plugin_command_registry_reports_invalid_schema(tmp_path: Path) -> None:
    registry = PluginCommandRegistry()

    command_id = registry.register(
        plugin_id="demo",
        name="BadCommand",
        schema="not-object",  # type: ignore[arg-type]
        handler=lambda args: "unreachable",
    )

    assert command_id is None
    assert registry.issues() == ("demo:BadCommand: invalid command schema",)


def test_plugin_runtime_reports_load_failure_and_missing_env(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_config(workspace, enabled=["demo"])
    _write_plugin(
        workspace,
        "demo",
        requires_env=["DEMO_TOKEN"],
        register_body="def register(ctx):\n    raise RuntimeError('secret should not show')\n",
    )

    state = load_enabled_plugins(
        workspace_root=workspace,
        home_dir=home,
        hook_manager=HookManager(),
        tool_registry=ToolRegistry(workspace_root=workspace),
        env={},
    )

    assert state.loaded[0].status.value == "error"
    rendered = "\n".join(issue.safe_line() for issue in state.loaded[0].issues)
    assert "missing required env" in rendered
    assert "secret should not show" not in rendered


def test_plugin_management_service_lists_and_inspects_json_shape(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_config(workspace, enabled=["demo"])
    _write_plugin(workspace, "demo")

    service = PluginManagementService(workspace_root=workspace, home_dir=home, env={})
    listed = service.list_plugins()
    inspected = service.inspect_plugin("demo")

    assert listed.ok is True
    assert listed.plugins[0].plugin_id == "demo"
    assert listed.plugins[0].load_status == "loaded"
    assert inspected.to_dict()["plugin"]["provided_tools"] == ["DemoTool"]  # type: ignore[index]
    assert inspected.to_dict()["plugin"]["provided_commands"][0]["name"] == "DemoCommand"  # type: ignore[index]


def test_doctor_reports_plugin_diagnostics(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_config(workspace, enabled=["demo"])
    _write_plugin(workspace, "demo")

    report = DoctorService(workspace_root=workspace, home_dir=home, env={}).run()

    plugins = next(check for check in report.checks if check.name == "plugins")
    assert plugins.status is DoctorStatus.OK
    assert "loaded=1" in (plugins.detail or "")
    assert "commands=1" in (plugins.detail or "")


def _workspace_home(tmp_path: Path) -> tuple[Path, Path]:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    (workspace / ".mycli" / "plugins").mkdir(parents=True)
    (home / ".mycli" / "plugins").mkdir(parents=True)
    return workspace, home


def _write_config(workspace: Path, *, enabled: list[str], disabled: list[str] | None = None) -> None:
    disabled = disabled or []
    config_dir = workspace / ".mycli"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_dir.joinpath("config.toml").write_text(
        "[plugins]\n"
        f"enabled = {json.dumps(enabled)}\n"
        f"disabled = {json.dumps(disabled)}\n",
        encoding="utf-8",
    )


def _write_home_config(home: Path, *, enabled: list[str], disabled: list[str] | None = None) -> None:
    disabled = disabled or []
    config_dir = home / ".mycli"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_dir.joinpath("config.toml").write_text(
        "[plugins]\n"
        f"enabled = {json.dumps(enabled)}\n"
        f"disabled = {json.dumps(disabled)}\n",
        encoding="utf-8",
    )


def _write_plugin(
    workspace: Path,
    plugin_id: str,
    *,
    requires_env: list[str] | None = None,
    register_body: str | None = None,
) -> None:
    _write_plugin_dir(
        workspace / ".mycli" / "plugins" / plugin_id,
        requires_env=requires_env,
        register_body=register_body,
    )


def _write_plugin_dir(
    path: Path,
    *,
    requires_env: list[str] | None = None,
    register_body: str | None = None,
) -> None:
    path.mkdir(parents=True, exist_ok=True)
    env_lines = "\n".join(f"  - {name}" for name in (requires_env or []))
    requires_block = f"requires_env:\n{env_lines}\n" if requires_env else "requires_env: []\n"
    path.joinpath("plugin.yaml").write_text(
        "\n".join(
            [
                "name: Demo Plugin",
                "version: '1.0'",
                "description: Demo plugin",
                "kind: standalone",
                "provides_tools:",
                "  - DemoTool",
                "provides_hooks:",
                "  - pre_tool_use",
                "provides_commands:",
                "  - id: DemoCommand",
                "    description: Demo command",
                "    kind: slash",
                "    args_schema:",
                "      type: object",
                requires_block.rstrip(),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    path.joinpath("__init__.py").write_text(
        register_body
        or (
            "def register(ctx):\n"
            "    ctx.register_command('DemoCommand', {'description': 'Demo command'}, lambda args: {'summary': 'demo command ok'})\n"
        ),
        encoding="utf-8",
    )
