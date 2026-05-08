from __future__ import annotations

from typing import Protocol

from mycli.domain.capabilities import CapabilityActivation
from mycli.domain.conversation import Conversation
from mycli.domain.runtime import PlanState


class ToolContributionProvider(Protocol):
    def provide(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        capability_activations: tuple[CapabilityActivation, ...],
    ) -> tuple[object, ...]:
        ...
