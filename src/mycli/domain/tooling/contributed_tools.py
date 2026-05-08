from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import StrEnum
from typing import Any

from mycli.domain.tooling.exposure import ToolRouteKey
from mycli.tools.base import SchemaTool, ToolSpec


class ToolContributionSource(StrEnum):
    RUNTIME = "runtime"
    CAPABILITY = "capability"
    PROVIDER = "provider"


class ToolContributionScope(StrEnum):
    TURN = "turn"
    THREAD = "thread"


class ToolContributionLifecycleState(StrEnum):
    DECLARED = "declared"
    EXPOSED = "exposed"
    INVOKED = "invoked"
    COMPLETED = "completed"
    FAILED = "failed"
    EXPIRED = "expired"


class ToolContributionConflictOutcome(StrEnum):
    ACCEPTED = "accepted"
    REJECTED_DUPLICATE_TOOL_ID = "rejected_duplicate_tool_id"
    REJECTED_ROUTE_CONFLICT = "rejected_route_conflict"
    SHADOWS_THREAD_SCOPE = "shadows_thread_scope"


@dataclass(slots=True, frozen=True)
class ToolContributionDescriptor:
    tool_id: str
    display_name: str
    description: str
    route_key: ToolRouteKey
    source: ToolContributionSource
    scope: ToolContributionScope
    lifecycle_state: ToolContributionLifecycleState
    spec: ToolSpec
    origin_metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def route_name(self) -> str:
        return self.route_key.value

    def with_lifecycle_state(
        self,
        lifecycle_state: ToolContributionLifecycleState,
    ) -> "ToolContributionDescriptor":
        return replace(self, lifecycle_state=lifecycle_state)

    def to_snapshot(self) -> dict[str, Any]:
        return {
            "tool_id": self.tool_id,
            "display_name": self.display_name,
            "description": self.description,
            "route_name": self.route_name,
            "source": self.source.value,
            "scope": self.scope.value,
            "state": self.lifecycle_state.value,
            "origin_metadata": dict(self.origin_metadata),
        }


@dataclass(slots=True, frozen=True)
class ToolContributionRegistration:
    descriptor: ToolContributionDescriptor
    tool: SchemaTool

    def with_lifecycle_state(
        self,
        lifecycle_state: ToolContributionLifecycleState,
    ) -> "ToolContributionRegistration":
        return ToolContributionRegistration(
            descriptor=self.descriptor.with_lifecycle_state(lifecycle_state),
            tool=self.tool,
        )


@dataclass(slots=True, frozen=True)
class ToolContributionLifecycleEvent:
    tool_id: str
    route_name: str
    scope: ToolContributionScope
    state: ToolContributionLifecycleState
    source: ToolContributionSource
    origin_metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "tool_id": self.tool_id,
            "route_name": self.route_name,
            "scope": self.scope.value,
            "state": self.state.value,
            "source": self.source.value,
            "origin_metadata": dict(self.origin_metadata),
        }
