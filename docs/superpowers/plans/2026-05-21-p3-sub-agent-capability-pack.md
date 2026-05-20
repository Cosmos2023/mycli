# P3 Sub-agent Capability Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build safe synchronous `Task` sub-agents that can run bounded child loops with isolated context, restricted tools, XML reports, and observable lifecycle state.

**Architecture:** P3 adds a single runtime path: `TaskTool -> SubAgentService -> SubAgentChildLoop -> scoped ToolRegistry -> XML report`. Child agents inherit the parent provider/model configuration for stability, but they receive only a narrow task prompt and a resolver-produced tool subset; parent conversation records only the final `Task` tool result. Claude Code-style async mailbox, background workers, coordinator/team mode, worktree/remote agents, and fork prompt-cache sharing are explicitly deferred.

**Tech Stack:** Python 3.13, dataclasses, existing `ModelTurnRequester`, `ToolRegistry`, `ToolRouter`, `ToolExecutionService`, `TraceService`, pytest, ruff, mypy. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-21-p3-sub-agent-capability-pack.md`

---

## File Structure

- `src/mycli/domain/subagents.py`: immutable domain contracts for profile, invocation, budget, result, and run summary.
- `src/mycli/application/runtime/subagents/__init__.py`: runtime sub-agent package exports.
- `src/mycli/application/runtime/subagents/profiles.py`: built-in `explore`, `review`, and `executor` profiles.
- `src/mycli/application/runtime/subagents/tool_scope.py`: layered child tool resolver with global denylist, profile denylist, parent exposure, requested tools, and policy denial.
- `src/mycli/application/runtime/subagents/loop.py`: bounded child model/tool loop with max turns, max tool calls, no-progress stop, and approval-required stop.
- `src/mycli/application/runtime/subagents/service.py`: service orchestration, child session id generation, XML report normalization, trace events, and recent run summaries.
- `src/mycli/tools/task.py`: model-facing `Task` tool; unavailable fallback when no service is bound.
- `src/mycli/tools/registry.py`: register fallback `TaskTool` in default tool inventory.
- `src/mycli/application/runtime/agent_runtime.py`: bind `SubAgentService`, replace fallback `TaskTool`, and expose recent sub-agent summaries.
- `src/mycli/application/turn_service.py`: expose `/subagents` inspection through the existing turn/service boundary.
- `src/mycli/cli/repl.py`: render `/subagents` command output.
- `src/mycli/agents/sub_agent.py`: remove the legacy parallel abstraction or replace it with a compatibility stub that imports from the new path and emits no runtime behavior.
- `docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md`: mark P3-covered sub-agent rows and leave deferred rows explicit.
- `docs/superpowers/reports/2026-05-21-p3-sub-agent-capability-pack-smoke.md`: final smoke evidence.

---

### Task 1: Domain Contracts And Profiles

**Files:**
- Create: `src/mycli/domain/subagents.py`
- Create: `src/mycli/application/runtime/subagents/__init__.py`
- Create: `src/mycli/application/runtime/subagents/profiles.py`
- Create: `tests/unit/domain/test_subagents.py`
- Create: `tests/unit/application/runtime/subagents/test_profiles.py`
- Modify: `src/mycli/agents/sub_agent.py`
- Modify: `tests/unit/agents/test_sub_agent.py`

- [ ] **Step 1: Write failing domain tests**

Create `tests/unit/domain/test_subagents.py`:

```python
from __future__ import annotations

import pytest

from mycli.domain.subagents import (
    SubAgentBudget,
    SubAgentInvocation,
    SubAgentProfile,
    SubAgentResult,
    SubAgentRunSummary,
)


def test_profile_has_budget_model_cache_and_denylists() -> None:
    profile = SubAgentProfile(
        name="explore",
        system_prompt="Read only.",
        default_tools=("Read", "Grep", "Read"),
        denied_tools=("Task",),
        budget=SubAgentBudget(max_turns=4, max_tool_calls=7),
        model=None,
        max_prompt_tokens=None,
        cache_strategy="inherit_provider_config",
    )

    assert profile.default_tools == ("Read", "Grep")
    assert profile.denied_tools == ("Task",)
    assert profile.budget.max_turns == 4
    assert profile.budget.max_tool_calls == 7
    assert profile.cache_strategy == "inherit_provider_config"


def test_budget_defaults_match_p3_spec() -> None:
    budget = SubAgentBudget()

    assert budget.max_turns == 8
    assert budget.max_tool_calls == 20
    assert budget.no_progress_turn_limit == 3
    assert budget.report_char_limit == 8000


def test_invocation_normalizes_tools_and_requires_task_identity() -> None:
    invocation = SubAgentInvocation(
        agent_type="explore",
        description="Find entry points",
        allowed_tools=("Grep", "Read", "Read"),
        parent_session_id="demo",
        parent_turn_id="turn_1",
    )

    assert invocation.allowed_tools == ("Grep", "Read")
    assert invocation.parent_session_id == "demo"
    assert invocation.parent_turn_id == "turn_1"


def test_blank_invocation_description_is_rejected() -> None:
    with pytest.raises(ValueError, match="description"):
        SubAgentInvocation(
            agent_type="explore",
            description=" ",
            allowed_tools=("Read",),
            parent_session_id="demo",
            parent_turn_id="turn_1",
        )


def test_summary_preserves_result_status_and_session() -> None:
    invocation = SubAgentInvocation(
        agent_type="review",
        description="Review diff",
        allowed_tools=("Read",),
        parent_session_id="demo",
        parent_turn_id="turn_1",
    )
    result = SubAgentResult(
        status="completed",
        report="<sub-agent-report agent=\"review\" status=\"completed\">ok</sub-agent-report>",
        child_session_id="demo:sub:turn_1:abcd1234",
        tool_calls=2,
    )

    summary = SubAgentRunSummary.from_result(invocation=invocation, result=result)

    assert summary.agent_type == "review"
    assert summary.status == "completed"
    assert summary.tool_calls == 2
    assert summary.child_session_id == "demo:sub:turn_1:abcd1234"
```

- [ ] **Step 2: Run domain tests to verify they fail**

Run:

```bash
uv run pytest tests/unit/domain/test_subagents.py -q
```

Expected: fails with `ModuleNotFoundError: No module named 'mycli.domain.subagents'`.

- [ ] **Step 3: Implement domain contracts**

Create `src/mycli/domain/subagents.py`:

```python
from __future__ import annotations

from dataclasses import dataclass, field


SubAgentStatus = str


def _non_blank(value: str, field_name: str) -> str:
    stripped = value.strip()
    if not stripped:
        raise ValueError(f"Sub-agent {field_name} cannot be blank.")
    return stripped


def _unique_non_blank(values: tuple[str, ...], field_name: str) -> tuple[str, ...]:
    unique = tuple(dict.fromkeys(value.strip() for value in values if value.strip()))
    if not unique:
        raise ValueError(f"Sub-agent {field_name} cannot be empty.")
    return unique


@dataclass(slots=True, frozen=True)
class SubAgentBudget:
    max_turns: int = 8
    max_tool_calls: int = 20
    no_progress_turn_limit: int = 3
    report_char_limit: int = 8000

    def __post_init__(self) -> None:
        for field_name in (
            "max_turns",
            "max_tool_calls",
            "no_progress_turn_limit",
            "report_char_limit",
        ):
            if getattr(self, field_name) <= 0:
                raise ValueError(f"Sub-agent {field_name} must be positive.")


