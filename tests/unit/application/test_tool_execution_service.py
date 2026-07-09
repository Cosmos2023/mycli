from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Callable

from mycli.application.runtime.tools.tool_execution_service import ToolExecutionService
from mycli.application.runtime.tools.runtime_policy import RuntimePolicyGate
from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.domain.conversation import Conversation
from mycli.domain.runtime import (
    CollaborationMode,
    ExecutionPolicy,
    ExecPolicyDecision,
    ExecPolicyRule,
    ExecPolicyRuleSet,
    ExecPolicySource,
    InvokedSkillSnapshot,
    PlanState,
    RuntimeStreamEvent,
    RuntimeInterruptToken,
    SandboxMode,
    SandboxProfile,
    TurnItemType,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.contributed_tools import (
    ToolContributionDescriptor,
    ToolContributionLifecycleState,
    ToolContributionRegistration,
    ToolContributionScope,
    ToolContributionSource,
)
from mycli.domain.tooling.exposure import ToolExposure, ToolExposureEntry, ToolRouteKey, ToolRouteSource
from mycli.services.context.context_manager import ContextManager
from mycli.services.file_history import FileHistoryService
from mycli.services.hooks import (
    HookAction,
    HookAllowlist,
    HookContext,
    HookManager,
    HookPoint,
    HookResult,
    register_configured_hooks,
)
from mycli.services.tracing import TraceService
from mycli.services.approval import ApprovalService, SafetyPolicy
from mycli.tools.base import ToolEffectProfile, ToolParameter, ToolResult, ToolSpec
from mycli.tools.bash import BashTool
from mycli.tools.registry import ToolRegistry
from mycli.tools.routing.tool_router import ToolRouter
from mycli.tools.write import WriteTool


class FakeTool:
    spec = ToolSpec(
        name="read_file",
        description="Read a file",
        parameters=(ToolParameter("path", "string"),),
    )

    def __init__(self) -> None:
        self.seen_arguments: list[dict[str, object]] = []

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        self.seen_arguments.append(dict(arguments))
        path = str(arguments["path"])
        return ToolResult(
            success=True,
            summary=f"Read {path}",
            raw_payload={"path": path, "content": f"content of {path}"},
        )


class FakeEditTool:
    spec = ToolSpec(
        name="edit_file",
        description="Edit a file",
        parameters=(ToolParameter("path", "string"), ToolParameter("new_content", "string")),
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        path = str(arguments["path"])
        target = self._workspace_root / path
        target.write_text(str(arguments["new_content"]), encoding="utf-8")
        return ToolResult(
            success=True,
            summary=f"Edited {path}",
            raw_payload={"path": path},
        )


class FakeContractMutationTool:
    spec = ToolSpec(
        name="ReplaceFile",
        description="Replace a file through the mutation contract",
        parameters=(ToolParameter("target", "string"), ToolParameter("content", "string")),
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def mutation_targets(self, arguments: dict[str, object]) -> tuple[str, ...]:
        return (str(arguments["target"]),)

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        path = str(arguments["target"])
        target = self._workspace_root / path
        target.write_text(str(arguments["content"]), encoding="utf-8")
        return ToolResult(
            success=True,
            summary=f"Replaced {path}",
            raw_payload={"path": path},
        )


class FakeSkillTool:
    spec = ToolSpec(
        name="Skill",
        description="Load skill",
        parameters=(ToolParameter("skill_name", "string"),),
    )

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        return ToolResult(
            success=True,
            summary="Activated skill: code-review",
            raw_payload={
                "skill_name": str(arguments["skill_name"]),
                "description": "Review code",
                "content": "Find correctness bugs first.",
                "source_path": "/tmp/code-review.md",
            },
        )


class FakeAskUserQuestionTool:
    spec = ToolSpec(
        name="AskUserQuestion",
        description="Ask the user a structured question",
        parameters=(ToolParameter("question", "string"), ToolParameter("options", "array")),
    )

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        return ToolResult(
            success=True,
            summary="Awaiting user response",
            raw_payload={
                "status": "awaiting_user_response",
                "question": str(arguments["question"]),
                "header": "Scope",
                "options": [
                    {"label": "Runtime", "description": "Only runtime contract"},
                    {"label": "TUI", "description": "Render the request"},
                    {"label": "Other", "description": "Custom answer"},
                ],
                "multi_select": False,
            },
        )


class FakeLongOutputTool:
    spec = ToolSpec(
        name="long_output",
        description="Return long diagnostics",
        parameters=(),
    )

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        return ToolResult(
            success=False,
            summary="summary " * 80,
            error="error " * 80,
            raw_payload={
                "stdout": "stdout " * 80,
                "stderr": "stderr " * 80,
                "error_kind": "long_output",
            },
        )


class FakeNetworkTool:
    spec = ToolSpec(
        name="WebFetch",
        description="Fetch a URL",
        parameters=(ToolParameter("url", "string"),),
    )

    def __init__(self) -> None:
        self.seen_arguments: list[dict[str, object]] = []

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(filesystem="none", network=True)

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        self.seen_arguments.append(dict(arguments))
        return ToolResult(
            success=True,
            summary="Fetched URL",
            raw_payload={"url": str(arguments["url"])},
        )


class FakeUnknownEffectTool:
    spec = ToolSpec(
        name="MysteryTool",
        description="Tool with no declared effect profile",
        parameters=(ToolParameter("payload", "string"),),
    )

    def __init__(self) -> None:
        self.seen_arguments: list[dict[str, object]] = []

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        self.seen_arguments.append(dict(arguments))
        return ToolResult(
            success=True,
            summary="Ran mystery tool",
            raw_payload={"payload": str(arguments["payload"])},
        )


class FakeContributedTool:
    spec = ToolSpec(
        name="runtime_echo",
        description="Echo through runtime contribution",
        parameters=(ToolParameter("message", "string"),),
    )

    def __init__(self) -> None:
        self.seen_arguments: list[dict[str, object]] = []

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        self.seen_arguments.append(dict(arguments))
        return ToolResult(
            success=True,
            summary=f"Echo {arguments['message']}",
            raw_payload={"message": arguments["message"]},
        )


class FakeInterruptTool:
    spec = ToolSpec(
        name="interrupt_tool",
        description="Interrupt while running",
        parameters=(ToolParameter("path", "string"),),
    )

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        raise KeyboardInterrupt


class FakeInterruptMutationTool:
    spec = ToolSpec(
        name="interrupt_write",
        description="Interrupt while mutating a file",
        parameters=(ToolParameter("path", "string"),),
    )

    def mutation_targets(self, arguments: dict[str, object]) -> tuple[str, ...]:
        return (str(arguments["path"]),)

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        raise KeyboardInterrupt


class FakeSlowSafeTool:
    spec = ToolSpec(
        name="Read",
        description="Slow safe read",
        parameters=(ToolParameter("path", "string"),),
        supports_parallel_tool_calls=True,
    )

    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        self.started.set()
        self.release.wait(timeout=30)
        return ToolResult(
            success=True,
            summary=f"Read {arguments['path']}",
            raw_payload={"path": arguments["path"]},
        )


class FakeInterruptingSafeTool:
    spec = ToolSpec(
        name="Grep",
        description="Interrupt safe grep",
        parameters=(ToolParameter("pattern", "string"),),
        supports_parallel_tool_calls=True,
    )

    def __init__(self, token: RuntimeInterruptToken) -> None:
        self._token = token
        self.started = threading.Event()

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        del arguments
        self.started.set()
        self._token.request("test_interrupt")
        raise KeyboardInterrupt


def _tool_exposure() -> ToolExposure:
    return ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("read_file"),
                source=ToolRouteSource.REGISTRY,
                spec=FakeTool.spec,
            ),
        )
    )


def _service(
    tmp_path: Path,
    *,
    hook_manager: HookManager,
    registry: ToolRegistry | None = None,
    trace_service: TraceService | None = None,
    file_history: FileHistoryService | None = None,
    record_invoked_skill: Callable[[InvokedSkillSnapshot], None] | None = None,
    write_diagnostics_runner: Callable[[tuple[str, ...]], dict[str, object]] | None = None,
    policy_gate: RuntimePolicyGate | None = None,
) -> tuple[ToolExecutionService, FakeTool]:
    fake_tool = FakeTool()
    tool_registry = registry or ToolRegistry.from_tools([fake_tool])

    def append_turn_item(**kwargs: object) -> None:
        turn_items = kwargs["turn_items"]
        item = kwargs["item"]
        assert isinstance(turn_items, list)
        turn_items.append(item)

    service = ToolExecutionService(
        session_id="demo",
        context_manager=ContextManager(),
        trace_service=trace_service or TraceService(home_dir=tmp_path / "home"),
        append_turn_item=append_turn_item,
        append_lifecycle_events=lambda **_: None,
        apply_tool_effects=lambda **kwargs: kwargs["plan_state"],
        normalize_tool_call=lambda call: call,
        hook_manager=hook_manager,
        file_history=file_history,
        record_invoked_skill=record_invoked_skill,
        write_diagnostics_runner=write_diagnostics_runner,
        policy_gate=policy_gate,
    )
    router = ToolRouter(
        tool_registry=tool_registry,
        contributed_tool_registry=ToolContributionRegistry(),
    )
    service._test_router = router  # type: ignore[attr-defined]
    return service, fake_tool


def _set_default_sandbox(
    gate: RuntimePolicyGate,
    *,
    workspace_root: Path,
    denied_read_roots: tuple[Path, ...] = (),
    denied_read_globs: tuple[str, ...] = (),
    filesystem: str = "workspace_write",
    network: str = "enabled",
    shell: str = "restricted",
) -> None:
    gate.default_policy = lambda: ExecutionPolicy(  # type: ignore[method-assign]
        sandbox=SandboxProfile(
            workspace_roots=(workspace_root,),
            cwd=workspace_root,
            writable_roots=(workspace_root,),
            denied_read_roots=denied_read_roots,
            denied_read_globs=denied_read_globs,
            filesystem=filesystem,  # type: ignore[arg-type]
            network=network,  # type: ignore[arg-type]
            shell=shell,  # type: ignore[arg-type]
        )
    )


def test_tool_execution_service_workspace_write_outside_workspace_requires_approval(
    tmp_path: Path,
) -> None:
    service, fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        policy_gate=RuntimePolicyGate(
            approval_service=ApprovalService(
                SafetyPolicy(workspace_root=tmp_path),
            )
        ),
        registry=ToolRegistry.from_tools([WriteTool(tmp_path)]),
    )
    exposure = ToolExposure(
        entries=(
            *_tool_exposure().entries,
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Write"),
                source=ToolRouteSource.REGISTRY,
                spec=WriteTool(tmp_path).spec,
            ),
        ),
    )
    router = service._test_router  # type: ignore[attr-defined]
    conversation = Conversation(session_id="demo")
    turn_items = []

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="Write",
            arguments={"file_path": "../outside.txt", "content": "escape\n"},
            reason="escape",
            call_id="call_escape_1",
        ),
        tool_router=router,
        tool_exposure=exposure,
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
    )

    assert fake_tool.seen_arguments == []
    assert conversation.messages[-1].role == "tool"
    assert "Tool needs approval before execution." in conversation.messages[-1].content
    trace = TraceService(home_dir=tmp_path / "home").load("demo")
    policy_trace = next(event for event in trace if event.kind == "runtime_policy_decision")
    assert policy_trace.payload["decision"] == "needs_approval"
    assert policy_trace.payload["policy"] == "workspace_write_boundary"
    assert policy_trace.payload["reason_code"] == "needs_choice"
    assert policy_trace.payload["tool_name"] == "Write"
    assert policy_trace.payload["argument_keys"] == ["content", "file_path"]
    assert "escape\n" not in str(policy_trace.payload)
    assert "outside.txt" not in str(policy_trace.payload)


