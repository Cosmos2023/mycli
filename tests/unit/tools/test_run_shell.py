from pathlib import Path
import threading
import time

from mycli.domain.runtime import (
    RiskLevel,
    RuntimeInterruptToken,
    ShellBackendProfile,
    ShellEnvironmentPolicy,
    ShellExecutionOptions,
    ShellKind,
    ShellProfile,
)
from mycli.domain.runtime.task_notifications import TaskNotification
from mycli.domain.tools import ToolCall
from mycli.services.safety_policy import SafetyPolicy
from mycli.tools.bash import BashTool, ShellTool, derive_command_pattern, execute_bash
from mycli.tools.shell_backend import LocalShellBackend, ShellBackendRequest
from tests.support.shell_commands import python_shell_command
import sys


def test_execute_bash_forwards_configured_shell_path(tmp_path: Path) -> None:
    captured: list[ShellBackendRequest] = []

    class CapturingBackend:
        @property
        def profile(self) -> ShellBackendProfile:
            return ShellBackendProfile()

        def execute(self, request: ShellBackendRequest) -> dict[str, object]:
            captured.append(request)
            return {"success": True, "status": "completed", "output": "ok"}

    execute_bash(
        "printf ok",
        workdir=str(tmp_path),
        shell_path="/configured/bash",
        backend=CapturingBackend(),
    )

    assert captured[0].shell_path == "/configured/bash"


def test_execute_bash_forwards_legacy_background_to_backend(tmp_path: Path) -> None:
    captured: list[ShellBackendRequest] = []

    class CapturingBackend:
        @property
        def profile(self) -> ShellBackendProfile:
            return ShellBackendProfile()

        def execute(self, request: ShellBackendRequest) -> dict[str, object]:
            captured.append(request)
            return {"success": True, "status": "running", "output": ""}

    execute_bash(
        "sleep 30",
        workdir=str(tmp_path),
        run_in_background=True,
        backend=CapturingBackend(),
    )

    assert captured[0].legacy_background is True


def test_execute_bash_reports_explicit_shell_profile(tmp_path: Path) -> None:
    profile = ShellProfile(ShellKind.BASH, Path("/bin/bash"))

    result = execute_bash(
        "printf ok",
        workdir=str(tmp_path),
        shell_profile=profile,
    )

    assert result["shell_kind"] == "bash"
    assert result["shell_edition"] is None
    assert "shell_path" not in result


def test_shell_tool_executes_structured_args(tmp_path: Path) -> None:
    tool = BashTool(workspace_root=tmp_path)

    result = tool.run(
        ToolCall(
            name="Bash",
            arguments={"args": [sys.executable, "-c", "print('ok')"]},
            reason="check shell wiring",
        )
    )

    assert result.success is True
    assert result.raw_payload["output"].strip() == "ok"
    assert result.raw_payload["exit_code"] == 0
    assert result.raw_payload["stdout"].strip() == "ok"
    assert result.raw_payload["stderr"] == ""
    assert result.raw_payload["timed_out"] is False
    assert isinstance(result.raw_payload["duration_ms"], int)
    assert result.raw_payload["command_pattern"].startswith(sys.executable)


def test_shell_tool_executes_with_workspace_cwd(tmp_path: Path) -> None:
    nested = tmp_path / "nested"
    nested.mkdir()
    tool = BashTool(workspace_root=tmp_path)

    result = tool.execute({"command": "pwd", "cwd": "nested"})

    assert result.success is True
    assert result.raw_payload["cwd"] == str(nested.resolve())
    assert str(nested.resolve()) in result.raw_payload["output"]


def test_shell_schema_exposes_codex_style_parameters() -> None:
    parameters = {parameter.name: parameter for parameter in ShellTool.spec.parameters}

    assert set(parameters) == {
        "command",
        "cwd",
        "tty",
        "yield_time_ms",
        "max_output_tokens",
    }
    assert parameters["cwd"].required is False
    assert parameters["cwd"].description is not None
    assert "working directory" in parameters["cwd"].description.lower()
    for spec in (ShellTool.spec, BashTool.spec):
        assert "always set the `cwd`" in spec.description.lower()
        assert "do not use `cd` unless absolutely necessary" in spec.description.lower()


