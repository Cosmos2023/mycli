from __future__ import annotations

from mycli.domain.subagents import SubAgentRunSummary


class FakeRuntime:
    def recent_subagents(self) -> tuple[SubAgentRunSummary, ...]:
        return (
            SubAgentRunSummary(
                agent_type="explore",
                description="Find docs",
                status="completed",
                child_session_id="demo:sub:turn_1:abcd1234",
                tool_calls=2,
            ),
        )


def test_turn_service_formats_subagent_summaries() -> None:
    from mycli.application.turn_service import format_subagent_summaries

    output = format_subagent_summaries(FakeRuntime().recent_subagents())

    assert output == (
        "explore completed tools=2 demo:sub:turn_1:abcd1234 "
        "description=Find docs"
    )
