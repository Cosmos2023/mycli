from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from threading import Event, Thread
from time import monotonic

from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.application.runtime.turn_executor import _has_visible_turn_activity
from mycli.domain.runtime import (
    RuntimeBlock,
    RuntimeInterruptToken,
    RuntimeItem,
    StopReason,
    TurnItem,
    TurnItemType,
    TurnStatus,
)
from mycli.domain.tools import ToolCall
from mycli.services.hooks import HookAction, HookContext, HookPoint, HookResult
from mycli.services.tracing import TraceService


class LoopingDirectoryAdapter:
    def __init__(self) -> None:
        self.seen_tool_counts: list[int] = []

    def next_action(self, *, messages, tools):
        del messages
        self.seen_tool_counts.append(len(tools))
        if len(self.seen_tool_counts) >= 5:
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
                        name="Shell",
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
    def __init__(self) -> None:
        self.calls = 0

    def next_action(self, *, messages, tools):
        del messages, tools
        self.calls += 1
        if self.calls >= 4:
            return type(
                "Action",
                (),
                {
                    "assistant_message": "The file is missing, so I stopped retrying and summarized the result.",
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


class InterruptibleBlockingContributionProvider:
    def __init__(self) -> None:
        self.started = Event()

    def provide(
        self,
        *,
        user_message,
        conversation,
        plan_state,
        interrupt_token=None,
    ):
        del user_message, conversation, plan_state
        self.started.set()
        if interrupt_token is None:
            Event().wait(2)
            return ()
        interrupt_token.wait(2)
        interrupt_token.raise_if_interrupted()
        return ()


class UncooperativeBlockingContributionProvider:
    def __init__(self) -> None:
        self.started = Event()

    def provide(
        self,
        *,
        user_message,
        conversation,
        plan_state,
        interrupt_token=None,
    ):
        del user_message, conversation, plan_state, interrupt_token
        self.started.set()
        Event().wait(2)
        return ()


class ApprovalThenSiblingToolsAdapter:
    def __init__(self, workspace_root: Path) -> None:
        self.workspace_root = workspace_root
        self.calls = 0
        self.seen_items: list[list[RuntimeItem]] = []

    def stream_turn(self, *, items, tools):
        del tools
        self.calls += 1
        self.seen_items.append(items)
        if self.calls == 1:
            blocks = (
                RuntimeBlock(
                    type="tool_call",
                    tool_name="Shell",
                    tool_arguments={
                        "command": "touch approval-marker.txt",
                        "cwd": str(self.workspace_root),
                    },
                    call_id="call_needs_approval",
                    provider_id="fc_needs_approval",
                ),
                RuntimeBlock(
                    type="tool_call",
                    tool_name="LS",
                    tool_arguments={"path": str(self.workspace_root)},
                    call_id="call_sibling_ls_1",
                    provider_id="fc_sibling_ls_1",
                ),
                RuntimeBlock(
                    type="tool_call",
                    tool_name="LS",
                    tool_arguments={"path": str(self.workspace_root)},
                    call_id="call_sibling_ls_2",
                    provider_id="fc_sibling_ls_2",
                ),
            )
            for block in blocks:
                yield {"type": "tool_call", "block": block}
                yield {
                    "type": "item_completed",
                    "item": RuntimeItem(role="assistant", blocks=(block,)),
                }
            yield {
                "type": "completed",
                "response_id": "resp_approval_batch",
                "metadata": {},
            }
            return
        yield {"type": "text_delta", "text": "All sibling tools completed."}
        yield {
            "type": "completed",
            "response_id": "resp_after_approval_batch",
            "metadata": {},
        }


class TwoApprovalsThenSiblingToolAdapter(ApprovalThenSiblingToolsAdapter):
    def stream_turn(self, *, items, tools):
        del tools
        self.calls += 1
        self.seen_items.append(items)
        if self.calls == 1:
            blocks = (
                RuntimeBlock(
                    type="tool_call",
                    tool_name="Shell",
                    tool_arguments={
                        "command": "touch approval-marker-1.txt",
                        "cwd": str(self.workspace_root),
                    },
                    call_id="call_needs_approval_1",
                    provider_id="fc_needs_approval_1",
                ),
                RuntimeBlock(
                    type="tool_call",
                    tool_name="Shell",
                    tool_arguments={
                        "command": "touch approval-marker-2.txt",
                        "cwd": str(self.workspace_root),
                    },
                    call_id="call_needs_approval_2",
                    provider_id="fc_needs_approval_2",
                ),
                RuntimeBlock(
                    type="tool_call",
                    tool_name="LS",
                    tool_arguments={"path": str(self.workspace_root)},
                    call_id="call_after_approvals",
                    provider_id="fc_after_approvals",
                ),
            )
            for block in blocks:
                yield {"type": "tool_call", "block": block}
                yield {
                    "type": "item_completed",
                    "item": RuntimeItem(role="assistant", blocks=(block,)),
                }
            yield {
                "type": "completed",
                "response_id": "resp_two_approvals",
                "metadata": {},
            }
            return
        yield {"type": "text_delta", "text": "Both approvals completed."}
        yield {
            "type": "completed",
            "response_id": "resp_after_two_approvals",
            "metadata": {},
        }


def test_turn_executor_keeps_tools_available_after_repeated_successful_calls(
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
    assert adapter.seen_tool_counts[-1] == adapter.seen_tool_counts[0]


def test_approval_resume_completes_every_call_in_the_original_model_batch(
    tmp_path: Path,
) -> None:
    adapter = ApprovalThenSiblingToolsAdapter(tmp_path)
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    waiting = runtime.handle_user_turn("run the approved call and inspect the workspace")

    assert waiting.pending_decision is not None
    resumed = runtime.resolve_pending_approval("1")

    assert resumed.assistant_message == "All sibling tools completed."
    assert adapter.calls == 2
    replayed_blocks = [
        block
        for item in adapter.seen_items[1]
        for block in item.blocks
        if block.type in {"tool_call", "tool_result"}
    ]
    expected_call_ids = {
        "call_needs_approval",
        "call_sibling_ls_1",
        "call_sibling_ls_2",
    }
    for call_id in expected_call_ids:
        assert sum(
            block.type == "tool_call" and block.call_id == call_id
            for block in replayed_blocks
        ) == 1
        assert sum(
            block.type == "tool_result" and block.call_id == call_id
            for block in replayed_blocks
        ) == 1


def test_approval_resume_finalizes_interrupt_during_approved_tool_execution(
    tmp_path: Path,
    monkeypatch,
) -> None:
    from mycli.application.runtime.turn_executor import TurnExecutor

    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenLoopAdapter(),
    )
    waiting = runtime.handle_user_turn("push the branch")
    assert waiting.pending_decision is not None

    def interrupt_tool(**kwargs):
        del kwargs
        raise KeyboardInterrupt()

    monkeypatch.setattr(runtime, "_execute_tool_call", interrupt_tool)

    interrupted = TurnExecutor(runtime).resolve_pending_approval("1")

    assert interrupted.turn is not None
    assert interrupted.turn.status is TurnStatus.INTERRUPTED
    assert interrupted.turn.stop_reason is StopReason.INTERRUPTED
    conversation = runtime._session_service.load_conversation(runtime._config.session_id)
    assert conversation.messages[-1].role == "developer"
    assert "<turn_aborted>" in conversation.messages[-1].content


def test_approval_resume_advances_through_multiple_approvals_in_one_batch(
    tmp_path: Path,
) -> None:
    adapter = TwoApprovalsThenSiblingToolAdapter(tmp_path)
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    first_wait = runtime.handle_user_turn("run both approved calls and inspect")

    assert first_wait.pending_decision is not None
    assert first_wait.pending_decision.tool_call.call_id == "call_needs_approval_1"

    second_wait = runtime.resolve_pending_approval("1")

    assert second_wait.pending_decision is not None
    assert second_wait.pending_decision.tool_call.call_id == "call_needs_approval_2"
    assert adapter.calls == 1

    resumed = runtime.resolve_pending_approval("1")

    assert resumed.assistant_message == "Both approvals completed."
    assert adapter.calls == 2
    replayed_blocks = [
        block
        for item in adapter.seen_items[1]
        for block in item.blocks
        if block.type in {"tool_call", "tool_result"}
    ]
    for call_id in {
        "call_needs_approval_1",
        "call_needs_approval_2",
        "call_after_approvals",
    }:
        assert sum(
            block.type == "tool_call" and block.call_id == call_id
            for block in replayed_blocks
        ) == 1
        assert sum(
            block.type == "tool_result" and block.call_id == call_id
            for block in replayed_blocks
        ) == 1


def test_turn_executor_continues_after_repeated_tool_failure(
    tmp_path: Path,
) -> None:
    from mycli.application.runtime.turn_executor import TurnExecutor

    home_dir = tmp_path / "home"
    adapter = RepeatedMissingReadAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=home_dir,
        model_adapter=adapter,
    )

    response = TurnExecutor(runtime).execute_user_turn("inspect missing file")

    assert response.turn is not None
    assert response.turn.stop_reason is StopReason.ASSISTANT_COMPLETED
    assert "stopped retrying" in response.assistant_message
    assert adapter.calls == 4
    trace = TraceService(home_dir=home_dir).load(runtime._config.session_id)
    assert not any(
        event.kind == "guardrail"
        and event.payload.get("exit_reason") == "repeated_tool_failure"
        for event in trace
    )


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


def test_turn_executor_finalizes_interrupt_during_tool_execution(
    tmp_path: Path,
    monkeypatch,
) -> None:
    from mycli.application.runtime.turn_executor import TurnExecutor

    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ThirdStepCompletionAdapter(),
    )

    def interrupt_tools(**kwargs):
        del kwargs
        raise KeyboardInterrupt()

    monkeypatch.setattr(
        runtime._assistant_block_consumer,
        "_execute_tool_calls",
        interrupt_tools,
    )

    interrupted = TurnExecutor(runtime).execute_user_turn("inspect the repo")

    assert interrupted.turn is not None
    assert interrupted.turn.status is TurnStatus.INTERRUPTED
    assert interrupted.turn.stop_reason is StopReason.INTERRUPTED
    conversation = runtime._session_service.load_conversation(runtime._config.session_id)
    assert conversation.messages[-1].role == "developer"
    assert "<turn_aborted>" in conversation.messages[-1].content


