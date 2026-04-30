from __future__ import annotations

from pathlib import Path
import json

from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.domain.conversation import Conversation, Message
from mycli.domain.dynamic_tools import (
    DynamicToolDescriptor,
    DynamicToolLifecycleState,
    DynamicToolRegistration,
    DynamicToolScope,
    DynamicToolSource,
)
from mycli.domain.memory import MemoryKind, MemoryRecord
from mycli.infrastructure.openai_client import ModelResponseError
from mycli.infrastructure.openai_responses_client import OpenAIResponsesClient
from mycli.infrastructure.models.responses_adapter import ResponsesModelAdapter
from mycli.domain.tool_exposure import ToolRouteKey
from mycli.domain.runtime import (
    ActivityEvent,
    AgentConfig,
    BaselineFragment,
    ContextBaseline,
    HistoryItem,
    HistoryItemType,
    ModelTurnResult,
    PlanItem,
    PlanState,
    PlanStatus,
    RuntimeBlock,
    RuntimeItem,
    StopReason,
    TurnItemType,
    TurnRollout,
    TurnStatus,
)
from mycli.schemas.responses_protocol import ResponsesContinuationState
from mycli.services.trace_service import TraceService
from mycli.services.dynamic_tool_provider import DynamicToolProvider
from mycli.domain.tools import ToolCall
from mycli.services.memory_service import MemoryService
from mycli.services.skill_registry import SkillRegistry
from mycli.services.workspace_log_service import WorkspaceLogService
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.edit_file import EditFileTool
from mycli.tools.list_directory import ListDirectoryTool
from mycli.tools.read_file import ReadFileTool
from mycli.tools.registry import ToolRegistryV2
from mycli.tools.run_shell import RunShellTool
from mycli.tools.search_text import SearchTextTool
from mycli.tools.update_plan import UpdatePlanTool


class PushThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0

    def next_action(self, *, messages, tools):
        del messages, tools
        self.calls += 1
        if self.calls == 1:
            return type(
                "Action",
                (),
                {
                    "assistant_message": None,
                    "progress_message": "Preparing a risky push",
                    "tool_call": ToolCall(
                        name="run_shell",
                        arguments={"args": ["git", "push", "origin", "main"]},
                        reason="publish branch",
                    ),
                    "done": False,
                },
            )()
        return type(
            "Action",
            (),
            {
                "assistant_message": "Push finished",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


def test_agent_runtime_resumes_after_approval(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenDoneAdapter(),
    )

    first = runtime.handle_user_turn("push the branch")
    assert first.pending_decision is not None

    resumed = runtime.resolve_pending_approval("1")
    assert resumed.assistant_message == "Push finished"


def test_agent_runtime_emits_activity_events_for_thinking_and_tool_execution(
    tmp_path: Path,
) -> None:
    adapter = SearchThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    (tmp_path / "README.md").write_text("search_text mention\n", encoding="utf-8")

    response = runtime.handle_user_turn("search for search_text")

    kinds = [event.kind for event in response.activity_events]
    messages = [event.message for event in response.activity_events]

    assert response.assistant_message == "Search complete"
    assert "thinking" in kinds
    assert "tool_started" in kinds
    assert "tool_finished" in kinds
    assert any(message.startswith("Searching:") for message in messages)
    assert any(message.startswith("Done searching:") for message in messages)


class InspectThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_messages: list[list[dict[str, object]]] = []

    def next_action(self, *, messages, tools):
        del tools
        self.seen_messages.append(messages)
        self.calls += 1
        if self.calls == 1:
            return type(
                "Action",
                (),
                {
                    "assistant_message": None,
                    "progress_message": "Inspecting the workspace",
                    "tool_call": ToolCall(
                        call_id="call_list_directory_1",
                        name="list_directory",
                        arguments={"path": "."},
                        reason="inspect root",
                    ),
                    "done": False,
                },
            )()
        return type(
            "Action",
            (),
            {
                "assistant_message": "Inspection complete",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


class SearchThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_messages: list[list[dict[str, object]]] = []

    def next_action(self, *, messages, tools):
        del tools
        self.seen_messages.append(messages)
        self.calls += 1
        if self.calls == 1:
            return type(
                "Action",
                (),
                {
                    "assistant_message": None,
                    "progress_message": "Searching the workspace",
                    "tool_call": ToolCall(
                        call_id="call_search_text_1",
                        name="search_text",
                        arguments={"query": "search_text", "path": ".", "glob": "*.md"},
                        reason="search workspace",
                    ),
                    "done": False,
                },
            )()
        return type(
            "Action",
            (),
            {
                "assistant_message": "Search complete",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


class OverviewReasoningEffortAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.current_reasoning_effort: str | None = None
        self.reasoning_efforts: list[str | None] = []

    def set_reasoning_effort(self, reasoning_effort: str | None) -> None:
        self.current_reasoning_effort = reasoning_effort

    def next_turn(self, *, items, tools):
        del items, tools
        self.calls += 1
        self.reasoning_efforts.append(self.current_reasoning_effort)
        if self.calls == 1:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="list_directory",
                                tool_arguments={"path": "."},
                                call_id="call_list_directory_1",
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        if self.calls == 2:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="read_file",
                                tool_arguments={"path": "README.md"},
                                call_id="call_readme_1",
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Repository summary complete."),),
                ),
            ),
            done=True,
        )


class SearchReadEditThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_messages: list[list[dict[str, object]]] = []

    def next_action(self, *, messages, tools):
        del tools
        self.seen_messages.append(messages)
        self.calls += 1
        if self.calls == 1:
            return type(
                "Action",
                (),
                {
                    "assistant_message": None,
                    "progress_message": "Searching for evidence",
                    "tool_call": ToolCall(
                        call_id="call_search_1",
                        name="search_text",
                        arguments={
                            "query": "needle",
                            "path": ".",
                            "glob": "*.txt",
                            "case_sensitive": True,
                            "max_matches": 5,
                        },
                        reason="locate relevant lines",
                    ),
                    "done": False,
                },
            )()
        if self.calls == 2:
            return type(
                "Action",
                (),
                {
                    "assistant_message": None,
                    "progress_message": "Reading the file",
                    "tool_call": ToolCall(
                        call_id="call_read_1",
                        name="read_file",
                        arguments={"path": "notes.txt"},
                        reason="inspect full file content",
                    ),
                    "done": False,
                },
            )()
        if self.calls == 3:
            return type(
                "Action",
                (),
                {
                    "assistant_message": None,
                    "progress_message": "Editing the file",
                    "tool_call": ToolCall(
                        call_id="call_edit_1",
                        name="edit_file",
                        arguments={"path": "notes.txt", "new_content": "needle one\nline three\n"},
                        reason="apply edit",
                    ),
                    "done": False,
                },
            )()
        return type(
            "Action",
            (),
            {
                "assistant_message": "Grounding complete",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


class SearchRangeThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_messages: list[list[object]] = []

    def next_action(self, *, messages, tools):
        del tools
        self.seen_messages.append(messages)
        self.calls += 1
        if self.calls == 1:
            return type(
                "Action",
                (),
                {
                    "assistant_message": None,
                    "progress_message": "Searching for evidence",
                    "tool_call": ToolCall(
                        call_id="call_search_1",
                        name="search_text",
                        arguments={"query": "needle"},
                        reason="find the file",
                    ),
                    "done": False,
                },
            )()
        if self.calls == 2:
            return type(
                "Action",
                (),
                {
                    "assistant_message": None,
                    "progress_message": "Reading the matching lines",
                    "tool_call": ToolCall(
                        call_id="call_read_range_1",
                        name="read_file_range",
                        arguments={"path": "notes.txt", "start_line": 1, "end_line": 2},
                        reason="inspect the evidence",
                    ),
                    "done": False,
                },
            )()
        return type(
            "Action",
            (),
            {
                "assistant_message": "The evidence shows needle on line 1 of notes.txt.",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


class ShellThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_messages: list[list[dict[str, object]]] = []

    def next_action(self, *, messages, tools):
        del tools
        self.seen_messages.append(messages)
        self.calls += 1
        if self.calls == 1:
            return type(
                "Action",
                (),
                {
                    "assistant_message": None,
                    "progress_message": "Checking the working directory",
                    "tool_call": ToolCall(
                        call_id="call_shell_1",
                        name="run_shell",
                        arguments={"args": ["python3", "-c", "print('shell-output')"]},
                        reason="inspect shell output",
                    ),
                    "done": False,
                },
            )()
        return type(
            "Action",
            (),
            {
                "assistant_message": "Shell check complete",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


class BlockInspectThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_items: list[list[RuntimeItem]] = []

    def next_turn(self, *, items, tools):
        del tools
        self.seen_items.append(items)
        self.calls += 1
        if self.calls == 1:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="list_directory",
                                tool_arguments={"path": "."},
                                call_id="call_list_directory_1",
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Inspection complete"),),
                ),
            ),
            done=True,
        )


class MultiToolThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_items: list[list[RuntimeItem]] = []

    def next_turn(self, *, items, tools):
        del tools
        self.seen_items.append(items)
        self.calls += 1
        if self.calls == 1:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(type="text", text="I will inspect both files."),
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="read_file",
                                tool_arguments={"path": "README.md"},
                                call_id="call_read_readme",
                            ),
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="read_file",
                                tool_arguments={"path": "pyproject.toml"},
                                call_id="call_read_pyproject",
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Inspection complete"),),
                ),
            ),
            done=True,
        )


class PushThenResumedReasoningUnsupportedAdapter:
    def __init__(self) -> None:
        self.calls = 0

    def next_turn(self, *, items, tools):
        del items, tools
        self.calls += 1
        if self.calls == 1:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="run_shell",
                                tool_arguments={"args": ["git", "push", "origin", "main"]},
                                call_id="call_push_1",
                            ),
                        ),
                    ),
                ),
                done=False,
            )

        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(
                        RuntimeBlock(type="reasoning", text="Resuming after approval"),
                        RuntimeBlock(
                            type="tool_call",
                            tool_name="unsupported_tool",
                            tool_arguments={},
                            call_id="call_bad_1",
                        ),
                    ),
                ),
            ),
            done=False,
        )


