from __future__ import annotations

from pathlib import Path

from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.domain.runtime import StopReason
from mycli.domain.tools import ToolCall
from mycli.services.tracing import TraceService


class LoopingDirectoryAdapter:
    def next_action(self, *, messages, tools):
        del messages, tools
        return type(
            "Action",
            (),
            {
                "assistant_message": None,
                "progress_message": "Still exploring",
                "tool_call": ToolCall(
                    name="LS",
                    arguments={"path": "."},
                    reason="keep exploring",
                ),
                "done": False,
            },
        )()


class PushThenLoopAdapter:
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
                        name="Bash",
                        arguments={"command": "git push origin main"},
                        reason="publish branch",
                    ),
                    "done": False,
                },
            )()
        return type(
            "Action",
            (),
            {
                "assistant_message": None,
                "progress_message": "Still exploring",
                "tool_call": ToolCall(
                    name="LS",
                    arguments={"path": "."},
                    reason="keep exploring",
                ),
                "done": False,
            },
        )()


class ThirdStepCompletionAdapter:
    def __init__(self) -> None:
        self.calls = 0

    def next_action(self, *, messages, tools):
        del messages, tools
        self.calls += 1
        if self.calls < 3:
            return type(
                "Action",
                (),
                {
                    "assistant_message": None,
                    "progress_message": "Exploring before answering",
                    "tool_call": ToolCall(
                        name="LS",
                        arguments={"path": "."},
                        reason="inspect workspace",
                    ),
                    "done": False,
                },
            )()
        return type(
            "Action",
            (),
            {
                "assistant_message": "I found the answer after one extra step.",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


class RepeatedMissingReadAdapter:
    def next_action(self, *, messages, tools):
        del messages, tools
        return type(
            "Action",
            (),
            {
                "assistant_message": None,
                "progress_message": "Retrying missing read",
                "tool_call": ToolCall(
                    name="Read",
                    arguments={"file_path": "missing.py"},
                    reason="inspect missing file",
                ),
                "done": False,
            },
        )()


def test_turn_executor_stops_repeated_tool_loop_without_step_limit(
    tmp_path: Path,
) -> None:
    from mycli.application.runtime.turn_executor import TurnExecutor

    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=LoopingDirectoryAdapter(),
    )

    response = TurnExecutor(runtime).execute_user_turn("inspect the repo")

    assert response.turn is not None
    assert response.turn.stop_reason is StopReason.LOOP_DETECTED
    assert "repeated exploration" in response.assistant_message.lower()


def test_turn_executor_records_guardrail_trace_for_repeated_tool_failure(
    tmp_path: Path,
) -> None:
    from mycli.application.runtime.turn_executor import TurnExecutor

    home_dir = tmp_path / "home"
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=home_dir,
        model_adapter=RepeatedMissingReadAdapter(),
    )

    response = TurnExecutor(runtime).execute_user_turn("inspect missing file")

    assert response.turn is not None
    assert response.turn.stop_reason is StopReason.LOOP_DETECTED
    assert "repeated failed tool" in response.assistant_message.lower()
    warning = next(item for item in response.turn.items if item.type.value == "warning")
    assert warning.metadata["exit_reason"] == "repeated_tool_failure"
    assert warning.metadata["guardrail"]["tool_name"] == "Read"
    trace = TraceService(home_dir=home_dir).load(runtime._config.session_id)
    guardrail = next(event for event in trace if event.kind == "guardrail")
    assert guardrail.payload["exit_reason"] == "repeated_tool_failure"
    assert guardrail.payload["trigger"] == "repeated_failed_tool_result"
    assert guardrail.payload["tool_name"] == "Read"
    assert guardrail.payload["path"] == "missing.py"


def test_turn_executor_allows_completion_after_multiple_tool_calls(tmp_path: Path) -> None:
    from mycli.application.runtime.turn_executor import TurnExecutor

    adapter = ThirdStepCompletionAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = TurnExecutor(runtime).execute_user_turn("inspect the repo and then answer")

    assert response.turn is not None
    assert response.turn.stop_reason is StopReason.ASSISTANT_COMPLETED
    assert response.assistant_message == "I found the answer after one extra step."
    assert adapter.calls == 3


def test_turn_executor_handles_resumed_approval_loop_detection(tmp_path: Path) -> None:
    from mycli.application.runtime.turn_executor import TurnExecutor

    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenLoopAdapter(),
    )

    first = runtime.handle_user_turn("push the branch")
    assert first.pending_decision is not None

    resumed = TurnExecutor(runtime).resolve_pending_approval("1")

    assert resumed.turn is not None
    assert resumed.turn.stop_reason is StopReason.LOOP_DETECTED
    assert "repeated exploration" in resumed.assistant_message.lower()
