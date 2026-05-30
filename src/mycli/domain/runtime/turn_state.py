from __future__ import annotations

from dataclasses import dataclass, field

from mycli.domain.conversation import Message
from mycli.domain.runtime.approvals import PendingApproval
from mycli.domain.runtime.clarifications import PendingClarification
from mycli.domain.runtime.planning import PlanState
from mycli.domain.runtime.protocol import StopReason


@dataclass(slots=True, frozen=True)
class SuspendedTurn:
    """Snapshot used to resume a paused turn, including block-aware transcript entries."""

    user_message: str
    conversation: tuple[Message, ...]
    plan_state: PlanState = field(default_factory=PlanState)
    pending_approval: PendingApproval | None = None
    pending_clarification: PendingClarification | None = None
    suspend_reason: StopReason = StopReason.INTERRUPTED
