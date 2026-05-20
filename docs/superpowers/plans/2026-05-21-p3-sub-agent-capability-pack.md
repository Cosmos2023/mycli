# P3 Sub-agent Capability Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sub-agents a safe in-process runtime capability exposed through a model-facing `Task` tool.

**Architecture:** Add small domain contracts, a conservative built-in profile catalog, a tool-scope resolver, and a `SubAgentService` that creates child runs with a strict tool subset and isolated child session id. Keep P3 synchronous and in-process; parent context receives only the final `Task` tool result while child lifecycle is visible through trace/activity surfaces.

**Tech Stack:** Python 3.13, dataclasses, existing `ToolRegistry`/`ApprovalService`/`TraceService`, pytest, ruff, mypy. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-21-p3-sub-agent-capability-pack.md`

---

## File Structure

- `src/mycli/domain/subagents.py`: immutable sub-agent profile, invocation, result, and run summary dataclasses.
- `src/mycli/application/runtime/subagents/__init__.py`: package exports.
- `src/mycli/application/runtime/subagents/profiles.py`: built-in `explore`, `review`, and `executor` profiles.
- `src/mycli/application/runtime/subagents/tool_scope.py`: child tool subset resolver.
- `src/mycli/application/runtime/subagents/service.py`: sub-agent orchestration, child session id generation, lifecycle trace, report normalization.
- `src/mycli/tools/task.py`: model-facing `Task` tool that delegates to `SubAgentService`.
- `src/mycli/tools/registry.py`: register a disabled/fallback `TaskTool` placeholder only when no runtime-bound service exists.
- `src/mycli/cli/bootstrap.py`: construct and register runtime-bound `TaskTool`.
- `src/mycli/application/runtime/agent_runtime.py`: construct `SubAgentService`, expose current tool scope to it, and keep parent transcript limited to `Task` result.
- `src/mycli/application/turn_service.py`: add `inspect_subagents()`.
- `src/mycli/cli/repl.py`: add `/subagents`.
- `tests/unit/domain/test_subagents.py`: domain contract tests.
- `tests/unit/application/runtime/subagents/test_profiles.py`: built-in profile tests.
- `tests/unit/application/runtime/subagents/test_tool_scope.py`: tool scope tests.
- `tests/unit/application/runtime/subagents/test_sub_agent_service.py`: service orchestration tests.
- `tests/unit/tools/test_task_tool.py`: Task tool tests.
- `tests/unit/application/test_agent_runtime.py`: runtime registration and parent transcript tests.
- `tests/unit/cli/test_main.py`: `/subagents` command tests.
- `docs/superpowers/reports/2026-05-21-p3-sub-agent-capability-pack-smoke.md`: final verification and real smoke report.

---

### Task 1: Domain Contracts And Built-in Profiles

**Files:**
- Create: `src/mycli/domain/subagents.py`
- Create: `src/mycli/application/runtime/subagents/__init__.py`
- Create: `src/mycli/application/runtime/subagents/profiles.py`
- Create: `tests/unit/domain/test_subagents.py`
- Create: `tests/unit/application/runtime/subagents/test_profiles.py`

- [ ] **Step 1: Write failing domain tests**

Create `tests/unit/domain/test_subagents.py`:

```python
from __future__ import annotations

import pytest

from mycli.domain.subagents import (
    SubAgentInvocation,
    SubAgentProfile,
    SubAgentResult,
    SubAgentRunSummary,
)


def test_sub_agent_profile_requires_name_and_tools() -> None:
    profile = SubAgentProfile(
        name="explore",
        system_prompt="Inspect only.",
        default_tools=("Read", "Grep", "LS"),
        max_tool_calls=8,
    )

    assert profile.name == "explore"
    assert profile.default_tools == ("Read", "Grep", "LS")
    assert profile.max_tool_calls == 8


def test_sub_agent_profile_rejects_blank_name() -> None:
    with pytest.raises(ValueError, match="name"):
        SubAgentProfile(name=" ", system_prompt="x", default_tools=("Read",))


def test_sub_agent_invocation_normalizes_allowed_tools() -> None:
    invocation = SubAgentInvocation(
        agent_type="explore",
        description="Find entrypoints",
        allowed_tools=("Grep", "Read", "Read"),
        parent_session_id="demo",
        parent_turn_id="turn_1",
    )

    assert invocation.allowed_tools == ("Grep", "Read")


def test_sub_agent_result_and_summary_are_stable() -> None:
    result = SubAgentResult(
        status="completed",
        report="Found files.",
        child_session_id="demo:sub:turn_1:abcd",
        tool_calls=2,
    )
    summary = SubAgentRunSummary.from_result(
        invocation=SubAgentInvocation(
            agent_type="explore",
            description="Find files",
            allowed_tools=("Read",),
            parent_session_id="demo",
            parent_turn_id="turn_1",
        ),
        result=result,
    )

    assert summary.agent_type == "explore"
    assert summary.status == "completed"
    assert summary.child_session_id == "demo:sub:turn_1:abcd"
```

- [ ] **Step 2: Run domain tests to verify failure**

Run:

```bash
uv run pytest tests/unit/domain/test_subagents.py -q
```

Expected: fails because `mycli.domain.subagents` does not exist.

- [ ] **Step 3: Implement domain contracts**

Create `src/mycli/domain/subagents.py`:

```python
from __future__ import annotations

from dataclasses import dataclass


