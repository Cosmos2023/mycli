# mycli Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight evidence-first grounding layer that makes `search_text -> read_file/read_file_range -> answer` more reliable without rewriting the runtime loop.

**Architecture:** Introduce a shared `ToolEvidence` contract in the tool/domain layer and carry it through both `ToolResult` and `ToolResultV2`. Update the read/search tools to emit evidence, then switch `ContextManager` to render evidence-first tool transcripts while keeping the old `raw_payload` fallback for untouched tools. Finish by tightening prompt guidance and adding runtime tests that verify grounded tool messages survive reinjection.

**Tech Stack:** Python 3.13, standard-library `dataclasses`/`pathlib`, existing `ToolRegistryV2` + `AgentRuntime`, `pytest`, `ruff`

---

## Scope Check

This plan implements the approved design in [2026-04-10-mycli-grounding-design.md](/Users/cosmos/Desktop/mycli/docs/superpowers/specs/2026-04-10-mycli-grounding-design.md). It covers only the first grounding slice: shared evidence contracts, `search_text`, `read_file`, `read_file_range`, evidence-aware rendering, and prompt/runtime verification. It does not add edit-tool grounding, git/shell evidence models, transcript schema migrations, or citation formatting.

Global `uv run mypy` is currently blocked by the existing missing `py.typed` marker in this repo. That issue is outside the scope of this plan, so verification here uses targeted `pytest` and `ruff`.

## File Structure

- Modify: `src/mycli/domain/tools.py`
  Add the shared `ToolEvidence` dataclass and extend legacy `ToolResult` so `run()` callers can observe grounding evidence.
- Modify: `src/mycli/tools/base.py`
  Extend `ToolResultV2` with evidence support and preserve it during `to_legacy()`.
- Modify: `src/mycli/tools/search_text.py`
  Emit `search_match` evidence for top matches while preserving existing `raw_payload`.
- Modify: `src/mycli/tools/read_file.py`
  Emit a `file_excerpt` evidence item for whole-file reads.
- Modify: `src/mycli/tools/read_file_range.py`
  Emit a `file_excerpt` evidence item with stable line-range metadata.
- Modify: `src/mycli/services/context/context_manager.py`
  Prefer rendering `result.evidence` and fall back to existing payload-based preview rendering for untouched tools.
- Modify: `src/mycli/prompts/system.py`
  Add one grounded-reasoning instruction that tells the model to use path/line/snippet evidence directly.
- Modify: `tests/unit/tools/test_read_only_tools.py`
  Cover shared evidence propagation, `search_text` evidence, and `read_file` evidence.
- Modify: `tests/unit/tools/test_file_editing_tools.py`
  Cover `read_file_range` evidence.
- Modify: `tests/unit/services/test_context_manager_v2.py`
  Cover evidence-first rendering and snippet trimming behavior.
- Modify: `tests/unit/application/test_agent_runtime.py`
  Verify grounded search/range tool messages are reinjected with evidence text.
- Modify: `tests/unit/prompts/test_prompts.py`
  Verify the system prompt includes the new grounding guidance.

## Task 1: Introduce Shared Evidence Contracts

**Files:**
- Modify: `src/mycli/domain/tools.py`
- Modify: `src/mycli/tools/base.py`
- Modify: `tests/unit/tools/test_read_only_tools.py`

- [ ] **Step 1: Write the failing contract-preservation test**

```python
# tests/unit/tools/test_read_only_tools.py
from mycli.domain.tools import ToolEvidence
from mycli.tools.base import ToolResultV2


def test_tool_result_v2_to_legacy_preserves_evidence() -> None:
    evidence = (
        ToolEvidence(
            kind="search_match",
            title='Match 1 for "hello"',
            path="README.md",
            line_start=1,
            line_end=1,
            snippet="hello world",
            metadata={"query": "hello"},
        ),
    )

    legacy = ToolResultV2(
        success=True,
        summary="Found 1 match for hello",
        evidence=evidence,
    ).to_legacy()

    assert legacy.evidence == evidence
```

