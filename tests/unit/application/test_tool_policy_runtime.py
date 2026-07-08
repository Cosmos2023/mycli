from __future__ import annotations

from pathlib import Path

from mycli.application.runtime.tools.tool_policy_runtime import ToolPolicyRuntime
from mycli.application.runtime.tools.runtime_policy import RuntimePolicyGate
from mycli.domain.runtime import (
    ExecutionPolicy,
    SandboxProfile,
    ToolRuntimeDecisionKind,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.exposure import ToolExposure
from mycli.services.approval import ApprovalService, SafetyPolicy
from mycli.services.tracing import TraceService
from mycli.tools.base import ToolEffectProfile


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


def test_tool_policy_runtime_records_decision_and_builds_policy_result(tmp_path: Path) -> None:
    trace_service = TraceService(home_dir=tmp_path / "home")
    runtime = ToolPolicyRuntime(
        session_id="demo",
        policy_gate=_read_only_gate(tmp_path),
        trace_service=trace_service,
    )
    call = ToolCall(
        name="Write",
        arguments={"file_path": "notes.txt", "content": "blocked\n"},
        reason="write",
        call_id="call_write_1",
    )

    decision = runtime.decide(
        call=call,
        tool_exposure=ToolExposure(entries=()),
        turn_id="turn_1",
        policy_approved=False,
        effect_profile=ToolEffectProfile(filesystem="write"),
    )

    assert decision is not None
    assert decision.kind is ToolRuntimeDecisionKind.DENIED
    trace = trace_service.load("demo")
    policy_trace = next(event for event in trace if event.kind == "runtime_policy_decision")
    assert policy_trace.payload["decision"] == "denied"
    assert policy_trace.payload["policy"] == "sandbox_filesystem_policy"
    assert "blocked\n" not in str(policy_trace.payload)

    result = runtime.result_for_decision(decision)

    assert result.success is False
    assert result.summary == (
        "Tool denied by runtime policy: Write "
        "(policy=sandbox_filesystem_policy, reason=filesystem_write_blocked_by_read_only)."
    )
    assert result.raw_payload["error_kind"] == "tool_denied_by_policy"


def test_tool_policy_runtime_skips_decision_when_call_is_already_approved(tmp_path: Path) -> None:
    trace_service = TraceService(home_dir=tmp_path / "home")
    runtime = ToolPolicyRuntime(
        session_id="demo",
        policy_gate=_read_only_gate(tmp_path),
        trace_service=trace_service,
    )

    decision = runtime.decide(
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "approved\n"},
            reason="write",
            call_id="call_write_1",
        ),
        tool_exposure=ToolExposure(entries=()),
        turn_id="turn_1",
        policy_approved=True,
        effect_profile=ToolEffectProfile(filesystem="write"),
    )

    assert decision is None
    assert trace_service.load("demo") == ()
