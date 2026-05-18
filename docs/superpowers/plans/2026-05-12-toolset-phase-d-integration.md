# Toolset Redesign — Phase D: Integration & Cleanup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rename 7 old tools, delete 11 deprecated tools, register 15 new tools into ToolRegistry, and run full test suite.

**Architecture:** Phased refactor: rename first (update imports throughout), then delete deprecated, then register all new tools and verify.

**Tech Stack:** Python 3.12+, pytest, ripgrep for import search.

**Prerequisite:** Phase A, B, C complete.

---

### Task D1: Rename old tools

**Files:**
- Delete: `src/mycli/tools/read_file.py` (replaced by `read/` package — dispatcher + text handler)
- Delete: `src/mycli/tools/read_file_range.py` (replaced by Read offset/limit params)
- Rename: `src/mycli/tools/edit_file.py` → `src/mycli/tools/edit.py`
- Rename: `src/mycli/tools/write_file.py` → `src/mycli/tools/write.py`
- Rename: `src/mycli/tools/search_text.py` → `src/mycli/tools/grep.py`
- Rename: `src/mycli/tools/list_directory.py` → `src/mycli/tools/ls.py`
- Rename: `src/mycli/tools/run_shell.py` → `src/mycli/tools/bash.py`
- Rename: `src/mycli/tools/update_plan.py` → `src/mycli/tools/plan.py`

注意：`read_file.py` 不能重命名为 `read.py`——Phase A 已创建 `read/` 目录。同目录下不能同时存在 `read/` 目录和 `read.py` 文件。旧 `read_file.py` 的功能由 `read/__init__.py`（dispatcher）+ `read/text.py`（文本处理器）替代，直接删除。

- [ ] **Step 1: Rename + delete files**

```bash
cd src/mycli/tools
git rm read_file.py read_file_range.py
git mv edit_file.py edit.py
git mv write_file.py write.py
git mv search_text.py grep.py
git mv list_directory.py ls.py
git mv run_shell.py bash.py
git mv update_plan.py plan.py
```

- [ ] **Step 2: Update all imports across codebase**

Run: `rg "from mycli.tools.(read_file|read_file_range|edit_file|write_file|search_text|list_directory|run_shell|update_plan)" src/ --files-with-matches`

Expected: List of files needing import updates.

For deleted `read_file`/`read_file_range`: update imports to `from mycli.tools.read import read_file`.
For renamed files: update to the new module name (e.g. `mycli.tools.edit`, `mycli.tools.grep`).

- [ ] **Step 3: Update tool registry references**

In `src/mycli/tools/registry.py` (or wherever tools are registered), update all references from old names to new names.

- [ ] **Step 4: Run tests**

Run: `pytest tests/ -x -q`
Expected: All previously passing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/ src/ tests/
git commit -m "refactor: rename tools to Claude Code naming convention

read_file→Read, edit_file→Edit, write_file→Write,
search_text→Grep, list_directory→LS, run_shell→Bash, update_plan→Plan"
```

---

### Task D2: Delete deprecated tools

**Files to delete:**
- `src/mycli/tools/replace_in_file.py` — merged into Edit
- `src/mycli/tools/append_file.py` — merged into Edit
- `src/mycli/tools/create_file.py` — merged into Write
- `src/mycli/tools/delete_path.py` — Bash
- `src/mycli/tools/move_path.py` — Bash
- `src/mycli/tools/mkdir.py` — Bash
- `src/mycli/tools/git_diff.py` — Bash
- `src/mycli/tools/git_log.py` — Bash
- `src/mycli/tools/git_status.py` — Bash
- `src/mycli/tools/filesystem.py` — removed (functionality moved to Bash)

- [ ] **Step 1: Delete files**

```bash
cd src/mycli/tools
git rm replace_in_file.py append_file.py create_file.py \
       delete_path.py move_path.py mkdir.py git_diff.py git_log.py git_status.py \
       filesystem.py
```

- [ ] **Step 2: Search for stale imports**

Run: `rg "from mycli.tools.(replace_in_file|append_file|create_file|delete_path|move_path|mkdir|git_diff|git_log|git_status|filesystem)" src/ --files-with-matches`

Expected: No results (or fix remaining references).

- [ ] **Step 3: Remove from tool registry**

Remove deleted tool registrations from `src/mycli/tools/registry.py`.

- [ ] **Step 4: Run tests**

Run: `pytest tests/ -x -q`
Expected: PASS. No import errors referencing deleted modules.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/ tests/
git commit -m "refactor: remove 11 deprecated tools

File ops (rm, mv, mkdir) → Bash. Git tools → Bash.
Edit tools (replace, append, create) → Edit/Write.
read_file_range → Read offset/limit params."
```

