from __future__ import annotations

from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolEffectProfile, ToolParameter, ToolResult, ToolSpec
from mycli.tools.bash import _background_processes
from mycli.tools.shell_registry import SHELL_REGISTRY


def kill_shell(shell_id: str) -> dict[str, Any]:
    payload = SHELL_REGISTRY.kill(shell_id)
    _background_processes.clear()
    _background_processes.update(SHELL_REGISTRY.processes())
    return payload


class KillShellTool:
    name = "KillShell"
    spec = ToolSpec(
        name="KillShell",
        description="Terminate a background Bash process by shell_id.",
        parameters=(ToolParameter(name="shell_id", type="string", required=True),),
        risk_level="medium",
    )

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(process=True)

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        shell_id = str(arguments.get("shell_id") or arguments.get("bash_id") or "")
        if not shell_id:
            return ToolResult(
                success=False,
                summary="Failed to kill shell",
                error="KillShell requires shell_id.",
                raw_payload={"error_kind": "missing_shell_id"},
            )
        payload = kill_shell(shell_id)
        success = "error" not in payload
        if not success:
            payload.setdefault("error_kind", "shell_not_found")
        return ToolResult(
            success=success,
            summary=f"Killed shell {shell_id}" if success else f"Failed to kill shell {shell_id}",
            error=str(payload["error"]) if "error" in payload else None,
            raw_payload=payload,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)