def _require_non_blank(value: str, field_name: str) -> str:
    stripped = value.strip()
    if not stripped:
        raise ValueError(f"Sub-agent {field_name} cannot be blank.")
    return stripped


def _unique_tools(tools: tuple[str, ...]) -> tuple[str, ...]:
    unique = tuple(dict.fromkeys(tool for tool in tools if tool.strip()))
    if not unique:
        raise ValueError("Sub-agent requires at least one tool.")
    return unique


@dataclass(slots=True, frozen=True)
class SubAgentProfile:
    name: str
    system_prompt: str
    default_tools: tuple[str, ...]
    max_tool_calls: int = 25

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", _require_non_blank(self.name, "name"))
        object.__setattr__(
            self,
            "system_prompt",
            _require_non_blank(self.system_prompt, "system_prompt"),
        )
        object.__setattr__(self, "default_tools", _unique_tools(self.default_tools))
        if self.max_tool_calls <= 0:
            raise ValueError("Sub-agent max_tool_calls must be positive.")


@dataclass(slots=True, frozen=True)
class SubAgentInvocation:
    agent_type: str
    description: str
    allowed_tools: tuple[str, ...]
    parent_session_id: str
    parent_turn_id: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "agent_type", _require_non_blank(self.agent_type, "agent_type"))
        object.__setattr__(
            self,
            "description",
            _require_non_blank(self.description, "description"),
        )
        object.__setattr__(self, "allowed_tools", _unique_tools(self.allowed_tools))
        object.__setattr__(
            self,
            "parent_session_id",
            _require_non_blank(self.parent_session_id, "parent_session_id"),
        )
        object.__setattr__(
            self,
            "parent_turn_id",
            _require_non_blank(self.parent_turn_id, "parent_turn_id"),
        )


@dataclass(slots=True, frozen=True)
class SubAgentResult:
    status: str
    report: str
    child_session_id: str
    tool_calls: int
    error: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "status", _require_non_blank(self.status, "status"))
        object.__setattr__(
            self,
            "child_session_id",
            _require_non_blank(self.child_session_id, "child_session_id"),
        )
        if self.tool_calls < 0:
            raise ValueError("Sub-agent tool_calls cannot be negative.")


@dataclass(slots=True, frozen=True)
class SubAgentRunSummary:
    agent_type: str
    description: str
    status: str
    child_session_id: str
    tool_calls: int

    @classmethod
    def from_result(
        cls,
        *,
        invocation: SubAgentInvocation,
        result: SubAgentResult,
    ) -> SubAgentRunSummary:
        return cls(
            agent_type=invocation.agent_type,
            description=invocation.description,
            status=result.status,
            child_session_id=result.child_session_id,
            tool_calls=result.tool_calls,
        )


__all__ = [
    "SubAgentInvocation",
    "SubAgentProfile",
    "SubAgentResult",
    "SubAgentRunSummary",
]
```

- [ ] **Step 4: Write failing profile tests**

Create `tests/unit/application/runtime/subagents/test_profiles.py`:

```python
from mycli.application.runtime.subagents.profiles import get_sub_agent_profile, list_sub_agent_profiles


def test_builtin_sub_agent_profiles_are_conservative() -> None:
    names = [profile.name for profile in list_sub_agent_profiles()]

    assert names == ["executor", "explore", "review"]
    assert get_sub_agent_profile("explore").default_tools == ("Read", "Grep", "Glob", "LS")
    assert "Bash" not in get_sub_agent_profile("review").default_tools


def test_get_sub_agent_profile_rejects_unknown_profile() -> None:
    assert get_sub_agent_profile("missing") is None
```

- [ ] **Step 5: Run profile tests to verify failure**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_profiles.py -q
```

Expected: fails because profile module does not exist.

- [ ] **Step 6: Implement built-in profiles**

Create `src/mycli/application/runtime/subagents/__init__.py`:

```python
"""Sub-agent runtime support."""
```

Create `src/mycli/application/runtime/subagents/profiles.py`:

```python
from __future__ import annotations

from mycli.domain.subagents import SubAgentProfile


_PROFILES: dict[str, SubAgentProfile] = {
    "explore": SubAgentProfile(
        name="explore",
        system_prompt=(
            "You are a read-only exploration sub-agent. Map files, symbols, and "
            "evidence. Do not modify files."
        ),
        default_tools=("Read", "Grep", "Glob", "LS"),
        max_tool_calls=12,
    ),
    "review": SubAgentProfile(
        name="review",
        system_prompt=(
            "You are a code review sub-agent. Prioritize correctness, security, "
            "and test gaps. Return concrete findings with file references."
        ),
        default_tools=("Read", "Grep", "Glob", "LS", "Lint"),
        max_tool_calls=16,
    ),
    "executor": SubAgentProfile(
        name="executor",
        system_prompt=(
            "You are an implementation sub-agent. Keep edits scoped to the assigned "
            "task and report changed files."
        ),
        default_tools=("Read", "Grep", "Glob", "LS", "Edit", "Write", "Bash"),
        max_tool_calls=20,
    ),
}


def list_sub_agent_profiles() -> tuple[SubAgentProfile, ...]:
    return tuple(_PROFILES[name] for name in sorted(_PROFILES))


def get_sub_agent_profile(name: str) -> SubAgentProfile | None:
    return _PROFILES.get(name)


__all__ = ["get_sub_agent_profile", "list_sub_agent_profiles"]
```

- [ ] **Step 7: Run Task 1 tests**

