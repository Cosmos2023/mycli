from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from mycli.tools.base import ToolSpec

if TYPE_CHECKING:
    from mycli.domain.dynamic_tools import DynamicToolDescriptor


class ToolExposureKind(StrEnum):
    DIRECT = "direct"
    DEFERRED = "deferred"
    DYNAMIC = "dynamic"


class ToolRouteSource(StrEnum):
    REGISTRY = "registry"
    RUNTIME = "runtime"
    CAPABILITY = "capability"
    PROVIDER = "provider"


@dataclass(slots=True, frozen=True)
class ToolRouteKey:
    namespace: str
    name: str

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise ValueError("ToolRouteKey name cannot be blank.")

    @classmethod
    def local(cls, name: str) -> "ToolRouteKey":
        return cls(namespace="", name=name)

    @property
    def value(self) -> str:
        namespace = self.namespace.strip()
        if not namespace:
            return self.name
        return f"{namespace}.{self.name}"


@dataclass(slots=True, frozen=True)
class ToolExposureEntry:
    route_key: ToolRouteKey
    kind: ToolExposureKind
    source: ToolRouteSource
    spec: ToolSpec
    metadata: dict[str, Any] = field(default_factory=dict)
    dynamic_descriptor: DynamicToolDescriptor | None = None

    @property
    def name(self) -> str:
        return self.route_key.value


@dataclass(slots=True, frozen=True)
class ToolExposure:
    direct: tuple[ToolExposureEntry, ...] = ()
    deferred: tuple[ToolExposureEntry, ...] = ()
    dynamic: tuple[ToolExposureEntry, ...] = ()

    def __post_init__(self) -> None:
        names = [entry.name for entry in self.all_entries()]
        if len(names) != len(set(names)):
            raise ValueError("ToolExposure entries must have unique route names.")

    def callable_entries(self) -> tuple[ToolExposureEntry, ...]:
        return self.all_entries()

    def callable_tool_names(self) -> tuple[str, ...]:
        return tuple(entry.name for entry in self.callable_entries())

    def all_entries(self) -> tuple[ToolExposureEntry, ...]:
        return (*self.direct, *self.deferred, *self.dynamic)

    def summary(self) -> dict[str, list[str]]:
        return {
            "direct": [entry.name for entry in self.direct],
            "deferred": [entry.name for entry in self.deferred],
            "dynamic": [entry.name for entry in self.dynamic],
        }
