from __future__ import annotations

from dataclasses import dataclass
from typing import cast

from mycli.domain.capabilities import CapabilityActivation
from mycli.domain.dynamic_tools import (
    DynamicToolLifecycleEvent,
    DynamicToolLifecycleState,
    DynamicToolDescriptor,
    DynamicToolRegistration,
    DynamicToolScope,
    DynamicToolSource,
)
from mycli.domain.tool_exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolExposureKind,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.tools.base import SchemaTool
from mycli.tools.registry import ToolRegistryV2


@dataclass(slots=True, frozen=True)
class PlannedToolExposure:
    exposure: ToolExposure
    dynamic_tools: dict[str, DynamicToolRegistration]
    lifecycle_events: tuple[DynamicToolLifecycleEvent, ...] = ()


class ToolExposurePlanner:
    def __init__(self, *, tool_registry: ToolRegistryV2) -> None:
        self._tool_registry = tool_registry

    def plan(
        self,
        *,
        user_message: str,
        capability_activations: tuple[CapabilityActivation, ...] = (),
        runtime_dynamic_tools: tuple[object, ...] = (),
    ) -> PlannedToolExposure:
        direct_names = set(self._default_direct_tool_names(user_message))
        direct_entries: list[ToolExposureEntry] = []
        deferred_entries: list[ToolExposureEntry] = []
        seen: set[str] = set()
        lifecycle_events: list[DynamicToolLifecycleEvent] = []

        for spec in self._tool_registry.specs.values():
            entry = ToolExposureEntry(
                route_key=ToolRouteKey.local(spec.name),
                kind=(
                    ToolExposureKind.DIRECT
                    if spec.name in direct_names
                    else ToolExposureKind.DEFERRED
                ),
                source=ToolRouteSource.REGISTRY,
                spec=spec,
            )
            seen.add(entry.name)
            if entry.kind is ToolExposureKind.DIRECT:
                direct_entries.append(entry)
            else:
                deferred_entries.append(entry)

        dynamic_entries: list[ToolExposureEntry] = []
        dynamic_tools: dict[str, DynamicToolRegistration] = {}
        for registration in runtime_dynamic_tools:
            normalized = self._normalize_registration(
                registration=registration,
                source=ToolRouteSource.RUNTIME,
                scope=DynamicToolScope.TURN,
            )
            if normalized is None:
                continue
            entry = self._dynamic_entry(
                registration=normalized,
                source=ToolRouteSource.RUNTIME,
                kind=ToolExposureKind.DYNAMIC,
            )
            if entry.name in seen:
                continue
            seen.add(entry.name)
            dynamic_entries.append(entry)
            dynamic_tools[entry.name] = normalized
            lifecycle_events.append(
                self._lifecycle_event(
                    registration=normalized,
                    state=DynamicToolLifecycleState.EXPOSED,
                )
            )

        for activation in capability_activations:
            for registration in self._activation_dynamic_tools(activation):
                entry = self._dynamic_entry(
                    registration=registration,
                    source=ToolRouteSource.CAPABILITY,
                    kind=ToolExposureKind.DYNAMIC,
                    metadata={"capability_name": activation.name},
                )
                if entry.name in seen:
                    continue
                seen.add(entry.name)
                dynamic_entries.append(entry)
                dynamic_tools[entry.name] = registration
                lifecycle_events.append(
                    self._lifecycle_event(
                        registration=registration,
                        state=DynamicToolLifecycleState.EXPOSED,
                    )
                )

        return PlannedToolExposure(
            exposure=ToolExposure(
                direct=tuple(direct_entries),
                deferred=tuple(deferred_entries),
                dynamic=tuple(dynamic_entries),
            ),
            dynamic_tools=dynamic_tools,
            lifecycle_events=tuple(lifecycle_events),
        )

    def _default_direct_tool_names(self, user_message: str) -> tuple[str, ...]:
        lowered = user_message.lower()
        direct = {
            "list_directory",
            "read_file",
            "read_file_range",
            "search_text",
            "update_plan",
        }
        if any(
            token in lowered
            for token in (
                "edit",
                "write",
                "modify",
                "create",
                "fix",
                "implement",
                "append",
                "replace",
                "refactor",
                "修改",
                "修复",
                "修一下",
                "改一下",
                "改动",
                "补一条",
                "补充",
                "新增",
                "创建",
                "删除",
                "移动",
                "重命名",
                "写入",
                "替换",
                "测试",
            )
        ):
            direct.update(
                {
                    "append_file",
                    "create_file",
                    "delete_path",
                    "edit_file",
                    "mkdir",
                    "move_path",
                    "replace_in_file",
                }
            )
        if any(
            token in lowered
            for token in (
                "shell",
                "command",
                "pytest",
                "ruff",
                "mypy",
                "git",
                "install",
                "push",
                "branch",
                "commit",
                "publish",
            )
        ):
            direct.update({"run_shell", "git_diff", "git_log", "git_status"})
        return tuple(sorted(direct))

    def _activation_dynamic_tools(
        self,
        activation: CapabilityActivation,
    ) -> tuple[DynamicToolRegistration, ...]:
        raw = activation.metadata.get("dynamic_tools")
        if not isinstance(raw, tuple):
            return ()
        tools: list[DynamicToolRegistration] = []
        for item in raw:
            normalized = self._normalize_registration(
                registration=item,
                source=ToolRouteSource.CAPABILITY,
                scope=DynamicToolScope.TURN,
                origin_metadata={"capability_name": activation.name},
            )
            if normalized is not None:
                tools.append(normalized)
        return tuple(tools)

    def _normalize_registration(
        self,
        *,
        registration: object,
        source: ToolRouteSource,
        scope: DynamicToolScope,
        origin_metadata: dict[str, object] | None = None,
    ) -> DynamicToolRegistration | None:
        if isinstance(registration, DynamicToolRegistration):
            return registration
        if hasattr(registration, "spec") and callable(getattr(registration, "execute", None)):
            tool = cast(SchemaTool, registration)
            route_key = self._route_key_for_tool_name(tool.spec.name)
            source_type = (
                DynamicToolSource.RUNTIME
                if source is ToolRouteSource.RUNTIME
                else DynamicToolSource.CAPABILITY
            )
            tool_id = f"{source_type.value}:{route_key.value}:{scope.value}"
            return DynamicToolRegistration(
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
        source: DynamicToolSource,
        scope: DynamicToolScope,
        origin_metadata: dict[str, object] | None = None,
    ) -> DynamicToolDescriptor:
        return DynamicToolDescriptor(
            tool_id=tool_id,
            display_name=tool.spec.name,
            description=tool.spec.description,
            route_key=route_key,
            source=source,
            scope=scope,
            lifecycle_state=DynamicToolLifecycleState.DECLARED,
            spec=tool.spec,
            origin_metadata={} if origin_metadata is None else dict(origin_metadata),
        )

    def _dynamic_entry(
        self,
        *,
        registration: DynamicToolRegistration,
        source: ToolRouteSource,
        kind: ToolExposureKind,
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
            kind=kind,
            source=source,
            spec=descriptor.spec,
            metadata=merged_metadata,
            dynamic_descriptor=descriptor,
        )

    def _lifecycle_event(
        self,
        *,
        registration: DynamicToolRegistration,
        state: DynamicToolLifecycleState,
    ) -> DynamicToolLifecycleEvent:
        descriptor = registration.descriptor
        return DynamicToolLifecycleEvent(
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
