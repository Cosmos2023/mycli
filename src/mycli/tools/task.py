from __future__ import annotations

from typing import Any, Protocol

from mycli.domain.subagents import SubAgentResult
from mycli.services.subagents.tool_result_payload import (
    subagent_tool_artifacts,
    subagent_tool_payload,
)
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


def _model_task_mode(value: object) -> str:
    mode = str(value).strip().lower() if value is not None else ""
    return "background" if mode in {"", "sync", "background"} else "background"


def _task_success(status: str) -> bool:
    return status in {"completed", "running"}


def _task_summary(agent_type: str, status: str) -> str:
    if status == "running":
        return f"Sub-agent {agent_type} started in background."
    return f"Sub-agent {agent_type} completed with status {status}."


class TaskTool(SchemaTool):
    spec = ToolSpec(
        name="Task",
        description=(
            "Delegate a bounded, self-contained task to a child sub-agent. Use this for "
            "independent investigation, review, or implementation slices that can run in "
            "parallel while the main agent continues. If several independent subtasks are "
            "needed, issue multiple Task calls in the same assistant turn. Background task "
            "completion is delivered automatically as a notification; do not poll for it."
        ),
        parameters=(
            ToolParameter(
                "description",
                "string",
                True,
                (
                    "Self-contained child task prompt. Include the goal, why it matters, "
                    "relevant files or facts already learned, constraints, exact questions "
                    "to answer, and the expected final report format."
                ),
            ),
            ToolParameter(
                "agent_type",
                "string",
                True,
                (
                    "Sub-agent profile id from /agents. Built-in examples include "
                    "explore, review, and executor; custom profiles can be defined locally."
                ),
            ),
            ToolParameter(
                "allowed_tools",
                "array",
                True,
                (
                    "Candidate tool names the parent allows the child to use. Keep this "
                    "minimal and aligned with the delegated task."
                ),
                items_schema={"type": "string"},
            ),
            ToolParameter(
                "mode",
                "string",
                False,
                (
                    "Task execution mode. Model-facing task calls run in background; the "
                    "parent is notified automatically on completion and should not poll "
                    "SubagentOutput unless the user explicitly asks to inspect a task."
                ),
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
        mode = _model_task_mode(arguments.get("mode"))
        result = self._service.run_task(
            description=description,
            agent_type=agent_type,
            allowed_tools=allowed_tools,
            mode=mode,
        )
        return ToolResult(
            success=_task_success(result.status),
            summary=_task_summary(agent_type, result.status),
            artifacts=subagent_tool_artifacts(result),
            error=result.error,
            raw_payload=subagent_tool_payload(profile=agent_type, result=result),
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


__all__ = ["TaskTool"]
