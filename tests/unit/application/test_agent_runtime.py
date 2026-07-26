from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
import json
import sys
from threading import Event, Lock, Thread
import time
from dataclasses import replace
import pytest

from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.application.runtime.request.provider_timeline import ProviderTimelineState
from mycli.application.runtime.turn_executor import TurnExecutor
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
from mycli.domain.providers import ProtocolId, ProviderId
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
    InstructionContract,
    MailboxAcceptance,
    ModelTurnResult,
    PlanItem,
    PlanState,
    PlanStatus,
    RuntimeBlock,
    RuntimeItem,
    ShellLifecycleEvent,
    RuntimeStreamEvent,
    SessionCommandAllowance,
    ShellKind,
    StopReason,
    ToolRuntimeDecisionKind,
    TurnItemType,
    TurnRollout,
    TurnStatus,
    UserMessageInput,
)
from mycli.schemas.responses_protocol import ResponsesContinuationState
from mycli.services.trace_service import TraceService
from mycli.services.execpolicy_writer import ExecPolicyWriter
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
from mycli.tools.bash import BashTool, ShellTool
from mycli.tools.bash_output import BashOutputTool
from mycli.tools.kill_shell import KillShellTool
from mycli.tools.shell_registry import SHELL_REGISTRY
from mycli.tools.grep import GrepTool
from mycli.tools.write import WriteTool
from mycli.tools.plan import PlanTool
from mycli.tools.ask_user_question import AskUserQuestionTool
from tests.support.shell_commands import python_shell_command


def test_agent_runtime_projects_provider_timeline_before_building_request_shape() -> None:
    conversation = Conversation(
        session_id="session-1",
        messages=[Message(role="user", content="U1")],
    )
    contract = InstructionContract(
        base_instructions="S",
        current_user_request="U1",
    )
    projected = InstructionContract(
        base_instructions="S",
        conversation_messages=(Message(role="user", content="projected"),),
    )
    calls: list[tuple[object, ...]] = []

    class Coordinator:
        def project_and_persist(self, **kwargs):
            calls.append(
                (
                    "project",
                    kwargs["contract"],
                    kwargs["conversation"],
                    kwargs["current_user_request"],
                )
            )
            return projected

    class Pipeline:
        def build_and_trace_request_shape(self, **kwargs):
            calls.append(("build", kwargs["contract"]))
            return "shape"

    runtime = AgentRuntime.__new__(AgentRuntime)
    runtime._provider_timeline = Coordinator()
    runtime._request_pipeline = Pipeline()

    result = runtime._build_and_trace_request_shape(
        turn_id="turn-1",
        contract=contract,
        conversation=conversation,
        tools=[],
    )

    assert result == "shape"
    assert calls == [
        ("project", contract, conversation, "U1"),
        ("build", projected),
    ]


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
                        name="Shell",
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


def test_agent_runtime_approval_resume_does_not_repeat_user_history(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenDoneAdapter(),
    )

    first = runtime.handle_user_turn("push the branch")
    assert first.pending_decision is not None
    runtime.resolve_pending_approval("1")

    history = runtime._session_service.load_history_items(runtime._config.session_id)
    user_items = [item for item in history if item.type is HistoryItemType.USER_MESSAGE]

    assert [item.text for item in user_items] == ["push the branch"]


def test_agent_runtime_persists_allowance_for_active_shell_kind(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenDoneAdapter(),
    )
    runtime.rebind_session(replace(runtime._config, shell_path="/bin/sh"))

    first = runtime.handle_user_turn("push the branch")
    assert first.pending_decision is not None

    resumed = runtime.resolve_pending_approval("3")

    assert resumed.assistant_message == "Push finished"
    assert runtime._session_service.load_command_allowances(
        runtime._config.session_id
    ) == (
        SessionCommandAllowance(
            command_pattern="git push",
            shell_kind=ShellKind.SH,
        ),
    )


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


def test_shell_guidance_is_dynamic_not_stored_in_instruction_snapshot(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenDoneAdapter(),
    )

    base = runtime._instruction_snapshot_system_prompt()
    context, turn_context = runtime._assemble_turn_context(
        user_message="inspect the repository",
        conversation=Conversation(session_id=runtime._config.session_id),
        plan_state=PlanState(),
    )
    contract = runtime._assemble_instruction_contract(
        turn_id="turn-shell-guidance",
        context=context,
        turn_context=turn_context,
    )
    shape = runtime._request_shape_builder.build(
        config=runtime._config,
        contract=contract,
        tools=(),
    )
    provider_payload = "\n".join(
        (
            *(message.content for message in shape.provider_messages),
            *(
                block.text or ""
                for item in shape.provider_runtime_items
                for block in item.blocks
            ),
        )
    )

    assert "Current shell:" not in base
    assert "Current shell:" not in contract.base_instructions
    assert any(
        "Current shell:" in section.content
        for section in contract.memory_excluded_contextual_sections()
    )
    assert "Current shell:" in provider_payload


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


def test_refresh_execpolicy_rules_updates_gate_without_session_rebind(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=home_dir,
        model_adapter=PushThenDoneAdapter(),
    )
    ExecPolicyWriter(home_dir=home_dir).allow_prefix(("git", "push"))

    rules = runtime.refresh_execpolicy_rules()

    assert rules.match(("git", "push", "origin", "main")) is not None
    decision = runtime._runtime_policy_gate.decide_execpolicy(
        ToolCall(
            name="Shell",
            arguments={"command": "git push origin main"},
            reason="publish branch",
        )
    )
    assert decision is not None
    assert decision.kind is ToolRuntimeDecisionKind.ALLOWED
    assert decision.policy == "execpolicy_prefix_rule"


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
        "Denied: Tool denied by runtime policy: Shell"
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
    assert any("rg -n --glob '*.md' search_text ." in message for message in messages)


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


