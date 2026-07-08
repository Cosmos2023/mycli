from __future__ import annotations

from pathlib import Path

from mycli.application.runtime.tools.runtime_policy import RuntimePolicyGate
from mycli.application.runtime.tools.tool_orchestrator import ToolRuntimeOrchestrator
from mycli.domain.runtime import ExecutionPolicy, PlanState, SandboxProfile, ToolRuntimeDecisionKind
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.exposure import ToolExposure
from mycli.services.approval import ApprovalService, SafetyPolicy
from mycli.services.hooks import HookAction, HookManager, HookPoint, HookResult
from mycli.services.tracing import TraceService
from mycli.tools.base import ToolEffectProfile, ToolResult


def _read_only_gate(workspace_root: Path) -> RuntimePolicyGate:
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=workspace_root)),
        workspace_root=workspace_root,
    )
    gate.default_policy = lambda: ExecutionPolicy(  # type: ignore[method-assign]
        sandbox=SandboxProfile(
            workspace_roots=(workspace_root,),
            cwd=workspace_root,
            writable_roots=(workspace_root,),
            filesystem="read_only",
            network="enabled",
            shell="restricted",
        )
    )
    return gate


def test_tool_runtime_orchestrator_coordinates_policy_decision(tmp_path: Path) -> None:
    trace_service = TraceService(home_dir=tmp_path / "home")
    orchestrator = ToolRuntimeOrchestrator(
        session_id="demo",
        trace_service=trace_service,
        policy_gate=_read_only_gate(tmp_path),
        hook_manager=HookManager(),
    )

    decision = orchestrator.decide_policy(
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "blocked\n"},
            reason="write",
            call_id="call_write_1",
        ),
        tool_exposure=ToolExposure(entries=()),
        turn_id="turn_1",
        policy_approved=False,
        effect_profile=ToolEffectProfile(filesystem="write"),
    )

    assert decision is not None
    assert decision.kind is ToolRuntimeDecisionKind.DENIED
    result = orchestrator.policy_result(decision)
    assert result.raw_payload["error_kind"] == "tool_denied_by_policy"


def test_tool_runtime_orchestrator_coordinates_hooks_and_write_diagnostics() -> None:
    hook_manager = HookManager()
    hook_manager.register(
        HookPoint.PRE_TOOL_USE,
        lambda ctx: HookResult(
            action=HookAction.MODIFY,
            modified_args={"file_path": "changed.txt"},
        ),
    )
    hook_manager.register(
        HookPoint.POST_TOOL_USE,
        lambda ctx: HookResult(
            action=HookAction.MODIFY,
            modified_args={"summary": "post summary"},
            additional_contexts=("Use this result.",),
        ),
    )
    seen_paths: list[tuple[str, ...]] = []
    orchestrator = ToolRuntimeOrchestrator(
        session_id="demo",
        trace_service=TraceService(home_dir=Path("/tmp/unused")),
        policy_gate=None,
        hook_manager=hook_manager,
        write_diagnostics_runner=lambda paths: seen_paths.append(paths) or {"count": 0},
    )

    pre = orchestrator.before_tool_use(
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "after\n"},
            reason="write",
            call_id="call_write_1",
        ),
        turn_id="turn_1",
    )
    after_write = orchestrator.with_write_diagnostics_if_needed(
        call=pre.call,
        result=ToolResult(success=True, summary="Wrote", raw_payload={"path": "changed.txt"}),
        effect_profile=ToolEffectProfile(filesystem="write"),
    )
    post = orchestrator.after_tool_use(call=pre.call, turn_id="turn_1", result=after_write)

    assert pre.call.arguments["file_path"] == "changed.txt"
    assert seen_paths == [("changed.txt",)]
    assert post.result.summary == "post summary"
    assert post.additional_contexts == ("Use this result.",)


def test_tool_runtime_orchestrator_batches_adjacent_safe_tool_calls() -> None:
    orchestrator = ToolRuntimeOrchestrator(
        session_id="demo",
        trace_service=TraceService(home_dir=Path("/tmp/unused")),
        policy_gate=None,
        hook_manager=HookManager(),
    )
    calls = (
        ToolCall(name="Read", arguments={"path": "one"}, reason="inspect", call_id="call_1"),
        ToolCall(name="Grep", arguments={"path": "two"}, reason="inspect", call_id="call_2"),
        ToolCall(name="Edit", arguments={"path": "three"}, reason="mutate", call_id="call_3"),
        ToolCall(name="LS", arguments={"path": "four"}, reason="inspect", call_id="call_4"),
    )
    executed_batches: list[tuple[str, ...]] = []

    def execute_batch(batch: tuple[ToolCall, ...], plan_state: PlanState) -> tuple[PlanState, ...]:
        executed_batches.append(tuple(call.call_id or "" for call in batch))
        return tuple(plan_state for _ in batch)

    result = orchestrator.execute_tool_calls(
        calls=calls,
        plan_state=PlanState(),
        concurrency_safe_tools={"Read", "Grep", "LS"},
        execute_batch=execute_batch,
    )

    assert result == PlanState()
    assert executed_batches == [
        ("call_1", "call_2"),
        ("call_3",),
        ("call_4",),
    ]
