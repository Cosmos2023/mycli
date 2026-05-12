from mycli.tools.bash import _background_processes, execute_bash
from mycli.tools.kill_shell import kill_shell


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
