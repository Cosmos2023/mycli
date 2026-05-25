from __future__ import annotations

import argparse
from collections.abc import Callable
import os
from pathlib import Path
import shutil
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

__all__ = [
    "build_command_handler",
    "build_parser",
    "build_turn_service",
    "handle_evaluation_command",
    "handle_slash_command",
    "main",
    "run_repl",
]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mycli")
    parser.add_argument("--session", default="default", help="Session identifier")
    parser.add_argument("--model", default=None, help="Model override")
    parser.add_argument("--eval-list", action="store_true", help="List evaluation scenarios")
    parser.add_argument("--eval-scenario", default=None, help="Run a single evaluation scenario")
    parser.add_argument(
        "--eval-root",
        default="evaluation/scenarios",
        help="Evaluation scenario root directory",
    )
    return parser

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
            output_func(f"{scenario.id}: {scenario.title}")
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
    eval_exit_code = handle_evaluation_command(args, cwd=cwd, home=home, env=env)
    if eval_exit_code is not None:
        return eval_exit_code
    service = build_turn_service(args, cwd=cwd, home=home, env=env)

    def emit_stream_event(event: RuntimeStreamEvent) -> None:
        for line in render_runtime_stream_event(event):
            output_func(line)

    def render_options() -> RenderOptions:
        config = service._config
        return RenderOptions(
            view_mode=config.view_mode,
            show_statusline=config.statusline_enabled,
            diff_max_lines=240 if config.view_mode is ViewMode.VERBOSE else 80,
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
        return [
            *render_activity_lines(response, options=options),
            *render_stream_lines(response, options=options),
            *render_error_lines(response),
            *render_progress_lines(response, options=options),
            response.assistant_message,
        ]

    cleanup_autocomplete = install_path_autocomplete(
        workspace_root=service._config.workspace_root
    )
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
                service.inspect_status() if service._config.statusline_enabled else ()
            ),
            input_func=input_func,
            output_func=output_func,
        )
    finally:
        cleanup_autocomplete()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
