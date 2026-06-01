from __future__ import annotations

from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolEffectProfile, ToolParameter, ToolResult, ToolSpec
from mycli.tools.shell_registry import SHELL_REGISTRY


class BashOutputTool:
    name = "BashOutput"
    spec = ToolSpec(
        name="BashOutput",
        description="Read incremental output and status for a background Bash process.",
        parameters=(ToolParameter(name="shell_id", type="string", required=True),),
        risk_level="low",
    )

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(process=True)

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        shell_id = str(arguments.get("shell_id") or arguments.get("bash_id") or "")
        if not shell_id:
            return ToolResult(
                success=False,
                summary="Failed to read shell output",
                error="BashOutput requires shell_id.",
                raw_payload={"error_kind": "missing_shell_id"},
            )
        payload = SHELL_REGISTRY.read(shell_id)
        success = "error" not in payload
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
