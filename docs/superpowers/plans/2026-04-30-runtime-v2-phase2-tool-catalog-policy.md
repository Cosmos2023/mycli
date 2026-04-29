# Runtime V2 Phase 2 Tool Catalog Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate model-visible tool catalog ordering from per-turn tool policy so tool schema order stays stable when direct/deferred policy changes.

**Architecture:** Phase 2 adds `ToolCatalog` and `ToolPolicy` domain contracts, then routes model schema rendering through the catalog while keeping existing `ToolExposure` execution behavior intact. It also fixes negated tool intent so requests like "do not call git_diff or run_shell" do not promote shell/git tools into the direct set.

**Tech Stack:** Python 3.13, dataclasses, StrEnum, pytest, ruff, mypy.

---

## Scope Check

This plan implements the Runtime v2 tool boundary slice:

- Add deterministic `ToolCatalog` model-visible ordering.
- Add explicit `ToolPolicy` for allowed/denied/recommended/requires-approval state.
- Keep existing `ToolExposure` and `ToolRouter.execute()` behavior for live runtime compatibility.
- Make `ToolRouter.render_for_model()` use catalog order instead of `direct + deferred + dynamic`.
- Fix direct-tool promotion for negated shell/git instructions.

This plan does not migrate approvals, dynamic tool lifecycle, request shape assembly, memory, or provider formatters. Those remain later Runtime v2 phases.

## File Structure

- Create `src/mycli/domain/tool_catalog.py`
  - Owns `ToolCatalogEntry` and `ToolCatalog`.
  - Converts existing `ToolExposure` into deterministic model-visible entries.
  - Provides deterministic schema order hash input.

- Create `src/mycli/domain/tool_policy.py`
  - Owns `ToolPolicy`, `ToolPolicyStatus`, and construction from `ToolExposure`.
  - Does not execute tools and does not render model schemas.

- Modify `src/mycli/domain/__init__.py` only if the package already exports domain types there.
  - If it has no public exports, leave it unchanged.

- Modify `src/mycli/services/tool_router.py`
  - Use `ToolCatalog.from_exposure(exposure).model_visible_entries()` in `render_for_model()`.
  - Keep `execute()` using `ToolExposure.callable_tool_names()` for compatibility.

- Modify `src/mycli/services/tool_exposure_planner.py`
  - Add conservative negated-intent detection before shell/git promotion.

- Modify `tests/unit/services/test_tool_router.py`
  - Add schema ordering regression tests.

- Modify `tests/unit/services/test_tool_exposure_planner.py`
  - Add negated shell/git promotion regression tests.

- Create `tests/unit/domain/test_tool_catalog.py`
  - Tests deterministic catalog ordering and duplicate route rejection.

- Create `tests/unit/domain/test_tool_policy.py`
  - Tests policy construction from existing exposure.

## Task 1: Add Deterministic ToolCatalog

**Files:**
- Create: `src/mycli/domain/tool_catalog.py`
- Test: `tests/unit/domain/test_tool_catalog.py`

- [ ] **Step 1: Write failing ToolCatalog tests**

Create `tests/unit/domain/test_tool_catalog.py` with:

```python
from __future__ import annotations

import pytest

from mycli.domain.tool_catalog import ToolCatalog
from mycli.domain.tool_exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolExposureKind,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.tools.base import ToolSpec


def _entry(name: str, kind: ToolExposureKind) -> ToolExposureEntry:
    return ToolExposureEntry(
        route_key=ToolRouteKey.local(name),
        kind=kind,
        source=ToolRouteSource.REGISTRY,
        spec=ToolSpec(name=name, description=f"Tool {name}"),
    )


def test_tool_catalog_orders_entries_by_route_key_not_policy_group() -> None:
    exposure = ToolExposure(
        direct=(_entry("run_shell", ToolExposureKind.DIRECT),),
        deferred=(_entry("list_directory", ToolExposureKind.DEFERRED),),
    )

    catalog = ToolCatalog.from_exposure(exposure)

    assert [entry.name for entry in catalog.model_visible_entries()] == [
        "list_directory",
        "run_shell",
    ]


def test_tool_catalog_order_is_stable_when_direct_and_deferred_swap() -> None:
    first = ToolCatalog.from_exposure(
        ToolExposure(
            direct=(_entry("run_shell", ToolExposureKind.DIRECT),),
            deferred=(_entry("list_directory", ToolExposureKind.DEFERRED),),
        )
    )
    second = ToolCatalog.from_exposure(
        ToolExposure(
            direct=(_entry("list_directory", ToolExposureKind.DIRECT),),
            deferred=(_entry("run_shell", ToolExposureKind.DEFERRED),),
        )
    )

    assert [entry.name for entry in first.model_visible_entries()] == [
        entry.name for entry in second.model_visible_entries()
    ]
    assert first.order_hash() == second.order_hash()


def test_tool_catalog_rejects_duplicate_route_names() -> None:
    entry = _entry("read_file", ToolExposureKind.DIRECT)

    with pytest.raises(ValueError, match="unique route names"):
        ToolCatalog(entries=(entry, entry))
```

- [ ] **Step 2: Run ToolCatalog tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/domain/test_tool_catalog.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'mycli.domain.tool_catalog'`.

- [ ] **Step 3: Implement `ToolCatalog`**

Create `src/mycli/domain/tool_catalog.py` with:

```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from mycli.domain.runtime import stable_hash
from mycli.domain.tool_exposure import ToolExposure, ToolRouteKey, ToolRouteSource
from mycli.tools.base import ToolSpec

if TYPE_CHECKING:
    from mycli.domain.dynamic_tools import DynamicToolDescriptor


@dataclass(slots=True, frozen=True)
class ToolCatalogEntry:
    route_key: ToolRouteKey
    source: ToolRouteSource
    spec: ToolSpec
    metadata: dict[str, Any] = field(default_factory=dict)
    dynamic_descriptor: DynamicToolDescriptor | None = None

    @property
    def name(self) -> str:
        return self.route_key.value


@dataclass(slots=True, frozen=True)
class ToolCatalog:
    entries: tuple[ToolCatalogEntry, ...] = ()

    def __post_init__(self) -> None:
        names = [entry.name for entry in self.entries]
        if len(names) != len(set(names)):
            raise ValueError("ToolCatalog entries must have unique route names.")

    @classmethod
    def from_exposure(cls, exposure: ToolExposure) -> "ToolCatalog":
        return cls(
            entries=tuple(
                ToolCatalogEntry(
                    route_key=entry.route_key,
                    source=entry.source,
                    spec=entry.spec,
                    metadata=dict(entry.metadata),
                    dynamic_descriptor=entry.dynamic_descriptor,
                )
                for entry in exposure.all_entries()
            )
        )

    def model_visible_entries(self) -> tuple[ToolCatalogEntry, ...]:
        return tuple(sorted(self.entries, key=lambda entry: entry.name))

    def order_hash(self) -> str:
        return stable_hash("\n".join(entry.name for entry in self.model_visible_entries()))
```

- [ ] **Step 4: Run ToolCatalog tests and verify they pass**

Run:

```bash
uv run pytest tests/unit/domain/test_tool_catalog.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit ToolCatalog**

Run:

```bash
git add src/mycli/domain/tool_catalog.py tests/unit/domain/test_tool_catalog.py
git commit -m "Add deterministic tool catalog contract" \
  -m "Runtime v2 separates model-visible tool schema order from per-turn policy. ToolCatalog converts existing ToolExposure values into a deterministic route-key order so direct/deferred changes stop perturbing schema order." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run pytest tests/unit/domain/test_tool_catalog.py -q"
```

## Task 2: Add ToolPolicy Contract

**Files:**
- Create: `src/mycli/domain/tool_policy.py`
- Test: `tests/unit/domain/test_tool_policy.py`

- [ ] **Step 1: Write failing ToolPolicy tests**

Create `tests/unit/domain/test_tool_policy.py` with:

