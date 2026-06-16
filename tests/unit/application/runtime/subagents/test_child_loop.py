from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from mycli.application.runtime.subagents.loop import SubAgentChildLoop
from mycli.application.runtime.subagents.loop import RuntimeChildTurnRequester
from mycli.domain.runtime import ModelTurnResult, RuntimeBlock, RuntimeItem
from mycli.domain.subagents import (
    SubAgentBudget,
    SubAgentContextSnapshot,
    SubAgentInvocation,
    SubAgentProfile,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.exposure import ToolExposure
from mycli.tools.base import ToolResult


@dataclass(slots=True)
class FakeTurn:
    text: str = ""
    tool_calls: tuple[ToolCall, ...] = ()


class FakeRequester:
    def __init__(self, turns: list[FakeTurn]) -> None:
        self.turns = turns
        self.requests = 0
        self.seen_messages: list[list[dict[str, object]]] = []

    def request_child_turn(self, *, messages, tool_names, child_session_id):
        del tool_names, child_session_id
        self.requests += 1
        self.seen_messages.append([dict(message) for message in messages])
        return self.turns.pop(0)


class FakeRuntimeRequester:
    def __init__(self, result: ModelTurnResult) -> None:
        self.result = result

    def request_model_turn(
        self,
        *,
        runtime_items: list[RuntimeItem],
        legacy_messages: list[Any],
        tools: list[Any],
    ) -> tuple[ModelTurnResult, tuple[str, ...]]:
        del runtime_items, legacy_messages, tools
        return self.result, ()


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


class FakeTranscriptRecorder:
    def __init__(self) -> None:
        self.events: list[tuple[str, object]] = []

    def record_system_text(self, text: str) -> None:
        self.events.append(("system", text))

    def record_reference_text(self, text: str, metadata: dict[str, object]) -> None:
        self.events.append(("reference", (text, metadata)))

    def record_user_text(self, text: str) -> None:
        self.events.append(("user", text))

    def record_assistant_text(self, text: str) -> None:
        self.events.append(("assistant", text))

    def record_tool_call(self, *, call_id, tool_name, arguments) -> None:
        self.events.append(("tool_call", (call_id, tool_name, arguments)))

    def record_tool_result(self, *, call_id, tool_name, content) -> None:
        self.events.append(("tool_result", (call_id, tool_name, content)))

    def record_final(self, *, status: str, report: str, tool_calls: int) -> None:
        self.events.append(("final", (status, report, tool_calls)))


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
    assert requester.seen_messages[1][-1]["role"] == "tool"
    assert requester.seen_messages[1][-1]["tool_call_id"] == "call_1"


def test_runtime_child_turn_requester_joins_streamed_text_blocks_without_newlines() -> None:
    requester = RuntimeChildTurnRequester(
        requester=FakeRuntimeRequester(
            ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(type="text", text="my"),
                            RuntimeBlock(type="text", text="cli"),
                            RuntimeBlock(type="text", text=" >=3.13"),
                        ),
                    ),
                ),
                done=True,
            )
        ),
        tool_exposure_builder=lambda _tool_names: ToolExposure(entries=()),
        tool_renderer=lambda _exposure: [],
    )

    turn = requester.request_child_turn(
        messages=[{"role": "user", "content": "inspect"}],
        tool_names=(),
        child_session_id="demo:sub:turn_1:abcd",
    )

    assert turn.text == "mycli >=3.13"


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


def test_child_loop_default_tool_calls_are_unlimited() -> None:
    requester = FakeRequester(
        [
            FakeTurn(
                tool_calls=(
                    ToolCall(
                        name="Read",
                        arguments={"path": f"file-{index}.txt"},
                        reason="inspect",
                        call_id=f"call_{index}",
                    ),
                )
            )
            for index in range(3)
        ]
        + [FakeTurn(text="Done.")]
    )
    executor = FakeExecutor()
    loop = SubAgentChildLoop(requester=requester, executor=executor)

    result = loop.run(
        invocation=_invocation(),
        profile=SubAgentProfile(
            name="explore",
            system_prompt="Read only.",
            default_tools=("Read",),
            budget=SubAgentBudget(max_turns=5),
        ),
        child_session_id="demo:sub:turn_1:abcd1234",
        tool_names=("Read",),
    )

    assert result.status == "completed"
    assert result.tool_calls == 3
    assert len(executor.calls) == 3