@dataclass(slots=True, frozen=True)
class SubAgentProfile:
    name: str
    system_prompt: str
    default_tools: tuple[str, ...]
    denied_tools: tuple[str, ...] = ()
    budget: SubAgentBudget = field(default_factory=SubAgentBudget)
    model: str | None = None
    max_prompt_tokens: int | None = None
    cache_strategy: str = "inherit_provider_config"

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", _non_blank(self.name, "name"))
        object.__setattr__(self, "system_prompt", _non_blank(self.system_prompt, "system_prompt"))
        object.__setattr__(
            self,
            "default_tools",
            _unique_non_blank(self.default_tools, "default_tools"),
        )
        object.__setattr__(
            self,
            "denied_tools",
            tuple(dict.fromkeys(tool.strip() for tool in self.denied_tools if tool.strip())),
        )
        object.__setattr__(self, "cache_strategy", _non_blank(self.cache_strategy, "cache_strategy"))
        if self.max_prompt_tokens is not None and self.max_prompt_tokens <= 0:
            raise ValueError("Sub-agent max_prompt_tokens must be positive when set.")


@dataclass(slots=True, frozen=True)
class SubAgentInvocation:
    agent_type: str
    description: str
    allowed_tools: tuple[str, ...]
    parent_session_id: str
    parent_turn_id: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "agent_type", _non_blank(self.agent_type, "agent_type"))
        object.__setattr__(self, "description", _non_blank(self.description, "description"))
        object.__setattr__(
            self,
            "allowed_tools",
            _unique_non_blank(self.allowed_tools, "allowed_tools"),
        )
        object.__setattr__(
            self,
            "parent_session_id",
            _non_blank(self.parent_session_id, "parent_session_id"),
        )
        object.__setattr__(
            self,
            "parent_turn_id",
            _non_blank(self.parent_turn_id, "parent_turn_id"),
        )


@dataclass(slots=True, frozen=True)
class SubAgentResult:
    status: SubAgentStatus
    report: str
    child_session_id: str
    tool_calls: int
    error: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "status", _non_blank(self.status, "status"))
        object.__setattr__(
            self,
            "child_session_id",
            _non_blank(self.child_session_id, "child_session_id"),
        )
        if self.tool_calls < 0:
            raise ValueError("Sub-agent tool_calls cannot be negative.")


@dataclass(slots=True, frozen=True)
class SubAgentRunSummary:
    agent_type: str
    description: str
    status: SubAgentStatus
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
    "SubAgentBudget",
    "SubAgentInvocation",
    "SubAgentProfile",
    "SubAgentResult",
    "SubAgentRunSummary",
    "SubAgentStatus",
]
```

- [ ] **Step 4: Write failing profile tests**

Create `tests/unit/application/runtime/subagents/test_profiles.py`:

```python
from mycli.application.runtime.subagents.profiles import (
    get_sub_agent_profile,
    list_sub_agent_profiles,
)


def test_builtin_profiles_are_stable_and_conservative() -> None:
    profiles = list_sub_agent_profiles()

    assert [profile.name for profile in profiles] == ["executor", "explore", "review"]
    assert get_sub_agent_profile("explore").default_tools == ("Read", "Grep", "Glob", "LS")
    assert get_sub_agent_profile("review").default_tools == ("Read", "Grep", "Glob", "LS", "Lint")
    assert "Bash" not in get_sub_agent_profile("executor").default_tools
    assert "Task" in get_sub_agent_profile("executor").denied_tools


def test_unknown_profile_returns_none() -> None:
    assert get_sub_agent_profile("missing") is None
```

- [ ] **Step 5: Run profile tests to verify they fail**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_profiles.py -q
```

Expected: fails because `mycli.application.runtime.subagents.profiles` does not exist.

- [ ] **Step 6: Implement profiles and mark legacy sub-agent path**

Create `src/mycli/application/runtime/subagents/__init__.py`:

```python
"""Runtime support for safe synchronous sub-agents."""
```

Create `src/mycli/application/runtime/subagents/profiles.py`:

```python
from __future__ import annotations

from mycli.domain.subagents import SubAgentProfile


GLOBAL_CHILD_DENYLIST: tuple[str, ...] = (
    "Task",
    "AskUserQuestion",
    "enter_plan_mode",
    "exit_plan_mode",
    "EnterPlanMode",
    "ExitPlanMode",
)

_PROFILES: dict[str, SubAgentProfile] = {
    "executor": SubAgentProfile(
        name="executor",
        system_prompt=(
            "You are a bounded execution sub-agent. Make small scoped changes only. "
            "Return concise findings and changed paths. Do not ask the user questions."
        ),
        default_tools=("Read", "Grep", "Glob", "LS", "Edit", "Write"),
        denied_tools=GLOBAL_CHILD_DENYLIST,
    ),
    "explore": SubAgentProfile(
        name="explore",
        system_prompt=(
            "You are a read-only exploration sub-agent. Map files, symbols, and facts. "
            "Do not modify files or ask the user questions."
        ),
        default_tools=("Read", "Grep", "Glob", "LS"),
        denied_tools=GLOBAL_CHILD_DENYLIST,
    ),
    "review": SubAgentProfile(
        name="review",
        system_prompt=(
            "You are a code review sub-agent. Prioritize correctness, regressions, "
            "security, and missing tests. Do not modify files."
        ),
        default_tools=("Read", "Grep", "Glob", "LS", "Lint"),
        denied_tools=GLOBAL_CHILD_DENYLIST,
    ),
}


def get_sub_agent_profile(name: str) -> SubAgentProfile | None:
    return _PROFILES.get(name)


def list_sub_agent_profiles() -> list[SubAgentProfile]:
    return [_PROFILES[name] for name in sorted(_PROFILES)]


__all__ = ["GLOBAL_CHILD_DENYLIST", "get_sub_agent_profile", "list_sub_agent_profiles"]
```

Replace `src/mycli/agents/sub_agent.py` with:

```python
from __future__ import annotations

"""Legacy sub-agent module.

P3 routes all sub-agent execution through
``mycli.application.runtime.subagents``. This module is intentionally kept as
a small compatibility marker while old direct users are migrated.
"""

from mycli.domain.subagents import SubAgentResult


SubAgentReportFragment = SubAgentResult

__all__ = ["SubAgentReportFragment"]
```

Replace `tests/unit/agents/test_sub_agent.py` with:

```python
from mycli.agents.sub_agent import SubAgentReportFragment
from mycli.domain.subagents import SubAgentResult


def test_legacy_sub_agent_module_exports_report_alias() -> None:
    assert SubAgentReportFragment is SubAgentResult
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
uv run pytest tests/unit/domain/test_subagents.py tests/unit/application/runtime/subagents/test_profiles.py -q
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/mycli/domain/subagents.py src/mycli/application/runtime/subagents/__init__.py src/mycli/application/runtime/subagents/profiles.py src/mycli/agents/sub_agent.py tests/unit/domain/test_subagents.py tests/unit/application/runtime/subagents/test_profiles.py tests/unit/agents/test_sub_agent.py
git commit -m "Define bounded sub-agent contracts"
```

