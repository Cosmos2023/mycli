from __future__ import annotations

from pathlib import Path

from mycli.domain.runtime import (
    ApprovalGate,
    ExecPolicyDecision,
    ExecPolicyRule,
    ExecPolicySource,
    ExecutionPolicy,
    SandboxMode,
    SandboxProfile,
    ShellBackendProfile,
    ShellExecutionOptions,
    ToolRuntimeDecision,
    ToolRuntimeDecisionKind,
    ToolRuntimeEffect,
    tool_runtime_coverage_profiles,
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
            writable_roots=(Path("/repo"), Path("/tmp/mycli-cache")),
            denied_read_roots=(Path("/private/secrets"),),
            denied_read_globs=("**/.env",),
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
                "writable_roots": 2,
                "denied_read_roots": 1,
                "denied_read_globs": 1,
                "sandbox_mode": "workspace-write",
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


def test_execution_policy_default_sandbox_matches_codex_workspace_write() -> None:
    policy = ExecutionPolicy.for_workspace(Path("/repo"))

    assert policy.sandbox.mode == SandboxMode.WORKSPACE_WRITE
    assert policy.sandbox.cwd == Path("/repo")
    assert policy.sandbox.workspace_roots == (Path("/repo"),)
    assert policy.sandbox.writable_roots == (Path("/repo"),)
    assert policy.sandbox.denied_read_roots == ()
    assert policy.sandbox.denied_read_globs == ("**/.env", "**/.env.*")
    assert policy.sandbox.filesystem == "workspace_write"
    assert policy.sandbox.network == "disabled"
    assert policy.sandbox.shell == "restricted"


def test_execution_policy_builds_named_sandbox_modes() -> None:
    read_only = ExecutionPolicy.for_workspace(Path("/repo"), sandbox_mode=SandboxMode.READ_ONLY)
    unrestricted = ExecutionPolicy.for_workspace(
        Path("/repo"),
        sandbox_mode=SandboxMode.DANGER_FULL_ACCESS,
    )

    assert read_only.sandbox.mode == SandboxMode.READ_ONLY
    assert read_only.sandbox.filesystem == "read_only"
    assert read_only.sandbox.network == "disabled"
    assert read_only.sandbox.shell == "restricted"
    assert read_only.sandbox.writable_roots == ()
    assert unrestricted.sandbox.mode == SandboxMode.DANGER_FULL_ACCESS
    assert unrestricted.sandbox.filesystem == "unrestricted"
    assert unrestricted.sandbox.network == "enabled"
    assert unrestricted.sandbox.shell == "enabled"
    assert unrestricted.sandbox.writable_roots == (Path("/repo"),)


def test_shell_backend_profile_is_bounded_runtime_metadata() -> None:
    profile = ShellBackendProfile()
    options = ShellExecutionOptions(workspace_root=Path("/repo"), backend=profile)

    payload = options.to_trace_payload(
        timeout_seconds=3,
        timeout_capped=False,
        env_keys=("PATH",),
        cwd="/repo",
    )

    assert payload["backend"] == {
        "backend": "local",
        "available": True,
        "isolation": "host_subprocess",
        "supports_background": True,
        "supports_interrupt_cleanup": True,
    }
    assert "command" not in str(payload)


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


def test_tool_runtime_coverage_profiles_name_all_tool_like_lanes() -> None:
    profiles = tool_runtime_coverage_profiles()
    by_lane = {profile.lane: profile for profile in profiles}

    assert set(by_lane) == {
        "builtin_tool",
        "shell_foreground",
        "shell_background",
        "mcp_tool",
        "plugin_tool",
        "hook_execution",
        "subagent_job",
        "skill_activation",
        "background_job_control",
    }
    assert by_lane["shell_foreground"].is_full_runtime_lane is True
    assert by_lane["hook_execution"].is_partial_runtime_lane is True
    assert by_lane["subagent_job"].known_gap == (
        "delegated_actions_are_not_single_tool_runtime_lane"
    )


def test_tool_runtime_coverage_payload_is_bounded_metadata() -> None:
    payloads = [
        profile.to_diagnostic_payload()
        for profile in tool_runtime_coverage_profiles()
    ]

    encoded = str(payloads)

    assert "command" not in encoded
    assert "arguments" not in encoded
    assert "stdout" not in encoded
    assert "stderr" not in encoded
    assert "api_key" not in encoded
    assert "secret" not in encoded
