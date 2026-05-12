from __future__ import annotations

import os
from pathlib import Path
import re
import shlex
import subprocess
from typing import Any
from uuid import uuid4

from mycli.domain.tooling.calls import ToolCall, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec


OUTPUT_CHAR_LIMIT = 10_000
OUTPUT_HEAD_CHARS = 6_000
OUTPUT_TAIL_CHARS = 4_000

DANGEROUS_PATTERNS = [
    (r"rm\s+-rf\s+/", "rm -rf / is forbidden"),
    (
        r"git\s+push\s+.*--force.*(main|master)",
        "Force push to main/master requires confirmation",
    ),
    (r"curl.*\|.*(bash|sh|zsh)", "curl pipe to shell requires confirmation"),
    (r"wget.*\|.*(bash|sh|zsh)", "wget pipe to shell requires confirmation"),
    (r"chmod\s+777", "chmod 777 requires confirmation"),
    (r"sudo\s+", "sudo requires confirmation"),
    (r"git\s+reset\s+--hard", "git reset --hard requires confirmation"),
]

FORBIDDEN_IN_BASH = {
    "cat": "Read",
    "head": "Read",
    "tail": "Read",
    "grep": "Grep",
    "rg": "Grep",
    "ls": "LS",
    "find": "Glob",
    "sed": "Edit",
}

_background_processes: dict[str, subprocess.Popen[str]] = {}


def check_dangerous(command: str) -> tuple[bool, str]:
    for pattern, reason in DANGEROUS_PATTERNS:
        if re.search(pattern, command):
            return True, reason
    return False, ""


def derive_command_pattern(args: list[str]) -> str:
    if args[:3] == ["git", "reset", "--hard"]:
        return "git reset --hard"
    if args[:2] == ["git", "push"]:
        return "git push"
    if args[:2] == ["rm", "-rf"]:
        return "rm -rf"
    if len(args) >= 3 and args[0] == "python" and args[1].endswith(".py"):
        return " ".join(args[:3])
    return " ".join(args[: min(3, len(args))])


def check_forbidden(command: str) -> str | None:
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None

    if tokens and tokens[0] in FORBIDDEN_IN_BASH:
        return FORBIDDEN_IN_BASH[tokens[0]]
    return None


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

    def execute(self, arguments: dict[str, Any]) -> ToolResultV2:
        command_value = arguments.get("command")
        if command_value is None and isinstance(arguments.get("args"), list):
            parts = [part for part in arguments["args"] if isinstance(part, str)]
            command_value = shlex.join(parts)
        if not isinstance(command_value, str) or not command_value:
            return ToolResultV2(
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
        return ToolResultV2(
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
        return self.execute(call.arguments).to_legacy()
