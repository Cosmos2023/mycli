from __future__ import annotations

import os
from dataclasses import replace
from pathlib import Path
import shlex
import time
from typing import Any, Callable

from mycli.domain.runtime import (
    RuntimeInterruptToken,
    ShellExecutionOptions,
    ShellProfile,
    ShellLifecycleEvent,
)
from mycli.domain.runtime.task_notifications import TaskNotification
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolEffectProfile, ToolParameter, ToolResult, ToolSpec
from mycli.tools.invocation_context import current_tool_owner_session_id
from mycli.tools.model_output import shell_model_output
from mycli.tools.path_utils import classify_filesystem_error, resolve_workspace_path
from mycli.tools.shell_environment import create_shell_environment
from mycli.tools.shell_safety import (
    ShellRiskLevel,
    analyze_shell_command,
    dedicated_tool_for_command,
    derive_command_pattern as _derive_command_pattern,
)
from mycli.tools.shell_backend import LocalShellBackend, ShellBackend, ShellBackendRequest
from mycli.tools.shell_registry import LEGACY_SHELL_OWNER, SHELL_REGISTRY
from mycli.tools.shell_resolver import detect_shell_profile
from mycli.tools.shell_safety_adapters import analyze_shell_for_profile


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

    def __init__(self, *, owner_session_id: str = LEGACY_SHELL_OWNER) -> None:
        self._owner_session_id = owner_session_id

    def configure_shell_session(self, session_id: str) -> None:
        self._owner_session_id = session_id

    def execute(
        self,
        command: str,
        timeout: int = 120,
        workdir: str | None = None,
        run_in_background: bool = False,
        shell_path: str | None = None,
        shell_profile: ShellProfile | None = None,
        env: dict[str, str] | None = None,
        command_pattern: str | None = None,
        output_file: Path | None = None,
        notification_sink: Callable[[TaskNotification], None] | None = None,
        call_id: str | None = None,
        lifecycle_sink: Callable[[ShellLifecycleEvent], None] | None = None,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> dict[str, Any]:
        effective_cwd = workdir or os.getcwd()
        owner_session_id = current_tool_owner_session_id(self._owner_session_id)
        started = time.monotonic()
        payload = SHELL_REGISTRY.execute(
            command,
            owner_session_id=owner_session_id,
            timeout_seconds=timeout,
            workdir=effective_cwd,
            background=run_in_background,
            shell_path=shell_path,
            shell_profile=shell_profile,
            env=env,
            command_pattern=command_pattern,
            output_file=output_file,
            notification_sink=notification_sink,
            call_id=call_id,
            lifecycle_sink=lifecycle_sink,
            interrupt_token=interrupt_token,
        )
        payload["cwd"] = effective_cwd
        payload["duration_ms"] = _duration_ms(started)
        if run_in_background:
            _background_processes.clear()
            _background_processes.update(SHELL_REGISTRY.processes())
            return payload
        if "error" in payload:
            return payload
        stdout = str(payload.get("stdout") or "")
        stderr = str(payload.get("stderr") or "")
        payload["output"] = _combine_output(stdout, stderr)
        terminal_state = payload.get("terminal_state")
        if terminal_state == "interrupted":
            payload.update(
                {
                    "exit_code": 130,
                    "interrupted": True,
                    "error_kind": "interrupted",
                }
            )
        elif terminal_state == "timed_out":
            payload.update({"exit_code": 143, "error_kind": "timeout"})
        elif payload.get("exit_code") != 0:
            payload["error_kind"] = "nonzero_exit"
        return payload

    def execute_new(
        self,
        command: str,
        timeout: int = 120,
        workdir: str | None = None,
        *,
        tty: bool = False,
        yield_time_ms: int = 10_000,
        max_output_tokens: int = 10_000,
        shell_path: str | None = None,
        shell_profile: ShellProfile | None = None,
        env: dict[str, str] | None = None,
        command_pattern: str | None = None,
        output_file: Path | None = None,
        notification_sink: Callable[[TaskNotification], None] | None = None,
        call_id: str | None = None,
        lifecycle_sink: Callable[[ShellLifecycleEvent], None] | None = None,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> dict[str, Any]:
        effective_cwd = workdir or os.getcwd()
        started = time.monotonic()
        payload = SHELL_REGISTRY.execute_new(
            command,
            owner_session_id=self._owner_session_id,
            timeout_seconds=timeout,
            workdir=effective_cwd,
            tty=tty,
            yield_time_ms=yield_time_ms,
            max_output_tokens=max_output_tokens,
            shell_path=shell_path,
            shell_profile=shell_profile,
            env=env,
            command_pattern=command_pattern,
            output_file=output_file,
            notification_sink=notification_sink,
            call_id=call_id,
            lifecycle_sink=lifecycle_sink,
            interrupt_token=interrupt_token,
        )
        payload["cwd"] = effective_cwd
        payload["duration_ms"] = _duration_ms(started)
        if payload.get("background") is True:
            _background_processes.clear()
            _background_processes.update(SHELL_REGISTRY.processes())
        if "error" in payload:
            return payload
        stdout = str(payload.get("stdout") or "")
        stderr = str(payload.get("stderr") or "")
        payload["output"] = _combine_output(stdout, stderr)
        terminal_state = payload.get("terminal_state")
        if terminal_state == "interrupted":
            payload.update(
                {
                    "exit_code": 130,
                    "interrupted": True,
                    "error_kind": "interrupted",
                }
            )
        elif terminal_state == "timed_out":
            payload.update({"exit_code": 143, "error_kind": "timeout"})
        elif terminal_state is not None and payload.get("exit_code") != 0:
            payload["error_kind"] = "nonzero_exit"
        return payload


DEFAULT_SHELL_COMMAND_RUNTIME = ShellCommandRuntime()


def execute_bash(
    command: str,
    timeout: int = 120,
    workdir: str | None = None,
    owner_session_id: str = LEGACY_SHELL_OWNER,
    run_in_background: bool = False,
    shell_path: str | None = None,
    shell_profile: ShellProfile | None = None,
    env: dict[str, str] | None = None,
    command_pattern: str | None = None,
    output_file: Path | None = None,
    notification_sink: Callable[[TaskNotification], None] | None = None,
    call_id: str | None = None,
    lifecycle_sink: Callable[[ShellLifecycleEvent], None] | None = None,
    interrupt_token: RuntimeInterruptToken | None = None,
    backend: ShellBackend | None = None,
) -> dict[str, Any]:
    effective_profile = shell_profile or detect_shell_profile(shell_path)
    if backend is not None:
        return backend.execute(
            ShellBackendRequest(
                command=command,
                timeout_seconds=timeout,
                cwd=workdir or os.getcwd(),
                owner_session_id=owner_session_id,
                run_in_background=run_in_background,
                legacy_background=run_in_background,
                shell_path=shell_path,
                shell_profile=effective_profile,
                env=env,
                command_pattern=command_pattern,
                output_file=output_file,
                notification_sink=notification_sink,
                call_id=call_id,
                lifecycle_sink=lifecycle_sink,
                interrupt_token=interrupt_token,
            )
        )
    runtime = (
        DEFAULT_SHELL_COMMAND_RUNTIME
        if owner_session_id == LEGACY_SHELL_OWNER
        else ShellCommandRuntime(owner_session_id=owner_session_id)
    )
    return runtime.execute(
        command,
        timeout=timeout,
        workdir=workdir,
        run_in_background=run_in_background,
        shell_path=shell_path,
        shell_profile=effective_profile,
        env=env,
        command_pattern=command_pattern,
        output_file=output_file,
        notification_sink=notification_sink,
        call_id=call_id,
        lifecycle_sink=lifecycle_sink,
        interrupt_token=interrupt_token,
    )


def _combine_output(stdout: str, stderr: str) -> str:
    if stderr:
        return f"[stderr]\n{stderr}\n[stdout]\n{stdout}"
    return stdout


def _duration_ms(started: float) -> int:
    return max(0, int((time.monotonic() - started) * 1000))


_LEGACY_SHELL_PARAMETERS = (
    ToolParameter(
        name="command",
        type="string",
        required=True,
        description="Shell command to execute in the active user shell.",
    ),
    ToolParameter(
        name="args",
        type="array",
        required=False,
        items_schema={"type": "string"},
    ),
    ToolParameter(name="timeout", type="integer", required=False),
    ToolParameter(
        name="cwd",
        type="string",
        required=False,
        description=(
            "Working directory for the command. Defaults to the workspace root."
        ),
    ),
    ToolParameter(name="run_in_background", type="boolean", required=False),
)

_CODEX_SHELL_PARAMETERS = (
    ToolParameter(
        name="command",
        type="string",
        required=True,
        description="Shell command to execute in the active user shell.",
    ),
    ToolParameter(
        name="cwd",
        type="string",
        required=False,
        description=(
            "Working directory for the command. Defaults to the workspace root."
        ),
    ),
    ToolParameter(name="tty", type="boolean", required=False),
    ToolParameter(name="yield_time_ms", type="integer", required=False),
    ToolParameter(name="max_output_tokens", type="integer", required=False),
    ToolParameter(
        name="prefix_rule",
        type="array",
        required=False,
        items_schema={"type": "string"},
        description=(
            "Optional narrow executable prefix proposed for persistent user approval. "
            "It is policy metadata and is never executed."
        ),
    ),
)


class _ShellToolBase:
    name: str
    spec: ToolSpec
    uses_yield_semantics = False

    def __init__(self, workspace_root: Path, shell_backend: ShellBackend | None = None) -> None:
        self._workspace_root = workspace_root
        self._shell_backend = shell_backend or LocalShellBackend()
        self._owner_session_id = LEGACY_SHELL_OWNER
        self._background_output_dir: Path | None = None
        self._notification_sink: Callable[[TaskNotification], None] | None = None
        self._lifecycle_sink: Callable[[ShellLifecycleEvent], None] | None = None
        self._shell_path: str | None = None
        self._shell_profile: ShellProfile | None = None

    def configure_background_tasks(
        self,
        *,
        output_dir: Path,
        notification_sink: Callable[[TaskNotification], None],
    ) -> None:
        self._background_output_dir = output_dir
        self._notification_sink = notification_sink

    def configure_shell_lifecycle(
        self,
        lifecycle_sink: Callable[[ShellLifecycleEvent], None],
    ) -> None:
        self._lifecycle_sink = lifecycle_sink

    def configure_shell_session(self, session_id: str) -> None:
        self._owner_session_id = session_id

    def configure_shell_path(self, shell_path: str | None) -> None:
        self._shell_path = shell_path

    def configure_shell_profile(self, shell_profile: ShellProfile) -> None:
        self._shell_profile = shell_profile

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(filesystem="unknown", process=True)

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        owner_session_id = current_tool_owner_session_id(self._owner_session_id)
        command_value = arguments.get("command")
        if command_value is None and isinstance(arguments.get("args"), list):
            parts = [part for part in arguments["args"] if isinstance(part, str)]
            command_value = shlex.join(parts)
        if not isinstance(command_value, str) or not command_value:
            return ToolResult(
                success=False,
                summary="Invalid shell command",
                error=f"{self.name} requires command.",
            )
        shell_options = _shell_execution_options(arguments.get("_runtime_shell_options"))
        if shell_options.shell_path is None and self._shell_path is not None:
            shell_options = replace(shell_options, shell_path=self._shell_path)
        if shell_options.shell_profile is None:
            shell_options = replace(
                shell_options,
                shell_profile=(
                    self._shell_profile
                    or detect_shell_profile(shell_options.shell_path)
                ),
            )
        assert shell_options.shell_profile is not None
        analysis = analyze_shell_for_profile(shell_options.shell_profile, command_value)
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
                summary=f"Use {analysis.reroute_tool} instead of {self.name}",
                error=message,
                raw_payload={
                    **raw_payload,
                    "command_pattern": analysis.command_pattern,
                },
            )
        cwd_result = self._resolve_cwd(arguments.get("cwd"))
        if isinstance(cwd_result, ToolResult):
            return cwd_result
        timeout_value = arguments.get("timeout", 120)
        timeout, timeout_capped = shell_options.effective_timeout(timeout_value)
        env = _shell_env(shell_options)
        legacy_background: bool | None
        tty = False
        yield_time_ms = 10_000
        max_output_tokens = 10_000
        if self.uses_yield_semantics:
            tty_value = arguments.get("tty", False)
            if not isinstance(tty_value, bool):
                return _invalid_shell_parameter("tty", "a boolean")
            tty = tty_value
            yield_value = arguments.get("yield_time_ms", 10_000)
            if not _is_positive_int(yield_value):
                return _invalid_shell_parameter(
                    "yield_time_ms",
                    "a positive integer",
                )
            yield_time_ms = min(30_000, max(250, yield_value))
            output_budget = arguments.get("max_output_tokens", 10_000)
            if not _is_positive_int(output_budget):
                return _invalid_shell_parameter(
                    "max_output_tokens",
                    "a positive integer",
                )
            max_output_tokens = output_budget
            legacy_background = None
            background_output_file = self._next_background_output_file()
            notification_sink = self._notification_sink
        else:
            legacy_background = bool(arguments.get("run_in_background", False))
            background_output_file = (
                self._next_background_output_file() if legacy_background else None
            )
            notification_sink = (
                self._notification_sink if background_output_file is not None else None
            )
        payload = self._shell_backend.execute(
            ShellBackendRequest(
                command=command_value,
                timeout_seconds=timeout,
                cwd=str(cwd_result),
                owner_session_id=owner_session_id,
                run_in_background=legacy_background is True,
                tty=tty,
                yield_time_ms=yield_time_ms,
                max_output_tokens=max_output_tokens,
                legacy_background=legacy_background,
                shell_path=shell_options.shell_path,
                shell_profile=shell_options.shell_profile,
                env=env,
                command_pattern=analysis.command_pattern,
                output_file=background_output_file,
                notification_sink=notification_sink,
                call_id=arguments.get("_runtime_tool_call_id")
                if isinstance(arguments.get("_runtime_tool_call_id"), str)
                else None,
                lifecycle_sink=self._lifecycle_sink,
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
                error=f"{self.name} cwd must be a string path within the workspace.",
                raw_payload={"error_kind": "invalid_cwd"},
            )
        try:
            cwd = resolve_workspace_path(self._workspace_root, raw_cwd)
            if not cwd.is_dir():
                return ToolResult(
                    success=False,
                    summary="Invalid shell cwd",
                    error=f"{self.name} cwd is not a directory: {raw_cwd}",
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


class ShellTool(_ShellToolBase):
    name = "Shell"
    uses_yield_semantics = True
    spec = ToolSpec(
        name=name,
        description=(
            "Execute a command in the active user shell when dedicated tools "
            "cannot handle the task. Waits briefly, then returns a resumable session "
            "when the command is still running. "
            "Always set the `cwd` parameter when using this tool. Do not use `cd` "
            "unless absolutely necessary."
        ),
        parameters=_CODEX_SHELL_PARAMETERS,
        risk_level="high",
        model_output_adapter=shell_model_output,
    )


class BashTool(_ShellToolBase):
    name = "Bash"
    spec = ToolSpec(
        name=name,
        description=(
            "Compatibility alias for the Shell tool. Always set the `cwd` parameter "
            "when using this tool. Do not use `cd` unless absolutely necessary."
        ),
        parameters=_LEGACY_SHELL_PARAMETERS,
        risk_level="high",
        model_output_adapter=shell_model_output,
    )


def _shell_execution_options(value: object) -> ShellExecutionOptions:
    if isinstance(value, ShellExecutionOptions):
        return value
    return ShellExecutionOptions(workspace_root=Path.cwd())


def _is_positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _invalid_shell_parameter(name: str, expected: str) -> ToolResult:
    return ToolResult(
        success=False,
        summary=f"Invalid Shell {name}",
        error=f"Shell {name} must be {expected}.",
        raw_payload={"error_kind": f"invalid_{name}"},
    )


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
