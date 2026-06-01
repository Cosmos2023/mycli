from __future__ import annotations

import os
from pathlib import Path
import shlex
import subprocess
from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolEffectProfile, ToolParameter, ToolResult, ToolSpec
from mycli.tools.shell_safety import (
    ShellRiskLevel,
    analyze_shell_command,
    dedicated_tool_for_command,
    derive_command_pattern as _derive_command_pattern,
)
from mycli.tools.shell_registry import SHELL_REGISTRY


OUTPUT_CHAR_LIMIT = 10_000
OUTPUT_HEAD_CHARS = 6_000
OUTPUT_TAIL_CHARS = 4_000

_background_processes = SHELL_REGISTRY.processes()


def check_dangerous(command: str) -> tuple[bool, str]:
    analysis = analyze_shell_command(command)
    if analysis.risk_level in {ShellRiskLevel.CONFIRM, ShellRiskLevel.DENY}:
        return True, analysis.reason
    return False, ""


def derive_command_pattern(args: list[str]) -> str:
    return _derive_command_pattern(args, " ".join(args))


def check_forbidden(command: str) -> str | None:
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None

    return dedicated_tool_for_command(tokens)


def execute_bash(
    command: str,
    timeout: int = 120,
    workdir: str | None = None,
    run_in_background: bool = False,
) -> dict[str, Any]:
    if run_in_background:
        return _run_background(command, timeout, workdir)

    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=workdir or os.getcwd(),
            executable=os.environ.get("SHELL", "/bin/bash"),
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {
            "exit_code": 143,
            "output": f"[Command timed out after {timeout}s]",
            "truncated": False,
        }

    output = _combine_output(result.stdout, result.stderr)
    output, truncated = _truncate_output(output)

    return {"exit_code": result.returncode, "output": output, "truncated": truncated}


def _run_background(
    command: str,
    timeout: int,
    workdir: str | None,
) -> dict[str, Any]:
    shell = SHELL_REGISTRY.start(command, workdir=workdir)
    _background_processes.clear()
    _background_processes.update(SHELL_REGISTRY.processes())
    return {
        "bash_id": shell.shell_id,
        "shell_id": shell.shell_id,
        "status": "running",
        "timeout": timeout,
    }


def _combine_output(stdout: str, stderr: str) -> str:
    if stderr:
        return f"[stderr]\n{stderr}\n[stdout]\n{stdout}"
    return stdout


def _truncate_output(output: str) -> tuple[str, bool]:
    if len(output) <= OUTPUT_CHAR_LIMIT:
        return output, False

    omitted = len(output) - OUTPUT_CHAR_LIMIT
    truncated_output = (
        f"{output[:OUTPUT_HEAD_CHARS]}\n"
        f"... [... chars omitted] ({omitted} chars) ...\n"
        f"{output[-OUTPUT_TAIL_CHARS:]}\n"
        "[Full output saved. Use Read to view the persisted file.]"
    )
    return truncated_output, True