Run:

```bash
uv run pytest tests/unit/domain/test_subagents.py tests/unit/application/runtime/subagents/test_profiles.py -q
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/mycli/domain/subagents.py src/mycli/application/runtime/subagents/__init__.py src/mycli/application/runtime/subagents/profiles.py tests/unit/domain/test_subagents.py tests/unit/application/runtime/subagents/test_profiles.py
git commit -m "Define sub-agent contracts and profiles" -m "Add immutable sub-agent invocation/result contracts and conservative built-in profiles for explore, review, and executor child agents." -m "Constraint: P3 supports only synchronous in-process child agents; team/worktree/remote agents remain out of scope." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: uv run pytest tests/unit/domain/test_subagents.py tests/unit/application/runtime/subagents/test_profiles.py -q"
```

---

### Task 2: Child Tool Scope Resolver

**Files:**
- Create: `src/mycli/application/runtime/subagents/tool_scope.py`
- Create: `tests/unit/application/runtime/subagents/test_tool_scope.py`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/application/runtime/subagents/test_tool_scope.py`:

```python
from mycli.application.runtime.subagents.profiles import get_sub_agent_profile
from mycli.application.runtime.subagents.tool_scope import resolve_sub_agent_tool_scope


def test_tool_scope_is_intersection_of_parent_request_and_profile() -> None:
    profile = get_sub_agent_profile("explore")
    assert profile is not None

    resolved = resolve_sub_agent_tool_scope(
        parent_tool_names=("Read", "Grep", "Edit", "Bash"),
        requested_tool_names=("Read", "Edit", "Bash"),
        profile=profile,
    )

    assert resolved.allowed_tool_names == ("Read",)
    assert resolved.denied_tool_names == ("Bash", "Edit")


def test_tool_scope_blocks_high_risk_tools_without_explicit_profile_support() -> None:
    profile = get_sub_agent_profile("review")
    assert profile is not None

    resolved = resolve_sub_agent_tool_scope(
        parent_tool_names=("Read", "Bash", "Lint"),
        requested_tool_names=("Read", "Bash", "Lint"),
        profile=profile,
    )

    assert resolved.allowed_tool_names == ("Read", "Lint")
    assert resolved.denied_tool_names == ("Bash",)


def test_tool_scope_reports_empty_result() -> None:
    profile = get_sub_agent_profile("explore")
    assert profile is not None

    resolved = resolve_sub_agent_tool_scope(
        parent_tool_names=("Edit",),
        requested_tool_names=("Edit",),
        profile=profile,
    )

    assert resolved.allowed_tool_names == ()
    assert resolved.denied_tool_names == ("Edit",)
    assert resolved.error == "No tools remain after applying sub-agent scope."
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_tool_scope.py -q
```

Expected: fails because `tool_scope.py` does not exist.

- [ ] **Step 3: Implement resolver**

Create `src/mycli/application/runtime/subagents/tool_scope.py`:

```python
from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.subagents import SubAgentProfile


@dataclass(slots=True, frozen=True)
class SubAgentToolScope:
    allowed_tool_names: tuple[str, ...]
    denied_tool_names: tuple[str, ...]
    error: str | None = None


def resolve_sub_agent_tool_scope(
    *,
    parent_tool_names: tuple[str, ...],
    requested_tool_names: tuple[str, ...],
    profile: SubAgentProfile,
) -> SubAgentToolScope:
    parent = set(parent_tool_names)
    requested = tuple(dict.fromkeys(requested_tool_names))
    profile_tools = set(profile.default_tools)
    allowed = tuple(
        tool_name
        for tool_name in requested
        if tool_name in parent and tool_name in profile_tools
    )
    denied = tuple(tool_name for tool_name in requested if tool_name not in allowed)
    if not allowed:
        return SubAgentToolScope(
            allowed_tool_names=(),
            denied_tool_names=denied,
            error="No tools remain after applying sub-agent scope.",
        )
    return SubAgentToolScope(allowed_tool_names=allowed, denied_tool_names=denied)


__all__ = ["SubAgentToolScope", "resolve_sub_agent_tool_scope"]
```

- [ ] **Step 4: Run tests**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_tool_scope.py -q
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/subagents/tool_scope.py tests/unit/application/runtime/subagents/test_tool_scope.py
git commit -m "Constrain sub-agent tool scopes" -m "Resolve child-agent tools as the intersection of parent exposure, requested tools, and built-in profile defaults." -m "Constraint: P3 prevents tool amplification but does not add OS sandboxing or nested approval UI." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: uv run pytest tests/unit/application/runtime/subagents/test_tool_scope.py -q"
```

---

### Task 3: SubAgentService Orchestration

**Files:**
- Create: `src/mycli/application/runtime/subagents/service.py`
- Create: `tests/unit/application/runtime/subagents/test_sub_agent_service.py`

- [ ] **Step 1: Write failing service tests**

Create `tests/unit/application/runtime/subagents/test_sub_agent_service.py`:

```python
from __future__ import annotations

from mycli.application.runtime.subagents.service import SubAgentService
from mycli.domain.subagents import SubAgentInvocation, SubAgentResult


class FakeRunner:
    def __init__(self) -> None:
        self.seen: list[dict[str, object]] = []

    def run_child(self, **kwargs: object) -> SubAgentResult:
        self.seen.append(dict(kwargs))
        return SubAgentResult(
            status="completed",
            report="Child report.",
            child_session_id=str(kwargs["child_session_id"]),
            tool_calls=2,
        )


class FakeTrace:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, object]]] = []

    def append(self, session_id: str, event) -> None:
        self.events.append((session_id, dict(event.payload)))


def test_sub_agent_service_invokes_child_with_scoped_tools() -> None:
    runner = FakeRunner()
    trace = FakeTrace()
    service = SubAgentService(
        parent_session_id="demo",
        parent_turn_id="turn_1",
        parent_tool_names=("Read", "Grep", "Edit"),
        trace_service=trace,  # type: ignore[arg-type]
        child_runner=runner.run_child,
        child_id_provider=lambda: "abcd",
    )

    result = service.invoke(
        SubAgentInvocation(
            agent_type="explore",
            description="Find entrypoints",
            allowed_tools=("Read", "Edit"),
            parent_session_id="demo",
            parent_turn_id="turn_1",
        )
    )

    assert result.status == "completed"
    assert result.child_session_id == "demo:sub:turn_1:abcd"
    assert runner.seen[0]["allowed_tool_names"] == ("Read",)
    assert trace.events[0][1]["event"] == "started"
    assert trace.events[-1][1]["event"] == "completed"


def test_sub_agent_service_rejects_unknown_profile() -> None:
    service = SubAgentService(
        parent_session_id="demo",
        parent_turn_id="turn_1",
        parent_tool_names=("Read",),
        trace_service=FakeTrace(),  # type: ignore[arg-type]
        child_runner=lambda **_: SubAgentResult(
            status="completed",
            report="unused",
            child_session_id="unused",
            tool_calls=0,
        ),
        child_id_provider=lambda: "abcd",
    )

    result = service.invoke(
        SubAgentInvocation(
            agent_type="missing",
            description="Find entrypoints",
            allowed_tools=("Read",),
            parent_session_id="demo",
            parent_turn_id="turn_1",
        )
    )

    assert result.status == "failed"
    assert result.error == "Unknown sub-agent profile: missing"
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_sub_agent_service.py -q
```

Expected: fails because service does not exist.

- [ ] **Step 3: Implement service**

Create `src/mycli/application/runtime/subagents/service.py`:

```python
from __future__ import annotations

from collections.abc import Callable
from uuid import uuid4

from mycli.application.runtime.subagents.profiles import get_sub_agent_profile
from mycli.application.runtime.subagents.tool_scope import resolve_sub_agent_tool_scope
from mycli.domain.runtime.tracing import RuntimeTraceEvent
from mycli.domain.subagents import SubAgentInvocation, SubAgentResult, SubAgentRunSummary
from mycli.services.tracing import TraceService


ChildRunner = Callable[..., SubAgentResult]


class SubAgentService:
    def __init__(
        self,
        *,
        parent_session_id: str,
        parent_turn_id: str,
        parent_tool_names: tuple[str, ...],
        trace_service: TraceService,
        child_runner: ChildRunner,
        child_id_provider: Callable[[], str] | None = None,
    ) -> None:
        self._parent_session_id = parent_session_id
        self._parent_turn_id = parent_turn_id
        self._parent_tool_names = parent_tool_names
        self._trace_service = trace_service
        self._child_runner = child_runner
        self._child_id_provider = child_id_provider or (lambda: uuid4().hex[:8])
        self._runs: list[SubAgentRunSummary] = []

    def invoke(self, invocation: SubAgentInvocation) -> SubAgentResult:
        profile = get_sub_agent_profile(invocation.agent_type)
        if profile is None:
            return self._failed(invocation, f"Unknown sub-agent profile: {invocation.agent_type}")

        scope = resolve_sub_agent_tool_scope(
            parent_tool_names=self._parent_tool_names,
            requested_tool_names=invocation.allowed_tools,
            profile=profile,
        )
        child_session_id = self._child_session_id()
        self._trace(invocation, child_session_id=child_session_id, event="started")
        self._trace(
            invocation,
            child_session_id=child_session_id,
            event="tool_scope_resolved",
            allowed_tools=scope.allowed_tool_names,
            denied_tools=scope.denied_tool_names,
        )
        if scope.error is not None:
            return self._failed(invocation, scope.error, child_session_id=child_session_id)

        try:
            result = self._child_runner(
                invocation=invocation,
                profile=profile,
                child_session_id=child_session_id,
                allowed_tool_names=scope.allowed_tool_names,
            )
        except Exception as exc:  # noqa: BLE001 - child failures become Task reports.
            return self._failed(invocation, str(exc), child_session_id=child_session_id)

        self._runs.append(SubAgentRunSummary.from_result(invocation=invocation, result=result))
        self._trace(
            invocation,
            child_session_id=result.child_session_id,
            event=result.status,
            tool_calls=result.tool_calls,
        )
        return result

    def list_runs(self) -> tuple[SubAgentRunSummary, ...]:
        return tuple(self._runs)

    def _failed(
        self,
        invocation: SubAgentInvocation,
        error: str,
        *,
        child_session_id: str | None = None,
    ) -> SubAgentResult:
        result = SubAgentResult(
            status="failed",
            report=f"Sub-agent failed: {error}",
            child_session_id=child_session_id or self._child_session_id(),
            tool_calls=0,
            error=error,
        )
        self._runs.append(SubAgentRunSummary.from_result(invocation=invocation, result=result))
        self._trace(
            invocation,
            child_session_id=result.child_session_id,
            event="failed",
            error=error,
        )
        return result

    def _child_session_id(self) -> str:
        return (
            f"{self._parent_session_id}:sub:"
            f"{self._parent_turn_id}:{self._child_id_provider()}"
        )

    def _trace(
        self,
        invocation: SubAgentInvocation,
        *,
        child_session_id: str,
        event: str,
        **payload: object,
    ) -> None:
        self._trace_service.append(
            self._parent_session_id,
            RuntimeTraceEvent(
                kind="sub_agent",
                turn_id=self._parent_turn_id,
                payload={
                    "event": event,
                    "agent_type": invocation.agent_type,
                    "description": invocation.description,
                    "child_session_id": child_session_id,
                    **payload,
                },
            ),
        )


__all__ = ["ChildRunner", "SubAgentService"]
```