- [ ] **Step 2: Run the test to confirm the shared evidence contract does not exist yet**

Run: `uv run pytest tests/unit/tools/test_read_only_tools.py -k preserves_evidence -v`

Expected: FAIL with `ImportError: cannot import name 'ToolEvidence'` or `TypeError` because `ToolResultV2` does not accept `evidence`.

- [ ] **Step 3: Add `ToolEvidence` to the shared domain contract and expose it on legacy `ToolResult`**

```python
# src/mycli/domain/tools.py
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True, frozen=True)
class ToolEvidence:
    kind: str
    title: str
    path: str | None = None
    line_start: int | None = None
    line_end: int | None = None
    snippet: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True, frozen=True)
class ToolResult:
    success: bool
    summary: str
    artifacts: dict[str, Any] = field(default_factory=dict)
    raw_payload: dict[str, Any] = field(default_factory=dict)
    evidence: tuple[ToolEvidence, ...] = field(default_factory=tuple)
    error: str | None = None
```

- [ ] **Step 4: Extend `ToolResultV2` and preserve evidence when converting to the legacy result**

```python
# src/mycli/tools/base.py
from dataclasses import dataclass, field
from typing import Any, Protocol

from mycli.domain.tools import ToolCall, ToolEvidence, ToolResult


@dataclass(slots=True, frozen=True)
class ToolResultV2:
    success: bool
    summary: str
    artifacts: dict[str, Any] = field(default_factory=dict)
    raw_payload: dict[str, Any] = field(default_factory=dict)
    evidence: tuple[ToolEvidence, ...] = field(default_factory=tuple)
    error: str | None = None

    def to_legacy(self) -> ToolResult:
        return ToolResult(
            success=self.success,
            summary=self.summary,
            artifacts=self.artifacts,
            raw_payload=self.raw_payload,
            evidence=self.evidence,
            error=self.error,
        )
```

- [ ] **Step 5: Run the targeted test again and confirm evidence now survives `to_legacy()`**

