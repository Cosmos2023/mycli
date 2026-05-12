from __future__ import annotations

import os
import re
import shlex
import subprocess
from typing import Any
from uuid import uuid4


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
