from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import tempfile

from mycli.domain.tooling.calls import ToolCall
from mycli.services.plugins.management import PluginManagementService
from mycli.services.hooks import HookContext, HookManager, HookPoint
from mycli.services.plugins import PluginCommandRegistry, load_enabled_plugins
from mycli.tools.registry import ToolRegistry


def main() -> int:
    timestamp = datetime.now(tz=UTC).strftime("%Y%m%dT%H%M%SZ")
    with tempfile.TemporaryDirectory(prefix="mycli-plugin-runtime-") as raw_root:
        root = Path(raw_root)
        workspace = root / "workspace"
        home = root / "home"
        plugin = workspace / ".mycli" / "plugins" / "demo"
        plugin.mkdir(parents=True)
        (home / ".mycli" / "plugins").mkdir(parents=True)
        marker = root / "registered.txt"
        plugin.joinpath("plugin.yaml").write_text(
            "\n".join(
                [
                    "name: Demo Plugin",
                    "version: '1.0'",
                    "description: Smoke plugin",
                    "kind: standalone",
                    "provides_tools:",
                    "  - DemoTool",
                    "provides_hooks:",
                    "  - pre_tool_use",
                    "provides_commands:",
                    "  - id: DemoCommand",
                    "    description: Demo smoke command",
                    "    kind: slash",
                    "    args_schema:",
                    "      type: object",
                    "requires_env: []",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        plugin.joinpath("__init__.py").write_text(
            "\n".join(
                [
                    "from pathlib import Path",
                    "from mycli.services.hooks import HookAction, HookResult",
                    "",
                    "def register(ctx):",
                    f"    Path({str(marker)!r}).write_text('registered', encoding='utf-8')",
                    "    def hook(context):",
                    "        return HookResult(action=HookAction.DENY, message='plugin denied')",
                    "    ctx.register_hook('pre_tool_use', hook, name='plugin:demo:hook')",
                    "    ctx.register_tool('DemoTool', {'description': 'Demo smoke tool'}, lambda args: {'summary': 'plugin tool ok'}, {'toolset': 'plugin'})",
                    "    ctx.register_command('DemoCommand', {'description': 'Demo smoke command'}, lambda args: {'summary': 'plugin command ok', 'content': args.get('name', 'world')})",
                ]
            )
            + "\n",
            encoding="utf-8",
        )

        disabled_by_default = _load(workspace=workspace, home=home)
        default_loaded = disabled_by_default["loaded_statuses"]
        default_marker = marker.exists()
        marker.unlink(missing_ok=True)

        _write_config(workspace, enabled=["demo"])
        enabled_state = _load(workspace=workspace, home=home, execute=True)
        management_service = PluginManagementService(workspace_root=workspace, home_dir=home, env={})
        inspect_payload = management_service.inspect_plugin("demo").to_dict()
        run_payload = management_service.run_command(
            "demo",
            "DemoCommand",
            {"name": "codex"},
        ).to_dict()
        enabled_marker = marker.exists()
        marker.unlink(missing_ok=True)

        _write_config(workspace, enabled=["demo"], disabled=["demo"])
        disabled_state = _load(workspace=workspace, home=home)
        disabled_marker = marker.exists()

        report = {
            "scenario": "plugin-runtime-smoke",
            "timestamp": timestamp,
            "default_loaded_statuses": default_loaded,
            "default_marker_exists": default_marker,
            "enabled": enabled_state,
            "inspect": inspect_payload,
            "run": run_payload,
            "enabled_marker_exists": enabled_marker,
            "disabled": disabled_state,
            "disabled_marker_exists": disabled_marker,
        }
        ok = (
            default_loaded == ["disabled"]
            and not default_marker
            and enabled_state["loaded_statuses"] == ["loaded"]
            and enabled_marker
            and enabled_state["hook_actions"] == ["deny"]
            and enabled_state["tool_summary"] == "plugin tool ok"
            and enabled_state["command_summary"] == "plugin command ok"
            and enabled_state["command_content"] == "codex"
            and inspect_payload["plugin"]["provided_commands"][0]["id"] == "plugin:demo:DemoCommand"
            and run_payload["command_result"]["summary"] == "plugin command ok"
            and disabled_state["loaded_statuses"] == ["disabled"]
            and not disabled_marker
        )
        report["ok"] = ok
        output_dir = Path(__file__).resolve().parent / "runs"
        output_dir.mkdir(parents=True, exist_ok=True)
        report_path = output_dir / f"plugin-runtime-smoke-{timestamp}.json"
        report_path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
        print(f"[plugin-runtime-smoke] report: {report_path}")
        print(f"[plugin-runtime-smoke] ok={str(ok).lower()}")
        return 0 if ok else 1


def _load(*, workspace: Path, home: Path, execute: bool = False) -> dict[str, object]:
    manager = HookManager()
    registry = ToolRegistry(workspace_root=workspace)
    command_registry = PluginCommandRegistry()
    state = load_enabled_plugins(
        workspace_root=workspace,
        home_dir=home,
        hook_manager=manager,
        tool_registry=registry,
        command_registry=command_registry,
        env={},
    )
    payload: dict[str, object] = {
        "loaded_statuses": [item.status.value for item in state.loaded],
        "registered_hooks": [list(item.registered_hooks) for item in state.loaded],
        "registered_tools": [list(item.registered_tools) for item in state.loaded],
        "registered_commands": [list(item.registered_commands) for item in state.loaded],
    }
    if execute:
        payload["hook_actions"] = [
            result.action.value
            for result in manager.execute(HookPoint.PRE_TOOL_USE, HookContext(hook_point=HookPoint.PRE_TOOL_USE))
        ]
        payload["tool_summary"] = registry.execute(ToolCall(name="DemoTool", arguments={}, reason="smoke")).summary
        command_result = command_registry.execute("demo", "DemoCommand", {"name": "codex"})
        payload["command_summary"] = command_result.summary
        payload["command_content"] = command_result.content
    return payload


def _write_config(workspace: Path, *, enabled: list[str], disabled: list[str] | None = None) -> None:
    (workspace / ".mycli").mkdir(parents=True, exist_ok=True)
    (workspace / ".mycli" / "config.toml").write_text(
        "[plugins]\n"
        f"enabled = {json.dumps(enabled)}\n"
        f"disabled = {json.dumps(disabled or [])}\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    raise SystemExit(main())
