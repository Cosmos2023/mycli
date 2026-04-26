from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class PlanStatus(StrEnum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


@dataclass(slots=True, frozen=True)
class PlanItem:
    id: str
    content: str
    status: PlanStatus = PlanStatus.PENDING


@dataclass(slots=True, frozen=True)
class PlanState:
    items: tuple[PlanItem, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        in_progress = [
            item for item in self.items if item.status is PlanStatus.IN_PROGRESS
        ]
        if len(in_progress) > 1:
            raise ValueError("PlanState allows a single in_progress item.")

    def replace_item(self, item_id: str, status: PlanStatus) -> "PlanState":
        return PlanState(
            items=tuple(
                PlanItem(
                    id=item.id,
                    content=item.content,
                    status=status if item.id == item_id else item.status,
                )
                for item in self.items
            )
        )

    def current_in_progress_item_id(self) -> str | None:
        for item in self.items:
            if item.status is PlanStatus.IN_PROGRESS:
                return item.id
        return None