def test_tool_execution_service_denied_read_root_blocks_execution_without_path_leak(
    tmp_path: Path,
) -> None:
    denied_root = tmp_path / ".secrets"
    service, fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        policy_gate=RuntimePolicyGate(
            approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        ),
    )
    _set_default_sandbox(
        service._policy_gate,  # type: ignore[attr-defined]
        workspace_root=tmp_path,
        denied_read_roots=(denied_root,),
    )
    router = service._test_router  # type: ignore[attr-defined]
    conversation = Conversation(session_id="demo")

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="read_file",
            arguments={"path": str(denied_root / "token.txt")},
            reason="read secret",
            call_id="call_read_secret",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert fake_tool.seen_arguments == []
    assert conversation.messages[-1].role == "tool"
    assert "Tool denied by runtime policy: read_file" in conversation.messages[-1].content
    assert "token.txt" not in conversation.messages[-1].content
    trace = TraceService(home_dir=tmp_path / "home").load("demo")
    policy_trace = next(event for event in trace if event.kind == "runtime_policy_decision")
    assert policy_trace.payload["decision"] == "denied"
    assert policy_trace.payload["policy"] == "sandbox_denied_read_policy"
    assert policy_trace.payload["reason_code"] == "denied_read_root"
    assert "token.txt" not in str(policy_trace.payload)


def test_runtime_policy_denial_message_includes_tool_policy_and_reason(
    tmp_path: Path,
) -> None:
    service, fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        policy_gate=RuntimePolicyGate(
            approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        ),
        registry=ToolRegistry.from_tools([FakeUnknownEffectTool()]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    conversation = Conversation(session_id="demo")

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="MysteryTool",
            arguments={"payload": "secret-payload"},
            reason="unknown",
            call_id="call_unknown_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("MysteryTool"),
                    source=ToolRouteSource.REGISTRY,
                    spec=FakeUnknownEffectTool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert fake_tool.seen_arguments == []
    assert (
        "Tool denied by runtime policy: MysteryTool "
        "(policy=unsupported_tool, reason=deny)."
    ) in conversation.messages[-1].content


def test_runtime_policy_gate_plan_mode_denies_mutating_tools_and_allows_read_only(
    tmp_path: Path,
) -> None:
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
        collaboration_mode=CollaborationMode.PLAN,
    )

    write_decision = gate.decide(
        ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "hello\n"},
            reason="write",
            call_id="call_write_1",
        ),
        effect_profile=ToolEffectProfile(filesystem="write"),
    )
    read_decision = gate.decide(
        ToolCall(
            name="Read",
            arguments={"file_path": "notes.txt"},
            reason="inspect",
            call_id="call_read_1",
        ),
        effect_profile=ToolEffectProfile(filesystem="read"),
    )

    assert write_decision.kind.value == "denied"
    assert write_decision.policy == "collaboration_mode"
    assert write_decision.reason_code == "plan_mode_blocks_mutating_tool"
    assert write_decision.to_trace_payload()["collaboration_mode"] == "plan"
    assert read_decision.kind.value == "allowed"


def test_runtime_policy_gate_workspace_write_outside_workspace_requires_approval(
    tmp_path: Path,
) -> None:
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
    )

    decision = gate.decide(
        ToolCall(
            name="Write",
            arguments={"file_path": "../outside.txt", "content": "hello\n"},
            reason="write outside workspace",
            call_id="call_write_outside",
        ),
        effect_profile=ToolEffectProfile(filesystem="write"),
    )

    assert decision.kind.value == "needs_approval"
    assert decision.policy == "workspace_write_boundary"
    assert decision.reason_code == "needs_choice"
    assert decision.to_trace_payload()["sandbox"] == {
        "workspace_roots": 1,
        "writable_roots": 1,
        "denied_read_roots": 0,
        "denied_read_globs": 2,
        "sandbox_mode": "workspace-write",
        "filesystem": "workspace_write",
        "network": "disabled",
        "shell": "restricted",
    }


def test_runtime_policy_gate_denies_read_inside_denied_read_root(
    tmp_path: Path,
) -> None:
    denied_root = tmp_path / ".secrets"
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
    )
    policy = ExecutionPolicy(
        sandbox=SandboxProfile(
            workspace_roots=(tmp_path,),
            cwd=tmp_path,
            writable_roots=(tmp_path,),
            denied_read_roots=(denied_root,),
            denied_read_globs=(),
        )
    )

    decision = gate.decide(
        ToolCall(
            name="Read",
            arguments={"file_path": str(denied_root / "token.txt")},
            reason="read secret",
            call_id="call_read_secret",
        ),
        policy=policy,
        effect_profile=ToolEffectProfile(filesystem="read"),
    )

    assert decision.kind.value == "denied"
    assert decision.policy == "sandbox_denied_read_policy"
    assert decision.reason_code == "denied_read_root"
    payload = decision.to_trace_payload()
    assert payload["sandbox"]["denied_read_roots"] == 1
    assert "token.txt" not in str(payload)


def test_runtime_policy_gate_default_policy_uses_configured_denied_reads(
    tmp_path: Path,
) -> None:
    denied_root = tmp_path / ".private"
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
        denied_read_roots=(denied_root,),
        denied_read_globs=("**/*.pem",),
    )

    root_decision = gate.decide(
        ToolCall(
            name="Read",
            arguments={"file_path": str(denied_root / "token.txt")},
            reason="read secret",
            call_id="call_read_private",
        ),
        effect_profile=ToolEffectProfile(filesystem="read"),
    )
    glob_decision = gate.decide(
        ToolCall(
            name="Grep",
            arguments={"pattern": "KEY", "path": ".", "include": "*.pem"},
            reason="search pem",
            call_id="call_grep_pem",
        ),
        effect_profile=ToolEffectProfile(filesystem="read"),
    )

    assert root_decision.kind.value == "denied"
    assert root_decision.reason_code == "denied_read_root"
    assert glob_decision.kind.value == "denied"
    assert glob_decision.reason_code == "denied_read_glob"


def test_runtime_policy_gate_read_only_ignores_configured_writable_roots(
    tmp_path: Path,
) -> None:
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
        writable_roots=(tmp_path / "scratch",),
        sandbox_mode=SandboxMode.READ_ONLY,
    )

    policy = gate.default_policy()

    assert policy.sandbox.mode == SandboxMode.READ_ONLY
    assert policy.sandbox.filesystem == "read_only"
    assert policy.sandbox.writable_roots == ()


def test_runtime_policy_gate_denied_read_root_matches_workspace_relative_path(
    tmp_path: Path,
) -> None:
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
        denied_read_roots=(tmp_path / ".private",),
    )

    decision = gate.decide(
        ToolCall(
            name="Read",
            arguments={"file_path": ".private/token.txt"},
            reason="read secret",
            call_id="call_read_private_relative",
        ),
        effect_profile=ToolEffectProfile(filesystem="read"),
    )

    assert decision.kind.value == "denied"
    assert decision.reason_code == "denied_read_root"


def test_runtime_policy_gate_denies_grep_matching_denied_read_glob(
    tmp_path: Path,
) -> None:
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
    )
    policy = ExecutionPolicy(
        sandbox=SandboxProfile(
            workspace_roots=(tmp_path,),
            cwd=tmp_path,
            writable_roots=(tmp_path,),
            denied_read_roots=(),
            denied_read_globs=("**/.env",),
        )
    )

    decision = gate.decide(
        ToolCall(
            name="Grep",
            arguments={"pattern": "TOKEN", "path": ".", "include": "**/.env"},
            reason="search env",
            call_id="call_grep_env",
        ),
        policy=policy,
        effect_profile=ToolEffectProfile(filesystem="read"),
    )

    assert decision.kind.value == "denied"
    assert decision.policy == "sandbox_denied_read_policy"
    assert decision.reason_code == "denied_read_glob"
    assert decision.to_trace_payload()["argument_keys"] == ["include", "path", "pattern"]


def test_runtime_policy_gate_denies_ls_inside_denied_read_root(
    tmp_path: Path,
) -> None:
    denied_root = tmp_path / ".secrets"
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
    )
    policy = ExecutionPolicy(
        sandbox=SandboxProfile(
            workspace_roots=(tmp_path,),
            cwd=tmp_path,
            writable_roots=(tmp_path,),
            denied_read_roots=(denied_root,),
            denied_read_globs=(),
        )
    )

    decision = gate.decide(
        ToolCall(
            name="LS",
            arguments={"path": str(denied_root)},
            reason="list secrets",
            call_id="call_ls_secret",
        ),
        policy=policy,
        effect_profile=ToolEffectProfile(filesystem="read"),
    )

    assert decision.kind.value == "denied"
    assert decision.reason_code == "denied_read_root"


def test_runtime_policy_gate_denies_grep_include_inside_denied_glob(
    tmp_path: Path,
) -> None:
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
    )
    policy = ExecutionPolicy(
        sandbox=SandboxProfile(
            workspace_roots=(tmp_path,),
            cwd=tmp_path,
            writable_roots=(tmp_path,),
            denied_read_roots=(),
            denied_read_globs=("**/*.env",),
        )
    )

    decision = gate.decide(
        ToolCall(
            name="Grep",
            arguments={"pattern": "TOKEN", "path": ".", "include": "*.env"},
            reason="search env",
            call_id="call_grep_env",
        ),
        policy=policy,
        effect_profile=ToolEffectProfile(filesystem="read"),
    )

    assert decision.kind.value == "denied"
    assert decision.reason_code == "denied_read_glob"


def test_runtime_policy_gate_allows_write_inside_writable_root(
    tmp_path: Path,
) -> None:
    writable_root = tmp_path / ".mycli" / "cache"
    writable_root.mkdir(parents=True)
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(
            SafetyPolicy(
                workspace_root=tmp_path,
                writable_roots=(writable_root,),
            )
        ),
        workspace_root=tmp_path,
        writable_roots=(writable_root,),
    )

    decision = gate.decide(
        ToolCall(
            name="Write",
            arguments={
                "file_path": str(writable_root / "state.json"),
                "content": "{}",
            },
            reason="write cache",
            call_id="call_write_cache",
        ),
        effect_profile=ToolEffectProfile(filesystem="write"),
    )

    assert decision.kind.value == "allowed"
    assert decision.policy == "workspace_write_tool"
    assert decision.to_trace_payload()["sandbox"]["writable_roots"] == 2


def test_runtime_policy_gate_allows_background_shell_output_reads(
    tmp_path: Path,
) -> None:
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
    )

    decision = gate.decide(
        ToolCall(
            name="BashOutput",
            arguments={"shell_id": "shell_123"},
            reason="read background shell output",
            call_id="call_output_1",
        ),
        effect_profile=ToolEffectProfile(process=True),
    )

    assert decision.kind.value == "allowed"
    assert decision.policy == "builtin_safe_tool"


def test_runtime_policy_gate_workspace_policy_update_refreshes_collaboration_mode(
    tmp_path: Path,
) -> None:
    call = ToolCall(
        name="Write",
        arguments={"file_path": "notes.txt", "content": "hello\n"},
        reason="write",
        call_id="call_write_1",
    )
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(
            SafetyPolicy(workspace_root=tmp_path, auto_approve_medium=True),
        ),
        workspace_root=tmp_path,
    )

    assert gate.decide(call, effect_profile=ToolEffectProfile(filesystem="write")).kind.value == "allowed"

    gate.set_workspace_policy(
        workspace_root=tmp_path,
        execpolicy_rules=ExecPolicyRuleSet(),
        collaboration_mode=CollaborationMode.PLAN,
    )

    decision = gate.decide(call, effect_profile=ToolEffectProfile(filesystem="write"))
    assert decision.kind.value == "denied"
    assert decision.policy == "collaboration_mode"


