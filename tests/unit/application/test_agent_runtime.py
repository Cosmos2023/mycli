from __future__ import annotations

from pathlib import Path
import json
import time
from dataclasses import replace

from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.domain.conversation import Conversation, Message
from mycli.domain.contributed_tools import (
    ToolContributionDescriptor,
    ToolContributionLifecycleState,
    ToolContributionRegistration,
    ToolContributionScope,
    ToolContributionSource,
)
from mycli.domain.memory import MemoryKind
from mycli.domain.logging import LogLevel
from mycli.llms.clients.openai_chat import ModelResponseError
from mycli.llms.clients.openai_responses import OpenAIResponsesClient
from mycli.llms.adapters.responses_adapter import ResponsesModelAdapter
from mycli.domain.tool_exposure import ToolRouteKey
from mycli.domain.runtime import (
    ActivityEvent,
    AgentConfig,
    BaselineFragment,
    CollaborationMode,
    ContextBaseline,
    HistoryItem,
    HistoryItemType,
    ModelTurnResult,
    PlanItem,
    PlanState,
    PlanStatus,
    RuntimeBlock,
    RuntimeItem,
    RuntimeStreamEvent,
    SessionCommandAllowance,
    StopReason,
    TurnItemType,
    TurnRollout,
    TurnStatus,
)
from mycli.schemas.responses_protocol import ResponsesContinuationState
from mycli.services.trace_service import TraceService
from mycli.services.hooks import HookAllowlist, HookConfigRegistry
from mycli.application.runtime.tools.contributed_tool_provider import ToolContributionProvider
from mycli.domain.tools import ToolCall
from mycli.memory.service import MemoryService
from mycli.services.skill_registry import SkillRegistry
from mycli.utils.workspace_logger import WorkspaceLogService
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec
from mycli.tools.edit import EditTool
from mycli.tools.ls import LSTool
from mycli.tools.read import ReadTool
from mycli.tools.registry import ToolRegistry
from mycli.tools.bash import BashTool
from mycli.tools.grep import GrepTool
from mycli.tools.write import WriteTool
from mycli.tools.plan import PlanTool
from mycli.tools.ask_user_question import AskUserQuestionTool


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
                        name="Bash",
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


def test_agent_runtime_approval_resume_streams_tool_lifecycle_events(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenDoneAdapter(),
    )

    first = runtime.handle_user_turn("push the branch")
    assert first.pending_decision is not None

    events: list[RuntimeStreamEvent] = []
    resumed = runtime.resolve_pending_approval("1", stream_sink=events.append)

    assert resumed.assistant_message == "Push finished"
    lifecycle_kinds = [event.kind for event in events]
    assert "tool_start" in lifecycle_kinds
    assert any(kind in lifecycle_kinds for kind in {"tool_complete", "tool_failed"})


def test_agent_runtime_uses_existing_instruction_snapshot_for_contract(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenDoneAdapter(),
    )
    runtime._session_service._save_state(
        session_id=runtime._config.session_id,
        thread_id=runtime._config.session_id,
        state_key="instruction_snapshot",
        payload={
            "version": "legacy-v1",
            "system": "Legacy frozen system prompt",
            "react": "Legacy react prompt",
            "source": "legacy-session",
            "hash": "legacy-hash",
        },
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
        turn_id="turn_snapshot",
        context=context,
        turn_context=turn_context,
    )

    assert contract.base_instructions.startswith("Legacy frozen system prompt")
    assert "Legacy react prompt" not in contract.base_instructions


def test_agent_runtime_loads_project_execpolicy_rules_before_shell_execution(
    tmp_path: Path,
) -> None:
    rules_dir = tmp_path / ".mycli" / "rules"
    rules_dir.mkdir(parents=True)
    (rules_dir / "default.rules").write_text(
        'prefix_rule(pattern=["git", "push"], decision="deny")\n',
        encoding="utf-8",
    )
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenDoneAdapter(),
    )

    response = runtime.handle_user_turn("push the branch")

    assert response.pending_decision is None
    trace = TraceService(home_dir=tmp_path / "home").load(runtime._config.session_id)
    policy_trace = next(event for event in trace if event.kind == "runtime_policy_decision")
    assert policy_trace.payload["decision"] == "denied"
    assert policy_trace.payload["policy"] == "execpolicy_prefix_rule"
    assert policy_trace.payload["execpolicy_decision"] == "deny"
    assert policy_trace.payload["execpolicy_rule_source"] == "project"
    assert "git push" not in str(policy_trace.payload)


def test_project_execpolicy_deny_overrides_existing_session_shell_allowance(
    tmp_path: Path,
) -> None:
    rules_dir = tmp_path / ".mycli" / "rules"
    rules_dir.mkdir(parents=True)
    (rules_dir / "default.rules").write_text(
        'prefix_rule(pattern=["git", "push"], decision="deny")\n',
        encoding="utf-8",
    )
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenDoneAdapter(),
    )
    runtime._session_service.add_command_allowance(
        runtime._config.session_id,
        SessionCommandAllowance(command_pattern="git push"),
    )

    response = runtime.handle_user_turn("push the branch")

    assert response.pending_decision is None
    assert response.assistant_message.startswith(
        "Denied: Tool denied by runtime policy: Bash"
    )
    assert "policy=execpolicy_prefix_rule" in response.assistant_message
    assert "reason=execpolicy_deny" in response.assistant_message
    trace = TraceService(home_dir=tmp_path / "home").load(runtime._config.session_id)
    policy_trace = next(event for event in trace if event.kind == "runtime_policy_decision")
    assert policy_trace.payload["policy"] == "execpolicy_prefix_rule"
    assert policy_trace.payload["execpolicy_decision"] == "deny"
    assert "git push" not in str(policy_trace.payload)


def test_agent_runtime_includes_bounded_environment_contract_in_model_context(
    tmp_path: Path,
) -> None:
    rules_dir = tmp_path / ".mycli" / "rules"
    rules_dir.mkdir(parents=True)
    (rules_dir / "default.rules").write_text(
        'prefix_rule(pattern=["git", "push"], decision="deny")\n',
        encoding="utf-8",
    )
    adapter = BlockSingleTurnCaptureAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("inspect runtime environment")

    assert response.assistant_message == "done"
    assert adapter.seen_items
    rendered_items = "\n".join(
        block.text or ""
        for item in adapter.seen_items[0]
        for block in item.blocks
        if block.type == "text"
    )
    assert "Runtime environment:" in rendered_items
    assert f"- workspace_root: {tmp_path}" in rendered_items
    assert f"- writable_roots: {tmp_path}, {tmp_path / 'home' / '.mycli' / 'vendor'}" in rendered_items
    assert "- denied_read_globs: 2" in rendered_items
    assert "- filesystem: workspace_write" in rendered_items
    assert "- network: disabled" in rendered_items
    assert "- shell: restricted" in rendered_items
    assert "- approval_policy: safety_policy" in rendered_items
    assert "- command_policy: shell_safety_analysis" in rendered_items
    assert "- execpolicy: enabled" in rendered_items
    assert "- execpolicy_rule_count: 1" in rendered_items
    assert "- execpolicy_sources: project" in rendered_items
    assert "prefix_rule" not in rendered_items
    assert "git push" not in rendered_items


def test_agent_runtime_rebind_session_refreshes_environment_execpolicy_summary(
    tmp_path: Path,
) -> None:
    first_workspace = tmp_path / "first"
    second_workspace = tmp_path / "second"
    first_workspace.mkdir()
    second_workspace.mkdir()
    second_rules_dir = second_workspace / ".mycli" / "rules"
    second_rules_dir.mkdir(parents=True)
    (second_rules_dir / "default.rules").write_text(
        'prefix_rule(pattern=["git", "push"], decision="deny")\n',
        encoding="utf-8",
    )
    adapter = BlockSingleTurnCaptureAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=first_workspace,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    runtime.rebind_session(
        AgentConfig(workspace_root=second_workspace, session_id="second")
    )
    response = runtime.handle_user_turn("inspect runtime environment")

    assert response.assistant_message == "done"
    rendered_items = "\n".join(
        block.text or ""
        for item in adapter.seen_items[0]
        for block in item.blocks
        if block.type == "text"
    )
    assert f"- workspace_root: {second_workspace.resolve()}" in rendered_items
    assert "- execpolicy: enabled" in rendered_items
    assert "- execpolicy_rule_count: 1" in rendered_items
    assert "- execpolicy_sources: project" in rendered_items
    assert "prefix_rule" not in rendered_items
    assert "git push" not in rendered_items


def test_agent_runtime_requires_approval_for_medium_risk_write_when_strict(
    tmp_path: Path,
) -> None:
    class WriteThenDoneAdapter:
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
                                    tool_name="Write",
                                    tool_arguments={
                                        "file_path": "notes.txt",
                                        "content": "hello\n",
                                    },
                                    call_id="call_write_1",
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
                        blocks=(RuntimeBlock(type="text", text="Write finished."),),
                    ),
                ),
                done=True,
            )

    adapter = WriteThenDoneAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistry.from_tools(
            [
                WriteTool(tmp_path),
            ]
        ),
        config=AgentConfig(
            workspace_root=tmp_path,
            auto_approve_medium=False,
        ),
        home_dir=tmp_path / "home",
    )

    first = runtime.handle_user_turn("write notes")

    assert first.pending_decision is not None
    assert first.pending_decision.tool_call.name == "Write"
    assert first.pending_decision.command_pattern is None
    assert [option.value for option in first.pending_decision.options] == [
        "approve_once",
        "reject",
    ]
    assert first.turn is not None
    assert first.turn.status is TurnStatus.WAITING_APPROVAL
    assert not (tmp_path / "notes.txt").exists()

    resumed = runtime.resolve_pending_approval("1")

    assert resumed.assistant_message == "Write finished."
    assert (tmp_path / "notes.txt").read_text(encoding="utf-8") == "hello\n"


def test_agent_runtime_allows_write_to_user_vendor_root_when_strict(
    tmp_path: Path,
) -> None:
    vendor_file = tmp_path / "home" / ".mycli" / "vendor" / "ripgrep" / "state.json"

    class VendorWriteThenDoneAdapter:
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
                                    tool_name="Write",
                                    tool_arguments={
                                        "file_path": str(vendor_file),
                                        "content": "{}",
                                    },
                                    call_id="call_write_vendor",
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
                        blocks=(RuntimeBlock(type="text", text="Vendor write finished."),),
                    ),
                ),
                done=True,
            )

    runtime = AgentRuntime(
        model_adapter=VendorWriteThenDoneAdapter(),
        tool_registry=ToolRegistry.from_tools([WriteTool(tmp_path)]),
        config=AgentConfig(
            workspace_root=tmp_path,
            auto_approve_medium=False,
        ),
        home_dir=tmp_path / "home",
    )

    response = runtime.handle_user_turn("prepare vendor state")

    assert response.pending_decision is None
    assert response.assistant_message == "Vendor write finished."
    assert vendor_file.read_text(encoding="utf-8") == "{}"


def test_agent_runtime_allows_write_to_configured_writable_root_when_strict(
    tmp_path: Path,
) -> None:
    writable_root = tmp_path / "scratch"
    target_file = writable_root / "state.json"

    class ScratchWriteThenDoneAdapter:
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
                                    tool_name="Write",
                                    tool_arguments={
                                        "file_path": str(target_file),
                                        "content": "{}",
                                    },
                                    call_id="call_write_scratch",
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
                        blocks=(RuntimeBlock(type="text", text="Scratch write finished."),),
                    ),
                ),
                done=True,
            )

    runtime = AgentRuntime(
        model_adapter=ScratchWriteThenDoneAdapter(),
        tool_registry=ToolRegistry.from_tools([WriteTool(tmp_path)]),
        config=AgentConfig(
            workspace_root=tmp_path,
            auto_approve_medium=False,
            sandbox_writable_roots=(writable_root,),
        ),
        home_dir=tmp_path / "home",
    )

    response = runtime.handle_user_turn("prepare scratch state")

    assert response.pending_decision is None
    assert response.assistant_message == "Scratch write finished."
    assert target_file.read_text(encoding="utf-8") == "{}"


