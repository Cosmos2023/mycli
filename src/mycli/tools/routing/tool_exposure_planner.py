from __future__ import annotations

from dataclasses import dataclass
from typing import cast

from mycli.domain.tooling.contributed_tools import (
    ToolContributionLifecycleEvent,
    ToolContributionLifecycleState,
    ToolContributionDescriptor,
    ToolContributionRegistration,
    ToolContributionScope,
    ToolContributionSource,
)
from mycli.domain.tooling.exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.tools.base import SchemaTool
from mycli.tools.registry import ToolRegistry


MODEL_VISIBLE_BUILTIN_TOOLS: frozenset[str] = frozenset(
    {
        "AskUserQuestion",
        "Bash",
        "BashOutput",
        "Edit",
        "KillShell",
        "LS",
        "Plan",
        "Read",
        "Skill",
        "Task",
        "WebFetch",
        "WebSearch",
        "Write",
    }
)

HIDDEN_BY_DEFAULT_BUILTIN_TOOLS: frozenset[str] = frozenset(
    {
        "GitDiff",
        "GitLog",
        "GitShow",
        "GitStatus",
        "Lint",
        "Patch",
        "SubagentOutput",
        "enter_plan_mode",
        "exit_plan_mode",
    }
)

RETIRED_BUILTIN_TOOLS: frozenset[str] = frozenset({"Glob", "Grep"})

KNOWN_BUILTIN_TOOLS: frozenset[str] = (
    MODEL_VISIBLE_BUILTIN_TOOLS | HIDDEN_BY_DEFAULT_BUILTIN_TOOLS | RETIRED_BUILTIN_TOOLS
)


@dataclass(slots=True, frozen=True)
class PlannedToolExposure:
    exposure: ToolExposure
    contributed_tools: dict[str, ToolContributionRegistration]
    lifecycle_events: tuple[ToolContributionLifecycleEvent, ...] = ()


class ToolExposurePlanner:
    def __init__(self, *, tool_registry: ToolRegistry) -> None:
        self._tool_registry = tool_registry

    def plan(
        self,
        *,
        user_message: str,
        runtime_contributed_tools: tuple[object, ...] = (),
    ) -> PlannedToolExposure:
        del user_message
        entries: list[ToolExposureEntry] = []
        seen: set[str] = set()
        lifecycle_events: list[ToolContributionLifecycleEvent] = []

        specs = self._tool_registry.specs
        assert specs is not None
        for spec in specs.values():
            if not _is_model_visible_registry_tool(spec.name):
                continue
            entry = ToolExposureEntry(
                route_key=ToolRouteKey.local(spec.name),
                source=ToolRouteSource.REGISTRY,
                spec=spec,
            )
            seen.add(entry.name)
            entries.append(entry)

        contributed_tools: dict[str, ToolContributionRegistration] = {}
        for registration in runtime_contributed_tools:
            normalized = self._normalize_registration(
                registration=registration,
                source=ToolRouteSource.RUNTIME,
                scope=ToolContributionScope.TURN,
            )
            if normalized is None:
                continue
            entry = self._contributed_entry(
                registration=normalized,
                source=ToolRouteSource.RUNTIME,
            )
            if entry.name in seen:
                continue
            seen.add(entry.name)
            entries.append(entry)
            contributed_tools[entry.name] = normalized
            lifecycle_events.append(
                self._lifecycle_event(
                    registration=normalized,
                    state=ToolContributionLifecycleState.EXPOSED,
                )
            )

        return PlannedToolExposure(
            exposure=ToolExposure(entries=tuple(entries)),
            contributed_tools=contributed_tools,
            lifecycle_events=tuple(lifecycle_events),
        )

    def _normalize_registration(
        self,
        *,
        registration: object,
        source: ToolRouteSource,
        scope: ToolContributionScope,
        origin_metadata: dict[str, object] | None = None,
    ) -> ToolContributionRegistration | None:
        del source
        if isinstance(registration, ToolContributionRegistration):
            return registration
        if hasattr(registration, "spec") and callable(getattr(registration, "execute", None)):
            tool = cast(SchemaTool, registration)
            route_key = self._route_key_for_tool_name(tool.spec.name)
            source_type = ToolContributionSource.RUNTIME
            tool_id = f"{source_type.value}:{route_key.value}:{scope.value}"
            return ToolContributionRegistration(
                descriptor=self._descriptor(
                    tool=tool,
                    tool_id=tool_id,
                    route_key=route_key,
                    source=source_type,
                    scope=scope,
                    origin_metadata=origin_metadata,
                ),
                tool=tool,
            )
        return None

    def _descriptor(
        self,
        *,
        tool: SchemaTool,
        tool_id: str,
        route_key: ToolRouteKey,
        source: ToolContributionSource,
        scope: ToolContributionScope,
        origin_metadata: dict[str, object] | None = None,
    ) -> ToolContributionDescriptor:
        return ToolContributionDescriptor(
            tool_id=tool_id,
            display_name=tool.spec.name,
            description=tool.spec.description,
            route_key=route_key,
            source=source,
            scope=scope,
            lifecycle_state=ToolContributionLifecycleState.DECLARED,
            spec=tool.spec,
            origin_metadata={} if origin_metadata is None else dict(origin_metadata),
        )

    def _contributed_entry(
        self,
        *,
        registration: ToolContributionRegistration,
        source: ToolRouteSource,
        metadata: dict[str, object] | None = None,
    ) -> ToolExposureEntry:
        descriptor = registration.descriptor
        merged_metadata: dict[str, object] = {
            "tool_id": descriptor.tool_id,
            "scope": descriptor.scope.value,
            "state": descriptor.lifecycle_state.value,
        }
        if metadata is not None:
            merged_metadata.update(metadata)
        return ToolExposureEntry(
            route_key=descriptor.route_key,
            source=source,
            spec=descriptor.spec,
            metadata=merged_metadata,
        )

    def _lifecycle_event(
        self,
        *,
        registration: ToolContributionRegistration,
        state: ToolContributionLifecycleState,
    ) -> ToolContributionLifecycleEvent:
        descriptor = registration.descriptor
        return ToolContributionLifecycleEvent(
            tool_id=descriptor.tool_id,
            route_name=descriptor.route_name,
            scope=descriptor.scope,
            state=state,
            source=descriptor.source,
            origin_metadata=dict(descriptor.origin_metadata),
        )

    def _route_key_for_tool_name(self, name: str) -> ToolRouteKey:
        if "." not in name:
            return ToolRouteKey.local(name)
        namespace, local_name = name.rsplit(".", maxsplit=1)
        return ToolRouteKey(namespace=namespace, name=local_name)


def _is_model_visible_registry_tool(name: str) -> bool:
    if name in MODEL_VISIBLE_BUILTIN_TOOLS:
        return True
    if name in HIDDEN_BY_DEFAULT_BUILTIN_TOOLS:
        return False
    return name not in KNOWN_BUILTIN_TOOLS