class BlockSingleTurnCaptureAdapter:
    def __init__(self) -> None:
        self.seen_items: list[list[RuntimeItem]] = []

    def next_turn(self, *, items, tools):
        del tools
        self.seen_items.append(items)
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="done"),),
                ),
            ),
            done=True,
        )


class ReasoningToolThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0

    def next_turn(self, *, items, tools):
        del items, tools
        self.calls += 1
        if self.calls == 1:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(type="reasoning", text="Inspect pyproject.toml first."),
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="read_file",
                                tool_arguments={"path": "pyproject.toml"},
                                call_id="call_read_1",
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Repository summary complete."),),
                ),
            ),
            done=True,
        )


class ReasoningTextDoneAdapter:
    def next_turn(self, *, items, tools):
        del items, tools
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(
                        RuntimeBlock(type="reasoning", text="Summarizing the repository."),
                        RuntimeBlock(type="text", text="Repository summary complete."),
                    ),
                ),
            ),
            done=True,
        )


class StreamReasoningTextDoneAdapter:
    def stream_turn(self, *, items, tools):
        del items, tools
        yield {"type": "reasoning", "text": "Inspect pyproject first."}
        yield {"type": "text_delta", "text": "Repository "}
        yield {"type": "text_delta", "text": "summary complete."}
        yield {"type": "completed", "response_id": "resp_stream_1", "metadata": {"response_status": "completed"}}


class StreamReasoningToolThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0

    def stream_turn(self, *, items, tools):
        del items, tools
        self.calls += 1
        if self.calls == 1:
            yield {"type": "reasoning", "text": "Read pyproject first."}
            yield {
                "type": "tool_call",
                "block": RuntimeBlock(
                    type="tool_call",
                    tool_name="read_file",
                    tool_arguments={"path": "pyproject.toml"},
                    call_id="call_stream_read_1",
                ),
            }
            yield {"type": "completed", "response_id": "resp_stream_tool_1", "metadata": {"response_status": "completed"}}
            return
        yield {"type": "text_delta", "text": "Repository summary complete."}
        yield {"type": "completed", "response_id": "resp_stream_tool_2", "metadata": {"response_status": "completed"}}


class ContinuationAwareDoneAdapter:
    def __init__(self) -> None:
        self.loaded_state: ResponsesContinuationState | None = None
        self.current_state: ResponsesContinuationState | None = None

    def set_continuation_state(
        self,
        state: ResponsesContinuationState | None,
    ) -> None:
        self.loaded_state = state
        self.current_state = state

    def get_continuation_state(self) -> ResponsesContinuationState | None:
        return self.current_state

    def next_turn(self, *, items, tools):
        del items, tools
        self.current_state = ResponsesContinuationState(
            response_id="resp_next_1",
            request_signature='{"model":"gpt-test"}',
            request_input=(
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": "inspect"}],
                },
            ),
            response_output=(
                {
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Inspection complete"}],
                },
            ),
            eligible=True,
        )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Inspection complete"),),
                ),
            ),
            done=True,
            response_id="resp_next_1",
        )


class ContinuationFailureAdapter:
    def __init__(self) -> None:
        self.current_state: ResponsesContinuationState | None = None

    def set_continuation_state(
        self,
        state: ResponsesContinuationState | None,
    ) -> None:
        self.current_state = state

    def get_continuation_state(self) -> ResponsesContinuationState | None:
        return self.current_state

    def next_turn(self, *, items, tools):
        del items, tools
        self.current_state = ResponsesContinuationState(
            response_id="resp_failed_1",
            request_signature='{"model":"gpt-test"}',
            request_input=(
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": "inspect"}],
                },
            ),
            response_output=(),
            eligible=False,
            failure_reason="provider response.failed",
        )
        raise ModelResponseError("provider response.failed")


class StructuredFailureAdapter:
    def next_turn(self, *, items, tools):
        del items, tools
        raise ModelResponseError(
            "stream retry budget exhausted",
            stop_reason=StopReason.RETRY_EXHAUSTED,
            is_retryable=False,
            failure_kind="retry_exhausted",
        )


class RuntimeEventEmittingAdapter:
    def __init__(self) -> None:
        self._recorder = None

    def set_runtime_event_recorder(self, recorder) -> None:
        self._recorder = recorder

    def next_turn(self, *, items, tools):
        del items, tools
        if callable(self._recorder):
            self._recorder(
                "model_stream_retrying",
                {"attempt": 2, "failure_kind": "transport_error"},
            )
            self._recorder(
                "model_stream_fallback_activated",
                {"reason": "transport_error"},
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Recovered after fallback"),),
                ),
            ),
            done=True,
            response_id="resp_runtime_event_1",
        )