def test_agent_runtime_denies_read_of_default_secret_glob(
    tmp_path: Path,
) -> None:
    secret_file = tmp_path / ".env"
    secret_file.write_text("TOKEN=sk-secret\n", encoding="utf-8")

    class ReadEnvThenDoneAdapter:
        def __init__(self) -> None:
            self.calls = 0

        def next_turn(self, *, items, tools):
            del items, tools
            self.calls += 1
            if self.calls > 1:
                return ModelTurnResult(
                    items=(
                        RuntimeItem(
                            role="assistant",
                            blocks=(RuntimeBlock(type="text", text="Denied."),),
                        ),
                    ),
                    done=True,
                )
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="Read",
                                tool_arguments={"file_path": str(secret_file), "offset": 1, "limit": 20},
                                call_id="call_read_env",
                            ),
                        ),
                    ),
                ),
                done=False,
            )

    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ReadEnvThenDoneAdapter(),
    )

    response = runtime.handle_user_turn("read env")

    assert response.pending_decision is None
    assert response.assistant_message == "Denied."
    trace = TraceService(home_dir=tmp_path / "home").load(runtime._config.session_id)
    policy_trace = next(event for event in trace if event.kind == "runtime_policy_decision")
    assert policy_trace.payload["policy"] == "sandbox_denied_read_policy"
    assert policy_trace.payload["reason_code"] == "denied_read_glob"
    assert "sk-secret" not in str(policy_trace.payload)


def test_agent_runtime_applies_configured_sandbox_profile(
    tmp_path: Path,
) -> None:
    denied_root = tmp_path / ".private"
    denied_root.mkdir()
    secret_file = denied_root / "token.txt"
    secret_file.write_text("TOKEN=sk-secret\n", encoding="utf-8")
    writable_root = tmp_path / "scratch"

    class ReadPrivateThenDoneAdapter:
        def __init__(self) -> None:
            self.calls = 0
            self.seen_items: list[list[RuntimeItem]] = []

        def next_turn(self, *, items, tools):
            del tools
            self.calls += 1
            self.seen_items.append(items)
            if self.calls > 1:
                return ModelTurnResult(
                    items=(
                        RuntimeItem(
                            role="assistant",
                            blocks=(RuntimeBlock(type="text", text="Denied."),),
                        ),
                    ),
                    done=True,
                )
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="Read",
                                tool_arguments={
                                    "file_path": str(secret_file),
                                    "offset": 1,
                                    "limit": 20,
                                },
                                call_id="call_read_private",
                            ),
                        ),
                    ),
                ),
                done=False,
            )

    adapter = ReadPrivateThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime.rebind_session(
        AgentConfig(
            workspace_root=tmp_path,
            session_id="sandbox-config",
            sandbox_writable_roots=(writable_root,),
            sandbox_denied_read_roots=(denied_root,),
            sandbox_denied_read_globs=("**/*.pem",),
        )
    )

    response = runtime.handle_user_turn("read private token")

    assert response.pending_decision is None
    assert response.assistant_message == "Denied."
    rendered_items = "\n".join(
        block.text or ""
        for item in adapter.seen_items[0]
        for block in item.blocks
        if block.type == "text"
    )
    assert f"- writable_roots: {tmp_path}, {tmp_path / 'home' / '.mycli' / 'vendor'}, {writable_root}" in rendered_items
    assert "- denied_read_roots: 1" in rendered_items
    assert "- denied_read_globs: 3" in rendered_items
    trace = TraceService(home_dir=tmp_path / "home").load("sandbox-config")
    policy_trace = next(event for event in trace if event.kind == "runtime_policy_decision")
    assert policy_trace.payload["policy"] == "sandbox_denied_read_policy"
    assert policy_trace.payload["reason_code"] == "denied_read_root"
    assert "token.txt" not in str(policy_trace.payload)
    assert "sk-secret" not in str(policy_trace.payload)


def test_agent_runtime_plan_mode_denies_mutating_tool_without_approval(
    tmp_path: Path,
) -> None:
    class WriteThenDoneAdapter:
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
                                    tool_name="Write",
                                    tool_arguments={
                                        "file_path": "notes.txt",
                                        "content": "hello\n",
                                    },
                                    call_id="call_write_1",
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
                        blocks=(RuntimeBlock(type="text", text="Plan mode stayed read-only."),),
                    ),
                ),
                done=True,
            )

    runtime = AgentRuntime(
        model_adapter=WriteThenDoneAdapter(),
        tool_registry=ToolRegistry.from_tools([WriteTool(tmp_path)]),
        config=AgentConfig(
            workspace_root=tmp_path,
            collaboration_mode=CollaborationMode.PLAN,
            auto_approve_medium=False,
        ),
        home_dir=tmp_path / "home",
    )

    response = runtime.handle_user_turn("write notes")

    assert response.pending_decision is None
    assert response.assistant_message == (
        "Denied: Plan mode is read-only; blocked Write. Switch to /mode default to allow mutating tools."
    )
    assert not (tmp_path / "notes.txt").exists()
    trace = TraceService(home_dir=tmp_path / "home").load(runtime._config.session_id)
    policy_trace = next(event for event in trace if event.kind == "runtime_policy_decision")
    assert policy_trace.payload["decision"] == "denied"
    assert policy_trace.payload["policy"] == "collaboration_mode"
    assert policy_trace.payload["reason_code"] == "plan_mode_blocks_mutating_tool"


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
    assert any(message.startswith("query=search_text") for message in messages)
    assert any(message.startswith("query=search_text") for message in messages)


def test_agent_runtime_pauses_and_resumes_after_clarification(tmp_path: Path) -> None:
    adapter = ClarifyThenDoneAdapter()
    log_service = WorkspaceLogService(workspace_root=tmp_path)
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
        workspace_log_service=log_service,
    )
    runtime._tool_registry.register(AskUserQuestionTool())

    first = runtime.handle_user_turn("choose next slice")

    assert first.turn is not None
    assert first.turn.status is TurnStatus.WAITING_CLARIFICATION
    assert first.turn.stop_reason is StopReason.CLARIFICATION_REQUIRED
    suspended = runtime._session_service.load_suspended_turn(runtime._config.session_id)
    assert suspended is not None
    assert suspended.pending_clarification is not None
    assert suspended.pending_clarification.request_id == "call_question_1"

    resumed = runtime.resolve_pending_clarification(
        request_id="call_question_1",
        response="Runtime",
    )

    assert resumed.assistant_message == "Runtime slice selected."
    assert runtime._session_service.load_suspended_turn(runtime._config.session_id) is None
    trace = TraceService(home_dir=tmp_path / "home").load(runtime._config.session_id)
    resolution = next(event for event in trace if event.kind == "clarification_resolution")
    assert resolution.payload == {
        "result": "answered",
        "request_id": "call_question_1",
        "response_chars": len("Runtime"),
        "expected_request_id": "call_question_1",
        "tool_name": "AskUserQuestion",
        "call_id": "call_question_1",
    }
    agent_log = log_service.agent_log_path().read_text(encoding="utf-8")
    assert "clarification_resolution" in agent_log
    assert "answered" in agent_log
    assert "Runtime slice selected" not in agent_log
    assert any(
        message.role == "tool"
        and message.tool_call_id == "call_question_1"
        and "Runtime" in message.content
        for message in runtime._session_service.load_conversation(
            runtime._config.session_id
        ).messages
    )


def test_agent_runtime_records_blank_clarification_response_without_raw_text(
    tmp_path: Path,
) -> None:
    log_service = WorkspaceLogService(workspace_root=tmp_path)
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ClarifyThenDoneAdapter(),
        workspace_log_service=log_service,
    )

    response = runtime.resolve_pending_clarification(
        request_id="call_question_1",
        response="   ",
    )

    assert response.assistant_message == "Please provide a clarification response."
    trace = TraceService(home_dir=tmp_path / "home").load(runtime._config.session_id)
    resolution = next(event for event in trace if event.kind == "clarification_resolution")
    assert resolution.payload == {
        "result": "blank_response",
        "request_id": "call_question_1",
        "response_chars": 0,
    }
    agent_log = log_service.agent_log_path().read_text(encoding="utf-8")
    assert "blank_response" in agent_log


def test_agent_runtime_records_no_pending_clarification_response(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ClarifyThenDoneAdapter(),
    )

    response = runtime.resolve_pending_clarification(
        request_id="call_question_1",
        response="Runtime",
    )

    assert response.assistant_message == "There is no pending clarification to resolve."
    trace = TraceService(home_dir=tmp_path / "home").load(runtime._config.session_id)
    resolution = next(event for event in trace if event.kind == "clarification_resolution")
    assert resolution.payload == {
        "result": "no_pending_clarification",
        "request_id": "call_question_1",
        "response_chars": len("Runtime"),
    }


def test_agent_runtime_records_mismatched_clarification_without_clearing_state(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ClarifyThenDoneAdapter(),
    )
    runtime._tool_registry.register(AskUserQuestionTool())
    first = runtime.handle_user_turn("choose next slice")
    assert first.turn is not None
    assert first.turn.status is TurnStatus.WAITING_CLARIFICATION

    response = runtime.resolve_pending_clarification(
        request_id="wrong_request",
        response="Runtime",
    )

    assert response.assistant_message == "No pending clarification matches the provided request_id."
    assert runtime._session_service.load_suspended_turn(runtime._config.session_id) is not None
    trace = TraceService(home_dir=tmp_path / "home").load(runtime._config.session_id)
    resolution = next(
        event
        for event in trace
        if event.kind == "clarification_resolution"
        and event.payload["result"] == "request_id_mismatch"
    )
    assert resolution.payload == {
        "result": "request_id_mismatch",
        "request_id": "wrong_request",
        "response_chars": len("Runtime"),
        "expected_request_id": "call_question_1",
        "tool_name": "AskUserQuestion",
        "call_id": "call_question_1",
    }


def test_runtime_registers_bound_task_tool(tmp_path: Path) -> None:
    adapter = SearchThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    assert "Task" in runtime._tool_registry.list_names()
    task_tool = runtime._tool_registry.executors["Task"]
    assert getattr(task_tool, "_service", None) is runtime._sub_agent_service
    assert "SubagentOutput" in runtime._tool_registry.list_names()
    output_tool = runtime._tool_registry.executors["SubagentOutput"]
    assert getattr(output_tool, "_service", None) is runtime._sub_agent_service


def test_runtime_extension_manifest_exposes_live_subagent_contributed_tools(
    tmp_path: Path,
) -> None:
    adapter = SearchThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    manifest = runtime.extension_manifest()
    tools = {tool["name"]: tool for tool in manifest["tool_manifest"]["tools"]}
    toolsets = {toolset["id"]: toolset for toolset in manifest["toolset_manifest"]["toolsets"]}

    assert tools["Task"]["source"] == "builtin"
    assert tools["subagent_explore"]["source"] == "subagent"
    assert tools["subagent_explore"]["toolset"] == "external"
    assert "subagent_explore" in toolsets["external"]["tools"]


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
                        name="LS",
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
                        name="Grep",
                        arguments={"query": "search_text", "path": ".", "include": "*.md", "output_mode": "content"},
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


class ClarifyThenDoneAdapter:
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
                                tool_name="AskUserQuestion",
                                tool_arguments={
                                    "question": "Which slice should come next?",
                                    "options": [
                                        {"label": "Runtime"},
                                        {"label": "TUI"},
                                    ],
                                },
                                call_id="call_question_1",
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
                    blocks=(RuntimeBlock(type="text", text="Runtime slice selected."),),
                ),
            ),
            done=True,
        )


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
                                tool_name="LS",
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
                                tool_name="Read",
                                tool_arguments={"path": "README.md", "offset": 1, "limit": 200},
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
                        name="Grep",
                        arguments={
                            "query": "needle",
                            "path": ".",
                            "include": "*.txt", "output_mode": "content",
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
                        name="Read",
                        arguments={"path": "notes.txt", "offset": 1, "limit": 200},
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
                        name="Edit",
                        arguments={"path": "notes.txt", "old_string": "line two", "new_string": "line three"},
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
                        name="Grep",
                        arguments={"query": "needle", "output_mode": "content"},
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
                        name="Read",
                        arguments={"file_path": "notes.txt", "offset": 1, "limit": 2},
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
                        name="Bash",
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
                                tool_name="LS",
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
                                tool_name="Read",
                                tool_arguments={"path": "README.md", "offset": 1, "limit": 200},
                                call_id="call_read_readme",
                            ),
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="Read",
                                tool_arguments={"file_path": "pyproject.toml", "offset": 1, "limit": 200},
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


class FollowUpCaptureAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_items: list[list[RuntimeItem]] = []

    def next_turn(self, *, items, tools):
        del tools
        self.calls += 1
        self.seen_items.append(items)
        if self.calls == 1:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(RuntimeBlock(type="text", text="first answer"),),
                    ),
                ),
                done=True,
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="follow-up answer"),),
                ),
            ),
            done=True,
        )


class SteeringNotificationCaptureAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_items: list[list[RuntimeItem]] = []

    def next_turn(self, *, items, tools):
        del tools
        self.calls += 1
        self.seen_items.append(items)
        if self.calls == 1:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(RuntimeBlock(type="text", text="first answer"),),
                    ),
                ),
                done=True,
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="notification handled"),),
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
                                tool_name="Bash",
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
                                tool_name="Read",
                                tool_arguments={"file_path": "pyproject.toml", "offset": 1, "limit": 200},
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


class HighUsageToolThenDoneAdapter:
    def __init__(self, *, tool_calls: int = 3) -> None:
        self.calls = 0
        self.tool_calls = tool_calls

    def next_turn(self, *, items, tools):
        del items, tools
        self.calls += 1
        if self.calls <= self.tool_calls:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="Read",
                                tool_arguments={"file_path": "pyproject.toml", "offset": 1, "limit": 200},
                                call_id=f"call_high_usage_{self.calls}",
                            ),
                        ),
                    ),
                ),
                done=False,
                metadata={
                    "usage": {
                        "prompt_tokens": 90_000,
                        "completion_tokens": 15_000,
                    }
                },
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Finished despite high usage."),),
                ),
            ),
            done=True,
            metadata={
                "usage": {
                    "prompt_tokens": 90_000,
                    "completion_tokens": 15_000,
                }
            },
        )


class InvalidToolArgumentsThenDoneAdapter:
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
                                tool_name="Read",
                                tool_arguments={},
                                call_id="call_read_missing_args",
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
                        RuntimeBlock(
                            type="text",
                            text="Recovered from invalid tool arguments.",
                        ),
                    ),
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
                    tool_name="Read",
                    tool_arguments={"file_path": "pyproject.toml", "offset": 1, "limit": 200},
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