- [ ] **Step 4: Run tests**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_sub_agent_service.py -q
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/subagents/service.py tests/unit/application/runtime/subagents/test_sub_agent_service.py
git commit -m "Orchestrate scoped sub-agent runs" -m "Add SubAgentService to resolve profiles and tool scopes, emit lifecycle trace events, and normalize child results into parent-visible summaries." -m "Constraint: Child agents are synchronous in-process runs and nested approval remains deferred." -m "Confidence: medium" -m "Scope-risk: moderate" -m "Tested: uv run pytest tests/unit/application/runtime/subagents/test_sub_agent_service.py -q"
```

---

### Task 4: Model-facing `Task` Tool

**Files:**
- Create: `src/mycli/tools/task.py`
- Create: `tests/unit/tools/test_task_tool.py`
- Modify: `src/mycli/tools/registry.py`
- Modify: `tests/integration/test_toolset_smoke.py`

- [ ] **Step 1: Write failing TaskTool tests**

Create `tests/unit/tools/test_task_tool.py`:

```python
from __future__ import annotations

from mycli.domain.subagents import SubAgentResult
from mycli.tools.task import TaskTool


class FakeSubAgentService:
    def __init__(self) -> None:
        self.invocations = []

    def invoke(self, invocation):
        self.invocations.append(invocation)
        return SubAgentResult(
            status="completed",
            report="Found entrypoints.",
            child_session_id="demo:sub:turn_1:abcd",
            tool_calls=3,
        )


def test_task_tool_invokes_sub_agent_service() -> None:
    service = FakeSubAgentService()
    tool = TaskTool(
        sub_agent_service=service,  # type: ignore[arg-type]
        parent_session_id="demo",
        parent_turn_id="turn_1",
    )

    result = tool.execute(
        {
            "agent_type": "explore",
            "description": "Find entrypoints",
            "allowed_tools": ["Read", "Grep"],
        }
    )

    assert result.success is True
    assert result.summary == "Sub-agent explore completed"
    assert result.raw_payload["child_session_id"] == "demo:sub:turn_1:abcd"
    assert "Found entrypoints." in result.raw_payload["report"]
    assert service.invocations[0].allowed_tools == ("Read", "Grep")


def test_task_tool_requires_bound_service() -> None:
    result = TaskTool().execute({"description": "Find entrypoints"})

    assert result.success is False
    assert result.raw_payload["error_kind"] == "sub_agent_service_unavailable"
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/tools/test_task_tool.py -q
```

Expected: fails because `TaskTool` does not exist.

- [ ] **Step 3: Implement TaskTool**

Create `src/mycli/tools/task.py`:

```python
from __future__ import annotations

from typing import Any

from mycli.domain.subagents import SubAgentInvocation
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec


class TaskTool:
    name = "Task"
    spec = ToolSpec(
        name="Task",
        description="Run a bounded sub-agent task and return only the final report.",
        parameters=(
            ToolParameter(name="description", type="string", required=True),
            ToolParameter(name="agent_type", type="string", required=False),
            ToolParameter(
                name="allowed_tools",
                type="array",
                required=False,
                items_schema={"type": "string"},
            ),
        ),
        risk_level="medium",
    )

    def __init__(
        self,
        *,
        sub_agent_service: object | None = None,
        parent_session_id: str = "",
        parent_turn_id: str = "",
    ) -> None:
        self._sub_agent_service = sub_agent_service
        self._parent_session_id = parent_session_id
        self._parent_turn_id = parent_turn_id

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        if self._sub_agent_service is None:
            return ToolResult(
                success=False,
                summary="Sub-agent service unavailable",
                error="Task tool is not bound to a runtime sub-agent service.",
                raw_payload={"error_kind": "sub_agent_service_unavailable"},
            )
        description = arguments.get("description")
        if not isinstance(description, str) or not description.strip():
            return ToolResult(
                success=False,
                summary="Invalid sub-agent task",
                error="Task requires description.",
                raw_payload={"error_kind": "invalid_task_description"},
            )
        agent_type = arguments.get("agent_type")
        raw_allowed_tools = arguments.get("allowed_tools", ["Read", "Grep", "Glob", "LS"])
        allowed_tools = tuple(
            item
            for item in raw_allowed_tools
            if isinstance(raw_allowed_tools, list) and isinstance(item, str)
        )
        invocation = SubAgentInvocation(
            agent_type=agent_type if isinstance(agent_type, str) and agent_type else "explore",
            description=description,
            allowed_tools=allowed_tools or ("Read",),
            parent_session_id=self._parent_session_id or "unknown",
            parent_turn_id=self._parent_turn_id or "turn",
        )
        result = self._sub_agent_service.invoke(invocation)  # type: ignore[attr-defined]
        success = result.status == "completed"
        return ToolResult(
            success=success,
            summary=f"Sub-agent {invocation.agent_type} {result.status}",
            error=result.error,
            raw_payload={
                "kind": "sub_agent_report",
                "agent_type": invocation.agent_type,
                "status": result.status,
                "report": result.report,
                "child_session_id": result.child_session_id,
                "tool_calls": result.tool_calls,
                "error": result.error,
            },
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)
```

- [ ] **Step 4: Register fallback Task tool**

Modify `src/mycli/tools/registry.py` inside `default_tools()` imports:

```python
    from mycli.tools.task import TaskTool