def test_tool_execution_service_plan_mode_denial_uses_actionable_summary(
    tmp_path: Path,
) -> None:
    write_tool = WriteTool(tmp_path)
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        policy_gate=RuntimePolicyGate(
            approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
            workspace_root=tmp_path,
            collaboration_mode=CollaborationMode.PLAN,
        ),
        registry=ToolRegistry.from_tools([write_tool]),
    )
    conversation = Conversation(session_id="demo")
    turn_items = []

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "hello\n"},
            reason="write",
            call_id="call_write_1",
        ),
        tool_router=service._test_router,  # type: ignore[attr-defined]
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("Write"),
                    source=ToolRouteSource.REGISTRY,
                    spec=write_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
    )

    assert not (tmp_path / "notes.txt").exists()
    assert "Plan mode is read-only; blocked Write" in conversation.messages[-1].content
    assert turn_items[-1].metadata["summary"] == (
        "Plan mode is read-only; blocked Write. "
        "Switch to /mode default to allow mutating tools."
    )
    assert turn_items[-1].metadata["raw_payload"]["runtime_policy"]["collaboration_mode"] == "plan"


def test_tool_execution_service_sandbox_read_only_blocks_write_tool(
    tmp_path: Path,
) -> None:
    write_tool = WriteTool(tmp_path)
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
    )
    _set_default_sandbox(gate, workspace_root=tmp_path, filesystem="read_only")
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        policy_gate=gate,
        registry=ToolRegistry.from_tools([write_tool]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Write"),
                source=ToolRouteSource.REGISTRY,
                spec=write_tool.spec,
            ),
        )
    )

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "blocked\n"},
            reason="write",
            call_id="call_write_read_only",
        ),
        tool_router=router,
        tool_exposure=exposure,
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert not (tmp_path / "notes.txt").exists()
    trace = TraceService(home_dir=tmp_path / "home").load("demo")
    policy_trace = next(event for event in trace if event.kind == "runtime_policy_decision")
    assert policy_trace.payload["decision"] == "denied"
    assert policy_trace.payload["policy"] == "sandbox_filesystem_policy"
    assert policy_trace.payload["reason_code"] == "filesystem_write_blocked_by_read_only"
    assert policy_trace.payload["effect"] == {
        "filesystem": "write",
        "network": False,
        "process": False,
    }
    assert "blocked\n" not in str(policy_trace.payload)


def test_tool_execution_service_sandbox_read_only_blocks_unknown_filesystem_effect(
    tmp_path: Path,
) -> None:
    unknown_tool = FakeUnknownEffectTool()
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
    )
    _set_default_sandbox(gate, workspace_root=tmp_path, filesystem="read_only")
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        policy_gate=gate,
        registry=ToolRegistry.from_tools([unknown_tool]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("MysteryTool"),
                source=ToolRouteSource.REGISTRY,
                spec=unknown_tool.spec,
            ),
        )
    )

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="MysteryTool",
            arguments={"payload": "secret-payload"},
            reason="unknown effect",
            call_id="call_unknown_read_only",
        ),
        tool_router=router,
        tool_exposure=exposure,
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert unknown_tool.seen_arguments == []
    trace = TraceService(home_dir=tmp_path / "home").load("demo")
    policy_trace = next(event for event in trace if event.kind == "runtime_policy_decision")
    assert policy_trace.payload["decision"] == "denied"
    assert policy_trace.payload["policy"] == "sandbox_filesystem_policy"
    assert policy_trace.payload["reason_code"] == "filesystem_unknown_blocked_by_read_only"
    assert policy_trace.payload["effect"] == {
        "filesystem": "unknown",
        "network": False,
        "process": False,
    }
    assert "secret-payload" not in str(policy_trace.payload)


def test_tool_execution_service_sandbox_shell_disabled_blocks_execpolicy_allow(
    tmp_path: Path,
) -> None:
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
        execpolicy_rules=ExecPolicyRuleSet(
            rules=(
                ExecPolicyRule(
                    source=ExecPolicySource.PROJECT,
                    index=0,
                    pattern=("python3", "-c"),
                    decision=ExecPolicyDecision.ALLOW,
                ),
            )
        ),
    )
    _set_default_sandbox(gate, workspace_root=tmp_path, shell="disabled")
    service, fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        policy_gate=gate,
        registry=ToolRegistry.from_tools([BashTool(tmp_path)]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Bash"),
                source=ToolRouteSource.REGISTRY,
                spec=BashTool(tmp_path).spec,
            ),
        )
    )

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Bash",
            arguments={"command": "python3 -c 'print(\"secret-output\")'"},
            reason="probe",
            call_id="call_shell_disabled",
        ),
        tool_router=router,
        tool_exposure=exposure,
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert fake_tool.seen_arguments == []
    trace = TraceService(home_dir=tmp_path / "home").load("demo")
    policy_trace = next(event for event in trace if event.kind == "runtime_policy_decision")
    assert policy_trace.payload["decision"] == "denied"
    assert policy_trace.payload["policy"] == "sandbox_shell_policy"
    assert policy_trace.payload["reason_code"] == "shell_disabled"
    assert "execpolicy_decision" not in policy_trace.payload
    assert "python3 -c" not in str(policy_trace.payload)
    assert "secret-output" not in str(policy_trace.payload)


def test_tool_execution_service_sandbox_network_disabled_blocks_network_tool(
    tmp_path: Path,
) -> None:
    network_tool = FakeNetworkTool()
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
    )
    _set_default_sandbox(gate, workspace_root=tmp_path, network="disabled")
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        policy_gate=gate,
        registry=ToolRegistry.from_tools([network_tool]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("WebFetch"),
                source=ToolRouteSource.REGISTRY,
                spec=network_tool.spec,
            ),
        )
    )

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="WebFetch",
            arguments={"url": "https://example.com/sk-secret"},
            reason="fetch",
            call_id="call_network_disabled",
        ),
        tool_router=router,
        tool_exposure=exposure,
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert network_tool.seen_arguments == []
    trace = TraceService(home_dir=tmp_path / "home").load("demo")
    policy_trace = next(event for event in trace if event.kind == "runtime_policy_decision")
    assert policy_trace.payload["decision"] == "denied"
    assert policy_trace.payload["policy"] == "sandbox_network_policy"
    assert policy_trace.payload["reason_code"] == "network_disabled"
    assert policy_trace.payload["effect"] == {
        "filesystem": "none",
        "network": True,
        "process": False,
    }
    assert "example.com" not in str(policy_trace.payload)
    assert "sk-secret" not in str(policy_trace.payload)


def test_tool_execution_service_runtime_policy_needs_approval_blocks_execution(
    tmp_path: Path,
) -> None:
    service, fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        policy_gate=RuntimePolicyGate(
            approval_service=ApprovalService(
                SafetyPolicy(workspace_root=tmp_path, auto_approve_medium=False),
            )
        ),
        registry=ToolRegistry.from_tools([WriteTool(tmp_path)]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    exposure = ToolExposure(
        entries=(
            *_tool_exposure().entries,
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Write"),
                source=ToolRouteSource.REGISTRY,
                spec=WriteTool(tmp_path).spec,
            ),
        )
    )

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "hello\n"},
            reason="write",
            call_id="call_write_1",
        ),
        tool_router=router,
        tool_exposure=exposure,
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert not (tmp_path / "notes.txt").exists()
    assert fake_tool.seen_arguments == []
    trace = TraceService(home_dir=tmp_path / "home").load("demo")
    policy_trace = next(event for event in trace if event.kind == "runtime_policy_decision")
    assert policy_trace.payload["decision"] == "needs_approval"
    assert policy_trace.payload["approval_required"] is True


def test_tool_execution_service_execpolicy_deny_blocks_shell_without_raw_command(
    tmp_path: Path,
) -> None:
    service, fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        policy_gate=RuntimePolicyGate(
            approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
            execpolicy_rules=ExecPolicyRuleSet(
                rules=(
                    ExecPolicyRule(
                        source=ExecPolicySource.PROJECT,
                        index=0,
                        pattern=("git", "push"),
                        decision=ExecPolicyDecision.DENY,
                    ),
                )
            ),
        ),
    )
    router = service._test_router  # type: ignore[attr-defined]

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Bash",
            arguments={"command": "git push origin main sk-do-not-print"},
            reason="push",
            call_id="call_shell_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert fake_tool.seen_arguments == []
    trace = TraceService(home_dir=tmp_path / "home").load("demo")
    policy_trace = next(event for event in trace if event.kind == "runtime_policy_decision")
    assert policy_trace.payload["decision"] == "denied"
    assert policy_trace.payload["policy"] == "execpolicy_prefix_rule"
    assert policy_trace.payload["execpolicy_decision"] == "deny"
    assert policy_trace.payload["execpolicy_rule_source"] == "project"
    assert "git push" not in str(policy_trace.payload)
    assert "sk-do-not-print" not in str(policy_trace.payload)


def test_tool_execution_service_execpolicy_ask_blocks_shell_for_approval(
    tmp_path: Path,
) -> None:
    service, fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        policy_gate=RuntimePolicyGate(
            approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
            execpolicy_rules=ExecPolicyRuleSet(
                rules=(
                    ExecPolicyRule(
                        source=ExecPolicySource.PROJECT,
                        index=0,
                        pattern=("git", "push"),
                        decision=ExecPolicyDecision.ASK,
                    ),
                )
            ),
        ),
    )
    router = service._test_router  # type: ignore[attr-defined]

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="run_shell",
            arguments={"args": ["git", "push", "origin", "main"]},
            reason="push",
            call_id="call_shell_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert fake_tool.seen_arguments == []
    trace = TraceService(home_dir=tmp_path / "home").load("demo")
    policy_trace = next(event for event in trace if event.kind == "runtime_policy_decision")
    assert policy_trace.payload["decision"] == "needs_approval"
    assert policy_trace.payload["approval_required"] is True
    assert policy_trace.payload["execpolicy_decision"] == "ask"


def test_tool_execution_service_execpolicy_allow_runs_shell_with_bounded_trace(
    tmp_path: Path,
) -> None:
    service, fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        policy_gate=RuntimePolicyGate(
            approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
            execpolicy_rules=ExecPolicyRuleSet(
                rules=(
                    ExecPolicyRule(
                        source=ExecPolicySource.PROJECT,
                        index=0,
                        pattern=("python3", "-c"),
                        decision=ExecPolicyDecision.ALLOW,
                    ),
                )
            ),
        ),
        registry=ToolRegistry.from_tools([BashTool(tmp_path)]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Bash"),
                source=ToolRouteSource.REGISTRY,
                spec=BashTool(tmp_path).spec,
            ),
        )
    )
    conversation = Conversation(session_id="demo")

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="Bash",
            arguments={"command": "python3 -c 'print(\"ok\")'"},
            reason="probe",
            call_id="call_shell_1",
        ),
        tool_router=router,
        tool_exposure=exposure,
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert fake_tool.seen_arguments == []
    assert conversation.messages[-1].role == "tool"
    assert "ok" in conversation.messages[-1].content
    trace = TraceService(home_dir=tmp_path / "home").load("demo")
    policy_trace = next(event for event in trace if event.kind == "runtime_policy_decision")
    assert policy_trace.payload["decision"] == "allowed"
    assert policy_trace.payload["policy"] == "execpolicy_prefix_rule"
    assert policy_trace.payload["execpolicy_decision"] == "allow"
    assert policy_trace.payload["execpolicy_rule_argument_count"] == 3
    assert "print" not in str(policy_trace.payload)


