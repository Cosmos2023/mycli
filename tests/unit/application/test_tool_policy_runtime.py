from __future__ import annotations

from pathlib import Path

from mycli.application.runtime.tools.tool_policy_runtime import ToolPolicyRuntime
from mycli.application.runtime.tools.runtime_policy import RuntimePolicyGate
from mycli.application.runtime.approval_decisions import RuntimeApprovalDecisions
from mycli.domain.runtime import (
    ExecPolicyDecision,
    ExecPolicyRule,
    ExecPolicyRuleSet,
    ExecPolicySource,
    ExecutionPolicy,
    PermissionProfile,
    PowerShellEdition,
    SandboxMode,
    SandboxProfile,
    ShellKind,
    ShellProfile,
    ToolRuntimeDecisionKind,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.exposure import ToolExposure
from mycli.services.approval import ApprovalService, SafetyPolicy
from mycli.services.tracing import TraceService
from mycli.tools.base import ToolEffectProfile


def test_runtime_policy_gate_carries_shell_path_into_execution_options(
    tmp_path: Path,
) -> None:
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
        shell_path="/configured/bash",
    )

    options = gate.shell_execution_options()

    assert options.shell_path == "/configured/bash"
    assert options.to_trace_payload(
        timeout_seconds=1,
        timeout_capped=False,
        env_keys=(),
    )["custom_shell_path"] is True


def test_runtime_policy_gate_carries_shell_profile_without_tracing_path(
    tmp_path: Path,
) -> None:
    profile = ShellProfile(
        ShellKind.POWERSHELL,
        Path(r"C:\Program Files\PowerShell\7\pwsh.exe"),
        PowerShellEdition.CORE,
    )
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(
            SafetyPolicy(workspace_root=tmp_path, shell_profile=profile)
        ),
        workspace_root=tmp_path,
        shell_profile=profile,
    )

    options = gate.shell_execution_options()
    trace = options.to_trace_payload(
        timeout_seconds=1,
        timeout_capped=False,
        env_keys=(),
    )

    assert options.shell_profile is profile
    assert trace["shell_kind"] == "powershell"
    assert trace["shell_edition"] == "core"
    assert str(profile.executable) not in str(trace)


def test_permission_profiles_map_to_legacy_sandbox_modes() -> None:
    assert PermissionProfile.READ_ONLY.sandbox_mode is SandboxMode.READ_ONLY
    assert PermissionProfile.WORKSPACE.sandbox_mode is SandboxMode.WORKSPACE_WRITE
    assert PermissionProfile.FULL_ACCESS.sandbox_mode is SandboxMode.DANGER_FULL_ACCESS


def test_full_access_skips_routine_approval_but_keeps_explicit_denies(tmp_path: Path) -> None:
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
        permission_profile=PermissionProfile.FULL_ACCESS,
    )
    call = ToolCall(
        name="Shell",
        arguments={"command": "python deploy.py"},
        reason="deploy",
    )

    decision = gate.decide(call, effect_profile=ToolEffectProfile(process=True))

    assert decision.kind is ToolRuntimeDecisionKind.ALLOWED
    assert decision.policy == "permission_profile_full_access"

    gate.set_execpolicy_rules(
        ExecPolicyRuleSet(
            rules=(
                ExecPolicyRule(
                    source=ExecPolicySource.PROJECT,
                    index=0,
                    pattern=("python", "deploy.py"),
                    decision=ExecPolicyDecision.DENY,
                ),
            )
        )
    )

    denied = gate.decide(call, effect_profile=ToolEffectProfile(process=True))

    assert denied.kind is ToolRuntimeDecisionKind.DENIED
    assert denied.policy == "execpolicy_prefix_rule"


def test_approved_shell_options_escalate_beyond_restricted_profile(tmp_path: Path) -> None:
    gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
        permission_profile=PermissionProfile.WORKSPACE,
    )

    options = gate.shell_execution_options(policy_approved=True)

    assert options.filesystem == "unrestricted"
    assert options.network == "enabled"
    assert options.shell == "enabled"


