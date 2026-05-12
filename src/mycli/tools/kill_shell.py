from __future__ import annotations

import subprocess
from typing import Any

from mycli.domain.tooling.calls import ToolCall, ToolResult
from mycli.tools.bash import _background_processes
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec


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


class KillShellTool:
    name = "KillShell"
    spec = ToolSpec(
        name="KillShell",
        description="Terminate a background Bash process by shell_id.",
        parameters=(ToolParameter(name="shell_id", type="string", required=True),),
        risk_level="medium",
    )

    def execute(self, arguments: dict[str, Any]) -> ToolResultV2:
        shell_id = str(arguments.get("shell_id") or arguments.get("bash_id") or "")
        if not shell_id:
            return ToolResultV2(
                success=False,
                summary="Failed to kill shell",
                error="KillShell requires shell_id.",
            )
        payload = kill_shell(shell_id)
        success = "error" not in payload
        return ToolResultV2(
            success=success,
            summary=f"Killed shell {shell_id}" if success else f"Failed to kill shell {shell_id}",
            error=str(payload["error"]) if "error" in payload else None,
            raw_payload=payload,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
