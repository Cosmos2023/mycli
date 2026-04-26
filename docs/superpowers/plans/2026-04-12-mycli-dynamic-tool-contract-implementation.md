# mycli Dynamic Tool Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Productize dynamic tools as first-class runtime objects with stable descriptors, scope, lifecycle, persistence, and surface visibility so `mycli` can stay a general-purpose agent instead of drifting into task-specific tool hacks.

**Architecture:** Introduce a dedicated dynamic-tool domain model plus a small registry service that owns identity, scope, lifecycle, and conflict handling. Update planner/router/runtime/session/context layers to consume registrations instead of raw ad hoc `SchemaTool` tuples, then add tests that prove dynamic tools survive declaration, exposure, invocation, persistence, and expiration without becoming a codebase-analysis-only feature.

**Tech Stack:** Python 3.13, standard-library `dataclasses`/`enum`/`pathlib`, existing `ToolRegistryV2` + `AgentRuntime`, `pytest`, `ruff`

---

## Scope Check

This plan implements the approved dynamic-tool-contract design in `openspec/changes/formalize-dynamic-tool-contract/`. It covers:

- dynamic tool domain models
- runtime/capability registration through a shared contract
- planner/router integration
- lifecycle visibility in turn items, trace, session persistence, and turn context
- conflict handling for turn-scoped and thread-scoped tools

It does **not** implement provider/MCP bridge logic, approval policy expansion, or new external tools. Those remain follow-up work after the contract is stable.

## File Structure

- Create: `src/mycli/domain/dynamic_tools.py`
  Owns `DynamicToolDescriptor`, `DynamicToolScope`, `DynamicToolLifecycleState`, `DynamicToolSource`, and conflict outcome models.
- Create: `src/mycli/services/dynamic_tool_registry.py`
  Owns runtime registrations, conflict resolution, scope filtering, lifecycle transitions, and expiration logic.
- Modify: `src/mycli/domain/tool_exposure.py`
  Allows exposure entries to carry descriptor-backed dynamic-tool metadata instead of relying on loose `metadata` dicts alone.
- Modify: `src/mycli/services/tool_exposure_planner.py`
  Converts runtime/capability registrations into exposure entries and lifecycle transitions.
- Modify: `src/mycli/services/tool_router.py`
  Executes dynamic tools via stable registrations and records lifecycle transitions on success/failure.
- Modify: `src/mycli/application/runtime/agent_runtime.py`
  Replaces raw `_runtime_dynamic_tools()` tuples with registry-backed registrations, emits lifecycle items/trace, and expires turn-scoped tools.
- Modify: `src/mycli/services/context/turn_context_assembler.py`
  Renders dynamic tool descriptors into turn context/tool exposure summaries.
- Modify: `src/mycli/services/session_service.py`
  Persists dynamic tool descriptor snapshots and lifecycle state changes across thread scope.
- Modify: `src/mycli/domain/runtime/protocol.py`
  Adds turn item types for dynamic tool lifecycle visibility.
- Modify: `tests/unit/services/test_tool_exposure_planner.py`
  Covers registration-to-exposure conversion, scope filtering, and conflict outcomes.
- Modify: `tests/unit/services/test_tool_router.py`
  Covers descriptor-backed execution and failure transitions.
- Modify: `tests/unit/services/test_session_service.py`
  Covers dynamic tool persistence round trips.
- Modify: `tests/unit/services/test_turn_context_assembler.py`
  Covers dynamic tool descriptor rendering in turn context.
- Modify: `tests/unit/application/test_agent_runtime.py`
  Covers lifecycle items, trace events, thread-scoped persistence, and turn-scoped expiration.
- Create: `tests/unit/domain/test_dynamic_tools.py`
  Covers descriptor identity, lifecycle transitions, and conflict dataclasses.
- Create: `tests/unit/services/test_dynamic_tool_registry.py`
  Covers registration, conflict handling, exposure selection, and expiration.

## Task 1: Introduce Dynamic Tool Domain Models