def test_restricted_profiles_request_approval_for_escalatable_boundaries(tmp_path: Path) -> None:
    workspace_gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
        permission_profile=PermissionProfile.WORKSPACE,
    )
    network_call = ToolCall(
        name="Shell",
        arguments={"command": "curl https://example.com"},
        reason="fetch release metadata",
    )

    network = workspace_gate.decide(
        network_call,
        effect_profile=ToolEffectProfile(network=True, process=True),
    )

    assert network.kind is ToolRuntimeDecisionKind.NEEDS_APPROVAL
    assert network.reason_code == "network_disabled"
    assert network.pending_approval is not None

    read_only_gate = RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        workspace_root=tmp_path,
        permission_profile=PermissionProfile.READ_ONLY,
    )
    write = read_only_gate.decide(
        ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "approved later\n"},
            reason="write notes",
        ),
        effect_profile=ToolEffectProfile(filesystem="write"),
    )

    assert write.kind is ToolRuntimeDecisionKind.NEEDS_APPROVAL
    assert write.reason_code == "filesystem_write_blocked_by_read_only"
    assert write.pending_approval is not None


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


def _shell_gate(workspace_root: Path, *, rule: ExecPolicyRule) -> RuntimePolicyGate:
    return RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=workspace_root)),
        workspace_root=workspace_root,
        execpolicy_rules=ExecPolicyRuleSet(rules=(rule,)),
    )


def test_allow_rule_for_first_segment_does_not_allow_unknown_second_segment(
    tmp_path: Path,
) -> None:
    gate = _shell_gate(
        tmp_path,
        rule=ExecPolicyRule(
            source=ExecPolicySource.PROJECT,
            index=0,
            pattern=("cat",),
            decision=ExecPolicyDecision.ALLOW,
        ),
    )

    decision = gate.decide(
        ToolCall(
            name="Shell",
            arguments={"command": "cat README.md && python script.py"},
            reason="inspect then run",
        ),
        effect_profile=ToolEffectProfile(process=True),
    )

    assert decision.kind is ToolRuntimeDecisionKind.NEEDS_APPROVAL


def test_allow_rule_and_safe_fallback_allow_every_segment(tmp_path: Path) -> None:
    gate = _shell_gate(
        tmp_path,
        rule=ExecPolicyRule(
            source=ExecPolicySource.PROJECT,
            index=0,
            pattern=("python", "-m", "pytest"),
            decision=ExecPolicyDecision.ALLOW,
        ),
    )

    decision = gate.decide(
        ToolCall(
            name="Shell",
            arguments={"command": "python -m pytest -q && git status --short"},
            reason="test then inspect",
        ),
        effect_profile=ToolEffectProfile(process=True),
    )

    assert decision.kind is ToolRuntimeDecisionKind.ALLOWED
    assert decision.policy == "execpolicy_prefix_rule"


def test_deny_rule_for_second_segment_denies_whole_shell_call(tmp_path: Path) -> None:
    gate = _shell_gate(
        tmp_path,
        rule=ExecPolicyRule(
            source=ExecPolicySource.PROJECT,
            index=0,
            pattern=("npm", "publish"),
            decision=ExecPolicyDecision.DENY,
        ),
    )

    decision = gate.decide(
        ToolCall(
            name="Shell",
            arguments={"command": "cat README.md && npm publish"},
            reason="inspect then publish",
        ),
        effect_profile=ToolEffectProfile(process=True),
    )

    assert decision.kind is ToolRuntimeDecisionKind.DENIED
    assert decision.policy == "execpolicy_prefix_rule"


def test_ask_rule_for_second_segment_uses_execpolicy_approval(tmp_path: Path) -> None:
    gate = _shell_gate(
        tmp_path,
        rule=ExecPolicyRule(
            source=ExecPolicySource.PROJECT,
            index=0,
            pattern=("npm", "publish"),
            decision=ExecPolicyDecision.ASK,
        ),
    )

    decision = gate.decide(
        ToolCall(
            name="Shell",
            arguments={"command": "cat README.md && npm publish"},
            reason="inspect then publish",
        ),
        effect_profile=ToolEffectProfile(process=True),
    )

    assert decision.kind is ToolRuntimeDecisionKind.NEEDS_APPROVAL
    assert decision.policy == "execpolicy_prefix_rule"


