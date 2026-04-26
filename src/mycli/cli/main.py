from __future__ import annotations

import argparse
from collections.abc import Callable, Iterable
import os
from pathlib import Path
import re
import shutil
import tempfile
from typing import Any, cast

from mycli.application.runtime import AgentRuntime
from mycli.application.turn_service import TurnService
from mycli.evaluation.runner import (
    EvaluationRunReport,
    EvaluationScenario,
    discover_scenarios,
    load_scenario,
    render_evaluation_report,
    run_evaluation_scenario,
    write_evaluation_report,
)
from mycli.domain.providers import ProtocolId
from mycli.domain.runtime import DecisionAction, PendingDecision, TurnItemType, TurnRecord
from mycli.infrastructure.models.base import ModelAdapter
from mycli.infrastructure.models.native_tool_adapter import NativeToolModelAdapter
from mycli.infrastructure.models.responses_adapter import ResponsesModelAdapter
from mycli.infrastructure.openai_client import OpenAIChatClient
from mycli.infrastructure.openai_responses_client import OpenAIResponsesClient
from mycli.infrastructure.providers import chat_adapter_for_provider
from mycli.services.config_service import resolve_config
from mycli.services.workspace_log_service import WorkspaceLogService
from mycli.tools.append_file import AppendFileTool
from mycli.tools.create_file import CreateFileTool
from mycli.tools.delete_path import DeletePathTool
from mycli.tools.git_diff import GitDiffTool
from mycli.tools.git_log import GitLogTool
from mycli.tools.git_status import GitStatusTool
from mycli.tools.mkdir import MkdirTool
from mycli.tools.move_path import MovePathTool
from mycli.tools.registry import ToolRegistryV2
from mycli.tools.edit_file import EditFileTool
from mycli.tools.list_directory import ListDirectoryTool
from mycli.tools.read_file import ReadFileTool
from mycli.tools.read_file_range import ReadFileRangeTool
from mycli.tools.replace_in_file import ReplaceInFileTool
from mycli.tools.run_shell import RunShellTool
from mycli.tools.search_text import SearchTextTool
from mycli.tools.update_plan import UpdatePlanTool
from datetime import UTC, datetime


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


def handle_slash_command(command: str) -> str:
    if command == "/help":
        return "\n".join(
            [
                "/help",
                "/skill",
                "/skills",
                "/memory",
                "/plan",
                "/trace",
                "/tools",
                "/session",
                "/sessions",
                "/quit",
            ]
        )
    if command == "/quit":
        return "quit"
    return f"Unknown command: {command}"


def build_command_handler(
    service: TurnService,
) -> Callable[[str], Iterable[str]]:
    def handle(command: str) -> Iterable[str]:
        if command in {"/skill", "/skills"}:
            return [f"[skill] {line}" for line in service.inspect_skills()]
        if command == "/tools":
            return [f"[tool] {line}" for line in service.inspect_tools()]
        if command == "/memory":
            return [f"[memory] {line}" for line in service.inspect_memory()]
        if command == "/plan":
            return [f"[plan] {line}" for line in service.inspect_plan()]
        if command == "/session":
            return [f"[session] {line}" for line in service.inspect_session()]
        if command == "/sessions":
            return [f"[session] {line}" for line in service.inspect_sessions()]
        if command == "/trace":
            return [f"[trace] {line}" for line in service.inspect_trace()]
        return [f"Unknown command: {command}"]

    return handle


def build_turn_service(
    cli_args: dict[str, object],
    cwd: Path | None = None,
    home: Path | None = None,
    env: dict[str, str] | None = None,
) -> TurnService:
    workspace_root = cwd or Path.cwd()
    home_dir = home or Path.home()
    env_vars = env or dict(os.environ)
    config = resolve_config(cli_args=cli_args, env=env_vars, cwd=workspace_root, home=home_dir)
    if not config.api_key:
        raise RuntimeError("MYCLI_API_KEY is required")
    workspace_log_service = WorkspaceLogService(
        workspace_root=workspace_root,
        logs_root=_build_runtime_logs_root(home_dir=home_dir, session_id=config.session_id),
    )

    model_adapter: ModelAdapter
    provider_adapter = chat_adapter_for_provider(config.provider)
    if config.protocol is ProtocolId.CHAT_COMPLETIONS:
        chat_client = OpenAIChatClient(
            api_key=config.api_key,
            base_url=config.api_base_url,
            model=config.model,
            max_output_tokens=config.max_output_tokens,
            log_service=workspace_log_service,
            provider_adapter=provider_adapter,
        )
        model_adapter = cast(
            ModelAdapter,
            NativeToolModelAdapter(
                client=chat_client,
                provider_adapter=provider_adapter,
            ),
        )
    else:
        responses_client = OpenAIResponsesClient(
            api_key=config.api_key,
            base_url=config.api_base_url,
            model=config.model,
            max_output_tokens=config.max_output_tokens,
            log_service=workspace_log_service,
        )
        model_adapter = cast(
            ModelAdapter,
            ResponsesModelAdapter(
                client=responses_client,
                log_service=workspace_log_service,
            ),
        )
    tool_registry = ToolRegistryV2.from_tools(
        [
            CreateFileTool(workspace_root),
            MkdirTool(workspace_root),
            MovePathTool(workspace_root),
            DeletePathTool(workspace_root),
            ListDirectoryTool(workspace_root),
            ReadFileTool(workspace_root),
            ReadFileRangeTool(workspace_root),
            SearchTextTool(workspace_root),
            GitStatusTool(workspace_root),
            GitDiffTool(workspace_root),
            GitLogTool(workspace_root),
            AppendFileTool(workspace_root),
            ReplaceInFileTool(workspace_root),
            EditFileTool(workspace_root),
            RunShellTool(workspace_root),
            UpdatePlanTool(),
        ]
    )
    runtime = AgentRuntime(
        model_adapter=model_adapter,
        tool_registry=tool_registry,
        config=config,
        home_dir=home_dir,
        workspace_log_service=workspace_log_service,
    )
    return TurnService(
        runtime=runtime,
        config=config,
        home_dir=home_dir,
    )