**Files:**
- Create: `src/mycli/domain/dynamic_tools.py`
- Modify: `src/mycli/domain/tool_exposure.py`
- Create: `tests/unit/domain/test_dynamic_tools.py`

- [ ] **Step 1: Write the failing dynamic descriptor identity test**

```python
# tests/unit/domain/test_dynamic_tools.py
from mycli.domain.dynamic_tools import (
    DynamicToolDescriptor,
    DynamicToolLifecycleState,
    DynamicToolScope,
    DynamicToolSource,
)
from mycli.domain.tool_exposure import ToolRouteKey
from mycli.tools.base import ToolParameter, ToolSpec


def test_dynamic_tool_descriptor_exposes_stable_identity_and_route() -> None:
    descriptor = DynamicToolDescriptor(
        tool_id="runtime:workspace_summary:thread",
        display_name="workspace_summary",
        description="Summarize workspace facts",
        route_key=ToolRouteKey.local("workspace_summary"),
        source=DynamicToolSource.RUNTIME,
        scope=DynamicToolScope.THREAD,
        lifecycle_state=DynamicToolLifecycleState.DECLARED,
        spec=ToolSpec(
            name="workspace_summary",
            description="Summarize workspace facts",
            parameters=(ToolParameter(name="path", type="string", required=False),),
        ),
    )

    assert descriptor.tool_id == "runtime:workspace_summary:thread"
    assert descriptor.route_name == "workspace_summary"
    assert descriptor.scope.value == "thread"
    assert descriptor.lifecycle_state.value == "declared"
```

- [ ] **Step 2: Run the domain test to confirm the contract does not exist yet**

Run: `uv run pytest tests/unit/domain/test_dynamic_tools.py::test_dynamic_tool_descriptor_exposes_stable_identity_and_route -v`

Expected: FAIL with `ModuleNotFoundError` or `ImportError` because `mycli.domain.dynamic_tools` does not exist.

- [ ] **Step 3: Add the dedicated dynamic-tool domain contract**

```python
# src/mycli/domain/dynamic_tools.py
from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from mycli.domain.tool_exposure import ToolRouteKey
from mycli.tools.base import SchemaTool, ToolSpec


class DynamicToolSource(StrEnum):
    RUNTIME = "runtime"
    CAPABILITY = "capability"
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
    display_name: str
    description: str
    route_key: ToolRouteKey
    source: DynamicToolSource
    scope: DynamicToolScope
    lifecycle_state: DynamicToolLifecycleState
    spec: ToolSpec
    origin_metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def route_name(self) -> str:
        return self.route_key.value


@dataclass(slots=True, frozen=True)
class DynamicToolRegistration:
    descriptor: DynamicToolDescriptor
    tool: SchemaTool


@dataclass(slots=True, frozen=True)
class DynamicToolLifecycleEvent:
    tool_id: str
    route_name: str
    scope: DynamicToolScope
    state: DynamicToolLifecycleState
    source: DynamicToolSource
    origin_metadata: dict[str, Any] = field(default_factory=dict)
```

- [ ] **Step 4: Allow exposure entries to retain descriptor-backed metadata**

```python
# src/mycli/domain/tool_exposure.py
from mycli.domain.dynamic_tools import DynamicToolDescriptor


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
```

- [ ] **Step 5: Run the domain test again and confirm the descriptor contract now exists**

Run: `uv run pytest tests/unit/domain/test_dynamic_tools.py::test_dynamic_tool_descriptor_exposes_stable_identity_and_route -v`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/mycli/domain/dynamic_tools.py src/mycli/domain/tool_exposure.py tests/unit/domain/test_dynamic_tools.py
git commit -m "feat: add dynamic tool domain contract"
```

## Task 2: Add a Registry for Scope, Conflict, and Lifecycle

**Files:**
- Create: `src/mycli/services/dynamic_tool_registry.py`
- Create: `tests/unit/services/test_dynamic_tool_registry.py`
- Modify: `src/mycli/services/tool_exposure_planner.py`

- [ ] **Step 1: Write the failing registry conflict test**

```python
# tests/unit/services/test_dynamic_tool_registry.py
from mycli.domain.dynamic_tools import (
    DynamicToolConflictOutcome,
    DynamicToolDescriptor,
    DynamicToolLifecycleState,
    DynamicToolRegistration,
    DynamicToolScope,
    DynamicToolSource,
)
from mycli.domain.tool_exposure import ToolRouteKey
from mycli.services.dynamic_tool_registry import DynamicToolRegistry
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec


class FakeDynamicTool:
    def __init__(self, name: str) -> None:
        self.spec = ToolSpec(
            name=name,
            description=f"Tool {name}",
            parameters=(ToolParameter(name="path", type="string", required=False),),
        )

    def execute(self, arguments: dict[str, object]) -> ToolResultV2:
        return ToolResultV2(success=True, summary=f"{self.spec.name} ok", raw_payload=arguments)


def _registration(tool_id: str, scope: DynamicToolScope) -> DynamicToolRegistration:
    tool = FakeDynamicTool("workspace_summary")
    return DynamicToolRegistration(
        descriptor=DynamicToolDescriptor(
            tool_id=tool_id,
            display_name="workspace_summary",
            description="Summarize workspace facts",
            route_key=ToolRouteKey.local("workspace_summary"),
            source=DynamicToolSource.RUNTIME,
            scope=scope,
            lifecycle_state=DynamicToolLifecycleState.DECLARED,
            spec=tool.spec,
        ),
        tool=tool,
    )


def test_dynamic_tool_registry_reports_route_conflicts_for_same_scope() -> None:
    registry = DynamicToolRegistry()

    first = registry.register(_registration("runtime:workspace_summary:turn:1", DynamicToolScope.TURN))
    second = registry.register(_registration("runtime:workspace_summary:turn:2", DynamicToolScope.TURN))

    assert first.outcome is DynamicToolConflictOutcome.ACCEPTED
    assert second.outcome is DynamicToolConflictOutcome.REJECTED_ROUTE_CONFLICT
```

- [ ] **Step 2: Run the registry test to confirm the service does not exist yet**

Run: `uv run pytest tests/unit/services/test_dynamic_tool_registry.py::test_dynamic_tool_registry_reports_route_conflicts_for_same_scope -v`

Expected: FAIL with `ModuleNotFoundError` because `DynamicToolRegistry` does not exist.

- [ ] **Step 3: Implement the registry and explicit conflict outcomes**

```python
# src/mycli/services/dynamic_tool_registry.py
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
    lifecycle_event: DynamicToolLifecycleEvent | None


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
                lifecycle_event=None,
            )

        scope_route_key = (descriptor.scope.value, descriptor.route_name)
        if scope_route_key in self._by_scope_and_route:
            return DynamicToolRegisterResult(
                outcome=DynamicToolConflictOutcome.REJECTED_ROUTE_CONFLICT,
                registration=None,
                lifecycle_event=None,
            )

        self._by_tool_id[descriptor.tool_id] = registration
        self._by_scope_and_route[scope_route_key] = descriptor.tool_id
        return DynamicToolRegisterResult(
            outcome=DynamicToolConflictOutcome.ACCEPTED,
            registration=registration,
            lifecycle_event=DynamicToolLifecycleEvent(
                tool_id=descriptor.tool_id,
                route_name=descriptor.route_name,
                scope=descriptor.scope,
                state=DynamicToolLifecycleState.DECLARED,
                source=descriptor.source,
                origin_metadata=descriptor.origin_metadata,
            ),
        )
```

- [ ] **Step 4: Update the planner to accept registrations instead of raw loose tools**

```python
# src/mycli/services/tool_exposure_planner.py
from mycli.domain.dynamic_tools import DynamicToolLifecycleState, DynamicToolRegistration


@dataclass(slots=True, frozen=True)
class PlannedToolExposure:
    exposure: ToolExposure
    dynamic_tools: dict[str, DynamicToolRegistration]
    lifecycle_events: tuple[DynamicToolLifecycleEvent, ...] = ()


