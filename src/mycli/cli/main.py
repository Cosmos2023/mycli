from __future__ import annotations

import argparse
from collections.abc import Callable
import json
import os
from pathlib import Path
from sys import stdin, stdout
from typing import Any

from mycli.cli.bootstrap import build_turn_service
from mycli.cli.node_tui import NodeTuiProcessError, run_node_tui
from mycli.cli.setup_wizard import run_setup_wizard
from mycli.config.settings import resolve_config
from mycli.services.diagnostics.doctor import DoctorService, render_doctor_report
from mycli.services.hooks.management import (
    HookManagementResponse,
    HookManagementRow,
    HookManagementService,
)
from mycli.services.mcp import (
    McpManagementResponse,
    McpManagementRow,
    McpManagementService,
)
from mycli.services.plugins import (
    PluginManagementResponse,
    PluginManagementRow,
    PluginManagementService,
)
from mycli.services.subagents import (
    SubAgentManagementResponse,
    SubAgentManagementService,
    render_subagent_management_response,
)
from mycli.tools.registry import ToolRegistry
from mycli.tools.shell_resolver import detect_shell_profile

__all__ = [
    "build_parser",
    "build_turn_service",
    "handle_doctor_command",
    "handle_hooks_command",
    "handle_mcp_command",
    "handle_plugins_command",
    "handle_setup_command",
    "handle_subagents_command",
    "main",
]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mycli")
    parser.add_argument("--session", default=None, help="Session identifier")
    parser.add_argument("--model", default=None, help="Model override")
    parser.add_argument(
        "--node-tui",
        action="store_true",
        help="Run the full-screen Node.js TUI gateway",
    )
    parser.add_argument("--json", action="store_true", dest="json_output", help="Render utility output as JSON")
    parser.add_argument("--json-args", default=None, help=argparse.SUPPRESS)
    parser.add_argument(
        "command",
        nargs="?",
        choices=["doctor", "hooks", "plugins", "mcp", "subagents", "setup"],
        help="Run a utility command",
    )
    parser.add_argument("utility_args", nargs="*", help=argparse.SUPPRESS)
    return parser


def should_run_setup_wizard() -> bool:
    return stdin.isatty() and stdout.isatty()


def handle_doctor_command(
    cli_args: dict[str, object],
    *,
    cwd: Path | None = None,
    home: Path | None = None,
    env: dict[str, str] | None = None,
    output_func: Callable[[str], Any] = print,
) -> int | None:
    if cli_args.get("command") != "doctor":
        return None
    report = DoctorService(
        workspace_root=cwd or Path.cwd(),
        home_dir=home or Path.home(),
        env=dict(env or os.environ),
    ).run()
    for line in render_doctor_report(report):
        output_func(line)
    return 1 if report.failed_count else 0


def handle_hooks_command(
    cli_args: dict[str, object],
    *,
    cwd: Path | None = None,
    home: Path | None = None,
    env: dict[str, str] | None = None,
    output_func: Callable[[str], Any] = print,
) -> int | None:
    if cli_args.get("command") != "hooks":
        return None
    utility_args = cli_args.get("utility_args", [])
    args = [str(item) for item in utility_args] if isinstance(utility_args, list) else []
    json_output = bool(cli_args.get("json_output"))
    workspace_root = cwd or Path.cwd()
    home_dir = home or Path.home()
    config = resolve_config({}, dict(env or os.environ), workspace_root, home_dir)
    service = HookManagementService(
        workspace_root=workspace_root,
        home_dir=home_dir,
        shell_path=config.shell_path,
        shell_profile=detect_shell_profile(
            config.shell_path,
            env=dict(env or os.environ),
        ),
    )
    response = _dispatch_hooks_command(service, args)
    if json_output:
        output_func(json.dumps(response.to_dict(), sort_keys=True))
    else:
        for line in render_hook_management_response(response):
            output_func(line)
    return 0 if response.ok else 1


