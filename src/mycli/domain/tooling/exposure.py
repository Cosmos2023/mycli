from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from mycli.tools.base import ToolSpec


class ToolRouteSource(StrEnum):
    REGISTRY = "registry"
    RUNTIME = "runtime"
    PROVIDER = "provider"


class ToolExposureKind(StrEnum):
    TOOL = "tool"
    DIRECT = "tool"
    DEFERRED = "tool"
    CONTRIBUTED = "tool"


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


@dataclass(slots=True, frozen=True, init=False)
class ToolExposureEntry:
    route_key: ToolRouteKey
    source: ToolRouteSource
    spec: ToolSpec
    metadata: dict[str, Any] = field(default_factory=dict)

    def __init__(
        self,
        *,
        route_key: ToolRouteKey,
        source: ToolRouteSource,
        spec: ToolSpec,
        metadata: dict[str, Any] | None = None,
        kind: ToolExposureKind | None = None,
        contributed_descriptor: object | None = None,
    ) -> None:
        del kind, contributed_descriptor
        object.__setattr__(self, "route_key", route_key)
        object.__setattr__(self, "source", source)
        object.__setattr__(self, "spec", spec)
        object.__setattr__(self, "metadata", {} if metadata is None else dict(metadata))

    @property
    def name(self) -> str:
        return self.route_key.value


@dataclass(slots=True, frozen=True, init=False)
class ToolExposure:
    entries: tuple[ToolExposureEntry, ...] = ()

    def __init__(
        self,
        entries: tuple[ToolExposureEntry, ...] = (),
        *,
        direct: tuple[ToolExposureEntry, ...] = (),
        deferred: tuple[ToolExposureEntry, ...] = (),
        contributed: tuple[ToolExposureEntry, ...] = (),
    ) -> None:
        object.__setattr__(self, "entries", (*entries, *direct, *deferred, *contributed))
        self.__post_init__()

    def __post_init__(self) -> None:
        names = [entry.name for entry in self.entries]
        if len(names) != len(set(names)):
            raise ValueError("ToolExposure entries must have unique route names.")

    def callable_entries(self) -> tuple[ToolExposureEntry, ...]:
        return self.entries

    def callable_tool_names(self) -> tuple[str, ...]:
        return tuple(entry.name for entry in self.callable_entries())

    def all_entries(self) -> tuple[ToolExposureEntry, ...]:
        return self.entries

    def summary(self) -> dict[str, list[str]]:
        return {"tools": [entry.name for entry in self.entries]}