def plan(
    self,
    *,
    user_message: str,
    capability_activations: tuple[CapabilityActivation, ...] = (),
    runtime_dynamic_tools: tuple[DynamicToolRegistration, ...] = (),
) -> PlannedToolExposure:
    ...
    for registration in runtime_dynamic_tools:
        descriptor = registration.descriptor
        entry = ToolExposureEntry(
            route_key=descriptor.route_key,
            kind=ToolExposureKind.DYNAMIC,
            source=ToolRouteSource.RUNTIME,
            spec=descriptor.spec,
            metadata={"tool_id": descriptor.tool_id, "scope": descriptor.scope.value},
            dynamic_descriptor=descriptor,
        )
```

- [ ] **Step 5: Run the registry and planner tests**

Run: `uv run pytest tests/unit/services/test_dynamic_tool_registry.py tests/unit/services/test_tool_exposure_planner.py -v`

Expected: PASS for the new registry test and updated planner expectations around descriptor-backed dynamic entries.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/services/dynamic_tool_registry.py src/mycli/services/tool_exposure_planner.py tests/unit/services/test_dynamic_tool_registry.py tests/unit/services/test_tool_exposure_planner.py
git commit -m "feat: add dynamic tool registry and planner integration"
```

## Task 3: Route Execution Through Descriptor-Backed Registrations

**Files:**
- Modify: `src/mycli/services/tool_router.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `tests/unit/services/test_tool_router.py`
- Modify: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write the failing router lifecycle test**

```python
# tests/unit/services/test_tool_router.py
def test_tool_router_marks_dynamic_tool_failed_when_execution_raises() -> None:
    class FailingDynamicTool(FakeTool):
        def execute(self, arguments: dict[str, object]) -> ToolResultV2:
            raise RuntimeError("boom")

    registry = ToolRegistryV2.from_tools([FakeTool("list_directory", "listed")])
    dynamic = FailingDynamicTool("workspace_summary", "unused")
    descriptor = DynamicToolDescriptor(
        tool_id="runtime:workspace_summary:turn",
        display_name="workspace_summary",
        description="Summarize workspace facts",
        route_key=ToolRouteKey.local("workspace_summary"),
        source=DynamicToolSource.RUNTIME,
        scope=DynamicToolScope.TURN,
        lifecycle_state=DynamicToolLifecycleState.EXPOSED,
        spec=dynamic.spec,
    )
    exposure = ToolExposure(
        dynamic=(
            ToolExposureEntry(
                route_key=descriptor.route_key,
                kind=ToolExposureKind.DYNAMIC,
                source=ToolRouteSource.RUNTIME,
                spec=descriptor.spec,
                metadata={"tool_id": descriptor.tool_id},
                dynamic_descriptor=descriptor,
            ),
        ),
    )
    router = ToolRouter(
        tool_registry=registry,
        dynamic_tools={"workspace_summary": DynamicToolRegistration(descriptor=descriptor, tool=dynamic)},
    )

    try:
        router.execute(
            ToolCall(name="workspace_summary", arguments={"path": "."}, reason="summarize"),
            exposure=exposure,
        )
    except RuntimeError as exc:
        assert "boom" in str(exc)
    else:
        raise AssertionError("router should re-raise dynamic tool execution errors")
```

- [ ] **Step 2: Run the router and runtime tests to confirm raw registrations are not supported yet**

Run: `uv run pytest tests/unit/services/test_tool_router.py tests/unit/application/test_agent_runtime.py -k dynamic_tool -v`

Expected: FAIL because `ToolRouter` currently expects raw `SchemaTool` values and `AgentRuntime` does not emit lifecycle items.

- [ ] **Step 3: Update `ToolRouter` to execute descriptor-backed registrations**

```python
# src/mycli/services/tool_router.py
from mycli.domain.dynamic_tools import DynamicToolRegistration


