from __future__ import annotations

from dataclasses import dataclass

from mycli.application.runtime.tools.runtime_policy import RuntimePolicyGate
from mycli.domain.runtime import (
    RuntimeTraceEvent,
    ToolRuntimeDecision,
    ToolRuntimeDecisionKind,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.exposure import ToolExposure
from mycli.services.tracing import TraceService
from mycli.tools.base import ToolEffectProfile, ToolResult


@dataclass(slots=True)
class ToolPolicyRuntime:
    """Coordinates tool runtime policy decisions and their runtime artifacts."""

    session_id: str
    policy_gate: RuntimePolicyGate | None
    trace_service: TraceService

    def decide(
        self,
        *,
        call: ToolCall,
        tool_exposure: ToolExposure,
        turn_id: str,
        policy_approved: bool,
        effect_profile: ToolEffectProfile,
    ) -> ToolRuntimeDecision | None:
        if self.policy_gate is None:
            return None
        if policy_approved:
            return None
        decision = self.policy_gate.decide(
            call,
            tool_exposure=tool_exposure,
            effect_profile=effect_profile,
        )
        self.trace_service.append(
            self.session_id,
            RuntimeTraceEvent(
                kind="runtime_policy_decision",
                turn_id=turn_id,
                payload=decision.to_trace_payload(),
            ),
        )
        return decision

    def result_for_decision(self, decision: ToolRuntimeDecision) -> ToolResult:
        if decision.kind is ToolRuntimeDecisionKind.NEEDS_APPROVAL:
            summary = "Tool needs approval before execution."
            error_kind = "tool_needs_approval"
        else:
            summary = runtime_policy_denial_message(decision)
            error_kind = "tool_denied_by_policy"
        return ToolResult(
            success=False,
            summary=summary,
            error=summary,
            raw_payload={
                "tool_name": decision.tool_call.name,
                "error_kind": error_kind,
                "runtime_policy": decision.to_trace_payload(),
            },
        )


def runtime_policy_denial_message(decision: ToolRuntimeDecision) -> str:
    if (
        decision.policy == "collaboration_mode"
        and decision.reason_code == "plan_mode_blocks_mutating_tool"
    ):
        return (
            f"Plan mode is read-only; blocked {decision.tool_call.name}. "
            "Switch to /mode default to allow mutating tools."
        )
    parts = [f"Tool denied by runtime policy: {decision.tool_call.name}"]
    details: list[str] = []
    if decision.policy:
        details.append(f"policy={decision.policy}")
    if decision.reason_code:
        details.append(f"reason={decision.reason_code}")
    if details:
        parts.append(f"({', '.join(details)})")
    return " ".join(parts) + "."