Use Lore trailers in the commit body:

```text
Constraint: P3 keeps only one sub-agent runtime path and marks the old Fragment-based abstraction legacy.
Confidence: high
Scope-risk: moderate
Tested: uv run pytest tests/unit/domain/test_subagents.py tests/unit/application/runtime/subagents/test_profiles.py -q
```

---

### Task 2: Layered Child Tool Scope Resolver

**Files:**
- Create: `src/mycli/application/runtime/subagents/tool_scope.py`
- Create: `tests/unit/application/runtime/subagents/test_tool_scope.py`

- [ ] **Step 1: Write failing resolver tests**

Create `tests/unit/application/runtime/subagents/test_tool_scope.py`:

```python
from __future__ import annotations

from mycli.application.runtime.subagents.profiles import get_sub_agent_profile
from mycli.application.runtime.subagents.tool_scope import resolve_child_tool_scope


def test_resolver_intersects_parent_request_and_profile() -> None:
    profile = get_sub_agent_profile("explore")

    resolved = resolve_child_tool_scope(
        parent_tools=("Read", "Grep", "Edit", "Task"),
        requested_tools=("Read", "Edit", "Task"),
        profile=profile,
        policy_denied_tools=(),
    )

    assert resolved == ("Read",)


def test_resolver_removes_global_and_policy_denied_tools() -> None:
    profile = get_sub_agent_profile("executor")

    resolved = resolve_child_tool_scope(
        parent_tools=("Read", "Write", "Task", "AskUserQuestion"),
        requested_tools=("Read", "Write", "Task", "AskUserQuestion"),
        profile=profile,
        policy_denied_tools=("Write",),
    )

    assert resolved == ("Read",)


def test_resolver_keeps_stable_profile_order() -> None:
    profile = get_sub_agent_profile("review")

    resolved = resolve_child_tool_scope(
        parent_tools=("Lint", "LS", "Glob", "Grep", "Read"),
        requested_tools=("Lint", "LS", "Glob", "Grep", "Read"),
        profile=profile,
        policy_denied_tools=(),
    )

    assert resolved == ("Read", "Grep", "Glob", "LS", "Lint")
```

- [ ] **Step 2: Run resolver tests to verify they fail**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_tool_scope.py -q
```

Expected: fails because `tool_scope.py` does not exist.

- [ ] **Step 3: Implement resolver**

Create `src/mycli/application/runtime/subagents/tool_scope.py`:

```python
from __future__ import annotations

from mycli.application.runtime.subagents.profiles import GLOBAL_CHILD_DENYLIST
from mycli.domain.subagents import SubAgentProfile


def resolve_child_tool_scope(
    *,
    parent_tools: tuple[str, ...],
    requested_tools: tuple[str, ...],
    profile: SubAgentProfile | None,
    policy_denied_tools: tuple[str, ...] = (),
) -> tuple[str, ...]:
    if profile is None:
        return ()
    parent = set(parent_tools)
    requested = set(requested_tools)
    profile_tools = set(profile.default_tools)
    denied = set(GLOBAL_CHILD_DENYLIST)
    denied.update(profile.denied_tools)
    denied.update(policy_denied_tools)

    allowed = parent & requested & profile_tools
    allowed -= denied
    return tuple(tool for tool in profile.default_tools if tool in allowed)


__all__ = ["resolve_child_tool_scope"]
```

- [ ] **Step 4: Run resolver tests**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_tool_scope.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/subagents/tool_scope.py tests/unit/application/runtime/subagents/test_tool_scope.py
git commit -m "Constrain child agent tool scope"
```

Use Lore trailers:

```text
Constraint: Child tools must be a subset of parent exposure, caller request, profile defaults, and policy.
Rejected: Simple allowlist intersection only | it would miss global no-nesting and profile denylist rules.
Confidence: high
Scope-risk: narrow
Tested: uv run pytest tests/unit/application/runtime/subagents/test_tool_scope.py -q
```

---

### Task 3: Model-Facing Task Tool

**Files:**
- Create: `src/mycli/tools/task.py`
- Create: `tests/unit/tools/test_task_tool.py`
- Modify: `src/mycli/tools/registry.py`

- [ ] **Step 1: Write failing Task tool tests**

Create `tests/unit/tools/test_task_tool.py`:

```python
from __future__ import annotations

from mycli.domain.subagents import SubAgentResult
from mycli.tools.task import TaskTool


class FakeSubAgentService:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def run_task(
        self,
        *,
        description: str,
        agent_type: str,
        allowed_tools: tuple[str, ...],
    ) -> SubAgentResult:
        self.calls.append(
            {
                "description": description,
                "agent_type": agent_type,
                "allowed_tools": allowed_tools,
            }
        )
        return SubAgentResult(
            status="completed",
            report="<sub-agent-report agent=\"explore\" status=\"completed\">ok</sub-agent-report>",
            child_session_id="demo:sub:turn_1:abcd1234",
            tool_calls=1,
        )


def test_task_tool_delegates_to_bound_service() -> None:
    service = FakeSubAgentService()
    tool = TaskTool(service=service)

    result = tool.execute(
        {
            "description": "Find tests",
            "agent_type": "explore",
            "allowed_tools": ["Read", "Grep"],
        }
    )

    assert result.success is True
    assert result.summary == "Sub-agent explore completed with status completed."
    assert result.raw_payload["child_session_id"] == "demo:sub:turn_1:abcd1234"
    assert service.calls == [
        {
            "description": "Find tests",
            "agent_type": "explore",
            "allowed_tools": ("Read", "Grep"),
        }
    ]


def test_unbound_task_tool_returns_unavailable_result() -> None:
    result = TaskTool().execute(
        {
            "description": "Find tests",
            "agent_type": "explore",
            "allowed_tools": ["Read"],
        }
    )

    assert result.success is False
    assert result.raw_payload["error_kind"] == "task_tool_unbound"
```

- [ ] **Step 2: Run Task tool tests to verify they fail**

Run:

```bash
uv run pytest tests/unit/tools/test_task_tool.py -q
```

Expected: fails because `mycli.tools.task` does not exist.

- [ ] **Step 3: Implement TaskTool**

Create `src/mycli/tools/task.py`:

```python
from __future__ import annotations

from typing import Protocol

from mycli.domain.subagents import SubAgentResult
from mycli.tools.base import SchemaTool, ToolParameter, ToolResult, ToolSpec


class SupportsSubAgentService(Protocol):
    def run_task(
        self,
        *,
        description: str,
        agent_type: str,
        allowed_tools: tuple[str, ...],
    ) -> SubAgentResult:
        ...


class TaskTool(SchemaTool):
    spec = ToolSpec(
        name="Task",
        description="Run a bounded child sub-agent for a specific task.",
        parameters=(
            ToolParameter("description", "string", True, "Specific child task."),
            ToolParameter("agent_type", "string", True, "One of: explore, review, executor."),
            ToolParameter(
                "allowed_tools",
                "array",
                True,
                "Candidate tool names the parent allows the child to use.",
                items_schema={"type": "string"},
            ),
        ),
        risk_level="medium",
    )

    def __init__(self, service: SupportsSubAgentService | None = None) -> None:
        self._service = service

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        if self._service is None:
            return ToolResult(
                success=False,
                summary="Task tool is unavailable until runtime binding completes.",
                error="Task tool is not bound to a SubAgentService.",
                raw_payload={"error_kind": "task_tool_unbound"},
            )
        description = str(arguments["description"])
        agent_type = str(arguments["agent_type"])
        allowed_tools = tuple(str(tool) for tool in arguments.get("allowed_tools", ()))
        result = self._service.run_task(
            description=description,
            agent_type=agent_type,
            allowed_tools=allowed_tools,
        )
        return ToolResult(
            success=result.status == "completed",
            summary=f"Sub-agent {agent_type} completed with status {result.status}.",
            error=result.error,
            raw_payload={
                "kind": "sub_agent_report",
                "status": result.status,
                "child_session_id": result.child_session_id,
                "tool_calls": result.tool_calls,
                "report": result.report,
                "content": result.report,
            },
        )

    def run(self, call) -> ToolResult:
        return self.execute(call.arguments)


__all__ = ["TaskTool"]
```

- [ ] **Step 4: Register fallback TaskTool**

Modify `src/mycli/tools/registry.py`:

```python
from mycli.tools.task import TaskTool
```

Add `TaskTool()` to the list returned by `default_tools()` after plan-mode tools.

- [ ] **Step 5: Run Task tool tests**

Run:

```bash
uv run pytest tests/unit/tools/test_task_tool.py -q
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/tools/task.py src/mycli/tools/registry.py tests/unit/tools/test_task_tool.py
git commit -m "Expose Task as a runtime-bound tool"
```

Use Lore trailers:

```text
Constraint: Default registries need a stable Task schema before runtime binding replaces the fallback executor.
Confidence: high
Scope-risk: narrow
Tested: uv run pytest tests/unit/tools/test_task_tool.py -q
```

---

### Task 4: Bounded Child Loop

**Files:**
- Create: `src/mycli/application/runtime/subagents/loop.py`
- Create: `tests/unit/application/runtime/subagents/test_child_loop.py`

- [ ] **Step 1: Write failing child loop tests**

Create `tests/unit/application/runtime/subagents/test_child_loop.py`:

```python
from __future__ import annotations

from dataclasses import dataclass

from mycli.application.runtime.subagents.loop import SubAgentChildLoop
from mycli.domain.subagents import SubAgentBudget, SubAgentInvocation, SubAgentProfile
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolResult


@dataclass(slots=True)
class FakeTurn:
    text: str = ""
    tool_calls: tuple[ToolCall, ...] = ()


class FakeRequester:
    def __init__(self, turns: list[FakeTurn]) -> None:
        self.turns = turns
        self.requests = 0

    def request_child_turn(self, *, messages, tool_names, child_session_id):
        self.requests += 1
        return self.turns.pop(0)


class FakeExecutor:
    def __init__(self) -> None:
        self.calls: list[ToolCall] = []
        self.tool_scopes: list[tuple[str, ...]] = []

    def execute_child_tool(
        self,
        *,
        call: ToolCall,
        child_session_id: str,
        tool_names: tuple[str, ...],
    ) -> ToolResult:
        del child_session_id
        self.calls.append(call)
        self.tool_scopes.append(tool_names)
        return ToolResult(
            success=True,
            summary="read ok",
            raw_payload={"content": "file content"},
        )


def _invocation() -> SubAgentInvocation:
    return SubAgentInvocation(
        agent_type="explore",
        description="Find files",
        allowed_tools=("Read",),
        parent_session_id="demo",
        parent_turn_id="turn_1",
    )


def test_child_loop_executes_tool_then_returns_final_text() -> None:
    requester = FakeRequester(
        [
            FakeTurn(
                tool_calls=(
                    ToolCall(
                        name="Read",
                        arguments={"path": "README.md"},
                        reason="inspect file",
                        call_id="call_1",
                    ),
                )
            ),
            FakeTurn(text="Found README.md."),
        ]
    )
    executor = FakeExecutor()
    loop = SubAgentChildLoop(requester=requester, executor=executor)

    result = loop.run(
        invocation=_invocation(),
        profile=SubAgentProfile(
            name="explore",
            system_prompt="Read only.",
            default_tools=("Read",),
            budget=SubAgentBudget(max_turns=4, max_tool_calls=4),
        ),
        child_session_id="demo:sub:turn_1:abcd1234",
        tool_names=("Read",),
    )

    assert result.status == "completed"
    assert result.report == "Found README.md."
    assert result.tool_calls == 1
    assert executor.calls[0].name == "Read"


def test_child_loop_stops_at_no_progress_limit() -> None:
    requester = FakeRequester([FakeTurn(), FakeTurn(), FakeTurn()])
    loop = SubAgentChildLoop(requester=requester, executor=FakeExecutor())

    result = loop.run(
        invocation=_invocation(),
        profile=SubAgentProfile(
            name="explore",
            system_prompt="Read only.",
            default_tools=("Read",),
            budget=SubAgentBudget(max_turns=6, no_progress_turn_limit=2),
        ),
        child_session_id="demo:sub:turn_1:abcd1234",
        tool_names=("Read",),
    )

    assert result.status == "max_no_progress"
    assert result.tool_calls == 0


def test_child_loop_stops_at_max_tool_calls() -> None:
    requester = FakeRequester(
        [
            FakeTurn(
                tool_calls=(
                    ToolCall(name="Read", arguments={"path": "a"}, reason="inspect a", call_id="call_1"),
                )
            ),
            FakeTurn(
                tool_calls=(
                    ToolCall(name="Read", arguments={"path": "b"}, reason="inspect b", call_id="call_2"),
                )
            ),
        ]
    )
    loop = SubAgentChildLoop(requester=requester, executor=FakeExecutor())

    result = loop.run(
        invocation=_invocation(),
        profile=SubAgentProfile(
            name="explore",
            system_prompt="Read only.",
            default_tools=("Read",),
            budget=SubAgentBudget(max_turns=4, max_tool_calls=1),
        ),
        child_session_id="demo:sub:turn_1:abcd1234",
        tool_names=("Read",),
    )

    assert result.status == "max_tool_calls"
    assert result.tool_calls == 1
```

- [ ] **Step 2: Run child loop tests to verify they fail**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_child_loop.py -q
```

Expected: fails because `loop.py` does not exist.

- [ ] **Step 3: Implement child loop against small protocols**

Create `src/mycli/application/runtime/subagents/loop.py`:

```python
from __future__ import annotations

from typing import Protocol

from mycli.domain.subagents import SubAgentInvocation, SubAgentProfile, SubAgentResult
from mycli.domain.tooling.calls import ToolCall
from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.tools.base import ToolResult


class ChildTurn(Protocol):
    text: str
    tool_calls: tuple[ToolCall, ...]


class ChildTurnRequester(Protocol):
    def request_child_turn(
        self,
        *,
        messages: list[dict[str, object]],
        tool_names: tuple[str, ...],
        child_session_id: str,
    ) -> ChildTurn:
        ...


class ChildToolExecutor(Protocol):
    def execute_child_tool(
        self,
        *,
        call: ToolCall,
        child_session_id: str,
        tool_names: tuple[str, ...],
    ) -> ToolResult:
        ...


