# mycli File Edit Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured file-editing tools plus `rg`-style keyword search to `mycli` so the runtime can inspect snippets, search text precisely, append text, and perform exact in-file replacements without defaulting to `run_shell`.

**Architecture:** Introduce a shared workspace-path helper for file tools, upgrade `search_text` toward `rg` semantics, then add three focused tools: `read_file_range`, `append_file`, and `replace_in_file`. Wire them into the registry, safety policy, prompts, CLI inspection output, and docs so the model prefers these tools before `edit_file` and only falls back to `run_shell` when needed.

**Tech Stack:** Python 3.13, standard library `pathlib`/`dataclasses`/`difflib`, existing schema-based tools, `pytest`, `ruff`, `mypy`

---

## Scope Check

This plan only covers the first batch approved in [2026-04-05-mycli-file-edit-tools-design.md](/Users/cosmos/Desktop/mycli/docs/superpowers/specs/2026-04-05-mycli-file-edit-tools-design.md): `read_file_range`, `append_file`, `replace_in_file`, plus `rg`-style `search_text` enhancement and the shared safety/prompt/docs wiring. It does not include file management tools such as `create_file`, `mkdir`, `move`, or `delete`.

## File Structure

- Create: `src/mycli/tools/filesystem.py`
  Shared helpers for resolving workspace-relative text-file paths safely.
- Create: `src/mycli/tools/read_file_range.py`
  Reads inclusive line ranges from UTF-8 files.
- Modify: `src/mycli/tools/search_text.py`
  Expands keyword search to cover common `rg`-style filters and bounded structured results.
- Create: `src/mycli/tools/append_file.py`
  Appends UTF-8 text to files, creating the file when appropriate.
- Create: `src/mycli/tools/replace_in_file.py`
  Performs exact literal replacements with optional occurrence-count assertions.
- Modify: `src/mycli/cli/main.py`
  Registers the new tools in the default tool registry.
- Modify: `src/mycli/services/safety_policy.py`
  Classifies the new tools and gives them readable previews.
- Modify: `src/mycli/prompts/react.py`
  Prefers structured file-editing tools before `edit_file` and `run_shell`.
- Modify: `README.md`
  Documents the expanded toolset and usage philosophy.
- Create: `tests/unit/tools/test_file_editing_tools.py`
  Covers happy paths and error cases for `read_file_range`, `append_file`, and `replace_in_file`.
- Modify: `tests/unit/tools/test_read_only_tools.py`
  Covers upgraded `search_text` behavior and keeps read-only tool guarantees stable.
- Modify: `tests/unit/tools/test_tool_registry_v2.py`
  Verifies schema validation and registration remain stable with the new tools.
- Modify: `tests/unit/tools/test_run_shell.py`
  Verifies shell remains the high-risk fallback and does not change classification.
- Modify: `tests/unit/cli/test_main.py`
  Verifies `/tools` and runtime wiring include the new tool names.
- Modify: `tests/unit/prompts/test_prompts.py`
  Verifies the prompt text nudges the model toward specialized file-editing tools.

## Task 1: Add Shared Path Guards and `read_file_range`

**Files:**
- Create: `src/mycli/tools/filesystem.py`
- Create: `src/mycli/tools/read_file_range.py`
- Create: `tests/unit/tools/test_file_editing_tools.py`

- [ ] **Step 1: Write the failing tests for path guarding and range reads**

```python
from pathlib import Path

from mycli.domain.tools import ToolCall
from mycli.tools.read_file_range import ReadFileRangeTool


def test_read_file_range_reads_inclusive_line_slice(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "notes.txt").write_text("a\nb\nc\nd\n", encoding="utf-8")

    tool = ReadFileRangeTool(root)
    result = tool.run(
        ToolCall(
            name="read_file_range",
            arguments={"path": "notes.txt", "start_line": 2, "end_line": 3},
            reason="inspect snippet",
        )
    )

    assert result.success is True
    assert result.raw_payload["content"] == "b\nc\n"
    assert result.raw_payload["actual_start_line"] == 2
    assert result.raw_payload["actual_end_line"] == 3


def test_read_file_range_rejects_workspace_escape(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()

    tool = ReadFileRangeTool(root)
    result = tool.run(
        ToolCall(
            name="read_file_range",
            arguments={"path": "../secret.txt", "start_line": 1, "end_line": 1},
            reason="inspect snippet",
        )
    )

    assert result.success is False
    assert "workspace" in result.error.lower()
```

- [ ] **Step 2: Run the tests to verify they fail for the right reason**

Run: `uv run pytest tests/unit/tools/test_file_editing_tools.py -k read_file_range -v`

