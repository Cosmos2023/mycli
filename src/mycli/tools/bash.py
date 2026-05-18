from __future__ import annotations

import os
from pathlib import Path
import shlex
import subprocess
from typing import Any
from uuid import uuid4

from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec
from mycli.tools.shell_safety import (
    ShellRiskLevel,
    analyze_shell_command,
    dedicated_tool_for_command,
    derive_command_pattern as _derive_command_pattern,
)


OUTPUT_CHAR_LIMIT = 10_000
OUTPUT_HEAD_CHARS = 6_000
OUTPUT_TAIL_CHARS = 4_000

_background_processes: dict[str, subprocess.Popen[str]] = {}


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
    proc = subprocess.Popen(
        command,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        cwd=workdir or os.getcwd(),
        executable=os.environ.get("SHELL", "/bin/bash"),
    )
    bash_id = str(uuid4())[:8]
    _background_processes[bash_id] = proc
    return {"bash_id": bash_id, "status": "running", "timeout": timeout}


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
