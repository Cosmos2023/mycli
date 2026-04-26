from __future__ import annotations

from pathlib import Path

from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.domain.runtime import AgentConfig, StopReason
from mycli.domain.tools import ToolCall


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
                    name="list_directory",
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
                "assistant_message": None,
                "progress_message": "Still exploring",
                "tool_call": ToolCall(
                    name="list_directory",
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
                        name="list_directory",
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


def test_turn_executor_prefers_loop_detection_before_compatibility_step_limit(
    tmp_path: Path,
) -> None:
    from mycli.application.runtime.turn_executor import TurnExecutor

    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=LoopingDirectoryAdapter(),
    )
    runtime._config = AgentConfig(workspace_root=tmp_path, max_steps=2)

    response = TurnExecutor(runtime).execute_user_turn("inspect the repo")

    assert response.turn is not None
    assert response.turn.stop_reason is StopReason.LOOP_DETECTED
    assert "repeated exploration" in response.assistant_message.lower()


def test_turn_executor_allows_completion_beyond_configured_soft_budget(tmp_path: Path) -> None:
    from mycli.application.runtime.turn_executor import TurnExecutor

    adapter = ThirdStepCompletionAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime._config = AgentConfig(workspace_root=tmp_path, max_steps=2)

    response = TurnExecutor(runtime).execute_user_turn("inspect the repo and then answer")

    assert response.turn is not None
    assert response.turn.stop_reason is StopReason.ASSISTANT_COMPLETED
    assert response.assistant_message == "I found the answer after one extra step."
    assert adapter.calls == 3


def test_turn_executor_handles_resumed_approval_step_limit(tmp_path: Path) -> None:
    from mycli.application.runtime.turn_executor import TurnExecutor

    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenLoopAdapter(),
    )
    runtime._config = AgentConfig(workspace_root=tmp_path, max_steps=2)

    first = runtime.handle_user_turn("push the branch")
    assert first.pending_decision is not None

    resumed = TurnExecutor(runtime).resolve_pending_approval("1")

    assert resumed.turn is not None
    assert resumed.turn.stop_reason is StopReason.MAX_STEPS_REACHED
    assert resumed.assistant_message == "I hit the step limit before reaching a confident answer."