Expected: FAIL with `ModuleNotFoundError` or missing `ReadFileRangeTool`

- [ ] **Step 3: Add a shared filesystem helper for safe workspace-relative file resolution**

```python
# src/mycli/tools/filesystem.py
from __future__ import annotations

from pathlib import Path


def resolve_workspace_path(workspace_root: Path, raw_path: str) -> Path:
    candidate = (workspace_root / raw_path).resolve()
    root = workspace_root.resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError("Path must stay within the current workspace.")
    return candidate


def require_text_file(path: Path) -> None:
    if path.exists() and path.is_dir():
        raise ValueError("Expected a file path, got a directory.")
```

- [ ] **Step 4: Implement `ReadFileRangeTool` with stable success/error results**

```python
# src/mycli/tools/read_file_range.py
from __future__ import annotations

from mycli.domain.tools import ToolCall, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.filesystem import require_text_file, resolve_workspace_path


class ReadFileRangeTool:
    name = "read_file_range"
    spec = ToolSpec(
        name="read_file_range",
        description="Read an inclusive line range from a UTF-8 text file in the workspace.",
        parameters=(
            ToolParameter(name="path", type="string", required=True),
            ToolParameter(name="start_line", type="integer", required=True),
            ToolParameter(name="end_line", type="integer", required=True),
        ),
        risk_level="low",
    )

    def __init__(self, workspace_root):
        self._workspace_root = workspace_root

    def execute(self, arguments):
        try:
            start_line = int(arguments["start_line"])
            end_line = int(arguments["end_line"])
            if start_line < 1 or end_line < start_line:
                raise ValueError("Line range must be 1-based and end_line >= start_line.")
            path = str(arguments["path"])
            target = resolve_workspace_path(self._workspace_root, path)
            require_text_file(target)
            content = target.read_text(encoding="utf-8")
        except (KeyError, ValueError, OSError, UnicodeDecodeError) as exc:
            return ToolResultV2(success=False, summary="Failed to read file range", error=str(exc))

        lines = content.splitlines(keepends=True)
        snippet = "".join(lines[start_line - 1:end_line])
        return ToolResultV2(
            success=True,
            summary=f"Read lines {start_line}-{end_line} from {path}",
            raw_payload={
                "path": path,
                "start_line": start_line,
                "end_line": end_line,
                "actual_start_line": start_line,
                "actual_end_line": min(end_line, len(lines)),
                "content": snippet,
            },
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
```

- [ ] **Step 5: Re-run the targeted tests and keep them green**

Run: `uv run pytest tests/unit/tools/test_file_editing_tools.py -k read_file_range -v`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/mycli/tools/filesystem.py src/mycli/tools/read_file_range.py tests/unit/tools/test_file_editing_tools.py
git commit -m "feat: add safe file range reader"
```

## Task 2: Upgrade `search_text` to Cover Common `rg` Workflows

**Files:**
- Modify: `src/mycli/tools/search_text.py`
- Modify: `tests/unit/tools/test_read_only_tools.py`

- [ ] **Step 1: Write the failing tests for scoped keyword search**

```python
from mycli.tools.search_text import SearchTextTool