def test_bash_schema_retains_legacy_background_parameters() -> None:
    parameters = {parameter.name for parameter in BashTool.spec.parameters}

    assert "run_in_background" in parameters
    assert "timeout" in parameters


def test_legacy_background_false_waits_for_completion(tmp_path: Path) -> None:
    tool = BashTool(tmp_path)

    result = tool.execute({"command": "printf done", "run_in_background": False})

    assert result.raw_payload["terminal_state"] == "completed"
    assert result.raw_payload["output"] == "done"


def test_shell_tool_background_writes_output_file_and_notifies(tmp_path: Path) -> None:
    notifications: list[TaskNotification] = []
    tool = BashTool(workspace_root=tmp_path)
    tool.configure_background_tasks(
        output_dir=tmp_path / ".mycli" / "sessions" / "demo" / "tasks",
        notification_sink=notifications.append,
    )

    result = tool.execute(
        {
            "command": python_shell_command("print('background-ready', flush=True)"),
            "run_in_background": True,
        }
    )

    assert result.success is True
    output_file = Path(str(result.raw_payload["output_file"]))
    assert result.raw_payload["task_id"] == f"shell:{result.raw_payload['shell_id']}"
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and not notifications:
        time.sleep(0.01)

    assert output_file.exists()
    assert "background-ready" in output_file.read_text(encoding="utf-8")
    assert len(notifications) == 1
    notification = notifications[0]
    assert notification.task_id == result.raw_payload["task_id"]
    assert notification.output_file == output_file
    assert notification.status == "completed"
    assert "<task-notification>" in notification.to_xml()
    assert f"<output-file>{output_file}</output-file>" in notification.to_xml()


def test_shell_tool_applies_runtime_enforcement_timeout_cap(
    monkeypatch,
    tmp_path: Path,
) -> None:
    tool = BashTool(workspace_root=tmp_path)
    seen: dict[str, object] = {}

    def fake_execute_bash(
        command: str,
        timeout: int = 120,
        workdir: str | None = None,
        run_in_background: bool = False,
        env: dict[str, str] | None = None,
        command_pattern: str | None = None,
        **kwargs: object,
    ) -> dict[str, object]:
        del kwargs
        seen.update(
            {
                "command": command,
                "timeout": timeout,
                "workdir": workdir,
                "run_in_background": run_in_background,
                "env": env,
                "command_pattern": command_pattern,
            }
        )
        return {"exit_code": 0, "output": "ok", "truncated": False}

    monkeypatch.setattr("mycli.tools.bash.execute_bash", fake_execute_bash)

    result = tool.execute(
        {
            "command": "python3 -c 'print(1)'",
            "timeout": 999,
            "_runtime_shell_options": ShellExecutionOptions(
                workspace_root=tmp_path,
                max_timeout_seconds=5,
            ),
        }
    )

    assert result.success is True
    assert seen["timeout"] == 5
    assert str(seen["command_pattern"]).startswith("python3 -c")
    assert result.raw_payload["runtime_enforcement"]["timeout_seconds"] == 5
    assert result.raw_payload["runtime_enforcement"]["timeout_capped"] is True
    assert result.raw_payload["runtime_enforcement"]["env_policy"] == "sanitized"


def test_shell_tool_executes_through_backend_contract(tmp_path: Path) -> None:
    class FakeBackend(LocalShellBackend):
        def __init__(self) -> None:
            self.requests: list[ShellBackendRequest] = []

        def execute(self, request: ShellBackendRequest) -> dict[str, object]:
            self.requests.append(request)
            return {
                "exit_code": 0,
                "output": "ok",
                "truncated": False,
                "process_state": "completed",
            }

    backend = FakeBackend()
    tool = BashTool(workspace_root=tmp_path, shell_backend=backend)

    result = tool.execute({"command": "python3 -c 'print(1)'"})

    assert result.success is True
    assert backend.requests
    request = backend.requests[0]
    assert request.command == "python3 -c 'print(1)'"
    assert request.cwd == str(tmp_path)
    assert request.command_pattern is not None
    assert request.tty is False
    assert request.yield_time_ms == 10_000
    assert request.max_output_tokens == 10_000
    assert request.legacy_background is False
    backend_payload = result.raw_payload["runtime_enforcement"]["backend"]
    assert backend_payload["backend"] == "local"
    assert backend_payload["isolation"] == "host_subprocess"