def test_tool_execution_service_shell_lifecycle_trace_has_bounded_process_metadata(
    tmp_path: Path,
) -> None:
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        policy_gate=RuntimePolicyGate(
            approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
            workspace_root=tmp_path,
            execpolicy_rules=ExecPolicyRuleSet(
                rules=(
                    ExecPolicyRule(
                        source=ExecPolicySource.PROJECT,
                        index=0,
                        pattern=("python3", "-c"),
                        decision=ExecPolicyDecision.ALLOW,
                    ),
                )
            ),
        ),
        registry=ToolRegistry.from_tools([BashTool(tmp_path)]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Bash"),
                source=ToolRouteSource.REGISTRY,
                spec=BashTool(tmp_path).spec,
            ),
        )
    )
    command = "python3 -c 'import time; time.sleep(30)'"

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Bash",
            arguments={
                "command": command,
                "run_in_background": True,
            },
            reason="probe background",
            call_id="call_shell_background",
        ),
        tool_router=router,
        tool_exposure=exposure,
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    lifecycle = [
        event.payload
        for event in TraceService(home_dir=tmp_path / "home").load("demo")
        if event.kind == "tool_runtime_lifecycle"
    ]
    terminal = lifecycle[-1]
    assert terminal["phase"] == "completed"
    assert terminal["process_state"] == "running_background"
    assert isinstance(terminal["shell_id"], str)
    assert terminal["command_length"] == len(command)
    assert "command_hash" in terminal
    assert command not in str(terminal)
    from mycli.tools.kill_shell import kill_shell

    kill_shell(str(terminal["shell_id"]))


def test_tool_execution_service_injects_bounded_shell_runtime_enforcement(
    tmp_path: Path,
) -> None:
    service, fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        policy_gate=RuntimePolicyGate(
            approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
            workspace_root=tmp_path,
        ),
        registry=ToolRegistry.from_tools([BashTool(tmp_path)]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Bash"),
                source=ToolRouteSource.REGISTRY,
                spec=BashTool(tmp_path).spec,
            ),
        )
    )
    turn_items = []

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Bash",
            arguments={"command": "python3 -c 'print(\"ok\")'", "timeout": 999},
            reason="probe",
            call_id="call_shell_enforced",
        ),
        tool_router=router,
        tool_exposure=exposure,
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
    )

    assert fake_tool.seen_arguments == []
    result_item = next(item for item in turn_items if item.type is TurnItemType.TOOL_RESULT)
    runtime_enforcement = result_item.metadata["raw_payload"]["runtime_enforcement"]
    assert runtime_enforcement["filesystem"] == "workspace_write"
    assert runtime_enforcement["shell"] == "restricted"
    assert runtime_enforcement["env_policy"] == "sanitized"
    assert runtime_enforcement["shell_environment_policy"]["inherit"] == "core"
    assert runtime_enforcement["timeout_seconds"] <= 120
    assert runtime_enforcement["timeout_capped"] is True
    assert "command" not in runtime_enforcement
    assert "secret" not in str(runtime_enforcement).lower()

    trace = TraceService(home_dir=tmp_path / "home").load("demo")
    tool_trace = next(event for event in trace if event.kind == "tool_execution")
    assert tool_trace.payload["runtime_enforcement"] == runtime_enforcement
    assert "_runtime_shell_options" not in tool_trace.payload["argument_keys"]
    assert "_runtime_shell_options" not in str(tool_trace.payload.get("arguments"))
    assert tool_trace.payload["arguments"] == {
        "redacted": True,
        "argument_count": 2,
    }
    assert tool_trace.payload["argument_preview"] == "argument_count=2 redacted=True"
    assert tool_trace.payload["stdout_preview"] is None
    assert tool_trace.payload["stderr_preview"] is None
    assert tool_trace.payload["stdout_chars"] == 2
    assert tool_trace.payload["stderr_chars"] == 0
    assert "command" not in tool_trace.payload["raw_payload_keys"]
    assert "output" not in tool_trace.payload["raw_payload_keys"]
    assert "stdout" not in tool_trace.payload["raw_payload_keys"]
    assert "stderr" not in tool_trace.payload["raw_payload_keys"]
    assert "python3 -c" not in str(tool_trace.payload)
    assert "print" not in str(tool_trace.payload)


def test_tool_execution_service_injects_shell_interrupt_token_without_tracing_it(
    tmp_path: Path,
) -> None:
    token = RuntimeInterruptToken(source="test")
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([BashTool(tmp_path)]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Bash"),
                source=ToolRouteSource.REGISTRY,
                spec=BashTool(tmp_path).spec,
            ),
        )
    )
    turn_items = []

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Bash",
            arguments={"command": "python3 -c 'print(\"ok\")'"},
            reason="probe",
            call_id="call_shell_interrupt",
        ),
        tool_router=router,
        tool_exposure=exposure,
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
        interrupt_token=token,
    )

    loaded = TraceService(home_dir=tmp_path / "home").load("demo")
    tool_trace = next(event for event in loaded if event.kind == "tool_execution")
    lifecycle = [
        event for event in loaded if event.kind == "tool_runtime_lifecycle"
    ]
    assert "_runtime_interrupt_token" not in tool_trace.payload["argument_keys"]
    assert "_runtime_interrupt_token" not in str(tool_trace.payload)
    assert all(
        "_runtime_interrupt_token" not in event.payload["argument_keys"]
        for event in lifecycle
    )
    assert all("_runtime_interrupt_token" not in str(event.payload) for event in lifecycle)


def test_tool_execution_service_runtime_policy_allows_contributed_tool(
    tmp_path: Path,
) -> None:
    contributed_tool = FakeContributedTool()
    registration = ToolContributionRegistration(
        descriptor=ToolContributionDescriptor(
            tool_id="runtime:runtime_echo:turn",
            display_name="runtime_echo",
            description="Echo through runtime contribution",
            route_key=ToolRouteKey.local("runtime_echo"),
            source=ToolContributionSource.RUNTIME,
            scope=ToolContributionScope.TURN,
            lifecycle_state=ToolContributionLifecycleState.EXPOSED,
            spec=contributed_tool.spec,
        ),
        tool=contributed_tool,
    )
    trace_service = TraceService(home_dir=tmp_path / "home")
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        trace_service=trace_service,
        policy_gate=RuntimePolicyGate(
            approval_service=ApprovalService(
                SafetyPolicy(workspace_root=tmp_path, auto_approve_medium=False),
            )
        ),
    )
    router = ToolRouter(
        tool_registry=ToolRegistry.from_tools([]),
        contributed_tools={"runtime_echo": registration},
        contributed_tool_registry=ToolContributionRegistry(),
    )
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("runtime_echo"),
                source=ToolRouteSource.RUNTIME,
                spec=contributed_tool.spec,
            ),
        )
    )

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="runtime_echo",
            arguments={"message": "hello"},
            reason="echo",
            call_id="call_echo_1",
        ),
        tool_router=router,
        tool_exposure=exposure,
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert contributed_tool.seen_arguments == [{"message": "hello"}]
    policy_trace = next(
        event
        for event in trace_service.load("demo")
        if event.kind == "runtime_policy_decision"
    )
    assert policy_trace.payload["decision"] == "allowed"
    assert policy_trace.payload["policy"] == "contributed_tool_exposure"
    assert policy_trace.payload["tool_name"] == "runtime_echo"


def test_tool_execution_service_emits_runtime_lifecycle_trace_for_success(
    tmp_path: Path,
) -> None:
    service, _fake_tool = _service(tmp_path, hook_manager=HookManager())
    router = service._test_router  # type: ignore[attr-defined]
    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    lifecycle = [
        event.payload
        for event in TraceService(home_dir=tmp_path / "home").load("demo")
        if event.kind == "tool_runtime_lifecycle"
    ]

    assert [payload["phase"] for payload in lifecycle] == [
        "planned",
        "started",
        "progress",
        "completed",
    ]
    assert lifecycle[0]["status"] == "running"
    assert lifecycle[-1]["status"] == "completed"
    assert all(payload["tool_call_id"] == "call_read_1" for payload in lifecycle)
    assert lifecycle[0]["argument_keys"] == ["path"]
    assert "arguments" not in lifecycle[0]


def test_tool_execution_service_emits_runtime_lifecycle_trace_for_policy_stop(
    tmp_path: Path,
) -> None:
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        policy_gate=RuntimePolicyGate(
            approval_service=ApprovalService(
                SafetyPolicy(workspace_root=tmp_path, auto_approve_medium=False),
            )
        ),
        registry=ToolRegistry.from_tools([WriteTool(tmp_path)]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Write"),
                source=ToolRouteSource.REGISTRY,
                spec=WriteTool(tmp_path).spec,
            ),
        )
    )

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "hello\n"},
            reason="write",
            call_id="call_write_1",
        ),
        tool_router=router,
        tool_exposure=exposure,
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    lifecycle = [
        event.payload
        for event in TraceService(home_dir=tmp_path / "home").load("demo")
        if event.kind == "tool_runtime_lifecycle"
    ]

    assert [payload["phase"] for payload in lifecycle] == [
        "planned",
        "policy_checked",
        "started",
        "needs_approval",
    ]
    assert lifecycle[1]["policy_decision"] == "needs_approval"
    assert lifecycle[-1]["status"] == "needs_approval"


def test_tool_execution_service_denies_tool_before_execution(tmp_path: Path) -> None:
    hook_manager = HookManager()
    hook_manager.register(
        HookPoint.PRE_TOOL_USE,
        lambda ctx: HookResult(action=HookAction.DENY, message="blocked"),
    )
    service, fake_tool = _service(tmp_path, hook_manager=hook_manager)
    router = service._test_router  # type: ignore[attr-defined]
    conversation = Conversation(session_id="demo")

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert fake_tool.seen_arguments == []
    assert conversation.messages[-1].content.startswith("<tool_output><![CDATA[")
    assert "Tool denied:" in conversation.messages[-1].content


def test_tool_execution_service_emits_lifecycle_and_trace_for_denied_tool(
    tmp_path: Path,
) -> None:
    hook_manager = HookManager()
    hook_manager.register(
        HookPoint.PRE_TOOL_USE,
        lambda ctx: HookResult(action=HookAction.DENY, message="blocked by safety"),
    )
    service, fake_tool = _service(tmp_path, hook_manager=hook_manager)
    router = service._test_router  # type: ignore[attr-defined]
    service._monotonic = iter((10.0, 10.25)).__next__  # type: ignore[attr-defined]
    events: list[RuntimeStreamEvent] = []
    turn_items = []

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
        lifecycle_sink=events.append,
    )

    assert fake_tool.seen_arguments == []
    assert [event.kind for event in events] == ["tool_start", "tool_progress", "tool_failed"]
    assert events[0].metadata == {
        "tool_id": "call_read_1",
        "call_id": "call_read_1",
        "name": "read_file",
        "context": "read_file",
        "args_preview": "path=README.md",
    }
    failed = events[-1]
    assert failed.tool_name == "read_file"
    assert failed.metadata["tool_id"] == "call_read_1"
    assert failed.metadata["call_id"] == "call_read_1"
    assert failed.metadata["success"] is False
    assert failed.metadata["summary"] == "Tool denied: blocked by safety"
    assert failed.metadata["error"] == "blocked by safety"
    assert [item.type for item in turn_items] == [
        TurnItemType.TOOL_CALL,
        TurnItemType.TOOL_RESULT,
    ]

    trace = TraceService(home_dir=tmp_path / "home").load("demo")
    tool_trace = next(event for event in trace if event.kind == "tool_execution")
    assert tool_trace.payload["tool_name"] == "read_file"
    assert tool_trace.payload["tool_call_id"] == "call_read_1"
    assert tool_trace.payload["status"] == "failed"
    assert tool_trace.payload["success"] is False
    assert tool_trace.payload["error_kind"] == "tool_denied_by_hook"
    assert tool_trace.payload["hook_summaries"] == [
        {
            "hook_point": "pre_tool_use",
            "hook_name": "<lambda>",
            "status": "ok",
            "action": "deny",
            "message": "blocked by safety",
        }
    ]
    lifecycle = [
        event.payload
        for event in trace
        if event.kind == "tool_runtime_lifecycle"
    ]
    assert [payload["phase"] for payload in lifecycle] == [
        "planned",
        "started",
        "denied",
    ]
    assert lifecycle[-1]["status"] == "denied"
    assert lifecycle[-1]["error_kind"] == "tool_denied_by_hook"
    assert all("arguments" not in payload for payload in lifecycle)


