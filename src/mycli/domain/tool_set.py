from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from mycli.domain.runtime import stable_hash
from mycli.domain.tool_exposure import ToolExposure, ToolRouteKey, ToolRouteSource
from mycli.tools.base import ToolSpec

if TYPE_CHECKING:
    from mycli.domain.dynamic_tools import DynamicToolDescriptor


@dataclass(slots=True, frozen=True)
class ToolSetEntry:
    route_key: ToolRouteKey
    source: ToolRouteSource
    spec: ToolSpec
    metadata: dict[str, Any] = field(default_factory=dict)
    dynamic_descriptor: DynamicToolDescriptor | None = None

    @property
    def name(self) -> str:
        return self.route_key.value


@dataclass(slots=True, frozen=True)
class ToolSet:
    entries: tuple[ToolSetEntry, ...] = ()

    def __post_init__(self) -> None:
        names = [entry.name for entry in self.entries]
        if len(names) != len(set(names)):
            raise ValueError("ToolSet entries must have unique route names.")

    @classmethod
    def from_exposure(cls, exposure: ToolExposure) -> ToolSet:
        return cls(
            entries=tuple(
                ToolSetEntry(
                    route_key=entry.route_key,
                    source=entry.source,
                    spec=entry.spec,
                    metadata=dict(entry.metadata),
                    dynamic_descriptor=entry.dynamic_descriptor,
                )
                for entry in exposure.all_entries()
            )
        )

    def model_visible_entries(self) -> tuple[ToolSetEntry, ...]:
        return tuple(sorted(self.entries, key=lambda entry: entry.name))

    def order_hash(self) -> str:
        return stable_hash("\n".join(entry.name for entry in self.model_visible_entries()))
