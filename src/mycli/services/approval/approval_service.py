from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.runtime import (
    DecisionKind,
    PendingApproval,
    SessionCommandAllowance,
    ShellProfile,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.services.approval.safety_policy import SafetyPolicy


@dataclass(slots=True, frozen=True)
class ApprovalOutcome:
    auto_approved: bool = False
    auto_approved_by: str | None = None
    command_pattern: str | None = None
    reason: str | None = None
    denied_reason: str | None = None
    pending_approval: PendingApproval | None = None
    safety_metadata: dict[str, object] | None = None


class ApprovalService:
    def __init__(
        self,
        safety_policy: SafetyPolicy | None = None,
        session_allowances: tuple[SessionCommandAllowance, ...] = (),
    ) -> None:
        self._safety_policy = safety_policy or SafetyPolicy()
        self._session_allowances = session_allowances

    def set_safety_policy(self, safety_policy: SafetyPolicy) -> None:
        self._safety_policy = safety_policy

    def configure_shell_profile(self, shell_profile: ShellProfile) -> None:
        self._safety_policy.configure_shell_profile(shell_profile)

    def set_session_allowances(
        self,
        session_allowances: tuple[SessionCommandAllowance, ...],
    ) -> None:
        self._session_allowances = session_allowances

    def evaluate(self, call: ToolCall) -> ApprovalOutcome:
        safety = self._safety_policy.evaluate(call)
        if safety.kind is DecisionKind.DENY:
            return ApprovalOutcome(
                denied_reason=safety.reason,
                safety_metadata=safety.metadata,
            )
        if self._matches_session_allowance(call, safety.command_pattern):
            return ApprovalOutcome(
                auto_approved=True,
                auto_approved_by="session_allowance",
                command_pattern=safety.command_pattern,
                reason=safety.reason,
                safety_metadata=safety.metadata,
            )
        if safety.kind is DecisionKind.NEEDS_CHOICE:
            return ApprovalOutcome(
                pending_approval=PendingApproval(
                    tool_call=call,
                    reason=safety.reason,
                    preview=safety.preview,
                    command_pattern=safety.command_pattern,
                    metadata=safety.metadata,
                ),
                safety_metadata=safety.metadata,
            )
        return ApprovalOutcome(
            auto_approved=True,
            command_pattern=safety.command_pattern,
            reason=safety.reason,
            safety_metadata=safety.metadata,
        )

    def _matches_session_allowance(
        self,
        call: ToolCall,
        command_pattern: str | None,
    ) -> bool:
        if command_pattern is None or call.name not in {"Shell", "Bash", "run_shell"}:
            return False
        return any(
            allowance.command_pattern == command_pattern
            for allowance in self._session_allowances
        )
