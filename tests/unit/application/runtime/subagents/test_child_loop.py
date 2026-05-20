from __future__ import annotations

from dataclasses import dataclass

from mycli.application.runtime.subagents.loop import SubAgentChildLoop
from mycli.domain.subagents import SubAgentBudget, SubAgentInvocation, SubAgentProfile
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolResult


@dataclass(slots=True)
class FakeTurn:
    text: str = ""
    tool_calls: tuple[ToolCall, ...] = ()


class FakeRequester:
    def __init__(self, turns: list[FakeTurn]) -> None:
        self.turns = turns
        self.requests = 0

    def request_child_turn(self, *, messages, tool_names, child_session_id):
        del messages, tool_names, child_session_id
        self.requests += 1
        return self.turns.pop(0)


class FakeExecutor:
    def __init__(self) -> None:
        self.calls: list[ToolCall] = []
        self.tool_scopes: list[tuple[str, ...]] = []

    def execute_child_tool(
        self,
        *,
        call: ToolCall,
        child_session_id: str,
        tool_names: tuple[str, ...],
    ) -> ToolResult:
        del child_session_id
        self.calls.append(call)
        self.tool_scopes.append(tool_names)
        return ToolResult(
            success=True,
            summary="read ok",
            raw_payload={"content": "file content"},
        )


def _invocation() -> SubAgentInvocation:
    return SubAgentInvocation(
        agent_type="explore",
        description="Find files",
        allowed_tools=("Read",),
        parent_session_id="demo",
        parent_turn_id="turn_1",
    )


def test_child_loop_executes_tool_then_returns_final_text() -> None:
    requester = FakeRequester(
        [
            FakeTurn(
                tool_calls=(
                    ToolCall(
                        name="Read",
                        arguments={"path": "README.md"},
                        reason="inspect file",
                        call_id="call_1",
                    ),
                )
            ),
            FakeTurn(text="Found README.md."),
        ]
    )
    executor = FakeExecutor()
    loop = SubAgentChildLoop(requester=requester, executor=executor)

    result = loop.run(
        invocation=_invocation(),
        profile=SubAgentProfile(
            name="explore",
            system_prompt="Read only.",
            default_tools=("Read",),
            budget=SubAgentBudget(max_turns=4, max_tool_calls=4),
        ),
        child_session_id="demo:sub:turn_1:abcd1234",
        tool_names=("Read",),
    )

    assert result.status == "completed"
    assert result.report == "Found README.md."
    assert result.tool_calls == 1
    assert executor.calls[0].name == "Read"
    assert executor.tool_scopes == [("Read",)]


def test_child_loop_stops_at_no_progress_limit() -> None:
    requester = FakeRequester([FakeTurn(), FakeTurn(), FakeTurn()])
    loop = SubAgentChildLoop(requester=requester, executor=FakeExecutor())

    result = loop.run(
        invocation=_invocation(),
        profile=SubAgentProfile(
            name="explore",
            system_prompt="Read only.",
            default_tools=("Read",),
            budget=SubAgentBudget(max_turns=6, no_progress_turn_limit=2),
        ),
        child_session_id="demo:sub:turn_1:abcd1234",
        tool_names=("Read",),
    )

    assert result.status == "max_no_progress"
    assert result.tool_calls == 0


def test_child_loop_stops_at_max_tool_calls() -> None:
    requester = FakeRequester(
        [
            FakeTurn(
                tool_calls=(
                    ToolCall(
                        name="Read",
                        arguments={"path": "a"},
                        reason="inspect a",
                        call_id="call_1",
                    ),
                )
            ),
            FakeTurn(
                tool_calls=(
                    ToolCall(
                        name="Read",
                        arguments={"path": "b"},
                        reason="inspect b",
                        call_id="call_2",
                    ),
                )
            ),
        ]
    )
    loop = SubAgentChildLoop(requester=requester, executor=FakeExecutor())

    result = loop.run(
        invocation=_invocation(),
        profile=SubAgentProfile(
            name="explore",
            system_prompt="Read only.",
            default_tools=("Read",),
            budget=SubAgentBudget(max_turns=4, max_tool_calls=1),
        ),
        child_session_id="demo:sub:turn_1:abcd1234",
        tool_names=("Read",),
    )

    assert result.status == "max_tool_calls"
    assert result.tool_calls == 1
