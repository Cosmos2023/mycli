# Standard Skill Directory Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load Agent Skills from direct-child `SKILL.md` directories and repository `.agents/skills` while preserving all existing flat skill behavior.

**Architecture:** Extend `SkillRegistry` with one optional shared repository root and deterministic candidate discovery for both supported formats. Keep parsing, lazy loading, diagnostics, and overwrite behavior in the registry, then pass the shared root through each production composition path.

**Tech Stack:** Python 3.13, `pathlib`, pytest, Ruff, mypy

---

### Task 1: Directory-Based Skill Discovery

**Files:**
- Modify: `src/mycli/services/skills/registry.py`
- Test: `tests/unit/services/test_skill_registry.py`

- [ ] **Step 1: Write failing registry tests**

Add tests that create `skills/<name>/SKILL.md`, a nested `references/ignored.md`, and same-name definitions across built-in, user, shared repository, and mycli repository roots. Assert that only direct `SKILL.md` entries load, directory form overrides same-source flat form, and precedence is `repo > shared_repo > user > builtin`.

- [ ] **Step 2: Run the registry tests and verify RED**

Run:

```bash
./.venv/bin/pytest tests/unit/services/test_skill_registry.py -q
```

Expected: new tests fail because `shared_repo_root` and directory discovery do not exist.

- [ ] **Step 3: Implement deterministic candidate discovery**

Change the constructor to accept:

```python
def __init__(
    self,
    builtin_root: Path,
    user_root: Path,
    *,
    shared_repo_root: Path | None = None,
    repo_root: Path | None = None,
) -> None:
```

Build `_directories` in low-to-high precedence order and replace the flat-only glob with a helper returning:

```python
(*sorted(root.glob("*.md")), *sorted(root.glob("*/SKILL.md")))
```

Keep duplicate tracking unchanged so collisions in either format remain diagnosable.

- [ ] **Step 4: Run registry tests and verify GREEN**

Run:

```bash
./.venv/bin/pytest tests/unit/services/test_skill_registry.py -q
```

Expected: all registry tests pass.

- [ ] **Step 5: Commit registry behavior**

```bash
git add src/mycli/services/skills/registry.py tests/unit/services/test_skill_registry.py
git commit -m "feat: discover directory-based skills"
```

### Task 2: Shared Repository Skill Wiring

**Files:**
- Modify: `src/mycli/cli/bootstrap.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/services/diagnostics/doctor.py`
- Test: `tests/unit/cli/test_main.py`
- Test: `tests/unit/services/test_doctor_service.py`

- [ ] **Step 1: Write failing composition tests**

Add a CLI bootstrap test with `.agents/skills/shared-skill/SKILL.md` and assert the runtime registry loads `shared-skill`. Extend doctor coverage to place an invalid standard skill at `.agents/skills/broken/SKILL.md` and assert the skill check reports it without leaking body text.

- [ ] **Step 2: Run composition tests and verify RED**

Run:

```bash
./.venv/bin/pytest tests/unit/cli/test_main.py tests/unit/services/test_doctor_service.py -q -k skill
```

Expected: shared repository skills are absent from runtime and doctor discovery.

- [ ] **Step 3: Wire the shared root through production constructors**

Pass this argument at every default `SkillRegistry` construction:

```python
shared_repo_root=workspace_root / ".agents" / "skills"
```

Use the local workspace expression already available in each file (`config.workspace_root` or `self._workspace_root`) and leave explicitly injected test registries unchanged.

- [ ] **Step 4: Run composition tests and verify GREEN**

Run:

```bash
./.venv/bin/pytest tests/unit/cli/test_main.py tests/unit/services/test_doctor_service.py -q -k skill
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit production wiring**

```bash
git add src/mycli/cli/bootstrap.py src/mycli/application/runtime/agent_runtime.py src/mycli/application/turn_service.py src/mycli/services/diagnostics/doctor.py tests/unit/cli/test_main.py tests/unit/services/test_doctor_service.py
git commit -m "feat: load shared repository skills"
```

### Task 3: Documentation And Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update skill location documentation**

Document directory-form skills as preferred at `.agents/skills/<name>/SKILL.md`, `.mycli/skills/<name>/SKILL.md`, and `~/.mycli/skills/<name>/SKILL.md`. State that flat `*.md` files remain supported for compatibility and list the effective precedence.

- [ ] **Step 2: Run focused and static verification**

Run:

```bash
./.venv/bin/pytest tests/unit/services/test_skill_registry.py tests/unit/services/test_skill_catalog.py tests/unit/tools/test_skill_tool.py tests/unit/application/test_skill_tool_lifecycle.py tests/unit/cli/test_main.py tests/unit/services/test_doctor_service.py -q
./.venv/bin/ruff check src/mycli/services/skills/registry.py src/mycli/cli/bootstrap.py src/mycli/application/runtime/agent_runtime.py src/mycli/application/turn_service.py src/mycli/services/diagnostics/doctor.py tests/unit/services/test_skill_registry.py tests/unit/cli/test_main.py tests/unit/services/test_doctor_service.py
./.venv/bin/mypy src/mycli
```

Expected: pytest, Ruff, and mypy all pass.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md
git commit -m "docs: document standard skill directories"
```

