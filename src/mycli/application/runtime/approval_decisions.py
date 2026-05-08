from __future__ import annotations

from mycli.domain.runtime import (
    DecisionAction,
    PendingApproval,
    PendingDecision,
)
from mycli.services.approval.approval_service import ApprovalService


class RuntimeApprovalDecisions:
    def __init__(self, approval_service: ApprovalService) -> None:
        self._approval_service = approval_service

    def pending_decision_from_approval(
        self,
        approval: PendingApproval,
    ) -> PendingDecision:
        options = [DecisionAction.APPROVE_ONCE, DecisionAction.REJECT]
        if approval.command_pattern:
            options.append(DecisionAction.ALLOW_SESSION)
        return PendingDecision(
            tool_call=approval.tool_call,
            kind=self._approval_service._safety_policy.evaluate(approval.tool_call).kind,
            reason=approval.reason,
            preview=approval.preview,
            options=tuple(options),
            command_pattern=approval.command_pattern,
        )

    def format_allowed_choices(self, options: tuple[DecisionAction, ...]) -> str:
        choice_to_action = {
            "1": DecisionAction.APPROVE_ONCE,
            "2": DecisionAction.REJECT,
            "3": DecisionAction.ALLOW_SESSION,
        }
        allowed_choices = tuple(
            key for key, action in choice_to_action.items() if action in options
        )
        if len(allowed_choices) == 1:
            return allowed_choices[0]
        if len(allowed_choices) == 2:
            return f"{allowed_choices[0]} or {allowed_choices[1]}"
        return ", ".join(allowed_choices[:-1]) + f", or {allowed_choices[-1]}"
