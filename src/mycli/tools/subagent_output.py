from __future__ import annotations

from typing import Any, Protocol

from mycli.domain.subagents import SubAgentOutput
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolEffectProfile, ToolParameter, ToolResult, ToolSpec


class SupportsSubAgentOutputService(Protocol):
    def read_output(self, child_session_id: str) -> SubAgentOutput:
        ...


class SubagentOutputTool:
    name = "SubagentOutput"
    spec = ToolSpec(
        name="SubagentOutput",
        description=(
            "Read status, final report, and recent transcript lines for a background "
            "sub-agent by child_session_id for a user-requested manual progress "
            "check. Do not proactively poll running background sub-agents; completion "
            "is delivered automatically via <task-notification>."
        ),
        parameters=(
            ToolParameter(name="child_session_id", type="string", required=True),
        ),
        risk_level="low",
    )

    def __init__(self, service: SupportsSubAgentOutputService | None = None) -> None:
        self._service = service

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(filesystem="none")

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        child_session_id = str(arguments.get("child_session_id") or "").strip()
        if not child_session_id:
            return ToolResult(
                success=False,
                summary="Failed to read sub-agent output",
                error="SubagentOutput requires child_session_id.",
                raw_payload={
                    "kind": "sub_agent_output",
                    "error_kind": "missing_child_session_id",
                },
            )
        if self._service is None:
            return ToolResult(
                success=False,
                summary="SubagentOutput is unavailable until runtime binding completes.",
                error="SubagentOutput is not bound to a SubAgentService.",
                raw_payload={
                    "kind": "sub_agent_output",
                    "child_session_id": child_session_id,
                    "error_kind": "subagent_output_unbound",
                },
            )
        output = self._service.read_output(child_session_id)
        return ToolResult(
            success=output.status != "missing",
            summary=f"Sub-agent {output.status}.",
            error=output.error,
            raw_payload={
                "kind": "sub_agent_output",
                "child_session_id": output.child_session_id,
                "status": output.status,
                "tool_calls": output.tool_calls,
                "report": output.report,
                "error": output.error,
                "transcript": list(output.transcript_lines),
            },
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


__all__ = ["SubagentOutputTool"]
