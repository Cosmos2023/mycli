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

__all__ = [
    "build_command_handler",
    "build_parser",
    "build_turn_service",
    "handle_doctor_command",
    "handle_evaluation_command",
    "handle_hooks_command",
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
    parser.add_argument("command", nargs="?", choices=["doctor", "hooks"], help="Run a utility command")
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