```

Add `TaskTool()` after `PlanTool()` in the default list.

Modify `tests/integration/test_toolset_smoke.py`:

```python
from mycli.tools.task import TaskTool
```

Add `TaskTool` to the importable tuple and `"Task"` to the expected registered tool set.

- [ ] **Step 5: Run TaskTool tests**

Run:

```bash
uv run pytest tests/unit/tools/test_task_tool.py tests/integration/test_toolset_smoke.py -q
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/tools/task.py src/mycli/tools/registry.py tests/unit/tools/test_task_tool.py tests/integration/test_toolset_smoke.py
git commit -m "Expose Task tool for sub-agent calls" -m "Add a model-facing Task tool that delegates to a runtime-bound SubAgentService and returns only the final child report." -m "Constraint: The default registry exposes a safe unavailable fallback until runtime binds a real service." -m "Confidence: medium" -m "Scope-risk: moderate" -m "Tested: uv run pytest tests/unit/tools/test_task_tool.py tests/integration/test_toolset_smoke.py -q"
```

---

### Task 5: Runtime-bound SubAgentService And Parent Transcript Isolation

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/cli/bootstrap.py`
- Modify: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write failing runtime registration test**

Append to `tests/unit/application/test_agent_runtime.py`:

```python
def test_agent_runtime_registers_bound_task_tool(tmp_path: Path) -> None:
    runtime = build_runtime(tmp_path)

    task_tool = runtime._tool_registry.executors["Task"]

    assert task_tool._sub_agent_service is not None
    assert task_tool._parent_session_id == runtime._config.session_id
```

If this test file uses a different helper than `build_runtime(tmp_path)`, use the existing runtime construction helper from nearby tests.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime.py::test_agent_runtime_registers_bound_task_tool -q
```

Expected: fails because runtime does not bind `TaskTool`.

- [ ] **Step 3: Add runtime child runner boundary**

In `src/mycli/application/runtime/agent_runtime.py`, add a private method:

```python
    def _run_child_sub_agent(
        self,
        *,
        invocation,
        profile,
        child_session_id: str,
        allowed_tool_names: tuple[str, ...],
    ):
        from mycli.domain.subagents import SubAgentResult

        # P3 minimal runner: create a bounded report from current repository/runtime state.
        # Later tasks can replace this with a full nested AgentRuntime turn.
        report = (
            f"{profile.name} sub-agent accepted task: {invocation.description}\n"
            f"Allowed tools: {', '.join(allowed_tool_names)}"
        )
        return SubAgentResult(
            status="completed",
            report=report,
            child_session_id=child_session_id,
            tool_calls=0,
        )
```

This minimal runner is intentional for Task 5. Task 6 adds real child model turn execution.

- [ ] **Step 4: Bind SubAgentService and TaskTool**

In `AgentRuntime.__init__`, after tool registry is available:

```python
from mycli.application.runtime.subagents.service import SubAgentService
from mycli.tools.task import TaskTool

self._sub_agent_service = SubAgentService(
    parent_session_id=self._config.session_id,
    parent_turn_id="runtime",
    parent_tool_names=tuple(self._tool_registry.list_names()),
    trace_service=self._trace_service,
    child_runner=self._run_child_sub_agent,
)
self._tool_registry.register(
    TaskTool(
        sub_agent_service=self._sub_agent_service,
        parent_session_id=self._config.session_id,
        parent_turn_id="runtime",
    )
)
```

In `rebind_session()`, update/re-register `TaskTool` with the new session id.

- [ ] **Step 5: Run runtime registration test**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime.py::test_agent_runtime_registers_bound_task_tool -q
```

Expected: pass.

- [ ] **Step 6: Add parent transcript isolation test**

Append to `tests/unit/application/test_agent_runtime.py`:

```python
def test_agent_runtime_task_tool_returns_only_sub_agent_report(tmp_path: Path) -> None:
    runtime = build_runtime(tmp_path)
    task_tool = runtime._tool_registry.executors["Task"]

    result = task_tool.execute(
        {
            "agent_type": "explore",
            "description": "Find source files",
            "allowed_tools": ["Read", "Grep"],
        }
    )

    assert result.success is True
    assert result.raw_payload["kind"] == "sub_agent_report"
    assert "Find source files" in result.raw_payload["report"]
    assert "tool_result" not in result.raw_payload["report"]
```