class LegacySingleTurnCaptureAdapter:
    def __init__(self) -> None:
        self.seen_messages: list[list[object]] = []

    def next_action(self, *, messages, tools):
        del tools
        self.seen_messages.append(messages)
        return type(
            "Action",
            (),
            {
                "assistant_message": "done",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


class CapturingResponsesClient:
    def __init__(self) -> None:
        self.captured_input_items: list[dict[str, object]] = []

    def create_response(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> dict[str, object]:
        del tools
        self.captured_input_items = input_items
        return {"id": "resp_capture_1", "output": []}


def build_runtime_with_capture_adapter(
    *,
    tmp_path: Path,
    model_adapter: object,
    recent_message_count: int,
) -> AgentRuntime:
    tool_registry = ToolRegistryV2.from_tools(
        [
            ListDirectoryTool(tmp_path),
            ReadFileTool(tmp_path),
            SearchTextTool(tmp_path),
            EditFileTool(tmp_path),
            RunShellTool(tmp_path),
            UpdatePlanTool(),
        ]
    )
    return AgentRuntime(
        model_adapter=model_adapter,
        tool_registry=tool_registry,
        config=AgentConfig(
            workspace_root=tmp_path,
            session_id="demo",
            recent_message_count=recent_message_count,
        ),
        home_dir=tmp_path / "home",
    )


def test_agent_runtime_consumes_runtime_blocks_via_next_turn(tmp_path: Path) -> None:
    adapter = BlockInspectThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("inspect the repo")

    assert response.assistant_message == "Inspection complete"
    assert adapter.calls == 2
    assert adapter.seen_items[0][0].role == "system"
    assert any(item.role == "user" for item in adapter.seen_items[0])
    assistant_blocks = tuple(
        block
        for item in adapter.seen_items[1]
        if item.role == "assistant"
        for block in item.blocks
    )
    tool_blocks = tuple(
        block
        for item in adapter.seen_items[1]
        if item.role == "tool"
        for block in item.blocks
    )
    assert any(
        block.type == "tool_call" and block.call_id == "call_list_directory_1"
        for block in assistant_blocks
    )
    assert any(
        block.type == "tool_result" and block.call_id == "call_list_directory_1"
        for block in tool_blocks
    )


def test_agent_runtime_reinjects_multi_tool_turn_as_single_assistant_item(
    tmp_path: Path,
) -> None:
    (tmp_path / "README.md").write_text("# Demo\n", encoding="utf-8")
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'demo'\n", encoding="utf-8")
    adapter = MultiToolThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("inspect both files")

    assert response.assistant_message == "Inspection complete"
    assert adapter.calls == 2
    assistant_tool_items = [
        item
        for item in adapter.seen_items[1]
        if item.role == "assistant"
        and any(block.type == "tool_call" for block in item.blocks)
    ]
    assert len(assistant_tool_items) == 1
    assert [
        block.call_id
        for block in assistant_tool_items[0].blocks
        if block.type == "tool_call"
    ] == ["call_read_readme", "call_read_pyproject"]
    assert [
        block.text
        for block in assistant_tool_items[0].blocks
        if block.type == "text"
    ] == ["I will inspect both files."]
    assert [
        block.call_id
        for item in adapter.seen_items[1]
        if item.role == "tool"
        for block in item.blocks
        if block.type == "tool_result"
    ] == ["call_read_readme", "call_read_pyproject"]


def test_agent_runtime_turns_reasoning_blocks_into_activity_events(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ReasoningTextDoneAdapter(),
    )

    response = runtime.handle_user_turn("inspect the repo")

    assert response.assistant_message == "Repository summary complete."
    assert any(event.kind == "thinking" for event in response.activity_events)
    assert any("Summarizing the repository." in event.message for event in response.activity_events)
    assert "Summarizing the repository." in response.progress_updates


def test_agent_runtime_keeps_reasoning_and_tool_call_in_same_turn(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ReasoningToolThenDoneAdapter(),
    )

    response = runtime.handle_user_turn("inspect the repo")

    assert response.assistant_message == "Repository summary complete."
    assert any(event.kind == "thinking" for event in response.activity_events)
    assert any(event.kind == "tool_started" and event.tool_name == "read_file" for event in response.activity_events)
    assert any(
        message.role == "tool" and "Read pyproject.toml" in message.content
        for message in runtime._session_service.load_conversation(runtime._config.session_id).messages
    )


def test_agent_runtime_collects_streamed_chunks_and_reasoning_activity(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=StreamReasoningTextDoneAdapter(),
    )

    response = runtime.handle_user_turn("inspect the repo")

    assert response.assistant_message == "Repository summary complete."
    assert response.streamed_chunks == ("Repository ", "summary complete.",)
    assert any(event.kind == "thinking" for event in response.activity_events)
    assert any("Inspect pyproject first." in event.message for event in response.activity_events)
    assistant_messages = [
        message.content
        for message in runtime._session_service.load_conversation(runtime._config.session_id).messages
        if message.role == "assistant"
    ]
    assert assistant_messages == ["Repository summary complete."]


def test_agent_runtime_adjusts_reasoning_effort_across_overview_turns(tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text("This is mycli.\n", encoding="utf-8")
    adapter = OverviewReasoningEffortAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("请给我这个仓库的简短总结")

    assert response.assistant_message == "Repository summary complete."
    assert adapter.reasoning_efforts == ["low", "medium", "low"]


def test_agent_runtime_supports_streamed_tool_call_execution(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=StreamReasoningToolThenDoneAdapter(),
    )

    response = runtime.handle_user_turn("inspect the repo")

    assert response.assistant_message == "Repository summary complete."
    assert any(event.kind == "tool_started" and event.tool_name == "read_file" for event in response.activity_events)


def test_resumed_approval_turn_applies_block_validation_and_reasoning_updates(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenResumedReasoningUnsupportedAdapter(),
    )

    first = runtime.handle_user_turn("push the branch")
    assert first.pending_decision is not None

    resumed = runtime.resolve_pending_approval("1")

    assert "unsupported tool" in resumed.assistant_message.lower()
    assert "unsupported_tool" in resumed.assistant_message
    assert "[decision] approved" in resumed.progress_updates
    assert "Resuming after approval" in resumed.progress_updates
    assert runtime._session_service.load_pending_decision(runtime._config.session_id) is None
    assert runtime._session_service.load_suspended_turn(runtime._config.session_id) is None


def test_agent_runtime_resolves_pending_approval_via_reconstructed_suspended_turn(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenDoneAdapter(),
    )

    first = runtime.handle_user_turn("push the branch")
    assert first.pending_decision is not None
    runtime._session_service.clear_suspended_turn(runtime._config.session_id)

    resumed = runtime.resolve_pending_approval("1")

    assert resumed.assistant_message == "Push finished"


def test_agent_runtime_sends_current_user_turn_once_in_block_path(tmp_path: Path) -> None:
    request = "inspect exactly once"
    adapter = BlockSingleTurnCaptureAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn(request)

    assert response.assistant_message == "done"
    matching_user_items = [
        item
        for item in adapter.seen_items[0]
        if item.role == "user"
        and any(
            block.type == "text"
            and block.text == f"Current user request: {request}"
            for block in item.blocks
        )
    ]
    assert len(matching_user_items) == 1
    assert not any(
        item.role == "user"
        and any(block.type == "text" and block.text == request for block in item.blocks)
        for item in adapter.seen_items[0]
    )


def test_agent_runtime_sends_current_user_turn_once_in_legacy_path(tmp_path: Path) -> None:
    request = "inspect exactly once in legacy"
    adapter = LegacySingleTurnCaptureAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn(request)

    assert response.assistant_message == "done"
    matching_user_messages = [
        message
        for message in adapter.seen_messages[0]
        if getattr(message, "role", None) == "user"
        and getattr(message, "content", None) == f"Current user request: {request}"
    ]
    assert len(matching_user_messages) == 1
    assert not any(
        getattr(message, "role", None) == "user"
        and getattr(message, "content", None) == request
        for message in adapter.seen_messages[0]
    )


def test_agent_runtime_places_stable_action_guidance_before_contextual_user_messages(
    tmp_path: Path,
) -> None:
    adapter = LegacySingleTurnCaptureAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("inspect cache shape")

    assert response.assistant_message == "done"
    messages = adapter.seen_messages[0]
    assert getattr(messages[0], "role", None) == "system"
    assert "从当前用户请求和可见上下文出发" in str(
        getattr(messages[0], "content", "")
    )
    assert any(getattr(message, "role", None) == "user" for message in messages[1:])
    assert not any(getattr(message, "role", None) == "assistant" for message in messages)


def test_agent_runtime_uses_recent_conversation_window_in_block_path(tmp_path: Path) -> None:
    adapter = BlockSingleTurnCaptureAdapter()
    runtime = build_runtime_with_capture_adapter(
        tmp_path=tmp_path,
        model_adapter=adapter,
        recent_message_count=1,
    )
    conversation = Conversation(session_id="demo")
    conversation.append(Message(role="user", content="first question"))
    conversation.append(Message(role="assistant", content="first answer"))
    runtime._session_service.save_conversation(conversation)

    runtime.handle_user_turn("latest question")

    transcript_user_items = [
        item
        for item in adapter.seen_items[0]
        if item.role == "user"
        and any(block.type == "text" and block.text == "first question" for block in item.blocks)
    ]
    assert transcript_user_items == []


def test_agent_runtime_uses_recent_conversation_window_in_legacy_path(tmp_path: Path) -> None:
    adapter = LegacySingleTurnCaptureAdapter()
    runtime = build_runtime_with_capture_adapter(
        tmp_path=tmp_path,
        model_adapter=adapter,
        recent_message_count=1,
    )
    conversation = Conversation(session_id="demo")
    conversation.append(Message(role="user", content="first question"))
    conversation.append(Message(role="assistant", content="first answer"))
    runtime._session_service.save_conversation(conversation)

    runtime.handle_user_turn("latest question")

    transcript_user_messages = [
        message
        for message in adapter.seen_messages[0]
        if getattr(message, "role", None) == "user"
        and getattr(message, "content", None) == "first question"
    ]
    assert transcript_user_messages == []


def test_agent_runtime_reinjects_tool_results_as_transcript_messages(tmp_path: Path) -> None:
    adapter = InspectThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("inspect the repo")

    assert response.assistant_message == "Inspection complete"
    assert adapter.calls == 2
    assert adapter.seen_messages[0][0].role == "system"
    assert any(message.role == "user" for message in adapter.seen_messages[0])
    assert any(
        message.role == "assistant"
        and message.tool_calls
        and message.tool_calls[0].call_id == "call_list_directory_1"
        for message in adapter.seen_messages[1]
    )
    assert any(
        message.role == "tool"
        and message.tool_call_id == "call_list_directory_1"
        and "Tool list_directory" in str(message.content)
        for message in adapter.seen_messages[1]
    )


def test_agent_runtime_reinjects_grounded_search_matches_into_tool_message(tmp_path: Path) -> None:
    adapter = SearchThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    (tmp_path / "README.md").write_text("search_text mention\n", encoding="utf-8")

    response = runtime.handle_user_turn("search for search_text")

    assert response.assistant_message == "Search complete"
    assert adapter.calls == 2
    assert any(
        message.role == "tool"
        and message.tool_call_id == "call_search_text_1"
        and "Evidence:" in str(message.content)
        and "[search_match] README.md:1" in str(message.content)
        and "snippet: search_text mention" in str(message.content)
        for message in adapter.seen_messages[1]
    )


def test_agent_runtime_preserves_grounded_tool_messages_across_reinjection(
    tmp_path: Path,
) -> None:
    adapter = SearchReadEditThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    (tmp_path / "notes.txt").write_text("needle one\nline two\n", encoding="utf-8")

    response = runtime.handle_user_turn("inspect, then edit")

    assert response.assistant_message == "Grounding complete"
    assert adapter.calls == 4

    final_messages = adapter.seen_messages[3]
    search_tool_message = next(
        message
        for message in final_messages
        if getattr(message, "role", None) == "tool"
        and getattr(message, "tool_call_id", None) == "call_search_1"
    )
    read_tool_message = next(
        message
        for message in final_messages
        if getattr(message, "role", None) == "tool"
        and getattr(message, "tool_call_id", None) == "call_read_1"
    )
    edit_tool_message = next(
        message
        for message in final_messages
        if getattr(message, "role", None) == "tool"
        and getattr(message, "tool_call_id", None) == "call_edit_1"
    )

    search_content = str(search_tool_message.content)
    read_content = str(read_tool_message.content)
    edit_content = str(edit_tool_message.content)

    assert search_content.startswith("Tool search_text:")
    assert "Evidence:" in search_content
    assert "[search_match] notes.txt:1" in search_content
    assert "snippet: needle one" in search_content

    assert read_content.startswith("Tool read_file:")
    assert "Evidence:" in read_content
    assert "[file_excerpt] notes.txt:1-2" in read_content
    assert "snippet: needle one line two" in read_content

    assert edit_content.startswith("Tool edit_file:")
    assert "Diff preview:" in edit_content
    assert "-line two" in edit_content
    assert "+line three" in edit_content


def test_agent_runtime_reinjects_search_and_range_evidence_into_tool_messages(
    tmp_path: Path,
) -> None:
    adapter = SearchRangeThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    (tmp_path / "notes.txt").write_text("needle one\nline two\n", encoding="utf-8")

    response = runtime.handle_user_turn("find the note")

    assert response.assistant_message == "The evidence shows needle on line 1 of notes.txt."
    final_messages = adapter.seen_messages[-1]
    search_tool_message = next(
        message
        for message in final_messages
        if getattr(message, "role", None) == "tool"
        and getattr(message, "tool_call_id", None) == "call_search_1"
    )
    range_tool_message = next(
        message
        for message in final_messages
        if getattr(message, "role", None) == "tool"
        and getattr(message, "tool_call_id", None) == "call_read_range_1"
    )

    assert "Evidence:" in str(search_tool_message.content)
    assert "[search_match] notes.txt:1" in str(search_tool_message.content)
    assert "snippet: needle one" in str(search_tool_message.content)
    assert "[file_excerpt] notes.txt:1-2" in str(range_tool_message.content)


def test_agent_runtime_reinjects_grounded_shell_stdout_into_tool_message(
    tmp_path: Path,
) -> None:
    adapter = ShellThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("check shell output")

    assert response.assistant_message == "Shell check complete"
    assert any(
        message.role == "tool"
        and "Stdout preview:" in str(message.content)
        and "shell-output" in str(message.content)
        for message in adapter.seen_messages[-1]
    )


def test_agent_runtime_emits_waiting_approval_activity_event(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenDoneAdapter(),
    )

    response = runtime.handle_user_turn("push the branch")

    assert response.pending_decision is not None
    assert any(
        event.kind == "waiting_approval" and "Waiting approval:" in event.message
        for event in response.activity_events
    )


class ErroringAdapter:
    def next_turn(self, *, items, tools):
        del items, tools
        raise ModelResponseError("boom")


def test_agent_runtime_emits_model_error_activity_event(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ErroringAdapter(),
    )

    response = runtime.handle_user_turn("search for anything")

    assert "Model request failed: boom" == response.assistant_message
    assert response.activity_events[-1] == ActivityEvent(
        kind="model_error",
        message="Model error: boom",
    )


class UnexpectedErrorAdapter:
    def next_turn(self, *, items, tools):
        del items, tools
        raise ValueError("runtime exploded")


def test_agent_runtime_logs_unexpected_runtime_exceptions(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=UnexpectedErrorAdapter(),
    )

    response = runtime.handle_user_turn("search for anything")

    assert response.assistant_message == "Internal runtime error: runtime exploded"
    assert "Details logged to log/error.log" in response.error_details
    assert any(detail.endswith("-error.json") for detail in response.error_details)
    error_files = sorted((tmp_path / "log" / "model-raw").glob("*-error.json"))
    assert len(error_files) == 1
    payload = json.loads(error_files[0].read_text(encoding="utf-8"))
    assert payload["error_type"] == "ValueError"


class FakeResponsesPayload:
    def to_dict(self) -> dict[str, object]:
        return {
            "id": "resp_123",
            "output": [
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": "Inspection complete"}],
                }
            ],
        }


class FakeResponsesSdkClient:
    def __init__(self) -> None:
        self.responses = type(
            "_FakeResponsesNamespace",
            (),
            {"create": lambda _self, **kwargs: FakeResponsesPayload()},
        )()


def test_agent_runtime_passes_session_and_turn_context_to_model_logging(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: FakeResponsesSdkClient(),
    )

    log_service = WorkspaceLogService(workspace_root=tmp_path)
    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
        log_service=log_service,
    )
    runtime = AgentRuntime(
        model_adapter=ResponsesModelAdapter(client=client),
        tool_registry=ToolRegistryV2.from_tools(
            [
                ListDirectoryTool(tmp_path),
                ReadFileTool(tmp_path),
                SearchTextTool(tmp_path),
                EditFileTool(tmp_path),
                RunShellTool(tmp_path),
                UpdatePlanTool(),
            ]
        ),
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=tmp_path / "home",
        workspace_log_service=log_service,
    )

    runtime.handle_user_turn("inspect the repo")

    events = [
        json.loads(line)
        for line in (tmp_path / "log" / "model-events.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert events[0]["session_id"] == "demo"
    assert events[0]["turn_id"].startswith("turn_")


def test_agent_runtime_loads_and_persists_responses_continuation_state(
    tmp_path: Path,
) -> None:
    adapter = ContinuationAwareDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    initial_state = ResponsesContinuationState(
        response_id="resp_prev_1",
        request_signature='{"model":"gpt-test"}',
        request_input=(
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "inspect"}],
            },
        ),
        response_output=(
            {
                "role": "assistant",
                "content": [{"type": "output_text", "text": "I will inspect."}],
            },
        ),
        eligible=True,
    )
    runtime._session_service.save_responses_continuation_state(
        runtime._config.session_id,
        initial_state,
    )

    response = runtime.handle_user_turn("inspect")
    saved_state = runtime._session_service.load_responses_continuation_state(
        runtime._config.session_id,
    )
    trace = TraceService(home_dir=tmp_path / "home").load(runtime._config.session_id)

    assert response.assistant_message == "Inspection complete"
    assert adapter.loaded_state == initial_state
    assert saved_state is not None
    assert saved_state.response_id == "resp_next_1"
    assert saved_state.eligible is True
    assert any(event.kind == "responses_continuation_loaded" for event in trace)
    assert any(
        event.kind == "responses_continuation_persisted"
        and event.payload.get("phase") == "model_turn_completed"
        for event in trace
    )


def test_agent_runtime_persists_ineligible_continuation_state_after_model_error(
    tmp_path: Path,
) -> None:
    adapter = ContinuationFailureAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("inspect")
    saved_state = runtime._session_service.load_responses_continuation_state(
        runtime._config.session_id,
    )
    trace = TraceService(home_dir=tmp_path / "home").load(runtime._config.session_id)

    assert response.turn is not None
    assert response.turn.stop_reason is StopReason.MODEL_ERROR
    assert saved_state is not None
    assert saved_state.eligible is False
    assert saved_state.failure_reason == "provider response.failed"
    assert any(
        event.kind == "responses_continuation_persisted"
        and event.payload.get("phase") == "model_error"
        and event.payload.get("eligible") is False
        for event in trace
    )


def test_agent_runtime_propagates_structured_model_stop_reason(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=StructuredFailureAdapter(),
    )

    response = runtime.handle_user_turn("inspect")

    assert response.turn is not None
    assert response.turn.stop_reason is StopReason.RETRY_EXHAUSTED
    assert "retry budget exhausted" in response.assistant_message.lower()


def test_agent_runtime_persists_model_runtime_events_into_trace_and_rollout(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=RuntimeEventEmittingAdapter(),
    )

    response = runtime.handle_user_turn("inspect")
    trace = TraceService(home_dir=tmp_path / "home").load(runtime._config.session_id)
    rollouts = runtime._session_service.load_turn_rollouts(runtime._config.session_id)

    assert response.turn is not None
    assert any(event.kind == "model_stream_retrying" for event in trace)
    assert any(event.kind == "model_stream_fallback_activated" for event in trace)
    assert any(event.kind == "model_stream_retrying" for event in rollouts[0].events)
    assert any(event.kind == "model_stream_fallback_activated" for event in rollouts[0].events)


def test_agent_runtime_logs_assembled_turn_context_summary(tmp_path: Path) -> None:
    log_service = WorkspaceLogService(workspace_root=tmp_path)
    runtime = AgentRuntime(
        model_adapter=BlockSingleTurnCaptureAdapter(),
        tool_registry=ToolRegistryV2.from_tools(
            [
                ListDirectoryTool(tmp_path),
                ReadFileTool(tmp_path),
                SearchTextTool(tmp_path),
                EditFileTool(tmp_path),
                RunShellTool(tmp_path),
                UpdatePlanTool(),
            ]
        ),
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=tmp_path / "home",
        workspace_log_service=log_service,
    )

    runtime.handle_user_turn("inspect the repo")

    app_log = (tmp_path / "log" / "app.log").read_text(encoding="utf-8")

    assert "INFO turn_context_assembled Assembled turn context" in app_log
    assert '"session_id": "demo"' in app_log
    assert '"enabled_sections"' in app_log
    assert '"tool_exposure"' in app_log


class PlanThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0

    def next_action(self, *, messages, tools):
        del messages, tools
        self.calls += 1
        if self.calls == 1:
            return type(
                "Action",
                (),
                {
                    "assistant_message": None,
                    "progress_message": "Updating the plan",
                    "tool_call": ToolCall(
                        name="update_plan",
                        arguments={
                            "items": [
                                {
                                    "id": "inspect",
                                    "content": "Inspect the repository layout",
                                    "status": "in_progress",
                                },
                                {
                                    "id": "summarize",
                                    "content": "Summarize the findings",
                                    "status": "pending",
                                },
                            ]
                        },
                        reason="track progress explicitly",
                    ),
                    "done": False,
                },
            )()
        return type(
            "Action",
            (),
            {
                "assistant_message": "Plan recorded",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


class ProviderStylePlanThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0

    def next_action(self, *, messages, tools):
        del messages, tools
        self.calls += 1
        if self.calls == 1:
            return type(
                "Action",
                (),
                {
                    "assistant_message": None,
                    "progress_message": "Updating the plan",
                    "tool_call": ToolCall(
                        name="update_plan",
                        arguments={
                            "items": [
                                {
                                    "status": "in_progress",
                                    "description": "Stabilize runtime decisions",
                                },
                                {
                                    "status": "pending",
                                    "description": "Converge provider integration",
                                },
                                {
                                    "status": "pending",
                                    "description": "Run smoke validation",
                                },
                            ]
                        },
                        reason="track progress explicitly",
                    ),
                    "done": False,
                },
            )()
        return type(
            "Action",
            (),
            {
                "assistant_message": "Plan recorded",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


def test_agent_runtime_applies_update_plan_tool_and_returns_plan_steps(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PlanThenDoneAdapter(),
    )

    response = runtime.handle_user_turn("plan the repository analysis")
    stored = runtime._session_service.load_plan_state(runtime._config.session_id)

    assert response.assistant_message == "Plan recorded"
    assert response.plan_steps == (
        "in_progress: Inspect the repository layout",
        "pending: Summarize the findings",
    )
    assert stored.items[0].status is PlanStatus.IN_PROGRESS


def test_agent_runtime_accepts_provider_style_update_plan_payload(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ProviderStylePlanThenDoneAdapter(),
    )

    response = runtime.handle_user_turn("record a concise plan")
    stored = runtime._session_service.load_plan_state(runtime._config.session_id)

    assert response.assistant_message == "Plan recorded"
    assert response.plan_steps == (
        "in_progress: Stabilize runtime decisions",
        "pending: Converge provider integration",
        "pending: Run smoke validation",
    )
    assert tuple(item.id for item in stored.items) == ("step-1", "step-2", "step-3")


class SkillCaptureAdapter:
    def __init__(self) -> None:
        self.seen_messages: list[list[dict[str, object]]] = []

    def next_action(self, *, messages, tools):
        del tools
        self.seen_messages.append(messages)
        return type(
            "Action",
            (),
            {
                "assistant_message": "Skill captured",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


def test_agent_runtime_injects_loaded_skill_instructions_into_messages(tmp_path: Path) -> None:
    builtin_dir = tmp_path / "builtin-skills"
    user_dir = tmp_path / "home" / ".mycli" / "skills"
    builtin_dir.mkdir(parents=True)
    user_dir.mkdir(parents=True)
    (builtin_dir / "repository-analysis.md").write_text(
        '---\nname = "repository-analysis"\ndescription = "Inspect repos"\ntrigger_hints = ["repo"]\n---\nInspect repositories before answering.\n',
        encoding="utf-8",
    )

    adapter = SkillCaptureAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistryV2.from_tools(
            [
                ListDirectoryTool(tmp_path),
                ReadFileTool(tmp_path),
                SearchTextTool(tmp_path),
                EditFileTool(tmp_path),
                RunShellTool(tmp_path),
                UpdatePlanTool(),
            ]
        ),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
        skill_registry=SkillRegistry(builtin_root=builtin_dir, user_root=user_dir),
    )

    response = runtime.handle_user_turn("inspect this repo")

    assert response.assistant_message == "Skill captured"
    assert any(
        message.role == "user"
        and "Inspect repositories before answering." in str(message.content)
        for message in adapter.seen_messages[0]
    )
    assert not any(
        message.role == "system"
        and "Inspect repositories before answering." in str(message.content)
        for message in adapter.seen_messages[0]
    )


def test_agent_runtime_records_capability_turn_item_and_prompt_context(tmp_path: Path) -> None:
    builtin_dir = tmp_path / "builtin-skills"
    user_dir = tmp_path / "home" / ".mycli" / "skills"
    builtin_dir.mkdir(parents=True)
    user_dir.mkdir(parents=True)
    (builtin_dir / "repository-analysis.md").write_text(
        '---\nname = "repository-analysis"\ndescription = "Inspect repos"\ntrigger_hints = ["repo"]\nworkspace_dependencies = ["pyproject.toml"]\n---\nInspect repositories before answering.\n',
        encoding="utf-8",
    )
    (tmp_path / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")

    adapter = LegacySingleTurnCaptureAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistryV2.from_tools(
            [
                ListDirectoryTool(tmp_path),
                ReadFileTool(tmp_path),
                SearchTextTool(tmp_path),
                EditFileTool(tmp_path),
                RunShellTool(tmp_path),
                UpdatePlanTool(),
            ]
        ),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
        skill_registry=SkillRegistry(builtin_root=builtin_dir, user_root=user_dir),
    )

    response = runtime.handle_user_turn("inspect this repo with $repository-analysis")

    assert response.turn is not None
    assert any(item.type is TurnItemType.CAPABILITY for item in response.turn.items)
    capability_item = next(item for item in response.turn.items if item.type is TurnItemType.CAPABILITY)
    assert capability_item.metadata["capability_name"] == "repository-analysis"
    assert capability_item.metadata["source"] == "explicit_mention"
    assert any(
        getattr(message, "role", None) == "user"
        and "repository-analysis" in str(getattr(message, "content", ""))
        for message in adapter.seen_messages[0]
    )
    assert any(
        getattr(message, "role", None) == "user"
        and "explicit_mention" in str(getattr(message, "content", ""))
        for message in adapter.seen_messages[0]
    )


class FailingAdapter:
    def next_action(self, *, messages, tools):
        del messages, tools
        raise ModelResponseError("Model response content was not valid JSON.")


def test_agent_runtime_returns_readable_error_when_model_adapter_fails(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=FailingAdapter(),
    )

    response = runtime.handle_user_turn("你好")

    assert "model request failed" in response.assistant_message.lower()
    assert "not valid json" in response.assistant_message.lower()


class CompleteTaskThenDoneAdapter:
    def next_action(self, *, messages, tools):
        del messages, tools
        return type(
            "Action",
            (),
            {
                "assistant_message": "Task complete",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


def test_agent_runtime_marks_in_progress_task_completed_after_successful_turn(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=CompleteTaskThenDoneAdapter(),
    )
    runtime._session_service.save_plan_state(
        runtime._config.session_id,
        PlanState(
            items=(
                PlanItem(
                    id="inspect",
                    content="Inspect runtime entrypoints",
                    status=PlanStatus.IN_PROGRESS,
                ),
            )
        ),
    )

    response = runtime.handle_user_turn("finish the current task")
    stored = runtime._session_service.load_plan_state(runtime._config.session_id)

    assert response.assistant_message == "Task complete"
    assert stored.items[0].status is PlanStatus.COMPLETED


class MemoryCaptureAdapter:
    def __init__(self) -> None:
        self.seen_messages: list[list[object]] = []

    def next_action(self, *, messages, tools):
        del tools
        self.seen_messages.append(messages)
        return type(
            "Action",
            (),
            {
                "assistant_message": "Memory captured",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


def test_agent_runtime_uses_unified_memory_context_records(tmp_path: Path) -> None:
    memory_service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path,
    )
    memory_service.save_preference("tone", "concise")
    memory_service.save_project_note(
        MemoryRecord(
            kind=MemoryKind.PROJECT_NOTE,
            key="entrypoint",
            value="src/mycli/cli/main.py",
            tags=("repo",),
        )
    )
    memory_service.append_session_summary("demo", "Inspected the repo root")

    adapter = MemoryCaptureAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime._memory_service = memory_service
    runtime._config = AgentConfig(workspace_root=tmp_path, session_id="demo")

    response = runtime.handle_user_turn("inspect this repo")

    assert response.assistant_message == "Memory captured"
    contextual_user_content = "\n".join(
        str(getattr(message, "content", ""))
        for message in adapter.seen_messages[0]
        if getattr(message, "role", None) == "user"
    )
    assert "concise" in contextual_user_content
    assert "src/mycli/cli/main.py" in contextual_user_content
    assert "Inspected the repo root" not in contextual_user_content


def test_agent_runtime_emits_trace_for_tool_execution(tmp_path: Path) -> None:
    adapter = InspectThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    runtime.handle_user_turn("inspect the repo")

    trace_service = TraceService(home_dir=tmp_path / "home")
    loaded = trace_service.load(runtime._config.session_id)

    assert any(
        event.kind == "tool_execution"
        and event.payload.get("tool_name") == "list_directory"
        for event in loaded
    )
    assert any(event.kind == "tool_exposure" for event in loaded)
    assert any(event.kind == "runtime_policy" for event in loaded)
    assert any(event.kind == "instruction_contract" for event in loaded)
    request_shape = next(event for event in loaded if event.kind == "request_shape")
    assert request_shape.payload["provider"] == "openai"
    assert request_shape.payload["system_hash"]
    assert request_shape.payload["tool_schema_hash"]
    assert request_shape.payload["tool_order_hash"]
    assert request_shape.payload["fragment_hashes"]["intent:current"]


class RepeatMissingReadAdapter:
    def next_turn(self, *, items, tools):
        del items, tools
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(
                        RuntimeBlock(
                            type="tool_call",
                            tool_name="read_file",
                            tool_arguments={"path": "missing.py"},
                            call_id="call_repeat_read",
                        ),
                    ),
                ),
            ),
            done=False,
        )


class OverviewForceAnswerAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_tool_counts: list[int] = []

    def next_turn(self, *, items, tools):
        del items
        self.calls += 1
        self.seen_tool_counts.append(len(tools))
        if self.calls == 1:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="list_directory",
                                tool_arguments={"path": "."},
                                call_id="call_list_root",
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        if self.calls == 2:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="read_file",
                                tool_arguments={"path": "pyproject.toml"},
                                call_id="call_read_pyproject",
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        if tools:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="list_directory",
                                tool_arguments={"path": "src"},
                                call_id="call_list_src",
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="入口在 CLI，主要模块在 src/mycli 下。"),),
                ),
            ),
            done=True,
        )


class CaptureToolExposureAdapter:
    def __init__(self) -> None:
        self.seen_tool_names: list[list[str]] = []

    def next_turn(self, *, items, tools):
        del items
        self.seen_tool_names.append([tool.name for tool in tools])
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Inspection complete"),),
                ),
            ),
            done=True,
        )


class ImplementationAuditForceAnswerAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_tool_counts: list[int] = []

    def next_turn(self, *, items, tools):
        del items
        self.calls += 1
        self.seen_tool_counts.append(len(tools))
        if self.calls == 1:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="search_text",
                                tool_arguments={"query": "capability activation", "path": ".", "glob": "*.py"},
                                call_id="call_search_capability_activation",
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        if self.calls == 2:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="read_file",
                                tool_arguments={"path": "src/mycli/services/context/turn_context_assembler.py"},
                                call_id="call_read_turn_context_assembler",
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        if self.calls == 3:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="read_file",
                                tool_arguments={"path": "src/mycli/application/runtime/agent_runtime.py"},
                                call_id="call_read_agent_runtime",
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        if tools:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="search_text",
                                tool_arguments={"query": "trace", "path": ".", "glob": "*.py"},
                                call_id="call_search_trace_again",
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Implementation audit complete."),),
                ),
            ),
            done=True,
        )


class DeferredToolRequestAdapter:
    def next_turn(self, *, items, tools):
        del items, tools
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(
                        RuntimeBlock(
                            type="tool_call",
                            tool_name="run_shell",
                            tool_arguments={"args": ["pwd"]},
                            call_id="call_run_shell_deferred",
                        ),
                    ),
                ),
            ),
            done=False,
        )