def test_agent_runtime_forwards_stream_events_after_clarification_resume(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=StreamClarifyThenDoneAdapter(),
    )
    runtime._tool_registry.register(AskUserQuestionTool())
    first = runtime.handle_user_turn("choose next slice")
    assert first.turn is not None
    assert first.turn.status is TurnStatus.WAITING_CLARIFICATION
    stream_events: list[RuntimeStreamEvent] = []

    resumed = runtime.resolve_pending_clarification(
        request_id="call_question_1",
        response="Runtime",
        stream_sink=stream_events.append,
    )

    assert resumed.assistant_message == "Runtime slice selected."
    assert "".join(
        event.text for event in stream_events if event.kind == "text_delta"
    ) == "Runtime slice selected."
    assert any(event.kind == "completed" for event in stream_events)


def test_clarification_result_is_persisted_before_resumed_model_request(
    tmp_path: Path,
) -> None:
    adapter = ClarifyThenPersistenceProbeAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime._tool_registry.register(AskUserQuestionTool())
    adapter.probe = lambda: any(
        message.role == "tool" and message.tool_call_id == "call_question_1"
        for message in runtime._session_service.load_conversation(
            runtime._config.session_id
        ).messages
    )
    first = runtime.handle_user_turn("choose next slice")
    assert first.turn is not None
    assert first.turn.status is TurnStatus.WAITING_CLARIFICATION

    resumed = runtime.resolve_pending_clarification(
        request_id="call_question_1",
        response="Runtime",
    )

    assert resumed.turn is not None
    assert resumed.turn.status is TurnStatus.COMPLETED
    assert adapter.persisted_before_resume is True