class LegacyTwoTurnCaptureAdapter:
    def __init__(self) -> None:
        self.seen_messages: list[list[object]] = []

    def next_action(self, *, messages, tools):
        del tools
        self.seen_messages.append(messages)
        return type(
            "Action",
            (),
            {
                "assistant_message": f"done {len(self.seen_messages)}",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


def test_agent_runtime_registers_skill_tool_from_skill_registry(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=LegacySingleTurnCaptureAdapter(),
    )

    assert "Skill" in runtime._tool_registry.list_names()


def test_agent_runtime_executes_session_lifecycle_configured_hooks(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.joinpath(".mycli").mkdir(parents=True)
    home.mkdir()
    marker = tmp_path / "session-hooks.jsonl"
    script = tmp_path / "session_hook.py"
    script.write_text(
        "\n".join(
            [
                "import json, os, sys",
                "from pathlib import Path",
                "payload = json.load(sys.stdin)",
                f"Path({str(marker)!r}).open('a', encoding='utf-8').write(json.dumps({{'hook_point': payload['hook_point'], 'hook_id': os.environ['MYCLI_HOOK_ID']}}) + '\\n')",
                "print(json.dumps({'action':'allow','message':'ok'}))",
            ]
        ),
        encoding="utf-8",
    )
    (workspace / ".mycli" / "hooks.json").write_text(
        json.dumps(
            {
                "hooks": [
                    {
                        "id": "session-start",
                        "hook_point": "session_start",
                        "command": ["python3", str(script)],
                    },
                    {
                        "id": "session-end",
                        "hook_point": "session_end",
                        "command": ["python3", str(script)],
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    discovery = HookConfigRegistry(workspace_root=workspace, home_dir=home).discover()
    HookAllowlist(home_dir=home).write_allowed(discovery.hooks)
    trace_service = TraceService(home_dir=home)

    runtime = AgentRuntime(
        model_adapter=LegacySingleTurnCaptureAdapter(),
        tool_registry=ToolRegistry.from_tools([LSTool(workspace)]),
        config=AgentConfig(workspace_root=workspace, session_id="hook-session"),
        home_dir=home,
        trace_service=trace_service,
    )
    runtime.close()
    runtime.close()

    lines = [json.loads(line) for line in marker.read_text(encoding="utf-8").splitlines()]
    assert lines == [
        {"hook_point": "session_start", "hook_id": "session-start"},
        {"hook_point": "session_end", "hook_id": "session-end"},
    ]
    traces = [event for event in trace_service.load("hook-session") if event.kind == "hook_execution"]
    assert [event.turn_id for event in traces] == ["session_start", "session_end"]
    assert [event.payload["hook_id"] for event in traces] == ["session-start", "session-end"]
    assert all(event.payload["action"] == "allow" for event in traces)


def test_agent_runtime_loads_enabled_plugin_hooks_and_tools(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    plugin = workspace / ".mycli" / "plugins" / "demo"
    plugin.mkdir(parents=True)
    (home / ".mycli" / "plugins").mkdir(parents=True)
    (workspace / ".mycli" / "config.toml").write_text(
        "[plugins]\nenabled = [\"demo\"]\n",
        encoding="utf-8",
    )
    plugin.joinpath("plugin.yaml").write_text(
        "\n".join(
            [
                "name: Demo Plugin",
                "version: '1.0'",
                "kind: standalone",
                "provides_tools:",
                "  - DemoTool",
                "provides_hooks:",
                "  - session_start",
                "requires_env: []",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    marker = tmp_path / "plugin-session-start.txt"
    plugin.joinpath("__init__.py").write_text(
        "\n".join(
            [
                "from pathlib import Path",
                "from mycli.services.hooks import HookAction, HookResult",
                "def register(ctx):",
                "    def session_start(context):",
                f"        Path({str(marker)!r}).write_text('ran', encoding='utf-8')",
                "        return HookResult(action=HookAction.ALLOW)",
                "    ctx.register_hook('session_start', session_start, name='plugin:demo:session_start')",
                "    ctx.register_tool('DemoTool', {'description': 'Demo tool'}, lambda args: {'summary': 'demo ok'}, {'toolset': 'plugin'})",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    runtime = AgentRuntime.for_tests(
        workspace_root=workspace,
        home_dir=home,
        model_adapter=BlockInspectThenDoneAdapter(),
    )

    assert marker.read_text(encoding="utf-8") == "ran"
    assert "DemoTool" in runtime._tool_registry.list_names()
    assert any("plugin_hook demo session_start:plugin:demo:session_start" in line for line in runtime.inspect_hooks())


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
    tool_registry = ToolRegistry.from_tools(
        [
            LSTool(tmp_path),
            ReadTool(tmp_path),
            GrepTool(tmp_path),
            EditTool(tmp_path),
            BashTool(tmp_path),
            PlanTool(),
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


def disable_runtime_memory(runtime: AgentRuntime) -> None:
    runtime.rebind_session(replace(runtime._config, memory_enabled=False))


def test_agent_runtime_consumes_runtime_blocks_via_next_turn(tmp_path: Path) -> None:
    adapter = BlockInspectThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    disable_runtime_memory(runtime)

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
    disable_runtime_memory(runtime)

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


def test_agent_runtime_consumes_steering_before_next_model_request(
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
    disable_runtime_memory(runtime)
    original_execute_tool_calls = runtime._tool_execution_service.execute_tool_calls

    def queue_steering_after_tools(**kwargs):
        result = original_execute_tool_calls(**kwargs)
        runtime.queue_steering_message("also check docs")
        return result

    runtime._tool_execution_service.execute_tool_calls = queue_steering_after_tools

    response = runtime.handle_user_turn("inspect both files")

    assert response.assistant_message == "Inspection complete"
    assert adapter.calls == 2
    second_request_user_texts = [
        block.text
        for item in adapter.seen_items[1]
        if item.role == "user"
        for block in item.blocks
        if block.type == "text"
    ]
    assert "also check docs" in second_request_user_texts
    assert runtime.queued_messages() == ((), ())


def test_agent_runtime_preserves_queued_steering_images_in_next_request(
    tmp_path: Path,
) -> None:
    image_path = tmp_path / "screenshot.png"
    image_path.write_bytes(
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02"
        b"\x00\x00\x00\x90wS\xde\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    (tmp_path / "README.md").write_text("# Demo\n", encoding="utf-8")
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'demo'\n", encoding="utf-8")
    adapter = MultiToolThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    disable_runtime_memory(runtime)
    original_execute_tool_calls = runtime._tool_execution_service.execute_tool_calls

    def queue_steering_after_tools(**kwargs):
        result = original_execute_tool_calls(**kwargs)
        runtime.queue_steering_message(
            "also check this [image #1]",
            image_paths=(str(image_path),),
        )
        return result

    runtime._tool_execution_service.execute_tool_calls = queue_steering_after_tools

    runtime.handle_user_turn("inspect both files")

    second_request_images = [
        block
        for item in adapter.seen_items[1]
        if item.role == "user"
        for block in item.blocks
        if block.type == "image"
    ]
    assert [block.metadata["path"] for block in second_request_images] == [str(image_path)]


def test_agent_runtime_consumes_follow_up_after_answer_completion(
    tmp_path: Path,
) -> None:
    adapter = FollowUpCaptureAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    disable_runtime_memory(runtime)
    runtime.queue_follow_up_message("now summarize risks")

    response = runtime.handle_user_turn("answer first")

    assert response.assistant_message == "follow-up answer"
    assert adapter.calls == 2
    second_request_user_texts = [
        block.text
        for item in adapter.seen_items[1]
        if item.role == "user"
        for block in item.blocks
        if block.type == "text"
    ]
    assert "now summarize risks" in second_request_user_texts
    assert runtime.queued_messages() == ((), ())


def test_agent_runtime_preserves_queued_follow_up_images_in_next_request(
    tmp_path: Path,
) -> None:
    image_path = tmp_path / "follow.png"
    image_path.write_bytes(
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02"
        b"\x00\x00\x00\x90wS\xde\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    adapter = FollowUpCaptureAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    disable_runtime_memory(runtime)
    runtime.queue_follow_up_message(
        "now summarize this [image #1]",
        image_paths=(str(image_path),),
    )

    runtime.handle_user_turn("answer first")

    second_request_images = [
        block
        for item in adapter.seen_items[1]
        if item.role == "user"
        for block in item.blocks
        if block.type == "image"
    ]
    assert [block.metadata["path"] for block in second_request_images] == [str(image_path)]


def test_agent_runtime_places_subagent_notification_in_next_request(
    tmp_path: Path,
) -> None:
    adapter = SteeringNotificationCaptureAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    notification = (
        "<task-notification>\n"
        "<task-id>demo:sub:turn_1:abcd</task-id>\n"
        "<status>completed</status>\n"
        "<result>done</result>\n"
        "</task-notification>"
    )
    runtime.queue_steering_message(notification)

    response = runtime.handle_user_turn("answer first")

    assert response.assistant_message == "first answer"
    assert adapter.calls >= 1
    request_user_texts = [
        block.text
        for item in adapter.seen_items[0]
        if item.role == "user"
        for block in item.blocks
        if block.type == "text"
    ]
    assert notification in request_user_texts
    assert runtime.queued_messages() == ((), ())


def test_agent_runtime_enqueues_background_bash_task_notification(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=SteeringNotificationCaptureAdapter(),
    )
    bash_tool = next(
        tool for tool in runtime._tool_registry.list_all() if tool.spec.name == "Bash"
    )

    result = bash_tool.execute(
        {
            "command": "python3 -c \"print('runtime-background-ready', flush=True)\"",
            "run_in_background": True,
        }
    )

    assert result.success is True
    output_file = Path(str(result.raw_payload["output_file"]))
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        steering, _ = runtime.queued_messages()
        if steering and output_file.exists():
            break
        time.sleep(0.01)

    steering, follow_up = runtime.queued_messages()
    assert follow_up == ()
    assert len(steering) == 1
    assert "<task-notification>" in steering[0]
    assert "<task-type>local_bash</task-type>" in steering[0]
    assert f"<output-file>{output_file}</output-file>" in steering[0]
    assert output_file.read_text(encoding="utf-8").strip() == "runtime-background-ready"


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


def test_turn_service_resume_switches_runtime_session_for_follow_up_turn(
    tmp_path: Path,
) -> None:
    from mycli.application.turn_service import TurnService

    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ReasoningTextDoneAdapter(),
    )
    service = TurnService(
        config=runtime._config,
        home_dir=tmp_path / "home",
        runtime=runtime,
    )
    target = Conversation(session_id="backlog")
    target.append(Message(role="user", content="older request"))
    runtime._session_service.save_conversation(target)

    rendered = service.resume_session("backlog")
    response = service.handle_user_turn("inspect resumed session")

    assert rendered == ("resumed backlog", "messages=1")
    assert response.assistant_message == "Repository summary complete."
    assert service._config.session_id == "backlog"
    assert runtime._config.session_id == "backlog"
    assert runtime._event_ledger._session_id == "backlog"
    resumed = runtime._session_service.load_conversation("backlog")
    default = runtime._session_service.load_conversation("default")
    assert [message.content for message in resumed.messages if message.role == "user"] == [
        "older request",
        "inspect resumed session",
    ]
    assert default.messages == []


def test_turn_service_resume_ancestor_switches_runtime_session_to_resolved_tip(
    tmp_path: Path,
) -> None:
    from mycli.application.turn_service import TurnService

    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ReasoningTextDoneAdapter(),
    )
    service = TurnService(
        config=runtime._config,
        home_dir=tmp_path / "home",
        runtime=runtime,
    )
    root = Conversation(
        session_id="root",
        messages=[
            Message(role="user", content="root question"),
            Message(role="assistant", content="root answer"),
            Message(role="user", content="root-only"),
        ],
    )
    branch = Conversation(
        session_id="branch",
        parent_id="root",
        fork_point=2,
        messages=[
            Message(role="user", content="root question"),
            Message(role="assistant", content="root answer"),
            Message(role="user", content="branch-only"),
        ],
    )
    runtime._session_service.save_conversation(root)
    runtime._session_service.save_conversation(branch)

    rendered = service.resume_session("root")
    response = service.handle_user_turn("continue on the tip")

    assert rendered == ("resumed branch", "messages=3")
    assert response.assistant_message == "Repository summary complete."
    assert service._config.session_id == "branch"
    assert runtime._config.session_id == "branch"
    assert runtime._event_ledger._session_id == "branch"
    assert runtime._sub_agent_service._session_id == "branch"
    resumed = runtime._session_service.load_conversation("branch")
    stale_root = runtime._session_service.load_conversation("root")
    assert [message.content for message in resumed.messages if message.role == "user"] == [
        "root question",
        "branch-only",
        "continue on the tip",
    ]
    assert [message.content for message in stale_root.messages if message.role == "user"] == [
        "root question",
        "root-only",
    ]


def test_turn_service_fork_switches_active_session_to_branch(
    tmp_path: Path,
) -> None:
    from mycli.application.turn_service import TurnService

    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ReasoningTextDoneAdapter(),
    )
    service = TurnService(
        config=runtime._config,
        home_dir=tmp_path / "home",
        runtime=runtime,
    )
    source = Conversation(session_id="default")
    source.append(Message(role="user", content="original request"))
    source.append(Message(role="assistant", content="original answer"))
    runtime._session_service.save_conversation(source)

    rendered = service.fork_session(None, "branch", None)
    response = service.handle_user_turn("continue on branch")

    assert rendered == ("forked default -> branch", "fork_point=2", "messages=2")
    assert response.assistant_message == "Repository summary complete."
    assert service._config.session_id == "branch"
    branch = runtime._session_service.load_conversation("branch")
    default = runtime._session_service.load_conversation("default")
    assert [message.content for message in branch.messages if message.role == "user"] == [
        "original request",
        "continue on branch",
    ]
    assert [message.content for message in default.messages if message.role == "user"] == [
        "original request",
    ]


def test_turn_service_fork_keeps_lineage_after_follow_up_turn(
    tmp_path: Path,
) -> None:
    from mycli.application.turn_service import TurnService

    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ReasoningTextDoneAdapter(),
    )
    service = TurnService(
        config=runtime._config,
        home_dir=tmp_path / "home",
        runtime=runtime,
    )
    root = Conversation(session_id="default")
    root.append(Message(role="user", content="original request"))
    root.append(Message(role="assistant", content="original answer"))
    runtime._session_service.save_conversation(root)

    assert service.fork_session(None, "branch", None) == (
        "forked default -> branch",
        "fork_point=2",
        "messages=2",
    )
    service.handle_user_turn("continue on branch")

    branch = runtime._session_service.load_conversation("branch")
    assert branch.parent_id == "default"
    assert branch.fork_point == 2
    assert runtime._session_service.resume_conversation("default").session_id == "branch"


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
    assert any(event.kind == "tool_started" and event.tool_name == "Read" for event in response.activity_events)
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


def test_agent_runtime_forwards_stream_events_to_sink(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=StreamReasoningTextDoneAdapter(),
    )
    events = []

    response = runtime.handle_user_turn("inspect the repo", stream_sink=events.append)

    assert response.assistant_message == "Repository summary complete."
    assert [event.kind for event in events] == [
        "reasoning",
        "text_delta",
        "text_delta",
        "completed",
    ]
    assert "".join(event.text for event in events if event.kind == "text_delta") == (
        "Repository summary complete."
    )


def test_agent_runtime_records_model_stream_diagnostics_to_trace_and_log(tmp_path: Path) -> None:
    log_service = WorkspaceLogService(workspace_root=tmp_path)
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=StreamReasoningTextDoneAdapter(),
        workspace_log_service=log_service,
    )

    response = runtime.handle_user_turn("inspect the repo")
    trace = TraceService(home_dir=tmp_path / "home").load(runtime._config.session_id)
    diagnostics = [event for event in trace if event.kind == "model_stream_diagnostics"]
    agent_log = (tmp_path / "log" / "agent.log").read_text(encoding="utf-8")

    assert response.turn is not None
    assert len(diagnostics) == 1
    assert diagnostics[0].turn_id == response.turn.turn_id
    assert diagnostics[0].payload["success"] is True
    assert diagnostics[0].payload["provider_event_count"] == 4
    assert diagnostics[0].payload["text_event_count"] == 2
    assert diagnostics[0].payload["completed_event_count"] == 1
    assert diagnostics[0].payload["text_bytes"] == len(
        "Repository summary complete.".encode("utf-8")
    )
    assert "model_stream_diagnostics" in agent_log
    assert "Model stream completed" in agent_log


def test_agent_runtime_forwards_execution_tool_lifecycle_events_to_sink(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=StreamReasoningToolThenDoneAdapter(),
    )
    events = []

    response = runtime.handle_user_turn("inspect the repo", stream_sink=events.append)

    assert response.assistant_message == "Repository summary complete."
    assert [event.kind for event in events] == [
        "reasoning",
        "tool_call",
        "completed",
        "tool_start",
        "tool_progress",
        "tool_complete",
        "text_delta",
        "completed",
    ]
    tool_start = next(event for event in events if event.kind == "tool_start")
    tool_progress = next(event for event in events if event.kind == "tool_progress")
    tool_complete = next(event for event in events if event.kind == "tool_complete")
    assert tool_start.tool_name == "Read"
    assert tool_start.metadata["tool_id"] == "call_stream_read_1"
    assert tool_start.metadata["args_preview"] == "file_path=pyproject.toml"
    assert tool_progress.tool_name == "Read"
    assert tool_progress.metadata["tool_id"] == "call_stream_read_1"
    assert tool_progress.metadata["stage"] == "executing"
    assert tool_complete.tool_name == "Read"
    assert tool_complete.metadata["tool_id"] == "call_stream_read_1"
    assert tool_complete.metadata["summary"] == "Read pyproject.toml"
    assert tool_complete.metadata["success"] is True


def test_agent_runtime_uses_configured_reasoning_effort_across_overview_turns(
    tmp_path: Path,
) -> None:
    (tmp_path / "README.md").write_text("This is mycli.\n", encoding="utf-8")
    adapter = OverviewReasoningEffortAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("请给我这个仓库的简短总结")

    assert response.assistant_message == "Repository summary complete."
    assert adapter.reasoning_efforts == ["medium", "medium", "medium"]


def test_agent_runtime_supports_streamed_tool_call_execution(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=StreamReasoningToolThenDoneAdapter(),
    )

    response = runtime.handle_user_turn("inspect the repo")

    assert response.assistant_message == "Repository summary complete."
    assert any(event.kind == "tool_started" and event.tool_name == "Read" for event in response.activity_events)


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
            and block.text == request
            for block in item.blocks
        )
    ]
    assert len(matching_user_items) == 1
    assert not any(
        item.role == "user"
        and any(
            block.type == "text"
            and block.text == f"Current user request: {request}"
            for block in item.blocks
        )
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
        and getattr(message, "content", None) == request
    ]
    assert len(matching_user_messages) == 1
    assert not any(
        getattr(message, "role", None) == "user"
        and getattr(message, "content", None) == f"Current user request: {request}"
        for message in adapter.seen_messages[0]
    )


def test_agent_runtime_reuses_persisted_runtime_environment_context_in_legacy_path(
    tmp_path: Path,
) -> None:
    adapter = LegacyTwoTurnCaptureAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    first = runtime.handle_user_turn("inspect ports")
    second = runtime.handle_user_turn("inspect port 3000")

    assert first.assistant_message == "done 1"
    assert second.assistant_message.startswith("done ")
    history_items = runtime._session_service.load_history_items(runtime._config.session_id)
    environment_history_items = [
        item
        for item in history_items
        if item.type is HistoryItemType.CONTEXT_BASELINE_UPDATE
        and item.metadata.get("context_kind") == "environment_context"
    ]
    assert len(environment_history_items) == 1
    assert "Runtime environment:" in (environment_history_items[0].text or "")

    second_turn_messages = next(
        messages
        for messages in reversed(adapter.seen_messages)
        if any(
            getattr(message, "role", None) == "user"
            and getattr(message, "content", None) == "inspect port 3000"
            for message in messages
        )
    )
    second_payload = "\n".join(
        str(getattr(message, "content", "")) for message in second_turn_messages
    )
    assert second_payload.count("Runtime environment:") == 1
    assert "inspect port 3000\nRuntime environment:" not in second_payload


def test_agent_runtime_writes_only_provider_transcript_items_to_history(
    tmp_path: Path,
) -> None:
    adapter = BlockSingleTurnCaptureAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("inspect runtime ledger")

    assert any(item.type is TurnItemType.TOOL_EXPOSURE for item in response.turn.items)
    assert not any(item.type is TurnItemType.REASONING for item in response.turn.items)
    history_items = runtime._session_service.load_history_items(runtime._config.session_id)
    assert [item.type for item in history_items] == [
        HistoryItemType.CONTEXT_BASELINE_UPDATE,
        HistoryItemType.USER_MESSAGE,
        HistoryItemType.ASSISTANT_MESSAGE,
    ]
    assert history_items[0].metadata["context_kind"] == "environment_context"
    assert not any(
        item.type
        in {
            HistoryItemType.TOOL_EXPOSURE,
            HistoryItemType.CAPABILITY,
            HistoryItemType.WARNING,
            HistoryItemType.REASONING,
            HistoryItemType.FILE_CHANGE,
        }
        for item in history_items
    )


def test_agent_runtime_does_not_replay_visible_thinking_text_as_transcript(
    tmp_path: Path,
) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ReasoningToolThenDoneAdapter(),
    )

    response = runtime.handle_user_turn("inspect reasoning boundary")

    assert any(item.type is TurnItemType.REASONING for item in response.turn.items)
    history_items = runtime._session_service.load_history_items(runtime._config.session_id)
    assert HistoryItemType.REASONING not in {item.type for item in history_items}
    assert not any(
        isinstance(item.text, str)
        and (item.text.startswith("Thinking:") or item.text.startswith("Planning:"))
        for item in history_items
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
    assert getattr(messages[0], "role", None) == "developer"
    assert "<collaboration_mode>" in str(getattr(messages[0], "content", ""))
    assert any(
        getattr(message, "role", None) == "user"
        and "Runtime environment:" in str(getattr(message, "content", ""))
        for message in messages
    )
    assert getattr(messages[-1], "role", None) == "user"
    assert getattr(messages[-1], "content", None) == "inspect cache shape"
    assert not any(getattr(message, "role", None) == "assistant" for message in messages)


def test_agent_runtime_keeps_append_only_provider_replay_in_block_path(tmp_path: Path) -> None:
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
    assert len(transcript_user_items) == 1


def test_agent_runtime_keeps_append_only_provider_replay_in_legacy_path(tmp_path: Path) -> None:
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
    assert len(transcript_user_messages) == 1


def test_agent_runtime_reinjects_tool_results_as_transcript_messages(tmp_path: Path) -> None:
    adapter = InspectThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    disable_runtime_memory(runtime)

    response = runtime.handle_user_turn("inspect the repo")

    assert response.assistant_message == "Inspection complete"
    assert adapter.calls == 2
    assert any(message.role == "developer" for message in adapter.seen_messages[0])
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
        and "Tool list_directory" not in str(message.content)
        for message in adapter.seen_messages[1]
    )


def test_agent_runtime_reinjects_grounded_search_matches_into_tool_message(tmp_path: Path) -> None:
    adapter = SearchThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    disable_runtime_memory(runtime)
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

    assert "Evidence:" in search_content
    assert "[search_match] notes.txt:1" in search_content
    assert "snippet: needle one" in search_content

    assert "Evidence:" in read_content
    assert "[file_excerpt] notes.txt:1-2" in read_content
    assert "snippet: needle one line two" in read_content

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
    def __init__(self) -> None:
        self.calls = 0

    def next_turn(self, *, items, tools):
        del items, tools
        self.calls += 1
        raise ModelResponseError("boom")


def test_agent_runtime_blocks_image_input_when_model_config_disables_images(
    tmp_path: Path,
) -> None:
    adapter = ErroringAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime.rebind_session(replace(runtime._config, supports_images=False))

    response = runtime.handle_user_turn(
        "describe [image #1]",
        image_paths=("/tmp/screenshot.png",),
    )

    assert adapter.calls == 0
    assert response.turn is not None
    assert response.turn.status is TurnStatus.FAILED
    assert response.turn.stop_reason is StopReason.MODEL_ERROR
    assert "does not support image input" in response.assistant_message
    assert response.activity_events == (
        ActivityEvent(
            kind="model_capability",
            message="image input blocked by model configuration",
        ),
    )
    assert response.turn.items[-1].metadata["reason"] == "model_does_not_support_images"


def test_agent_runtime_emits_model_error_activity_event(tmp_path: Path) -> None:
    log_service = WorkspaceLogService(workspace_root=tmp_path)
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ErroringAdapter(),
        workspace_log_service=log_service,
    )

    response = runtime.handle_user_turn("search for anything")

    assert response.turn is not None
    assert response.turn.status is TurnStatus.FAILED
    assert "Model request failed: boom" == response.assistant_message
    assert response.activity_events[-1] == ActivityEvent(
        kind="model_error",
        message="Model error: boom",
    )
    trace = TraceService(home_dir=tmp_path / "home").load(runtime._config.session_id)
    failure = next(event for event in trace if event.kind == "turn_failed")
    assert failure.turn_id == response.turn.turn_id
    assert failure.payload["stop_reason"] == StopReason.MODEL_ERROR.value
    assert failure.payload["phase"] == "model_error"
    assert failure.payload["error_type"] == "ModelResponseError"
    assert "boom" not in failure.payload.values()
    agent_log = log_service.agent_log_path().read_text(encoding="utf-8")
    assert "turn_failed" in agent_log
    assert "Turn failed during model_error." in agent_log


class UnexpectedErrorAdapter:
    def next_turn(self, *, items, tools):
        del items, tools
        raise ValueError("runtime exploded")


def test_agent_runtime_logs_unexpected_runtime_exceptions(tmp_path: Path) -> None:
    log_service = WorkspaceLogService(workspace_root=tmp_path)
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=UnexpectedErrorAdapter(),
        workspace_log_service=log_service,
    )

    response = runtime.handle_user_turn("search for anything")

    assert response.turn is not None
    assert response.turn.status is TurnStatus.FAILED
    assert response.assistant_message == "Internal runtime error: runtime exploded"
    assert "Details logged to log/errors.log" in response.error_details
    assert any(detail.endswith("-error.json") for detail in response.error_details)
    error_files = sorted((tmp_path / "log" / "model-raw").glob("*/*-error.json"))
    assert len(error_files) == 1
    payload = json.loads(error_files[0].read_text(encoding="utf-8"))
    assert payload["error_type"] == "ValueError"
    trace = TraceService(home_dir=tmp_path / "home").load(runtime._config.session_id)
    failure = next(event for event in trace if event.kind == "turn_failed")
    assert failure.turn_id == response.turn.turn_id
    assert failure.payload["stop_reason"] == StopReason.RUNTIME_ERROR.value
    assert failure.payload["phase"] == "runtime_error"
    assert failure.payload["error_type"] == "ValueError"
    assert failure.payload["error_path"] in response.error_details[-1]
    assert "runtime exploded" not in failure.payload.values()
    assert "turn_failed" in log_service.agent_log_path().read_text(encoding="utf-8")


def test_turn_service_records_turn_interrupt_request_diagnostics(tmp_path: Path) -> None:
    from mycli.application.turn_service import TurnService

    log_service = WorkspaceLogService(workspace_root=tmp_path)
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ReasoningTextDoneAdapter(),
        workspace_log_service=log_service,
    )
    service = TurnService(
        config=runtime._config,
        home_dir=tmp_path / "home",
        runtime=runtime,
    )

    service.record_turn_interrupt_request(client_turn_id="client_1")

    trace = TraceService(home_dir=tmp_path / "home").load(runtime._config.session_id)
    event = next(event for event in trace if event.kind == "turn_interrupt_requested")
    assert event.turn_id == "client_1"
    assert event.payload == {
        "session_id": runtime._config.session_id,
        "client_turn_id": "client_1",
        "requested": True,
        "source": "node_tui_gateway",
    }
    agent_log = log_service.agent_log_path().read_text(encoding="utf-8")
    assert "turn_interrupt_requested" in agent_log
    assert "client_1" in agent_log


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
        "mycli.llms.clients.openai_responses._build_openai_sdk_client",
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
        tool_registry=ToolRegistry.from_tools(
            [
                LSTool(tmp_path),
                ReadTool(tmp_path),
                GrepTool(tmp_path),
                EditTool(tmp_path),
                BashTool(tmp_path),
                PlanTool(),
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
        tool_registry=ToolRegistry.from_tools(
            [
                LSTool(tmp_path),
                ReadTool(tmp_path),
                GrepTool(tmp_path),
                EditTool(tmp_path),
                BashTool(tmp_path),
                PlanTool(),
            ]
        ),
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=tmp_path / "home",
        workspace_log_service=log_service,
    )

    runtime.handle_user_turn("inspect the repo")

    app_log = (tmp_path / "log" / "agent.log").read_text(encoding="utf-8")

    assert "INFO [demo] turn_context_assembled Assembled turn context" in app_log
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
                        name="Plan",
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
                        name="Plan",
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


class CodexStylePlanThenDoneAdapter:
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
                        name="Plan",
                        arguments={
                            "plan": [
                                {"step": "Map runtime state", "status": "completed"},
                                {"step": "Render active plan", "status": "in_progress"},
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


class PartialPlanUpdateThenDoneAdapter:
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
                        name="Plan",
                        arguments={
                            "op": "update",
                            "item_id": "verify",
                            "status": "in_progress",
                            "content": "Run focused tests",
                            "evidence": ["pytest targeted tests"],
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
    events = []

    response = runtime.handle_user_turn("plan the repository analysis", stream_sink=events.append)
    stored = runtime._session_service.load_plan_state(runtime._config.session_id)

    assert response.assistant_message == "Plan recorded"
    assert response.plan_steps == (
        "in_progress: Inspect the repository layout",
        "pending: Summarize the findings",
    )
    assert stored.items[0].status is PlanStatus.IN_PROGRESS
    plan_event = next(event for event in events if event.kind == "plan_updated")
    assert plan_event.metadata == {
        "plan_steps": [
            "in_progress: Inspect the repository layout",
            "pending: Summarize the findings",
        ],
        "plan": {
            "items": [
                {
                    "id": "inspect",
                    "text": "Inspect the repository layout",
                    "status": "in_progress",
                },
                {
                    "id": "summarize",
                    "text": "Summarize the findings",
                    "status": "pending",
                },
            ],
        },
        "source": "Plan",
    }


def test_agent_runtime_does_not_recover_plan_anchor_for_new_session(tmp_path: Path) -> None:
    plan_path = tmp_path / "docs" / "tasks" / "current.md"
    plan_path.parent.mkdir(parents=True)
    plan_path.write_text("# Current Plan\n\n- [~] Old workspace plan\n", encoding="utf-8")

    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PlanThenDoneAdapter(),
    )

    stored = runtime._session_service.load_plan_state(runtime._config.session_id)

    assert stored == PlanState()


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


def test_agent_runtime_accepts_codex_style_plan_payload(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=CodexStylePlanThenDoneAdapter(),
    )

    response = runtime.handle_user_turn("record a codex style plan")
    stored = runtime._session_service.load_plan_state(runtime._config.session_id)

    assert response.assistant_message == "Plan recorded"
    assert response.plan_steps == (
        "completed: Map runtime state",
        "in_progress: Render active plan",
    )
    assert tuple(item.id for item in stored.items) == ("step-1", "step-2")


def test_agent_runtime_applies_partial_plan_update_without_dropping_items(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PartialPlanUpdateThenDoneAdapter(),
    )
    runtime._session_service.save_plan_state(
        runtime._config.session_id,
        PlanState(
            items=(
                PlanItem(id="inspect", content="Inspect repo", status=PlanStatus.IN_PROGRESS),
                PlanItem(id="verify", content="Run tests", status=PlanStatus.PENDING),
            )
        ),
    )

    events = []
    response = runtime.handle_user_turn("update current plan", stream_sink=events.append)
    stored = runtime._session_service.load_plan_state(runtime._config.session_id)

    assert response.assistant_message == "Plan recorded"
    assert response.plan_steps == (
        "pending: Inspect repo",
        "in_progress: Run focused tests",
    )
    assert stored.items[1].evidence == ("pytest targeted tests",)
    plan_event = next(event for event in events if event.kind == "plan_updated")
    assert plan_event.metadata["plan"] == {
        "items": [
            {
                "id": "inspect",
                "text": "Inspect repo",
                "status": "pending",
            },
            {
                "id": "verify",
                "text": "Run focused tests",
                "status": "in_progress",
                "evidence": ["pytest targeted tests"],
            },
        ],
    }


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


class SkillToolSchemaCaptureAdapter:
    def __init__(self) -> None:
        self.seen_tools: list[list[object]] = []

    def next_action(self, *, messages, tools):
        del messages
        self.seen_tools.append(list(tools))
        return type(
            "Action",
            (),
            {
                "assistant_message": "Tool schema captured",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


class SkillThenAnswerAdapter:
    def __init__(self) -> None:
        self.seen_messages: list[list[object]] = []
        self.seen_tools: list[list[object]] = []
        self.calls = 0

    def next_action(self, *, messages, tools):
        self.calls += 1
        self.seen_messages.append(list(messages))
        self.seen_tools.append(list(tools))
        if self.calls == 1:
            return type(
                "Action",
                (),
                {
                    "assistant_message": "",
                    "progress_message": None,
                    "tool_call": ToolCall(
                        name="Skill",
                        arguments={"skill_name": "code-review"},
                        reason="Need review rules",
                    ),
                    "done": False,
                },
            )()
        return type(
            "Action",
            (),
            {
                "assistant_message": "Reviewed with skill.",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


def test_agent_runtime_continues_same_turn_with_skill_tool_result(tmp_path: Path) -> None:
    builtin_dir = tmp_path / "builtin-skills"
    user_dir = tmp_path / "home" / ".mycli" / "skills"
    builtin_dir.mkdir(parents=True)
    user_dir.mkdir(parents=True)
    (builtin_dir / "code-review.md").write_text(
        "---\n"
        'name = "code-review"\n'
        'description = "Review code"\n'
        'trigger_hints = ["review"]\n'
        "---\n"
        "Find correctness bugs first.\n",
        encoding="utf-8",
    )
    adapter = SkillThenAnswerAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistry.from_tools([PlanTool()]),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
        skill_registry=SkillRegistry(builtin_root=builtin_dir, user_root=user_dir),
    )

    response = runtime.handle_user_turn("review this change")

    assert response.assistant_message == "Reviewed with skill."
    assert adapter.calls == 2
    assert any(getattr(tool, "name", "") == "Skill" for tool in adapter.seen_tools[0])
    second_request_text = "\n".join(
        str(getattr(message, "content", "")) for message in adapter.seen_messages[1]
    )
    assert "Find correctness bugs first." in second_request_text
    assert response.turn is not None
    assert any(
        item.type is TurnItemType.TOOL_RESULT
        and item.tool_name == "Skill"
        and "Find correctness bugs first." in str(item.metadata.get("transcript_content", ""))
        for item in response.turn.items
    )
    assert any(
        item.type is TurnItemType.SKILL_INSTRUCTIONS
        and item.metadata.get("skill_name") == "code-review"
        for item in response.turn.items
    )
    stored_conversation = runtime._session_service.load_conversation(runtime._config.session_id)
    skill_messages = [
        message
        for message in stored_conversation.messages
        if message.metadata.get("kind") == "skill_instructions"
    ]
    assert len(skill_messages) == 1
    assert skill_messages[0].role == "user"
    assert skill_messages[0].metadata["skill_name"] == "code-review"
    assert skill_messages[0].metadata["cache_class"] == "dynamic"
    assert skill_messages[0].metadata["durability"] == "persistent"
    assert skill_messages[0].metadata["scope"] == "transcript"
    assert "not the current user request" in skill_messages[0].content
    assert "Find correctness bugs first." in skill_messages[0].content


def test_agent_runtime_exposes_skill_catalog_without_auto_loading_body(tmp_path: Path) -> None:
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
        tool_registry=ToolRegistry.from_tools(
            [
                LSTool(tmp_path),
                ReadTool(tmp_path),
                GrepTool(tmp_path),
                EditTool(tmp_path),
                BashTool(tmp_path),
                PlanTool(),
            ]
        ),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
        skill_registry=SkillRegistry(builtin_root=builtin_dir, user_root=user_dir),
    )

    response = runtime.handle_user_turn("inspect this repo")

    assert response.assistant_message == "Skill captured"
    first_request_text = "\n".join(
        str(getattr(message, "content", "")) for message in adapter.seen_messages[0]
    )
    assert "repository-analysis: Inspect repos" in first_request_text
    assert "Inspect repositories before answering." not in first_request_text


def test_agent_runtime_keeps_provider_tool_schema_stable_when_skills_change(
    tmp_path: Path,
) -> None:
    builtin_dir = tmp_path / "builtin-skills"
    user_dir = tmp_path / "home" / ".mycli" / "skills"
    builtin_dir.mkdir(parents=True)
    user_dir.mkdir(parents=True)
    (builtin_dir / "code-review.md").write_text(
        '---\nname = "code-review"\ndescription = "Review code"\n---\nReview body.\n',
        encoding="utf-8",
    )
    adapter = SkillToolSchemaCaptureAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistry.from_tools([PlanTool()]),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
        skill_registry=SkillRegistry(builtin_root=builtin_dir, user_root=user_dir),
    )

    runtime.handle_user_turn("first turn")
    first_tool_names = tuple(sorted(getattr(tool, "name", "") for tool in adapter.seen_tools[0]))

    (user_dir / "repo-analysis.md").write_text(
        '---\nname = "repo-analysis"\ndescription = "Analyze repo"\n---\nRepo body.\n',
        encoding="utf-8",
    )
    adapter_after_add = SkillToolSchemaCaptureAdapter()
    runtime_after_add = AgentRuntime(
        model_adapter=adapter_after_add,
        tool_registry=ToolRegistry.from_tools([PlanTool()]),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home-after",
        skill_registry=SkillRegistry(builtin_root=builtin_dir, user_root=user_dir),
    )

    runtime_after_add.handle_user_turn("second turn")
    second_tool_names = tuple(
        sorted(getattr(tool, "name", "") for tool in adapter_after_add.seen_tools[0])
    )

    assert first_tool_names == second_tool_names
    assert "Skill" in second_tool_names
    assert all(not name.startswith("skill_") for name in second_tool_names)


def test_agent_runtime_keeps_explicit_skill_mentions_as_plain_user_text(tmp_path: Path) -> None:
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
        tool_registry=ToolRegistry.from_tools(
            [
                LSTool(tmp_path),
                ReadTool(tmp_path),
                GrepTool(tmp_path),
                EditTool(tmp_path),
                BashTool(tmp_path),
                PlanTool(),
            ]
        ),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
        skill_registry=SkillRegistry(builtin_root=builtin_dir, user_root=user_dir),
    )

    response = runtime.handle_user_turn("inspect this repo with $repository-analysis")

    assert response.turn is not None
    assert not any(item.type is TurnItemType.CAPABILITY for item in response.turn.items)
    first_request_text = "\n".join(
        str(getattr(message, "content", "")) for message in adapter.seen_messages[0]
    )
    assert "Call the Skill tool" not in first_request_text
    assert "Inspect repositories before answering." not in first_request_text
    assert any(
        getattr(message, "role", None) == "user"
        and "repository-analysis" in str(getattr(message, "content", ""))
        for message in adapter.seen_messages[0]
    )
    assert not any(
        "Inspect repositories before answering." in str(getattr(message, "content", ""))
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
    memory_service.add_file_memory(
        kind=MemoryKind.PROJECT,
        name="repository entrypoint",
        description="Repository entrypoint",
        content="The repository entrypoint is src/mycli/cli/main.py.",
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
    user_messages = next(
        [
            str(getattr(message, "content", ""))
            for message in messages
            if getattr(message, "role", None) == "user"
        ]
        for messages in adapter.seen_messages
        if any(
            "<memory-context>" in str(getattr(message, "content", ""))
            for message in messages
        )
    )
    contextual_user_content = "\n".join(user_messages)
    assert "src/mycli/cli/main.py" in contextual_user_content
    assert "<memory-context>" in contextual_user_content
    assert "Inspected the repo root" in contextual_user_content
    current_request_messages = [
        message for message in user_messages if message == "inspect this repo"
    ]
    assert current_request_messages == ["inspect this repo"]


def test_agent_runtime_wires_model_file_memory_selector_by_default(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=MemoryCaptureAdapter(),
    )

    assert runtime._memory_service._file_memory_selector is not None


def test_agent_runtime_extracts_explicit_memory_after_successful_turn(tmp_path: Path) -> None:
    memory_service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path,
    )
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=MemoryCaptureAdapter(),
    )
    runtime._memory_service = memory_service

    response = runtime.handle_user_turn("remember that I prefer terse final answers")

    assert response.assistant_message == "Memory captured"
    assert "[memory] memory_extract_started" in response.progress_updates
    trace = runtime._trace_service.load(runtime._config.session_id)
    event = next(event for event in trace if event.kind == "memory_extraction")
    assert event.payload["result"] == "started"
    assert event.payload["mode"] == "background_agent"
    assert "terse final answers" not in json.dumps(event.payload)


class FakeMemoryDreamService:
    def __init__(self) -> None:
        self.requests = []

    def maybe_start_background_dream(self, request):
        self.requests.append(request)
        return ("memory_dream_started",)


class FakeMemoryExtractionService:
    def __init__(self) -> None:
        self.requests = []

    def maybe_start_background_extraction(self, request):
        self.requests.append(request)
        return ("memory_extract_started",)


def test_agent_runtime_skips_automatic_memory_when_disabled(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=MemoryCaptureAdapter(),
    )
    runtime._config = AgentConfig(
        workspace_root=tmp_path,
        session_id="demo",
        memory_enabled=False,
    )
    extraction_service = FakeMemoryExtractionService()
    dream_service = FakeMemoryDreamService()
    runtime._memory_extraction_service = extraction_service
    runtime._memory_dream_service = dream_service

    response = runtime.handle_user_turn("continue")

    assert "[memory] memory_extract_started" not in response.progress_updates
    assert "[memory] memory_dream_started" not in response.progress_updates
    assert extraction_service.requests == []
    assert dream_service.requests == []


def test_agent_runtime_throttles_automatic_memory_extraction(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=MemoryCaptureAdapter(),
    )

    response = runtime.handle_user_turn("continue")

    assert "[memory] memory_extract_started" not in response.progress_updates
    assert "[memory] memory_extract_skipped:interval" in response.progress_updates


def test_agent_runtime_checks_memory_dream_after_successful_turn(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=MemoryCaptureAdapter(),
    )
    dream_service = FakeMemoryDreamService()
    runtime._memory_dream_service = dream_service

    response = runtime.handle_user_turn("continue")

    assert "[memory] memory_dream_started" in response.progress_updates
    assert dream_service.requests
    request = dream_service.requests[0]
    assert request.session_id == runtime._config.session_id
    assert request.turn_id


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
        and event.payload.get("tool_name") == "LS"
        for event in loaded
    )
    assert any(event.kind == "tool_exposure" for event in loaded)
    policy_decision = next(
        event
        for event in loaded
        if event.kind == "runtime_policy_decision"
        and event.payload.get("tool_name") == "LS"
    )
    assert policy_decision.payload["decision"] == "allowed"
    assert policy_decision.payload["argument_keys"] == ["path"]
    assert "arguments" not in policy_decision.payload
    assert any(event.kind == "instruction_contract" for event in loaded)
    request_shape = next(event for event in loaded if event.kind == "request_shape")
    assert request_shape.payload["provider"] == "openai"
    assert request_shape.payload["system_hash"]
    assert request_shape.payload["tool_schema_hash"]
    assert request_shape.payload["tool_order_hash"]
    assert request_shape.payload["fragment_hashes"]["intent:current"]


class UsageMetadataAdapter:
    def __init__(self) -> None:
        self.calls = 0

    def next_turn(self, *, items, tools):
        del items, tools
        self.calls += 1
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text=f"done {self.calls}"),),
                ),
            ),
            done=True,
            metadata={
                "usage": {
                    "prompt_tokens": 1200 + self.calls,
                    "prompt_cache_hit_tokens": 1000,
                    "prompt_cache_miss_tokens": 200,
                }
            },
        )


class PromptCompletionUsageAdapter:
    def next_turn(self, *, items, tools):
        del items, tools
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="done"),),
                ),
            ),
            done=True,
            metadata={
                "usage": {
                    "prompt_tokens": 1000,
                    "completion_tokens": 800,
                }
            },
        )


class TotalOnlyUsageAdapter:
    def next_turn(self, *, items, tools):
        del items, tools
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="done"),),
                ),
            ),
            done=True,
            metadata={"usage": {"total_tokens": 1800}},
        )