def test_turn_executor_interrupts_blocked_tool_contribution_discovery(
    tmp_path: Path,
) -> None:
    from mycli.application.runtime.turn_executor import TurnExecutor

    provider = InterruptibleBlockingContributionProvider()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=CaptureMessagesDoneAdapter(),
    )
    runtime._tool_orchestrator._contributed_tool_providers = (provider,)
    token = RuntimeInterruptToken(source="test")
    responses = []
    worker = Thread(
        target=lambda: responses.append(
            TurnExecutor(runtime).execute_user_turn(
                "inspect the repo",
                interrupt_token=token,
            )
        ),
        daemon=True,
    )
    worker.start()
    assert provider.started.wait(0.5)

    interrupted_at = monotonic()
    token.request_nonblocking("user_interrupt")
    worker.join(timeout=0.3)

    assert not worker.is_alive()
    assert monotonic() - interrupted_at < 0.3
    assert responses[0].turn is not None
    assert responses[0].turn.status is TurnStatus.INTERRUPTED


def test_turn_executor_abandons_uncooperative_tool_contribution_discovery(
    tmp_path: Path,
) -> None:
    from mycli.application.runtime.turn_executor import TurnExecutor

    provider = UncooperativeBlockingContributionProvider()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=CaptureMessagesDoneAdapter(),
    )
    runtime._tool_orchestrator._contributed_tool_providers = (provider,)
    token = RuntimeInterruptToken(source="test")
    responses = []
    worker = Thread(
        target=lambda: responses.append(
            TurnExecutor(runtime).execute_user_turn(
                "inspect the repo",
                interrupt_token=token,
            )
        ),
        daemon=True,
    )
    worker.start()
    assert provider.started.wait(0.5)

    interrupted_at = monotonic()
    token.request_nonblocking("user_interrupt")
    worker.join(timeout=0.3)

    assert not worker.is_alive()
    assert monotonic() - interrupted_at < 0.3
    assert responses[0].turn is not None
    assert responses[0].turn.status is TurnStatus.INTERRUPTED