def _build_runtime_logs_root(*, home_dir: Path, session_id: str) -> Path:
    safe_session_id = re.sub(r"[^A-Za-z0-9._-]+", "-", session_id).strip("-") or "default"
    return home_dir / ".mycli" / "logs" / safe_session_id


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


def run_repl(
    turn_handler: Callable[[str], str | Iterable[str]],
    input_func: Callable[[str], str] = input,
    output_func: Callable[[str], Any] = print,
    session_id: str = "default",
    decision_handler: Callable[[str], Iterable[str]] | None = None,
    pending_decision_provider: Callable[[], bool] | None = None,
    command_handler: Callable[[str], Iterable[str]] | None = None,
) -> None:
    while True:
        try:
            raw = input_func("> ").strip()
        except (EOFError, KeyboardInterrupt):
            output_func("Bye.")
            return
        if not raw:
            continue
        if raw.startswith("/"):
            handled = handle_slash_command(raw)
            if handled == "quit":
                output_func("Bye.")
                return
            if handled.startswith("Unknown command:") and command_handler is not None:
                for line in command_handler(raw):
                    output_func(line)
            else:
                output_func(handled)
            continue
        if pending_decision_provider is not None and pending_decision_provider():
            if raw in {"1", "2", "3"} and decision_handler is not None:
                for line in decision_handler(raw):
                    output_func(line)
            else:
                output_func("There is a pending risky action. Choose one of the available options.")
            continue
        rendered = turn_handler(raw)
        if isinstance(rendered, str):
            output_func(rendered)
            continue
        for line in rendered:
            output_func(line)


def render_pending_decision(decision: PendingDecision) -> list[str]:
    option_labels = {
        DecisionAction.APPROVE_ONCE: "[1] 仅本次允许",
        DecisionAction.REJECT: "[2] 拒绝",
        DecisionAction.ALLOW_SESSION: "[3] 本次会话内始终允许同类命令",
    }
    rendered = [
        "[decision] 发现需要确认的操作：",
        f"[decision] Tool: {decision.tool_call.name}",
        f"[decision] Preview: {decision.preview}",
        f"[decision] Reason: {decision.reason}",
    ]
    rendered.extend(option_labels[action] for action in decision.options)
    return rendered


def render_activity_lines(response: object) -> list[str]:
    raw_turn = getattr(response, "turn", None)
    if isinstance(raw_turn, TurnRecord):
        turn_lines = _render_turn_activity_lines(raw_turn)
        if turn_lines:
            return turn_lines

    raw_events = getattr(response, "activity_events", ())
    if not isinstance(raw_events, tuple):
        return []
    lines: list[str] = []
    for event in raw_events:
        message = getattr(event, "message", None)
        if isinstance(message, str) and message:
            kind = getattr(event, "kind", None)
            semantic = None
            if kind in {"thinking", "planning"}:
                semantic = _semanticize_reasoning_activity(None, message)
            lines.append(f"[activity] {semantic or message}")
    return lines


def render_progress_lines(response: object) -> list[str]:
    raw_updates = getattr(response, "progress_updates", ())
    if not isinstance(raw_updates, tuple):
        return []
    has_structured_activity = bool(render_activity_lines(response)) and isinstance(
        getattr(response, "turn", None),
        TurnRecord,
    )
    lines: list[str] = []
    for update in raw_updates:
        if not isinstance(update, str) or not update:
            continue
        if has_structured_activity and not update.startswith("[decision]"):
            continue
        lines.append(f"[progress] {update}")
    return lines