def handle_plugins_command(
    cli_args: dict[str, object],
    *,
    cwd: Path | None = None,
    home: Path | None = None,
    env: dict[str, str] | None = None,
    output_func: Callable[[str], Any] = print,
) -> int | None:
    if cli_args.get("command") != "plugins":
        return None
    utility_args = cli_args.get("utility_args", [])
    args = [str(item) for item in utility_args] if isinstance(utility_args, list) else []
    service = PluginManagementService(
        workspace_root=cwd or Path.cwd(),
        home_dir=home or Path.home(),
        env=dict(env or os.environ),
    )
    json_args_value = cli_args.get("json_args")
    response = _dispatch_plugins_command(
        service,
        args,
        json_args=str(json_args_value) if isinstance(json_args_value, str) else None,
    )
    if bool(cli_args.get("json_output")):
        output_func(json.dumps(response.to_dict(), sort_keys=True))
    else:
        for line in render_plugin_management_response(response):
            output_func(line)
    return 0 if response.ok else 1


def handle_mcp_command(
    cli_args: dict[str, object],
    *,
    cwd: Path | None = None,
    home: Path | None = None,
    env: dict[str, str] | None = None,
    output_func: Callable[[str], Any] = print,
) -> int | None:
    if cli_args.get("command") != "mcp":
        return None
    utility_args = cli_args.get("utility_args", [])
    args = [str(item) for item in utility_args] if isinstance(utility_args, list) else []
    service = McpManagementService(
        workspace_root=cwd or Path.cwd(),
        home_dir=home or Path.home(),
        env=dict(env or os.environ),
    )
    response = _dispatch_mcp_command(service, args)
    if bool(cli_args.get("json_output")):
        output_func(json.dumps(response.to_dict(), sort_keys=True))
    else:
        for line in render_mcp_management_response(response):
            output_func(line)
    return 0 if response.ok else 1


def handle_subagents_command(
    cli_args: dict[str, object],
    *,
    cwd: Path | None = None,
    home: Path | None = None,
    output_func: Callable[[str], Any] = print,
) -> int | None:
    if cli_args.get("command") != "subagents":
        return None
    workspace_root = cwd or Path.cwd()
    utility_args = cli_args.get("utility_args", [])
    args = [str(item) for item in utility_args] if isinstance(utility_args, list) else []
    service = SubAgentManagementService(
        workspace_root=workspace_root,
        home_dir=home or Path.home(),
        known_tools=tuple(ToolRegistry(workspace_root=workspace_root).list_names()),
    )
    response = _dispatch_subagents_command(service, args)
    if bool(cli_args.get("json_output")):
        output_func(json.dumps(response.to_dict(), sort_keys=True))
    else:
        for line in render_subagent_management_response(response):
            output_func(line)
    return 0 if response.ok else 1


def handle_setup_command(
    cli_args: dict[str, object],
    *,
    home: Path | None = None,
    input_func: Callable[[str], str] = input,
    output_func: Callable[[str], Any] = print,
) -> int | None:
    if cli_args.get("command") != "setup":
        return None
    run_setup_wizard(
        home_dir=home or Path.home(),
        input_func=input_func,
        output_func=output_func,
    )
    return 0


def _dispatch_subagents_command(
    service: SubAgentManagementService,
    args: list[str],
) -> SubAgentManagementResponse:
    if not args:
        return SubAgentManagementResponse(
            ok=False,
            action="usage",
            message="usage: mycli subagents list|inspect [profile_id] [--json]",
        )
    action = args[0]
    target = args[1] if len(args) > 1 else ""
    if action == "list" and len(args) == 1:
        return service.list_profiles()
    if action == "inspect" and target and len(args) == 2:
        return service.inspect_profile(target)
    return SubAgentManagementResponse(
        ok=False,
        action=action,
        message="usage: mycli subagents list|inspect [profile_id] [--json]",
    )


def _dispatch_mcp_command(
    service: McpManagementService,
    args: list[str],
) -> McpManagementResponse:
    if not args:
        return McpManagementResponse(
            ok=False,
            action="usage",
            message="usage: mycli mcp list|inspect [server_id] [--json]",
        )
    action = args[0]
    target = args[1] if len(args) > 1 else ""
    if action == "list" and len(args) == 1:
        return service.list_servers()
    if action == "inspect" and target and len(args) == 2:
        return service.inspect_server(target)
    return McpManagementResponse(
        ok=False,
        action=action,
        message="usage: mycli mcp list|inspect [server_id] [--json]",
    )