def test_tool_execution_service_runs_configured_pre_tool_hook(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.joinpath(".mycli").mkdir(parents=True)
    home.mkdir()
    hook_script = tmp_path / "deny_read.py"
    hook_script.write_text(
        "import json\nprint(json.dumps({'action':'deny','message':'configured block'}))\n",
        encoding="utf-8",
    )
    (workspace / ".mycli" / "hooks.json").write_text(
        json.dumps(
            {
                "hooks": [
                    {
                        "id": "deny-read",
                        "hook_point": "pre_tool_use",
                        "command": ["python3", str(hook_script)],
                        "matcher": {"tool_name": "read_file"},
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    hook_manager = HookManager()
    trace_service = TraceService(home_dir=home)
    discovery = register_configured_hooks(
        manager=hook_manager,
        workspace_root=workspace,
        home_dir=home,
        trace_service=trace_service,
        session_id="demo",
    )
    HookAllowlist(home_dir=home).write_allowed(discovery.hooks)
    hook_manager = HookManager()
    discovery = register_configured_hooks(
        manager=hook_manager,
        workspace_root=workspace,
        home_dir=home,
        trace_service=trace_service,
        session_id="demo",
    )
    service, fake_tool = _service(tmp_path, hook_manager=hook_manager)
    router = service._test_router  # type: ignore[attr-defined]

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert discovery.issues == ()
    assert fake_tool.seen_arguments == []
    loaded = trace_service.load("demo")
    hook_trace = next(event for event in loaded if event.kind == "hook_execution")
    tool_trace = next(event for event in loaded if event.kind == "tool_execution")
    assert hook_trace.turn_id == "turn_1"
    assert hook_trace.payload["hook_id"] == "deny-read"
    assert hook_trace.payload["action"] == "deny"
    assert tool_trace.payload["error_kind"] == "tool_denied_by_hook"
    assert tool_trace.payload["hook_summaries"] == [
        {
            "hook_point": "pre_tool_use",
            "hook_name": "configured:repo:deny-read",
            "status": "ok",
            "action": "deny",
            "message": "configured block",
        }
    ]


def test_tool_execution_service_applies_post_tool_modify_and_deny(
    tmp_path: Path,
) -> None:
    hook_manager = HookManager()

    def post_hook(ctx: HookContext) -> HookResult:
        assert ctx.metadata["success"] is True
        return HookResult(
            action=HookAction.MODIFY,
            modified_args={
                "summary": "post hook summary",
                "raw_payload": {"post_hook": "seen"},
            },
        )

    hook_manager.register(HookPoint.POST_TOOL_USE, post_hook, name="post_modifier")
    trace_service = TraceService(home_dir=tmp_path / "home")
    service, fake_tool = _service(
        tmp_path,
        hook_manager=hook_manager,
        trace_service=trace_service,
    )
    router = service._test_router  # type: ignore[attr-defined]
    conversation = Conversation(session_id="demo")
    turn_items = []

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
    )

    assert fake_tool.seen_arguments == [{"path": "README.md"}]
    tool_result = next(item for item in turn_items if item.type is TurnItemType.TOOL_RESULT)
    assert tool_result.metadata["summary"] == "post hook summary"
    assert tool_result.metadata["raw_payload"]["post_hook"] == "seen"
    assert "post hook summary" in conversation.messages[-1].content
    trace = next(event for event in trace_service.load("demo") if event.kind == "tool_execution")
    assert trace.payload["hook_summaries"] == [
        {
            "hook_point": "post_tool_use",
            "hook_name": "post_modifier",
            "status": "ok",
            "action": "modify",
        }
    ]

    deny_manager = HookManager()
    deny_manager.register(
        HookPoint.POST_TOOL_USE,
        lambda ctx: HookResult(action=HookAction.DENY, message="bad result"),
        name="post_deny",
    )
    deny_trace = TraceService(home_dir=tmp_path / "deny_home")
    deny_service, _ = _service(
        tmp_path,
        hook_manager=deny_manager,
        trace_service=deny_trace,
    )
    deny_router = deny_service._test_router  # type: ignore[attr-defined]
    deny_turn_items = []
    deny_conversation = Conversation(session_id="demo")

    deny_service.execute_tool_call(
        conversation=deny_conversation,
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_2",
        ),
        tool_router=deny_router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_2",
        activity_events=[],
        turn_items=deny_turn_items,
    )

    denied_result = next(item for item in deny_turn_items if item.type is TurnItemType.TOOL_RESULT)
    assert denied_result.metadata["success"] is False
    assert denied_result.metadata["error_kind"] == "tool_denied_by_post_hook"
    assert "Tool result denied by hook" in deny_conversation.messages[-1].content


def test_tool_execution_service_records_post_tool_additional_context_metadata(
    tmp_path: Path,
) -> None:
    hook_manager = HookManager()
    hook_manager.register(
        HookPoint.POST_TOOL_USE,
        lambda ctx: HookResult(
            action=HookAction.ALLOW,
            additional_contexts=("Use this result; do not repeat the same call.",),
        ),
        name="post_context",
    )
    service, _ = _service(tmp_path, hook_manager=hook_manager)
    router = service._test_router  # type: ignore[attr-defined]
    conversation = Conversation(session_id="demo")

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    tool_message = conversation.messages[-1]
    assert tool_message.metadata["post_tool_additional_contexts"] == (
        "Use this result; do not repeat the same call.",
    )
    assert tool_message.blocks[0].metadata["post_tool_additional_contexts"] == (
        "Use this result; do not repeat the same call.",
    )
    assert "<tool_runtime_reminder>" not in tool_message.content


def test_tool_execution_service_skips_non_allowlisted_configured_hook(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.joinpath(".mycli").mkdir(parents=True)
    home.mkdir()
    marker = tmp_path / "executed.txt"
    hook_script = tmp_path / "deny_read.py"
    hook_script.write_text(
        "\n".join(
            [
                "import json",
                f"from pathlib import Path; Path({str(marker)!r}).write_text('ran')",
                "print(json.dumps({'action':'deny','message':'configured block'}))",
            ]
        ),
        encoding="utf-8",
    )
    (workspace / ".mycli" / "hooks.json").write_text(
        json.dumps(
            {
                "hooks": [
                    {
                        "id": "deny-read",
                        "hook_point": "pre_tool_use",
                        "command": ["python3", str(hook_script)],
                        "matcher": {"tool_name": "read_file"},
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    hook_manager = HookManager()
    trace_service = TraceService(home_dir=home)
    discovery = register_configured_hooks(
        manager=hook_manager,
        workspace_root=workspace,
        home_dir=home,
        trace_service=trace_service,
        session_id="demo",
    )
    service, fake_tool = _service(tmp_path, hook_manager=hook_manager, trace_service=trace_service)
    router = service._test_router  # type: ignore[attr-defined]

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert discovery.issues == ()
    assert fake_tool.seen_arguments == [{"path": "README.md"}]
    assert not marker.exists()
    loaded = trace_service.load("demo")
    hook_trace = next(event for event in loaded if event.kind == "hook_execution")
    tool_trace = next(event for event in loaded if event.kind == "tool_execution")
    assert hook_trace.payload["hook_id"] == "deny-read"
    assert hook_trace.payload["status"] == "error"
    assert hook_trace.payload["action"] == "error"
    assert hook_trace.payload["message"] == "not allowlisted: allowlist_missing"
    assert tool_trace.payload["status"] == "succeeded"
    assert tool_trace.payload["hook_summaries"] == [
        {
            "hook_point": "pre_tool_use",
            "hook_name": "configured:repo:deny-read",
            "status": "error",
            "action": "error",
            "message": "configured hook not allowlisted",
        }
    ]


def test_tool_execution_service_persists_successful_skill_instructions(
    tmp_path: Path,
) -> None:
    hook_manager = HookManager()
    skill_tool = FakeSkillTool()
    registry = ToolRegistry.from_tools([skill_tool])
    service, _ = _service(tmp_path, hook_manager=hook_manager, registry=registry)
    router = service._test_router  # type: ignore[attr-defined]
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Skill"),
                source=ToolRouteSource.REGISTRY,
                spec=skill_tool.spec,
            ),
        )
    )
    conversation = Conversation(session_id="demo")
    turn_items = []

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="Skill",
            arguments={"skill_name": "code-review"},
            reason="Need code review instructions",
            call_id="call_skill",
        ),
        tool_router=router,
        tool_exposure=exposure,
        plan_state=PlanState(),
        turn_id="turn-1",
        activity_events=[],
        turn_items=turn_items,
    )

    tool_result = next(item for item in turn_items if item.type is TurnItemType.TOOL_RESULT)
    skill_instruction = conversation.messages[-1]
    assert tool_result.tool_name == "Skill"
    assert tool_result.call_id == "call_skill"
    assert tool_result.metadata["transcript_content"] == "Find correctness bugs first."
    assert [item.type for item in turn_items].count(TurnItemType.TOOL_RESULT) == 1
    skill_instruction_item = next(
        item for item in turn_items if item.type is TurnItemType.SKILL_INSTRUCTIONS
    )
    assert skill_instruction_item.metadata["kind"] == "skill_instructions"
    assert skill_instruction_item.tool_name == "Skill"
    assert skill_instruction.role == "user"
    assert skill_instruction.metadata == {
        "kind": "skill_instructions",
        "skill_name": "code-review",
        "source_path": "/tmp/code-review.md",
        "cache_class": "dynamic",
        "durability": "persistent",
        "scope": "transcript",
        "model_visible": True,
        "replayable": True,
    }
    assert "<skill_instructions>" in skill_instruction.content
    assert "<name>code-review</name>" in skill_instruction.content
    assert "<description>Review code</description>" in skill_instruction.content
    assert "<path>/tmp/code-review.md</path>" in skill_instruction.content
    assert "Find correctness bugs first." in skill_instruction.content
    assert "not the current user request" in skill_instruction.content


def test_tool_execution_service_records_successful_skill_invocation(tmp_path: Path) -> None:
    recorded: list[InvokedSkillSnapshot] = []
    hook_manager = HookManager()
    skill_tool = FakeSkillTool()
    registry = ToolRegistry.from_tools([skill_tool])
    service, _ = _service(
        tmp_path,
        hook_manager=hook_manager,
        registry=registry,
        record_invoked_skill=lambda snapshot: recorded.append(snapshot),
    )
    router = service._test_router  # type: ignore[attr-defined]
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Skill"),
                source=ToolRouteSource.REGISTRY,
                spec=skill_tool.spec,
            ),
        )
    )
    conversation = Conversation(session_id="demo")

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="Skill",
            arguments={"skill_name": "code-review"},
            reason="Need code review instructions",
            call_id="call_skill",
        ),
        tool_router=router,
        tool_exposure=exposure,
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert len(recorded) == 1
    assert recorded[0].name == "code-review"
    assert recorded[0].description == "Review code"
    assert recorded[0].source_path is not None
    assert recorded[0].cached_body_excerpt == "Find correctness bugs first."
    assert recorded[0].last_turn_id == "turn_1"

    traces = TraceService(home_dir=tmp_path / "home").load("demo")
    activation = next(event for event in traces if event.kind == "skill_activation")
    assert activation.turn_id == "turn_1"
    assert activation.payload["skill_name"] == "code-review"
    assert activation.payload["tool_call_id"] == "call_skill"
    assert activation.payload["content_chars"] == len("Find correctness bugs first.")
    assert activation.payload["body_digest"] == recorded[0].body_digest
    assert activation.payload["replayable"] is True
    assert "content" not in activation.payload
    assert "Find correctness bugs first" not in json.dumps(activation.payload)


def test_tool_execution_service_applies_modified_args(tmp_path: Path) -> None:
    hook_manager = HookManager()
    hook_manager.register(
        HookPoint.PRE_TOOL_USE,
        lambda ctx: HookResult(
            action=HookAction.MODIFY,
            modified_args={"path": "pyproject.toml"},
        ),
    )
    service, fake_tool = _service(tmp_path, hook_manager=hook_manager)
    router = service._test_router  # type: ignore[attr-defined]
    conversation = Conversation(session_id="demo")

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert fake_tool.seen_arguments == [{"path": "pyproject.toml"}]
    assert conversation.messages[-1].content.startswith("<tool_output><![CDATA[")
    assert "pyproject.toml" in conversation.messages[-1].content
    assert conversation.messages[-1].content.endswith("]]></tool_output>")


def test_tool_execution_service_guards_tool_transcript_before_context(tmp_path: Path) -> None:
    hook_manager = HookManager()
    service, _fake_tool = _service(tmp_path, hook_manager=hook_manager)
    router = service._test_router  # type: ignore[attr-defined]
    conversation = Conversation(session_id="demo")
    turn_items = []

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
    )

    content = conversation.messages[-1].content
    assert content.startswith("<tool_output><![CDATA[")
    assert content.endswith("]]></tool_output>")
    assert turn_items[-1].metadata["transcript_content"] == content