def test_agent_runtime_traces_cache_shape_diagnostic_from_provider_usage(
    tmp_path: Path,
) -> None:
    adapter = UsageMetadataAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    runtime.handle_user_turn("first stable request")
    runtime.handle_user_turn("second stable request")

    loaded = TraceService(home_dir=tmp_path / "home").load(runtime._config.session_id)
    diagnostics = [event for event in loaded if event.kind == "cache_shape_diagnostic"]

    assert len(diagnostics) == 2
    assert diagnostics[-1].payload["prompt_tokens"] == 1202
    assert diagnostics[-1].payload["cache_hit_tokens"] == 1000
    assert diagnostics[-1].payload["cache_miss_tokens"] == 200
    assert diagnostics[-1].payload["cache_hit_ratio"] == 1000 / 1200
    assert diagnostics[-1].payload["first_changed_fragment_id"] is not None
    snapshot = runtime._observability_service.snapshot()
    assert snapshot.cache_hit_tokens == 2000
    assert snapshot.cache_miss_tokens == 400
    assert snapshot.cache_hit_rate == 2000 / 2400
    assert snapshot.budget_curve


def test_agent_runtime_traces_context_budget_trimming_for_oversized_context(
    tmp_path: Path,
) -> None:
    (tmp_path / ".mycli.md").write_text("workspace " * 2000, encoding="utf-8")
    adapter = UsageMetadataAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime._config = replace(runtime._config, max_prompt_tokens=350)

    runtime.handle_user_turn("inspect oversized context")

    loaded = TraceService(home_dir=tmp_path / "home").load(runtime._config.session_id)
    diagnostics = [
        event for event in loaded if event.kind == "context_budget_diagnostic"
    ]

    assert diagnostics
    payload = diagnostics[-1].payload
    assert payload["before_tokens"] > payload["after_tokens"]
    assert payload["trimmed_section_count"] >= 1
    assert payload["estimated_saved_tokens"] > 0
    assert any(
        item["section_type"] == "workspace_instructions"
        for item in payload["trimmed_sections"]
    )