- [ ] **Step 7: Run runtime tests**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime.py::test_agent_runtime_registers_bound_task_tool tests/unit/application/test_agent_runtime.py::test_agent_runtime_task_tool_returns_only_sub_agent_report -q
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/mycli/application/runtime/agent_runtime.py src/mycli/cli/bootstrap.py tests/unit/application/test_agent_runtime.py
git commit -m "Bind Task tool to runtime sub-agent service" -m "Wire a runtime-owned SubAgentService into Task so parent sessions receive only final child reports with scoped tool metadata." -m "Constraint: This task uses a minimal in-process child runner; full nested model turns are added separately." -m "Confidence: medium" -m "Scope-risk: moderate" -m "Tested: targeted AgentRuntime Task tool tests"
```

---

### Task 6: Child Model Turn Execution

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write failing child execution test**

Append to `tests/unit/application/test_agent_runtime.py`:

```python
def test_agent_runtime_task_tool_runs_child_model_turn_with_scoped_tools(tmp_path: Path) -> None:
    runtime = build_runtime(tmp_path)
    runtime._model_adapter.queue_text_response("Child inspected files.")
    task_tool = runtime._tool_registry.executors["Task"]

    result = task_tool.execute(
        {
            "agent_type": "explore",
            "description": "Inspect README only",
            "allowed_tools": ["Read"],
        }
    )

    assert result.success is True
    assert result.raw_payload["status"] == "completed"
    assert result.raw_payload["report"] == "Child inspected files."
    child_tools = runtime._model_adapter.seen_tool_names[-1]
    assert child_tools == ("Read",)
```

Adapt `queue_text_response` / `seen_tool_names` names to the local fake model adapter helper in `test_agent_runtime.py`. If the helper does not expose them, extend the fake in the test file only.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime.py::test_agent_runtime_task_tool_runs_child_model_turn_with_scoped_tools -q
```

Expected: fails because `_run_child_sub_agent()` returns a static report.

- [ ] **Step 3: Implement child turn execution**

Replace `_run_child_sub_agent()` with:

```python
    def _run_child_sub_agent(
        self,
        *,
        invocation,
        profile,
        child_session_id: str,
        allowed_tool_names: tuple[str, ...],
    ):
        from mycli.domain.runtime import RuntimeBlock, RuntimeItem
        from mycli.domain.subagents import SubAgentResult

        runtime_items = [
            RuntimeItem(
                role="system",
                blocks=(RuntimeBlock(type="text", text=profile.system_prompt),),
            ),
            RuntimeItem(
                role="user",
                blocks=(RuntimeBlock(type="text", text=invocation.description),),
            ),
        ]
        tools = self._tool_registry.render_for_model(allowed_tool_names)
        turn_result, streamed_chunks = self._model_turn_requester.request_model_turn(
            runtime_items=runtime_items,
            legacy_messages=[],
            tools=tools,
        )
        text_parts = [
            block.text or ""
            for item in turn_result.items
            for block in item.blocks
            if block.type == "text" and block.text
        ]
        report = "".join(text_parts).strip() or "".join(streamed_chunks).strip()
        if not report:
            report = "Sub-agent completed without a text report."
        return SubAgentResult(
            status="completed",
            report=self._truncate_sub_agent_report(report),
            child_session_id=child_session_id,
            tool_calls=sum(
                1
                for item in turn_result.items
                for block in item.blocks
                if block.type == "tool_call"
            ),
        )
```

Add helper:

```python
    def _truncate_sub_agent_report(self, report: str, limit: int = 6000) -> str:
        if len(report) <= limit:
            return report
        omitted = len(report) - limit
        return f"{report[:limit]}\n... [{omitted} chars omitted from sub-agent report]"
```

- [ ] **Step 4: Run child execution test**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime.py::test_agent_runtime_task_tool_runs_child_model_turn_with_scoped_tools -q
```

Expected: pass.

- [ ] **Step 5: Add report truncation test**

Append:

```python
def test_agent_runtime_truncates_sub_agent_report(tmp_path: Path) -> None:
    runtime = build_runtime(tmp_path)
    report = "x" * 7000

    truncated = runtime._truncate_sub_agent_report(report, limit=100)

    assert len(truncated) < 200
    assert "chars omitted from sub-agent report" in truncated
```

- [ ] **Step 6: Run runtime sub-agent tests**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime.py::test_agent_runtime_task_tool_runs_child_model_turn_with_scoped_tools tests/unit/application/test_agent_runtime.py::test_agent_runtime_truncates_sub_agent_report -q
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/mycli/application/runtime/agent_runtime.py tests/unit/application/test_agent_runtime.py
git commit -m "Run scoped child model turns for Task" -m "Execute Task sub-agent requests through the existing model turn requester with the resolved child tool subset and truncate final reports before returning to the parent context." -m "Constraint: Child turns are synchronous and execute one model turn; multi-turn child loops and nested approval are deferred." -m "Confidence: medium" -m "Scope-risk: moderate" -m "Tested: targeted AgentRuntime child turn tests"
```

---

### Task 7: `/subagents` Inspection

**Files:**
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/cli/repl.py`
- Modify: `tests/unit/cli/test_main.py`

- [ ] **Step 1: Write failing CLI command test**

Append to `tests/unit/cli/test_main.py`:

```python
def test_subagents_command_renders_recent_runs() -> None:
    service = SimpleNamespace(
        inspect_subagents=lambda: ("explore completed tools=2 demo:sub:turn_1:abcd",)
    )
    handler = build_command_handler(service)

    assert list(handler("/subagents")) == [
        "[subagent] explore completed tools=2 demo:sub:turn_1:abcd"
    ]
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py::test_subagents_command_renders_recent_runs -q
```

Expected: unknown command.

- [ ] **Step 3: Implement service inspection**

In `src/mycli/application/turn_service.py`, add:

```python
    def inspect_subagents(self) -> tuple[str, ...]:
        service = getattr(self._runtime, "_sub_agent_service", None)
        if service is None:
            return ("no sub-agent service",)
        runs = service.list_runs()
        if not runs:
            return ("no sub-agent runs",)
        return tuple(
            f"{run.agent_type} {run.status} tools={run.tool_calls} {run.child_session_id}"
            for run in runs[-10:]
        )
