from __future__ import annotations

import os
from pathlib import Path
import signal
import shlex
import subprocess
import time
from typing import Any, Callable

from mycli.domain.runtime import RuntimeInterruptToken, ShellExecutionOptions
from mycli.domain.runtime.task_notifications import TaskNotification
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolEffectProfile, ToolParameter, ToolResult, ToolSpec
from mycli.tools.path_utils import classify_filesystem_error, resolve_workspace_path
from mycli.tools.shell_environment import create_shell_environment
from mycli.tools.shell_safety import (
    ShellRiskLevel,
    analyze_shell_command,
    dedicated_tool_for_command,
    derive_command_pattern as _derive_command_pattern,
)
from mycli.tools.shell_backend import LocalShellBackend, ShellBackend, ShellBackendRequest
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


class ShellCommandRuntime:
    """Coordinates local shell command execution and background shell registration."""

    def execute(
        self,
        command: str,
        timeout: int = 120,
        workdir: str | None = None,
        run_in_background: bool = False,
        env: dict[str, str] | None = None,
        command_pattern: str | None = None,
        output_file: Path | None = None,
        notification_sink: Callable[[TaskNotification], None] | None = None,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> dict[str, Any]:
        effective_cwd = workdir or os.getcwd()
        started = time.monotonic()
        if run_in_background:
            background_payload = _run_background(
                command,
                timeout,
                effective_cwd,
                env=env,
                command_pattern=command_pattern,
                output_file=output_file,
                notification_sink=notification_sink,
            )
            background_payload["cwd"] = effective_cwd
            background_payload["duration_ms"] = _duration_ms(started)
            return background_payload

        if interrupt_token is not None:
            return _run_foreground_interruptible(
                command,
                timeout,
                effective_cwd,
                started=started,
                env=env,
                interrupt_token=interrupt_token,
            )

        return _run_foreground(
            command,
            timeout,
            effective_cwd,
            started=started,
            env=env,
        )


DEFAULT_SHELL_COMMAND_RUNTIME = ShellCommandRuntime()


def execute_bash(
    command: str,
    timeout: int = 120,
    workdir: str | None = None,
    run_in_background: bool = False,
    env: dict[str, str] | None = None,
    command_pattern: str | None = None,
    output_file: Path | None = None,
    notification_sink: Callable[[TaskNotification], None] | None = None,
    interrupt_token: RuntimeInterruptToken | None = None,
) -> dict[str, Any]:
    return DEFAULT_SHELL_COMMAND_RUNTIME.execute(
        command,
        timeout=timeout,
        workdir=workdir,
        run_in_background=run_in_background,
        env=env,
        command_pattern=command_pattern,
        output_file=output_file,
        notification_sink=notification_sink,
        interrupt_token=interrupt_token,
    )


def _run_foreground(
    command: str,
    timeout: int,
    cwd: str,
    *,
    started: float,
    env: dict[str, str] | None,
) -> dict[str, Any]:
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
            executable=os.environ.get("SHELL", "/bin/bash"),
            env=env,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        stdout = _coerce_timeout_output(exc.stdout)
        stderr = _coerce_timeout_output(exc.stderr)
        output = _combine_output(stdout, stderr)
        if not output:
            output = f"[Command timed out after {timeout}s]"
        output, output_meta = _truncate_output(output)
        stdout, stdout_meta = _truncate_output(stdout)
        stderr, stderr_meta = _truncate_output(stderr)
        return {
            "exit_code": 143,
            "stdout": stdout,
            "stderr": stderr,
            "output": output,
            "timed_out": True,
            "truncated": output_meta["truncated"],
            "duration_ms": _duration_ms(started),
            "cwd": cwd,
            "error_kind": "timeout",
            "process_state": "timed_out",
            "cleanup_result": "subprocess_timeout_expired",
            "timeout_seconds": timeout,
            "output_chars": output_meta["original_chars"],
            "stdout_chars": stdout_meta["original_chars"],
            "stderr_chars": stderr_meta["original_chars"],
            "stdout_truncated": stdout_meta["truncated"],
            "stderr_truncated": stderr_meta["truncated"],
            "truncated_chars": output_meta["truncated_chars"],
        }

    output = _combine_output(result.stdout, result.stderr)
    output, output_meta = _truncate_output(output)
    stdout, stdout_meta = _truncate_output(result.stdout)
    stderr, stderr_meta = _truncate_output(result.stderr)
    payload: dict[str, Any] = {
        "exit_code": result.returncode,
        "stdout": stdout,
        "stderr": stderr,
        "output": output,
        "timed_out": False,
        "process_state": "completed",
        "truncated": output_meta["truncated"],
        "duration_ms": _duration_ms(started),
        "cwd": cwd,
        "output_chars": output_meta["original_chars"],
        "stdout_chars": stdout_meta["original_chars"],
        "stderr_chars": stderr_meta["original_chars"],
        "stdout_truncated": stdout_meta["truncated"],
        "stderr_truncated": stderr_meta["truncated"],
        "truncated_chars": output_meta["truncated_chars"],
    }
    if result.returncode != 0:
        payload["error_kind"] = "nonzero_exit"
    return payload


def _run_foreground_interruptible(
    command: str,
    timeout: int,
    cwd: str,
    *,
    started: float,
    env: dict[str, str] | None,
    interrupt_token: RuntimeInterruptToken,
) -> dict[str, Any]:
    process = subprocess.Popen(
        command,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=cwd,
        executable=os.environ.get("SHELL", "/bin/bash"),
        env=env,
        start_new_session=os.name == "posix",
    )
    timed_out = False
    interrupted = False
    deadline = started + max(0, timeout)
    stdout = ""
    stderr = ""
    while True:
        if interrupt_token.interrupted:
            interrupted = True
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            timed_out = True
            break
        try:
            stdout, stderr = process.communicate(timeout=min(0.05, remaining))
            break
        except subprocess.TimeoutExpired:
            continue

    cleanup_result = "not_needed"
    if interrupted or timed_out:
        cleanup_result = _terminate_process_group(process, prefer_interrupt=interrupted)
        stdout, stderr = process.communicate()
    if interrupted:
        return _foreground_interrupted_payload(
            stdout=stdout,
            stderr=stderr,
            started=started,
            cwd=cwd,
            cleanup_result=cleanup_result,
            reason=interrupt_token.reason,
        )
    if timed_out:
        output = _combine_output(stdout, stderr)
        if not output:
            output = f"[Command timed out after {timeout}s]"
        output, output_meta = _truncate_output(output)
        stdout, stdout_meta = _truncate_output(stdout)
        stderr, stderr_meta = _truncate_output(stderr)
        return {
            "exit_code": 143,
            "stdout": stdout,
            "stderr": stderr,
            "output": output,
            "timed_out": True,
            "truncated": output_meta["truncated"],
            "duration_ms": _duration_ms(started),
            "cwd": cwd,
            "error_kind": "timeout",
            "process_state": "timed_out",
            "cleanup_result": cleanup_result,
            "timeout_seconds": timeout,
            "output_chars": output_meta["original_chars"],
            "stdout_chars": stdout_meta["original_chars"],
            "stderr_chars": stderr_meta["original_chars"],
            "stdout_truncated": stdout_meta["truncated"],
            "stderr_truncated": stderr_meta["truncated"],
            "truncated_chars": output_meta["truncated_chars"],
        }

    return _foreground_completed_payload(
        returncode=process.returncode,
        stdout=stdout,
        stderr=stderr,
        started=started,
        cwd=cwd,
    )


def _terminate_process_group(
    process: subprocess.Popen[str],
    *,
    prefer_interrupt: bool,
) -> str:
    signals = (
        (signal.SIGINT, "sent_sigint"),
        (signal.SIGTERM, "sent_sigterm"),
        (signal.SIGKILL, "sent_sigkill"),
    )
    if not prefer_interrupt:
        signals = signals[1:]
    cleanup_result = "already_exited"
    for sig, label in signals:
        if process.poll() is not None:
            return cleanup_result
        try:
            if os.name == "posix":
                os.killpg(process.pid, sig)
            else:
                process.send_signal(sig)
            cleanup_result = label
        except ProcessLookupError:
            return cleanup_result
        except PermissionError:
            cleanup_result = f"{label}_permission_denied"
            continue
        try:
            process.wait(timeout=0.5)
            return cleanup_result
        except subprocess.TimeoutExpired:
            continue
    return cleanup_result


def _foreground_completed_payload(
    *,
    returncode: int | None,
    stdout: str,
    stderr: str,
    started: float,
    cwd: str,
) -> dict[str, Any]:
    output = _combine_output(stdout, stderr)
    output, output_meta = _truncate_output(output)
    stdout, stdout_meta = _truncate_output(stdout)
    stderr, stderr_meta = _truncate_output(stderr)
    payload: dict[str, Any] = {
        "exit_code": returncode,
        "stdout": stdout,
        "stderr": stderr,
        "output": output,
        "timed_out": False,
        "truncated": output_meta["truncated"],
        "duration_ms": _duration_ms(started),
        "cwd": cwd,
        "output_chars": output_meta["original_chars"],
        "stdout_chars": stdout_meta["original_chars"],
        "stderr_chars": stderr_meta["original_chars"],
        "stdout_truncated": stdout_meta["truncated"],
        "stderr_truncated": stderr_meta["truncated"],
        "truncated_chars": output_meta["truncated_chars"],
    }
    if returncode != 0:
        payload["error_kind"] = "nonzero_exit"
    return payload


def _foreground_interrupted_payload(
    *,
    stdout: str,
    stderr: str,
    started: float,
    cwd: str,
    cleanup_result: str,
    reason: str | None,
) -> dict[str, Any]:
    output = _combine_output(stdout, stderr)
    if not output:
        output = "[Command interrupted]"
    output, output_meta = _truncate_output(output)
    stdout, stdout_meta = _truncate_output(stdout)
    stderr, stderr_meta = _truncate_output(stderr)
    return {
        "exit_code": 130,
        "stdout": stdout,
        "stderr": stderr,
        "output": output,
        "timed_out": False,
        "interrupted": True,
        "truncated": output_meta["truncated"],
        "duration_ms": _duration_ms(started),
        "cwd": cwd,
        "error_kind": "interrupted",
        "process_state": "interrupted",
        "cleanup_result": cleanup_result,
        "interrupt_reason": reason,
        "output_chars": output_meta["original_chars"],
        "stdout_chars": stdout_meta["original_chars"],
        "stderr_chars": stderr_meta["original_chars"],
        "stdout_truncated": stdout_meta["truncated"],
        "stderr_truncated": stderr_meta["truncated"],
        "truncated_chars": output_meta["truncated_chars"],
    }


def _run_background(
    command: str,
    timeout: int,
    workdir: str | None,
    env: dict[str, str] | None = None,
    command_pattern: str | None = None,
    output_file: Path | None = None,
    notification_sink: Callable[[TaskNotification], None] | None = None,
) -> dict[str, Any]:
    shell = SHELL_REGISTRY.start(
        command,
        workdir=workdir,
        env=env,
        timeout_seconds=timeout,
        command_pattern=command_pattern,
        output_file=output_file,
        notification_sink=notification_sink,
    )
    _background_processes.clear()
    _background_processes.update(SHELL_REGISTRY.processes())
    return {
        "bash_id": shell.shell_id,
        "shell_id": shell.shell_id,
        "status": "running",
        "process_state": "running_background",
        "started_at": shell.started_at,
        "last_observed_at": shell.last_observed_at,
        "timeout": timeout,
        "timeout_seconds": timeout,
        "command_hash": shell.command_hash,
        "command_length": shell.command_length,
        "command_pattern": shell.command_pattern,
        "output_chars": 0,
        "task_id": f"shell:{shell.shell_id}",
        "output_file": str(shell.output_file) if shell.output_file else None,
    }


def _combine_output(stdout: str, stderr: str) -> str:
    if stderr:
        return f"[stderr]\n{stderr}\n[stdout]\n{stdout}"
    return stdout


def _truncate_output(output: str) -> tuple[str, dict[str, int | bool]]:
    original_chars = len(output)
    if len(output) <= OUTPUT_CHAR_LIMIT:
        return output, {
            "truncated": False,
            "original_chars": original_chars,
            "truncated_chars": 0,
        }

    omitted = len(output) - OUTPUT_CHAR_LIMIT
    truncated_output = (
        f"{output[:OUTPUT_HEAD_CHARS]}\n"
        f"... [... chars omitted] ({omitted} chars) ...\n"
        f"{output[-OUTPUT_TAIL_CHARS:]}\n"
        "[Full output saved. Use Read to view the persisted file.]"
    )
    return truncated_output, {
        "truncated": True,
        "original_chars": original_chars,
        "truncated_chars": omitted,
    }


def _duration_ms(started: float) -> int:
    return max(0, int((time.monotonic() - started) * 1000))


def _coerce_timeout_output(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


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
            ToolParameter(name="cwd", type="string", required=False),
            ToolParameter(name="run_in_background", type="boolean", required=False),
        ),
        risk_level="high",
    )

    def __init__(self, workspace_root: Path, shell_backend: ShellBackend | None = None) -> None:
        self._workspace_root = workspace_root
        self._shell_backend = shell_backend or LocalShellBackend()
        self._background_output_dir: Path | None = None
        self._notification_sink: Callable[[TaskNotification], None] | None = None

    def configure_background_tasks(
        self,
        *,
        output_dir: Path,
        notification_sink: Callable[[TaskNotification], None],
    ) -> None:
        self._background_output_dir = output_dir
        self._notification_sink = notification_sink

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
                raw_payload={
                    **raw_payload,
                    "command_pattern": analysis.command_pattern,
                },
            )
        cwd_result = self._resolve_cwd(arguments.get("cwd"))
        if isinstance(cwd_result, ToolResult):
            return cwd_result
        shell_options = _shell_execution_options(arguments.get("_runtime_shell_options"))
        timeout_value = arguments.get("timeout", 120)
        timeout, timeout_capped = shell_options.effective_timeout(timeout_value)
        env = _shell_env(shell_options)
        background_output_file = (
            self._next_background_output_file()
            if bool(arguments.get("run_in_background", False))
            else None
        )
        payload = self._shell_backend.execute(
            ShellBackendRequest(
                command=command_value,
                timeout_seconds=timeout,
                cwd=str(cwd_result),
                run_in_background=bool(arguments.get("run_in_background", False)),
                env=env,
                command_pattern=analysis.command_pattern,
                output_file=background_output_file,
                notification_sink=(
                    self._notification_sink if background_output_file is not None else None
                ),
                interrupt_token=arguments.get("_runtime_interrupt_token")
                if isinstance(
                    arguments.get("_runtime_interrupt_token"),
                    RuntimeInterruptToken,
                )
                else None,
            )
        )
        payload.setdefault("command_pattern", analysis.command_pattern)
        runtime_enforcement = shell_options.to_trace_payload(
            timeout_seconds=timeout,
            timeout_capped=timeout_capped,
            env_keys=tuple(sorted(env)),
            cwd=cwd_result,
        )
        runtime_enforcement["backend"] = self._shell_backend.profile.to_trace_payload()
        payload["runtime_enforcement"] = runtime_enforcement
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

    def _next_background_output_file(self) -> Path | None:
        if self._background_output_dir is None:
            return None
        return self._background_output_dir / f"shell-{time.time_ns()}" / "output.txt"

    def _resolve_cwd(self, raw_cwd: object) -> Path | ToolResult:
        if raw_cwd is None or raw_cwd == "":
            return self._workspace_root.resolve()
        if not isinstance(raw_cwd, str):
            return ToolResult(
                success=False,
                summary="Invalid shell cwd",
                error="Bash cwd must be a string path within the workspace.",
                raw_payload={"error_kind": "invalid_cwd"},
            )
        try:
            cwd = resolve_workspace_path(self._workspace_root, raw_cwd)
            if not cwd.is_dir():
                return ToolResult(
                    success=False,
                    summary="Invalid shell cwd",
                    error=f"Bash cwd is not a directory: {raw_cwd}",
                    raw_payload={
                        "cwd": raw_cwd,
                        "error_kind": "not_directory",
                    },
                )
        except Exception as exc:
            return ToolResult(
                success=False,
                summary="Invalid shell cwd",
                error=str(exc),
                raw_payload={
                    "cwd": raw_cwd,
                    "error_kind": classify_filesystem_error(exc),
                },
            )
        return cwd


def _shell_execution_options(value: object) -> ShellExecutionOptions:
    if isinstance(value, ShellExecutionOptions):
        return value
    return ShellExecutionOptions(workspace_root=Path.cwd())


def _shell_env(options: ShellExecutionOptions) -> dict[str, str]:
    return create_shell_environment(options.resolved_shell_environment_policy())


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
        "note": f"Read supports offset/limit; use LS or Bash `rg`/line-count commands to choose the last {lines} lines.",
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