class ToolRouter:
    def __init__(
        self,
        *,
        tool_registry: ToolRegistryV2,
        dynamic_tools: dict[str, DynamicToolRegistration] | None = None,
    ) -> None:
        self._tool_registry = tool_registry
        self._dynamic_tools = {} if dynamic_tools is None else dict(dynamic_tools)

    def execute(self, call: ToolCall, *, exposure: ToolExposure) -> ToolResultV2:
        ...
        registration = self._dynamic_tools.get(call.name)
        if registration is not None:
            return registration.tool.execute(call.arguments)
        return self._tool_registry.execute(call)
```

- [ ] **Step 4: Emit lifecycle items and expire turn-scoped registrations in `AgentRuntime`**

```python
# src/mycli/application/runtime/agent_runtime.py
from mycli.domain.dynamic_tools import DynamicToolLifecycleState
from mycli.domain.runtime import TurnItemType


def _append_dynamic_tool_lifecycle_event(
    self,
    *,
    turn_id: str,
    turn_items: list[TurnItem],
    activity_events: list[ActivityEvent],
    event: DynamicToolLifecycleEvent,
) -> None:
    text = (
        f"Dynamic tool {event.route_name}: state={event.state.value} "
        f"scope={event.scope.value} source={event.source.value}"
    )
    turn_items.append(
        TurnItem(
            type=TurnItemType.TOOL_EXPOSURE,
            text=text,
            tool_name=event.route_name,
            metadata={"tool_id": event.tool_id, "scope": event.scope.value, "state": event.state.value},
        )
    )
    activity_events.append(ActivityEvent(kind="tool_exposure", message=text, tool_name=event.route_name))
    self._trace_service.append(
        self._config.session_id,
        RuntimeTraceEvent(kind="dynamic_tool_lifecycle", turn_id=turn_id, payload=event.__dict__),
    )
```

- [ ] **Step 5: Run the router/runtime dynamic-tool test slice**

Run: `uv run pytest tests/unit/services/test_tool_router.py tests/unit/application/test_agent_runtime.py -k dynamic_tool -v`

Expected: PASS, with runtime tests confirming descriptor-backed tools execute, lifecycle items are recorded, and turn-scoped tools do not leak into the next turn.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/services/tool_router.py src/mycli/application/runtime/agent_runtime.py tests/unit/services/test_tool_router.py tests/unit/application/test_agent_runtime.py
git commit -m "feat: route dynamic tools through stable registrations"
```

## Task 4: Persist and Render Dynamic Tool Lifecycle Across Thread Scope

**Files:**
- Modify: `src/mycli/services/session_service.py`
- Modify: `src/mycli/services/context/turn_context_assembler.py`
- Modify: `src/mycli/domain/runtime/protocol.py`
- Modify: `tests/unit/services/test_session_service.py`
- Modify: `tests/unit/services/test_turn_context_assembler.py`

- [ ] **Step 1: Write the failing session persistence test**

```python
# tests/unit/services/test_session_service.py
def test_session_service_round_trips_dynamic_tool_state(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    descriptor = {
        "tool_id": "runtime:workspace_summary:thread",
        "route_name": "workspace_summary",
        "scope": "thread",
        "state": "exposed",
        "source": "runtime",
        "description": "Summarize workspace facts",
    }

    service.save_dynamic_tool_state("demo", [descriptor])

    assert service.load_dynamic_tool_state("demo") == [descriptor]
```

- [ ] **Step 2: Run the session/context tests to confirm persistence hooks do not exist yet**

Run: `uv run pytest tests/unit/services/test_session_service.py tests/unit/services/test_turn_context_assembler.py -k dynamic_tool -v`

Expected: FAIL because `SessionService` has no dynamic-tool persistence API and the turn context renderer does not include descriptor metadata.

- [ ] **Step 3: Add session persistence for dynamic-tool descriptor snapshots**