def test_agent_runtime_records_provider_input_tokens_for_budget_curve(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PromptCompletionUsageAdapter(),
    )
    runtime._config = AgentConfig(
        workspace_root=tmp_path,
        max_prompt_tokens=2000,
        max_tokens_per_turn=2000,
    )

    runtime.handle_user_turn("measure provider input")

    snapshot = runtime._observability_service.snapshot()
    assert snapshot.budget_curve == (0.5,)
    assert runtime._session_service.load_turn_record(runtime._config.session_id) is not None
    turn = runtime._session_service.load_turn_record(runtime._config.session_id)
    assert turn is not None
    usage_item = next(item for item in turn.items if item.type is TurnItemType.MODEL_USAGE)
    assert usage_item.metadata["input_tokens"] == 1000
    assert usage_item.metadata["output_tokens"] == 800
    assert usage_item.metadata["total_tokens"] == 1800
    assert usage_item.metadata["cache_read_tokens"] == 0
    assert usage_item.metadata["cache_write_tokens"] == 0
    assert usage_item.metadata["source"] == "provider"


def test_agent_runtime_provider_budget_payload_marks_internal_usage(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=MemoryCaptureAdapter(),
    )

    payload = runtime._provider_input_budget_payload(
        usage={
            "input_tokens": 1000,
            "output_tokens": 100,
            "total_tokens": 1100,
            "usage_scope": "internal",
            "child_session_id": "demo:memory:turn_1:abcd1234",
        },
        fallback_total_tokens=1200,
        max_tokens=2000,
    )

    assert payload["usage_scope"] == "internal"
    assert payload["child_session_id"] == "demo:memory:turn_1:abcd1234"