```python
from __future__ import annotations

from mycli.domain.tool_exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolExposureKind,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.domain.tool_policy import ToolPolicy, ToolPolicyStatus
from mycli.tools.base import ToolSpec


def _entry(name: str, kind: ToolExposureKind) -> ToolExposureEntry:
    return ToolExposureEntry(
        route_key=ToolRouteKey.local(name),
        kind=kind,
        source=ToolRouteSource.REGISTRY,
        spec=ToolSpec(name=name, description=f"Tool {name}"),
    )


def test_tool_policy_builds_from_exposure_groups() -> None:
    policy = ToolPolicy.from_exposure(
        ToolExposure(
            direct=(_entry("read_file", ToolExposureKind.DIRECT),),
            deferred=(_entry("run_shell", ToolExposureKind.DEFERRED),),
        )
    )

    assert policy.status_for("read_file") is ToolPolicyStatus.RECOMMENDED
    assert policy.status_for("run_shell") is ToolPolicyStatus.ALLOWED
    assert policy.allows("read_file")
    assert policy.allows("run_shell")


def test_tool_policy_denied_overrides_allowed() -> None:
    policy = ToolPolicy(
        allowed=("run_shell",),
        denied=("run_shell",),
        recommended=(),
        requires_approval=(),
    )

    assert policy.status_for("run_shell") is ToolPolicyStatus.DENIED
    assert not policy.allows("run_shell")
```

- [ ] **Step 2: Run ToolPolicy tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/domain/test_tool_policy.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'mycli.domain.tool_policy'`.

- [ ] **Step 3: Implement `ToolPolicy`**

Create `src/mycli/domain/tool_policy.py` with:

```python
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from mycli.domain.tool_exposure import ToolExposure


class ToolPolicyStatus(StrEnum):
    ALLOWED = "allowed"
    DENIED = "denied"
    RECOMMENDED = "recommended"
    REQUIRES_APPROVAL = "requires_approval"
    UNKNOWN = "unknown"


@dataclass(slots=True, frozen=True)
class ToolPolicy:
    allowed: tuple[str, ...] = ()
    denied: tuple[str, ...] = ()
    recommended: tuple[str, ...] = ()
    requires_approval: tuple[str, ...] = ()

    @classmethod
    def from_exposure(cls, exposure: ToolExposure) -> "ToolPolicy":
        direct = tuple(entry.name for entry in exposure.direct)
        deferred = tuple(entry.name for entry in exposure.deferred)
        dynamic = tuple(entry.name for entry in exposure.dynamic)
        return cls(
            allowed=tuple(dict.fromkeys((*direct, *deferred, *dynamic))),
            recommended=direct,
        )

    def status_for(self, tool_name: str) -> ToolPolicyStatus:
        if tool_name in self.denied:
            return ToolPolicyStatus.DENIED
        if tool_name in self.requires_approval:
            return ToolPolicyStatus.REQUIRES_APPROVAL
        if tool_name in self.recommended:
            return ToolPolicyStatus.RECOMMENDED
        if tool_name in self.allowed:
            return ToolPolicyStatus.ALLOWED
        return ToolPolicyStatus.UNKNOWN

    def allows(self, tool_name: str) -> bool:
        status = self.status_for(tool_name)
        return status in {
            ToolPolicyStatus.ALLOWED,
            ToolPolicyStatus.RECOMMENDED,
            ToolPolicyStatus.REQUIRES_APPROVAL,
        }
```

- [ ] **Step 4: Run ToolPolicy tests and verify they pass**

Run:

```bash
uv run pytest tests/unit/domain/test_tool_policy.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit ToolPolicy**

Run:

```bash
git add src/mycli/domain/tool_policy.py tests/unit/domain/test_tool_policy.py
git commit -m "Add explicit tool policy contract" \
  -m "Runtime v2 needs tool permissions and recommendations to be represented separately from model-visible schema order. ToolPolicy captures allowed, denied, recommended, and approval-required states without rendering schemas or executing tools." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run pytest tests/unit/domain/test_tool_policy.py -q"
```

## Task 3: Render Tools in Catalog Order

**Files:**
- Modify: `src/mycli/services/tool_router.py`
- Modify: `tests/unit/services/test_tool_router.py`