class DynamicSummaryTool:
    def __init__(self) -> None:
        self.spec = ToolSpec(
            name="workspace_summary",
            description="Summarize workspace",
            parameters=(ToolParameter(name="path", type="string", required=False),),
        )

    def execute(self, arguments: dict[str, object]) -> ToolResultV2:
        del arguments
        return ToolResultV2(success=True, summary="Workspace summary ready", raw_payload={"path": "."})


class OverviewDynamicToolProvider(DynamicToolProvider):
    def provide(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        capability_activations,
    ) -> tuple[object, ...]:
        del conversation, plan_state, capability_activations
        if "概览" not in user_message and "overview" not in user_message.lower():
            return ()
        tool = DynamicSummaryTool()
        return (
            DynamicToolRegistration(
                descriptor=DynamicToolDescriptor(
                    tool_id="provider:workspace_summary:thread",
                    display_name="workspace_summary",
                    description="Summarize workspace",
                    route_key=ToolRouteKey.local("workspace_summary"),
                    source=DynamicToolSource.PROVIDER,
                    scope=DynamicToolScope.THREAD,
                    lifecycle_state=DynamicToolLifecycleState.DECLARED,
                    spec=tool.spec,
                ),
                tool=tool,
            ),
        )


class DynamicToolAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_tool_names: list[list[str]] = []

    def next_turn(self, *, items, tools):
        del items
        self.calls += 1
        self.seen_tool_names.append([tool.name for tool in tools])
        if self.calls == 1:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="workspace_summary",
                                tool_arguments={"path": "."},
                                call_id="call_workspace_summary_1",
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Dynamic summary complete"),),
                ),
            ),
            done=True,
        )