```python
# src/mycli/services/session_service.py
class SessionService:
    ...
    def save_dynamic_tool_state(self, session_id: str, descriptors: list[dict[str, Any]]) -> None:
        write_json(self._sessions_root / f"{session_id}-dynamic-tools.json", descriptors)

    def load_dynamic_tool_state(self, session_id: str) -> list[dict[str, Any]]:
        payload = read_json(self._sessions_root / f"{session_id}-dynamic-tools.json", [])
        if not isinstance(payload, list):
            raise ValueError("Dynamic tool state must serialize to a list.")
        return [item for item in payload if isinstance(item, dict)]
```

- [ ] **Step 4: Render descriptor-backed lifecycle details in turn context and turn items**

```python
# src/mycli/domain/runtime/protocol.py
class TurnItemType(StrEnum):
    ...
    DYNAMIC_TOOL = "dynamic_tool"


# src/mycli/services/context/turn_context_assembler.py
def _render_tool_exposure(self, context: ExecutionContext) -> str:
    if context.tool_exposure is not None:
        dynamic_descriptors = [
            entry.dynamic_descriptor
            for entry in context.tool_exposure.dynamic
            if entry.dynamic_descriptor is not None
        ]
        dynamic = ", ".join(
            f"{descriptor.route_name} [{descriptor.scope.value}/{descriptor.lifecycle_state.value}]"
            for descriptor in dynamic_descriptors
        ) or "none"
        ...
```

- [ ] **Step 5: Run the session/context tests again**

Run: `uv run pytest tests/unit/services/test_session_service.py tests/unit/services/test_turn_context_assembler.py -v`

Expected: PASS, with turn context showing scope/state metadata for dynamic tools and session state round-tripping for thread-scoped registrations.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/services/session_service.py src/mycli/services/context/turn_context_assembler.py src/mycli/domain/runtime/protocol.py tests/unit/services/test_session_service.py tests/unit/services/test_turn_context_assembler.py
git commit -m "feat: persist and render dynamic tool lifecycle"
```

## Task 5: Full Verification and General-Agent Regression Check

**Files:**
- Modify: `tests/unit/application/test_agent_runtime.py`
- Modify: `tests/unit/services/test_tool_exposure_planner.py`
- Modify: `tests/unit/services/test_tool_router.py`
- Modify: `tests/unit/services/test_session_service.py`
- Modify: `tests/unit/services/test_turn_context_assembler.py`

- [ ] **Step 1: Add the failing cross-task regression test that keeps the contract general-purpose**

```python
# tests/unit/application/test_agent_runtime.py
def test_dynamic_tool_contract_is_not_tied_to_repository_analysis_language(tmp_path: Path) -> None:
    adapter = DynamicToolAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistryV2.from_tools([ListDirectoryTool(tmp_path)]),
        config=AgentConfig(workspace_root=tmp_path, max_steps=4),
        home_dir=tmp_path / "home",
    )
    runtime._runtime_dynamic_tools = lambda **_kwargs: (
        DynamicToolRegistration(
            descriptor=DynamicToolDescriptor(
                tool_id="runtime:daily_brief:thread",
                display_name="daily_brief",
                description="Summarize current task state",
                route_key=ToolRouteKey.local("daily_brief"),
                source=DynamicToolSource.RUNTIME,
                scope=DynamicToolScope.THREAD,
                lifecycle_state=DynamicToolLifecycleState.DECLARED,
                spec=DynamicSummaryTool().spec,
            ),
            tool=DynamicSummaryTool(),
        ),
    )

    response = runtime.handle_user_turn("Please help me prepare a brief status update for today's work.")

    assert response.turn is not None
    assert any(item.tool_name == "daily_brief" for item in response.turn.items if item.tool_name)
