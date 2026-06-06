from __future__ import annotations

from pathlib import Path

from mycli.domain.runtime import ExecutionPolicy, ToolRuntimeDecision
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
    ) -> None:
        self._approval_service = approval_service
        self._workspace_root = workspace_root

    def default_policy(self) -> ExecutionPolicy:
        root = self._workspace_root or Path.cwd()
        return ExecutionPolicy.for_workspace(root)

    def decide(
        self,
        call: ToolCall,
        policy: ExecutionPolicy | None = None,
        *,
        tool_exposure: ToolExposure | None = None,
    ) -> ToolRuntimeDecision:
        resolved_policy = policy or self.default_policy()
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