def test_agent_runtime_persists_turn_record_with_stop_reason(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ReasoningTextDoneAdapter(),
    )

    response = runtime.handle_user_turn("inspect the repo")
    stored_turn = runtime._session_service.load_turn_record(runtime._config.session_id)

    assert response.turn is not None
    assert response.turn.status is TurnStatus.COMPLETED
    assert response.turn.stop_reason is StopReason.ASSISTANT_COMPLETED
    assert stored_turn is not None
    assert stored_turn.turn_id == response.turn.turn_id
    assert any(item.type is TurnItemType.USER_MESSAGE for item in response.turn.items)
    assert any(item.type is TurnItemType.REASONING for item in response.turn.items)
    assert any(item.type is TurnItemType.ASSISTANT_MESSAGE for item in response.turn.items)


def test_agent_runtime_persists_structured_history_baseline_and_rollout_for_completed_turn(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ReasoningTextDoneAdapter(),
    )

    response = runtime.handle_user_turn("inspect the repo")
    history_items = runtime._session_service.load_history_items(runtime._config.session_id)
    baseline = runtime._session_service.load_context_baseline(runtime._config.session_id)
    rollouts = runtime._session_service.load_turn_rollouts(runtime._config.session_id)

    assert response.turn is not None
    assert any(item.type is HistoryItemType.USER_MESSAGE for item in history_items)
    assert any(item.type is HistoryItemType.REASONING for item in history_items)
    assert any(item.type is HistoryItemType.ASSISTANT_MESSAGE for item in history_items)
    assert baseline is not None
    assert isinstance(baseline, ContextBaseline)
    assert baseline.fragments
    assert any(fragment.kind == "runtime_policy" for fragment in baseline.fragments)
    assert rollouts
    assert isinstance(rollouts[0], TurnRollout)
    assert rollouts[0].turn_id == response.turn.turn_id
    assert rollouts[0].status is TurnStatus.COMPLETED
    assert rollouts[0].stop_reason is StopReason.ASSISTANT_COMPLETED