def test_shell_tool_maps_new_session_controls_to_backend(tmp_path: Path) -> None:
    class FakeBackend(LocalShellBackend):
        def __init__(self) -> None:
            self.requests: list[ShellBackendRequest] = []

        def execute(self, request: ShellBackendRequest) -> dict[str, object]:
            self.requests.append(request)
            return {
                "status": "running",
                "output": "",
                "process_state": "running_background",
            }

    backend = FakeBackend()
    tool = ShellTool(workspace_root=tmp_path, shell_backend=backend)

    result = tool.execute(
        {
            "command": "python3 worker.py",
            "tty": True,
            "yield_time_ms": 500,
            "max_output_tokens": 321,
        }
    )

    assert result.success is True
    request = backend.requests[0]
    assert request.legacy_background is None
    assert request.tty is True
    assert request.yield_time_ms == 500
    assert request.max_output_tokens == 321


def test_shell_tool_passes_runtime_interrupt_token_to_backend(tmp_path: Path) -> None:
    token = RuntimeInterruptToken(source="test")

    class FakeBackend(LocalShellBackend):
        def __init__(self) -> None:
            self.requests: list[ShellBackendRequest] = []

        def execute(self, request: ShellBackendRequest) -> dict[str, object]:
            self.requests.append(request)
            return {
                "exit_code": 0,
                "output": "ok",
                "truncated": False,
                "process_state": "completed",
            }

    backend = FakeBackend()
    tool = BashTool(workspace_root=tmp_path, shell_backend=backend)

    result = tool.execute(
        {
            "command": "python3 -c 'print(1)'",
            "_runtime_interrupt_token": token,
        }
    )

    assert result.success is True
    assert backend.requests[0].interrupt_token is token


