from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.domain.runtime import StopReason
from mycli.domain.tools import ToolCall
from mycli.services.hooks import HookAction, HookContext, HookPoint, HookResult
from mycli.services.tracing import TraceService


class LoopingDirectoryAdapter:
    def __init__(self) -> None:
        self.seen_tool_counts: list[int] = []

    def next_action(self, *, messages, tools):
        self.seen_tool_counts.append(len(tools))
        payload = "\n".join(str(getattr(message, "content", "")) for message in messages)
        if (
            not tools
            or
            "Do not call more tools" in payload
            or "Do not call tools" in payload
            or "Answer now" in payload
        ):
            return type(
                "Action",
                (),
                {
                    "assistant_message": "I inspected the repository and can summarize from gathered evidence.",
                    "progress_message": None,
                    "tool_call": None,
                    "done": True,
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


class CaptureMessagesDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_messages: list[list[object]] = []

    def next_action(self, *, messages, tools):
        del tools
        self.calls += 1
        self.seen_messages.append(messages)
        return type(
            "Action",
            (),
            {
                "assistant_message": f"done {self.calls}",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


def test_turn_executor_forces_answer_after_repeated_successful_tool_loop(
    tmp_path: Path,
) -> None:
    from mycli.application.runtime.turn_executor import TurnExecutor

    adapter = LoopingDirectoryAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = TurnExecutor(runtime).execute_user_turn("inspect the repo")

    assert response.turn is not None
    assert response.turn.stop_reason is StopReason.ASSISTANT_COMPLETED
    assert "summarize from gathered evidence" in response.assistant_message
    assert adapter.seen_tool_counts[0] > 0
    assert adapter.seen_tool_counts[-1] > 0


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
    runtime._config = replace(runtime._config, memory_enabled=False)

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


def test_user_prompt_submit_hook_can_block_before_model_call(tmp_path: Path) -> None:
    from mycli.application.runtime.turn_executor import TurnExecutor

    adapter = CaptureMessagesDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    def block_prompt(ctx: HookContext) -> HookResult:
        assert ctx.hook_point is HookPoint.USER_PROMPT_SUBMIT
        return HookResult(action=HookAction.DENY, message="blocked prompt")

    runtime._hook_manager.register(
        HookPoint.USER_PROMPT_SUBMIT,
        block_prompt,
        name="test:block_prompt",
    )

    response = TurnExecutor(runtime).execute_user_turn("do the thing")

    assert response.assistant_message == "blocked prompt"
    assert response.turn is not None
    assert response.turn.status.value == "rejected"
    assert adapter.calls == 0


def test_user_prompt_submit_context_enters_model_without_changing_user_input(
    tmp_path: Path,
) -> None:
    from mycli.application.runtime.turn_executor import TurnExecutor

    adapter = CaptureMessagesDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    def add_context(ctx: HookContext) -> HookResult:
        assert ctx.hook_point is HookPoint.USER_PROMPT_SUBMIT
        return HookResult(
            action=HookAction.ALLOW,
            additional_contexts=("hook context visible",),
        )

    runtime._hook_manager.register(
        HookPoint.USER_PROMPT_SUBMIT,
        add_context,
        name="test:add_context",
    )

    response = TurnExecutor(runtime).execute_user_turn("actual prompt")

    assert response.assistant_message == "done 1"
    assert adapter.seen_messages
    rendered = "\n".join(str(message) for message in adapter.seen_messages[0])
    assert "hook context visible" in rendered
    user_lines = [
        str(message)
        for message in adapter.seen_messages[0]
        if getattr(message, "role", None) == "user"
    ]
    assert any("actual prompt" in line for line in user_lines)
    assert not any("Current user request: actual prompt" in line for line in user_lines)


def test_stop_hook_block_continues_model_loop(tmp_path: Path) -> None:
    from mycli.application.runtime.turn_executor import TurnExecutor

    adapter = CaptureMessagesDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    stop_calls = 0

    def block_once(ctx: HookContext) -> HookResult:
        nonlocal stop_calls
        assert ctx.hook_point is HookPoint.STOP
        stop_calls += 1
        if stop_calls == 1:
            return HookResult(action=HookAction.DENY, message="need one more step")
        return HookResult(action=HookAction.ALLOW)

    runtime._hook_manager.register(
        HookPoint.STOP,
        block_once,
        name="test:block_once",
    )

    response = TurnExecutor(runtime).execute_user_turn("answer")

    assert response.assistant_message == "done 2"
    assert stop_calls == 2
    assert any("[hook] stop blocked; continuing" == item for item in response.progress_updates)