def test_agent_runtime_counts_qwen_cache_creation_tokens(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=MemoryCaptureAdapter(),
    )

    payload = runtime._provider_input_budget_payload(
        usage={
            "prompt_tokens": 41000,
            "completion_tokens": 100,
            "total_tokens": 41100,
            "prompt_tokens_details": {
                "cached_tokens": 0,
                "cache_creation_input_tokens": 40900,
                "cache_creation": {"ephemeral_5m_input_tokens": 40900},
            },
        },
        fallback_total_tokens=41000,
        max_tokens=100000,
    )

    assert payload["cache_write_tokens"] == 40900


def test_agent_runtime_falls_back_to_estimate_when_provider_omits_input_tokens(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=TotalOnlyUsageAdapter(),
    )
    runtime._config = AgentConfig(
        workspace_root=tmp_path,
        max_prompt_tokens=2000,
        max_tokens_per_turn=2000,
    )

    runtime.handle_user_turn("measure provider input")

    snapshot = runtime._observability_service.snapshot()
    assert snapshot.budget_curve
    assert snapshot.budget_curve != (0.9,)
    turn = runtime._session_service.load_turn_record(runtime._config.session_id)
    assert turn is not None
    usage_item = next(item for item in turn.items if item.type is TurnItemType.MODEL_USAGE)
    assert usage_item.metadata["input_tokens"] == 0
    assert usage_item.metadata["budget_input_tokens"] > 0
    assert usage_item.metadata["total_tokens"] == 1800
    assert usage_item.metadata["source"] == "estimate"


def test_agent_runtime_restores_provider_input_budget_when_rebinding_session(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PromptCompletionUsageAdapter(),
    )
    first_config = AgentConfig(
        workspace_root=tmp_path,
        session_id="first",
        max_prompt_tokens=2000,
        max_tokens_per_turn=2000,
    )
    second_config = AgentConfig(
        workspace_root=tmp_path,
        session_id="second",
        max_prompt_tokens=2000,
        max_tokens_per_turn=2000,
    )
    runtime.rebind_session(first_config)
    runtime.handle_user_turn("measure first")
    runtime.rebind_session(second_config)
    assert runtime._observability_service.snapshot().budget_curve == ()

    runtime.rebind_session(first_config)

    snapshot = runtime._observability_service.snapshot()
    assert snapshot.budget_curve == (0.5,)
    assert runtime._session_service.load_turn_rollouts("first")


def test_agent_runtime_restores_estimated_budget_input_when_rebinding_session(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=TotalOnlyUsageAdapter(),
    )
    first_config = AgentConfig(
        workspace_root=tmp_path,
        session_id="first",
        max_prompt_tokens=2000,
        max_tokens_per_turn=2000,
    )
    second_config = AgentConfig(
        workspace_root=tmp_path,
        session_id="second",
        max_prompt_tokens=2000,
        max_tokens_per_turn=2000,
    )
    runtime.rebind_session(first_config)
    runtime.handle_user_turn("measure first")
    runtime.rebind_session(second_config)
    assert runtime._observability_service.snapshot().budget_curve == ()

    runtime.rebind_session(first_config)

    snapshot = runtime._observability_service.snapshot()
    assert snapshot.budget_curve
    assert snapshot.budget_curve != ()
    assert runtime._session_service.load_turn_rollouts("first")


def test_agent_runtime_rebind_session_clears_stale_context_compaction_metrics(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PromptCompletionUsageAdapter(),
    )
    first_config = AgentConfig(
        workspace_root=tmp_path,
        session_id="first",
        max_prompt_tokens=2000,
        max_tokens_per_turn=2000,
    )
    second_config = AgentConfig(
        workspace_root=tmp_path,
        session_id="second",
        max_prompt_tokens=2000,
        max_tokens_per_turn=2000,
    )
    runtime.rebind_session(first_config)
    runtime._observability_service.metrics.record_budget(total_tokens=900, max_tokens=1000)
    runtime._observability_service.metrics.record_context_window(
        {"total_tokens": 900, "max_tokens": 1000, "usage_ratio": 0.9}
    )
    runtime._observability_service.metrics.record_compaction(
        before_tokens=1200,
        after_tokens=300,
        level="L4",
    )
    runtime._observability_service.metrics.record_l4_decision(
        decision="summarize",
        source="pre_request",
    )

    runtime.rebind_session(second_config)

    snapshot = runtime._observability_service.snapshot()
    assert snapshot.budget_curve == ()
    assert snapshot.context_window == {}
    assert snapshot.compaction_levels == {}
    assert snapshot.compaction_before_tokens == 0
    assert snapshot.compaction_after_tokens == 0
    assert snapshot.l4_last_decision is None
    assert snapshot.l4_last_source is None


def test_agent_runtime_rebind_session_updates_workspace_log_context(
    tmp_path: Path,
) -> None:
    log_service = WorkspaceLogService(workspace_root=tmp_path, session_id="first")
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PromptCompletionUsageAdapter(),
        workspace_log_service=log_service,
    )

    runtime.rebind_session(
        AgentConfig(
            workspace_root=tmp_path,
            session_id="second",
        )
    )

    path = log_service.write_raw_model_payload(
        kind="request",
        payload={"message": "after rebind"},
        session_id="second",
        turn_id="turn_1",
    )
    log_service.log(level=LogLevel.INFO, event="turn_started", message="Turn started")

    assert path.parent == tmp_path / "log" / "model-raw" / "second"
    assert "INFO [second] turn_started Turn started" in log_service.agent_log_path().read_text(
        encoding="utf-8"
    )


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
                            tool_name="Read",
                            tool_arguments={"path": "missing.py", "offset": 1, "limit": 200},
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
        self.tool_choices: list[str | None] = []

    def set_tool_choice(self, tool_choice: str | None) -> None:
        self.tool_choices.append(tool_choice)

    def supports_tool_choice(self) -> bool:
        return True

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
                                tool_name="LS",
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
                                tool_name="Read",
                                tool_arguments={"file_path": "pyproject.toml", "offset": 1, "limit": 200},
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
        self.tool_choices: list[str | None] = []

    def set_tool_choice(self, tool_choice: str | None) -> None:
        self.tool_choices.append(tool_choice)

    def supports_tool_choice(self) -> bool:
        return True

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
                                tool_name="Grep",
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
                                tool_name="Read",
                                tool_arguments={
                                    "path": "src/mycli/services/context/turn_context_assembler.py",
                                    "offset": 1,
                                    "limit": 200,
                                },
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
                        blocks=(RuntimeBlock(type="text", text="Implementation audit complete."),),
                    ),
                ),
                done=True,
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


class ForceAnswerRequestShapeAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_tool_counts: list[int] = []
        self.tool_choices: list[str | None] = []

    def set_tool_choice(self, tool_choice: str | None) -> None:
        self.tool_choices.append(tool_choice)

    def supports_tool_choice(self) -> bool:
        return True

    def next_turn(self, *, items, tools):
        del items
        self.calls += 1
        self.seen_tool_counts.append(len(tools))
        if self.calls <= 12:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="Read",
                                tool_arguments={
                                    "path": f"evidence_{self.calls}.txt",
                                    "offset": 1,
                                    "limit": 200,
                                },
                                call_id=f"call_read_evidence_{self.calls}",
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
                    blocks=(RuntimeBlock(type="text", text="收口回答。"),),
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
                            tool_name="Bash",
                            tool_arguments={"args": ["pwd"]},
                            call_id="call_run_shell_deferred",
                        ),
                    ),
                ),
            ),
            done=False,
        )


class ContributedSummaryTool:
    def __init__(self) -> None:
        self.spec = ToolSpec(
            name="workspace_summary",
            description="Summarize workspace",
            parameters=(ToolParameter(name="path", type="string", required=False),),
        )

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        del arguments
        return ToolResult(success=True, summary="Workspace summary ready", raw_payload={"path": "."})


class OverviewToolContributionProvider(ToolContributionProvider):
    def provide(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
    ) -> tuple[object, ...]:
        del conversation, plan_state
        if "概览" not in user_message and "overview" not in user_message.lower():
            return ()
        tool = ContributedSummaryTool()
        return (
            ToolContributionRegistration(
                descriptor=ToolContributionDescriptor(
                    tool_id="provider:workspace_summary:thread",
                    display_name="workspace_summary",
                    description="Summarize workspace",
                    route_key=ToolRouteKey.local("workspace_summary"),
                    source=ToolContributionSource.PROVIDER,
                    scope=ToolContributionScope.THREAD,
                    lifecycle_state=ToolContributionLifecycleState.DECLARED,
                    spec=tool.spec,
                ),
                tool=tool,
            ),
        )


class ToolContributionAdapter:
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
                    blocks=(RuntimeBlock(type="text", text="Contributed summary complete"),),
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


def test_agent_runtime_persists_provider_history_baseline_state_and_runtime_rollout(
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
    assert any(item.type is HistoryItemType.ASSISTANT_MESSAGE for item in history_items)
    assert not any(item.type is HistoryItemType.REASONING for item in history_items)
    assert any(item.type is TurnItemType.REASONING for item in response.turn.items)
    assert baseline is not None
    assert isinstance(baseline, ContextBaseline)
    assert baseline.fragments
    assert not any(fragment.kind == "runtime_policy" for fragment in baseline.fragments)
    assert rollouts
    assert isinstance(rollouts[0], TurnRollout)
    assert rollouts[0].turn_id == response.turn.turn_id
    assert rollouts[0].status is TurnStatus.COMPLETED
    assert rollouts[0].stop_reason is StopReason.ASSISTANT_COMPLETED
    assert any(
        event.kind == "turn_item"
        and event.payload.get("type") == TurnItemType.REASONING.value
        for event in rollouts[0].events
    )


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
    assert tool_result.tool_name == "Read"
    assert tool_result.metadata["success"] is True


def test_agent_runtime_does_not_hard_stop_on_cumulative_provider_usage(
    tmp_path: Path,
) -> None:
    adapter = HighUsageToolThenDoneAdapter(tool_calls=3)
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime._config = AgentConfig(
        workspace_root=tmp_path,
        max_prompt_tokens=200_000,
        max_tokens_per_turn=200_000,
    )
    (tmp_path / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")

    response = runtime.handle_user_turn("inspect the repo")

    assert response.turn is not None
    assert response.turn.stop_reason is StopReason.ASSISTANT_COMPLETED
    assert response.assistant_message == "Finished despite high usage."
    assert adapter.calls == 4
    assert not any(
        item.type is TurnItemType.WARNING
        and item.text
        and "token budget exceeded" in item.text.lower()
        for item in response.turn.items
    )


def test_agent_runtime_returns_tool_validation_failures_to_model(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=InvalidToolArgumentsThenDoneAdapter(),
    )

    response = runtime.handle_user_turn("read README")
    history_items = runtime._session_service.load_history_items(runtime._config.session_id)

    assert response.turn is not None
    assert response.turn.status is TurnStatus.COMPLETED
    assert response.assistant_message == "Recovered from invalid tool arguments."
    tool_result = next(item for item in history_items if item.type is HistoryItemType.TOOL_RESULT)
    assert tool_result.tool_name == "Read"
    assert tool_result.metadata["success"] is False
    assert tool_result.metadata["error_kind"] == "tool_validation_error"


def test_agent_runtime_file_history_undo_restores_mutating_tool_change(
    tmp_path: Path,
) -> None:
    from mycli.application.turn_service import TurnService

    class EditThenDoneAdapter:
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
                                    tool_name="Edit",
                                    tool_arguments={
                                        "path": "notes.txt",
                                        "new_content": "after\n",
                                    },
                                    call_id="call_edit_1",
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
                        blocks=(RuntimeBlock(type="text", text="Edited."),),
                    ),
                ),
                done=True,
            )

    (tmp_path / "notes.txt").write_text("before\n", encoding="utf-8")
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=EditThenDoneAdapter(),
    )
    service = TurnService(
        config=runtime._config,
        home_dir=tmp_path / "home",
        runtime=runtime,
    )

    response = service.handle_user_turn("edit notes")
    undo_message = service.undo_last_file_change()

    assert response.assistant_message == "Edited."
    assert (tmp_path / "notes.txt").read_text(encoding="utf-8") == "before\n"
    assert "restored notes.txt" in undo_message


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