def test_shell_tool_applies_sanitized_runtime_environment(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("MYCLI_SECRET_SHOULD_NOT_LEAK", "secret-value")
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("PWD", "/outside-workspace")
    tool = BashTool(workspace_root=tmp_path)
    seen: dict[str, object] = {}

    def fake_execute_bash(
        command: str,
        timeout: int = 120,
        workdir: str | None = None,
        run_in_background: bool = False,
        env: dict[str, str] | None = None,
        command_pattern: str | None = None,
        **kwargs: object,
    ) -> dict[str, object]:
        del command, timeout, workdir, run_in_background, command_pattern, kwargs
        seen["env"] = dict(env or {})
        return {"exit_code": 0, "output": "ok", "truncated": False}

    monkeypatch.setattr("mycli.tools.bash.execute_bash", fake_execute_bash)

    result = tool.execute(
        {
            "command": "python3 -c 'print(1)'",
            "_runtime_shell_options": ShellExecutionOptions(workspace_root=tmp_path),
        }
    )

    env = seen["env"]
    assert isinstance(env, dict)
    assert env["PATH"].endswith("/usr/bin")
    assert env["PWD"] == str(tmp_path)
    assert "MYCLI_SECRET_SHOULD_NOT_LEAK" not in env
    assert result.raw_payload["runtime_enforcement"]["env_keys"] == sorted(env)
    assert "secret-value" not in str(result.raw_payload["runtime_enforcement"])


def test_shell_tool_applies_explicit_shell_environment_policy(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("CUSTOM_VALUE", "visible")
    monkeypatch.setenv("API_TOKEN", "secret-value")
    tool = BashTool(workspace_root=tmp_path)
    seen: dict[str, object] = {}

    def fake_execute_bash(
        command: str,
        timeout: int = 120,
        workdir: str | None = None,
        run_in_background: bool = False,
        env: dict[str, str] | None = None,
        command_pattern: str | None = None,
        **kwargs: object,
    ) -> dict[str, object]:
        del command, timeout, workdir, run_in_background, command_pattern, kwargs
        seen["env"] = dict(env or {})
        return {"exit_code": 0, "output": "ok", "truncated": False}

    monkeypatch.setattr("mycli.tools.bash.execute_bash", fake_execute_bash)

    result = tool.execute(
        {
            "command": "python3 -c 'print(1)'",
            "_runtime_shell_options": ShellExecutionOptions(
                workspace_root=tmp_path,
                shell_environment_policy=ShellEnvironmentPolicy(
                    inherit="all",
                    ignore_default_excludes=False,
                    exclude=("CUSTOM_*",),
                    set={"CI": "false"},
                ),
            ),
        }
    )

    env = seen["env"]
    assert isinstance(env, dict)
    assert env["CI"] == "false"
    assert "CUSTOM_VALUE" not in env
    assert "API_TOKEN" not in env
    assert result.raw_payload["runtime_enforcement"]["shell_environment_policy"][
        "inherit"
    ] == "all"


def test_shell_tool_rejects_cwd_outside_workspace(tmp_path: Path) -> None:
    tool = BashTool(workspace_root=tmp_path)

    result = tool.execute({"command": "pwd", "cwd": "../outside"})

    assert result.success is False
    assert result.raw_payload["error_kind"] == "workspace_escape"


def test_execute_bash_reports_nonzero_exit() -> None:
    result = execute_bash(
        python_shell_command("import sys; sys.stderr.write('bad'); sys.exit(7)")
    )

    assert result["exit_code"] == 7
    assert result["error_kind"] == "nonzero_exit"
    assert result["stderr"] == "bad"
    assert "[stderr]" in result["output"]
    assert result["timed_out"] is False


def test_execute_bash_reports_timeout() -> None:
    result = execute_bash(
        python_shell_command("import time; time.sleep(1)"),
        timeout=0,
    )

    assert result["exit_code"] == 143
    assert result["error_kind"] == "timeout"
    assert result["timed_out"] is True
    assert result["timeout_seconds"] == 0


def test_execute_bash_interrupt_token_stops_foreground_process() -> None:
    token = RuntimeInterruptToken(source="test")
    result_holder: dict[str, object] = {}
    started = threading.Event()

    def run_command() -> None:
        started.set()
        result_holder["result"] = execute_bash(
            python_shell_command("import time; time.sleep(30)"),
            timeout=30,
            interrupt_token=token,
        )

    thread = threading.Thread(target=run_command)
    thread.start()
    assert started.wait(timeout=1.0)
    time.sleep(0.1)
    token.request("test_interrupt")
    thread.join(timeout=3.0)

    assert not thread.is_alive()
    result = result_holder["result"]
    assert isinstance(result, dict)
    assert result["interrupted"] is True
    assert result["error_kind"] == "interrupted"
    assert result["process_state"] == "interrupted"
    assert result["exit_code"] == 130


def test_execute_bash_retains_output_below_session_limit() -> None:
    result = execute_bash(python_shell_command("print('x' * 20000)"))

    assert result["truncated"] is False
    assert result["output_chars"] > 10_000
    assert result["stdout_chars"] > 10_000
    assert result["stdout_truncated"] is False
    assert result["stderr_truncated"] is False
    assert result["truncated_chars"] == 0


def test_shell_tool_returns_error_when_args_are_missing(tmp_path: Path) -> None:
    tool = BashTool(workspace_root=tmp_path)

    result = tool.run(
        ToolCall(
            name="Bash",
            arguments={},
            reason="broken tool call",
        )
    )

    assert result.success is False
    assert "command" in result.error


def test_shell_tool_returns_failure_when_command_is_missing(tmp_path: Path) -> None:
    tool = BashTool(workspace_root=tmp_path)

    result = tool.run(
        ToolCall(
            name="Bash",
            arguments={"args": ["command-that-does-not-exist-xyz", "--version"]},
            reason="check shell wiring",
        )
    )

    assert result.success is False
    assert result.error is not None
    assert "not found" in result.error or "No such file or directory" in result.error


def test_safety_policy_marks_shell_high_risk() -> None:
    risk = SafetyPolicy().classify(
        ToolCall(name="Bash", arguments={"command": "python3 -V"}, reason="inspect")
    )
    assert risk is RiskLevel.HIGH


def test_safety_policy_marks_file_editing_tools_medium_risk() -> None:
    policy = SafetyPolicy()

    assert policy.classify(
        ToolCall(name="Edit", arguments={"path": "README.md"}, reason="edit")
    ) is RiskLevel.MEDIUM
    assert policy.classify(
        ToolCall(
            name="Write",
            arguments={"path": "README.md", "content": "x"},
            reason="write",
        )
    ) is RiskLevel.MEDIUM


def test_derive_command_pattern_fallbacks_to_first_three_args() -> None:
    assert derive_command_pattern(["docker", "compose", "up", "-d"]) == "docker compose up"

def test_bash_tool_refuses_dedicated_read_command(tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text("hello\n", encoding="utf-8")
    tool = BashTool(workspace_root=tmp_path)

    result = tool.execute({"command": "cat README.md"})

    assert result.success is False
    assert result.raw_payload["error_kind"] == "dedicated_tool_required"
    assert result.raw_payload["reroute_tool"] == "Read"
    assert "Use Read instead" in result.error


def test_bash_tool_reroute_includes_actionable_read_arguments(tmp_path: Path) -> None:
    tool = BashTool(workspace_root=tmp_path)

    result = tool.execute({"command": "head -100 data.csv"})

    assert result.success is False
    assert result.raw_payload["error_kind"] == "dedicated_tool_required"
    assert result.raw_payload["reroute_tool"] == "Read"
    assert result.raw_payload["suggested_arguments"] == {
        "file_path": "data.csv",
        "offset": 1,
        "limit": 100,
    }
    assert "file_path=data.csv" in result.error
    assert "limit=100" in result.error


def test_bash_tool_allows_read_only_discovery_commands(monkeypatch, tmp_path: Path) -> None:
    tool = BashTool(workspace_root=tmp_path)
    seen: list[str] = []

    def fake_execute_bash(
        command: str,
        timeout: int = 120,
        workdir: str | None = None,
        run_in_background: bool = False,
        env: dict[str, str] | None = None,
        command_pattern: str | None = None,
        **kwargs: object,
    ) -> dict[str, object]:
        del timeout, workdir, run_in_background, env, command_pattern, kwargs
        seen.append(command)
        return {"exit_code": 0, "output": "ok", "truncated": False}

    monkeypatch.setattr("mycli.tools.bash.execute_bash", fake_execute_bash)

    for command in ("rg -n query .", "grep -R query .", "ls -la", "find . -maxdepth 1 -type f"):
        result = tool.execute({"command": command})

        assert result.success is True
        assert result.raw_payload.get("error_kind") != "dedicated_tool_required"

    assert seen == ["rg -n query .", "grep -R query .", "ls -la", "find . -maxdepth 1 -type f"]


def test_bash_tool_refuses_denied_command(tmp_path: Path) -> None:
    tool = BashTool(workspace_root=tmp_path)

    result = tool.execute({"command": "rm -rf /"})

    assert result.success is False
    assert result.raw_payload["error_kind"] == "shell_command_denied"
    assert result.error == "rm -rf / is forbidden"


def test_bash_tool_does_not_reroute_confirm_level_command(monkeypatch, tmp_path: Path) -> None:
    tool = BashTool(workspace_root=tmp_path)

    def fake_execute_bash(
        command: str,
        timeout: int = 120,
        workdir: str | None = None,
        run_in_background: bool = False,
        env: dict[str, str] | None = None,
        command_pattern: str | None = None,
        **kwargs: object,
    ) -> dict[str, object]:
        del command, timeout, workdir, run_in_background, env, command_pattern, kwargs
        return {"exit_code": 7, "output": "simulated", "truncated": False}

    monkeypatch.setattr("mycli.tools.bash.execute_bash", fake_execute_bash)

    result = tool.execute({"command": "cat README.md && echo done"})

    assert result.raw_payload.get("error_kind") != "dedicated_tool_required"
    assert result.error == "simulated"