class BashTool:
    name = "Bash"
    spec = ToolSpec(
        name="Bash",
        description="Execute a shell command when dedicated tools cannot handle the task. Supports timeout and background execution.",
        parameters=(
            ToolParameter(name="command", type="string", required=True),
            ToolParameter(
                name="args",
                type="array",
                required=False,
                items_schema={"type": "string"},
            ),
            ToolParameter(name="timeout", type="integer", required=False),
            ToolParameter(name="run_in_background", type="boolean", required=False),
        ),
        risk_level="high",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(filesystem="unknown", process=True)

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        command_value = arguments.get("command")
        if command_value is None and isinstance(arguments.get("args"), list):
            parts = [part for part in arguments["args"] if isinstance(part, str)]
            command_value = shlex.join(parts)
        if not isinstance(command_value, str) or not command_value:
            return ToolResult(
                success=False,
                summary="Invalid shell command",
                error="Bash requires command.",
            )
        analysis = analyze_shell_command(command_value)
        if analysis.risk_level is ShellRiskLevel.DENY:
            return ToolResult(
                success=False,
                summary="Shell command denied",
                error=analysis.reason,
                raw_payload={
                    "command": command_value,
                    "error_kind": "shell_command_denied",
                    "command_pattern": analysis.command_pattern,
                },
            )
        if analysis.risk_level is ShellRiskLevel.ALLOW and analysis.reroute_tool is not None:
            suggested_arguments = _suggested_tool_arguments(command_value)
            message = _reroute_message(
                tool_name=analysis.reroute_tool,
                suggested_arguments=suggested_arguments,
            )
            raw_payload: dict[str, object] = {
                "command": command_value,
                "error_kind": "dedicated_tool_required",
                "reroute_tool": analysis.reroute_tool,
                "reroute_reason": message,
            }
            if suggested_arguments:
                raw_payload["suggested_arguments"] = suggested_arguments
            return ToolResult(
                success=False,
                summary=f"Use {analysis.reroute_tool} instead of Bash",
                error=message,
                raw_payload=raw_payload,
            )
        payload = execute_bash(
            command_value,
            timeout=int(arguments.get("timeout", 120)),
            workdir=str(self._workspace_root),
            run_in_background=bool(arguments.get("run_in_background", False)),
        )
        if "output" in payload:
            payload.setdefault("stdout", payload["output"])
            payload.setdefault("stderr", "")
        exit_code = payload.get("exit_code")
        success = exit_code == 0 or payload.get("status") == "running"
        return ToolResult(
            success=success,
            summary=(
                f"Command exited with {exit_code}"
                if "exit_code" in payload
                else f"Command {payload.get('status', 'started')}"
            ),
            raw_payload={"command": command_value, **payload},
            error=None if success else str(payload.get("output", "")),
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


def _suggested_tool_arguments(command: str) -> dict[str, object]:
    try:
        args = shlex.split(command)
    except ValueError:
        return {}
    if not args:
        return {}
    command_name = args[0]
    if command_name == "cat":
        file_path = _first_path_argument(args[1:])
        return {"file_path": file_path} if file_path else {}
    if command_name == "head":
        return _suggest_head_arguments(args[1:])
    if command_name == "tail":
        return _suggest_tail_arguments(args[1:])
    if command_name == "ls":
        path = _first_path_argument(args[1:])
        return {"path": path or "."}
    if command_name in {"grep", "rg"}:
        return _suggest_search_arguments(args[1:])
    if command_name == "find":
        return _suggest_glob_arguments(args[1:])
    return {}


def _suggest_head_arguments(args: list[str]) -> dict[str, object]:
    limit = 10
    remaining: list[str] = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in {"-n", "--lines"} and index + 1 < len(args):
            parsed = _parse_positive_int(args[index + 1])
            if parsed is not None:
                limit = parsed
            index += 2
            continue
        if arg.startswith("-") and arg[1:].isdigit():
            limit = int(arg[1:])
            index += 1
            continue
        if arg.startswith("--lines="):
            parsed = _parse_positive_int(arg.partition("=")[2])
            if parsed is not None:
                limit = parsed
            index += 1
            continue
        remaining.append(arg)
        index += 1
    file_path = _first_path_argument(remaining)
    if not file_path:
        return {}
    return {"file_path": file_path, "offset": 1, "limit": limit}


def _suggest_tail_arguments(args: list[str]) -> dict[str, object]:
    lines = 10
    remaining: list[str] = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in {"-n", "--lines"} and index + 1 < len(args):
            parsed = _parse_positive_int(args[index + 1].lstrip("+"))
            if parsed is not None:
                lines = parsed
            index += 2
            continue
        if arg.startswith("-") and arg[1:].isdigit():
            lines = int(arg[1:])
            index += 1
            continue
        if arg.startswith("--lines="):
            parsed = _parse_positive_int(arg.partition("=")[2].lstrip("+"))
            if parsed is not None:
                lines = parsed
            index += 1
            continue
        remaining.append(arg)
        index += 1
    file_path = _first_path_argument(remaining)
    if not file_path:
        return {}
    return {
        "file_path": file_path,
        "note": f"Read supports offset/limit; use LS/Grep or a prior line count to choose the last {lines} lines.",
    }


def _suggest_search_arguments(args: list[str]) -> dict[str, object]:
    positional = [arg for arg in args if not arg.startswith("-")]
    if not positional:
        return {}
    suggested: dict[str, object] = {"query": positional[0]}
    if len(positional) >= 2:
        suggested["path"] = positional[1]
    return suggested


def _suggest_glob_arguments(args: list[str]) -> dict[str, object]:
    path = "."
    pattern = "*"
    positional = [arg for arg in args if not arg.startswith("-")]
    if positional:
        path = positional[0]
    for index, arg in enumerate(args):
        if arg == "-name" and index + 1 < len(args):
            pattern = args[index + 1]
            break
    return {"path": path, "pattern": pattern}


def _first_path_argument(args: list[str]) -> str | None:
    for arg in args:
        if arg == "--":
            continue
        if arg.startswith("-"):
            continue
        return arg
    return None


def _parse_positive_int(value: str) -> int | None:
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if parsed > 0 else None


def _reroute_message(
    *,
    tool_name: str,
    suggested_arguments: dict[str, object],
) -> str:
    if not suggested_arguments:
        return f"Use {tool_name} instead of Bash."
    args_preview = " ".join(
        f"{key}={value}" for key, value in suggested_arguments.items()
    )
    return f"Use {tool_name} instead of Bash with {args_preview}."