Run: `uv run pytest tests/unit/tools/test_read_only_tools.py -k preserves_evidence -v`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/mycli/domain/tools.py src/mycli/tools/base.py tests/unit/tools/test_read_only_tools.py
git commit -m "feat: add shared tool evidence contracts"
```

## Task 2: Add `search_text` Grounding Evidence

**Files:**
- Modify: `src/mycli/tools/search_text.py`
- Modify: `tests/unit/tools/test_read_only_tools.py`

- [ ] **Step 1: Write the failing `search_text` evidence test**

```python
# tests/unit/tools/test_read_only_tools.py
def test_search_text_exposes_match_evidence(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\n", encoding="utf-8")

    tool = SearchTextTool(root)
    result = tool.run(
        ToolCall(name="search_text", arguments={"query": "hello"}, reason="inspect")
    )

    assert result.success is True
    assert len(result.evidence) == 1
    evidence = result.evidence[0]
    assert evidence.kind == "search_match"
    assert evidence.title == 'Match 1 for "hello"'
    assert evidence.path == "README.md"
    assert evidence.line_start == 1
    assert evidence.line_end == 1
    assert evidence.snippet == "hello world"
    assert evidence.metadata["query"] == "hello"
```

- [ ] **Step 2: Run the test to confirm `search_text` does not emit evidence yet**

Run: `uv run pytest tests/unit/tools/test_read_only_tools.py -k exposes_match_evidence -v`

Expected: FAIL because `result.evidence` is empty.

- [ ] **Step 3: Add a helper that converts raw matches into `search_match` evidence**

```python
# src/mycli/tools/search_text.py
from mycli.domain.tools import ToolCall, ToolEvidence, ToolResult


def _build_match_evidence(
    self,
    *,
    matches: list[dict[str, object]],
    query: str,
    glob_pattern: str,
    case_sensitive: bool,
) -> tuple[ToolEvidence, ...]:
    evidence: list[ToolEvidence] = []
    for index, match in enumerate(matches[:8], start=1):
        path = match.get("path")
        line_number = match.get("line_number")
        line = match.get("line")
        if not isinstance(path, str) or not isinstance(line_number, int) or not isinstance(line, str):
            continue
        evidence.append(
            ToolEvidence(
                kind="search_match",
                title=f'Match {index} for "{query}"',
                path=path,
                line_start=line_number,
                line_end=line_number,
                snippet=line,
                metadata={
                    "query": query,
                    "glob": glob_pattern,
                    "case_sensitive": case_sensitive,
                },
            )
        )
    return tuple(evidence)
```

- [ ] **Step 4: Include evidence in both the `rg` and Python fallback success paths**

```python
# src/mycli/tools/search_text.py
matches = self._search_with_python(
    query=query,
    search_root=search_root,
    glob_pattern=glob_pattern,
    case_sensitive=case_sensitive,
    max_matches=max_matches,
)
return ToolResultV2(
    success=True,
    summary=f"Found {len(matches)} matches for {query}",
    raw_payload={
        "matches": matches,
        "query": query,
        "path": str(arguments.get("path", ".")),
        "glob": glob_pattern,
        "case_sensitive": case_sensitive,
        "max_matches": max_matches,
    },
    evidence=self._build_match_evidence(
        matches=matches,
        query=query,
        glob_pattern=glob_pattern,
        case_sensitive=case_sensitive,
    ),
)
```

```python
# src/mycli/tools/search_text.py (_search_with_rg return)
return ToolResultV2(
    success=True,
    summary=f"Found {len(matches)} matches for {query}",
    raw_payload={
        "matches": matches,
        "query": query,
        "path": scope_arg,
        "glob": glob_pattern,
        "case_sensitive": case_sensitive,
        "max_matches": max_matches,
    },
    evidence=self._build_match_evidence(
        matches=matches,
        query=query,
        glob_pattern=glob_pattern,
        case_sensitive=case_sensitive,
    ),
)
```

- [ ] **Step 5: Run the targeted read-only tool tests**

Run: `uv run pytest tests/unit/tools/test_read_only_tools.py -k "search_text and (grounded_results or exposes_match_evidence or path_and_glob_filters or case_sensitive_matching or prefers_rg or falls_back)" -v`

Expected: PASS for the existing search tests plus the new evidence assertion.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/tools/search_text.py tests/unit/tools/test_read_only_tools.py
git commit -m "feat: ground search_text results with evidence"
```

## Task 3: Add `read_file` and `read_file_range` Evidence

**Files:**
- Modify: `src/mycli/tools/read_file.py`
- Modify: `src/mycli/tools/read_file_range.py`
- Modify: `tests/unit/tools/test_read_only_tools.py`
- Modify: `tests/unit/tools/test_file_editing_tools.py`

- [ ] **Step 1: Write the failing `read_file` evidence test**

```python
# tests/unit/tools/test_read_only_tools.py
def test_read_file_exposes_file_excerpt_evidence(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\nsecond line\n", encoding="utf-8")

    tool = ReadFileTool(root)
    result = tool.run(ToolCall(name="read_file", arguments={"path": "README.md"}, reason="inspect"))

    assert result.success is True
    assert len(result.evidence) == 1
    evidence = result.evidence[0]
    assert evidence.kind == "file_excerpt"
    assert evidence.title == "Excerpt from README.md"
    assert evidence.path == "README.md"
    assert evidence.line_start == 1
    assert evidence.line_end == 2
    assert evidence.snippet == "hello world\nsecond line\n"
```

- [ ] **Step 2: Write the failing `read_file_range` evidence test**

```python
# tests/unit/tools/test_file_editing_tools.py
def test_read_file_range_exposes_line_scoped_file_excerpt_evidence(tmp_path: Path) -> None:
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
    assert len(result.evidence) == 1
    evidence = result.evidence[0]
    assert evidence.kind == "file_excerpt"
    assert evidence.title == "notes.txt:2-3"
    assert evidence.path == "notes.txt"
    assert evidence.line_start == 2
    assert evidence.line_end == 3
    assert evidence.snippet == "b\nc\n"
```

- [ ] **Step 3: Run the two new tests to confirm the file tools still emit no evidence**

Run: `uv run pytest tests/unit/tools/test_read_only_tools.py tests/unit/tools/test_file_editing_tools.py -k "read_file_exposes_file_excerpt_evidence or line_scoped_file_excerpt_evidence" -v`

Expected: FAIL because both tools currently return empty evidence tuples.

- [ ] **Step 4: Emit a whole-file `file_excerpt` evidence item from `ReadFileTool`**

```python
# src/mycli/tools/read_file.py
from mycli.domain.tools import ToolCall, ToolEvidence, ToolResult


def execute(self, arguments: dict[str, object]) -> ToolResultV2:
    path = str(arguments["path"])
    target = (self._workspace_root / path).resolve()
    content = target.read_text(encoding="utf-8")
    line_count = len(content.splitlines())
    evidence = ()
    if content:
        evidence = (
            ToolEvidence(
                kind="file_excerpt",
                title=f"Excerpt from {path}",
                path=path,
                line_start=1,
                line_end=line_count,
                snippet=content,
            ),
        )
    return ToolResultV2(
        success=True,
        summary=f"Read {path}",
        raw_payload={"path": path, "content": content},
        evidence=evidence,
    )
```

- [ ] **Step 5: Emit a line-scoped `file_excerpt` evidence item from `ReadFileRangeTool`**

```python
# src/mycli/tools/read_file_range.py
from mycli.domain.tools import ToolCall, ToolEvidence, ToolResult


actual_end_line = min(end_line, len(lines))
snippet = "".join(lines[start_line - 1 : end_line])
evidence = ()
if snippet:
    evidence = (
        ToolEvidence(
            kind="file_excerpt",
            title=f"{path}:{start_line}-{actual_end_line}",
            path=path,
            line_start=start_line,
            line_end=actual_end_line,
            snippet=snippet,
        ),
    )
return ToolResultV2(
    success=True,
    summary=f"Read lines {start_line}-{end_line} from {path}",
    raw_payload={
        "path": path,
        "start_line": start_line,
        "end_line": end_line,
        "actual_start_line": start_line,
        "actual_end_line": actual_end_line,
        "content": snippet,
    },
    evidence=evidence,
)
```

- [ ] **Step 6: Run the targeted file-tool tests**

Run: `uv run pytest tests/unit/tools/test_read_only_tools.py -k "read_file_exposes_file_excerpt_evidence or grounded_results" tests/unit/tools/test_file_editing_tools.py -k "read_file_range" -v`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/mycli/tools/read_file.py src/mycli/tools/read_file_range.py tests/unit/tools/test_read_only_tools.py tests/unit/tools/test_file_editing_tools.py
git commit -m "feat: add file excerpt grounding evidence"
```

## Task 4: Render Evidence-First Tool Messages

**Files:**
- Modify: `src/mycli/services/context/context_manager.py`
- Modify: `tests/unit/services/test_context_manager_v2.py`

- [ ] **Step 1: Write the failing evidence-first rendering test**

```python
# tests/unit/services/test_context_manager_v2.py
from mycli.domain.tools import ToolEvidence


def test_context_manager_prefers_evidence_over_payload_previews() -> None:
    manager = ContextManager()

    rendered = manager.render_tool_result(
        ToolResultV2(
            success=True,
            summary="Found 1 match for hello",
            raw_payload={
                "query": "hello",
                "matches": [{"path": "README.md", "line_number": 99, "line": "legacy payload"}],
            },
            evidence=(
                ToolEvidence(
                    kind="search_match",
                    title='Match 1 for "hello"',
                    path="README.md",
                    line_start=1,
                    line_end=1,
                    snippet="hello world",
                ),
            ),
        ),
        max_chars=400,
    )

    assert "Evidence:" in rendered
    assert "[search_match] README.md:1" in rendered
    assert "snippet: hello world" in rendered
    assert "legacy payload" not in rendered
```

- [ ] **Step 2: Add a trimming test that protects path/line metadata when snippets are long**

```python
# tests/unit/services/test_context_manager_v2.py
def test_context_manager_trims_evidence_snippet_but_keeps_location() -> None:
    manager = ContextManager()

    rendered = manager.render_tool_result(
        ToolResultV2(
            success=True,
            summary="Read README.md",
            evidence=(
                ToolEvidence(
                    kind="file_excerpt",
                    title="Excerpt from README.md",
                    path="README.md",
                    line_start=20,
                    line_end=40,
                    snippet="x" * 300,
                ),
            ),
        ),
        max_chars=160,
    )

    assert "[file_excerpt] README.md:20-40" in rendered
    assert "snippet:" in rendered
    assert rendered.endswith("...")
```

- [ ] **Step 3: Run the context-manager tests to confirm the renderer still ignores evidence**

Run: `uv run pytest tests/unit/services/test_context_manager_v2.py -k "prefers_evidence or trims_evidence_snippet" -v`

Expected: FAIL because the renderer only knows how to inspect `raw_payload`.

- [ ] **Step 4: Add evidence-aware rendering helpers and keep the old payload fallback**

```python
# src/mycli/services/context/context_manager.py
from mycli.domain.tools import ToolEvidence


def render_tool_result(
    self,
    result: ToolResultV2,
    *,
    max_chars: int = 400,
) -> str:
    rendered = self._render_tool_result_details(result)
    if len(rendered) <= max_chars:
        return rendered
    return rendered[: max_chars - 3] + "..."


def _render_tool_result_details(self, result: ToolResultV2) -> str:
    if result.evidence:
        return self._render_tool_result_from_evidence(result)
    return self._render_tool_result_from_payload(result)


def _render_tool_result_from_evidence(self, result: ToolResultV2) -> str:
    details = [result.summary, "Evidence:"]
    for item in result.evidence:
        details.append(self._format_evidence_header(item))
        if item.snippet:
            details.append(f"  snippet: {self._normalize_whitespace(item.snippet)[:200]}")
    return "\n".join(details)
```

```python
# src/mycli/services/context/context_manager.py
def _format_evidence_header(self, item: ToolEvidence) -> str:
    location = item.path or item.title
    if item.path and item.line_start is not None and item.line_end is not None:
        if item.line_start == item.line_end:
            location = f"{item.path}:{item.line_start}"
        else:
            location = f"{item.path}:{item.line_start}-{item.line_end}"
    return f"- [{item.kind}] {location}"


def _render_tool_result_from_payload(self, result: ToolResultV2) -> str:
    details: list[str] = [result.summary]
    payload = result.raw_payload
    query = payload.get("query")
    if isinstance(query, str) and query:
        details.append(f"Search query: {query}")

    payload_path = payload.get("path")
    glob = payload.get("glob")
    case_sensitive = payload.get("case_sensitive")
    max_matches = payload.get("max_matches")
    if (
        isinstance(payload_path, str)
        and payload_path
        and isinstance(glob, str)
        and glob
        and isinstance(case_sensitive, bool)
        and isinstance(max_matches, int)
    ):
        details.append(
            "Search scope: "
            f"path={payload_path} glob={glob} "
            f"case_sensitive={case_sensitive} max_matches={max_matches}"
        )

    matches = payload.get("matches")
    if isinstance(matches, list) and matches:
        lines: list[str] = []
        for item in matches[:5]:
            if not isinstance(item, dict):
                continue
            match_path = item.get("path")
            line_number = item.get("line_number")
            line = item.get("line")
            if (
                isinstance(match_path, str)
                and isinstance(line_number, int)
                and isinstance(line, str)
            ):
                lines.append(f"{match_path}:{line_number}: {line}")
        if lines:
            details.append("Matches:")
            details.extend(lines)

    content = payload.get("content")
    if isinstance(content, str) and content:
        if isinstance(payload_path, str) and payload_path:
            details.append(f"File path: {payload_path}")
        preview = self._normalize_whitespace(content)[:240]
        if preview:
            details.append(f"Content preview: {preview}")

    diff = payload.get("diff")
    if isinstance(diff, str) and diff:
        preview = diff[:240]
        if preview:
            details.append(f"Diff preview: {preview}")

    stdout = payload.get("stdout")
    if isinstance(stdout, str) and stdout.strip():
        preview = self._normalize_whitespace(stdout)[:240]
        if preview:
            details.append(f"Stdout preview: {preview}")

    stderr = payload.get("stderr")
    if isinstance(stderr, str) and stderr.strip():
        preview = self._normalize_whitespace(stderr)[:240]
        if preview:
            details.append(f"Stderr preview: {preview}")

    return "\n".join(details)
```

- [ ] **Step 5: Run the full context-manager suite**

Run: `uv run pytest tests/unit/services/test_context_manager_v2.py -v`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/mycli/services/context/context_manager.py tests/unit/services/test_context_manager_v2.py
git commit -m "feat: render tool grounding evidence in context manager"
```

## Task 5: Reinforce Grounded Reasoning in Prompt and Runtime Tests

**Files:**
- Modify: `src/mycli/prompts/system.py`
- Modify: `tests/unit/prompts/test_prompts.py`
- Modify: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write the failing prompt test for explicit evidence usage**

```python
# tests/unit/prompts/test_prompts.py
def test_build_system_prompt_mentions_path_line_and_snippet_evidence() -> None:
    prompt = build_system_prompt()

    assert "When tool results include paths, line numbers, or evidence snippets, reason from them directly." in prompt
```

- [ ] **Step 2: Write the failing runtime reinjection test for `search -> read_file_range -> answer`**

```python
# tests/unit/application/test_agent_runtime.py
class SearchRangeThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_messages: list[list[object]] = []

    def next_action(self, *, messages, tools):
        del tools
        self.calls += 1
        self.seen_messages.append(list(messages))
        if self.calls == 1:
            return type(
                "Action",
                (),
                {
                    "assistant_message": None,
                    "progress_message": "Searching for evidence",
                    "tool_call": ToolCall(
                        name="search_text",
                        arguments={"query": "needle"},
                        reason="find the file",
                        call_id="call_search_1",
                    ),
                    "done": False,
                },
            )()
        if self.calls == 2:
            return type(
                "Action",
                (),
                {
                    "assistant_message": None,
                    "progress_message": "Reading the matching lines",
                    "tool_call": ToolCall(
                        name="read_file_range",
                        arguments={"path": "notes.txt", "start_line": 1, "end_line": 2},
                        reason="inspect the evidence",
                        call_id="call_read_range_1",
                    ),
                    "done": False,
                },
            )()
        return type(
            "Action",
            (),
            {
                "assistant_message": "The evidence shows needle on line 1 of notes.txt.",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


def test_agent_runtime_reinjects_search_and_range_evidence_into_tool_messages(tmp_path: Path) -> None:
    adapter = SearchRangeThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    (tmp_path / "notes.txt").write_text("needle one\nline two\n", encoding="utf-8")

    response = runtime.handle_user_turn("find the note")

    assert response.assistant_message == "The evidence shows needle on line 1 of notes.txt."
    final_messages = adapter.seen_messages[-1]
    search_tool_message = next(
        message for message in final_messages
        if getattr(message, "role", None) == "tool"
        and getattr(message, "tool_call_id", None) == "call_search_1"
    )
    range_tool_message = next(
        message for message in final_messages
        if getattr(message, "role", None) == "tool"
        and getattr(message, "tool_call_id", None) == "call_read_range_1"
    )

    assert "Evidence:" in str(search_tool_message.content)
    assert "[search_match] notes.txt:1" in str(search_tool_message.content)
    assert "snippet: needle one" in str(search_tool_message.content)
    assert "[file_excerpt] notes.txt:1-2" in str(range_tool_message.content)
```

- [ ] **Step 3: Run the prompt/runtime tests to confirm the guidance and evidence transcript are still missing**

Run: `uv run pytest tests/unit/prompts/test_prompts.py tests/unit/application/test_agent_runtime.py -k "mentions_path_line_and_snippet_evidence or search_and_range_evidence" -v`

Expected: FAIL because the system prompt does not mention evidence usage and the runtime still reinjects the old payload-style read/search text.

- [ ] **Step 4: Add one grounding-specific sentence to the system prompt**

```python
# src/mycli/prompts/system.py
def build_system_prompt() -> str:
    return (
        "You are mycli, a local-first ReAct coding agent. "
        "Prefer grounded answers. Use tools when facts are missing. "
        "When tool results include paths, line numbers, or evidence snippets, reason from them directly. "
        "Keep progress updates concise. "
        "Invoke available tools directly when needed. "
        "Respond in normal plain text when you are not invoking a tool. "
        "Never describe tool schemas, IDs, JSON wrappers, or wire protocols in assistant text."
    )
```

- [ ] **Step 5: Run the full grounding verification set**

Run: `uv run pytest tests/unit/tools/test_read_only_tools.py tests/unit/tools/test_file_editing_tools.py tests/unit/services/test_context_manager_v2.py tests/unit/application/test_agent_runtime.py tests/unit/prompts/test_prompts.py -q`

Expected: all targeted tests PASS

Run: `uv run ruff check src/mycli/domain/tools.py src/mycli/tools/base.py src/mycli/tools/search_text.py src/mycli/tools/read_file.py src/mycli/tools/read_file_range.py src/mycli/services/context/context_manager.py src/mycli/prompts/system.py tests/unit/tools/test_read_only_tools.py tests/unit/tools/test_file_editing_tools.py tests/unit/services/test_context_manager_v2.py tests/unit/application/test_agent_runtime.py tests/unit/prompts/test_prompts.py`

Expected: `All checks passed!`

- [ ] **Step 6: Commit**

```bash
git add src/mycli/prompts/system.py tests/unit/prompts/test_prompts.py tests/unit/application/test_agent_runtime.py
git add src/mycli/domain/tools.py src/mycli/tools/base.py src/mycli/tools/search_text.py src/mycli/tools/read_file.py src/mycli/tools/read_file_range.py src/mycli/services/context/context_manager.py
git add tests/unit/tools/test_read_only_tools.py tests/unit/tools/test_file_editing_tools.py tests/unit/services/test_context_manager_v2.py
git commit -m "feat: improve grounding for search and file evidence"
```

## Self-Review

### Spec coverage

- Shared evidence contract: covered by Task 1
- `search_text` grounding: covered by Task 2
- `read_file` and `read_file_range` grounding: covered by Task 3
- evidence-first rendering: covered by Task 4
- prompt/runtime grounding behavior: covered by Task 5

No approved requirement from the spec is left without a task.

### Placeholder scan

- No `TODO`, `TBD`, or “implement later” placeholders remain
- Every task includes exact file paths, concrete test code, commands, and commit messages
- No task depends on an undefined helper or unnamed future refactor

### Type consistency

- The plan uses one shared evidence type name: `ToolEvidence`
- Result objects consistently expose `evidence: tuple[ToolEvidence, ...]`
- Evidence kinds stay limited to `search_match` and `file_excerpt`, matching the approved spec
