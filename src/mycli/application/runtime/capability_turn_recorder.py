from __future__ import annotations

from collections.abc import Callable

from mycli.domain.capabilities import (
    CapabilityActivation,
    CapabilityActivationDependencyStatus,
)
from mycli.domain.runtime import TurnItem, TurnItemType


class CapabilityTurnRecorder:
    def __init__(self, append_turn_item: Callable[..., None]) -> None:
        self._append_turn_item = append_turn_item

    def append_capability_turn_items(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        capability_activations: tuple[CapabilityActivation, ...],
    ) -> None:
        for activation in capability_activations:
            text = (
                f"Capability activated: {activation.name}"
                if activation.dependency_status is CapabilityActivationDependencyStatus.READY
                else f"Capability unavailable: {activation.name}"
            )
            self._append_turn_item(
                turn_id=turn_id,
                turn_items=turn_items,
                item=TurnItem(
                    type=TurnItemType.CAPABILITY,
                    text=text,
                    metadata={
                        "capability_name": activation.name,
                        "source": activation.source.value,
                        "dependency_status": activation.dependency_status.value,
                        "source_path": activation.source_path,
                        **activation.metadata,
                    },
                ),
            )
