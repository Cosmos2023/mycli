from mycli.tools.bash import _background_processes, execute_bash
from mycli.tools.kill_shell import KillShellTool, kill_shell


class TestKillShell:
    def test_kill_existing_process(self):
        result = execute_bash("sleep 60", run_in_background=True)
        bash_id = result["bash_id"]
        assert bash_id in _background_processes

        kill_result = kill_shell(bash_id)

        assert kill_result["status"] == "killed"
        assert bash_id not in _background_processes

    def test_kill_nonexistent(self):
        result = kill_shell("nosuchid")

        assert "error" in result
        assert result["error_kind"] == "shell_not_found"

    def test_kill_tool_reports_missing_shell_id(self):
        result = KillShellTool().execute({})

        assert result.success is False
        assert result.raw_payload["error_kind"] == "missing_shell_id"

    def test_kill_tool_reports_missing_shell(self):
        result = KillShellTool().execute({"shell_id": "nosuchid"})

        assert result.success is False
        assert result.raw_payload["error_kind"] == "shell_not_found"