def render_mcp_management_response(response: McpManagementResponse) -> tuple[str, ...]:
    lines = [f"mycli mcp {response.action}: {response.message}"]
    rows = response.servers or ((response.server,) if response.server is not None else ())
    for row in rows:
        if row is not None:
            lines.extend(_render_mcp_row(row))
    for issue in response.issues:
        lines.append(f"mcp_issue: {issue}")
    return tuple(lines)


def _render_mcp_row(row: McpManagementRow) -> tuple[str, ...]:
    lines = [
        f"mcp server {row.server_id}",
        f"  transport={row.transport} enabled={str(row.enabled).lower()} status={row.status}",
        f"  tool_count={row.tool_count} timeout_seconds={row.timeout_seconds}",
    ]
    if row.failure_kind:
        if row.failure_category:
            lines.append(f"  failure_category={row.failure_category}")
        lines.append(f"  failure_kind={row.failure_kind}")
    if row.failure_message:
        lines.append(f"  failure_message={row.failure_message}")
    return tuple(lines)


def _dispatch_plugins_command(
    service: PluginManagementService,
    args: list[str],
    *,
    json_args: str | None = None,
) -> PluginManagementResponse:
    if not args:
        return PluginManagementResponse(
            ok=False,
            action="usage",
            message="usage: mycli plugins list|inspect|run [plugin_id] [command] [--json-args JSON] [--json]",
        )
    action = args[0]
    target = args[1] if len(args) > 1 else ""
    if action == "list" and len(args) == 1:
        return service.list_plugins()
    if action == "inspect" and target and len(args) == 2:
        return service.inspect_plugin(target)
    if action == "run" and len(args) >= 3:
        raw_json_args = json_args or "{}"
        if "--json-args" in args:
            index = args.index("--json-args")
            if index + 1 >= len(args):
                return PluginManagementResponse(ok=False, action="run", message="--json-args requires a value")
            raw_json_args = args[index + 1]
            args = args[:index] + args[index + 2:]
        if len(args) != 3:
            return PluginManagementResponse(
                ok=False,
                action="run",
                message="usage: mycli plugins run <plugin_id> <command_name> [--json-args JSON] [--json]",
            )
        try:
            parsed_args = json.loads(raw_json_args)
        except json.JSONDecodeError:
            return PluginManagementResponse(ok=False, action="run", message="invalid JSON arguments")
        if not isinstance(parsed_args, dict):
            return PluginManagementResponse(ok=False, action="run", message="JSON arguments must be an object")
        return service.run_command(args[1], args[2], parsed_args)
    return PluginManagementResponse(
        ok=False,
        action=action,
        message="usage: mycli plugins list|inspect|run [plugin_id] [command] [--json-args JSON] [--json]",
    )


def render_plugin_management_response(response: PluginManagementResponse) -> tuple[str, ...]:
    lines = [f"mycli plugins {response.action}: {response.message}"]
    rows = response.plugins or ((response.plugin,) if response.plugin is not None else ())
    for row in rows:
        if row is not None:
            lines.extend(_render_plugin_row(row))
    for issue in response.issues:
        lines.append(f"plugin_issue: {issue}")
    return tuple(lines)


def _render_plugin_row(row: PluginManagementRow) -> tuple[str, ...]:
    tools = ",".join(row.provided_tools) if row.provided_tools else "none"
    hooks = ",".join(row.provided_hooks) if row.provided_hooks else "none"
    commands = ",".join(_plugin_command_label(command) for command in row.provided_commands) if row.provided_commands else "none"
    lines = [
        f"plugin {row.plugin_id}",
        f"  source={row.source} name={row.name} version={row.version or 'unknown'} kind={row.kind}",
        f"  enabled={str(row.enabled).lower()} load_status={row.load_status}",
        f"  provided_tools={tools}",
        f"  provided_hooks={hooks}",
        f"  provided_commands={commands}",
        f"  path={row.path}",
    ]
    lines.extend(f"  issue={issue}" for issue in row.issues)
    return tuple(lines)


def _plugin_command_label(command: dict[str, object]) -> str:
    value = command.get("id") or command.get("name")
    return str(value) if value else "unknown"


