from __future__ import annotations

from typing import Any, Protocol

from mycli.domain.subagents import SubAgentResult
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import SchemaTool, ToolParameter, ToolResult, ToolSpec


class SupportsSubAgentService(Protocol):
    def run_task(
        self,
        *,
        description: str,
        agent_type: str,
        allowed_tools: tuple[str, ...],
        mode: str = "sync",
    ) -> SubAgentResult:
        ...


class TaskTool(SchemaTool):
    spec = ToolSpec(
        name="Task",
        description="Run a bounded child sub-agent for a specific task.",
        parameters=(
            ToolParameter("description", "string", True, "Specific child task."),
            ToolParameter("agent_type", "string", True, "One of: explore, review, executor."),
            ToolParameter(
                "allowed_tools",
                "array",
                True,
                "Candidate tool names the parent allows the child to use.",
                items_schema={"type": "string"},
            ),
            ToolParameter(
                "mode",
                "string",
                False,
                "Task execution mode: sync or background.",
            ),
        ),
        risk_level="medium",
    )

    def __init__(self, service: SupportsSubAgentService | None = None) -> None:
        self._service = service

    @property
    def name(self) -> str:
        return self.spec.name

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        if self._service is None:
            return ToolResult(
                success=False,
                summary="Task tool is unavailable until runtime binding completes.",
                error="Task tool is not bound to a SubAgentService.",
                raw_payload={"error_kind": "task_tool_unbound"},
            )
        description = str(arguments["description"])
        agent_type = str(arguments["agent_type"])
        allowed_tools = tuple(str(tool) for tool in arguments.get("allowed_tools", ()))
        mode = str(arguments.get("mode", "sync"))
        result = self._service.run_task(
            description=description,
            agent_type=agent_type,
            allowed_tools=allowed_tools,
            mode=mode,
        )
        return ToolResult(
            success=result.status == "completed",
            summary=f"Sub-agent {agent_type} completed with status {result.status}.",
            error=result.error,
            raw_payload={
                "kind": "sub_agent_report",
                "status": result.status,
                "child_session_id": result.child_session_id,
                "tool_calls": result.tool_calls,
                "report": result.report,
                "content": result.report,
            },
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


__all__ = ["TaskTool"]
