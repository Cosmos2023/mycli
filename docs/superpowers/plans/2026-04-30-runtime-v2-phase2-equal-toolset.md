# Runtime V2 Phase 2 Equal ToolSet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace prompt-visible tool hierarchy with one stable, equal toolset whose schema order does not change with task wording or runtime safety state.

**Architecture:** Phase 2 introduces `ToolSet` as the model-visible tool contract and uses it for deterministic schema rendering. Existing `ToolExposure` remains only as a compatibility carrier while live runtime migration continues; it must no longer define model-visible ordering or imply tool rank. Safety checks stay in the execution path and do not create direct/deferred/recommended prompt levels.

**Tech Stack:** Python 3.13, dataclasses, pytest, ruff, mypy.

---

## Scope Check

This plan implements the Runtime v2 equal-toolset slice:

- Add deterministic `ToolSet` model-visible ordering.
- Make `ToolRouter.render_for_model()` use `ToolSet` order instead of `direct + deferred + dynamic`.
- Change `ToolExposurePlanner` so static registry tools are exposed as one equal callable set for compatibility.
- Preserve execution safety and approvals outside the model-visible tool schema.
- Keep dynamic tool lifecycle, provider formatting, memory, and request-shape assembly for later phases.

There is intentionally no `ToolPolicy`, no `recommended` tool state, and no direct/deferred hierarchy in the target model-visible design.

Phase 2 depends on Phase 1 only for the architectural direction and diagnostics vocabulary. It does not require live `RequestShape` integration yet.

## File Structure

- Create `src/mycli/domain/tool_set.py`
  - Owns `ToolSetEntry` and `ToolSet`.
  - Converts existing `ToolExposure` into deterministic model-visible entries during migration.
  - Provides deterministic order hash input.

- Modify `src/mycli/services/tool_router.py`
  - Use `ToolSet.from_exposure(exposure).model_visible_entries()` in `render_for_model()`.
  - Keep `execute()` behavior unchanged for this phase.

- Modify `src/mycli/services/tool_exposure_planner.py`
  - Stop promoting tools by task keyword.
  - Put all static registry tools into one compatibility group so the agent sees tools as equal.
  - Keep dynamic entries separate only because the current domain type still has a dynamic tuple.

- Modify `src/mycli/services/context/turn_context_assembler.py`
  - Render tool exposure as an equal toolset summary instead of `Direct tools` / `Deferred tools`.

- Modify `src/mycli/services/context/instruction_contract_assembler.py`
  - Keep tool exposure guidance level-free.

- Create `tests/unit/domain/test_tool_set.py`
  - Tests deterministic ordering and duplicate route rejection.

- Modify `tests/unit/services/test_tool_router.py`
  - Adds schema ordering regression tests.

- Modify `tests/unit/services/test_tool_exposure_planner.py`
  - Updates expectations from direct/deferred hierarchy to equal toolset behavior.

- Modify `tests/unit/services/test_turn_context_assembler.py`
  - Updates tool exposure text expectations.

## Task 1: Add Deterministic ToolSet

**Files:**
- Create: `src/mycli/domain/tool_set.py`
- Test: `tests/unit/domain/test_tool_set.py`

- [ ] **Step 1: Write failing ToolSet tests**

Create `tests/unit/domain/test_tool_set.py` with:

