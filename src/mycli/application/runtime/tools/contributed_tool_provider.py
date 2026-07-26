from __future__ import annotations

from typing import Protocol

from mycli.domain.conversation import Conversation
from mycli.domain.runtime import PlanState, RuntimeInterruptToken


class ToolContributionProvider(Protocol):
    def provide(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> tuple[object, ...]:
        ...
