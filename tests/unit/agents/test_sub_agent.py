from __future__ import annotations

from dataclasses import dataclass

from mycli.agents.sub_agent import SubAgent
from mycli.services.context.token_counter import CachePolicy, Fragment, FragmentKind, Priority


@dataclass(slots=True, frozen=True)
class FakeTool:
    name: str
    schema_text: str | None = None

    def render_schema(self) -> str:
        if self.schema_text is None:
            raise AssertionError("render_schema should not be called for this tool")
        return self.schema_text


@dataclass(slots=True, frozen=True)
class FakeToolCall:
    name: str
    arguments: dict[str, object]


@dataclass(slots=True, frozen=True)
class FakeToolResult:
    content: str


class FakeResponse:
    def __init__(
        self,
        *,
        content: str = "",
        tool_calls: list[FakeToolCall] | None = None,
        is_final: bool = False,
    ) -> None:
        self.content = content
        self.tool_calls = tool_calls or []
        self.is_final = is_final


class StubSubAgent(SubAgent):
    def __init__(self, *args, responses: list[FakeResponse], **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._responses = list(responses)
        self.seen_messages: list[list[dict[str, object]]] = []
        self.executed_calls: list[FakeToolCall] = []

    def _call_model(
        self,
        messages: list[dict[str, object]],
        tools: list[object],
    ) -> FakeResponse:
        self.seen_messages.append([dict(message) for message in messages])
        return self._responses.pop(0)

    def _execute_tool(self, call: FakeToolCall) -> FakeToolResult:
        self.executed_calls.append(call)
        return FakeToolResult(content=f"file content for {call.name}")

    def _is_final(self, response: FakeResponse) -> bool:
        return response.is_final

    def _response_content(self, response: FakeResponse) -> str:
        return response.content

    def _response_tool_calls(self, response: FakeResponse) -> list[FakeToolCall]:
        return list(response.tool_calls)


def test_sub_agent_returns_independent_report_fragment() -> None:
    agent = StubSubAgent(
        name="finder",
        system_prompt="You are a focused finder",
        tools=[FakeTool(name="read_file", schema_text="schema: read_file")],
        model="test-model",
        budget=object(),
        responses=[FakeResponse(content="Done", is_final=True)],
    )

    report = agent.run("Find all Python files")

    assert isinstance(report, Fragment)
    assert report.kind is FragmentKind.TOOL_RESULT
    assert report.priority is Priority.HIGH
    assert report.cache_policy is CachePolicy.DYNAMIC
    assert report.metadata["source"] == "sub_agent"
    assert report.metadata["sub_agent_name"] == "finder"
    assert report.metadata["tool_calls"] == 0
    assert report.metadata["cache_prefix"] == "sub_agent:finder"
    assert "Done" in report.content
    assert "Find all Python files" not in report.content


def test_sub_agent_sorts_tools_and_renders_static_tool_schema_messages() -> None:
    agent = StubSubAgent(
        name="sorter",
        system_prompt="sort",
        tools=[
            FakeTool(name="z_tool", schema_text="schema: z_tool"),
            FakeTool(name="a_tool", schema_text="schema: a_tool"),
        ],
        model="test-model",
        budget=object(),
        responses=[FakeResponse(content="Sorted", is_final=True)],
    )

    assert [tool.name for tool in agent.tools] == ["a_tool", "z_tool"]

    agent.run("Inspect")

    first_call_messages = agent.seen_messages[0]
    assert [message["role"] for message in first_call_messages] == ["system", "system", "system", "user"]
    assert first_call_messages[0]["content"] == "sort"
    assert first_call_messages[1]["content"] == "schema: a_tool"
    assert first_call_messages[2]["content"] == "schema: z_tool"


def test_sub_agent_counts_internal_tool_calls_without_exposing_raw_tool_results() -> None:
    agent = StubSubAgent(
        name="reader",
        system_prompt="read",
        tools=[FakeTool(name="read_file", schema_text="schema: read_file")],
        model="test-model",
        budget=object(),
        responses=[
            FakeResponse(tool_calls=[FakeToolCall(name="read_file", arguments={"path": "a.py"})]),
            FakeResponse(tool_calls=[FakeToolCall(name="read_file", arguments={"path": "b.py"})]),
            FakeResponse(content="All done", is_final=True),
        ],
    )

    report = agent.run("Inspect two files")

    assert report.metadata["tool_calls"] == 2
    assert len(agent.executed_calls) == 2
    assert "All done" in report.content
    assert "file content" not in report.content.lower()
    assert "a.py" not in report.content
    assert "b.py" not in report.content


def test_sub_agent_returns_timeout_report_after_max_tool_calls() -> None:
    agent = StubSubAgent(
        name="looper",
        system_prompt="loop",
        tools=[FakeTool(name="read_file", schema_text="schema: read_file")],
        model="test-model",
        budget=object(),
        max_tool_calls=2,
        responses=[
            FakeResponse(tool_calls=[FakeToolCall(name="read_file", arguments={"path": "a.py"})]),
            FakeResponse(tool_calls=[FakeToolCall(name="read_file", arguments={"path": "b.py"})]),
        ],
    )

    report = agent.run("Keep reading")

    assert report.kind is FragmentKind.TOOL_RESULT
    assert report.priority is Priority.LOW
    assert report.metadata["source"] == "sub_agent"
    assert report.metadata["sub_agent_name"] == "looper"
    assert report.metadata["tool_calls"] == 2
    assert report.metadata["cache_prefix"] == "sub_agent:looper"
    assert report.metadata["timeout"] is True
    assert "max tool calls (2)" in report.content


def test_sub_agent_twenty_tool_calls_produce_one_parent_report_fragment() -> None:
    responses = [
        FakeResponse(tool_calls=[FakeToolCall(name="read_file", arguments={"path": f"{index}.py"})])
        for index in range(20)
    ]
    responses.append(FakeResponse(content="Found the answer", is_final=True))
    agent = StubSubAgent(
        name="twenty",
        system_prompt="read",
        tools=[FakeTool(name="read_file", schema_text="schema: read_file")],
        model="test-model",
        budget=object(),
        max_tool_calls=25,
        responses=responses,
    )

    report = agent.run("Inspect twenty files")

    assert isinstance(report, Fragment)
    assert report.metadata["tool_calls"] == 20
    assert report.metadata["source"] == "sub_agent"
    assert report.content.count("[Sub-agent 'twenty' report]") == 1
    assert len(agent.executed_calls) == 20
    assert all(f"{index}.py" not in report.content for index in range(20))