def test_runtime_policy_gate_attaches_validated_execpolicy_proposal(tmp_path: Path) -> None:
    approval_service = ApprovalService(SafetyPolicy(workspace_root=tmp_path))
    gate = RuntimePolicyGate(
        approval_service=approval_service,
        workspace_root=tmp_path,
    )

    decision = gate.decide(
        ToolCall(
            name="Shell",
            arguments={
                "command": "python -m pytest -q",
                "prefix_rule": ["python", "-m", "pytest"],
            },
            reason="run tests",
        ),
        effect_profile=ToolEffectProfile(process=True),
    )

    assert decision.kind is ToolRuntimeDecisionKind.NEEDS_APPROVAL
    assert decision.pending_approval is not None
    assert decision.pending_approval.proposed_execpolicy_pattern == (
        "python",
        "-m",
        "pytest",
    )
    pending = RuntimeApprovalDecisions(approval_service).pending_decision_from_approval(
        decision.pending_approval
    )
    assert pending.options[-1].value == "always_allow"
    assert RuntimeApprovalDecisions(approval_service).format_allowed_choices(pending.options).endswith(
        "or 4"
    )


def test_runtime_policy_gate_omits_unvalidated_execpolicy_proposals(tmp_path: Path) -> None:
    approval_service = ApprovalService(SafetyPolicy(workspace_root=tmp_path))
    gate = RuntimePolicyGate(
        approval_service=approval_service,
        workspace_root=tmp_path,
    )

    calls = (
        ToolCall(
            name="Shell",
            arguments={"command": "python -m pytest -q"},
            reason="missing proposal",
        ),
        ToolCall(
            name="Bash",
            arguments={
                "command": "python -m pytest -q",
                "prefix_rule": ["python", "-m", "pytest"],
            },
            reason="legacy alias",
        ),
        ToolCall(
            name="Shell",
            arguments={
                "command": "git push --force origin main",
                "prefix_rule": ["git", "push", "--force"],
            },
            reason="destructive command",
        ),
    )

    for call in calls:
        decision = gate.decide(call, effect_profile=ToolEffectProfile(process=True))
        assert decision.kind is ToolRuntimeDecisionKind.NEEDS_APPROVAL
        assert decision.pending_approval is not None
        assert decision.pending_approval.proposed_execpolicy_pattern is None


def test_explicit_ask_rule_never_attaches_model_proposal(tmp_path: Path) -> None:
    gate = _shell_gate(
        tmp_path,
        rule=ExecPolicyRule(
            source=ExecPolicySource.PROJECT,
            index=0,
            pattern=("python", "-m", "pytest"),
            decision=ExecPolicyDecision.ASK,
        ),
    )

    decision = gate.decide(
        ToolCall(
            name="Shell",
            arguments={
                "command": "python -m pytest -q",
                "prefix_rule": ["python", "-m", "pytest"],
            },
            reason="run tests",
        ),
        effect_profile=ToolEffectProfile(process=True),
    )

    assert decision.kind is ToolRuntimeDecisionKind.NEEDS_APPROVAL
    assert decision.pending_approval is not None
    assert decision.pending_approval.proposed_execpolicy_pattern is None


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
    assert decision.kind is ToolRuntimeDecisionKind.NEEDS_APPROVAL
    trace = trace_service.load("demo")
    policy_trace = next(event for event in trace if event.kind == "runtime_policy_decision")
    assert policy_trace.payload["decision"] == "needs_approval"
    assert policy_trace.payload["policy"] == "sandbox_filesystem_policy"
    assert "blocked\n" not in str(policy_trace.payload)

    result = runtime.result_for_decision(decision)

    assert result.success is False
    assert result.summary == "Tool needs approval before execution."
    assert result.raw_payload["error_kind"] == "tool_needs_approval"


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
