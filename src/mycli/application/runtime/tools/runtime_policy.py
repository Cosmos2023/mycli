from __future__ import annotations

from pathlib import Path
import shlex

from mycli.domain.runtime import (
    ExecPolicyRuleSet,
    ExecutionPolicy,
    SandboxProfile,
    ShellExecutionOptions,
    ToolRuntimeDecision,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.exposure import ToolExposure, ToolRouteSource
from mycli.services.approval import ApprovalService


class RuntimePolicyGate:
    """Projects existing approval/safety policy into the runtime contract."""

    def __init__(
        self,
        *,
        approval_service: ApprovalService,
        workspace_root: Path | None = None,
        execpolicy_rules: ExecPolicyRuleSet | None = None,
    ) -> None:
        self._approval_service = approval_service
        self._workspace_root = workspace_root
        self._execpolicy_rules = execpolicy_rules or ExecPolicyRuleSet()

    def default_policy(self) -> ExecutionPolicy:
        root = self._workspace_root or Path.cwd()
        return ExecutionPolicy.for_workspace(root)

    def set_workspace_policy(
        self,
        *,
        workspace_root: Path,
        execpolicy_rules: ExecPolicyRuleSet,
    ) -> None:
        self._workspace_root = workspace_root
        self._execpolicy_rules = execpolicy_rules

    def decide(
        self,
        call: ToolCall,
        policy: ExecutionPolicy | None = None,
        *,
        tool_exposure: ToolExposure | None = None,
    ) -> ToolRuntimeDecision:
        resolved_policy = policy or self.default_policy()
        execpolicy_decision = self._execpolicy_decision(
            call=call,
            sandbox=resolved_policy.sandbox,
        )
        if execpolicy_decision is not None:
            return execpolicy_decision
        if self._is_contributed_tool(call, tool_exposure):
            return ToolRuntimeDecision.allowed(
                tool_call=call,
                policy="contributed_tool_exposure",
                risk_level="low",
                sandbox=resolved_policy.sandbox,
            )

        outcome = self._approval_service.evaluate(call)
        metadata = outcome.safety_metadata or {}
        policy_name = _metadata_string(metadata.get("policy")) or resolved_policy.approval_policy
        risk_level = _metadata_string(metadata.get("risk_level"))
        decision_kind = _metadata_string(metadata.get("decision_kind"))
        if outcome.denied_reason is not None:
            return ToolRuntimeDecision.denied(
                tool_call=call,
                policy=policy_name,
                risk_level=risk_level,
                reason_code=decision_kind or "deny",
                sandbox=resolved_policy.sandbox,
            )
        if outcome.pending_approval is not None:
            return ToolRuntimeDecision.needs_approval(
                tool_call=call,
                policy=policy_name,
                risk_level=risk_level,
                reason_code=decision_kind or "needs_choice",
                pending_approval=outcome.pending_approval,
                sandbox=resolved_policy.sandbox,
            )
        return ToolRuntimeDecision.allowed(
            tool_call=call,
            policy=policy_name,
            risk_level=risk_level,
            sandbox=resolved_policy.sandbox,
        )

    def decide_execpolicy(
        self,
        call: ToolCall,
        policy: ExecutionPolicy | None = None,
    ) -> ToolRuntimeDecision | None:
        resolved_policy = policy or self.default_policy()
        return self._execpolicy_decision(
            call=call,
            sandbox=resolved_policy.sandbox,
        )

    def shell_execution_options(
        self,
        policy: ExecutionPolicy | None = None,
    ) -> ShellExecutionOptions:
        return ShellExecutionOptions.from_policy(policy or self.default_policy())

    def _execpolicy_decision(
        self,
        *,
        call: ToolCall,
        sandbox: SandboxProfile,
    ) -> ToolRuntimeDecision | None:
        if call.name not in {"Bash", "run_shell"}:
            return None
        command_args = _shell_command_args(call)
        if not command_args:
            return None
        match = self._execpolicy_rules.match(command_args)
        if match is None:
            return None
        return ToolRuntimeDecision.from_execpolicy_match(
            tool_call=call,
            match=match,
            sandbox=sandbox,
        )

    @staticmethod
    def _is_contributed_tool(
        call: ToolCall,
        tool_exposure: ToolExposure | None,
    ) -> bool:
        if tool_exposure is None:
            return False
        for entry in tool_exposure.entries:
            if entry.name != call.name:
                continue
            return entry.source in {ToolRouteSource.RUNTIME, ToolRouteSource.PROVIDER}
        return False


def _metadata_string(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _shell_command_args(call: ToolCall) -> tuple[str, ...]:
    args_value = call.arguments.get("args")
    if isinstance(args_value, list) and args_value and all(
        isinstance(item, str) for item in args_value
    ):
        return tuple(args_value)
    command_value = call.arguments.get("command")
    if not isinstance(command_value, str) or not command_value:
        return ()
    try:
        return tuple(shlex.split(command_value))
    except ValueError:
        return ()