def test_new_turn_repairs_dangling_tool_call_before_model_request(tmp_path: Path) -> None:
    adapter = BlockSingleTurnCaptureAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime._session_service.save_conversation(
        Conversation(
            session_id=runtime._config.session_id,
            messages=[
                Message(role="user", content="choose next slice"),
                Message(
                    role="assistant",
                    content="",
                    tool_calls=(
                        ToolCall(
                            name="AskUserQuestion",
                            arguments={"question": "Which slice?"},
                            reason="clarify",
                            call_id="call_dangling",
                        ),
                    ),
                ),
            ],
        )
    )

    response = runtime.handle_user_turn("continue")

    assert response.turn is not None
    assert response.turn.status is TurnStatus.COMPLETED
    blocks = [block for item in adapter.seen_items[0] for block in item.blocks]
    assert any(
        block.type == "tool_call" and block.call_id == "call_dangling"
        for block in blocks
    )
    assert any(
        block.type == "tool_result" and block.call_id == "call_dangling"
        for block in blocks
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
    assert "SendMessage" in runtime._tool_registry.list_names()
    send_message_tool = runtime._tool_registry.executors["SendMessage"]
    assert getattr(send_message_tool, "_service", None) is runtime._sub_agent_service


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
                        name="Shell",
                        arguments={"command": "rg -n --glob '*.md' search_text ."},
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


class StreamClarifyThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0

    def stream_turn(self, *, items, tools):
        del items, tools
        self.calls += 1
        if self.calls == 1:
            yield {
                "type": "tool_call",
                "block": RuntimeBlock(
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
            }
            yield {"type": "completed", "response_id": "resp_clarify_1"}
            return
        yield {"type": "text_delta", "text": "Runtime slice selected."}
        yield {"type": "completed", "response_id": "resp_clarify_2"}


class ClarifyThenPersistenceProbeAdapter(ClarifyThenDoneAdapter):
    def __init__(self) -> None:
        super().__init__()
        self.probe: Callable[[], bool] | None = None
        self.persisted_before_resume: bool | None = None

    def next_turn(self, *, items, tools):
        if self.calls > 0:
            assert self.probe is not None
            self.persisted_before_resume = self.probe()
        return super().next_turn(items=items, tools=tools)


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
                        name="Shell",
                        arguments={"command": "rg -n --glob '*.txt' needle ."},
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
                        name="Shell",
                        arguments={"command": "rg -n needle ."},
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
                        name="Shell",
                        arguments={"args": ["echo", "shell-output"]},
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


class ParallelReadProbe:
    spec = ToolSpec(
        name="Read",
        description="Read a file while recording overlapping executions.",
        parameters=(
            ToolParameter(name="path", type="string", required=False),
            ToolParameter(name="file_path", type="string", required=False),
            ToolParameter(name="offset", type="integer"),
            ToolParameter(name="limit", type="integer"),
        ),
        supports_parallel_tool_calls=True,
    )

    def __init__(self) -> None:
        self._lock = Lock()
        self._active = 0
        self.max_active = 0

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        with self._lock:
            self._active += 1
            self.max_active = max(self.max_active, self._active)
        try:
            time.sleep(0.10)
            path = str(arguments.get("file_path") or arguments.get("path") or "")
            return ToolResult(
                success=True,
                summary=f"Read {path}",
                raw_payload={"path": path, "content": path},
            )
        finally:
            with self._lock:
                self._active -= 1


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


def test_agent_runtime_queue_snapshot_is_session_scoped(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=FollowUpCaptureAdapter(),
    )
    runtime.rebind_session(replace(runtime._config, session_id="first"))
    runtime.queue_follow_up_message("first message", client_turn_id="client-1")
    runtime.rebind_session(replace(runtime._config, session_id="second"))

    assert runtime.queue_snapshot().session_id == "second"
    assert runtime.queued_messages() == ((), ())

    runtime.rebind_session(replace(runtime._config, session_id="first"))
    assert runtime.queued_messages() == ((), ("first message",))


def test_legacy_projection_keeps_rejected_before_follow_up(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=FollowUpCaptureAdapter(),
    )
    runtime.queue_steering_message(
        "rejected",
        client_turn_id="client-1",
        expected_turn_id="stale",
        active_turn_id="current",
        steerable=True,
    )
    runtime.queue_follow_up_message("later", client_turn_id="client-2")

    assert runtime.queued_messages() == ((), ("rejected", "later"))


def test_failed_steer_commit_closes_mailbox_for_tui_retry(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=FollowUpCaptureAdapter(),
    )
    runtime.begin_active_turn_mailbox("turn-fixed", steerable=True)
    runtime.steer_active_turn(
        UserMessageInput(
            client_user_message_id="client-steer",
            text="inspect",
            source="steer",
            target_turn_id="turn-fixed",
        )
    )
    append_history_items = runtime._session_service.append_history_items

    def fail_steer_commit(session_id: str, items: tuple[HistoryItem, ...]) -> None:
        if items[0].metadata.get("source") == "steer":
            raise OSError("disk full")
        append_history_items(session_id, items)

    runtime._session_service.append_history_items = fail_steer_commit

    with pytest.raises(OSError, match="disk full"):
        TurnExecutor(runtime).execute_user_turn("start", turn_id="turn-fixed")

    assert runtime.active_turn_mailbox_id() is None
    history = runtime._session_service.load_history_items(runtime._config.session_id)
    assert [item.text for item in history if item.type is HistoryItemType.USER_MESSAGE] == [
        "start"
    ]


def test_committed_steer_history_uses_client_identity_and_server_turn_id(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=FollowUpCaptureAdapter(),
    )
    runtime.begin_active_turn_mailbox("turn-fixed", steerable=True)
    assert runtime.steer_active_turn(
        UserMessageInput(
            client_user_message_id="client-steer",
            text="inspect",
            source="steer",
            target_turn_id="turn-fixed",
        )
    ) is MailboxAcceptance.ACCEPTED

    stream_events: list[RuntimeStreamEvent] = []
    response = TurnExecutor(runtime).execute_user_turn(
        "start",
        turn_id="turn-fixed",
        stream_sink=stream_events.append,
    )

    history = runtime._session_service.load_history_items(runtime._config.session_id)
    committed = [
        item
        for item in history
        if item.metadata.get("client_user_message_id") == "client-steer"
    ]
    assert len(committed) == 1
    assert committed[0].turn_id == "turn-fixed"
    assert response.turn is not None
    assert response.turn.turn_id == "turn-fixed"
    assert runtime.queue_snapshot().pending_steers == ()
    committed_event = next(
        event
        for event in stream_events
        if event.kind == "item_completed"
        and event.metadata["item"]["client_user_message_id"] == "client-steer"
    )
    assert committed_event.metadata["item"]["content"] == "inspect"


class TerminalQueueingAdapter:
    def __init__(self) -> None:
        self.before_return: Callable[[], None] | None = None
        self.call_count = 0

    def next_turn(self, *, items: list[RuntimeItem], tools: object) -> ModelTurnResult:
        del items, tools
        self.call_count += 1
        callback = self.before_return
        self.before_return = None
        if callback is not None:
            callback()
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="first"),),
                ),
            ),
            done=True,
        )


class BlockingSteerCaptureAdapter:
    def __init__(self) -> None:
        self.first_request_started = Event()
        self.release_first_request = Event()
        self.seen_items: list[list[RuntimeItem]] = []

    def next_turn(self, *, items: list[RuntimeItem], tools: object) -> ModelTurnResult:
        del tools
        self.seen_items.append(items)
        if len(self.seen_items) == 1:
            self.first_request_started.set()
            assert self.release_first_request.wait(timeout=2)
            text = "first answer"
        else:
            text = "steer answer"
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text=text),),
                ),
            ),
            done=True,
        )


def test_accepted_steer_continues_same_server_turn(tmp_path: Path) -> None:
    adapter = BlockingSteerCaptureAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    responses = []
    worker = Thread(
        target=lambda: responses.append(
            runtime.handle_user_turn(
                "start",
                turn_id="turn-fixed",
                client_user_message_id="client-start",
            )
        )
    )
    worker.start()
    assert adapter.first_request_started.wait(timeout=2)

    accepted = runtime.steer_active_turn(
        UserMessageInput(
            client_user_message_id="client-steer",
            text="inspect output",
            source="steer",
            target_turn_id="turn-fixed",
        )
    )
    adapter.release_first_request.set()
    worker.join(timeout=2)

    assert not worker.is_alive()
    assert accepted is MailboxAcceptance.ACCEPTED
    assert len(adapter.seen_items) == 2
    second_request_user_texts = [
        block.text
        for request_item in adapter.seen_items[1]
        if request_item.role == "user"
        for block in request_item.blocks
        if block.type == "text"
    ]
    assert second_request_user_texts[-1] == "inspect output"
    assert responses[0].turn is not None
    assert responses[0].turn.turn_id == "turn-fixed"

    history = runtime._session_service.load_history_items(runtime._config.session_id)
    visible = [
        (item.type, item.text)
        for item in history
        if item.type
        in {
            HistoryItemType.USER_MESSAGE,
            HistoryItemType.ASSISTANT_MESSAGE,
        }
    ]
    assert visible == [
        (HistoryItemType.USER_MESSAGE, "start"),
        (HistoryItemType.ASSISTANT_MESSAGE, "first answer"),
        (HistoryItemType.USER_MESSAGE, "inspect output"),
        (HistoryItemType.ASSISTANT_MESSAGE, "steer answer"),
    ]
    resumed = runtime._session_service.load_conversation(runtime._config.session_id)
    resumed_visible = [
        (message.role, message.content)
        for message in resumed.messages
        if message.role in {"user", "assistant"}
    ]
    assert resumed_visible[-4:] == [
        ("user", "start"),
        ("assistant", "first answer"),
        ("user", "inspect output"),
        ("assistant", "steer answer"),
    ]