---

### Task D3: Register all new tools

**Files:**
- Modify: `src/mycli/tools/registry.py`

- [ ] **Step 1: Update ToolRegistry with all 15 tools**

```python
# In ToolRegistry initialization:
from mycli.tools.read import ReadTool
from mycli.tools.edit import EditTool
from mycli.tools.write import WriteTool
from mycli.tools.grep import GrepTool
from mycli.tools.glob import GlobTool
from mycli.tools.ls import LSTool
from mycli.tools.bash import BashTool
from mycli.tools.kill_shell import KillShellTool
from mycli.tools.web_search import WebSearchTool
from mycli.tools.web_fetch import WebFetchTool
from mycli.tools.lint import LintTool
from mycli.tools.ask_user_question import AskUserQuestionTool
from mycli.tools.plan import PlanTool
from mycli.tools.plan_mode import EnterPlanModeTool, ExitPlanModeTool

self.register(ReadTool())
self.register(EditTool())
self.register(WriteTool())
self.register(GrepTool())
self.register(GlobTool())
self.register(LSTool())
self.register(BashTool())
self.register(KillShellTool())
self.register(WebSearchTool())
self.register(WebFetchTool())
self.register(LintTool())
self.register(AskUserQuestionTool())
self.register(PlanTool())
self.register(EnterPlanModeTool())
self.register(ExitPlanModeTool())
```

- [ ] **Step 2: Update concurrency safety config**

In `src/mycli/application/runtime/tools/tool_execution_service.py`:
```python
CONCURRENCY_SAFE_TOOLS = {
    "Read", "Grep", "Glob", "LS",
    "WebSearch", "WebFetch",
    "Lint",
}
```

- [ ] **Step 3: Run full integration test**

Run: `pytest tests/unit/ tests/integration/ -x -q`
Expected: PASS. All 15 tools import and instantiate correctly.

- [ ] **Step 4: Commit**

```bash
git add src/mycli/tools/registry.py src/mycli/application/runtime/tools/tool_execution_service.py
git commit -m "feat: register all 15 redesigned tools in ToolRegistry

Read Edit Write Grep Glob LS Bash KillShell
WebSearch WebFetch Lint AskUserQuestion
Plan EnterPlanMode ExitPlanMode"
```

---

### Task D4: End-to-end smoke test

- [ ] **Step 1: Write tool-import smoke test**

```python
# tests/integration/test_toolset_smoke.py
def test_all_tools_importable():
    from mycli.tools.read import ReadTool
    from mycli.tools.edit import EditTool
    from mycli.tools.write import WriteTool
    from mycli.tools.grep import GrepTool
    from mycli.tools.glob import GlobTool
    from mycli.tools.ls import LSTool
    from mycli.tools.bash import BashTool
    from mycli.tools.kill_shell import KillShellTool
    from mycli.tools.web_search import WebSearchTool
    from mycli.tools.web_fetch import WebFetchTool
    from mycli.tools.lint import LintTool
    from mycli.tools.ask_user_question import AskUserQuestionTool
    from mycli.tools.plan import PlanTool
    from mycli.tools.plan_mode import EnterPlanModeTool, ExitPlanModeTool
    # All imported — no ImportError

def test_all_tools_registered():
    from mycli.tools.registry import ToolRegistryV2
    registry = ToolRegistryV2()
    names = [t.name for t in registry.list_all()]
    expected = {
        "Read", "Edit", "Write", "Grep", "Glob", "LS",
        "Bash", "KillShell", "WebSearch", "WebFetch",
        "Lint", "AskUserQuestion", "Plan",
        "EnterPlanMode", "ExitPlanMode",
    }
    assert set(names) == expected
```

- [ ] **Step 2: Run smoke test**

Run: `pytest tests/integration/test_toolset_smoke.py -v`
Expected: PASS (2 tests)

- [ ] **Step 3: Commit**

```bash
git add tests/integration/test_toolset_smoke.py
git commit -m "test: add toolset smoke test — all 15 tools importable and registered"
```

---

## Phase D Completion Check

- [ ] All 7 old tools renamed with git mv
- [ ] All imports updated, no stale references
- [ ] 11 deprecated tools deleted
- [ ] All 15 tools registered in ToolRegistryV2
- [ ] `pytest tests/ -x -q` passes with 0 errors
- [ ] Smoke test confirms all tools importable