def test_child_loop_replays_parallel_tool_calls_as_one_assistant_message() -> None:
    requester = FakeRequester(
        [
            FakeTurn(
                text="Need both files",
                tool_calls=(
                    ToolCall(
                        name="Read",
                        arguments={"path": "a.txt"},
                        reason="inspect a",
                        call_id="call_a",
                    ),
                    ToolCall(
                        name="Read",
                        arguments={"path": "b.txt"},
                        reason="inspect b",
                        call_id="call_b",
                    ),
                ),
            ),
            FakeTurn(text="Done."),
        ]
    )
    loop = SubAgentChildLoop(requester=requester, executor=FakeExecutor())

    result = loop.run(
        invocation=_invocation(),
        profile=SubAgentProfile(
            name="explore",
            system_prompt="Read only.",
            default_tools=("Read",),
            budget=SubAgentBudget(max_turns=4),
        ),
        child_session_id="demo:sub:turn_1:abcd1234",
        tool_names=("Read",),
    )

    assert result.status == "completed"
    second_request_messages = requester.seen_messages[1]
    assert [message["role"] for message in second_request_messages[-3:]] == [
        "assistant",
        "tool",
        "tool",
    ]
    assert second_request_messages[-3]["tool_calls"] == (
        ToolCall(
            name="Read",
            arguments={"path": "a.txt"},
            reason="inspect a",
            call_id="call_a",
        ),
        ToolCall(
            name="Read",
            arguments={"path": "b.txt"},
            reason="inspect b",
            call_id="call_b",
        ),
    )
    assert second_request_messages[-2]["tool_call_id"] == "call_a"
    assert second_request_messages[-1]["tool_call_id"] == "call_b"


def test_child_loop_records_transcript_events() -> None:
    requester = FakeRequester(
        [
            FakeTurn(
                text="Need file",
                tool_calls=(
                    ToolCall(
                        name="Read",
                        arguments={"path": "README.md"},
                        reason="inspect file",
                        call_id="call_1",
                    ),
                ),
            ),
            FakeTurn(text="README says mycli."),
        ]
    )
    executor = FakeExecutor()
    recorder = FakeTranscriptRecorder()
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
        transcript=recorder,
    )

    assert result.status == "completed"
    assert [event[0] for event in recorder.events] == [
        "system",
        "user",
        "assistant",
        "tool_call",
        "tool_result",
        "final",
    ]


def test_child_loop_injects_fork_context_as_reference_before_task() -> None:
    requester = FakeRequester([FakeTurn(text="Done.")])
    recorder = FakeTranscriptRecorder()
    loop = SubAgentChildLoop(requester=requester, executor=FakeExecutor())
    snapshot = SubAgentContextSnapshot(
        baseline_fragments=("Workspace rules: stay in repo.",),
        memory_fence="Known preference: concise reports.",
        session_summary="Parent is hardening subagent context.",
        tool_names=("Read", "Grep"),
        diagnostics={
            "baseline_fragment_count": 1,
            "tool_count": 2,
            "content_hash": "abc123",
        },
    )

    result = loop.run(
        invocation=_invocation(),
        profile=SubAgentProfile(
            name="explore",
            system_prompt="Read only.",
            default_tools=("Read",),
            budget=SubAgentBudget(max_turns=2),
        ),
        child_session_id="demo:sub:turn_1:abcd1234",
        tool_names=("Read", "Grep"),
        context_snapshot=snapshot,
        transcript=recorder,
    )

    assert result.status == "completed"
    messages = requester.seen_messages[0]
    assert [message["role"] for message in messages] == ["system", "system", "user"]
    assert "Inherited parent context" in str(messages[1]["content"])
    assert "not the current user request" in str(messages[1]["content"])
    assert "Workspace rules: stay in repo." in str(messages[1]["content"])
    assert messages[2]["content"] == "Find files"
    assert recorder.events[1][0] == "reference"
    assert recorder.events[1][1][1]["content_hash"] == "abc123"