def test_tool_execution_service_emits_post_tool_hook(tmp_path: Path) -> None:
    seen: list[HookContext] = []
    hook_manager = HookManager()
    hook_manager.register(
        HookPoint.POST_TOOL_USE,
        lambda ctx: seen.append(ctx) or HookResult(action=HookAction.ALLOW),
    )
    service, _fake_tool = _service(tmp_path, hook_manager=hook_manager)
    router = service._test_router  # type: ignore[attr-defined]
    conversation = Conversation(session_id="demo")

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert len(seen) == 1
    assert seen[0].hook_point is HookPoint.POST_TOOL_USE
    assert seen[0].tool_name == "read_file"
    assert seen[0].metadata["success"] is True


def test_tool_execution_service_records_standard_tool_trace_payload(tmp_path: Path) -> None:
    hook_manager = HookManager()
    service, _fake_tool = _service(tmp_path, hook_manager=hook_manager)
    router = service._test_router  # type: ignore[attr-defined]
    service._monotonic = iter((10.0, 10.125)).__next__  # type: ignore[attr-defined]

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    loaded = TraceService(home_dir=tmp_path / "home").load("demo")
    trace = next(event for event in loaded if event.kind == "tool_execution")
    assert trace.payload["tool_name"] == "read_file"
    assert trace.payload["tool_call_id"] == "call_read_1"
    assert trace.payload["status"] == "succeeded"
    assert trace.payload["success"] is True
    assert trace.payload["duration_ms"] == 125
    assert trace.payload["path"] == "README.md"
    assert trace.payload["error_kind"] is None
    assert trace.payload["argument_count"] == 1
    assert trace.payload["argument_keys"] == ["path"]
    assert trace.payload["tool_id"] == "call_read_1"
    assert trace.payload["argument_preview"] == "path=README.md"
    assert trace.payload["result_summary"] == "Read README.md"
    assert trace.payload["error_summary"] is None
    assert trace.payload["raw_payload_keys"] == ["content", "path"]
    assert trace.payload["hook_summaries"] == []


def test_tool_execution_service_records_hook_error_trace_summary(tmp_path: Path) -> None:
    hook_manager = HookManager()

    def crashy(ctx: HookContext) -> HookResult:
        raise RuntimeError("api_key=sk-secret")

    hook_manager.register(HookPoint.PRE_TOOL_USE, crashy)
    service, fake_tool = _service(tmp_path, hook_manager=hook_manager)
    router = service._test_router  # type: ignore[attr-defined]

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert fake_tool.seen_arguments == [{"path": "README.md"}]
    loaded = TraceService(home_dir=tmp_path / "home").load("demo")
    trace = next(event for event in loaded if event.kind == "tool_execution")
    assert trace.payload["hook_summaries"] == [
        {
            "hook_point": "pre_tool_use",
            "hook_name": "crashy",
            "status": "error",
            "message": "RuntimeError",
        }
    ]


def test_tool_execution_service_notifies_tool_lifecycle_success(tmp_path: Path) -> None:
    hook_manager = HookManager()
    service, _fake_tool = _service(tmp_path, hook_manager=hook_manager)
    router = service._test_router  # type: ignore[attr-defined]
    service._monotonic = iter((10.0, 10.125)).__next__  # type: ignore[attr-defined]
    events: list[RuntimeStreamEvent] = []
    turn_items = []

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
        lifecycle_sink=events.append,
    )

    assert [event.kind for event in events] == ["tool_start", "tool_progress", "tool_complete"]
    assert events[0].tool_name == "read_file"
    assert events[0].metadata == {
        "tool_id": "call_read_1",
        "call_id": "call_read_1",
        "name": "read_file",
        "context": "read_file",
        "args_preview": "path=README.md",
    }
    assert events[1].tool_name == "read_file"
    assert events[1].metadata == {
        "tool_id": "call_read_1",
        "call_id": "call_read_1",
        "name": "read_file",
        "stage": "executing",
        "message": "Executing read_file",
        "args_preview": "path=README.md",
    }
    assert events[2].tool_name == "read_file"
    assert events[2].metadata == {
        "tool_id": "call_read_1",
        "call_id": "call_read_1",
        "name": "read_file",
        "duration_s": 0.125,
        "summary": "Read README.md",
        "summary_chars": len("Read README.md"),
        "summary_truncated": False,
        "success": True,
    }
    assert [item.type for item in turn_items].count(TurnItemType.TOOL_RESULT) == 1


def test_tool_execution_service_exposes_write_preview_and_diff_lifecycle_metadata(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    hook_manager = HookManager()
    write_tool = WriteTool(workspace)
    registry = ToolRegistry.from_tools([write_tool])
    service, _fake_tool = _service(tmp_path, hook_manager=hook_manager, registry=registry)
    router = service._test_router  # type: ignore[attr-defined]
    service._monotonic = iter((10.0, 10.125)).__next__  # type: ignore[attr-defined]
    events: list[RuntimeStreamEvent] = []
    turn_items = []
    content = "\n".join(f"line {index}" for index in range(1, 13))

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Write",
            arguments={"file_path": "docs/notes.md", "content": content},
            reason="create notes",
            call_id="call_write_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("Write"),
                    source=ToolRouteSource.REGISTRY,
                    spec=write_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
        lifecycle_sink=events.append,
    )

    start = events[0]
    complete = events[-1]
    assert start.kind == "tool_start"
    assert start.metadata["content_preview"] == content
    assert start.metadata["content_line_count"] == 12
    assert start.metadata["content_truncated"] is False
    assert "arguments" not in start.metadata
    assert complete.kind == "tool_complete"
    assert "@@" in str(complete.metadata["diff"])
    assert "+line 12" in str(complete.metadata["diff"])
    assert complete.metadata["diff_truncated"] is False


def test_tool_execution_service_notifies_clarify_request_after_question_tool(
    tmp_path: Path,
) -> None:
    hook_manager = HookManager()
    ask_tool = FakeAskUserQuestionTool()
    registry = ToolRegistry.from_tools([ask_tool])
    service, _fake_tool = _service(tmp_path, hook_manager=hook_manager, registry=registry)
    router = service._test_router  # type: ignore[attr-defined]
    service._monotonic = iter((10.0, 10.125)).__next__  # type: ignore[attr-defined]
    events: list[RuntimeStreamEvent] = []
    turn_items = []

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="AskUserQuestion",
            arguments={
                "question": "Which slice should come next?",
                "options": [
                    {"label": "Runtime", "description": "Only runtime contract"},
                    {"label": "TUI", "description": "Render the request"},
                ],
            },
            reason="Need user direction",
            call_id="call_question_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("AskUserQuestion"),
                    source=ToolRouteSource.REGISTRY,
                    spec=ask_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
        lifecycle_sink=events.append,
    )

    assert [event.kind for event in events] == [
        "tool_start",
        "tool_progress",
        "tool_complete",
        "clarify_request",
    ]
    clarify = events[-1]
    assert clarify.tool_name == "AskUserQuestion"
    assert clarify.metadata == {
        "request_id": "call_question_1",
        "tool_id": "call_question_1",
        "call_id": "call_question_1",
        "tool_name": "AskUserQuestion",
        "question": "Which slice should come next?",
        "options": [
            {"label": "Runtime", "description": "Only runtime contract"},
            {"label": "TUI", "description": "Render the request"},
            {"label": "Other", "description": "Custom answer"},
        ],
        "multi_select": False,
        "header": "Scope",
    }
    assert [item.type for item in turn_items].count(TurnItemType.TOOL_RESULT) == 1