```python
from __future__ import annotations

import pytest

from mycli.domain.tool_exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolExposureKind,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.domain.tool_set import ToolSet
from mycli.tools.base import ToolSpec


def _entry(name: str, kind: ToolExposureKind) -> ToolExposureEntry:
    return ToolExposureEntry(
        route_key=ToolRouteKey.local(name),
        kind=kind,
        source=ToolRouteSource.REGISTRY,
        spec=ToolSpec(name=name, description=f"Tool {name}"),
    )


def test_tool_set_orders_entries_by_route_key_not_compatibility_group() -> None:
    exposure = ToolExposure(
        direct=(_entry("run_shell", ToolExposureKind.DIRECT),),
        deferred=(_entry("list_directory", ToolExposureKind.DEFERRED),),
    )

    tool_set = ToolSet.from_exposure(exposure)

    assert [entry.name for entry in tool_set.model_visible_entries()] == [
        "list_directory",
        "run_shell",
    ]


def test_tool_set_order_is_stable_when_compatibility_groups_swap() -> None:
    first = ToolSet.from_exposure(
        ToolExposure(
            direct=(_entry("run_shell", ToolExposureKind.DIRECT),),
            deferred=(_entry("list_directory", ToolExposureKind.DEFERRED),),
        )
    )
    second = ToolSet.from_exposure(
        ToolExposure(
            direct=(_entry("list_directory", ToolExposureKind.DIRECT),),
            deferred=(_entry("run_shell", ToolExposureKind.DEFERRED),),
        )
    )

    assert [entry.name for entry in first.model_visible_entries()] == [
        entry.name for entry in second.model_visible_entries()
    ]
    assert first.order_hash() == second.order_hash()


def test_tool_set_rejects_duplicate_route_names() -> None:
    entry = _entry("read_file", ToolExposureKind.DIRECT)

    with pytest.raises(ValueError, match="unique route names"):
        ToolSet(entries=(entry, entry))
```

- [ ] **Step 2: Run ToolSet tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/domain/test_tool_set.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'mycli.domain.tool_set'`.

- [ ] **Step 3: Implement `ToolSet`**

Create `src/mycli/domain/tool_set.py` with:

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
class ToolSetEntry:
    route_key: ToolRouteKey
    source: ToolRouteSource
    spec: ToolSpec
    metadata: dict[str, Any] = field(default_factory=dict)
    dynamic_descriptor: DynamicToolDescriptor | None = None

    @property
    def name(self) -> str:
        return self.route_key.value


@dataclass(slots=True, frozen=True)
class ToolSet:
    entries: tuple[ToolSetEntry, ...] = ()

    def __post_init__(self) -> None:
        names = [entry.name for entry in self.entries]
        if len(names) != len(set(names)):
            raise ValueError("ToolSet entries must have unique route names.")

    @classmethod
    def from_exposure(cls, exposure: ToolExposure) -> "ToolSet":
        return cls(
            entries=tuple(
                ToolSetEntry(
                    route_key=entry.route_key,
                    source=entry.source,
                    spec=entry.spec,
                    metadata=dict(entry.metadata),
                    dynamic_descriptor=entry.dynamic_descriptor,
                )
                for entry in exposure.all_entries()
            )
        )

    def model_visible_entries(self) -> tuple[ToolSetEntry, ...]:
        return tuple(sorted(self.entries, key=lambda entry: entry.name))

    def order_hash(self) -> str:
        return stable_hash("\n".join(entry.name for entry in self.model_visible_entries()))
```

- [ ] **Step 4: Run ToolSet tests and verify they pass**

Run:

```bash
uv run pytest tests/unit/domain/test_tool_set.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit ToolSet**

Run:

```bash
git add src/mycli/domain/tool_set.py tests/unit/domain/test_tool_set.py
git commit -m "Add deterministic equal toolset contract" \
  -m "Runtime v2 treats tools as one equal model-visible set. ToolSet converts existing ToolExposure compatibility values into deterministic route-key order without preserving direct/deferred rank." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run pytest tests/unit/domain/test_tool_set.py -q"
```

## Task 2: Render Tools in Equal ToolSet Order

**Files:**
- Modify: `src/mycli/services/tool_router.py`
- Modify: `tests/unit/services/test_tool_router.py`

- [ ] **Step 1: Add failing router ordering regression test**

Append this test to `tests/unit/services/test_tool_router.py`:

```python
def test_tool_router_schema_order_does_not_change_when_compatibility_groups_change() -> None:
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
uv run pytest tests/unit/services/test_tool_router.py::test_tool_router_schema_order_does_not_change_when_compatibility_groups_change -q
```

Expected: FAIL because the first render currently returns `["run_shell", "list_directory"]`.

- [ ] **Step 3: Update `ToolRouter.render_for_model()`**

Modify `src/mycli/services/tool_router.py`.

Add this import:

```python
from mycli.domain.tool_set import ToolSet
```

Replace `render_for_model()` with:

```python
    def render_for_model(self, exposure: ToolExposure) -> list[ModelToolDefinition]:
        tool_set = ToolSet.from_exposure(exposure)
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
            for entry in tool_set.model_visible_entries()
        ]