def test_assistant_history_failure_does_not_commit_pending_steer(
    tmp_path: Path,
) -> None:
    adapter = TerminalQueueingAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    def accept_steer_before_response_returns() -> None:
        assert runtime.steer_active_turn(
            UserMessageInput(
                client_user_message_id="client-steer",
                text="inspect output",
                source="steer",
                target_turn_id="turn-fixed",
            )
        ) is MailboxAcceptance.ACCEPTED

    adapter.before_return = accept_steer_before_response_returns
    append_history_items = runtime._session_service.append_history_items

    def fail_assistant_commit(
        session_id: str,
        items: tuple[HistoryItem, ...],
    ) -> None:
        if any(item.type is HistoryItemType.ASSISTANT_MESSAGE for item in items):
            raise OSError("disk full")
        append_history_items(session_id, items)

    runtime._session_service.append_history_items = fail_assistant_commit

    with pytest.raises(OSError, match="disk full"):
        runtime.handle_user_turn(
            "start",
            turn_id="turn-fixed",
            client_user_message_id="client-start",
        )

    history = runtime._session_service.load_history_items(runtime._config.session_id)
    assert [
        item.text for item in history if item.type is HistoryItemType.USER_MESSAGE
    ] == ["start"]
    assert adapter.call_count == 1
    assert runtime.active_turn_mailbox_id() is None