def test_tool_execution_service_records_failed_tool_trace_payload(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    write_tool = WriteTool(workspace)
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([write_tool]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    service._monotonic = iter((3.0, 3.002)).__next__  # type: ignore[attr-defined]

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt"},
            reason="write",
            call_id="call_write_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("Write"),
                    source=ToolRouteSource.REGISTRY,
                    spec=write_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    loaded = TraceService(home_dir=tmp_path / "home").load("demo")
    trace = next(event for event in loaded if event.kind == "tool_execution")
    assert trace.payload["tool_name"] == "Write"
    assert trace.payload["status"] == "failed"
    assert trace.payload["success"] is False
    assert trace.payload["duration_ms"] == 2
    assert trace.payload["path"] == "notes.txt"
    assert trace.payload["error_kind"] == "tool_validation_error"
    assert trace.payload["argument_count"] == 1
    assert trace.payload["argument_keys"] == ["file_path"]
    assert trace.payload["argument_preview"] == "file_path=notes.txt"
    assert trace.payload["result_summary"] == "Tool Write could not run because its arguments were invalid."
    assert "Missing required arguments: content" in str(trace.payload["error_summary"])
    assert trace.payload["filesystem_effect"] == "write"
    assert trace.payload["network_effect"] is False
    assert trace.payload["process_effect"] is False
    assert trace.payload["stdout_chars"] == 0
    assert trace.payload["stdout_truncated"] is False
    assert trace.payload["stderr_chars"] == 0
    assert trace.payload["stderr_truncated"] is False
    lifecycle = [
        event.payload
        for event in loaded
        if event.kind == "tool_runtime_lifecycle"
    ]
    assert [payload["phase"] for payload in lifecycle] == [
        "planned",
        "started",
        "progress",
        "failed",
    ]
    assert lifecycle[-1]["status"] == "failed"
    assert lifecycle[-1]["error_kind"] == "tool_validation_error"
    assert all("arguments" not in payload for payload in lifecycle)


def test_tool_execution_service_records_long_output_trace_diagnostics(
    tmp_path: Path,
) -> None:
    long_tool = FakeLongOutputTool()
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([long_tool]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    service._monotonic = iter((1.0, 1.25)).__next__  # type: ignore[attr-defined]

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="long_output",
            arguments={},
            reason="diagnose",
            call_id="call_long_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("long_output"),
                    source=ToolRouteSource.REGISTRY,
                    spec=long_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    loaded = TraceService(home_dir=tmp_path / "home").load("demo")
    trace = next(event for event in loaded if event.kind == "tool_execution")
    assert len(str(trace.payload["stdout_preview"])) <= 120
    assert len(str(trace.payload["stderr_preview"])) <= 120
    assert trace.payload["stdout_chars"] == len(("stdout " * 80).strip())
    assert trace.payload["stdout_truncated"] is True
    assert trace.payload["stderr_chars"] == len(("stderr " * 80).strip())
    assert trace.payload["stderr_truncated"] is True


def test_tool_execution_service_records_interrupted_tool_before_reraising(
    tmp_path: Path,
) -> None:
    interrupt_tool = FakeInterruptTool()
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([interrupt_tool]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    service._monotonic = iter((7.0, 7.042)).__next__  # type: ignore[attr-defined]
    conversation = Conversation(session_id="demo")
    turn_items = []
    events: list[RuntimeStreamEvent] = []

    try:
        service.execute_tool_call(
            conversation=conversation,
            call=ToolCall(
                name="interrupt_tool",
                arguments={"path": "notes.txt"},
                reason="interrupt",
                call_id="call_interrupt_1",
            ),
            tool_router=router,
            tool_exposure=ToolExposure(
                entries=(
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("interrupt_tool"),
                        source=ToolRouteSource.REGISTRY,
                        spec=interrupt_tool.spec,
                    ),
                )
            ),
            plan_state=PlanState(),
            turn_id="turn_1",
            activity_events=[],
            turn_items=turn_items,
            lifecycle_sink=events.append,
        )
    except KeyboardInterrupt:
        pass
    else:  # pragma: no cover - explicit failure path
        raise AssertionError("KeyboardInterrupt should be re-raised")

    assert [event.kind for event in events] == ["tool_start", "tool_progress", "tool_failed"]
    failed = events[-1]
    assert failed.metadata["tool_id"] == "call_interrupt_1"
    assert failed.metadata["call_id"] == "call_interrupt_1"
    assert failed.metadata["success"] is False
    assert failed.metadata["summary"] == "Tool interrupt_tool was interrupted before it completed."
    assert failed.metadata["error"] == "Tool interrupt_tool was interrupted before it completed."
    assert [item.type for item in turn_items] == [
        TurnItemType.TOOL_CALL,
        TurnItemType.TOOL_RESULT,
    ]
    result_item = turn_items[-1]
    assert result_item.metadata["success"] is False
    assert result_item.metadata["error_kind"] == "tool_interrupted"
    assert result_item.metadata["raw_payload"]["error_kind"] == "tool_interrupted"
    assert conversation.messages[-1].tool_call_id == "call_interrupt_1"

    loaded = TraceService(home_dir=tmp_path / "home").load("demo")
    trace = next(event for event in loaded if event.kind == "tool_execution")
    assert trace.payload["tool_name"] == "interrupt_tool"
    assert trace.payload["tool_call_id"] == "call_interrupt_1"
    assert trace.payload["status"] == "failed"
    assert trace.payload["success"] is False
    assert trace.payload["duration_ms"] == 42
    assert trace.payload["error_kind"] == "tool_interrupted"
    assert trace.payload["argument_count"] == 1
    assert trace.payload["argument_keys"] == ["path"]
    lifecycle = [
        event.payload
        for event in loaded
        if event.kind == "tool_runtime_lifecycle"
    ]
    assert [payload["phase"] for payload in lifecycle] == [
        "planned",
        "started",
        "progress",
        "interrupted",
    ]
    assert lifecycle[-1]["status"] == "interrupted"
    assert lifecycle[-1]["error_kind"] == "tool_interrupted"
    assert all("arguments" not in payload for payload in lifecycle)


def test_tool_execution_service_notifies_tool_lifecycle_failure(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    write_tool = WriteTool(workspace)
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([write_tool]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    service._monotonic = iter((3.0, 3.002)).__next__  # type: ignore[attr-defined]
    events: list[RuntimeStreamEvent] = []

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt"},
            reason="write",
            call_id="call_write_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("Write"),
                    source=ToolRouteSource.REGISTRY,
                    spec=write_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
        lifecycle_sink=events.append,
    )

    assert [event.kind for event in events] == ["tool_start", "tool_progress", "tool_failed"]
    progress = events[1]
    assert progress.tool_name == "Write"
    assert progress.metadata["tool_id"] == "call_write_1"
    assert progress.metadata["stage"] == "executing"
    assert progress.metadata["message"] == "Executing Write"
    failed = events[2]
    assert failed.tool_name == "Write"
    assert failed.metadata["tool_id"] == "call_write_1"
    assert failed.metadata["call_id"] == "call_write_1"
    assert failed.metadata["name"] == "Write"
    assert failed.metadata["duration_s"] == 0.002
    assert failed.metadata["summary"] == "Tool Write could not run because its arguments were invalid."
    assert failed.metadata["summary_chars"] == len("Tool Write could not run because its arguments were invalid.")
    assert failed.metadata["summary_truncated"] is False
    assert failed.metadata["success"] is False
    assert isinstance(failed.metadata["error"], str)
    assert "Missing required arguments: content" in failed.metadata["error"]
    assert failed.metadata["error_kind"] == "tool_validation_error"
    assert isinstance(failed.metadata["error_chars"], int)
    assert failed.metadata["error_truncated"] is False


def test_tool_execution_service_parallel_batch_interrupt_does_not_wait_for_slow_tools(
    tmp_path: Path,
) -> None:
    token = RuntimeInterruptToken(source="test")
    slow_tool = FakeSlowSafeTool()
    interrupting_tool = FakeInterruptingSafeTool(token)
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([slow_tool, interrupting_tool]),
    )
    router = service._test_router  # type: ignore[attr-defined]

    started = time.monotonic()
    try:
        service.execute_tool_calls(
            conversation=Conversation(session_id="demo"),
            calls=[
                ToolCall(
                    name="Read",
                    arguments={"path": "slow.txt"},
                    reason="slow",
                    call_id="call_slow_1",
                ),
                ToolCall(
                    name="Grep",
                    arguments={"pattern": "needle"},
                    reason="interrupt",
                    call_id="call_interrupt_safe_1",
                ),
            ],
            tool_router=router,
            tool_exposure=ToolExposure(
                entries=(
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("Read"),
                        source=ToolRouteSource.REGISTRY,
                        spec=slow_tool.spec,
                    ),
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("Grep"),
                        source=ToolRouteSource.REGISTRY,
                        spec=interrupting_tool.spec,
                    ),
                )
            ),
            plan_state=PlanState(),
            turn_id="turn_1",
            activity_events=[],
            turn_items=[],
            interrupt_token=token,
        )
    except KeyboardInterrupt:
        elapsed = time.monotonic() - started
    else:  # pragma: no cover - explicit failure path
        slow_tool.release.set()
        raise AssertionError("KeyboardInterrupt should be re-raised")
    finally:
        slow_tool.release.set()

    assert interrupting_tool.started.is_set()
    assert elapsed < 1.0


def test_tool_execution_service_records_aborted_outputs_for_interrupted_parallel_batch(
    tmp_path: Path,
) -> None:
    token = RuntimeInterruptToken(source="test")
    slow_tool = FakeSlowSafeTool()
    interrupting_tool = FakeInterruptingSafeTool(token)
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([slow_tool, interrupting_tool]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    conversation = Conversation(session_id="demo")
    turn_items = []
    activity_events = []

    try:
        service.execute_tool_calls(
            conversation=conversation,
            calls=[
                ToolCall(
                    name="Read",
                    arguments={"path": "slow.txt"},
                    reason="slow",
                    call_id="call_slow_1",
                ),
                ToolCall(
                    name="Grep",
                    arguments={"pattern": "needle"},
                    reason="interrupt",
                    call_id="call_interrupt_safe_1",
                ),
            ],
            tool_router=router,
            tool_exposure=ToolExposure(
                entries=(
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("Read"),
                        source=ToolRouteSource.REGISTRY,
                        spec=slow_tool.spec,
                    ),
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("Grep"),
                        source=ToolRouteSource.REGISTRY,
                        spec=interrupting_tool.spec,
                    ),
                )
            ),
            plan_state=PlanState(),
            turn_id="turn_1",
            activity_events=activity_events,
            turn_items=turn_items,
            interrupt_token=token,
        )
    except KeyboardInterrupt:
        pass
    else:  # pragma: no cover - explicit failure path
        raise AssertionError("KeyboardInterrupt should be re-raised")
    finally:
        slow_tool.release.set()

    tool_messages = [message for message in conversation.messages if message.role == "tool"]
    assert [message.tool_call_id for message in tool_messages] == [
        "call_slow_1",
        "call_interrupt_safe_1",
    ]
    result_blocks = [
        block
        for message in tool_messages
        for block in message.blocks
        if block.type == "tool_result"
    ]
    assert [block.metadata["error_kind"] for block in result_blocks] == [
        "tool_interrupted",
        "tool_interrupted",
    ]
    result_items = [item for item in turn_items if item.type is TurnItemType.TOOL_RESULT]
    assert [item.call_id for item in result_items] == [
        "call_slow_1",
        "call_interrupt_safe_1",
    ]
    assert [item.metadata["error_kind"] for item in result_items] == [
        "tool_interrupted",
        "tool_interrupted",
    ]


def test_tool_execution_service_trace_argument_preview_redacts_shell_arguments(
    tmp_path: Path,
) -> None:
    service, _fake_tool = _service(tmp_path, hook_manager=HookManager())

    payload = service._tool_execution_trace_payload(  # type: ignore[attr-defined]
        call=ToolCall(
            name="Bash",
            arguments={"command": "deploy", "api_key": "secret-value"},
            reason="deploy",
            call_id="call_secret_1",
        ),
        result=ToolResult(success=True, summary="done", raw_payload={}),
        duration_seconds=0.1,
        effect_profile=ToolEffectProfile(process=True),
    )

    assert payload["arguments"] == {"redacted": True, "argument_count": 2}
    assert payload["argument_preview"] == "argument_count=2 redacted=True"
    assert "deploy" not in str(payload)
    assert "secret-value" not in str(payload)


def test_tool_execution_service_trace_argument_preview_redacts_non_shell_secret_values(
    tmp_path: Path,
) -> None:
    service, _fake_tool = _service(tmp_path, hook_manager=HookManager())

    payload = service._tool_execution_trace_payload(  # type: ignore[attr-defined]
        call=ToolCall(
            name="runtime_echo",
            arguments={"message": "deploy", "api_key": "secret-value"},
            reason="deploy",
            call_id="call_secret_1",
        ),
        result=ToolResult(success=True, summary="done", raw_payload={}),
        duration_seconds=0.1,
        effect_profile=ToolEffectProfile(process=True),
    )

    assert "api_key=<redacted>" in payload["argument_preview"]
    assert "message=deploy" in payload["argument_preview"]
    assert "secret-value" not in payload["argument_preview"]


def test_tool_execution_service_marks_long_lifecycle_output_as_truncated(
    tmp_path: Path,
) -> None:
    long_tool = FakeLongOutputTool()
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([long_tool]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    service._monotonic = iter((1.0, 1.25)).__next__  # type: ignore[attr-defined]
    events: list[RuntimeStreamEvent] = []

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="long_output",
            arguments={},
            reason="diagnose",
            call_id="call_long_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("long_output"),
                    source=ToolRouteSource.REGISTRY,
                    spec=long_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
        lifecycle_sink=events.append,
    )

    failed = events[-1]
    assert failed.kind == "tool_failed"
    assert len(str(failed.metadata["summary"])) <= 160
    assert len(str(failed.metadata["error"])) <= 160
    assert failed.metadata["summary_truncated"] is True
    assert failed.metadata["error_truncated"] is True
    assert failed.metadata["summary_chars"] == len(("summary " * 80).strip())
    assert failed.metadata["error_chars"] == len(("error " * 80).strip())


