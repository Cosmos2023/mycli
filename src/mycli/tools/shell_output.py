from __future__ import annotations

from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolEffectProfile, ToolParameter, ToolResult, ToolSpec
from mycli.tools.model_output import shell_model_output
from mycli.tools.shell_registry import LEGACY_SHELL_OWNER, SHELL_REGISTRY


class ShellOutputTool:
    name = "ShellOutput"
    spec = ToolSpec(
        name=name,
        description="Read incremental output and status for a background Shell process.",
        parameters=(ToolParameter(name="shell_id", type="string", required=True),),
        risk_level="low",
        model_output_adapter=shell_model_output,
    )

    def __init__(self, *, session_id: str = LEGACY_SHELL_OWNER) -> None:
        self._session_id = session_id

    def configure_shell_session(self, session_id: str) -> None:
        self._session_id = session_id

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(process=True)

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        shell_id = str(arguments.get("shell_id") or arguments.get("bash_id") or "")
        if not shell_id:
            return ToolResult(
                success=False,
                summary="Failed to read shell output",
                error=f"{self.name} requires shell_id.",
                raw_payload={"error_kind": "missing_shell_id"},
            )
        payload = SHELL_REGISTRY.read(shell_id, owner_session_id=self._session_id)
        success = "error" not in payload
        if not success:
            payload.setdefault("error_kind", "shell_not_found")
        return ToolResult(
            success=success,
            summary=(
                f"Read shell {shell_id} output"
                if success
                else f"Failed to read shell {shell_id}"
            ),
            error=str(payload["error"]) if "error" in payload else None,
            raw_payload=payload,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


__all__ = ["ShellOutputTool"]