- [ ] **Step 1: Add failing router ordering regression test**

Append this test to `tests/unit/services/test_tool_router.py`:

```python
def test_tool_router_schema_order_does_not_change_when_policy_groups_change() -> None:
    registry = ToolRegistryV2.from_tools(
        [
            FakeTool("list_directory", "listed"),
            FakeTool("run_shell", "ran"),
        ]
    )
    first_exposure = ToolExposure(
        direct=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("run_shell"),
                kind=ToolExposureKind.DIRECT,
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["run_shell"],
            ),
        ),
        deferred=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("list_directory"),
                kind=ToolExposureKind.DEFERRED,
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["list_directory"],
            ),
        ),
    )
    second_exposure = ToolExposure(
        direct=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("list_directory"),
                kind=ToolExposureKind.DIRECT,
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["list_directory"],
            ),
        ),
        deferred=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("run_shell"),
                kind=ToolExposureKind.DEFERRED,
                source=ToolRouteSource.REGISTRY,
                spec=registry.specs["run_shell"],
            ),
        ),
    )
    router = ToolRouter(tool_registry=registry)

    first_names = [tool.name for tool in router.render_for_model(first_exposure)]
    second_names = [tool.name for tool in router.render_for_model(second_exposure)]

    assert first_names == ["list_directory", "run_shell"]
    assert second_names == ["list_directory", "run_shell"]
```

- [ ] **Step 2: Run the new router test and verify it fails**

Run:

```bash
uv run pytest tests/unit/services/test_tool_router.py::test_tool_router_schema_order_does_not_change_when_policy_groups_change -q
```

Expected: FAIL because the first render currently returns `["run_shell", "list_directory"]`.

- [ ] **Step 3: Update `ToolRouter.render_for_model()`**

Modify `src/mycli/services/tool_router.py`.

Add this import:

```python
from mycli.domain.tool_catalog import ToolCatalog
```

Replace `render_for_model()` with:

```python
    def render_for_model(self, exposure: ToolExposure) -> list[ModelToolDefinition]:
        catalog = ToolCatalog.from_exposure(exposure)
        return [
            ModelToolDefinition(
                name=entry.name,
                description=entry.spec.description,
                parameters=tuple(
                    ModelToolParameter(
                        name=parameter.name,
                        type=parameter.type,
                        required=parameter.required,
                        description=parameter.description,
                        items_schema=parameter.items_schema,
                    )
                    for parameter in entry.spec.parameters
                ),
            )
            for entry in catalog.model_visible_entries()
        ]
```

- [ ] **Step 4: Run router tests and verify they pass**

Run:

```bash
uv run pytest tests/unit/services/test_tool_router.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit router catalog-order rendering**

Run:

```bash
git add src/mycli/services/tool_router.py tests/unit/services/test_tool_router.py
git commit -m "Render model tools in catalog order" \
  -m "ToolRouter now renders schemas through ToolCatalog so direct/deferred policy group changes do not reorder model-visible tools and perturb prompt caches." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: uv run pytest tests/unit/services/test_tool_router.py -q"
```

## Task 4: Fix Negated Shell/Git Promotion

**Files:**
- Modify: `src/mycli/services/tool_exposure_planner.py`
- Modify: `tests/unit/services/test_tool_exposure_planner.py`

- [ ] **Step 1: Add failing negation regression tests**

Append these tests to `tests/unit/services/test_tool_exposure_planner.py`:

```python
def test_tool_exposure_planner_does_not_promote_negated_git_or_shell_tools() -> None:
    registry = ToolRegistryV2.from_tools(
        [
            FakeTool("list_directory", "List files"),
            FakeTool("read_file", "Read file"),
            FakeTool("run_shell", "Run shell"),
            FakeTool("git_diff", "Git diff"),
            FakeTool("git_log", "Git log"),
            FakeTool("git_status", "Git status"),
        ]
    )
    planner = ToolExposurePlanner(tool_registry=registry)

    planned = planner.plan(user_message="不要调用 git_diff 或 run_shell，只读文件并总结")

    direct_names = {entry.name for entry in planned.exposure.direct}

    assert "run_shell" not in direct_names
    assert "git_diff" not in direct_names
    assert "git_log" not in direct_names
    assert "git_status" not in direct_names


