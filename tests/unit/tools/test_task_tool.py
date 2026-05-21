from __future__ import annotations

from mycli.domain.subagents import SubAgentResult
from mycli.tools.task import TaskTool


class FakeSubAgentService:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def run_task(
        self,
        *,
        description: str,
        agent_type: str,
        allowed_tools: tuple[str, ...],
        mode: str = "sync",
    ) -> SubAgentResult:
        self.calls.append(
            {
                "description": description,
                "agent_type": agent_type,
                "allowed_tools": allowed_tools,
                "mode": mode,
            }
        )
        return SubAgentResult(
            status="completed",
            report='<sub-agent-report agent="explore" status="completed">ok</sub-agent-report>',
            child_session_id="demo:sub:turn_1:abcd1234",
            tool_calls=1,
        )


def test_task_tool_delegates_to_bound_service() -> None:
    service = FakeSubAgentService()
    tool = TaskTool(service=service)

    result = tool.execute(
        {
            "description": "Find tests",
            "agent_type": "explore",
            "allowed_tools": ["Read", "Grep"],
        }
    )

    assert result.success is True
    assert result.summary == "Sub-agent explore completed with status completed."
    assert result.raw_payload["child_session_id"] == "demo:sub:turn_1:abcd1234"
    assert result.raw_payload["content"] == result.raw_payload["report"]
    assert service.calls == [
            {
                "description": "Find tests",
                "agent_type": "explore",
                "allowed_tools": ("Read", "Grep"),
                "mode": "sync",
            }
        ]


def test_unbound_task_tool_returns_unavailable_result() -> None:
    result = TaskTool().execute(
        {
            "description": "Find tests",
            "agent_type": "explore",
            "allowed_tools": ["Read"],
        }
    )

    assert result.success is False
    assert result.raw_payload["error_kind"] == "task_tool_unbound"


def test_task_tool_passes_background_mode() -> None:
    service = FakeSubAgentService()
    tool = TaskTool(service=service)

    result = tool.execute(
        {
            "description": "Inspect repo",
            "agent_type": "explore",
            "allowed_tools": ["Read"],
            "mode": "background",
        }
    )

    assert result.raw_payload["kind"] == "sub_agent_report"
    assert service.calls[0]["mode"] == "background"