```

- [ ] **Step 4: Run router tests and verify they pass**

Run:

```bash
uv run pytest tests/unit/services/test_tool_router.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit router equal-toolset rendering**

Run:

```bash
git add src/mycli/services/tool_router.py tests/unit/services/test_tool_router.py
git commit -m "Render model tools as an equal toolset" \
  -m "ToolRouter now renders schemas through ToolSet so compatibility grouping no longer reorders model-visible tools or implies prompt-visible tool rank." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: uv run pytest tests/unit/services/test_tool_router.py -q"
```

## Task 3: Make Static Tools Equal in Exposure Planner

**Files:**
- Modify: `src/mycli/services/tool_exposure_planner.py`
- Modify: `tests/unit/services/test_tool_exposure_planner.py`

- [ ] **Step 1: Replace hierarchy expectations in planner tests**

Update `test_tool_exposure_planner_separates_direct_and_deferred_tools_for_repo_analysis` in `tests/unit/services/test_tool_exposure_planner.py` to:

```python
def test_tool_exposure_planner_exposes_static_tools_as_equal_callable_set() -> None:
    registry = ToolRegistryV2.from_tools(
        [
            FakeTool("list_directory", "List files"),
            FakeTool("read_file", "Read file"),
            FakeTool("search_text", "Search text"),
            FakeTool("run_shell", "Run shell"),
            FakeTool("edit_file", "Edit file"),
        ]
    )
    planner = ToolExposurePlanner(tool_registry=registry)

    planned = planner.plan(user_message="please inspect this repository and summarize it")

    assert set(planned.exposure.callable_tool_names()) == {
        "list_directory",
        "read_file",
        "search_text",
        "run_shell",
        "edit_file",
    }
    assert [entry.name for entry in planned.exposure.deferred] == []
```

Update `test_tool_exposure_planner_promotes_write_tools_for_chinese_modify_intent` to:

```python
def test_tool_exposure_planner_keeps_write_tools_equal_for_chinese_modify_intent() -> None:
    registry = ToolRegistryV2.from_tools(
        [
            FakeTool("list_directory", "List files"),
            FakeTool("read_file", "Read file"),
            FakeTool("edit_file", "Edit file"),
            FakeTool("replace_in_file", "Replace in file"),
            FakeTool("append_file", "Append file"),
        ]
    )
    planner = ToolExposurePlanner(tool_registry=registry)

    planned = planner.plan(user_message="请直接修一下这个 bug，顺手补一条测试")

    assert set(planned.exposure.callable_tool_names()) == {
        "list_directory",
        "read_file",
        "edit_file",
        "replace_in_file",
        "append_file",
    }
    assert [entry.name for entry in planned.exposure.deferred] == []
```

- [ ] **Step 2: Run updated planner tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/services/test_tool_exposure_planner.py -q
```

Expected: FAIL because current planner still places non-promoted static tools into `deferred`.

- [ ] **Step 3: Simplify static exposure to one equal compatibility group**

Modify `src/mycli/services/tool_exposure_planner.py`.

Remove `_default_direct_tool_names()` usage from `plan()` by replacing:

```python
        direct_names = set(self._default_direct_tool_names(user_message))
```

with:

```python
        del user_message
```

Replace the static registry loop with:

```python
        for spec in self._tool_registry.specs.values():
            entry = ToolExposureEntry(
                route_key=ToolRouteKey.local(spec.name),
                kind=ToolExposureKind.DIRECT,
                source=ToolRouteSource.REGISTRY,
                spec=spec,
            )
            seen.add(entry.name)
            direct_entries.append(entry)
```

Remove the `_default_direct_tool_names()` method entirely if it is no longer referenced.

- [ ] **Step 4: Run planner tests and verify they pass**

Run:

```bash
uv run pytest tests/unit/services/test_tool_exposure_planner.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit equal static exposure**

Run:

```bash
git add src/mycli/services/tool_exposure_planner.py tests/unit/services/test_tool_exposure_planner.py
git commit -m "Expose static tools as an equal callable set" \
  -m "The agent tool system no longer ranks static tools by direct/deferred promotion. The planner keeps existing ToolExposure compatibility shape but puts static registry tools into one equal callable group." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: uv run pytest tests/unit/services/test_tool_exposure_planner.py -q"
```

