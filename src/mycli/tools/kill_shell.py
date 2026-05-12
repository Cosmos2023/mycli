from __future__ import annotations

import subprocess
from typing import Any

from mycli.tools.bash import _background_processes


def kill_shell(shell_id: str) -> dict[str, Any]:
    proc = _background_processes.pop(shell_id, None)
    if proc is None:
        return {"error": f"No such shell: {shell_id}"}

    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()

    return {"status": "killed", "exit_code": proc.returncode, "shell_id": shell_id}
