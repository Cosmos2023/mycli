from __future__ import annotations

from mycli.domain.subagents import SubAgentResult
from mycli.tools.task import TaskTool


class FakeSubAgentService:
    def __init__(self, *, status: str = "completed") -> None:
        self.calls: list[dict[str, object]] = []
        self.status = status

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
            status=self.status,
            report=f'<sub-agent-report agent="explore" status="{self.status}">ok</sub-agent-report>',
            child_session_id="demo:sub:turn_1:abcd1234",
            tool_calls=0 if self.status == "running" else 1,
            context_diagnostics={
                "baseline_fragment_count": 1,
                "tool_count": 2,
                "content_hash": "abc123",
            },
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
    assert result.artifacts["child_session_id"] == "demo:sub:turn_1:abcd1234"
    assert result.raw_payload["child_session_id"] == "demo:sub:turn_1:abcd1234"
    assert result.raw_payload["run_id"] == "demo:sub:turn_1:abcd1234"
    assert result.raw_payload["trace"] == {
        "run_id": "demo:sub:turn_1:abcd1234",
        "child_session_id": "demo:sub:turn_1:abcd1234",
        "status": "completed",
        "tool_calls": 1,
        "context": {
            "baseline_fragment_count": 1,
            "tool_count": 2,
            "content_hash": "abc123",
        },
    }
    assert result.artifacts["context_diagnostics"]["content_hash"] == "abc123"
    assert result.raw_payload["artifacts"]["subagent_report"] == result.raw_payload["report"]
    assert result.raw_payload["content"] == result.raw_payload["report"]
    assert service.calls == [
            {
                "description": "Find tests",
                "agent_type": "explore",
                "allowed_tools": ("Read", "Grep"),
                "mode": "background",
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


def test_task_tool_coerces_explicit_sync_to_background() -> None:
    service = FakeSubAgentService()
    tool = TaskTool(service=service)

    tool.execute(
        {
            "description": "Inspect repo",
            "agent_type": "explore",
            "allowed_tools": ["Read"],
            "mode": "sync",
        }
    )

    assert service.calls[0]["mode"] == "background"


def test_task_tool_treats_background_running_as_started_success() -> None:
    service = FakeSubAgentService(status="running")
    tool = TaskTool(service=service)

    result = tool.execute(
        {
            "description": "Inspect repo",
            "agent_type": "explore",
            "allowed_tools": ["Read"],
        }
    )

    assert result.success is True
    assert result.summary == "Sub-agent explore started in background."
    assert "notified automatically" in result.raw_payload["report"]
    assert "do not call SubagentOutput" in result.raw_payload["report"]
    assert result.raw_payload["status"] == "running"