## Task 4: Render Tool Context Without Levels

**Files:**
- Modify: `src/mycli/services/context/turn_context_assembler.py`
- Modify: `src/mycli/services/context/instruction_contract_assembler.py`
- Modify: `tests/unit/services/test_turn_context_assembler.py`
- Modify: `tests/unit/services/test_instruction_contract_assembler.py`

- [ ] **Step 1: Update context tests to expect equal toolset text**

In `tests/unit/services/test_turn_context_assembler.py`, replace assertions that expect `Direct tools:` and `Deferred tools:` with:

```python
    assert "Available tools: list_directory, read_file_range, search_text" in turn_context.sections[8].content
    assert "Direct tools:" not in turn_context.sections[8].content
    assert "Deferred tools:" not in turn_context.sections[8].content
```

In `tests/unit/services/test_instruction_contract_assembler.py`, add an assertion to the tool exposure test:

```python
    assert "工具没有 direct/deferred 等等级之分" in contract.developer_sections[0].content
```

- [ ] **Step 2: Run context tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/services/test_turn_context_assembler.py tests/unit/services/test_instruction_contract_assembler.py -q
```

Expected: FAIL because current rendering still emits `Direct tools:` / `Deferred tools:`.

- [ ] **Step 3: Update tool exposure rendering**

Modify `_render_tool_exposure()` in `src/mycli/services/context/turn_context_assembler.py` to:

```python
    def _render_tool_exposure(self, context: ExecutionContext) -> str:
        if context.tool_exposure is not None:
            summary = context.tool_exposure.summary()
            tool_names = summary["direct"] + summary["deferred"] + summary["dynamic"]
            tools = ", ".join(dict.fromkeys(tool_names)) or "none"
            dynamic = self._render_dynamic_tools(context)
            if dynamic == "none":
                return f"Available tools: {tools}"
            return f"Available tools: {tools}\nDynamic tools: {dynamic}"
        tools = ", ".join(context.available_tool_names) or "none"
        return f"Available tools: {tools}"
```

Modify `_tool_exposure_fragment()` in `src/mycli/services/context/instruction_contract_assembler.py` to:

```python
    def _tool_exposure_fragment(self, section: TurnContextSection) -> InstructionFragment:
        metadata = dict(section.metadata)
        metadata.pop("dynamic_tools", None)
        return InstructionFragment(
            kind=InstructionFragmentKind.TOOL_EXPOSURE,
            title=section.title,
            content=(
                "本轮只使用已暴露且可调用的工具。工具没有 direct/deferred 等等级之分；"
                "能用专门工具解决时，优先不要退化成临时 shell 操作。\n"
                f"{section.content}"
            ),
            source=section.source,
            metadata=metadata,
            include_in_memory=False,
        )
```

- [ ] **Step 4: Run context tests and verify they pass**

Run:

```bash
uv run pytest tests/unit/services/test_turn_context_assembler.py tests/unit/services/test_instruction_contract_assembler.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit level-free context rendering**

Run:

```bash
git add src/mycli/services/context/turn_context_assembler.py src/mycli/services/context/instruction_contract_assembler.py tests/unit/services/test_turn_context_assembler.py tests/unit/services/test_instruction_contract_assembler.py
git commit -m "Render tool context without hierarchy labels" \
  -m "Tool context now describes a single equal available toolset instead of direct/deferred groups, matching Runtime v2's level-free tool model." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: uv run pytest tests/unit/services/test_turn_context_assembler.py tests/unit/services/test_instruction_contract_assembler.py -q"
```

## Task 5: Add Phase 2 Documentation Linkage

**Files:**
- Modify: `docs/superpowers/specs/2026-04-29-runtime-v2-cache-first-architecture-design.md`
- Modify: `docs/superpowers/plans/2026-04-30-runtime-v2-phase2-equal-toolset.md`

- [ ] **Step 1: Add Phase 2 status note to the design**

Add this paragraph after the existing Phase 1 implementation note in `docs/superpowers/specs/2026-04-29-runtime-v2-cache-first-architecture-design.md`:

```markdown
Phase 2 replaces prompt-visible tool hierarchy with an equal `ToolSet`, stabilizes model-visible tool schema ordering, and keeps execution safety outside schema visibility. It preserves compatibility with existing runtime containers while removing direct/deferred/recommended language from agent-facing context.
```

- [ ] **Step 2: Add dependency note to this plan**

Add this paragraph under this plan's Scope Check section:

```markdown
Phase 2 depends on Phase 1 only for the architectural direction and diagnostics vocabulary. It does not require live `RequestShape` integration yet.
```

- [ ] **Step 3: Review docs diff**

Run:

```bash
git diff -- docs/superpowers/specs/2026-04-29-runtime-v2-cache-first-architecture-design.md docs/superpowers/plans/2026-04-30-runtime-v2-phase2-equal-toolset.md
```

Expected: diff shows only the two documentation notes above.

- [ ] **Step 4: Commit documentation linkage**

Run:

```bash
git add docs/superpowers/specs/2026-04-29-runtime-v2-cache-first-architecture-design.md docs/superpowers/plans/2026-04-30-runtime-v2-phase2-equal-toolset.md
git commit -m "Document runtime v2 equal toolset phase" \
  -m "Runtime v2 phase two removes prompt-visible tool hierarchy and records ToolSet as the equal model-visible tool contract." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: git diff review of documentation-only changes"
```

## Task 6: Run Phase 2 Verification

**Files:**
- Verify: `src/mycli/domain/tool_set.py`
- Verify: `src/mycli/services/tool_router.py`
- Verify: `src/mycli/services/tool_exposure_planner.py`
- Verify: context assembler files and related tests

- [ ] **Step 1: Run focused Phase 2 tests**

Run:

```bash
uv run pytest tests/unit/domain/test_tool_set.py tests/unit/services/test_tool_router.py tests/unit/services/test_tool_exposure_planner.py tests/unit/services/test_turn_context_assembler.py tests/unit/services/test_instruction_contract_assembler.py -q
```

Expected: PASS.

- [ ] **Step 2: Run targeted lint**

Run:

```bash
uv run ruff check src/mycli/domain/tool_set.py src/mycli/services/tool_router.py src/mycli/services/tool_exposure_planner.py src/mycli/services/context/turn_context_assembler.py src/mycli/services/context/instruction_contract_assembler.py tests/unit/domain/test_tool_set.py tests/unit/services/test_tool_router.py tests/unit/services/test_tool_exposure_planner.py tests/unit/services/test_turn_context_assembler.py tests/unit/services/test_instruction_contract_assembler.py
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
git add src/mycli/domain/tool_set.py src/mycli/services/tool_router.py src/mycli/services/tool_exposure_planner.py src/mycli/services/context/turn_context_assembler.py src/mycli/services/context/instruction_contract_assembler.py tests/unit/domain/test_tool_set.py tests/unit/services/test_tool_router.py tests/unit/services/test_tool_exposure_planner.py tests/unit/services/test_turn_context_assembler.py tests/unit/services/test_instruction_contract_assembler.py
git commit -m "Stabilize runtime v2 equal toolset verification" \
  -m "Focused tests, lint, typecheck, and full suite now pass for ToolSet, stable schema ordering, equal static exposure, and level-free tool context." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run ruff check targeted files; uv run mypy; uv run pytest"
```

If verification required no changes, do not create an empty commit.

## Self-Review

Spec coverage:

- Equal model-visible toolset is covered by Tasks 1, 2, 3, and 4.
- Stable tool schema ordering is covered by Tasks 1 and 2.
- Removing direct/deferred/recommended agent-facing language is covered by Tasks 3 and 4.
- Execution compatibility is covered by Task 2 because `ToolRouter.execute()` is intentionally unchanged.
- Documentation linkage is covered by Task 5.
- Verification is covered by Task 6.
- Approval migration, dynamic tool lifecycle redesign, and live RequestShape integration are intentionally deferred.

Placeholder scan:

- This plan contains no placeholder markers or unspecified implementation steps.
- Each code-changing task includes exact file paths, code, commands, and expected results.

Type consistency:

- `ToolSet` and `ToolSetEntry` are defined before use.
- `ToolRouter.render_for_model()` depends only on `ToolSet.from_exposure()`, which Task 1 defines.
- The context rendering snippets match the existing assembler method names.