def _dispatch_hooks_command(
    service: HookManagementService,
    args: list[str],
) -> HookManagementResponse:
    if not args:
        return HookManagementResponse(
            ok=False,
            action="usage",
            message="usage: mycli hooks list|inspect|approve|revoke [identity] [--json]",
        )
    action = args[0]
    target = args[1] if len(args) > 1 else ""
    if action == "list" and len(args) == 1:
        return service.list_hooks()
    if action == "inspect" and target and len(args) == 2:
        return service.inspect_hook(target)
    if action == "approve" and target and len(args) == 2:
        return service.approve_hook(target)
    if action == "revoke" and target and len(args) == 2:
        return service.revoke_hook(target)
    return HookManagementResponse(
        ok=False,
        action=action,
        message="usage: mycli hooks list|inspect|approve|revoke [identity] [--json]",
    )


def render_hook_management_response(response: HookManagementResponse) -> tuple[str, ...]:
    lines = [f"mycli hooks {response.action}: {response.message}"]
    rows = response.hooks or ((response.hook,) if response.hook is not None else ())
    for row in rows:
        if row is not None:
            lines.extend(_render_hook_row(row))
    for issue in response.config_issues:
        lines.append(f"config_issue: {issue}")
    for issue in response.allowlist_issues:
        lines.append(f"allowlist_issue: {issue}")
    return tuple(lines)


def _render_hook_row(row: HookManagementRow) -> tuple[str, ...]:
    return (
        f"hook {row.identity}",
        f"  source={row.source} hook_id={row.hook_id} hook_point={row.hook_point}",
        f"  enabled={str(row.enabled).lower()} timeout_seconds={row.timeout_seconds:g}",
        f"  working_directory={row.working_directory} env_policy={row.env_policy}",
        f"  command_digest={row.command_digest}",
        f"  allowlist_status={row.allowlist_status} reason={row.allowlist_reason}",
        f"  config_path={row.config_path}",
    )


def main(
    argv: list[str] | None = None,
    cwd: Path | None = None,
    home: Path | None = None,
    env: dict[str, str] | None = None,
    input_func: Callable[[str], str] = input,
    output_func: Callable[[str], Any] = print,
) -> int:
    args = vars(build_parser().parse_args(argv))
    doctor_exit_code = handle_doctor_command(
        args,
        cwd=cwd,
        home=home,
        env=env,
        output_func=output_func,
    )
    if doctor_exit_code is not None:
        return doctor_exit_code
    hooks_exit_code = handle_hooks_command(
        args,
        cwd=cwd,
        home=home,
        env=env,
        output_func=output_func,
    )
    if hooks_exit_code is not None:
        return hooks_exit_code
    plugins_exit_code = handle_plugins_command(
        args,
        cwd=cwd,
        home=home,
        env=env,
        output_func=output_func,
    )
    if plugins_exit_code is not None:
        return plugins_exit_code
    mcp_exit_code = handle_mcp_command(
        args,
        cwd=cwd,
        home=home,
        env=env,
        output_func=output_func,
    )
    if mcp_exit_code is not None:
        return mcp_exit_code
    subagents_exit_code = handle_subagents_command(
        args,
        cwd=cwd,
        home=home,
        output_func=output_func,
    )
    if subagents_exit_code is not None:
        return subagents_exit_code
    setup_exit_code = handle_setup_command(
        args,
        home=home,
        input_func=input_func,
        output_func=output_func,
    )
    if setup_exit_code is not None:
        return setup_exit_code
    if not stdin.isatty() or not stdout.isatty():
        output_func("Interactive mycli requires a terminal.")
        return 2
    try:
        service = build_turn_service(args, cwd=cwd, home=home, env=env)
    except RuntimeError as exc:
        if str(exc) != "MYCLI_API_KEY is required" or not should_run_setup_wizard():
            output_func(str(exc))
            return 2
        run_setup_wizard(
            home_dir=home or Path.home(),
            input_func=input_func,
            output_func=output_func,
        )
        try:
            service = build_turn_service(args, cwd=cwd, home=home, env=env)
        except RuntimeError as retry_exc:
            output_func(str(retry_exc))
            return 2
    try:
        try:
            return run_node_tui(service, cwd=cwd or Path.cwd(), env=env or dict(os.environ))
        except NodeTuiProcessError as exc:
            output_func(str(exc))
            return 2
    finally:
        close = getattr(service, "close", None)
        if callable(close):
            close()


if __name__ == "__main__":
    raise SystemExit(main())