class SubAgentChildLoop:
    def __init__(self, *, requester: ChildTurnRequester, executor: ChildToolExecutor) -> None:
        self._requester = requester
        self._executor = executor
        self._formatter = ToolResultFormatter()

    def run(
        self,
        *,
        invocation: SubAgentInvocation,
        profile: SubAgentProfile,
        child_session_id: str,
        tool_names: tuple[str, ...],
    ) -> SubAgentResult:
        messages: list[dict[str, object]] = [
            {"role": "system", "content": profile.system_prompt},
            {"role": "user", "content": invocation.description},
        ]
        tool_calls = 0
        no_progress_turns = 0

        for _turn_index in range(profile.budget.max_turns):
            turn = self._requester.request_child_turn(
                messages=messages,
                tool_names=tool_names,
                child_session_id=child_session_id,
            )
            text = (turn.text or "").strip()
            calls = tuple(turn.tool_calls)
            if text and not calls:
                return SubAgentResult(
                    status="completed",
                    report=text,
                    child_session_id=child_session_id,
                    tool_calls=tool_calls,
                )
            if not text and not calls:
                no_progress_turns += 1
                if no_progress_turns >= profile.budget.no_progress_turn_limit:
                    return SubAgentResult(
                        status="max_no_progress",
                        report="Child sub-agent stopped after repeated no-progress turns.",
                        child_session_id=child_session_id,
                        tool_calls=tool_calls,
                    )
                continue
            no_progress_turns = 0
            for call in calls:
                if tool_calls >= profile.budget.max_tool_calls:
                    return SubAgentResult(
                        status="max_tool_calls",
                        report="Child sub-agent reached the max tool call limit.",
                        child_session_id=child_session_id,
                        tool_calls=tool_calls,
                    )
                result = self._executor.execute_child_tool(
                    call=call,
                    child_session_id=child_session_id,
                    tool_names=tool_names,
                )
                tool_calls += 1
                if result.raw_payload.get("error_kind") == "approval_required":
                    return SubAgentResult(
                        status="approval_required",
                        report=f"Child sub-agent stopped because {call.name} requires approval.",
                        child_session_id=child_session_id,
                        tool_calls=tool_calls,
                        error=result.error,
                    )
                messages.append(
                    {
                        "role": "assistant",
                        "content": text,
                        "tool_calls": [call],
                    }
                )
                messages.append(
                    {
                        "role": "tool",
                        "tool_name": call.name,
                        "content": self._formatter.format(call.name, result),
                    }
                )

        return SubAgentResult(
            status="max_turns",
            report="Child sub-agent reached the max turn limit.",
            child_session_id=child_session_id,
            tool_calls=tool_calls,
        )


__all__ = ["ChildToolExecutor", "ChildTurnRequester", "SubAgentChildLoop"]
```

- [ ] **Step 4: Run child loop tests**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_child_loop.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/subagents/loop.py tests/unit/application/runtime/subagents/test_child_loop.py
git commit -m "Run bounded child agent loops"
```

Use Lore trailers:

```text
Constraint: P3 child agents are synchronous and bounded; async mailbox and background execution stay out of scope.
Confidence: medium
Scope-risk: moderate
Tested: uv run pytest tests/unit/application/runtime/subagents/test_child_loop.py -q
```

---

### Task 5: SubAgentService, XML Reports, And Run Summaries

**Files:**
- Create: `src/mycli/application/runtime/subagents/service.py`
- Create: `tests/unit/application/runtime/subagents/test_sub_agent_service.py`

- [ ] **Step 1: Write failing service tests**

Create `tests/unit/application/runtime/subagents/test_sub_agent_service.py`:

```python
from __future__ import annotations

from mycli.application.runtime.subagents.service import SubAgentService
from mycli.domain.subagents import SubAgentResult


class FakeLoop:
    def __init__(self, result: SubAgentResult) -> None:
        self.result = result
        self.calls: list[dict[str, object]] = []

    def run(self, **kwargs):
        self.calls.append(kwargs)
        return self.result


def test_service_resolves_scope_runs_loop_and_wraps_xml() -> None:
    loop = FakeLoop(
        SubAgentResult(
            status="completed",
            report="Found README.md.",
            child_session_id="ignored",
            tool_calls=1,
        )
    )
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read", "Grep", "Task"),
        child_loop=loop,
    )

    result = service.run_task(
        description="Find docs",
        agent_type="explore",
        allowed_tools=("Read", "Task"),
    )

    assert result.status == "completed"
    assert result.child_session_id.startswith("demo:sub:turn_1:")
    assert result.report.startswith("<sub-agent-report agent=\"explore\" status=\"completed\" tools=\"1\"")
    assert "Found README.md." in result.report
    assert loop.calls[0]["tool_names"] == ("Read",)
    assert service.recent_runs()[0].description == "Find docs"


def test_service_rejects_unknown_profile_with_xml_report() -> None:
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="unused",
                child_session_id="ignored",
                tool_calls=0,
            )
        ),
    )

    result = service.run_task(
        description="Find docs",
        agent_type="missing",
        allowed_tools=("Read",),
    )

    assert result.status == "failed"
    assert "Unknown sub-agent profile" in result.report


def test_service_truncates_long_report_body() -> None:
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="x" * 9000,
                child_session_id="ignored",
                tool_calls=0,
            )
        ),
    )

    result = service.run_task(
        description="Find docs",
        agent_type="explore",
        allowed_tools=("Read",),
    )

    assert len(result.report) < 8400
    assert "truncated" in result.report
```

- [ ] **Step 2: Run service tests to verify they fail**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_sub_agent_service.py -q
```

Expected: fails because `service.py` does not exist.

- [ ] **Step 3: Implement service**

Create `src/mycli/application/runtime/subagents/service.py`:

```python
from __future__ import annotations

from collections import deque
from collections.abc import Callable
from html import escape
from uuid import uuid4

from mycli.application.runtime.subagents.loop import SubAgentChildLoop
from mycli.application.runtime.subagents.profiles import get_sub_agent_profile
from mycli.application.runtime.subagents.tool_scope import resolve_child_tool_scope
from mycli.domain.subagents import (
    SubAgentInvocation,
    SubAgentResult,
    SubAgentRunSummary,
)