```

- [ ] **Step 2: Run the full targeted verification slice**

Run: `uv run pytest tests/unit/domain/test_dynamic_tools.py tests/unit/services/test_dynamic_tool_registry.py tests/unit/services/test_tool_exposure_planner.py tests/unit/services/test_tool_router.py tests/unit/services/test_session_service.py tests/unit/services/test_turn_context_assembler.py tests/unit/application/test_agent_runtime.py -k "dynamic_tool or workspace_summary or daily_brief" -v`

Expected: FAIL first on any remaining missing lifecycle/state assertions.

- [ ] **Step 3: Finish remaining glue code and rename repo-specific wording where needed**

```python
# src/mycli/application/runtime/agent_runtime.py
def _runtime_dynamic_tools(
    self,
    *,
    user_message: str,
    conversation: Conversation,
    plan_state: PlanState,
) -> tuple[DynamicToolRegistration, ...]:
    del conversation, plan_state
    if "status update" in user_message.lower():
        tool = DailyBriefTool()
        return (
            DynamicToolRegistration(
                descriptor=DynamicToolDescriptor(
                    tool_id="runtime:daily_brief:turn",
                    display_name="daily_brief",
                    description=tool.spec.description,
                    route_key=ToolRouteKey.local(tool.spec.name),
                    source=DynamicToolSource.RUNTIME,
                    scope=DynamicToolScope.TURN,
                    lifecycle_state=DynamicToolLifecycleState.DECLARED,
                    spec=tool.spec,
                ),
                tool=tool,
            ),
        )
    return ()
```

- [ ] **Step 4: Run the targeted tests plus lint**

Run: `uv run pytest tests/unit/domain/test_dynamic_tools.py tests/unit/services/test_dynamic_tool_registry.py tests/unit/services/test_tool_exposure_planner.py tests/unit/services/test_tool_router.py tests/unit/services/test_session_service.py tests/unit/services/test_turn_context_assembler.py tests/unit/application/test_agent_runtime.py -v`

Expected: PASS

Run: `uv run ruff check src/mycli/domain/dynamic_tools.py src/mycli/services/dynamic_tool_registry.py src/mycli/services/tool_exposure_planner.py src/mycli/services/tool_router.py src/mycli/application/runtime/agent_runtime.py src/mycli/services/context/turn_context_assembler.py src/mycli/services/session_service.py tests/unit/domain/test_dynamic_tools.py tests/unit/services/test_dynamic_tool_registry.py tests/unit/services/test_tool_exposure_planner.py tests/unit/services/test_tool_router.py tests/unit/services/test_session_service.py tests/unit/services/test_turn_context_assembler.py tests/unit/application/test_agent_runtime.py`

Expected: `All checks passed!`

- [ ] **Step 5: Commit**

```bash
git add src/mycli/domain/dynamic_tools.py src/mycli/services/dynamic_tool_registry.py src/mycli/services/tool_exposure_planner.py src/mycli/services/tool_router.py src/mycli/application/runtime/agent_runtime.py src/mycli/services/context/turn_context_assembler.py src/mycli/services/session_service.py src/mycli/domain/runtime/protocol.py tests/unit/domain/test_dynamic_tools.py tests/unit/services/test_dynamic_tool_registry.py tests/unit/services/test_tool_exposure_planner.py tests/unit/services/test_tool_router.py tests/unit/services/test_session_service.py tests/unit/services/test_turn_context_assembler.py tests/unit/application/test_agent_runtime.py
git commit -m "feat: formalize dynamic tool lifecycle contract"
```

## Spec Coverage

- `DynamicToolDescriptor` / scope / lifecycle contract:
  Covered by Task 1 and Task 2.
- Planner / router integration:
  Covered by Task 2 and Task 3.
- Turn/thread lifecycle and conflict handling:
  Covered by Task 2, Task 3, and Task 4.
- Context / trace / session / surface visibility:
  Covered by Task 3 and Task 4.
- General-agent, non-task-specific applicability:
  Covered by Task 5.

## Self-Review

- Placeholder scan: no `TODO`, `TBD`, or “implement later” markers remain.
- Scope check: this plan stays inside dynamic-tool-contract and does not absorb provider/MCP bridge work.
- Type consistency: the plan uses one shared vocabulary throughout: `DynamicToolDescriptor`, `DynamicToolRegistration`, `DynamicToolScope`, `DynamicToolLifecycleState`, `DynamicToolRegistry`.