def test_terminal_race_commits_leftover_steer_without_another_model_request(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = TerminalQueueingAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    events: list[RuntimeStreamEvent] = []
    accepted = False

    def accept_after_pending_check(turn_id: str) -> bool:
        nonlocal accepted
        if not accepted:
            accepted = True
            assert runtime.steer_active_turn(
                UserMessageInput(
                    client_user_message_id="client-late",
                    text="late steer",
                    source="steer",
                    target_turn_id=turn_id,
                )
            ) is MailboxAcceptance.ACCEPTED
        return False

    monkeypatch.setattr(
        runtime,
        "active_turn_has_pending_input",
        accept_after_pending_check,
    )

    response = runtime.handle_user_turn(
        "start",
        turn_id="turn-fixed",
        client_user_message_id="client-start",
        stream_sink=events.append,
    )

    history = runtime._session_service.load_history_items(runtime._config.session_id)
    assert adapter.call_count == 1
    assert [
        item.text for item in history if item.type is HistoryItemType.USER_MESSAGE
    ] == ["start", "late steer"]
    visible = [
        (item.type, item.text)
        for item in history
        if item.type
        in {
            HistoryItemType.USER_MESSAGE,
            HistoryItemType.ASSISTANT_MESSAGE,
        }
    ]
    assert visible == [
        (HistoryItemType.USER_MESSAGE, "start"),
        (HistoryItemType.ASSISTANT_MESSAGE, "first"),
        (HistoryItemType.USER_MESSAGE, "late steer"),
    ]
    assert response.turn is not None
    assert [
        item.text for item in response.turn.items if item.type is TurnItemType.USER_MESSAGE
    ] == ["start", "late steer"]
    assert [
        event.metadata["item"]["client_user_message_id"]
        for event in events
        if event.kind == "item_completed"
    ] == ["client-start", "client-late"]


def test_terminal_turn_consumes_accepted_steer_and_leaves_follow_up_for_host(
    tmp_path: Path,
) -> None:
    adapter = TerminalQueueingAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    def queue_during_in_flight_response() -> None:
        runtime.queue_steering_message(
            "retry first",
            client_turn_id="client-rejected",
            expected_turn_id="turn-fixed",
            active_turn_id="turn-fixed",
            steerable=True,
        )

    adapter.before_return = queue_during_in_flight_response
    runtime.queue_follow_up_message("ordinary later", client_turn_id="client-follow")

    TurnExecutor(runtime).execute_user_turn("start", turn_id="turn-fixed")

    snapshot = runtime.queue_snapshot()
    assert adapter.call_count == 2
    assert snapshot.rejected_steers == ()
    assert [item.text for item in snapshot.follow_ups] == ["ordinary later"]
    assert runtime.next_queued_turn().text == "ordinary later"


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
                                tool_name="Shell",
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
                        "command": [sys.executable, str(script)],
                    },
                    {
                        "id": "session-end",
                        "hook_point": "session_end",
                        "command": [sys.executable, str(script)],
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


def test_agent_runtime_configures_shell_tool_session_owner(tmp_path: Path) -> None:
    bash = BashTool(tmp_path)
    output = BashOutputTool()
    kill = KillShellTool()

    AgentRuntime(
        model_adapter=LegacySingleTurnCaptureAdapter(),
        tool_registry=ToolRegistry.from_tools([bash, output, kill]),
        config=AgentConfig(workspace_root=tmp_path, session_id="session-owner"),
        home_dir=tmp_path / "home",
    )

    assert bash._owner_session_id == "session-owner"
    assert output._session_id == "session-owner"
    assert kill._session_id == "session-owner"


def test_agent_runtime_publishes_shell_lifecycle_events_to_registered_listener(
    tmp_path: Path,
) -> None:
    bash = BashTool(tmp_path)
    runtime = AgentRuntime(
        model_adapter=LegacySingleTurnCaptureAdapter(),
        tool_registry=ToolRegistry.from_tools([bash]),
        config=AgentConfig(workspace_root=tmp_path, session_id="session-shell-events"),
        home_dir=tmp_path / "home",
    )
    events: list[ShellLifecycleEvent] = []
    unsubscribe = runtime.register_shell_lifecycle_listener(events.append)

    result = bash.execute({"command": "printf ready", "run_in_background": True})
    shell_id = str(result.raw_payload["shell_id"])
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        snapshot = SHELL_REGISTRY.read(
            shell_id,
            owner_session_id="session-shell-events",
        )
        if snapshot.get("terminal_state") is not None:
            break
        time.sleep(0.01)
    deadline = time.monotonic() + 2
    while not any(event.kind == "shell.completed" for event in events) and time.monotonic() < deadline:
        time.sleep(0.01)
    unsubscribe()

    assert events[0].kind == "shell.started"
    assert any(event.kind == "shell.completed" for event in events)
    assert all(event.owner_session_id == "session-shell-events" for event in events)
    runtime.close()


def test_agent_runtime_stops_shell_events_after_listener_unsubscribe(tmp_path: Path) -> None:
    bash = BashTool(tmp_path)
    runtime = AgentRuntime(
        model_adapter=LegacySingleTurnCaptureAdapter(),
        tool_registry=ToolRegistry.from_tools([bash]),
        config=AgentConfig(workspace_root=tmp_path, session_id="session-unsubscribe"),
        home_dir=tmp_path / "home",
    )
    events: list[ShellLifecycleEvent] = []
    unsubscribe = runtime.register_shell_lifecycle_listener(events.append)
    unsubscribe()

    result = bash.execute({"command": "printf ready", "run_in_background": True})
    shell_id = str(result.raw_payload["shell_id"])
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        snapshot = SHELL_REGISTRY.read(
            shell_id,
            owner_session_id="session-unsubscribe",
        )
        if snapshot.get("terminal_state") is not None:
            break
        time.sleep(0.01)

    assert events == []
    runtime.close()


def test_agent_runtime_close_terminates_owned_shell_sessions(tmp_path: Path) -> None:
    bash = BashTool(tmp_path)
    runtime = AgentRuntime(
        model_adapter=LegacySingleTurnCaptureAdapter(),
        tool_registry=ToolRegistry.from_tools([bash]),
        config=AgentConfig(workspace_root=tmp_path, session_id="session-close"),
        home_dir=tmp_path / "home",
    )
    started = bash.execute({"command": "sleep 30", "run_in_background": True})
    shell_id = str(started.raw_payload["shell_id"])
    child = SHELL_REGISTRY.execute(
        "sleep 30",
        owner_session_id="session-close:dream:turn_1:abcd1234",
        workdir=str(tmp_path),
        background=True,
    )
    peer = SHELL_REGISTRY.execute(
        "sleep 30",
        owner_session_id="session-close-peer",
        workdir=str(tmp_path),
        background=True,
    )
    child_shell_id = str(child["shell_id"])
    peer_shell_id = str(peer["shell_id"])

    try:
        runtime.close()

        processes = SHELL_REGISTRY.processes()
        assert shell_id not in processes
        assert child_shell_id not in processes
        assert peer_shell_id in processes
    finally:
        SHELL_REGISTRY.kill(peer_shell_id, owner_session_id="session-close-peer")


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
            ShellTool(tmp_path),
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


def test_agent_runtime_leaves_follow_up_for_a_new_host_turn(
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

    assert response.assistant_message == "first answer"
    assert adapter.calls == 1
    queued = runtime.next_queued_turn()
    assert queued is not None
    assert queued.text == "now summarize risks"

    runtime.mark_queued_turn_started(queued.queue_id)
    follow_up_response = runtime.handle_user_turn(
        queued.text,
        image_paths=queued.image_paths,
    )

    assert follow_up_response.assistant_message == "follow-up answer"
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


def test_agent_runtime_preserves_queued_follow_up_images_in_new_host_turn(
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
    queued = runtime.next_queued_turn()
    assert queued is not None
    runtime.mark_queued_turn_started(queued.queue_id)
    runtime.handle_user_turn(queued.text, image_paths=queued.image_paths)

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
    stream_events: list[RuntimeStreamEvent] = []

    assert runtime.queue_snapshot().active_records() == ()

    response = runtime.handle_user_turn("answer first", stream_sink=stream_events.append)

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
    completed_user_items = [
        event.metadata["item"]
        for event in stream_events
        if event.kind == "item_completed"
    ]
    assert len(completed_user_items) == 1
    assert completed_user_items[0]["content"] == "answer first"
    user_history = [
        item.text
        for item in runtime._session_service.load_history_items(runtime._config.session_id)
        if item.type is HistoryItemType.USER_MESSAGE
    ]
    assert user_history == ["answer first"]


def test_agent_runtime_enqueues_background_bash_task_notification(
    tmp_path: Path,
) -> None:
    adapter = SteeringNotificationCaptureAdapter()
    bash_tool = BashTool(tmp_path)
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistry.from_tools([bash_tool]),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
    )

    result = bash_tool.execute(
        {
            "command": python_shell_command(
                "print('runtime-background-ready', flush=True)"
            ),
            "run_in_background": True,
        }
    )

    assert result.success is True
    output_file = Path(str(result.raw_payload["output_file"]))
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if runtime._runtime_notification_inbox.snapshot() and output_file.exists():
            break
        time.sleep(0.01)

    notifications = runtime._runtime_notification_inbox.snapshot()
    assert runtime.queued_messages() == ((), ())
    assert len(notifications) == 1
    assert "<task-notification>" in notifications[0].content
    assert "<task-type>local_bash</task-type>" in notifications[0].content
    assert f"<output-file>{output_file}</output-file>" in notifications[0].content
    assert output_file.read_text(encoding="utf-8").strip() == "runtime-background-ready"
    time.sleep(0.05)
    assert len(runtime._runtime_notification_inbox.snapshot()) == 1
    assert adapter.calls == 0


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
        message.role == "tool"
        and "[project]" in message.content
        and "name='demo'" in message.content
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
        "item_started",
        "item_completed",
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
        "item_started",
        "item_completed",
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
        HistoryItemType.USER_MESSAGE,
        HistoryItemType.CONTEXT_BASELINE_UPDATE,
        HistoryItemType.ASSISTANT_MESSAGE,
    ]
    assert history_items[1].metadata["context_kind"] == "environment_context"
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
        and "README.md:1:search_text mention" in str(message.content)
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

    assert "notes.txt:1:needle one" in search_content

    assert "needle one" in read_content
    assert "line two" in read_content

    assert edit_content == "Success. Updated the following files:\nM notes.txt"
    assert "Diff:" not in edit_content


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

    assert "notes.txt:1:needle one" in str(search_tool_message.content)
    assert "needle one" in str(range_tool_message.content)


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
                ShellTool(tmp_path),
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
                ShellTool(tmp_path),
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


class NoOpPlanThenDoneAdapter:
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
                    "progress_message": "Keeping the existing plan",
                    "tool_call": ToolCall(
                        name="Plan",
                        arguments={
                            "plan": [
                                {
                                    "id": "inspect",
                                    "content": "Inspect runtime",
                                    "status": "in_progress",
                                }
                            ]
                        },
                        reason="confirm current plan",
                    ),
                    "done": False,
                },
            )()
        return type(
            "Action",
            (),
            {
                "assistant_message": "Plan unchanged",
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
        "completed": 0,
        "total": 2,
    }
    assert response.turn is not None
    plan_updates = [
        item for item in response.turn.items if item.type is TurnItemType.PLAN_UPDATE
    ]
    assert len(plan_updates) == 1
    assert plan_updates[0].text == "Updated Plan"
    assert plan_updates[0].metadata == {
        "source": "Plan",
        "completed": 0,
        "total": 2,
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
        "model_visible": False,
    }


def test_agent_runtime_does_not_record_unchanged_plan(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=NoOpPlanThenDoneAdapter(),
    )
    runtime._session_service.save_plan_state(
        runtime._config.session_id,
        PlanState(
            items=(
                PlanItem(
                    id="inspect",
                    content="Inspect runtime",
                    status=PlanStatus.IN_PROGRESS,
                ),
            )
        ),
    )
    events: list[RuntimeStreamEvent] = []

    response = runtime.handle_user_turn(
        "keep the current plan",
        stream_sink=events.append,
    )

    assert response.turn is not None
    assert all(
        item.type is not TurnItemType.PLAN_UPDATE for item in response.turn.items
    )
    assert all(event.kind != "plan_updated" for event in events)


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
    assert second_request_text.count("Find correctness bugs first.") == 1
    assert response.turn is not None
    assert any(
        item.type is TurnItemType.TOOL_RESULT
        and item.tool_name == "Skill"
        and item.metadata.get("transcript_content") == "Activated skill: code-review"
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
                ShellTool(tmp_path),
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
                ShellTool(tmp_path),
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
    assert not any(update.startswith("[memory]") for update in response.progress_updates)
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


class RecordingMemoryService:
    def __init__(self) -> None:
        self.summaries: list[tuple[str, str]] = []

    def append_session_summary(self, session_id: str, summary: str) -> None:
        self.summaries.append((session_id, summary))


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
    memory_service = RecordingMemoryService()
    runtime._memory_service = memory_service  # type: ignore[assignment]
    runtime._memory_extraction_service = extraction_service
    runtime._memory_dream_service = dream_service

    response = runtime.handle_user_turn("continue")

    assert "[memory] memory_extract_started" not in response.progress_updates
    assert "[memory] memory_dream_started" not in response.progress_updates
    assert extraction_service.requests == []
    assert dream_service.requests == []
    assert memory_service.summaries == []


def test_agent_runtime_can_disable_extraction_without_disabling_dream(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=MemoryCaptureAdapter(),
    )
    runtime._config = replace(
        runtime._config,
        memory_extraction_enabled=False,
        memory_dream_enabled=True,
    )
    extraction_service = FakeMemoryExtractionService()
    dream_service = FakeMemoryDreamService()
    runtime._memory_extraction_service = extraction_service
    runtime._memory_dream_service = dream_service

    response = runtime.handle_user_turn("continue")

    assert extraction_service.requests == []
    assert len(dream_service.requests) == 1
    assert not any(update.startswith("[memory]") for update in response.progress_updates)


def test_agent_runtime_can_disable_dream_without_disabling_extraction(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=MemoryCaptureAdapter(),
    )
    runtime._config = replace(
        runtime._config,
        memory_extraction_enabled=True,
        memory_dream_enabled=False,
    )
    extraction_service = FakeMemoryExtractionService()
    dream_service = FakeMemoryDreamService()
    runtime._memory_extraction_service = extraction_service
    runtime._memory_dream_service = dream_service

    response = runtime.handle_user_turn("continue")

    assert len(extraction_service.requests) == 1
    assert dream_service.requests == []
    assert not any(update.startswith("[memory]") for update in response.progress_updates)


def test_agent_runtime_passes_configured_memory_dream_thresholds(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_adapter=MemoryCaptureAdapter(),
        tool_registry=ToolRegistry.from_tools([]),
        config=AgentConfig(
            workspace_root=tmp_path,
            memory_dream_min_hours=48,
            memory_dream_min_sessions=9,
        ),
        home_dir=tmp_path / "home",
    )

    assert runtime._memory_dream_service._min_hours == 48
    assert runtime._memory_dream_service._min_sessions == 9


def test_agent_runtime_throttles_automatic_memory_extraction(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=MemoryCaptureAdapter(),
    )

    response = runtime.handle_user_turn("continue")

    assert not any(update.startswith("[memory]") for update in response.progress_updates)
    trace = runtime._trace_service.load(runtime._config.session_id)
    event = next(event for event in trace if event.kind == "memory_extraction")
    assert event.payload["result"] == "skipped_interval"


def test_agent_runtime_checks_memory_dream_after_successful_turn(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=MemoryCaptureAdapter(),
    )
    dream_service = FakeMemoryDreamService()
    runtime._memory_dream_service = dream_service

    response = runtime.handle_user_turn("continue")

    assert not any(update.startswith("[memory]") for update in response.progress_updates)
    assert dream_service.requests
    request = dream_service.requests[0]
    assert request.session_id == runtime._config.session_id
    assert request.turn_id


def test_agent_runtime_does_not_schedule_memory_after_failed_turn(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ErroringAdapter(),
    )
    extraction_service = FakeMemoryExtractionService()
    dream_service = FakeMemoryDreamService()
    runtime._memory_extraction_service = extraction_service
    runtime._memory_dream_service = dream_service

    response = runtime.handle_user_turn("continue")

    assert response.turn is not None
    assert response.turn.status is TurnStatus.FAILED
    assert extraction_service.requests == []
    assert dream_service.requests == []


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


def test_agent_runtime_extends_provider_timeline_without_reset_between_turns(
    tmp_path: Path,
) -> None:
    adapter = UsageMetadataAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    runtime.handle_user_turn("U1")
    runtime.handle_user_turn("U2")

    payload = runtime._session_service.load_provider_timeline_state(
        runtime._config.session_id
    )
    assert payload is not None
    state = ProviderTimelineState.from_dict(payload)
    assert state.reset_count == 0
    contents = [message.content for message in state.messages]
    u1_index = contents.index("U1")
    a1_index = contents.index("done 1")
    u2_index = contents.index("U2")
    assert u1_index < a1_index < u2_index


def test_agent_runtime_does_not_append_conversation_summary_without_compaction(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=UsageMetadataAdapter(),
    )
    runtime.rebind_session(
        replace(
            runtime._config,
            recent_message_count=1,
            memory_enabled=False,
        )
    )

    runtime.handle_user_turn("U1")
    runtime.handle_user_turn("U2")

    payload = runtime._session_service.load_provider_timeline_state(
        runtime._config.session_id
    )
    assert payload is not None
    state = ProviderTimelineState.from_dict(payload)
    assert all(
        message.metadata.get("context_kind") != "conversation_context"
        for message in state.messages
    )


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
    def __init__(self) -> None:
        self.calls = 0

    def next_turn(self, *, items, tools):
        del items, tools
        self.calls += 1
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
                                tool_name="Shell",
                                tool_arguments={"command": "rg -n --glob '*.py' 'capability activation' ."},
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
                        blocks=(RuntimeBlock(type="text", text="Deferred tool completed."),),
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
                            tool_name="Shell",
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


class WeatherContributionTool:
    spec = ToolSpec(
        name="weather_forecast",
        description="Get a weather forecast",
        parameters=(),
    )

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        del arguments
        return ToolResult(success=True, summary="Weather forecast unavailable")


class OverviewToolContributionProvider(ToolContributionProvider):
    def provide(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        interrupt_token=None,
    ) -> tuple[object, ...]:
        del conversation, plan_state, interrupt_token
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


class ToolSearchThenContributionAdapter:
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
                                tool_name="ToolSearch",
                                tool_arguments={"query": "workspace summary"},
                                call_id="call_tool_search_1",
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
                                tool_name="workspace_summary",
                                tool_arguments={"path": "."},
                                call_id="call_workspace_summary_after_search",
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
                    blocks=(RuntimeBlock(type="text", text="Discovered tool completed"),),
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


def test_agent_runtime_commits_user_message_with_client_identity(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=ReasoningTextDoneAdapter(),
    )
    events: list[RuntimeStreamEvent] = []

    response = runtime.handle_user_turn(
        "inspect the repo",
        stream_sink=events.append,
        turn_id="turn-fixed",
        client_user_message_id="client-1",
    )

    assert response.turn is not None
    user_history = [
        item
        for item in runtime._session_service.load_history_items(
            runtime._config.session_id
        )
        if item.type is HistoryItemType.USER_MESSAGE
    ]
    assert [(item.id, item.text, item.metadata) for item in user_history] == [
        (
            "turn-fixed:user:client-1",
            "inspect the repo",
            {
                "client_user_message_id": "client-1",
                "source": "submit",
                "image_paths": [],
            },
        )
    ]
    assert [
        event.kind
        for event in events
        if event.kind in {"item_started", "item_completed"}
    ] == ["item_started", "item_completed"]
    user_turn_items = [
        item for item in response.turn.items if item.type is TurnItemType.USER_MESSAGE
    ]
    assert len(user_turn_items) == 1
    assert user_turn_items[0].metadata["history_committed"] is True


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
    assert context.conversation_summary is None


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


def test_agent_runtime_allows_recovery_after_repeated_missing_file_reads(
    tmp_path: Path,
) -> None:
    adapter = RepeatMissingReadAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime._config = AgentConfig(workspace_root=tmp_path)

    response = runtime.handle_user_turn("请简短总结这个仓库的入口文件和主要模块")

    assert response.turn is not None
    assert response.turn.stop_reason is StopReason.LOOP_DETECTED
    assert response.turn.status is TurnStatus.COMPLETED
    assert "no new evidence" in response.assistant_message.lower()
    assert adapter.calls > 3
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
                role="user" if index % 2 == 0 else "assistant",
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
                ShellTool(tmp_path),
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
    assert "Shell" in adapter.seen_tool_names[0]
    assert "Edit" in adapter.seen_tool_names[0]
    assert any(item.type is TurnItemType.TOOL_EXPOSURE for item in response.turn.items)


def test_agent_runtime_executes_deferred_tool_calls_from_model(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_adapter=DeferredToolRequestAdapter(),
        tool_registry=ToolRegistry.from_tools(
            [
                LSTool(tmp_path),
                ShellTool(tmp_path),
            ]
        ),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
    )

    response = runtime.handle_user_turn("please inspect this repository and summarize it")

    assert response.turn is not None
    assert response.turn.status is TurnStatus.COMPLETED
    assert response.turn.stop_reason is StopReason.ASSISTANT_COMPLETED
    assert response.assistant_message == "Deferred tool completed."
    assert any(
        item.type is TurnItemType.TOOL_RESULT
        and item.tool_name == "Shell"
        and item.metadata.get("success") is True
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


def test_agent_runtime_runs_deepseek_multi_tool_batch_in_parallel(
    tmp_path: Path,
) -> None:
    adapter = MultiToolThenDoneAdapter()
    read_probe = ParallelReadProbe()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistry.from_tools([read_probe]),
        config=AgentConfig(
            workspace_root=tmp_path,
            provider=ProviderId.DEEPSEEK,
            protocol=ProtocolId.CHAT_COMPLETIONS,
        ),
        home_dir=tmp_path / "home",
    )

    response = runtime.handle_user_turn("inspect both files")

    assert response.turn is not None
    assert response.turn.status is TurnStatus.COMPLETED
    assert read_probe.max_active == 2
    assert adapter.calls == 2
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


def test_agent_runtime_searches_then_executes_deferred_contributed_tool(
    tmp_path: Path,
) -> None:
    adapter = ToolSearchThenContributionAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistry.from_tools([LSTool(tmp_path)]),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
    )
    runtime._tool_exposure_planner._defer_threshold = 2
    runtime._runtime_contributed_tools = lambda **_kwargs: (
        ContributedSummaryTool(),
        WeatherContributionTool(),
    )

    response = runtime.handle_user_turn("find and use the workspace summary tool")

    assert response.turn is not None
    assert response.assistant_message == "Discovered tool completed"
    assert len(adapter.seen_tool_names) == 3
    assert all("ToolSearch" in names for names in adapter.seen_tool_names)
    assert all("workspace_summary" not in names for names in adapter.seen_tool_names)
    assert all("weather_forecast" not in names for names in adapter.seen_tool_names)
    tool_results = [
        item for item in response.turn.items if item.type is TurnItemType.TOOL_RESULT
    ]
    assert [item.tool_name for item in tool_results] == [
        "ToolSearch",
        "workspace_summary",
    ]
    conversation = runtime._session_service.load_conversation(runtime._config.session_id)
    assert [
        message.tool_call_id for message in conversation.messages if message.role == "tool"
    ] == ["call_tool_search_1", "call_workspace_summary_after_search"]


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


def test_agent_runtime_does_not_disable_tools_after_twelve_steps(
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
    assert "none" not in adapter.tool_choices


def test_agent_runtime_pops_latest_follow_up_without_touching_steering(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=SteeringNotificationCaptureAdapter(),
    )
    runtime.queue_steering_message("inspect current output")
    runtime.queue_follow_up_message("first follow-up")
    runtime.queue_follow_up_message(
        "second [image #1]",
        image_paths=("/tmp/second.png",),
        client_turn_id="follow-up-2",
    )

    popped = runtime.pop_last_follow_up_input()

    assert popped is not None
    assert popped.kind == "follow_up"
    assert popped.text == "second [image #1]"
    assert popped.image_paths == ("/tmp/second.png",)
    assert popped.client_turn_id == "follow-up-2"
    assert runtime.queued_messages() == (
        ("inspect current output",),
        ("first follow-up",),
    )


def test_agent_runtime_pop_latest_follow_up_is_idempotent_when_empty(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=SteeringNotificationCaptureAdapter(),
    )
    runtime.queue_steering_message("keep steering")

    assert runtime.pop_last_follow_up_input() is None
    assert runtime.queued_messages() == (("keep steering",), ())