def _render_turn_activity_lines(turn: TurnRecord) -> list[str]:
    lines: list[str] = []
    reasoning_label: str | None = None
    reasoning_fragments: list[str] = []
    for item in turn.items:
        if item.type == TurnItemType.REASONING:
            label, body = _split_reasoning_item(item.text)
            if label is None or not body:
                continue
            if reasoning_fragments and reasoning_label != label:
                _flush_reasoning_activity(lines, reasoning_label, reasoning_fragments)
                reasoning_fragments = []
            reasoning_label = label
            reasoning_fragments.append(body)
            continue

        if item.type not in {
            TurnItemType.TOOL_EXPOSURE,
            TurnItemType.TOOL_CALL,
            TurnItemType.TOOL_RESULT,
            TurnItemType.APPROVAL_REQUEST,
            TurnItemType.APPROVAL_RESOLUTION,
            TurnItemType.WARNING,
        }:
            continue
        _flush_reasoning_activity(lines, reasoning_label, reasoning_fragments)
        reasoning_label = None
        reasoning_fragments = []
        if item.text:
            _append_unique_activity_line(lines, f"[activity] {item.text}")

    _flush_reasoning_activity(lines, reasoning_label, reasoning_fragments)
    return lines


def _flush_reasoning_activity(
    lines: list[str],
    label: str | None,
    fragments: list[str],
) -> None:
    if label is None or not fragments:
        return
    merged = _join_reasoning_fragments(fragments)
    if not merged:
        return
    if _is_noisy_reasoning_activity(label, merged):
        return
    semantic = _semanticize_reasoning_activity(label, merged)
    if semantic is not None:
        _append_unique_activity_line(lines, f"[activity] {semantic}")
        return
    summarized = _summarize_reasoning_text(merged)
    if not summarized:
        return
    _append_unique_activity_line(lines, f"[activity] {label}: {summarized}")


def _append_unique_activity_line(lines: list[str], line: str) -> None:
    if line in lines:
        return
    if line.startswith("[activity] 正在查看 ") and any(
        existing in {
            "[activity] 正在检查仓库结构",
            "[activity] 正在定位入口与主要模块",
            "[activity] 正在读取源码确认架构事实",
            "[activity] 已从确认的证据收口回答",
        }
        for existing in lines
    ):
        return
    lines.append(line)


def _split_reasoning_item(text: str | None) -> tuple[str | None, str]:
    if not isinstance(text, str):
        return None, ""
    stripped = text.strip()
    if not stripped:
        return None, ""
    for prefix in ("Thinking:", "Planning:"):
        if stripped.startswith(prefix):
            return prefix[:-1], stripped[len(prefix) :].strip()
    return "Thinking", stripped


def _join_reasoning_fragments(fragments: list[str]) -> str:
    merged = ""
    for fragment in fragments:
        piece = _normalize_whitespace(fragment)
        if not piece:
            continue
        if not merged:
            merged = piece
            continue
        if piece[0] in ",.!?;:)]}%":
            merged += piece
            continue
        if _is_cjk_character(merged[-1]) and _is_cjk_character(piece[0]):
            merged += piece
            continue
        merged += f" {piece}"
    return merged


def _summarize_reasoning_text(text: str, max_length: int = 140) -> str:
    normalized = _normalize_whitespace(text)
    if len(normalized) <= max_length:
        return normalized
    sentences = [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?。！？])\s+", normalized)
        if sentence.strip()
    ]
    candidate = ""
    for sentence in sentences:
        proposed = sentence if not candidate else f"{candidate} {sentence}"
        if len(proposed) > max_length:
            break
        candidate = proposed
        if len(candidate) >= 48:
            break
    if candidate:
        return candidate
    return f"{normalized[: max_length - 1].rstrip()}…"


def _semanticize_reasoning_activity(label: str | None, text: str) -> str | None:
    normalized = _normalize_whitespace(text)
    if not normalized:
        return None
    if normalized.startswith("已从确认的证据收口回答"):
        return "已从确认的证据收口回答"
    if normalized in {
        "正在检查仓库结构",
        "正在定位入口与主要模块",
        "正在读取源码确认架构事实",
        "已从确认的证据收口回答",
    }:
        return normalized
    lowered = normalized.lower()
    lowered = lowered.removeprefix("thinking: ").removeprefix("planning: ")

    if any(
        phrase in lowered
        for phrase in (
            "the user wants",
            "user wants me to",
            "user asked",
            "the user needs",
            "task is to",
        )
    ):
        return "正在理解任务目标"

    if label == "Planning" and "summar" in lowered:
        return "正在整理结论"

    if any(
        phrase in lowered
        for phrase in (
            "i have enough information",
            "output the summary",
            "summary now",
            "construct the response",
            "provide a brief summary",
            "provide a short summary",
            "organize the answer",
        )
    ):
        return "正在整理结论"

    targets = _extract_reasoning_targets(normalized)
    if targets and any(
        phrase in lowered
        for phrase in (
            "look at",
            "check",
            "inspect",
            "explore",
            "read",
            "list",
            "view",
        )
    ):
        rendered_targets = "、".join(f"`{target}`" for target in targets)
        return f"正在查看 {rendered_targets}"

    if any(
        phrase in lowered
        for phrase in (
            "workspace structure",
            "repository structure",
            "directory structure",
            "main structure",
            "project structure",
            "architecture pattern",
        )
    ):
        return "正在分析仓库结构"

    return None