def test_agent_runtime_build_context_uses_append_only_provider_replay(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ReasoningTextDoneAdapter(),
    )
    runtime._config = AgentConfig(
        workspace_root=tmp_path,
        session_id=runtime._config.session_id,
        recent_message_count=1,
    )
    runtime._session_service.append_history_items(
        runtime._config.session_id,
        (
            HistoryItem(
                id="hist_1",
                thread_id=runtime._config.session_id,
                turn_id="turn_1",
                type=HistoryItemType.USER_MESSAGE,
                text="first request",
            ),
            HistoryItem(
                id="hist_2",
                thread_id=runtime._config.session_id,
                turn_id="turn_1",
                type=HistoryItemType.ASSISTANT_MESSAGE,
                text="first answer",
            ),
            HistoryItem(
                id="hist_3",
                thread_id=runtime._config.session_id,
                turn_id="turn_2",
                type=HistoryItemType.USER_MESSAGE,
                text="second request",
            ),
        ),
    )

    context = runtime._build_context(
        user_message="continue",
        conversation=Conversation(session_id=runtime._config.session_id),
        plan_state=PlanState(),
    )

    assert [message.content for message in context.conversation_messages] == [
        "first request",
        "first answer",
        "second request",
    ]
    assert context.conversation_summary == "- user: first request\n- assistant: first answer"


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
                tool_name="Read",
                call_id="call_read_1",
                metadata={"arguments": {"path": "pyproject.toml"}},
            ),
            HistoryItem(
                id="hist_tool_result_1",
                thread_id=runtime._config.session_id,
                turn_id="turn_1",
                type=HistoryItemType.TOOL_RESULT,
                text="Read pyproject.toml",
                tool_name="Read",
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
                tool_name="Read",
                call_id="call_read_1",
                metadata={"arguments": {"path": "pyproject.toml"}},
            ),
            HistoryItem(
                id="hist_tool_result_1",
                thread_id=runtime._config.session_id,
                turn_id="turn_1",
                type=HistoryItemType.TOOL_RESULT,
                text="Read pyproject.toml",
                tool_name="Read",
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
        and item.get("name") == "Read"
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
    runtime._config = AgentConfig(workspace_root=tmp_path)

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


def test_agent_runtime_observes_sufficient_overview_evidence_without_forcing_answer(
    tmp_path: Path,
) -> None:
    adapter = OverviewForceAnswerAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    (tmp_path / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")
    runtime._config = AgentConfig(workspace_root=tmp_path)

    response = runtime.handle_user_turn("请分析这个仓库的入口文件和主要模块，给我一个简短总结。")

    assert response.assistant_message == "入口在 CLI，主要模块在 src/mycli 下。"
    assert response.turn is not None
    assert response.turn.stop_reason is StopReason.ASSISTANT_COMPLETED
    assert adapter.seen_tool_counts[0] > 0
    assert adapter.seen_tool_counts[-1] == adapter.seen_tool_counts[0]
    assert "none" not in adapter.tool_choices
    assert not any(
        item.type is TurnItemType.REASONING
        and item.text in {"正在检查仓库结构", "已从确认的证据收口回答"}
        for item in response.turn.items
    )


class CompactionMetricsAdapter:
    def next_turn(self, *, items, tools):
        del items, tools
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Compacted response."),),
                ),
            ),
            done=True,
            metadata={"usage": {"total_tokens": 1000}},
        )


def test_agent_runtime_records_compaction_metrics_when_window_changes(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_adapter=CompactionMetricsAdapter(),
        tool_registry=ToolRegistry.from_tools([]),
        config=AgentConfig(
            workspace_root=tmp_path,
            max_prompt_tokens=1000,
            max_tokens_per_turn=1000,
            compaction_l4_trigger_ratio=0.1,
        ),
        home_dir=tmp_path / "home",
    )
    conversation = Conversation(session_id=runtime._config.session_id)
    for index in range(8):
        conversation.append(
            Message(
                role="assistant",
                content=" ".join(f"evidence_{index}_{token}" for token in range(240)),
            )
        )
    runtime._session_service.save_conversation(conversation)

    runtime.handle_user_turn("summarize from compacted history")

    snapshot = runtime._observability_service.snapshot()
    assert snapshot.compaction_levels.get("L4") == 1
    assert snapshot.compaction_before_tokens > 0
    assert snapshot.compaction_after_tokens > 0


def test_agent_runtime_limits_model_tools_to_planned_exposure(tmp_path: Path) -> None:
    adapter = CaptureToolExposureAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistry.from_tools(
            [
                LSTool(tmp_path),
                ReadTool(tmp_path),
                GrepTool(tmp_path),
                BashTool(tmp_path),
                EditTool(tmp_path),
                PlanTool(),
            ]
        ),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
    )

    response = runtime.handle_user_turn("please inspect this repository and summarize it")

    assert response.turn is not None
    assert "LS" in adapter.seen_tool_names[0]
    assert "Read" in adapter.seen_tool_names[0]
    assert "Bash" in adapter.seen_tool_names[0]
    assert "Edit" in adapter.seen_tool_names[0]
    assert any(item.type is TurnItemType.TOOL_EXPOSURE for item in response.turn.items)


def test_agent_runtime_executes_deferred_tool_calls_from_model(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_adapter=DeferredToolRequestAdapter(),
        tool_registry=ToolRegistry.from_tools(
            [
                LSTool(tmp_path),
                BashTool(tmp_path),
            ]
        ),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
    )

    response = runtime.handle_user_turn("please inspect this repository and summarize it")

    assert response.turn is not None
    assert response.turn.status is TurnStatus.FAILED
    assert response.turn.stop_reason is StopReason.LOOP_DETECTED
    assert response.assistant_message.startswith(
        "I stopped due to repeated exploration"
    )
    assert any(
        item.type is TurnItemType.WARNING
        and item.metadata.get("exit_reason") == "force_answer_tool_request"
        for item in response.turn.items
    )


def test_agent_runtime_batches_adjacent_safe_tool_calls_from_same_model_item(
    tmp_path: Path,
) -> None:
    adapter = MultiToolThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    (tmp_path / "README.md").write_text("readme\n", encoding="utf-8")
    (tmp_path / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
    batch_calls: list[tuple[str, ...]] = []
    original_execute_tool_calls = runtime._tool_execution_service.execute_tool_calls

    def capture_execute_tool_calls(**kwargs):
        calls = tuple(kwargs["calls"])
        batch_calls.append(tuple(call.name for call in calls))
        return original_execute_tool_calls(**kwargs)

    runtime._tool_execution_service.execute_tool_calls = capture_execute_tool_calls

    response = runtime.handle_user_turn("inspect both files")

    assert response.turn is not None
    assert response.turn.status is TurnStatus.COMPLETED
    assert batch_calls == [("Read", "Read")]
    assert [
        item.call_id
        for item in response.turn.items
        if item.type is TurnItemType.TOOL_RESULT
    ] == ["call_read_readme", "call_read_pyproject"]


def test_agent_runtime_executes_runtime_contributed_tool_via_router(tmp_path: Path) -> None:
    adapter = ToolContributionAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistry.from_tools([LSTool(tmp_path)]),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
    )
    runtime._runtime_contributed_tools = lambda **_kwargs: (ContributedSummaryTool(),)

    response = runtime.handle_user_turn("summarize the workspace")

    assert response.turn is not None
    assert response.assistant_message == "Contributed summary complete"
    assert "workspace_summary" in adapter.seen_tool_names[0]
    assert any(
        item.type is TurnItemType.TOOL_RESULT and item.tool_name == "workspace_summary"
        for item in response.turn.items
    )


def test_agent_runtime_records_contributed_tool_lifecycle_and_persists_thread_snapshot(
    tmp_path: Path,
) -> None:
    adapter = ToolContributionAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistry.from_tools([LSTool(tmp_path)]),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
    )
    thread_tool = ContributedSummaryTool()
    runtime._runtime_contributed_tools = lambda **_kwargs: (
        ToolContributionRegistration(
            descriptor=ToolContributionDescriptor(
                tool_id="runtime:workspace_summary:thread",
                display_name="workspace_summary",
                description="Summarize workspace",
                route_key=runtime._tool_exposure_planner._route_key_for_tool_name("workspace_summary"),
                source=ToolContributionSource.RUNTIME,
                scope=ToolContributionScope.THREAD,
                lifecycle_state=ToolContributionLifecycleState.DECLARED,
                spec=thread_tool.spec,
            ),
            tool=thread_tool,
        ),
    )

    response = runtime.handle_user_turn("summarize the workspace")
    trace_service = TraceService(home_dir=tmp_path / "home")
    trace = trace_service.load(runtime._config.session_id)
    snapshot = runtime._session_service.load_contributed_tool_state(runtime._config.session_id)

    assert response.turn is not None
    assert any(
        item.type is TurnItemType.TOOL_EXPOSURE
        and item.tool_name == "workspace_summary"
        and item.text.startswith("workspace_summary")
        for item in response.turn.items
    )
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
        event for event in trace if event.kind == "tool_lifecycle"
    ]
    assert [event.payload["state"] for event in lifecycle_events] == [
        "declared",
        "exposed",
        "invoked",
        "completed",
    ]


def test_agent_runtime_reexposes_thread_scoped_contributed_tools_on_later_turns(tmp_path: Path) -> None:
    adapter = ToolContributionAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistry.from_tools([LSTool(tmp_path)]),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
    )
    thread_tool = ContributedSummaryTool()
    registration = ToolContributionRegistration(
        descriptor=ToolContributionDescriptor(
            tool_id="runtime:workspace_summary:thread",
            display_name="workspace_summary",
            description="Summarize workspace",
            route_key=runtime._tool_exposure_planner._route_key_for_tool_name("workspace_summary"),
            source=ToolContributionSource.RUNTIME,
            scope=ToolContributionScope.THREAD,
            lifecycle_state=ToolContributionLifecycleState.DECLARED,
            spec=thread_tool.spec,
        ),
        tool=thread_tool,
    )
    runtime._runtime_contributed_tools = lambda **_kwargs: (registration,)

    first = runtime.handle_user_turn("summarize the workspace")
    second = runtime.handle_user_turn("do I still have my helper tool?")

    assert first.turn is not None
    assert second.turn is not None
    assert "workspace_summary" in adapter.seen_tool_names[0]
    assert "workspace_summary" in adapter.seen_tool_names[-1]


def test_agent_runtime_accepts_provider_contributed_contributed_tool_for_overview_requests(
    tmp_path: Path,
) -> None:
    adapter = ToolContributionAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistry.from_tools([LSTool(tmp_path)]),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
        contributed_tool_providers=(OverviewToolContributionProvider(),),
    )
    (tmp_path / "README.md").write_text("# demo\n", encoding="utf-8")
    (tmp_path / "src").mkdir()

    response = runtime.handle_user_turn("请先给我一个这个工作区的概览")

    assert response.turn is not None
    assert "workspace_summary" in adapter.seen_tool_names[0]
    assert any(
        item.type is TurnItemType.TOOL_EXPOSURE
        and item.tool_name == "workspace_summary"
        and item.text.startswith("workspace_summary")
        for item in response.turn.items
    )


def test_agent_runtime_observes_sufficient_implementation_audit_without_forcing_answer(
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
    runtime._config = AgentConfig(workspace_root=tmp_path)

    response = runtime.handle_user_turn(
        "请检查 turn context、runtime 和 trace 是否已经接入 capability activation。"
    )

    assert response.assistant_message == "Implementation audit complete."
    assert response.turn is not None
    assert adapter.seen_tool_counts[0] > 0
    assert adapter.seen_tool_counts[-1] == adapter.seen_tool_counts[0]
    assert "none" not in adapter.tool_choices
    assert not any(event.kind == "runtime_policy" for event in response.activity_events)


def test_agent_runtime_force_answer_request_keeps_native_tool_affordance(
    tmp_path: Path,
) -> None:
    adapter = ForceAnswerRequestShapeAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    for index in range(1, 13):
        (tmp_path / f"evidence_{index}.txt").write_text(
            f"evidence {index}\n",
            encoding="utf-8",
        )
    runtime._config = AgentConfig(workspace_root=tmp_path)

    response = runtime.handle_user_turn("请持续读取证据，最后收口回答。")

    assert response.assistant_message == "收口回答。"
    assert response.turn is not None
    assert response.turn.stop_reason is StopReason.ASSISTANT_COMPLETED
    assert adapter.seen_tool_counts[:12]
    assert all(count > 0 for count in adapter.seen_tool_counts[:12])
    assert adapter.seen_tool_counts[12] == adapter.seen_tool_counts[0]
    assert adapter.tool_choices[-1] == "none"
