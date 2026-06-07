from __future__ import annotations

from pathlib import Path

from mycli.domain.runtime import (
    ApprovalGate,
    ExecPolicyDecision,
    ExecPolicyRule,
    ExecPolicySource,
    ExecutionPolicy,
    SandboxProfile,
    ToolRuntimeDecision,
    ToolRuntimeDecisionKind,
    ToolRuntimeEffect,
)
from mycli.domain.tooling.calls import ToolCall


def test_tool_runtime_decision_redacts_arguments_and_keeps_bounded_metadata() -> None:
    rule = ExecPolicyRule(
        source=ExecPolicySource.PROJECT,
        index=0,
        pattern=("git", "push"),
        decision=ExecPolicyDecision.ASK,
    )
    decision = ToolRuntimeDecision.allowed(
        tool_call=ToolCall(
            name="Bash",
            arguments={"command": "echo sk-secret", "timeout": 1},
            reason="run command",
            call_id="call_1",
        ),
        policy="shell_command_analysis",
        risk_level="high",
        sandbox=SandboxProfile(
            workspace_roots=(Path("/repo"),),
            cwd=Path("/repo"),
            filesystem="workspace_write",
            network="enabled",
            shell="restricted",
        ),
        execpolicy_rule=rule,
        effect=ToolRuntimeEffect(filesystem="unknown", network=False, process=True),
    )

    payload = decision.to_trace_payload()

    assert payload == {
        "tool_name": "Bash",
        "tool_call_id": "call_1",
        "decision": "allowed",
        "policy": "shell_command_analysis",
        "risk_level": "high",
        "argument_count": 2,
        "argument_keys": ["command", "timeout"],
        "approval_required": False,
        "reason_code": None,
        "sandbox": {
            "workspace_roots": 1,
            "filesystem": "workspace_write",
            "network": "enabled",
            "shell": "restricted",
        },
        "effect": {
            "filesystem": "unknown",
            "network": False,
            "process": True,
        },
        "execpolicy_decision": "ask",
        "execpolicy_rule_source": "project",
        "execpolicy_rule_index": 0,
        "execpolicy_rule_pattern_hash": rule.pattern_hash,
        "execpolicy_rule_pattern_length": 2,
        "execpolicy_rule_argument_count": 2,
    }
    assert "sk-secret" not in str(payload)
    assert "git push" not in str(payload)


def test_execution_policy_default_sandbox_is_bounded_to_workspace() -> None:
    policy = ExecutionPolicy.for_workspace(Path("/repo"))

    assert policy.sandbox.cwd == Path("/repo")
    assert policy.sandbox.workspace_roots == (Path("/repo"),)
    assert policy.sandbox.filesystem == "workspace_write"
    assert policy.sandbox.network == "enabled"
    assert policy.sandbox.shell == "restricted"


def test_approval_gate_protocol_accepts_policy_decisions() -> None:
    class DenyGate:
        def decide(self, call: ToolCall, policy: ExecutionPolicy) -> ToolRuntimeDecision:
            return ToolRuntimeDecision.denied(
                tool_call=call,
                policy="test_policy",
                reason_code="blocked",
                sandbox=policy.sandbox,
            )

    gate: ApprovalGate = DenyGate()
    decision = gate.decide(
        ToolCall(name="Write", arguments={"path": "notes.txt"}, reason="write"),
        ExecutionPolicy.for_workspace(Path("/repo")),
    )

    assert decision.kind is ToolRuntimeDecisionKind.DENIED
    assert decision.to_trace_payload()["decision"] == "denied"