def test_agent_runtime_persists_tool_calls_and_results_into_structured_history(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ReasoningToolThenDoneAdapter(),
    )
    (tmp_path / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")

    response = runtime.handle_user_turn("inspect the repo")
    history_items = runtime._session_service.load_history_items(runtime._config.session_id)

    assert response.turn is not None
    assert any(item.type is HistoryItemType.TOOL_CALL for item in history_items)
    assert any(item.type is HistoryItemType.TOOL_RESULT for item in history_items)
    tool_result = next(item for item in history_items if item.type is HistoryItemType.TOOL_RESULT)
    assert tool_result.tool_name == "read_file"
    assert tool_result.metadata["success"] is True


def test_agent_runtime_build_context_uses_runtime_snapshot_history_and_baseline(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ReasoningTextDoneAdapter(),
    )
    runtime._session_service.append_history_items(
        runtime._config.session_id,
        (
            HistoryItem(
                id="hist_1",
                thread_id=runtime._config.session_id,
                turn_id="turn_1",
                type=HistoryItemType.USER_MESSAGE,
                text="inspect repo",
            ),
            HistoryItem(
                id="hist_2",
                thread_id=runtime._config.session_id,
                turn_id="turn_1",
                type=HistoryItemType.ASSISTANT_MESSAGE,
                text="I inspected the repo root.",
            ),
        ),
    )
    runtime._session_service.save_context_baseline(
        runtime._config.session_id,
        ContextBaseline(
            thread_id=runtime._config.session_id,
            fragments=(
                BaselineFragment(
                    id="workspace",
                    kind="workspace_instructions",
                    title="Workspace instructions",
                    content="Prefer focused diffs.",
                ),
            ),
        ),
    )

    context = runtime._build_context(
        user_message="continue",
        conversation=Conversation(session_id=runtime._config.session_id),
        plan_state=PlanState(),
    )

    assert context.history_items
    assert context.history_items[0].type is HistoryItemType.USER_MESSAGE
    assert context.context_baseline is not None
    assert context.context_baseline.fragments[0].content == "Prefer focused diffs."
    assert [message.role for message in context.conversation_messages] == ["user", "assistant"]


def test_agent_runtime_build_context_reconstructs_block_aware_messages_from_history(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ReasoningTextDoneAdapter(),
    )
    runtime._session_service.append_history_items(
        runtime._config.session_id,
        (
            HistoryItem(
                id="hist_user_1",
                thread_id=runtime._config.session_id,
                turn_id="turn_1",
                type=HistoryItemType.USER_MESSAGE,
                text="inspect repo",
            ),
            HistoryItem(
                id="hist_tool_call_1",
                thread_id=runtime._config.session_id,
                turn_id="turn_1",
                type=HistoryItemType.TOOL_CALL,
                text="Reading: pyproject.toml",
                tool_name="read_file",
                call_id="call_read_1",
                metadata={"arguments": {"path": "pyproject.toml"}},
            ),
            HistoryItem(
                id="hist_tool_result_1",
                thread_id=runtime._config.session_id,
                turn_id="turn_1",
                type=HistoryItemType.TOOL_RESULT,
                text="Read pyproject.toml",
                tool_name="read_file",
                call_id="call_read_1",
                metadata={"transcript_content": "Read pyproject.toml"},
            ),
        ),
    )

    context = runtime._build_context(
        user_message="continue",
        conversation=Conversation(session_id=runtime._config.session_id),
        plan_state=PlanState(),
    )

    assert [message.role for message in context.conversation_messages] == ["user", "assistant", "tool"]
    assert context.conversation_messages[1].blocks[0].type == "tool_call"
    assert context.conversation_messages[1].blocks[0].tool_arguments == {"path": "pyproject.toml"}
    assert context.conversation_messages[2].blocks[0].type == "tool_result"


def test_agent_runtime_runtime_items_allow_responses_adapter_to_consume_history_derived_tool_blocks(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ReasoningTextDoneAdapter(),
    )
    runtime._session_service.append_history_items(
        runtime._config.session_id,
        (
            HistoryItem(
                id="hist_user_1",
                thread_id=runtime._config.session_id,
                turn_id="turn_1",
                type=HistoryItemType.USER_MESSAGE,
                text="inspect repo",
            ),
            HistoryItem(
                id="hist_tool_call_1",
                thread_id=runtime._config.session_id,
                turn_id="turn_1",
                type=HistoryItemType.TOOL_CALL,
                text="Reading: pyproject.toml",
                tool_name="read_file",
                call_id="call_read_1",
                metadata={"arguments": {"path": "pyproject.toml"}},
            ),
            HistoryItem(
                id="hist_tool_result_1",
                thread_id=runtime._config.session_id,
                turn_id="turn_1",
                type=HistoryItemType.TOOL_RESULT,
                text="Read pyproject.toml",
                tool_name="read_file",
                call_id="call_read_1",
                metadata={"transcript_content": "Read pyproject.toml"},
            ),
        ),
    )
    context = runtime._build_context(
        user_message="continue",
        conversation=Conversation(session_id=runtime._config.session_id),
        plan_state=PlanState(),
    )
    turn_context = runtime._turn_context_assembler.assemble(
        user_message="continue",
        context=context,
    )
    contract = runtime._assemble_instruction_contract(
        turn_id="turn_capture",
        context=context,
        turn_context=turn_context,
    )
    request_shape = runtime._request_shape_builder.build(
        config=runtime._config,
        contract=contract,
        tools=(),
    )
    runtime_items = runtime._build_runtime_items(request_shape=request_shape)
    client = CapturingResponsesClient()
    adapter = ResponsesModelAdapter(client=client)

    adapter.next_turn(items=runtime_items, tools=[])

    assert any(
        item.get("type") == "function_call"
        and item.get("call_id") == "call_read_1"
        and item.get("name") == "read_file"
        for item in client.captured_input_items
    )
    assert any(
        item.get("type") == "function_call_output"
        and item.get("call_id") == "call_read_1"
        and item.get("output") == "Read pyproject.toml"
        for item in client.captured_input_items
    )


def test_agent_runtime_loads_continuation_state_from_rollout_when_state_file_is_missing(
    tmp_path: Path,
) -> None:
    adapter = ContinuationAwareDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime._session_service.append_turn_rollout(
        runtime._config.session_id,
        TurnRollout(
            thread_id=runtime._config.session_id,
            turn_id="turn_prev",
            status=TurnStatus.COMPLETED,
            started_at="2026-04-15T00:00:00+00:00",
            completed_at="2026-04-15T00:00:01+00:00",
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            continuation_state={
                "response_id": "resp_rollout_1",
                "request_signature": '{"model":"gpt-test"}',
                "request_input": [],
                "response_output": [],
                "eligible": True,
                "failure_reason": None,
            },
        ),
    )

    runtime._load_model_continuation_state(turn_id="turn_new")

    assert adapter.loaded_state is not None
    assert adapter.loaded_state.response_id == "resp_rollout_1"


def test_agent_runtime_converts_missing_file_reads_into_recoverable_loop_stop(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=RepeatMissingReadAdapter(),
    )
    runtime._config = AgentConfig(workspace_root=tmp_path, max_steps=6)

    response = runtime.handle_user_turn("请简短总结这个仓库的入口文件和主要模块")

    assert response.turn is not None
    assert response.turn.stop_reason is StopReason.LOOP_DETECTED
    assert response.turn.status is TurnStatus.COMPLETED
    assert "repeated exploration" in response.assistant_message.lower()
    assert any(
        item.type is TurnItemType.TOOL_RESULT
        and item.metadata.get("success") is False
        and item.metadata.get("error_kind") == "not_found"
        for item in response.turn.items
    )


def test_agent_runtime_forces_answer_mode_when_overview_evidence_is_sufficient(
    tmp_path: Path,
) -> None:
    adapter = OverviewForceAnswerAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    (tmp_path / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")
    runtime._config = AgentConfig(workspace_root=tmp_path, max_steps=6)

    response = runtime.handle_user_turn("请分析这个仓库的入口文件和主要模块，给我一个简短总结。")

    assert response.assistant_message == "入口在 CLI，主要模块在 src/mycli 下。"
    assert response.turn is not None
    assert response.turn.stop_reason is StopReason.ASSISTANT_COMPLETED
    assert adapter.seen_tool_counts[-1] == 0
    assert any(
        item.type is TurnItemType.REASONING and item.text == "Planning: 正在检查仓库结构"
        for item in response.turn.items
    )
    assert any(
        item.type is TurnItemType.REASONING and item.text == "Planning: 已从确认的证据收口回答"
        for item in response.turn.items
    )


def test_agent_runtime_limits_model_tools_to_planned_exposure(tmp_path: Path) -> None:
    adapter = CaptureToolExposureAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistryV2.from_tools(
            [
                ListDirectoryTool(tmp_path),
                ReadFileTool(tmp_path),
                SearchTextTool(tmp_path),
                RunShellTool(tmp_path),
                EditFileTool(tmp_path),
                UpdatePlanTool(),
            ]
        ),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
    )

    response = runtime.handle_user_turn("please inspect this repository and summarize it")

    assert response.turn is not None
    assert "list_directory" in adapter.seen_tool_names[0]
    assert "read_file" in adapter.seen_tool_names[0]
    assert "run_shell" in adapter.seen_tool_names[0]
    assert "edit_file" in adapter.seen_tool_names[0]
    assert any(item.type is TurnItemType.TOOL_EXPOSURE for item in response.turn.items)


def test_agent_runtime_executes_deferred_tool_calls_from_model(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_adapter=DeferredToolRequestAdapter(),
        tool_registry=ToolRegistryV2.from_tools(
            [
                ListDirectoryTool(tmp_path),
                RunShellTool(tmp_path),
            ]
        ),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
    )

    response = runtime.handle_user_turn("please inspect this repository and summarize it")

    assert response.turn is not None
    assert response.turn.status is TurnStatus.COMPLETED
    assert any(
        item.type is TurnItemType.TOOL_RESULT and item.tool_name == "run_shell"
        for item in response.turn.items
    )


def test_agent_runtime_executes_runtime_dynamic_tool_via_router(tmp_path: Path) -> None:
    adapter = DynamicToolAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistryV2.from_tools([ListDirectoryTool(tmp_path)]),
        config=AgentConfig(workspace_root=tmp_path, max_steps=4),
        home_dir=tmp_path / "home",
    )
    runtime._runtime_dynamic_tools = lambda **_kwargs: (DynamicSummaryTool(),)

    response = runtime.handle_user_turn("summarize the workspace")

    assert response.turn is not None
    assert response.assistant_message == "Dynamic summary complete"
    assert "workspace_summary" in adapter.seen_tool_names[0]
    assert any(
        item.type is TurnItemType.TOOL_RESULT and item.tool_name == "workspace_summary"
        for item in response.turn.items
    )


