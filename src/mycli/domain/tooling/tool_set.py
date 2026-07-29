from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from mycli.domain.tooling.exposure import (
    ToolExposure,
    ToolExposureKind,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.tools.base import ToolSpec


@dataclass(slots=True, frozen=True)
class ToolSetEntry:
    route_key: ToolRouteKey
    source: ToolRouteSource
    spec: ToolSpec
    kind: ToolExposureKind = ToolExposureKind.DIRECT
    metadata: dict[str, Any] = field(default_factory=dict)

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
                    kind=entry.kind,
                    metadata=dict(entry.metadata),
                )
                for entry in exposure.all_entries()
            )
        )

    def model_visible_entries(self) -> tuple[ToolSetEntry, ...]:
        return tuple(
            sorted(
                (
                    entry
                    for entry in self.entries
                    if entry.kind is not ToolExposureKind.DEFERRED
                ),
                key=lambda entry: entry.name,
            )
        )