```

- [ ] **Step 4: Add slash command**

In `src/mycli/cli/repl.py`, add `/subagents` to `/help` output and in `build_command_handler()`:

```python
        if command == "/subagents":
            return [f"[subagent] {line}" for line in service.inspect_subagents()]
```

Update `test_help_lists_sessions_command()` to assert `"/subagents" in output`.

Update `test_build_command_handler_exposes_runtime_inspection_commands()` fake service with:

```python
        def inspect_subagents(self) -> tuple[str, ...]:
            return ("no sub-agent runs",)
```

And assert:

```python
assert list(handler("/subagents")) == ["[subagent] no sub-agent runs"]
```

- [ ] **Step 5: Run CLI tests**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py::test_subagents_command_renders_recent_runs tests/unit/cli/test_main.py::test_help_lists_sessions_command tests/unit/cli/test_main.py::test_build_command_handler_exposes_runtime_inspection_commands -q
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/application/turn_service.py src/mycli/cli/repl.py tests/unit/cli/test_main.py
git commit -m "Expose sub-agent run inspection" -m "Add /subagents to show recent child-agent runs from the runtime-owned SubAgentService." -m "Constraint: P3 exposes text inspection only; rich child-agent UI and resume remain deferred." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: targeted CLI /subagents tests"
```

---

### Task 8: Full Verification And Smoke Report

**Files:**
- Create: `docs/superpowers/reports/2026-05-21-p3-sub-agent-capability-pack-smoke.md`
- Modify: `docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md`

- [ ] **Step 1: Run full verification**

Run:

```bash
uv run ruff check src tests
uv run mypy src/mycli
uv run pytest -q
```

Expected: all pass.

- [ ] **Step 2: Run real CLI smoke**

Run:

```bash
printf 'Use Task with explore agent to inspect what top-level files exist. Keep the final answer short.\n/subagents\n/quit\n' | uv run mycli --session p3-sub-agent-smoke
```

Expected:

- model can see `Task` in tool exposure.
- if model calls `Task`, output includes a sub-agent report and `/subagents` shows a recent run.
- if model chooses not to call `Task`, report that smoke did not exercise tool selection and run a direct tool-level smoke in Step 3.

- [ ] **Step 3: Run direct Task tool smoke**

Run:

```bash
uv run python - <<'PY'
from pathlib import Path
from mycli.cli.bootstrap import build_turn_service

service = build_turn_service(
    cli_args={"session": "p3-sub-agent-direct-smoke"},
    cwd=Path.cwd(),
    home=Path.home(),
)
tool = service._runtime._tool_registry.executors["Task"]
result = tool.execute({
    "agent_type": "explore",
    "description": "List the top-level repository files.",
    "allowed_tools": ["Read", "Grep", "Glob", "LS"],
})
print(result.success)
print(result.summary)
print(result.raw_payload)
print(service.inspect_subagents())
PY
```

Expected: `success=True`, `kind=sub_agent_report`, and `inspect_subagents()` includes one run.

- [ ] **Step 4: Update gap doc**

In `docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md`, update:

- `7.1 5 种 agent 模式`: keep ⚠️, note P3 in-process sync Task sub-agent exists; async/fork/worktree/remote still missing.
- `7.3 权限隔离`: change ❌ to ⚠️, note child tool subset + deny not amplified; full sandbox not done.
- `7.4 工具集隔离`: improve note to P3 resolver.
- `7.5 Context 隔离`: improve note to parent only receives final Task report.
- Summary counts for Sub-agent row and total row.

- [ ] **Step 5: Write smoke report**

Create `docs/superpowers/reports/2026-05-21-p3-sub-agent-capability-pack-smoke.md`:

```markdown
# P3 Sub-agent Capability Pack Smoke Report

## Commands

- `uv run ruff check src tests`
- `uv run mypy src/mycli`
- `uv run pytest -q`
- real CLI smoke command
- direct Task tool smoke command

## Results

- Ruff:
- Mypy:
- Pytest:
- Real CLI smoke:
- Direct Task smoke:

## Notes

- P3 implements synchronous in-process child runs only.
- Parent context receives only the final Task report.
- Worktree/remote/team child agents and nested approval remain deferred.
```

Fill the result bullets with actual observed outputs.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/reports/2026-05-21-p3-sub-agent-capability-pack-smoke.md docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md
git commit -m "Verify P3 sub-agent capability pack" -m "Record P3 verification evidence and update the Claude Code gap matrix for in-process Task sub-agents, tool scoping, and context isolation." -m "Constraint: Worktree, remote, team, and nested approval sub-agent modes remain deferred." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: full ruff, mypy, pytest, CLI smoke, and direct Task smoke"
```

---

## Final Verification

After all tasks are complete, run:

```bash
uv run ruff check src tests
uv run mypy src/mycli
uv run pytest -q
git status --short
```

Expected:

- Ruff passes.
- Mypy passes.
- Pytest passes.
- Worktree contains only intentional committed changes or is clean.