def test_tool_execution_service_records_bash_effect_profile_in_trace(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    bash_tool = BashTool(workspace)
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([bash_tool]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    service._monotonic = iter((5.0, 5.01)).__next__  # type: ignore[attr-defined]

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Bash",
            arguments={"command": "pwd"},
            reason="inspect",
            call_id="call_bash_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("Bash"),
                    source=ToolRouteSource.REGISTRY,
                    spec=bash_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    loaded = TraceService(home_dir=tmp_path / "home").load("demo")
    trace = next(event for event in loaded if event.kind == "tool_execution")
    assert trace.payload["tool_name"] == "Bash"
    assert trace.payload["status"] == "succeeded"
    assert trace.payload["filesystem_effect"] == "unknown"
    assert trace.payload["network_effect"] is False
    assert trace.payload["process_effect"] is True


def test_tool_execution_service_records_write_diagnostics_after_successful_write(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    write_tool = WriteTool(workspace)
    seen_paths: list[tuple[str, ...]] = []

    def run_diagnostics(paths: tuple[str, ...]) -> dict[str, object]:
        seen_paths.append(paths)
        return {
            "diagnostics": [
                {
                    "file": "notes.txt",
                    "line": 1,
                    "column": 1,
                    "message": "example diagnostic",
                    "rule": "EX001",
                }
            ],
            "count": 1,
            "truncated": False,
        }

    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([write_tool]),
        write_diagnostics_runner=run_diagnostics,
    )
    router = service._test_router  # type: ignore[attr-defined]
    turn_items = []

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "after\n"},
            reason="write",
            call_id="call_write_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("Write"),
                    source=ToolRouteSource.REGISTRY,
                    spec=write_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
    )

    assert seen_paths == [("notes.txt",)]
    result_item = next(item for item in turn_items if item.type is TurnItemType.TOOL_RESULT)
    diagnostics = result_item.metadata["write_diagnostics"]
    assert isinstance(diagnostics, dict)
    assert diagnostics["count"] == 1
    assert result_item.metadata["raw_payload"]["write_diagnostics"] == diagnostics
    loaded = TraceService(home_dir=tmp_path / "home").load("demo")
    trace = next(event for event in loaded if event.kind == "tool_execution")
    assert trace.payload["write_diagnostics_count"] == 1
    assert trace.payload["write_diagnostics_error"] is None


def test_tool_execution_service_skips_write_diagnostics_after_failed_validation(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    write_tool = WriteTool(workspace)
    seen_paths: list[tuple[str, ...]] = []
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([write_tool]),
        write_diagnostics_runner=lambda paths: seen_paths.append(paths) or {"count": 0},
    )
    router = service._test_router  # type: ignore[attr-defined]
    turn_items = []

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt"},
            reason="write",
            call_id="call_write_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("Write"),
                    source=ToolRouteSource.REGISTRY,
                    spec=write_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
    )

    assert seen_paths == []
    result_item = next(item for item in turn_items if item.type is TurnItemType.TOOL_RESULT)
    assert "write_diagnostics" not in result_item.metadata


def test_tool_execution_service_skips_write_diagnostics_for_unchanged_write(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "notes.txt").write_text("same\n", encoding="utf-8")
    write_tool = WriteTool(workspace)
    seen_paths: list[tuple[str, ...]] = []
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([write_tool]),
        write_diagnostics_runner=lambda paths: seen_paths.append(paths) or {"count": 0},
    )
    router = service._test_router  # type: ignore[attr-defined]
    turn_items = []

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "same\n"},
            reason="write",
            call_id="call_write_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("Write"),
                    source=ToolRouteSource.REGISTRY,
                    spec=write_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
    )

    assert seen_paths == []
    result_item = next(item for item in turn_items if item.type is TurnItemType.TOOL_RESULT)
    assert "write_diagnostics" not in result_item.metadata


def test_tool_execution_service_records_write_diagnostics_errors_without_failing_write(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    write_tool = WriteTool(workspace)

    def run_diagnostics(_paths: tuple[str, ...]) -> dict[str, object]:
        raise RuntimeError("diagnostic backend unavailable")

    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([write_tool]),
        write_diagnostics_runner=run_diagnostics,
    )
    router = service._test_router  # type: ignore[attr-defined]
    turn_items = []

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "after\n"},
            reason="write",
            call_id="call_write_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("Write"),
                    source=ToolRouteSource.REGISTRY,
                    spec=write_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
    )

    assert (workspace / "notes.txt").read_text(encoding="utf-8") == "after\n"
    result_item = next(item for item in turn_items if item.type is TurnItemType.TOOL_RESULT)
    assert result_item.metadata["success"] is True
    diagnostics = result_item.metadata["write_diagnostics"]
    assert isinstance(diagnostics, dict)
    assert diagnostics["count"] == 0
    assert diagnostics["error"] == "diagnostic backend unavailable"
    loaded = TraceService(home_dir=tmp_path / "home").load("demo")
    trace = next(event for event in loaded if event.kind == "tool_execution")
    assert trace.payload["write_diagnostics_count"] == 0
    assert trace.payload["write_diagnostics_error"] == "diagnostic backend unavailable"


def test_tool_execution_service_snapshots_file_before_mutating_tool(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "notes.txt").write_text("before\n", encoding="utf-8")
    edit_tool = FakeEditTool(workspace)
    registry = ToolRegistry.from_tools([edit_tool])
    file_history = FileHistoryService(home_dir=tmp_path / "home", workspace_root=workspace)
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=registry,
        file_history=file_history,
    )
    router = service._test_router  # type: ignore[attr-defined]

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="edit_file",
            arguments={"path": "notes.txt", "new_content": "after\n"},
            reason="edit",
            call_id="call_edit_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("edit_file"),
                    source=ToolRouteSource.REGISTRY,
                    spec=edit_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert (workspace / "notes.txt").read_text(encoding="utf-8") == "after\n"
    rewind = file_history.rewind_latest(session_id="demo")
    assert rewind.error is None
    assert rewind.restored_paths == ("notes.txt",)
    assert (workspace / "notes.txt").read_text(encoding="utf-8") == "before\n"


def test_tool_execution_service_snapshots_file_via_mutation_contract(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "notes.txt").write_text("before\n", encoding="utf-8")
    mutation_tool = FakeContractMutationTool(workspace)
    file_history = FileHistoryService(home_dir=tmp_path / "home", workspace_root=workspace)
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([mutation_tool]),
        file_history=file_history,
    )
    router = service._test_router  # type: ignore[attr-defined]

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="ReplaceFile",
            arguments={"target": "notes.txt", "content": "after\n"},
            reason="replace",
            call_id="call_replace_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("ReplaceFile"),
                    source=ToolRouteSource.REGISTRY,
                    spec=mutation_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert (workspace / "notes.txt").read_text(encoding="utf-8") == "after\n"
    rewind = file_history.rewind_latest(session_id="demo")
    assert rewind.error is None
    assert rewind.restored_paths == ("notes.txt",)
    assert (workspace / "notes.txt").read_text(encoding="utf-8") == "before\n"


def test_tool_execution_service_does_not_keep_snapshot_for_write_noop(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "notes.txt").write_text("same\n", encoding="utf-8")
    write_tool = WriteTool(workspace)
    file_history = FileHistoryService(home_dir=tmp_path / "home", workspace_root=workspace)
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([write_tool]),
        file_history=file_history,
    )
    router = service._test_router  # type: ignore[attr-defined]

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "same\n"},
            reason="write",
            call_id="call_write_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("Write"),
                    source=ToolRouteSource.REGISTRY,
                    spec=write_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert file_history.list_snapshots(session_id="demo") == ()


def test_tool_execution_service_does_not_snapshot_failed_validation(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "notes.txt").write_text("before\n", encoding="utf-8")
    write_tool = WriteTool(workspace)
    file_history = FileHistoryService(home_dir=tmp_path / "home", workspace_root=workspace)
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([write_tool]),
        file_history=file_history,
    )
    router = service._test_router  # type: ignore[attr-defined]

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt"},
            reason="write",
            call_id="call_write_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("Write"),
                    source=ToolRouteSource.REGISTRY,
                    spec=write_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert file_history.list_snapshots(session_id="demo") == ()


def test_tool_execution_service_discards_snapshot_for_interrupted_mutation(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "notes.txt").write_text("before\n", encoding="utf-8")
    interrupt_tool = FakeInterruptMutationTool()
    file_history = FileHistoryService(home_dir=tmp_path / "home", workspace_root=workspace)
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([interrupt_tool]),
        file_history=file_history,
    )
    router = service._test_router  # type: ignore[attr-defined]
    turn_items = []

    try:
        service.execute_tool_call(
            conversation=Conversation(session_id="demo"),
            call=ToolCall(
                name="interrupt_write",
                arguments={"path": "notes.txt"},
                reason="interrupt",
                call_id="call_interrupt_write_1",
            ),
            tool_router=router,
            tool_exposure=ToolExposure(
                entries=(
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("interrupt_write"),
                        source=ToolRouteSource.REGISTRY,
                        spec=interrupt_tool.spec,
                    ),
                )
            ),
            plan_state=PlanState(),
            turn_id="turn_1",
            activity_events=[],
            turn_items=turn_items,
        )
    except KeyboardInterrupt:
        pass
    else:  # pragma: no cover - explicit failure path
        raise AssertionError("KeyboardInterrupt should be re-raised")

    assert file_history.list_snapshots(session_id="demo") == ()
    assert (workspace / "notes.txt").read_text(encoding="utf-8") == "before\n"
    result_item = next(item for item in turn_items if item.type is TurnItemType.TOOL_RESULT)
    assert result_item.metadata["error_kind"] == "tool_interrupted"


def test_file_history_rewind_refuses_to_overwrite_later_modification(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    path = workspace / "notes.txt"
    path.write_text("before\n", encoding="utf-8")
    write_tool = WriteTool(workspace)
    file_history = FileHistoryService(home_dir=tmp_path / "home", workspace_root=workspace)
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([write_tool]),
        file_history=file_history,
    )
    router = service._test_router  # type: ignore[attr-defined]

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "after\n"},
            reason="write",
            call_id="call_write_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("Write"),
                    source=ToolRouteSource.REGISTRY,
                    spec=write_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )
    path.write_text("manual\n", encoding="utf-8")

    rewind = file_history.rewind_latest(session_id="demo")

    assert rewind.error is not None
    assert "notes.txt" in rewind.error
    assert "changed after snapshot" in rewind.error
    assert path.read_text(encoding="utf-8") == "manual\n"


def test_tool_execution_records_edit_diff_in_turn_item(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    path = workspace / "notes.txt"
    path.write_text("before\n", encoding="utf-8")

    class DiffEditTool(FakeEditTool):
        def execute(self, arguments: dict[str, object]) -> ToolResult:
            target = self._workspace_root / str(arguments["path"])
            before = target.read_text(encoding="utf-8")
            target.write_text(str(arguments["new_content"]), encoding="utf-8")
            return ToolResult(
                success=True,
                summary="Edited notes.txt",
                raw_payload={
                    "path": "notes.txt",
                    "diff": "@@ -1 +1 @@\n-before\n+after",
                    "before": before,
                },
            )

    edit_tool = DiffEditTool(workspace)
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([edit_tool]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    turn_items = []

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="edit_file",
            arguments={"path": "notes.txt", "new_content": "after\n"},
            reason="edit",
            call_id="call_edit_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("edit_file"),
                    source=ToolRouteSource.REGISTRY,
                    spec=edit_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
    )

    result_items = [item for item in turn_items if item.type is TurnItemType.TOOL_RESULT]
    assert result_items[0].metadata["diff"] == "@@ -1 +1 @@\n-before\n+after"