def test_search_text_supports_path_and_glob_filters(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    (root / "src").mkdir(parents=True)
    (root / "docs").mkdir()
    (root / "src" / "app.py").write_text("TOKEN = 'abc'\n", encoding="utf-8")
    (root / "docs" / "notes.md").write_text("token mention\n", encoding="utf-8")

    tool = SearchTextTool(root)
    result = tool.run(
        ToolCall(
            name="search_text",
            arguments={"query": "TOKEN", "path": "src", "glob": "*.py"},
            reason="rg for token in source",
        )
    )

    assert result.success is True
    assert len(result.raw_payload["matches"]) == 1
    assert result.raw_payload["matches"][0]["path"] == "src/app.py"


def test_search_text_supports_case_sensitive_matching(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("Token\ntoken\n", encoding="utf-8")

    tool = SearchTextTool(root)
    result = tool.run(
        ToolCall(
            name="search_text",
            arguments={"query": "Token", "case_sensitive": True},
            reason="rg with case sensitivity",
        )
    )

    assert result.success is True
    assert len(result.raw_payload["matches"]) == 1
    assert result.raw_payload["matches"][0]["line"] == "Token"
```

- [ ] **Step 2: Run the read-only tests to confirm the new expectations fail**

Run: `uv run pytest tests/unit/tools/test_read_only_tools.py -k search_text -v`

Expected: FAIL because `search_text` does not yet support `path`, `glob`, or `case_sensitive`

- [ ] **Step 3: Implement `rg`-style filters in `SearchTextTool` without exposing raw shell**

```python
# src/mycli/tools/search_text.py
class SearchTextTool:
    spec = ToolSpec(
        name="search_text",
        description="Search UTF-8 text files in the workspace with rg-style filters.",
        parameters=(
            ToolParameter(name="query", type="string", required=True),
            ToolParameter(name="path", type="string", required=False),
            ToolParameter(name="glob", type="string", required=False),
            ToolParameter(name="case_sensitive", type="boolean", required=False),
            ToolParameter(name="max_matches", type="integer", required=False),
        ),
        risk_level="low",
    )

    def execute(self, arguments):
        query = str(arguments["query"])
        search_root = resolve_workspace_path(
            self._workspace_root,
            str(arguments.get("path", ".")),
        )
        glob_pattern = str(arguments.get("glob", "**/*"))
        case_sensitive = bool(arguments.get("case_sensitive", False))
        max_matches = int(arguments.get("max_matches", 200))
        ...
```

- [ ] **Step 4: Run the read-only tool suite and keep existing search behavior green**

Run: `uv run pytest tests/unit/tools/test_read_only_tools.py -v`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/search_text.py tests/unit/tools/test_read_only_tools.py
git commit -m "feat: upgrade search text with rg-style filters"
```

## Task 3: Add `append_file`

**Files:**
- Modify: `tests/unit/tools/test_file_editing_tools.py`
- Create: `src/mycli/tools/append_file.py`

- [ ] **Step 1: Write the failing append tests**

```python
from mycli.tools.append_file import AppendFileTool


def test_append_file_appends_text_to_existing_file(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "notes.txt").write_text("hello", encoding="utf-8")

    tool = AppendFileTool(root)
    result = tool.run(
        ToolCall(
            name="append_file",
            arguments={"path": "notes.txt", "content": " world"},
            reason="update note",
        )
    )

    assert result.success is True
    assert (root / "notes.txt").read_text(encoding="utf-8") == "hello world"
    assert result.raw_payload["created"] is False


def test_append_file_creates_missing_file_when_parent_exists(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()

    tool = AppendFileTool(root)
    result = tool.run(
        ToolCall(
            name="append_file",
            arguments={"path": "new.txt", "content": "hello\n"},
            reason="create note",
        )
    )

    assert result.success is True
    assert (root / "new.txt").read_text(encoding="utf-8") == "hello\n"
    assert result.raw_payload["created"] is True
```

- [ ] **Step 2: Run the append tests to confirm they fail**

Run: `uv run pytest tests/unit/tools/test_file_editing_tools.py -k append_file -v`

Expected: FAIL with `ModuleNotFoundError` or missing `AppendFileTool`

- [ ] **Step 3: Implement `AppendFileTool` using the shared path guard**

```python
# src/mycli/tools/append_file.py
from __future__ import annotations

from mycli.domain.tools import ToolCall, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.filesystem import require_text_file, resolve_workspace_path


class AppendFileTool:
    name = "append_file"
    spec = ToolSpec(
        name="append_file",
        description="Append UTF-8 text content to a workspace file, creating it if needed.",
        parameters=(
            ToolParameter(name="path", type="string", required=True),
            ToolParameter(name="content", type="string", required=True),
        ),
        risk_level="medium",
    )

    def __init__(self, workspace_root):
        self._workspace_root = workspace_root

    def execute(self, arguments):
        try:
            path = str(arguments["path"])
            content = arguments["content"]
            if not isinstance(content, str):
                raise ValueError("append_file requires string content.")
            target = resolve_workspace_path(self._workspace_root, path)
            if not target.parent.exists():
                raise ValueError("Parent directory does not exist.")
            require_text_file(target)
            before = target.read_text(encoding="utf-8") if target.exists() else ""
            target.write_text(before + content, encoding="utf-8")
        except (KeyError, ValueError, OSError, UnicodeDecodeError) as exc:
            return ToolResultV2(success=False, summary="Failed to append file", error=str(exc))

        after = before + content
        return ToolResultV2(
            success=True,
            summary=f"Appended {len(content)} chars to {path}",
            raw_payload={
                "path": path,
                "created": before == "",
                "before_size": len(before),
                "after_size": len(after),
                "appended_chars": len(content),
            },
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
```

- [ ] **Step 4: Run the append tests and the existing edit tool test**

Run: `uv run pytest tests/unit/tools/test_file_editing_tools.py -k append_file -v tests/unit/tools/test_edit_file_tool.py -v`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/append_file.py tests/unit/tools/test_file_editing_tools.py
git commit -m "feat: add append file tool"
```

## Task 4: Add `replace_in_file`

**Files:**
- Modify: `tests/unit/tools/test_file_editing_tools.py`
- Create: `src/mycli/tools/replace_in_file.py`

- [ ] **Step 1: Write the failing replacement tests**

```python
from mycli.tools.replace_in_file import ReplaceInFileTool


def test_replace_in_file_replaces_exact_text(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "config.txt").write_text("mode=dev\n", encoding="utf-8")

    tool = ReplaceInFileTool(root)
    result = tool.run(
        ToolCall(
            name="replace_in_file",
            arguments={
                "path": "config.txt",
                "old_text": "mode=dev",
                "new_text": "mode=prod",
                "expected_count": 1,
            },
            reason="promote config",
        )
    )

    assert result.success is True
    assert (root / "config.txt").read_text(encoding="utf-8") == "mode=prod\n"
    assert result.raw_payload["replacement_count"] == 1


def test_replace_in_file_refuses_mismatched_expected_count(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "config.txt").write_text("x\nx\n", encoding="utf-8")

    tool = ReplaceInFileTool(root)
    result = tool.run(
        ToolCall(
            name="replace_in_file",
            arguments={
                "path": "config.txt",
                "old_text": "x",
                "new_text": "y",
                "expected_count": 1,
            },
            reason="replace exact count",
        )
    )

    assert result.success is False
    assert "expected_count" in result.error
    assert (root / "config.txt").read_text(encoding="utf-8") == "x\nx\n"
```

- [ ] **Step 2: Run the replacement tests to confirm they fail**

Run: `uv run pytest tests/unit/tools/test_file_editing_tools.py -k replace_in_file -v`

Expected: FAIL with `ModuleNotFoundError` or missing `ReplaceInFileTool`

- [ ] **Step 3: Implement `ReplaceInFileTool` with literal replacement and diff output**

```python
# src/mycli/tools/replace_in_file.py
from __future__ import annotations

from difflib import unified_diff

from mycli.domain.tools import ToolCall, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.filesystem import require_text_file, resolve_workspace_path


class ReplaceInFileTool:
    name = "replace_in_file"
    spec = ToolSpec(
        name="replace_in_file",
        description="Replace exact text in a workspace file with optional match-count validation.",
        parameters=(
            ToolParameter(name="path", type="string", required=True),
            ToolParameter(name="old_text", type="string", required=True),
            ToolParameter(name="new_text", type="string", required=True),
            ToolParameter(name="expected_count", type="integer", required=False),
        ),
        risk_level="medium",
    )

    def __init__(self, workspace_root):
        self._workspace_root = workspace_root

    def execute(self, arguments):
        try:
            path = str(arguments["path"])
            old_text = arguments["old_text"]
            new_text = arguments["new_text"]
            expected_count = arguments.get("expected_count")
            if not isinstance(old_text, str) or not old_text:
                raise ValueError("replace_in_file requires a non-empty old_text string.")
            if not isinstance(new_text, str):
                raise ValueError("replace_in_file requires string new_text.")
            if expected_count is not None:
                expected_count = int(expected_count)
            target = resolve_workspace_path(self._workspace_root, path)
            require_text_file(target)
            before = target.read_text(encoding="utf-8")
            replacement_count = before.count(old_text)
            if replacement_count == 0:
                raise ValueError("old_text was not found in the target file.")
            if expected_count is not None and replacement_count != expected_count:
                raise ValueError("expected_count does not match the number of occurrences.")
            after = before.replace(old_text, new_text)
            diff = "".join(
                unified_diff(
                    before.splitlines(keepends=True),
                    after.splitlines(keepends=True),
                    fromfile=path,
                    tofile=path,
                )
            )
            target.write_text(after, encoding="utf-8")
        except (KeyError, ValueError, OSError, UnicodeDecodeError) as exc:
            return ToolResultV2(success=False, summary="Failed to replace text in file", error=str(exc))

        return ToolResultV2(
            success=True,
            summary=f"Replaced {replacement_count} occurrence in {path}",
            raw_payload={"path": path, "replacement_count": replacement_count, "diff": diff},
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
```

- [ ] **Step 4: Run the replacement tests and keep the whole file-edit suite green**

Run: `uv run pytest tests/unit/tools/test_file_editing_tools.py -v`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/replace_in_file.py tests/unit/tools/test_file_editing_tools.py
git commit -m "feat: add precise replace file tool"
```

## Task 5: Wire New Tools Into Runtime, Prompting, and Docs

**Files:**
- Modify: `src/mycli/cli/main.py`
- Modify: `src/mycli/services/safety_policy.py`
- Modify: `src/mycli/prompts/react.py`
- Modify: `README.md`
- Modify: `tests/unit/cli/test_main.py`
- Modify: `tests/unit/prompts/test_prompts.py`
- Modify: `tests/unit/tools/test_run_shell.py`

- [ ] **Step 1: Write the failing wiring tests**

```python
def test_build_turn_service_registers_file_editing_tools(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "demo"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )

    assert service._tool_registry.list_names() == [
        "append_file",
        "edit_file",
        "list_directory",
        "read_file",
        "read_file_range",
        "replace_in_file",
        "run_shell",
        "search_text",
        "update_plan",
    ]


def test_build_react_prompt_prefers_specialized_file_edit_tools() -> None:
    prompt = build_react_prompt(
        user_message="请帮我局部修改 README",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            available_tool_names=(
                "read_file_range",
                "append_file",
                "replace_in_file",
                "edit_file",
                "run_shell",
            ),
        ),
    )

    assert "Prefer rg-style search and specialized file-editing tools before edit_file or run_shell." in prompt
```

- [ ] **Step 2: Run the targeted wiring tests to confirm they fail**

Run: `uv run pytest tests/unit/cli/test_main.py -k file_editing_tools -v tests/unit/prompts/test_prompts.py -k specialized_file_edit_tools -v`

Expected: FAIL because the tool registry and prompt text do not yet mention the new tools

- [ ] **Step 3: Register the new tools in the default CLI tool list**

```python
# src/mycli/cli/main.py
tool_registry = ToolRegistryV2.from_tools(
    [
        ListDirectoryTool(workspace_root),
        ReadFileTool(workspace_root),
        ReadFileRangeTool(workspace_root),
        SearchTextTool(workspace_root),
        AppendFileTool(workspace_root),
        ReplaceInFileTool(workspace_root),
        EditFileTool(workspace_root),
        RunShellTool(workspace_root),
        UpdatePlanTool(),
    ]
)
```

- [ ] **Step 4: Extend the safety policy and prompt guidance**

```python
# src/mycli/services/safety_policy.py
if call.name in {"list_directory", "read_file", "read_file_range", "search_text", "update_plan"}:
    return RiskLevel.LOW
if call.name in {"append_file", "replace_in_file", "edit_file"}:
    return RiskLevel.MEDIUM

# src/mycli/prompts/react.py
"Prefer specialized workspace tools before run_shell.\n"
"Prefer rg-style search and specialized file-editing tools before edit_file or run_shell.\n"
```

- [ ] **Step 5: Update the README tooling section**

```markdown
## Built-in tools

- `list_directory`: list files in a workspace-relative directory
- `read_file`: read an entire UTF-8 text file
- `read_file_range`: read an inclusive line range from a UTF-8 text file
- `search_text`: search UTF-8 files for a query with rg-style path, glob, and case filters
- `append_file`: append text to a file, creating it when the parent directory exists
- `replace_in_file`: replace exact text with optional occurrence validation
- `edit_file`: overwrite a full file when a complete rewrite is appropriate
- `run_shell`: shell fallback for tasks that do not fit the structured workspace tools
```

- [ ] **Step 6: Run the focused wiring tests and then the whole relevant suite**

Run: `uv run pytest tests/unit/tools/test_file_editing_tools.py tests/unit/tools/test_read_only_tools.py tests/unit/cli/test_main.py tests/unit/prompts/test_prompts.py tests/unit/tools/test_run_shell.py -v`

Expected: PASS

- [ ] **Step 7: Run repository verification**

Run: `uv run pytest -q`
Expected: PASS

Run: `uv run ruff check .`
Expected: exit code 0

Run: `uv run mypy src`
Expected: exit code 0

- [ ] **Step 8: Commit**

```bash
git add src/mycli/cli/main.py src/mycli/services/safety_policy.py src/mycli/prompts/react.py README.md tests/unit/cli/test_main.py tests/unit/prompts/test_prompts.py tests/unit/tools/test_run_shell.py tests/unit/tools/test_file_editing_tools.py
git commit -m "feat: add structured file editing tools"
```

## Self-Review

- Spec coverage: the plan covers all approved pieces from the spec: the three new tools, shared path safety, prompt ordering, safety policy, CLI registration, README updates, and verification.
- Placeholder scan: no `TODO`/`TBD` placeholders remain; each task includes exact files, tests, commands, and expected results.
- Type consistency: all new tool names are used consistently as `read_file_range`, `append_file`, and `replace_in_file`; `search_text` remains the stable tool name while gaining `rg`-style filters; shared path helpers are referenced from a single file to avoid naming drift.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-05-mycli-file-edit-tools-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
