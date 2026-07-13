import time

from mycli.tools.bash import BashTool, execute_bash
from mycli.tools.bash_output import BashOutputTool
from mycli.tools.kill_shell import KillShellTool, kill_shell
from tests.support.shell_commands import python_shell_command


def test_bash_output_reads_background_output_incrementally(tmp_path):
    result = execute_bash(
        python_shell_command("import time; print('ready', flush=True); time.sleep(2)"),
        workdir=str(tmp_path),
        run_in_background=True,
    )
    shell_id = str(result["shell_id"])

    output_tool = BashOutputTool()
    output = output_tool.execute({"shell_id": shell_id})

    assert output.success is True
    assert output.raw_payload["shell_id"] == shell_id
    assert "ready" in str(output.raw_payload["output"])
    assert output.raw_payload["status"] in {"running", "exited"}
    assert output.raw_payload["process_state"] in {
        "running_background",
        "completed",
        "failed",
    }
    assert isinstance(output.raw_payload["output_chars"], int)
    assert "command" not in output.raw_payload

    kill_shell(shell_id)


def test_bash_output_reports_missing_shell() -> None:
    output = BashOutputTool().execute({"shell_id": "missing"})

    assert output.success is False
    assert output.raw_payload["error_kind"] == "shell_not_found"


def test_bash_output_reports_missing_shell_id_argument() -> None:
    output = BashOutputTool().execute({})

    assert output.success is False
    assert output.raw_payload["error_kind"] == "missing_shell_id"


def test_bash_output_rejects_shell_owned_by_another_session(tmp_path) -> None:
    bash = BashTool(tmp_path)
    bash.configure_shell_session("session-a")
    started = bash.execute({"command": "sleep 30", "run_in_background": True})
    shell_id = str(started.raw_payload["shell_id"])

    try:
        output = BashOutputTool(session_id="session-b").execute({"shell_id": shell_id})

        assert output.success is False
        assert output.raw_payload["error_kind"] == "shell_session_forbidden"
    finally:
        KillShellTool(session_id="session-a").execute({"shell_id": shell_id})


def test_background_timeout_is_enforced_without_initial_poll(tmp_path) -> None:
    result = execute_bash(
        python_shell_command("import time; time.sleep(30)"),
        timeout=0,
        workdir=str(tmp_path),
        run_in_background=True,
    )
    shell_id = str(result["shell_id"])

    time.sleep(0.1)
    output = BashOutputTool().execute({"shell_id": shell_id})

    assert output.raw_payload["terminal_state"] == "timed_out"
    assert output.raw_payload["process_state"] == "timed_out"