def test_output_free_interrupt_rolls_back_submitted_user_turn(
    tmp_path: Path,
) -> None:
    from mycli.application.runtime.turn_executor import TurnExecutor

    provider = UncooperativeBlockingContributionProvider()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=CaptureMessagesDoneAdapter(),
    )
    runtime._tool_orchestrator._contributed_tool_providers = (provider,)
    token = RuntimeInterruptToken(source="test")
    responses = []
    worker = Thread(
        target=lambda: responses.append(
            TurnExecutor(runtime).execute_user_turn(
                "restore this prompt",
                interrupt_token=token,
                turn_id="turn-output-free",
            )
        ),
        daemon=True,
    )
    worker.start()
    assert provider.started.wait(0.5)

    token.request_nonblocking(
        "user_interrupt",
        rollback_user_input=True,
    )
    worker.join(timeout=0.3)

    assert not worker.is_alive()
    response = responses[0]
    assert response.input_rolled_back is True
    assert response.turn is not None
    assert response.turn.status is TurnStatus.INTERRUPTED
    conversation = runtime._session_service.load_conversation(runtime._config.session_id)
    assert all(message.content != "restore this prompt" for message in conversation.messages)
    history = runtime._session_service.load_history_items(runtime._config.session_id)
    assert all(item.text != "restore this prompt" for item in history)


def test_visible_agent_activity_prevents_user_turn_rollback() -> None:
    assert _has_visible_turn_activity(
        [TurnItem(type=TurnItemType.ASSISTANT_MESSAGE, text="started")]
    )
    assert _has_visible_turn_activity(
        [TurnItem(type=TurnItemType.TOOL_CALL, tool_name="Read")]
    )
    assert not _has_visible_turn_activity(
        [TurnItem(type=TurnItemType.REASONING, text="thinking")]
    )


def test_turn_executor_handles_resumed_approval_no_progress_detection(tmp_path: Path) -> None:
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
    assert "no new evidence" in resumed.assistant_message.lower()


def test_rejected_approval_does_not_write_summary_when_memory_disabled(
    tmp_path: Path,
) -> None:
    class RecordingMemoryService:
        def __init__(self) -> None:
            self.summaries: list[tuple[str, str]] = []

        def append_session_summary(self, session_id: str, summary: str) -> None:
            self.summaries.append((session_id, summary))

    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenLoopAdapter(),
    )
    runtime._config = replace(runtime._config, memory_enabled=False)
    memory_service = RecordingMemoryService()
    runtime._memory_service = memory_service  # type: ignore[assignment]

    first = runtime.handle_user_turn("push the branch")
    assert first.pending_decision is not None

    rejected = runtime.resolve_pending_approval("2")

    assert rejected.turn is not None
    assert rejected.turn.status.value == "rejected"
    assert memory_service.summaries == []


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
