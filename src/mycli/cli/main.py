from __future__ import annotations

import argparse
from collections.abc import Callable
import json
import os
from pathlib import Path
import shutil
from sys import stdin, stdout
import tempfile
from typing import Any
from datetime import UTC, datetime

from mycli.cli.autocomplete import install_path_autocomplete
from mycli.cli.bootstrap import build_turn_service
from mycli.cli.repl import (
    build_command_handler,
    handle_slash_command,
    run_repl,
)
from mycli.cli.node_tui import NodeTuiProcessError, run_node_tui
from mycli.cli.tui import run_tui
from mycli.cli.rendering import (
    RenderOptions,
    render_activity_lines,
    render_error_lines,
    render_pending_decision,
    render_progress_lines,
    render_runtime_stream_event,
    render_stream_lines,
)
from mycli.config.settings import resolve_config
from mycli.domain.runtime import RuntimeStreamEvent, ViewMode
from mycli.evaluation.runner import (
    EvaluationRunReport,
    EvaluationScenario,
    discover_scenarios,
    load_scenario,
    render_evaluation_report,
    run_evaluation_scenario,
    write_evaluation_report,
)
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
    SubAgentManagementRow,
    SubAgentManagementService,
)
from mycli.tools.registry import ToolRegistry

__all__ = [
    "build_command_handler",
    "build_parser",
    "build_turn_service",
    "handle_doctor_command",
    "handle_evaluation_command",
    "handle_hooks_command",
    "handle_mcp_command",
    "handle_plugins_command",
    "handle_subagents_command",
    "handle_slash_command",
    "main",
    "run_repl",
]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mycli")
    parser.add_argument("--session", default="default", help="Session identifier")
    parser.add_argument("--model", default=None, help="Model override")
    parser.add_argument(
        "--plain",
        action="store_true",
        help="Use the line-oriented REPL instead of the full-screen TUI",
    )
    parser.add_argument(
        "--node-tui",
        action="store_true",
        help="Run the experimental Node.js TUI gateway",
    )
    parser.add_argument("--eval-list", action="store_true", help="List evaluation scenarios")
    parser.add_argument("--eval-scenario", default=None, help="Run a single evaluation scenario")
    parser.add_argument(
        "--eval-root",
        default="evaluation/scenarios",
        help="Evaluation scenario root directory",
    )
    parser.add_argument("--json", action="store_true", dest="json_output", help="Render utility output as JSON")
    parser.add_argument("--json-args", default=None, help=argparse.SUPPRESS)
    parser.add_argument(
        "command",
        nargs="?",
        choices=["doctor", "hooks", "plugins", "mcp", "subagents"],
        help="Run a utility command",
    )
    parser.add_argument("utility_args", nargs="*", help=argparse.SUPPRESS)
    return parser


def should_use_tui(cli_args: dict[str, object]) -> bool:
    if bool(cli_args.get("plain")):
        return False
    return stdin.isatty() and stdout.isatty()


def should_use_node_tui(cli_args: dict[str, object], env: dict[str, str] | None) -> bool:
    if bool(cli_args.get("plain")):
        return False
    env_vars = env if env is not None else os.environ
    backend = env_vars.get("MYCLI_TUI_BACKEND", "").strip().lower()
    if backend == "textual":
        return False
    if bool(cli_args.get("node_tui")) or backend == "node":
        return True
    return stdin.isatty() and stdout.isatty()


def _node_tui_fallback(env: dict[str, str] | None) -> str:
    env_vars = env if env is not None else os.environ
    return env_vars.get("MYCLI_TUI_FALLBACK", "").strip().lower()


