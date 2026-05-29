from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import StrEnum
from typing import Any


class DynamicToolSource(StrEnum):
    RUNTIME = "runtime"
    PROVIDER = "provider"


class DynamicToolScope(StrEnum):
    TURN = "turn"
    THREAD = "thread"


class DynamicToolLifecycleState(StrEnum):
    DECLARED = "declared"
    EXPOSED = "exposed"
    INVOKED = "invoked"
    COMPLETED = "completed"
    FAILED = "failed"
    EXPIRED = "expired"


class DynamicToolConflictOutcome(StrEnum):
    ACCEPTED = "accepted"
    REJECTED_DUPLICATE_TOOL_ID = "rejected_duplicate_tool_id"
    REJECTED_ROUTE_CONFLICT = "rejected_route_conflict"
    SHADOWS_THREAD_SCOPE = "shadows_thread_scope"


@dataclass(slots=True, frozen=True)
class DynamicToolDescriptor:
    tool_id: str
    route_name: str
    source: DynamicToolSource
    scope: DynamicToolScope
    lifecycle_state: DynamicToolLifecycleState = DynamicToolLifecycleState.DECLARED
    origin_metadata: dict[str, Any] = field(default_factory=dict)

    def with_lifecycle_state(
        self,
        lifecycle_state: DynamicToolLifecycleState,
    ) -> "DynamicToolDescriptor":
        return replace(self, lifecycle_state=lifecycle_state)

    def to_snapshot(self) -> dict[str, object]:
        return {
            "tool_id": self.tool_id,
            "route_name": self.route_name,
            "source": self.source.value,
            "scope": self.scope.value,
            "state": self.lifecycle_state.value,
            "origin_metadata": dict(self.origin_metadata),
        }


@dataclass(slots=True, frozen=True)
class DynamicToolRegistration:
    descriptor: DynamicToolDescriptor
    tool: object

    def with_lifecycle_state(
        self,
        lifecycle_state: DynamicToolLifecycleState,
    ) -> "DynamicToolRegistration":
        return replace(
            self,
            descriptor=self.descriptor.with_lifecycle_state(lifecycle_state),
        )


@dataclass(slots=True, frozen=True)
class DynamicToolLifecycleEvent:
    tool_id: str
    route_name: str
    scope: DynamicToolScope
    state: DynamicToolLifecycleState
    source: DynamicToolSource
    origin_metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            "tool_id": self.tool_id,
            "route_name": self.route_name,
            "scope": self.scope.value,
            "state": self.state.value,
            "source": self.source.value,
            "origin_metadata": dict(self.origin_metadata),
        }


__all__ = [
    "DynamicToolConflictOutcome",
    "DynamicToolDescriptor",
    "DynamicToolLifecycleEvent",
    "DynamicToolLifecycleState",
    "DynamicToolRegistration",
    "DynamicToolScope",
    "DynamicToolSource",
]
