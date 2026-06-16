from __future__ import annotations

from mycli.domain.subagents import SubAgentOutput
from mycli.tools.subagent_output import SubagentOutputTool


class FakeSubAgentOutputService:
    def __init__(self) -> None:
        self.child_session_ids: list[str] = []

    def read_output(self, child_session_id: str) -> SubAgentOutput:
        self.child_session_ids.append(child_session_id)
        return SubAgentOutput(
            child_session_id=child_session_id,
            status="completed",
            report="final report",
            tool_calls=2,
            transcript_lines=("explore completed tools=2 demo:sub", "  final final report"),
        )


def test_subagent_output_tool_reads_output_from_service() -> None:
    service = FakeSubAgentOutputService()
    tool = SubagentOutputTool(service=service)

    result = tool.execute({"child_session_id": "demo:sub:turn_1:abcd1234"})

    assert result.success is True
    assert result.summary == "Sub-agent completed."
    assert result.raw_payload["status"] == "completed"
    assert result.raw_payload["report"] == "final report"
    assert result.raw_payload["transcript"] == [
        "explore completed tools=2 demo:sub",
        "  final final report",
    ]
    assert service.child_session_ids == ["demo:sub:turn_1:abcd1234"]


def test_subagent_output_tool_description_discourages_proactive_polling() -> None:
    description = SubagentOutputTool.spec.description

    assert "user-requested" in description
    assert "Do not proactively poll" in description


def test_subagent_output_tool_requires_child_session_id() -> None:
    result = SubagentOutputTool().execute({})

    assert result.success is False
    assert result.raw_payload["error_kind"] == "missing_child_session_id"