def _prepare_evaluation_scenario(
    *,
    scenario: EvaluationScenario,
    home_dir: Path,
    session_id: str,
) -> EvaluationScenario:
    eval_root = home_dir / ".mycli" / "eval-workspaces"
    eval_root.mkdir(parents=True, exist_ok=True)
    run_root = Path(tempfile.mkdtemp(prefix=f"{session_id}-", dir=eval_root))
    workspace_copy_root = run_root / "workspace"
    shutil.copytree(
        scenario.workspace_root,
        workspace_copy_root,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("log", "__pycache__", ".pytest_cache", ".mycli"),
    )
    return EvaluationScenario(
        id=scenario.id,
        title=scenario.title,
        scenario_dir=scenario.scenario_dir,
        workspace_root=workspace_copy_root,
        turn_paths=scenario.turn_paths,
        expected_payload=scenario.expected_payload,
    )


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
    output_func: Callable[[str], Any] = print,
) -> int | None:
    if cli_args.get("command") != "hooks":
        return None
    utility_args = cli_args.get("utility_args", [])
    args = [str(item) for item in utility_args] if isinstance(utility_args, list) else []
    json_output = bool(cli_args.get("json_output"))
    service = HookManagementService(
        workspace_root=cwd or Path.cwd(),
        home_dir=home or Path.home(),
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
    env: dict[str, str] | None = None,
    output_func: Callable[[str], Any] = print,
) -> int | None:
    if cli_args.get("command") != "mcp":
        return None
    utility_args = cli_args.get("utility_args", [])
    args = [str(item) for item in utility_args] if isinstance(utility_args, list) else []
    service = McpManagementService(
        workspace_root=cwd or Path.cwd(),
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


def render_subagent_management_response(response: SubAgentManagementResponse) -> tuple[str, ...]:
    lines = [f"mycli subagents {response.action}: {response.message}"]
    rows = response.profiles or ((response.profile,) if response.profile is not None else ())
    for row in rows:
        if row is not None:
            lines.extend(_render_subagent_row(row))
    for issue in response.issues:
        lines.append(f"subagent_issue: {issue}")
    return tuple(lines)


def _render_subagent_row(row: SubAgentManagementRow) -> tuple[str, ...]:
    allowed = ",".join(row.allowed_tools) if row.allowed_tools else "none"
    denied = ",".join(row.denied_tools) if row.denied_tools else "none"
    high_risk = ",".join(row.high_risk_tools) if row.high_risk_tools else "none"
    lines = [
        f"subagent {row.profile_id}",
        f"  source={row.source} enabled={str(row.enabled).lower()} status={row.status}",
        f"  allowed_tools={allowed}",
        f"  denied_tools={denied}",
        f"  high_risk_tools={high_risk} model={row.model or 'inherit'}",
    ]
    lines.extend(f"  issue={issue}" for issue in row.issues)
    return tuple(lines)


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


def handle_evaluation_command(
    cli_args: dict[str, object],
    *,
    cwd: Path | None = None,
    home: Path | None = None,
    env: dict[str, str] | None = None,
    output_func: Callable[[str], Any] = print,
) -> int | None:
    eval_list = bool(cli_args.get("eval_list"))
    eval_scenario = cli_args.get("eval_scenario")
    if not eval_list and not isinstance(eval_scenario, str):
        return None

    workspace_root = cwd or Path.cwd()
    home_dir = home or Path.home()
    eval_root = workspace_root / str(cli_args.get("eval_root", "evaluation/scenarios"))
    if eval_list:
        for scenario in discover_scenarios(eval_root):
            output_func(f"{scenario.id} [{scenario.tier}]: {scenario.title}")
        return 0

    scenario = load_scenario(eval_root, str(eval_scenario))
    root_env = dict(env or os.environ)
    root_config = resolve_config(cli_args=cli_args, env=root_env, cwd=workspace_root, home=home_dir)
    eval_env = dict(root_env)
    if root_config.api_key:
        eval_env["MYCLI_API_KEY"] = root_config.api_key
    eval_env["MYCLI_PROVIDER"] = str(root_config.provider)
    eval_env["MYCLI_BASE_URL"] = root_config.api_base_url
    eval_env["MYCLI_MODEL"] = root_config.model
    eval_env["MYCLI_PROTOCOL"] = str(root_config.protocol)
    eval_env["MYCLI_MAX_PROMPT_TOKENS"] = str(root_config.max_prompt_tokens)
    eval_env["MYCLI_MAX_OUTPUT_TOKENS"] = str(root_config.max_output_tokens)
    eval_env["MYCLI_COMPRESSION_THRESHOLD_TOKENS"] = str(root_config.compression_threshold_tokens)
    eval_env["MYCLI_RECENT_MESSAGE_COUNT"] = str(root_config.recent_message_count)
    eval_session_id = (
        f"eval-{scenario.id}-{datetime.now(tz=UTC).strftime('%Y%m%dT%H%M%SZ')}"
    )
    prepared_scenario = _prepare_evaluation_scenario(
        scenario=scenario,
        home_dir=home_dir,
        session_id=eval_session_id,
    )
    eval_args = dict(cli_args)
    eval_args["session"] = eval_session_id
    try:
        service = build_turn_service(
            eval_args,
            cwd=prepared_scenario.workspace_root,
            home=home_dir,
            env=eval_env,
        )
    except RuntimeError as exc:
        output_func(f"[eval] error: {exc}")
        return 2
    report: EvaluationRunReport = run_evaluation_scenario(prepared_scenario, service)
    for line in render_evaluation_report(report):
        output_func(line)
    report_path = write_evaluation_report(
        output_root=workspace_root / "evaluation" / "runs",
        report_scenario=prepared_scenario,
        session_id=eval_session_id,
        turn_results=report.turn_results,
        checks=report.checks,
    )
    output_func(f"[eval] report: {report_path}")
    return 1 if report.failed_checks else 0


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
    eval_exit_code = handle_evaluation_command(args, cwd=cwd, home=home, env=env)
    if eval_exit_code is not None:
        return eval_exit_code
    service = build_turn_service(args, cwd=cwd, home=home, env=env)
    try:
        force_plain_after_node_failure = False
        if should_use_node_tui(args, env):
            try:
                return run_node_tui(service, cwd=cwd or Path.cwd(), env=env or dict(os.environ))
            except NodeTuiProcessError as exc:
                fallback = _node_tui_fallback(env)
                if fallback == "plain":
                    output_func(str(exc))
                    force_plain_after_node_failure = True
                elif fallback == "textual" and should_use_tui(args):
                    output_func(str(exc))
                    return run_tui(service, input_func=input_func, output_func=output_func)
                else:
                    output_func(str(exc))
                    return 2
        if should_use_tui(args) and not force_plain_after_node_failure:
            return run_tui(service, input_func=input_func, output_func=output_func)

        def emit_stream_event(event: RuntimeStreamEvent) -> None:
            for line in render_runtime_stream_event(event):
                output_func(line)

        def render_options() -> RenderOptions:
            config = service._config
            view_mode = getattr(config, "view_mode", ViewMode.DEFAULT)
            return RenderOptions(
                view_mode=view_mode,
                show_statusline=bool(getattr(config, "statusline_enabled", True)),
                diff_max_lines=240 if view_mode is ViewMode.VERBOSE else 80,
            )

        def handle_user_message(raw: str) -> list[str]:
            response = service.handle_user_turn(raw, stream_sink=emit_stream_event)
            options = render_options()
            rendered: list[str] = render_activity_lines(response, options=options)
            rendered.extend(render_error_lines(response))
            rendered.extend(render_progress_lines(response, options=options))
            rendered.extend(f"[plan] {step}" for step in response.plan_steps)
            if response.pending_decision is not None:
                rendered.extend(render_pending_decision(response.pending_decision))
            rendered.append(response.assistant_message)
            return rendered

        def resolve_pending_decision(choice: str) -> list[str]:
            response = service.resolve_pending_decision(choice)
            options = render_options()
            progress_lines = (
                list(response.progress_updates)
                if options.view_mode is ViewMode.DEFAULT
                else render_progress_lines(response, options=options)
            )
            return [
                *render_activity_lines(response, options=options),
                *render_stream_lines(response, options=options),
                *render_error_lines(response),
                *progress_lines,
                response.assistant_message,
            ]

        workspace_root = getattr(service._config, "workspace_root", cwd or Path.cwd())
        cleanup_autocomplete = install_path_autocomplete(workspace_root=workspace_root)
        try:
            run_repl(
                handle_user_message,
                session_id=service._config.session_id,
                decision_handler=resolve_pending_decision,
                pending_decision_provider=lambda: (
                    service._session_service.load_pending_decision(service._config.session_id)
                    is not None
                ),
                command_handler=build_command_handler(service),
                statusline_provider=lambda: (
                    service.inspect_status()
                    if getattr(service._config, "statusline_enabled", True)
                    else ()
                ),
                input_func=input_func,
                output_func=output_func,
            )
        finally:
            cleanup_autocomplete()
        return 0
    finally:
        close = getattr(service, "close", None)
        if callable(close):
            close()


if __name__ == "__main__":
    raise SystemExit(main())