def test_agent_runtime_records_dynamic_tool_lifecycle_and_persists_thread_snapshot(
    tmp_path: Path,
) -> None:
    adapter = DynamicToolAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistryV2.from_tools([ListDirectoryTool(tmp_path)]),
        config=AgentConfig(workspace_root=tmp_path, max_steps=4),
        home_dir=tmp_path / "home",
    )
    thread_tool = DynamicSummaryTool()
    runtime._runtime_dynamic_tools = lambda **_kwargs: (
        DynamicToolRegistration(
            descriptor=DynamicToolDescriptor(
                tool_id="runtime:workspace_summary:thread",
                display_name="workspace_summary",
                description="Summarize workspace",
                route_key=runtime._tool_exposure_planner._route_key_for_tool_name("workspace_summary"),
                source=DynamicToolSource.RUNTIME,
                scope=DynamicToolScope.THREAD,
                lifecycle_state=DynamicToolLifecycleState.DECLARED,
                spec=thread_tool.spec,
            ),
            tool=thread_tool,
        ),
    )

    response = runtime.handle_user_turn("summarize the workspace")
    trace_service = TraceService(home_dir=tmp_path / "home")
    trace = trace_service.load(runtime._config.session_id)
    snapshot = runtime._session_service.load_dynamic_tool_state(runtime._config.session_id)

    assert response.turn is not None
    assert any(item.type is TurnItemType.DYNAMIC_TOOL for item in response.turn.items)
    assert snapshot == [
        {
            "tool_id": "runtime:workspace_summary:thread",
            "display_name": "workspace_summary",
            "description": "Summarize workspace",
            "route_name": "workspace_summary",
            "source": "runtime",
            "scope": "thread",
            "state": "completed",
            "origin_metadata": {},
        }
    ]
    lifecycle_events = [
        event for event in trace if event.kind == "dynamic_tool_lifecycle"
    ]
    assert [event.payload["state"] for event in lifecycle_events] == [
        "declared",
        "exposed",
        "invoked",
        "completed",
    ]


def test_agent_runtime_reexposes_thread_scoped_dynamic_tools_on_later_turns(tmp_path: Path) -> None:
    adapter = DynamicToolAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistryV2.from_tools([ListDirectoryTool(tmp_path)]),
        config=AgentConfig(workspace_root=tmp_path, max_steps=4),
        home_dir=tmp_path / "home",
    )
    thread_tool = DynamicSummaryTool()
    registration = DynamicToolRegistration(
        descriptor=DynamicToolDescriptor(
            tool_id="runtime:workspace_summary:thread",
            display_name="workspace_summary",
            description="Summarize workspace",
            route_key=runtime._tool_exposure_planner._route_key_for_tool_name("workspace_summary"),
            source=DynamicToolSource.RUNTIME,
            scope=DynamicToolScope.THREAD,
            lifecycle_state=DynamicToolLifecycleState.DECLARED,
            spec=thread_tool.spec,
        ),
        tool=thread_tool,
    )
    runtime._runtime_dynamic_tools = lambda **_kwargs: (registration,)

    first = runtime.handle_user_turn("summarize the workspace")
    second = runtime.handle_user_turn("do I still have my helper tool?")

    assert first.turn is not None
    assert second.turn is not None
    assert "workspace_summary" in adapter.seen_tool_names[0]
    assert "workspace_summary" in adapter.seen_tool_names[-1]


def test_agent_runtime_accepts_provider_contributed_dynamic_tool_for_overview_requests(
    tmp_path: Path,
) -> None:
    adapter = DynamicToolAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistryV2.from_tools([ListDirectoryTool(tmp_path)]),
        config=AgentConfig(workspace_root=tmp_path, max_steps=4),
        home_dir=tmp_path / "home",
        dynamic_tool_providers=(OverviewDynamicToolProvider(),),
    )
    (tmp_path / "README.md").write_text("# demo\n", encoding="utf-8")
    (tmp_path / "src").mkdir()

    response = runtime.handle_user_turn("请先给我一个这个工作区的概览")

    assert response.turn is not None
    assert "workspace_summary" in adapter.seen_tool_names[0]
    assert any(
        item.type is TurnItemType.DYNAMIC_TOOL and item.tool_name == "workspace_summary"
        for item in response.turn.items
    )


def test_agent_runtime_forces_answer_mode_for_implementation_audit_after_source_evidence(
    tmp_path: Path,
) -> None:
    adapter = ImplementationAuditForceAnswerAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    (tmp_path / "src" / "mycli" / "services" / "context").mkdir(parents=True, exist_ok=True)
    (tmp_path / "src" / "mycli" / "application" / "runtime").mkdir(parents=True, exist_ok=True)
    (tmp_path / "src" / "mycli" / "services" / "context" / "turn_context_assembler.py").write_text(
        "class TurnContextAssembler: ...\n",
        encoding="utf-8",
    )
    (tmp_path / "src" / "mycli" / "application" / "runtime" / "agent_runtime.py").write_text(
        "class AgentRuntime: ...\n",
        encoding="utf-8",
    )
    runtime._config = AgentConfig(workspace_root=tmp_path, max_steps=6)

    response = runtime.handle_user_turn(
        "请检查 turn context、runtime 和 trace 是否已经接入 capability activation。"
    )

    assert response.assistant_message == "Implementation audit complete."
    assert response.turn is not None
    assert adapter.seen_tool_counts[-1] == 0
    assert any(event.kind == "runtime_policy" for event in response.activity_events)