class SubAgentService:
    def __init__(
        self,
        *,
        session_id: str,
        turn_id_provider: Callable[[], str],
        parent_tool_names: Callable[[], tuple[str, ...]],
        child_loop: SubAgentChildLoop,
        policy_denied_tools: Callable[[], tuple[str, ...]] | None = None,
        max_recent_runs: int = 20,
    ) -> None:
        self._session_id = session_id
        self._turn_id_provider = turn_id_provider
        self._parent_tool_names = parent_tool_names
        self._policy_denied_tools = policy_denied_tools or (lambda: ())
        self._child_loop = child_loop
        self._recent_runs: deque[SubAgentRunSummary] = deque(maxlen=max_recent_runs)

    def run_task(
        self,
        *,
        description: str,
        agent_type: str,
        allowed_tools: tuple[str, ...],
    ) -> SubAgentResult:
        turn_id = self._turn_id_provider()
        invocation = SubAgentInvocation(
            agent_type=agent_type,
            description=description,
            allowed_tools=allowed_tools,
            parent_session_id=self._session_id,
            parent_turn_id=turn_id,
        )
        child_session_id = self._child_session_id(turn_id)
        profile = get_sub_agent_profile(agent_type)
        if profile is None:
            result = SubAgentResult(
                status="failed",
                report=self._xml_report(
                    agent=agent_type,
                    status="failed",
                    tool_calls=0,
                    child_session_id=child_session_id,
                    body=f"Unknown sub-agent profile: {agent_type}",
                    limit=8000,
                ),
                child_session_id=child_session_id,
                tool_calls=0,
                error=f"Unknown sub-agent profile: {agent_type}",
            )
            self._record(invocation, result)
            return result
        tool_names = resolve_child_tool_scope(
            parent_tools=self._parent_tool_names(),
            requested_tools=allowed_tools,
            profile=profile,
            policy_denied_tools=self._policy_denied_tools(),
        )
        loop_result = self._child_loop.run(
            invocation=invocation,
            profile=profile,
            child_session_id=child_session_id,
            tool_names=tool_names,
        )
        result = SubAgentResult(
            status=loop_result.status,
            report=self._xml_report(
                agent=agent_type,
                status=loop_result.status,
                tool_calls=loop_result.tool_calls,
                child_session_id=child_session_id,
                body=loop_result.report,
                limit=profile.budget.report_char_limit,
            ),
            child_session_id=child_session_id,
            tool_calls=loop_result.tool_calls,
            error=loop_result.error,
        )
        self._record(invocation, result)
        return result

    def recent_runs(self) -> tuple[SubAgentRunSummary, ...]:
        return tuple(self._recent_runs)

    def _record(self, invocation: SubAgentInvocation, result: SubAgentResult) -> None:
        self._recent_runs.appendleft(
            SubAgentRunSummary.from_result(invocation=invocation, result=result)
        )

    def _child_session_id(self, turn_id: str) -> str:
        return f"{self._session_id}:sub:{turn_id}:{uuid4().hex[:8]}"

    def _xml_report(
        self,
        *,
        agent: str,
        status: str,
        tool_calls: int,
        child_session_id: str,
        body: str,
        limit: int,
    ) -> str:
        report_body = body
        if len(report_body) > limit:
            report_body = report_body[:limit] + "\n[truncated: sub-agent report exceeded limit]"
        return (
            f'<sub-agent-report agent="{escape(agent)}" status="{escape(status)}" '
            f'tools="{tool_calls}" child_session_id="{escape(child_session_id)}">'
            f"\n{escape(report_body)}\n</sub-agent-report>"
        )


__all__ = ["SubAgentService"]
```

- [ ] **Step 4: Run service tests**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_sub_agent_service.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/subagents/service.py tests/unit/application/runtime/subagents/test_sub_agent_service.py
git commit -m "Wrap sub-agent runs in observable XML reports"
```

Use Lore trailers:

```text
Constraint: Parent conversations should receive one final Task tool result rather than child intermediate messages.
Confidence: high
Scope-risk: moderate
Tested: uv run pytest tests/unit/application/runtime/subagents/test_sub_agent_service.py -q
```

---

### Task 6: Runtime Integration With Current Model And Tool Services

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/runtime/subagents/loop.py`
- Create: `tests/unit/application/runtime/subagents/test_runtime_child_adapters.py`
- Modify: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write failing adapter tests**

Create `tests/unit/application/runtime/subagents/test_runtime_child_adapters.py`:

```python
from __future__ import annotations

from mycli.application.runtime.subagents.loop import (
    RuntimeChildToolExecutor,
    RuntimeChildTurnRequester,
)
from mycli.domain.runtime import ModelTurnResult, RuntimeBlock, RuntimeItem
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.exposure import ToolExposure, ToolExposureEntry, ToolRouteKey, ToolRouteSource
from mycli.llms.adapters.base import ModelMessage
from mycli.llms.adapters.base import ModelToolDefinition
from mycli.tools.base import ToolResult, ToolSpec


class FakeRouter:
    def __init__(self) -> None:
        self.calls: list[tuple[ToolCall, ToolExposure]] = []

    def execute(self, call: ToolCall, *, exposure: ToolExposure) -> ToolResult:
        self.calls.append((call, exposure))
        return ToolResult(success=True, summary="ok", raw_payload={"content": "ok"})


def test_runtime_child_tool_executor_uses_child_exposure_only() -> None:
    router = FakeRouter()
    executor = RuntimeChildToolExecutor(
        tool_router=router,
        tool_specs={
            "Read": ToolSpec(name="Read", description="Read a file."),
            "Task": ToolSpec(name="Task", description="Run a child agent."),
        },
    )
    call = ToolCall(
        name="Read",
        arguments={"path": "README.md"},
        reason="inspect file",
        call_id="call_1",
    )

    result = executor.execute_child_tool(
        call=call,
        child_session_id="demo:sub:turn_1:abcd1234",
        tool_names=("Read",),
    )

    assert result.success is True
    assert router.calls[0][0] == call
    assert router.calls[0][1].callable_tool_names() == ("Read",)


class FakeRequester:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def request_model_turn(
        self,
        *,
        runtime_items: list[RuntimeItem],
        legacy_messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
        stream_sink=None,
    ):
        self.calls.append(
            {
                "runtime_items": runtime_items,
                "legacy_messages": legacy_messages,
                "tools": tools,
                "stream_sink": stream_sink,
            }
        )
        return (
            ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(type="text", text="checking"),
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="Read",
                                tool_arguments={"path": "README.md"},
                                call_id="call_1",
                            ),
                        ),
                    ),
                ),
                done=False,
            ),
            (),
        )


def test_runtime_child_turn_requester_projects_model_result() -> None:
    requester = FakeRequester()
    spec = ToolSpec(name="Read", description="Read a file.")
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Read"),
                source=ToolRouteSource.REGISTRY,
                spec=spec,
            ),
        )
    )
    child_requester = RuntimeChildTurnRequester(
        requester=requester,
        tool_exposure_builder=lambda names: exposure,
        tool_renderer=lambda exposure: [ModelToolDefinition(name="Read", description="Read a file.")],
    )

    turn = child_requester.request_child_turn(
        messages=[
            {"role": "system", "content": "Read only."},
            {"role": "user", "content": "Find docs"},
        ],
        tool_names=("Read",),
        child_session_id="demo:sub:turn_1:abcd1234",
    )

    assert turn.text == "checking"
    assert turn.tool_calls == (
        ToolCall(
            name="Read",
            arguments={"path": "README.md"},
            reason="child sub-agent tool call",
            call_id="call_1",
        ),
    )
```

- [ ] **Step 2: Run adapter test to verify it fails**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_runtime_child_adapters.py -q
```

Expected: fails because runtime child adapters do not exist.

- [ ] **Step 3: Add runtime adapters to loop module**

Extend `src/mycli/application/runtime/subagents/loop.py` with runtime adapters that translate the small child protocols to existing runtime services:

```python
from dataclasses import dataclass
from collections.abc import Callable

from mycli.domain.runtime import ModelTurnResult, RuntimeBlock, RuntimeItem
from mycli.domain.tooling.exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.llms.adapters.base import ModelMessage, ModelToolDefinition
from mycli.tools.base import ToolSpec
from mycli.tools.routing.tool_router import ToolRouter


@dataclass(slots=True, frozen=True)
class RuntimeChildTurn:
    text: str
    tool_calls: tuple[ToolCall, ...] = ()


@dataclass(slots=True)
class RuntimeChildTurnRequester:
    requester: object
    tool_exposure_builder: Callable[[tuple[str, ...]], ToolExposure]
    tool_renderer: Callable[[ToolExposure], list[ModelToolDefinition]]

    def request_child_turn(
        self,
        *,
        messages: list[dict[str, object]],
        tool_names: tuple[str, ...],
        child_session_id: str,
    ) -> RuntimeChildTurn:
        del child_session_id
        exposure = self.tool_exposure_builder(tool_names)
        turn_result, _streamed = self.requester.request_model_turn(
            runtime_items=self._runtime_items(messages),
            legacy_messages=self._legacy_messages(messages),
            tools=self.tool_renderer(exposure),
        )
        return self._project_turn(turn_result)

    def _runtime_items(self, messages: list[dict[str, object]]) -> list[RuntimeItem]:
        return [
            RuntimeItem(
                role=str(message["role"]),
                blocks=(RuntimeBlock(type="text", text=str(message.get("content", ""))),),
            )
            for message in messages
        ]

    def _legacy_messages(self, messages: list[dict[str, object]]) -> list[ModelMessage]:
        return [
            ModelMessage(
                role=str(message["role"]),
                content=str(message.get("content", "")),
            )
            for message in messages
        ]

    def _project_turn(self, turn_result: ModelTurnResult) -> RuntimeChildTurn:
        text_parts: list[str] = []
        calls: list[ToolCall] = []
        for item in turn_result.items:
            for block in item.blocks:
                if block.type == "text" and block.text:
                    text_parts.append(block.text)
                if block.type == "tool_call" and block.tool_name:
                    calls.append(
                        ToolCall(
                            name=block.tool_name,
                            arguments=block.tool_arguments or {},
                            reason="child sub-agent tool call",
                            call_id=block.call_id,
                        )
                    )
        return RuntimeChildTurn(text="\n".join(text_parts).strip(), tool_calls=tuple(calls))


@dataclass(slots=True)
class RuntimeChildToolExecutor:
    tool_router: ToolRouter
    tool_specs: dict[str, ToolSpec]

    def execute_child_tool(
        self,
        *,
        call: ToolCall,
        child_session_id: str,
        tool_names: tuple[str, ...],
    ) -> ToolResult:
        del child_session_id
        exposure = ToolExposure(
            entries=tuple(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local(name),
                    source=ToolRouteSource.REGISTRY,
                    spec=self.tool_specs[name],
                )
                for name in tool_names
                if name in self.tool_specs
            )
        )
        return self.tool_router.execute(call, exposure=exposure)
```

- [ ] **Step 4: Run child loop and adapter tests**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_child_loop.py tests/unit/application/runtime/subagents/test_runtime_child_adapters.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Write failing runtime registration test**

Add to `tests/unit/application/test_agent_runtime.py`:

```python
def test_runtime_registers_bound_task_tool(tmp_path) -> None:
    adapter = SearchThenDoneAdapter()
    runtime = AgentRuntime.for_tests(tmp_path, tmp_path, adapter)

    assert "Task" in runtime._tool_registry.list_names()
    task_tool = runtime._tool_registry.executors["Task"]
    assert getattr(task_tool, "_service", None) is runtime._sub_agent_service
```

- [ ] **Step 6: Wire service into AgentRuntime**

Modify `src/mycli/application/runtime/agent_runtime.py` after `_tool_orchestrator` and `_tool_execution_service` are constructed:

```python
from mycli.application.runtime.subagents.loop import (
    RuntimeChildToolExecutor,
    RuntimeChildTurnRequester,
    SubAgentChildLoop,
)
from mycli.application.runtime.subagents.service import SubAgentService
from mycli.tools.task import TaskTool
```

Create service:

```python
child_executor = RuntimeChildToolExecutor(
    tool_router=ToolRouter(tool_registry=self._tool_registry),
    tool_specs=dict(self._tool_registry.specs or {}),
)
child_requester = RuntimeChildTurnRequester(
    requester=self._model_turn_requester,
    tool_exposure_builder=self._child_tool_exposure,
    tool_renderer=lambda exposure: self._render_model_tools(
        tool_exposure=exposure,
        tool_router=ToolRouter(tool_registry=self._tool_registry),
        allow_tools=True,
    ),
)
self._sub_agent_child_loop = SubAgentChildLoop(
    requester=child_requester,
    executor=child_executor,
)
self._sub_agent_service = SubAgentService(
    session_id=config.session_id,
    turn_id_provider=lambda: getattr(self, "_current_turn_id", "turn_unknown"),
    parent_tool_names=lambda: tuple(self._tool_registry.list_names()),
    child_loop=self._sub_agent_child_loop,
)
self._tool_registry.register(TaskTool(service=self._sub_agent_service))
```

Add a helper on `AgentRuntime` for child exposure:

```python
def _child_tool_exposure(self, tool_names: tuple[str, ...]) -> ToolExposure:
    specs = self._tool_registry.specs or {}
    return ToolExposure(
        entries=tuple(
            ToolExposureEntry(
                route_key=ToolRouteKey.local(name),
                source=ToolRouteSource.REGISTRY,
                spec=specs[name],
            )
            for name in tool_names
            if name in specs
        )
    )
```

Import `ToolExposureEntry`, `ToolRouteKey`, and `ToolRouteSource` from `mycli.domain.tooling.exposure`.

Add an instance field update wherever a turn id is created at the start of a turn:

```python
self._current_turn_id = turn_id
```

If the concrete turn id variable has a different name, use that existing variable and keep the field assignment next to existing `_set_model_log_context(turn_id)` calls.

- [ ] **Step 7: Run runtime registration test**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime.py::test_runtime_registers_bound_task_tool -q
```

Expected: passes.

- [ ] **Step 8: Commit**

```bash
git add src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/subagents/loop.py tests/unit/application/runtime/subagents/test_runtime_child_adapters.py tests/unit/application/test_agent_runtime.py
git commit -m "Bind Task sub-agents into runtime"
```

Use Lore trailers:

```text
Constraint: P3 reuses the parent provider and runtime registry, but child scope is still resolver-limited.
Rejected: Separate child AgentRuntime instance | it duplicates session, approval, and provider wiring for P3.
Confidence: medium
Scope-risk: broad
Tested: uv run pytest tests/unit/application/test_agent_runtime.py::test_runtime_registers_bound_task_tool -q
```

---

### Task 7: `/subagents` Inspection And Gap Doc Update

**Files:**
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/cli/repl.py`
- Modify: `docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md`
- Create: `tests/unit/application/test_turn_service_subagents.py`
- Modify: existing CLI command tests under `tests/unit/cli/`

- [ ] **Step 1: Write failing turn service inspection test**

Create `tests/unit/application/test_turn_service_subagents.py`:

```python
from __future__ import annotations

from mycli.domain.subagents import SubAgentRunSummary


class FakeRuntime:
    def recent_subagents(self) -> tuple[SubAgentRunSummary, ...]:
        return (
            SubAgentRunSummary(
                agent_type="explore",
                description="Find docs",
                status="completed",
                child_session_id="demo:sub:turn_1:abcd1234",
                tool_calls=2,
            ),
        )


def test_turn_service_formats_subagent_summaries() -> None:
    from mycli.application.turn_service import format_subagent_summaries

    output = format_subagent_summaries(FakeRuntime().recent_subagents())

    assert output == (
        "explore completed tools=2 demo:sub:turn_1:abcd1234 "
        "description=Find docs"
    )
```

- [ ] **Step 2: Run inspection test to verify it fails**

Run:

```bash
uv run pytest tests/unit/application/test_turn_service_subagents.py -q
```

Expected: fails because `format_subagent_summaries` does not exist.

- [ ] **Step 3: Implement runtime and service inspection**

Add to `src/mycli/application/runtime/agent_runtime.py`:

```python
def recent_subagents(self) -> tuple[SubAgentRunSummary, ...]:
    return self._sub_agent_service.recent_runs()
```

Import `SubAgentRunSummary` from `mycli.domain.subagents`.

Add to `src/mycli/application/turn_service.py`:

```python
from mycli.domain.subagents import SubAgentRunSummary


def format_subagent_summaries(summaries: tuple[SubAgentRunSummary, ...]) -> str:
    if not summaries:
        return "No sub-agent runs in this session."
    return "\n".join(
        (
            f"{summary.agent_type} {summary.status} tools={summary.tool_calls} "
            f"{summary.child_session_id} description={summary.description[:80]}"
        )
        for summary in summaries
    )
```

Wire `/subagents` in `src/mycli/cli/repl.py` next to existing slash-command handling:

```python
if command == "/subagents":
    console.print(format_subagent_summaries(runtime.recent_subagents()))
    continue
```

Use the existing console/output abstraction in `repl.py`; if variable names differ, keep the command body equivalent.

- [ ] **Step 4: Update gap doc**

Modify `docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md` so the sub-agent section records:

```markdown
- 7.1 Agent modes: P3 covers sync in-process only; async/fork/worktree/remote remain open.
- 7.2 Fork cache sharing: still open; explicitly deferred to P4 because byte-identical prompt prefixes need separate verification.
- 7.3 Permission isolation: partially covered by P3 tool-scope denial and no nested approval UI; OS/process sandbox remains open.
- 7.4 Tool-set isolation: covered by P3 layered child resolver.
- 7.5 Context isolation: covered by P3 final XML report only; async notification remains open.
- 7.6 Agent Teams: open.
- 7.7 `/batch`: open.
```

- [ ] **Step 5: Run inspection tests**

Run:

```bash
uv run pytest tests/unit/application/test_turn_service_subagents.py -q
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/application/runtime/agent_runtime.py src/mycli/application/turn_service.py src/mycli/cli/repl.py tests/unit/application/test_turn_service_subagents.py docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md
git commit -m "Surface recent sub-agent runs"
```

Use Lore trailers:

```text
Constraint: P3 observability should expose child lifecycle without adding child internals to parent conversation.
Confidence: medium
Scope-risk: moderate
Tested: uv run pytest tests/unit/application/test_turn_service_subagents.py -q
```

---

### Task 8: Final Verification And Smoke Report

**Files:**
- Create: `docs/superpowers/reports/2026-05-21-p3-sub-agent-capability-pack-smoke.md`

- [ ] **Step 1: Run focused sub-agent test suite**

Run:

```bash
uv run pytest tests/unit/domain/test_subagents.py tests/unit/application/runtime/subagents tests/unit/tools/test_task_tool.py tests/unit/application/test_turn_service_subagents.py -q
```

Expected: all tests pass.

- [ ] **Step 2: Run full quality gates**

Run:

```bash
uv run ruff check src tests
uv run mypy src/mycli
uv run pytest -q
```

Expected: all commands pass. If an unrelated pre-existing failure appears, capture the failing command, file, and reason in the smoke report before deciding whether to fix or defer.

- [ ] **Step 3: Run CLI smoke**

Run the repository's supported CLI entrypoint in a temp workspace and ask for a bounded exploration sub-task. Use the existing local invocation style from prior smoke reports; for example:

```bash
MYCLI_HOME="$(mktemp -d)" uv run mycli --help
```

Then run an interactive or scripted `Task(explore)` scenario if the CLI test harness supports tool-call injection. The smoke passes when the resulting transcript contains:

```xml
<sub-agent-report agent="explore" status="completed"
```

and `/subagents` prints:

```text
explore completed tools=
```

- [ ] **Step 4: Write smoke report**

Create `docs/superpowers/reports/2026-05-21-p3-sub-agent-capability-pack-smoke.md`:

```markdown
# P3 Sub-agent Capability Pack Smoke

## Commands

- `uv run pytest tests/unit/domain/test_subagents.py tests/unit/application/runtime/subagents tests/unit/tools/test_task_tool.py tests/unit/application/test_turn_service_subagents.py -q`
- `uv run ruff check src tests`
- `uv run mypy src/mycli`
- `uv run pytest -q`
- `MYCLI_HOME="$(mktemp -d)" uv run mycli --help`

## Evidence

- `Task` is registered and runtime-bound.
- Child tool scope excludes `Task`, `AskUserQuestion`, and plan-mode tools.
- Child loop executes tool-call -> tool-result -> next turn.
- Child stop statuses are covered for `max_turns`, `max_tool_calls`, `max_no_progress`, and `approval_required`.
- Parent receives only the final XML report.
- `/subagents` shows recent child runs.

## Known Gaps

- Async mailbox, backgrounding, coordinator/team, worktree/remote agents, and fork cache sharing remain outside P3.
```

Replace the evidence bullets with exact command results after running the commands.

- [ ] **Step 5: Placeholder scan**

Run:

```bash
rg -n "T[B]D|T[O]DO|implement[ ]later|fill[ ]in|Similar[ ]to|appropriate[ ]error[ ]handling|add[ ]validation|Write[ ]tests[ ]for[ ]the[ ]above" docs/superpowers/specs/2026-05-21-p3-sub-agent-capability-pack.md docs/superpowers/plans/2026-05-21-p3-sub-agent-capability-pack.md docs/superpowers/reports/2026-05-21-p3-sub-agent-capability-pack-smoke.md
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/reports/2026-05-21-p3-sub-agent-capability-pack-smoke.md
git commit -m "Record P3 sub-agent smoke evidence"
```

Use Lore trailers:

```text
Constraint: Final acceptance requires runnable evidence, not only unit tests.
Confidence: high
Scope-risk: narrow
Tested: uv run ruff check src tests; uv run mypy src/mycli; uv run pytest -q
```

---

## Self-Review Checklist

- P3 includes sync in-process `Task` sub-agent only.
- P3 includes no nested sub-agent and no nested approval UI.
- P3 includes layered tool scope, not a plain allowlist.
- P3 includes `model`, `max_prompt_tokens`, `cache_strategy`, and child budget fields in the domain profile.
- P3 includes no-progress and max-turn guards in addition to max tool calls.
- P3 includes XML final reports and report length bounds.
- P3 keeps child intermediate messages out of parent conversation.
- P3 updates the Claude Code gap document with completed and deferred rows.
- P4 remains the home for fork cache sharing and async/background/coordinator behavior.
