from __future__ import annotations

from dataclasses import dataclass, field

from mycli.domain.dynamic_tools import (
    DynamicToolConflictOutcome,
    DynamicToolLifecycleEvent,
    DynamicToolLifecycleState,
    DynamicToolRegistration,
    DynamicToolScope,
)


@dataclass(slots=True, frozen=True)
class DynamicToolRegisterResult:
    outcome: DynamicToolConflictOutcome
    registration: DynamicToolRegistration | None
    lifecycle_event: DynamicToolLifecycleEvent | None = None


@dataclass(slots=True)
class DynamicToolRegistry:
    _by_tool_id: dict[str, DynamicToolRegistration] = field(default_factory=dict)
    _by_scope_and_route: dict[tuple[str, str], str] = field(default_factory=dict)

    def register(self, registration: DynamicToolRegistration) -> DynamicToolRegisterResult:
        descriptor = registration.descriptor
        if descriptor.tool_id in self._by_tool_id:
            return DynamicToolRegisterResult(
                outcome=DynamicToolConflictOutcome.REJECTED_DUPLICATE_TOOL_ID,
                registration=None,
            )

        scope_route_key = (descriptor.scope.value, descriptor.route_name)
        if scope_route_key in self._by_scope_and_route:
            return DynamicToolRegisterResult(
                outcome=DynamicToolConflictOutcome.REJECTED_ROUTE_CONFLICT,
                registration=None,
            )

        shadowed_thread = (
            descriptor.scope is DynamicToolScope.TURN
            and ("thread", descriptor.route_name) in self._by_scope_and_route
        )
        self._by_tool_id[descriptor.tool_id] = registration
        self._by_scope_and_route[scope_route_key] = descriptor.tool_id
        return DynamicToolRegisterResult(
            outcome=(
                DynamicToolConflictOutcome.SHADOWS_THREAD_SCOPE
                if shadowed_thread
                else DynamicToolConflictOutcome.ACCEPTED
            ),
            registration=registration,
            lifecycle_event=self._lifecycle_event(
                registration=registration,
                state=DynamicToolLifecycleState.DECLARED,
            ),
        )

    def get(self, tool_id: str) -> DynamicToolRegistration | None:
        return self._by_tool_id.get(tool_id)

    def get_visible_registrations(self) -> tuple[DynamicToolRegistration, ...]:
        visible: dict[str, DynamicToolRegistration] = {}
        for registration in self._by_tool_id.values():
            if registration.descriptor.scope is DynamicToolScope.THREAD:
                visible.setdefault(registration.descriptor.route_name, registration)
        for registration in self._by_tool_id.values():
            if registration.descriptor.scope is DynamicToolScope.TURN:
                visible[registration.descriptor.route_name] = registration
        return tuple(sorted(visible.values(), key=lambda item: item.descriptor.route_name))

    def transition(
        self,
        tool_id: str,
        state: DynamicToolLifecycleState,
    ) -> DynamicToolLifecycleEvent | None:
        registration = self._by_tool_id.get(tool_id)
        if registration is None:
            return None
        if registration.descriptor.lifecycle_state is state:
            return None
        updated = registration.with_lifecycle_state(state)
        self._by_tool_id[tool_id] = updated
        return self._lifecycle_event(registration=updated, state=state)

    def expire_turn_scoped(self) -> tuple[DynamicToolLifecycleEvent, ...]:
        expired: list[DynamicToolLifecycleEvent] = []
        for tool_id, registration in list(self._by_tool_id.items()):
            if registration.descriptor.scope is not DynamicToolScope.TURN:
                continue
            expired_event = self.transition(tool_id, DynamicToolLifecycleState.EXPIRED)
            if expired_event is not None:
                expired.append(expired_event)
            self._by_tool_id.pop(tool_id, None)
            self._by_scope_and_route.pop(
                (registration.descriptor.scope.value, registration.descriptor.route_name),
                None,
            )
        return tuple(expired)

    def snapshot(self) -> list[dict[str, object]]:
        snapshots = [
            registration.descriptor.to_snapshot() for registration in self.get_visible_registrations()
        ]
        return sorted(snapshots, key=lambda item: str(item["tool_id"]))

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