def test_tool_exposure_planner_still_promotes_positive_git_intent() -> None:
    registry = ToolRegistryV2.from_tools(
        [
            FakeTool("list_directory", "List files"),
            FakeTool("git_status", "Git status"),
            FakeTool("git_diff", "Git diff"),
            FakeTool("git_log", "Git log"),
            FakeTool("run_shell", "Run shell"),
        ]
    )
    planner = ToolExposurePlanner(tool_registry=registry)

    planned = planner.plan(user_message="please inspect git status and git diff")

    direct_names = {entry.name for entry in planned.exposure.direct}

    assert {"git_status", "git_diff", "git_log", "run_shell"} <= direct_names
```

- [ ] **Step 2: Run negation test and verify it fails**

Run:

```bash
uv run pytest tests/unit/services/test_tool_exposure_planner.py::test_tool_exposure_planner_does_not_promote_negated_git_or_shell_tools -q
```

Expected: FAIL because `run_shell` and git tools are currently promoted by keyword matching.

- [ ] **Step 3: Implement conservative negation detection**

Modify `src/mycli/services/tool_exposure_planner.py`.

Add these class constants near the top of `ToolExposurePlanner`:

```python
    _SHELL_GIT_TOKENS = (
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
    _NEGATION_MARKERS = (
        "不要",
        "别",
        "禁止",
        "不要调用",
        "不要使用",
        "do not",
        "don't",
        "never",
        "without",
    )
```

Replace the shell/git promotion block in `_default_direct_tool_names()` with:

```python
        if self._has_positive_shell_or_git_intent(lowered):
            direct.update({"run_shell", "git_diff", "git_log", "git_status"})
```

Add this helper method below `_default_direct_tool_names()`:

```python
    def _has_positive_shell_or_git_intent(self, lowered: str) -> bool:
        for token in self._SHELL_GIT_TOKENS:
            start = 0
            while True:
                index = lowered.find(token, start)
                if index == -1:
                    break
                if not self._is_negated_token(lowered, index):
                    return True
                start = index + len(token)
        return False

    def _is_negated_token(self, lowered: str, token_index: int) -> bool:
        window = lowered[max(0, token_index - 24):token_index]
        return any(marker in window for marker in self._NEGATION_MARKERS)
```

- [ ] **Step 4: Run tool exposure planner tests and verify they pass**

Run:

```bash
uv run pytest tests/unit/services/test_tool_exposure_planner.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit negated intent fix**

Run:

```bash
git add src/mycli/services/tool_exposure_planner.py tests/unit/services/test_tool_exposure_planner.py
git commit -m "Avoid promoting negated shell and git tools" \
  -m "The previous keyword scan treated mentions inside prohibitions as positive intent, so 'do not call git_diff or run_shell' made those tools direct. The planner now ignores shell/git tokens preceded by nearby negation markers." \
  -m "Confidence: medium" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run pytest tests/unit/services/test_tool_exposure_planner.py -q"
```

## Task 5: Add Phase 2 Documentation Linkage

**Files:**
- Modify: `docs/superpowers/specs/2026-04-29-runtime-v2-cache-first-architecture-design.md`
- Modify: `docs/superpowers/plans/2026-04-30-runtime-v2-phase2-tool-catalog-policy.md`

- [ ] **Step 1: Add Phase 2 status note to the design**

Add this paragraph after the existing Phase 1 implementation note in `docs/superpowers/specs/2026-04-29-runtime-v2-cache-first-architecture-design.md`:

```markdown
Phase 2 adds `ToolCatalog` and `ToolPolicy`, stabilizes model-visible tool schema ordering, and fixes negated shell/git tool promotion. It keeps live execution compatibility while separating schema visibility from per-turn policy.
```

- [ ] **Step 2: Add dependency note to this plan**

Add this paragraph under this plan's Scope Check section:

```markdown
Phase 2 depends on Phase 1 only for the architectural direction and diagnostics vocabulary. It does not require live `RequestShape` integration yet.
```

- [ ] **Step 3: Review docs diff**

Run:

```bash
git diff -- docs/superpowers/specs/2026-04-29-runtime-v2-cache-first-architecture-design.md docs/superpowers/plans/2026-04-30-runtime-v2-phase2-tool-catalog-policy.md
```

Expected: diff shows only the two documentation notes above.

- [ ] **Step 4: Commit documentation linkage**

Run:

```bash
git add docs/superpowers/specs/2026-04-29-runtime-v2-cache-first-architecture-design.md docs/superpowers/plans/2026-04-30-runtime-v2-phase2-tool-catalog-policy.md
git commit -m "Document runtime v2 phase two tool boundary" \
  -m "Runtime v2 phase two separates model-visible tool catalog ordering from per-turn tool policy while keeping live execution compatible." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: git diff review of documentation-only changes"
```

## Task 6: Run Phase 2 Verification

**Files:**
- Verify: `src/mycli/domain/tool_catalog.py`
- Verify: `src/mycli/domain/tool_policy.py`
- Verify: `src/mycli/services/tool_router.py`
- Verify: `src/mycli/services/tool_exposure_planner.py`
- Verify: related tests

- [ ] **Step 1: Run focused Phase 2 tests**

Run:

```bash
uv run pytest tests/unit/domain/test_tool_catalog.py tests/unit/domain/test_tool_policy.py tests/unit/services/test_tool_router.py tests/unit/services/test_tool_exposure_planner.py -q
```

Expected: PASS.

- [ ] **Step 2: Run targeted lint**

Run:

```bash
uv run ruff check src/mycli/domain/tool_catalog.py src/mycli/domain/tool_policy.py src/mycli/services/tool_router.py src/mycli/services/tool_exposure_planner.py tests/unit/domain/test_tool_catalog.py tests/unit/domain/test_tool_policy.py tests/unit/services/test_tool_router.py tests/unit/services/test_tool_exposure_planner.py
```

Expected: PASS with `All checks passed!`.

- [ ] **Step 3: Run typecheck**

Run:

```bash
uv run mypy
```

Expected: PASS with no mypy errors.

- [ ] **Step 4: Run full test suite**

Run:

```bash
uv run pytest
```

Expected: PASS.

- [ ] **Step 5: Commit verification adjustment if one was required**

If verification required changing code or tests, commit those exact changes:

```bash
git add src/mycli/domain/tool_catalog.py src/mycli/domain/tool_policy.py src/mycli/services/tool_router.py src/mycli/services/tool_exposure_planner.py tests/unit/domain/test_tool_catalog.py tests/unit/domain/test_tool_policy.py tests/unit/services/test_tool_router.py tests/unit/services/test_tool_exposure_planner.py
git commit -m "Stabilize runtime v2 phase two verification" \
  -m "Focused tests, lint, typecheck, and full suite now pass for ToolCatalog, ToolPolicy, stable schema ordering, and negated shell/git promotion." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run ruff check targeted files; uv run mypy; uv run pytest"
```

If verification required no changes, do not create an empty commit.

## Self-Review

Spec coverage:

- Stable tool schema ordering is covered by Tasks 1 and 3.
- ToolCatalog and ToolPolicy separation is covered by Tasks 1 and 2.
- Keeping execution compatibility is covered by Task 3 because `ToolRouter.execute()` is intentionally unchanged.
- Negated shell/git direct promotion is covered by Task 4.
- Documentation linkage is covered by Task 5.
- Verification is covered by Task 6.
- Approval migration and live RequestShape integration are intentionally deferred.

Placeholder scan:

- This plan contains no placeholder markers or unspecified implementation steps.
- Each code-changing task includes exact file paths, code, commands, and expected results.

Type consistency:

- `ToolCatalog`, `ToolCatalogEntry`, `ToolPolicy`, and `ToolPolicyStatus` are defined before use.
- `ToolRouter.render_for_model()` depends only on `ToolCatalog.from_exposure()`, which Task 1 defines.
- The negation helper names used in Task 4 match the implementation snippets.
