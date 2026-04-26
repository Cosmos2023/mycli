from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.runtime import PendingApproval
from mycli.domain.tools import ToolCall
from mycli.services.safety_policy import SafetyPolicy


@dataclass(slots=True, frozen=True)
class ApprovalOutcome:
    auto_approved: bool = False
    denied_reason: str | None = None
    pending_approval: PendingApproval | None = None


class ApprovalService:
    def __init__(self, safety_policy: SafetyPolicy | None = None) -> None:
        self._safety_policy = safety_policy or SafetyPolicy()

    def evaluate(self, call: ToolCall) -> ApprovalOutcome:
        safety = self._safety_policy.evaluate(call)
        if safety.kind.value == "deny":
            return ApprovalOutcome(denied_reason=safety.reason)
        if safety.kind.value == "needs_choice":
            return ApprovalOutcome(
                pending_approval=PendingApproval(
                    tool_call=call,
                    reason=safety.reason,
                    preview=safety.preview,
                    command_pattern=safety.command_pattern,
                )
            )
        return ApprovalOutcome(auto_approved=True)