def _is_noisy_reasoning_activity(label: str | None, text: str) -> bool:
    normalized = _normalize_whitespace(text)
    if not normalized:
        return True
    lowered = normalized.lower()

    prompt_echo_markers = (
        "active skill",
        "available tools",
        "current plan",
        "runtime reminders",
        "conversation summary",
        "recent conversation",
        "current user request",
        "do not emit json",
        "input_text",
        "tool_call",
        "tool_result",
        "plan: none",
    )
    if any(marker in lowered for marker in prompt_echo_markers):
        return True

    if label == "Planning" and any(
        marker in lowered
        for marker in (
            "update_plan",
            "/plans/",
            "_text",
        )
    ):
        return True

    stripped = normalized.strip()
    if len(stripped) <= 24 and any(char in stripped for char in ("`", "_", "/", '"')):
        alpha_count = sum(char.isalpha() for char in stripped)
        if alpha_count <= max(8, len(stripped) // 2):
            return True

    return False


def _extract_reasoning_targets(text: str) -> list[str]:
    targets: list[str] = []
    checks = (
        (r"\bpy\s*project\.toml\b|\bpyproject\.toml\b", "pyproject.toml"),
        (r"\breadme(?:\.md)?\b", "README.md"),
        (r"\bsrc/mycli\b", "src/mycli/"),
        (r"`?\bsrc/`?|\bsrc(?: directory| tree| structure)\b", "src/"),
    )
    for pattern, target in checks:
        if re.search(pattern, text, flags=re.IGNORECASE) and target not in targets:
            targets.append(target)
    return targets


def _normalize_whitespace(text: str) -> str:
    return " ".join(text.split())


def _is_cjk_character(value: str) -> bool:
    codepoint = ord(value)
    return (
        0x4E00 <= codepoint <= 0x9FFF
        or 0x3400 <= codepoint <= 0x4DBF
        or 0x3040 <= codepoint <= 0x30FF
        or 0xAC00 <= codepoint <= 0xD7AF
    )


def render_error_lines(response: object) -> list[str]:
    raw_details = getattr(response, "error_details", ())
    if not isinstance(raw_details, tuple):
        return []
    lines: list[str] = []
    for detail in raw_details:
        if isinstance(detail, str) and detail:
            lines.append(f"[error] {detail}")
    return lines


def render_stream_lines(response: object) -> list[str]:
    assistant_message = getattr(response, "assistant_message", None)
    if isinstance(assistant_message, str) and assistant_message:
        return []
    raw_chunks = getattr(response, "streamed_chunks", ())
    if not isinstance(raw_chunks, tuple):
        return []
    lines: list[str] = []
    for chunk in raw_chunks:
        if isinstance(chunk, str) and chunk:
            lines.append(f"[stream] {chunk}")
    return lines


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
) -> int:
    args = vars(build_parser().parse_args(argv))
    eval_exit_code = handle_evaluation_command(args, cwd=cwd, home=home, env=env)
    if eval_exit_code is not None:
        return eval_exit_code
    service = build_turn_service(args, cwd=cwd, home=home, env=env)

    def handle_user_message(raw: str) -> list[str]:
        response = service.handle_user_turn(raw)
        rendered: list[str] = render_activity_lines(response)
        rendered.extend(render_stream_lines(response))
        rendered.extend(render_error_lines(response))
        rendered.extend(render_progress_lines(response))
        rendered.extend(f"[plan] {step}" for step in response.plan_steps)
        if response.pending_decision is not None:
            rendered.extend(render_pending_decision(response.pending_decision))
        rendered.append(response.assistant_message)
        return rendered

    def resolve_pending_decision(choice: str) -> list[str]:
        response = service.resolve_pending_decision(choice)
        return [
            *render_activity_lines(response),
            *render_stream_lines(response),
            *render_error_lines(response),
            *response.progress_updates,
            response.assistant_message,
        ]

    run_repl(
        handle_user_message,
        session_id=service._config.session_id,
        decision_handler=resolve_pending_decision,
        pending_decision_provider=lambda: (
            service._session_service.load_pending_decision(service._config.session_id) is not None
        ),
        command_handler=build_command_handler(service),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
