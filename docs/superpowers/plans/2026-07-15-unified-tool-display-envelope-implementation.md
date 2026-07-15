# Unified Tool Display Envelope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project every built-in mycli tool into one bounded display envelope so live execution and resumed history render identically, while external tools retain a safe generic fallback.

**Architecture:** Add a pure Python `ToolDisplayProjector` beside the existing model-facing formatter. `ToolExecutionService` writes the projector output into lifecycle events and turn history, transcript snapshots preserve only that bounded display object, and the TypeScript runtime adapter consumes it before the existing legacy inference path. Shell, subagent, plan, and clarification components remain specialized.

**Tech Stack:** Python 3.13 dataclasses and pytest, TypeScript 5.9 and Node test runner, existing mycli runtime/transcript/TUI components, uv, Ruff, mypy.

---

## File Map

- Create `src/mycli/services/tool_display.py`: typed envelope, bounds, built-in classifications, external fallback, serialization and parsing.
- Create `tests/unit/services/test_tool_display.py`: projector contract, category matrix, bounds and external payload tests.
- Modify `src/mycli/application/runtime/tools/tool_execution_service.py`: attach display to start/progress/terminal lifecycle events and tool call/result turn items.
- Modify `tests/unit/application/test_tool_execution_service.py`: lifecycle and turn-history display assertions.
- Modify `src/mycli/services/transcript_projection.py`: preserve and coalesce bounded display without copying raw payload.
- Modify `tests/unit/services/test_transcript_projection.py`: snapshot/display and legacy compatibility tests.
- Modify `tui/mycli-shell/src/model.ts`: carry presentation, summary and detail separately in the TUI model.
- Modify `tui/mycli-shell/src/adapters/runtime-state.ts`: parse display first and retain legacy inference.
- Modify `tui/mycli-shell/src/components/tool-execution.ts`: render display detail without duplicating summary.
- Modify `tui/mycli-shell/src/components/tool-presentation.ts`: use presentation semantics for concise status text.
- Modify `tui/mycli-shell/src/transcript-projection.ts`: group context tools by presentation as well as legacy names.
- Modify `tui/mycli-shell/test/runtime-state.test.ts`: display parsing, malformed fallback and live/resume equivalence.
- Modify `tui/mycli-shell/test/shell-app.test.ts`: representative category rendering.
- Modify `tests/integration/test_toolset_smoke.py`: require every default tool to have a known presentation.

## Task 1: Add The Bounded Display Value Object

**Files:**
- Create: `src/mycli/services/tool_display.py`
- Test: `tests/unit/services/test_tool_display.py`

- [ ] **Step 1: Write failing value-object tests**

```python
from mycli.services.tool_display import ToolDisplayEnvelope


def test_display_envelope_serializes_only_non_default_values() -> None:
    envelope = ToolDisplayEnvelope(
        target="src/app.py",
        status="success",
        summary="Updated",
        metrics={"duration_ms": 25, "exit_code": 0},
        presentation="mutation",
    )

    assert envelope.to_dict() == {
        "target": "src/app.py",
        "status": "success",
        "summary": "Updated",
        "metrics": {"duration_ms": 25, "exit_code": 0},
        "presentation": "mutation",
    }


def test_display_envelope_bounds_text_and_scalar_metrics() -> None:
    envelope = ToolDisplayEnvelope.create(
        target="x" * 300,
        status="completed",
        summary="s" * 600,
        detail="head\n" + "d" * 12_000 + "\ntail",
        error="e" * 3_000,
        metrics={
            "duration_ms": 25,
            "nested": {"secret": "ignored"},
            "items": ["ignored"],
        },
        presentation="unknown",
    )

    payload = envelope.to_dict()
    assert payload["status"] == "success"
    assert payload["presentation"] == "tool"
    assert len(str(payload["target"])) <= 240
    assert len(str(payload["summary"])) <= 500
    assert len(str(payload["detail"])) <= 8_000
    assert len(str(payload["error"])) <= 2_000
    assert payload["metrics"] == {"duration_ms": 25}
    assert payload["truncated"] is True
    assert payload["omitted_chars"] > 0
```

- [ ] **Step 2: Verify RED**

```bash
uv run pytest tests/unit/services/test_tool_display.py -q
```

Expected: FAIL because `mycli.services.tool_display` does not exist.

- [ ] **Step 3: Implement the immutable envelope and helpers**

Create these public constants and APIs:

```python
DISPLAY_TARGET_MAX_CHARS = 240
DISPLAY_SUMMARY_MAX_CHARS = 500
DISPLAY_DETAIL_MAX_CHARS = 8_000
DISPLAY_ERROR_MAX_CHARS = 2_000
DISPLAY_METRICS_MAX_ITEMS = 16

DISPLAY_STATUSES = frozenset({"running", "success", "error", "cancelled", "waiting"})
DISPLAY_PRESENTATIONS = frozenset(
    {"tool", "context", "mutation", "shell", "skill", "web", "diagnostic", "control", "external"}
)


@dataclass(frozen=True, slots=True)
class ToolDisplayEnvelope:
    target: str | None = None
    status: str = "running"
    summary: str = ""
    detail: str | None = None
    error: str | None = None
    metrics: dict[str, int | float | str | bool] = field(default_factory=dict)
    truncated: bool = False
    omitted_chars: int = 0
    presentation: str = "tool"

    @classmethod
    def create(
        cls,
        *,
        target: object = None,
        status: object = "running",
        summary: object = "",
        detail: object = None,
        error: object = None,
        metrics: object = None,
        presentation: object = "tool",
    ) -> "ToolDisplayEnvelope":
        normalized_status = _normalize_status(status)
        normalized_presentation = (
            presentation if isinstance(presentation, str) and presentation in DISPLAY_PRESENTATIONS else "tool"
        )
        bounded_target, target_omitted = _bounded_single_line(target, DISPLAY_TARGET_MAX_CHARS)
        bounded_summary, summary_omitted = _bounded_single_line(summary, DISPLAY_SUMMARY_MAX_CHARS)
        bounded_detail, detail_omitted = _bounded_head_tail(detail, DISPLAY_DETAIL_MAX_CHARS)
        bounded_error, error_omitted = _bounded_head_tail(error, DISPLAY_ERROR_MAX_CHARS)
        omitted = target_omitted + summary_omitted + detail_omitted + error_omitted
        return cls(
            target=bounded_target,
            status=normalized_status,
            summary=bounded_summary or "",
            detail=bounded_detail,
            error=bounded_error,
            metrics=_scalar_metrics(metrics),
            truncated=omitted > 0,
            omitted_chars=omitted,
            presentation=normalized_presentation,
        )

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "status": self.status,
            "summary": self.summary,
            "presentation": self.presentation,
        }
        if self.target:
            payload["target"] = self.target
        if self.detail:
            payload["detail"] = self.detail
        if self.error:
            payload["error"] = self.error
        if self.metrics:
            payload["metrics"] = dict(self.metrics)
        if self.truncated:
            payload["truncated"] = True
        if self.omitted_chars:
            payload["omitted_chars"] = self.omitted_chars
        return payload

    @classmethod
    def from_mapping(cls, value: object) -> "ToolDisplayEnvelope | None":
        if not isinstance(value, dict):
            return None
        raw_status = value.get("status")
        raw_summary = value.get("summary")
        if not isinstance(raw_status, str) or not isinstance(raw_summary, str):
            return None
        envelope = cls.create(
            target=value.get("target"),
            status=value.get("status"),
            summary=value.get("summary"),
            detail=value.get("detail"),
            error=value.get("error"),
            metrics=value.get("metrics"),
            presentation=value.get("presentation"),
        )
        previous_omitted = value.get("omitted_chars")
        if not isinstance(previous_omitted, int) or isinstance(previous_omitted, bool):
            previous_omitted = 0
        return replace(
            envelope,
            truncated=envelope.truncated or value.get("truncated") is True or previous_omitted > 0,
            omitted_chars=envelope.omitted_chars + max(0, previous_omitted),
        )
```

`_bounded_single_line()` collapses whitespace and uses a trailing `...`. `_bounded_head_tail()` uses one `\n... N chars omitted ...\n` marker and returns the exact omitted count. `_scalar_metrics()` accepts at most 16 non-empty string keys whose values are `str`, `int`, `float`, or `bool`; it must reject non-finite floats and nested values. `_normalize_status()` maps `done/completed/succeeded` to `success`, `failed/denied` to `error`, and `interrupted` to `cancelled`.

Add a round-trip test proving an existing `truncated=true` and `omitted_chars` survive `from_mapping(...).to_dict()`, plus malformed mappings without string `status` and `summary` return `None`.

- [ ] **Step 4: Verify GREEN and static checks**

```bash
uv run pytest tests/unit/services/test_tool_display.py -q
uv run ruff check src/mycli/services/tool_display.py tests/unit/services/test_tool_display.py
uv run mypy src/mycli/services/tool_display.py
```

Expected: all commands pass.

- [ ] **Step 5: Commit only the new projector foundation**

```bash
git add src/mycli/services/tool_display.py tests/unit/services/test_tool_display.py
git commit -m "Add bounded tool display envelope"
```

## Task 2: Project Built-In And External Tool Semantics

**Files:**
- Modify: `src/mycli/services/tool_display.py`
- Modify: `tests/unit/services/test_tool_display.py`
- Modify: `tests/integration/test_toolset_smoke.py`

- [ ] **Step 1: Write failing category and fallback tests**

Add parameterized category coverage:

```python
import pytest

from mycli.domain.tooling.calls import ToolCall, ToolEvidence, ToolResult
from mycli.services.tool_display import ToolDisplayProjector


@pytest.mark.parametrize(
    ("name", "arguments", "payload", "presentation", "target"),
    [
        ("Read", {"file_path": "src/app.py", "offset": 1, "limit": 200}, {"content": "1\tline"}, "context", "src/app.py"),
        ("Grep", {"pattern": "ToolResult", "path": "src"}, {"matches": []}, "context", "src: ToolResult"),
        ("Glob", {"pattern": "**/*.py", "path": "src"}, {"files": ["src/a.py"], "dirs": []}, "context", "src: **/*.py"),
        ("LS", {"path": "src"}, {"entries": ["a.py"]}, "context", "src"),
        ("Write", {"file_path": "notes.md", "content": "a\nb\n"}, {"path": "notes.md", "status": "written"}, "mutation", "notes.md"),
        ("Edit", {"file_path": "app.py"}, {"path": "app.py", "diff": "-a\n+b"}, "mutation", "app.py"),
        ("Shell", {"command": "pytest -q", "cwd": "/repo"}, {"stdout": "2 passed", "exit_code": 0}, "shell", "pytest -q"),
        ("GitDiff", {"path": "src"}, {"diff": "+line"}, "mutation", "src"),
        ("Lint", {"paths": "src"}, {"output": "All checks passed"}, "diagnostic", "src"),
        ("WebSearch", {"query": "mycli"}, {"results": []}, "web", "mycli"),
        ("WebFetch", {"url": "https://example.com"}, {"content": "Example"}, "web", "https://example.com"),
        ("Skill", {"skill_name": "repository-analysis"}, {"skill_name": "repository-analysis"}, "skill", "repository-analysis"),
        ("SendMessage", {"child_session_id": "child-1", "message": "continue"}, {"status": "delivered"}, "control", "child-1"),
    ],
)
def test_projector_classifies_built_in_tools(
    name: str,
    arguments: dict[str, object],
    payload: dict[str, object],
    presentation: str,
    target: str,
) -> None:
    envelope = ToolDisplayProjector().project_result(
        ToolCall(name=name, arguments=arguments, reason="test", call_id="call-1"),
        ToolResult(success=True, summary="done", raw_payload=payload),
        duration_ms=25,
    )

    assert envelope.presentation == presentation
    assert envelope.target == target
    assert envelope.status == "success"
    assert envelope.metrics["duration_ms"] == 25


def test_external_tool_fallback_does_not_copy_unknown_payload() -> None:
    result = ToolResult(
        success=True,
        summary="Fetched record",
        raw_payload={
            "url": "https://example.com/1",
            "content": "visible",
            "provider_blob": {"secret": "must-not-leak"},
        },
        evidence=(ToolEvidence(kind="record", title="record-1", snippet="evidence"),),
    )

    envelope = ToolDisplayProjector().project_result(
        ToolCall(name="mcp__demo__fetch", arguments={"id": "1"}, reason="test"),
        result,
    )

    assert envelope.presentation == "external"
    assert envelope.summary == "Fetched record"
    assert "provider_blob" not in str(envelope.to_dict())
    assert "secret" not in str(envelope.to_dict())


def test_projector_degrades_to_minimal_fallback_for_unexpected_payload_types() -> None:
    envelope = ToolDisplayProjector().project_result(
        ToolCall(name="mcp__demo__fetch", arguments={"path": {"unexpected": True}}, reason="test"),
        ToolResult(
            success=False,
            summary="Provider tool failed",
            error="Invalid response",
            raw_payload={"content": object(), "stdout": ["not", "text"]},
        ),
    )

    assert envelope.status == "error"
    assert envelope.summary == "Provider tool failed"
    assert envelope.error == "Invalid response"
    assert envelope.presentation == "external"
```

- [ ] **Step 2: Add a failing default-tool classification guard**

In `tests/integration/test_toolset_smoke.py`, instantiate `default_tools(tmp_path)` and assert:

```python
def test_every_default_tool_has_display_presentation(tmp_path: Path) -> None:
    projector = ToolDisplayProjector()
    unknown = [
        tool.spec.name
        for tool in default_tools(tmp_path)
        if projector.presentation_for(tool.spec.name) == "external"
    ]
    assert unknown == []
```

Expected initial failure: built-ins are not classified yet.

- [ ] **Step 3: Implement category registries and pure render helpers**

Add explicit normalized-name sets for every default tool:

```python
CONTEXT_TOOLS = frozenset({"read", "grep", "glob", "ls", "gitstatus", "gitlog", "gitshow"})
MUTATION_TOOLS = frozenset({"write", "edit", "patch", "gitdiff"})
SHELL_TOOLS = frozenset({"shell", "bash", "shelloutput", "bashoutput", "killshell"})
WEB_TOOLS = frozenset({"websearch", "webfetch"})
DIAGNOSTIC_TOOLS = frozenset({"lint"})
SKILL_TOOLS = frozenset({"skill"})
CONTROL_TOOLS = frozenset(
    {"askuserquestion", "plan", "enterplanmode", "exitplanmode", "task", "subagentoutput", "sendmessage"}
)
```

Implement:

```python
class ToolDisplayProjector:
    def presentation_for(self, tool_name: str) -> str:
        normalized = _normalized_tool_name(tool_name)
        for presentation, names in _PRESENTATION_TOOLS:
            if normalized in names:
                return presentation
        return "external"

    def project_start(self, call: ToolCall) -> ToolDisplayEnvelope:
        presentation = self.presentation_for(call.name)
        return ToolDisplayEnvelope.create(
            target=_target_for(call, {}),
            status="running",
            summary=_running_summary(presentation),
            detail=_start_detail(call, presentation),
            metrics=_start_metrics(call, presentation),
            presentation=presentation,
        )

    def project_result(
        self,
        call: ToolCall,
        result: ToolResult,
        *,
        duration_ms: int | None = None,
    ) -> ToolDisplayEnvelope:
        presentation = self.presentation_for(call.name)
        try:
            metrics = _result_metrics(call, result, presentation)
            if duration_ms is not None:
                metrics["duration_ms"] = duration_ms
            return ToolDisplayEnvelope.create(
                target=_target_for(call, result.raw_payload),
                status="success" if result.success else "error",
                summary=_result_summary(call, result, presentation),
                detail=_result_detail(call, result, presentation),
                error=result.error if not result.success else None,
                metrics=metrics,
                presentation=presentation,
            )
        except (AttributeError, TypeError, ValueError):
            return ToolDisplayEnvelope.create(
                status="success" if result.success else "error",
                summary=result.summary,
                error=result.error if not result.success else None,
                presentation=presentation,
            )
```

Use small structured helpers for matches, entries, diffs, diagnostics, web results and evidence. Helpers may inspect only explicitly named fields. They must never stringify the complete `raw_payload`.

Semantic summary rules:

- Skill success: `Activated`.
- Write with line count: `Wrote N line(s)`; Edit/Patch: `Updated`; unchanged status: `No changes`.
- Grep: `N matches`; Glob/LS: `N entries`; WebSearch: `N results` when count is available.
- Shell: `Running` while active, `Exit N` when an exit code exists, otherwise the bounded result summary.
- All unrecognized or incomplete payloads: bounded `ToolResult.summary`.

- [ ] **Step 4: Verify projector matrix and default coverage**

```bash
uv run pytest tests/unit/services/test_tool_display.py tests/integration/test_toolset_smoke.py -q
uv run ruff check src/mycli/services/tool_display.py tests/unit/services/test_tool_display.py tests/integration/test_toolset_smoke.py
uv run mypy src/mycli/services/tool_display.py
```

Expected: all tests pass and every default tool is classified.

- [ ] **Step 5: Commit built-in semantic projection**

```bash
git add src/mycli/services/tool_display.py \
  tests/unit/services/test_tool_display.py \
  tests/integration/test_toolset_smoke.py
git commit -m "Project built-in tool display semantics"
```

## Task 3: Attach Display To Lifecycle And Turn History

**Files:**
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py`
- Modify: `tests/unit/application/test_tool_execution_service.py`

- [ ] **Step 1: Write failing lifecycle/turn-item tests**

Extend the existing successful lifecycle test:

```python
start_display = events[0].metadata["display"]
complete_display = events[-1].metadata["display"]
assert start_display == {
    "target": "README.md",
    "status": "running",
    "summary": "Reading",
    "presentation": "context",
}
assert complete_display["target"] == "README.md"
assert complete_display["status"] == "success"
assert complete_display["presentation"] == "context"
assert complete_display["metrics"]["duration_ms"] == 125

tool_call = next(item for item in turn_items if item.type is TurnItemType.TOOL_CALL)
tool_result = next(item for item in turn_items if item.type is TurnItemType.TOOL_RESULT)
assert tool_call.metadata["display"] == start_display
assert tool_result.metadata["display"] == complete_display
```

Add a failed tool assertion proving `display.status == "error"` and `display.error` survives without raw payload leakage.

- [ ] **Step 2: Verify RED**

```bash
uv run pytest \
  tests/unit/application/test_tool_execution_service.py::test_tool_execution_service_notifies_tool_lifecycle_success \
  tests/unit/application/test_tool_execution_service.py::test_tool_execution_service_emits_lifecycle_and_trace_for_denied_tool -q
```

Expected: FAIL because lifecycle and turn metadata do not contain `display`.

- [ ] **Step 3: Inject one projector and use it at all event boundaries**

Extend `ToolExecutionService.__init__`:

```python
tool_display_projector: ToolDisplayProjector | None = None,
```

Initialize:

```python
self._tool_display_projector = tool_display_projector or ToolDisplayProjector()
```

In `_record_tool_start()` compute once:

```python
start_display = self._tool_display_projector.project_start(normalized_call).to_dict()
turn_metadata["display"] = start_display
```

Pass the same object into `_tool_lifecycle_start_event()` and `_tool_lifecycle_progress_event()` rather than independently projecting it. In the terminal path, compute after duration:

```python
complete_display = self._tool_display_projector.project_result(
    normalized_call,
    result,
    duration_ms=round(duration_seconds * 1000),
).to_dict()
result_metadata["display"] = complete_display
```

Pass `complete_display` into `_tool_lifecycle_finish_event()`. Keep current flat lifecycle fields during compatibility; do not remove `args_preview`, `summary`, `diff`, skill name, or shell fields in this task.

Policy-denied, interrupted and aborted paths must call the same projector with their synthesized `ToolResult`; no terminal path may construct display by hand.

- [ ] **Step 4: Verify all ToolExecutionService tests**

```bash
uv run pytest tests/unit/application/test_tool_execution_service.py -q
uv run ruff check src/mycli/application/runtime/tools/tool_execution_service.py \
  tests/unit/application/test_tool_execution_service.py
uv run mypy src/mycli/application/runtime/tools/tool_execution_service.py
```

Expected: all tests pass; existing exact metadata assertions are updated to include `display` without losing legacy keys.

- [ ] **Step 5: Commit runtime integration**

Before committing, inspect staged files because this worktree already contains related uncommitted runtime changes. Do not stage `.codex/config.toml`.

```bash
git add src/mycli/application/runtime/tools/tool_execution_service.py \
  tests/unit/application/test_tool_execution_service.py
git diff --cached --name-only
git commit -m "Attach display envelopes to tool lifecycle"
```

## Task 4: Persist And Coalesce Display In Transcript Snapshots

**Files:**
- Modify: `src/mycli/services/transcript_projection.py`
- Modify: `tests/unit/services/test_transcript_projection.py`

- [ ] **Step 1: Write failing snapshot tests**

```python
def test_snapshot_coalesces_tool_display_without_raw_payload() -> None:
    items = (
        HistoryItem(
            id="call",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.TOOL_CALL,
            text="Read",
            tool_name="Read",
            call_id="call-1",
            metadata={
                "display": {
                    "target": "src/app.py",
                    "status": "running",
                    "summary": "Reading",
                    "presentation": "context",
                },
                "arguments": {"file_path": "src/app.py"},
            },
        ),
        HistoryItem(
            id="result",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.TOOL_RESULT,
            text="Read complete",
            tool_name="Read",
            call_id="call-1",
            metadata={
                "display": {
                    "status": "success",
                    "summary": "Read 20 lines",
                    "detail": "1\tline",
                    "metrics": {"line_count": 20},
                    "presentation": "context",
                },
                "raw_payload": {"content": "model-only duplicate"},
            },
        ),
    )

    payload = project_history_items_for_snapshot(items)[0].to_dict()
    display = payload["metadata"]["display"]
    assert display["target"] == "src/app.py"
    assert display["status"] == "success"
    assert display["detail"] == "1\tline"
    assert "raw_payload" not in str(payload)
```

Add a malformed-display test proving `_visible_tui_metadata()` ignores invalid display and retains legacy `path/query/command` fields.

- [ ] **Step 2: Verify RED**

```bash
uv run pytest tests/unit/services/test_transcript_projection.py -q
```

Expected: FAIL because `display` is discarded.

- [ ] **Step 3: Parse and merge bounded display**

Import `ToolDisplayEnvelope`. In `_visible_tui_metadata()`:

```python
display = ToolDisplayEnvelope.from_mapping(metadata.get("display"))
if display is not None:
    visible["display"] = display.to_dict()
```

When coalescing call and result snapshots, merge display semantically:

```python
def _merge_tool_display(
    start: object,
    finish: object,
) -> dict[str, object] | None:
    start_display = ToolDisplayEnvelope.from_mapping(start)
    finish_display = ToolDisplayEnvelope.from_mapping(finish)
    if start_display is None:
        return None if finish_display is None else finish_display.to_dict()
    if finish_display is None:
        return start_display.to_dict()
    payload = finish_display.to_dict()
    if not finish_display.target and start_display.target:
        payload["target"] = start_display.target
    return payload
```

Call this helper before `{**existing.metadata, **snapshot_item.metadata}` so the terminal result wins while a missing result target inherits from start. `_remove_snapshot_tool_duplicates()` must not remove display.

- [ ] **Step 4: Verify snapshot and gateway resume tests**

```bash
uv run pytest tests/unit/services/test_transcript_projection.py \
  tests/unit/cli/node_tui/test_gateway.py -q
uv run ruff check src/mycli/services/transcript_projection.py \
  tests/unit/services/test_transcript_projection.py
uv run mypy src/mycli/services/transcript_projection.py
```

Expected: all tests pass and snapshots contain no raw payload copy.

- [ ] **Step 5: Commit transcript integration**

```bash
git add src/mycli/services/transcript_projection.py \
  tests/unit/services/test_transcript_projection.py
git diff --cached --name-only
git commit -m "Persist bounded tool display envelopes"
```

## Task 5: Make The TUI Consume Display Before Legacy Metadata

**Files:**
- Modify: `tui/mycli-shell/src/model.ts`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Modify: `tui/mycli-shell/src/components/tool-execution.ts`
- Modify: `tui/mycli-shell/src/components/tool-presentation.ts`
- Modify: `tui/mycli-shell/src/transcript-projection.ts`
- Modify: `tui/mycli-shell/test/runtime-state.test.ts`
- Modify: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Write failing adapter priority and equivalence tests**

```typescript
test("runtime adapter prefers display envelope over conflicting legacy metadata", () => {
	let state = initialRuntimeState();
	state = runtimeStateFromTranscript(state, {
		items: [{
			id: "tool-1",
			type: "tool_summary",
			text: "legacy text",
			metadata: {
				tool_name: "Grep",
				path: "wrong-path",
				summary: "wrong summary",
				display: {
					target: "src: ToolResult",
					status: "success",
					summary: "12 matches",
					detail: "src/a.py:10: class ToolResult",
					metrics: { match_count: 12, duration_ms: 25 },
					presentation: "context",
				},
			},
		}],
	});

	const tool = projectRuntimeState(state).tools[0];
	assert.equal(tool?.args, "src: ToolResult");
	assert.equal(tool?.status, "success");
	assert.equal(tool?.summaryPreview, "12 matches");
	assert.equal(tool?.detailPreview, "src/a.py:10: class ToolResult");
	assert.equal(tool?.presentation, "context");
	assert.equal(tool?.durationMs, 25);
});

test("live and resumed display envelopes project to equal tools", () => {
	const display = {
		target: "repository-analysis",
		status: "success",
		summary: "Activated",
		presentation: "skill",
	};
	const resumed = runtimeStateFromTranscript(initialRuntimeState(), {
		items: [{ id: "skill", type: "tool_summary", text: "Skill", metadata: { tool_name: "Skill", display } }],
	});
	const live = reduceRuntimeEvent(initialRuntimeState(), "tool.complete", {
		tool_id: "skill",
		call_id: "skill-call",
		name: "Skill",
		display,
	});

	assert.deepEqual(projectRuntimeState(live).tools[0], projectRuntimeState(resumed).tools[0]);
});

test("malformed display falls back to legacy metadata", () => {
	let state = initialRuntimeState();
	state = runtimeStateFromTranscript(state, {
		items: [{
			id: "legacy-read",
			type: "tool_summary",
			text: "Read src/app.py",
			metadata: {
				tool_name: "Read",
				path: "src/app.py",
				success: true,
				display: { status: 42, summary: ["invalid"] },
			},
		}],
	});

	assert.equal(projectRuntimeState(state).tools[0]?.args, "src/app.py");
});
```

Add these fields to `MycliShellTool`:

```typescript
summaryPreview?: string;
detailPreview?: string;
presentation?: string;
displayTruncated?: boolean;
displayOmittedChars?: number;
```

The equality fixture must use the same stable ID/call ID on both paths.

- [ ] **Step 2: Verify RED**

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs \
  --test test/runtime-state.test.ts --test-reporter=spec
```

Expected: FAIL because adapter ignores `metadata.display`.

- [ ] **Step 3: Add a strict display parser and adapter-first mapping**

Add:

```typescript
type ToolDisplay = {
	target?: string;
	status: MycliShellToolStatus;
	summary: string;
	detail?: string;
	error?: string;
	metrics: Record<string, string | number | boolean>;
	truncated: boolean;
	omittedChars: number;
	presentation: string;
};

function toolDisplayFromMetadata(metadata: Record<string, unknown>): ToolDisplay | null {
	const display = recordValue(metadata.display);
	const status = stringValue(display.status);
	if (!status || !["running", "success", "error", "cancelled", "waiting"].includes(status)) return null;
	const presentation = stringValue(display.presentation) ?? "tool";
	return {
		target: stringValue(display.target) ?? undefined,
		status: status === "waiting" ? "running" : status as MycliShellToolStatus,
		summary: stringValue(display.summary) ?? "",
		detail: textValue(display.detail) ?? undefined,
		error: textValue(display.error) ?? undefined,
		metrics: scalarRecord(display.metrics),
		truncated: booleanValue(display.truncated) ?? false,
		omittedChars: numberValue(display.omitted_chars) ?? 0,
		presentation,
	};
}
```

In `toolFromTranscriptItem()`, branch on display first. Map target to `args`, summary to `summaryPreview`, detail to `detailPreview`, error to `errorPreview`, metrics duration to `durationMs`, and presentation `mutation` to `mutating=true`. Set `outputPreview` to `summaryPreview` only as a temporary compatibility alias for call sites that have not moved to the new fields. If parser returns null, execute the current legacy logic unchanged.

When `projectRuntimeState()` converts a shell tool into `MycliShellBash`, use:

```typescript
outputPreview: tool.detailPreview ?? tool.outputPreview,
```

This keeps Shell command output in the specialized component while the generic result summary remains separate.

When `applyToolLifecycle()` merges start/progress/complete events, preserve `params.display` as one object; do not flatten or merge its inner fields in TypeScript.

- [ ] **Step 4: Drive presentation and context grouping from envelope semantics**

Change `presentationForTool()` to accept an optional semantic presentation:

```typescript
export function presentationForTool(
	name: string,
	status?: MycliShellToolStatus,
	mutating?: boolean,
	semantic?: string,
): ToolPresentation {
	const semanticAccent =
		semantic === "shell" ? "bashMode" :
		semantic === "mutation" ? "warning" :
		semantic === "control" ? "muted" :
		"accent";
	const base = { ...DEFAULT_PRESENTATION, label: canonicalToolName(name), accent: semanticAccent };
	const keyed = TOOL_PRESENTATIONS[name.trim().toLowerCase()] ?? {};
	const presentation = { ...base, ...keyed };
	if (status === "error") return { ...presentation, accent: "error" };
	if (mutating && presentation.accent === "accent") return { ...presentation, accent: "warning" };
	return presentation;
}
```

Pass `this.tool.presentation` from every `ToolExecutionComponent` call site. Preserve the existing exact Skill and Shell behavior.

Update `ToolExecutionComponent.detailText()` in this order:

```typescript
if (this.tool.status === "error") {
	return this.tool.errorPreview ?? this.tool.detailPreview ?? this.tool.outputPreview ?? "";
}
if (this.tool.diffPreview) return this.tool.diffPreview;
if (this.tool.contentPreview) return this.tool.contentPreview;
if (this.tool.detailPreview) return this.tool.detailPreview;
if (!this.tool.expanded && !this.tool.hiddenLineCount && singleLineText(this.tool.outputPreview)) return "";
return this.tool.outputPreview ?? "";
```

`conciseToolResult()` reads `summaryPreview` before the legacy `outputPreview`. `shouldShowCollapsedHint()` and detail line truncation must include `detailPreview` so bounded display detail is discoverable but not duplicated on the result line.

In `transcript-projection.ts`:

```typescript
function isContextTool(tool: MycliShellTool): boolean {
	if (tool.hidden || tool.mutating) return false;
	if (tool.presentation === "context") return true;
	return CONTEXT_TOOL_NAMES.has(normalizeToolName(tool.name));
}
```

Generic details use `detailPreview`; mutation details may continue to use `contentPreview`/`diffPreview` during compatibility. Do not render the display detail twice.

- [ ] **Step 5: Verify TUI tests and typecheck**

```bash
cd tui/mycli-shell
npm test
npm run typecheck
```

Expected: all tests pass, including legacy resume tests.

- [ ] **Step 6: Commit TUI consumption**

```bash
git add tui/mycli-shell/src/adapters/runtime-state.ts \
  tui/mycli-shell/src/model.ts \
  tui/mycli-shell/src/components/tool-execution.ts \
  tui/mycli-shell/src/components/tool-presentation.ts \
  tui/mycli-shell/src/transcript-projection.ts \
  tui/mycli-shell/test/runtime-state.test.ts \
  tui/mycli-shell/test/shell-app.test.ts
git diff --cached --name-only
git commit -m "Render tools from display envelopes"
```

## Task 6: Prove Full-Path Equality And Budgets

**Files:**
- Modify: `tests/unit/application/test_tool_execution_service.py`
- Modify: `tests/unit/services/test_transcript_projection.py`
- Modify: `tests/unit/cli/node_tui/test_gateway.py`
- Modify: `tui/mycli-shell/test/gateway-replay.test.ts`

- [ ] **Step 1: Add a Python full-path contract test**

Execute representative Read, Write, Shell, Skill and external fake tools. For every call:

```python
live_display = next(
    event.metadata["display"]
    for event in events
    if event.kind in {"tool_complete", "tool_failed"}
)
history_display = next(
    item.metadata["display"]
    for item in turn_items
    if item.type is TurnItemType.TOOL_RESULT
)
snapshot_display = project_history_items_for_snapshot(history_items)[0].metadata["display"]

assert live_display == history_display == snapshot_display
assert len(json.dumps(snapshot_display, ensure_ascii=False)) <= 12_000
```

Use the actual `RuntimeEventLedger.provider_history_items_from_turn()` conversion instead of constructing history metadata by hand.

- [ ] **Step 2: Add gateway replay equality**

Record a live `tool.start` plus `tool.complete` envelope and replay the equivalent `transcript.load` payload. Assert both yield the same rendered tool title, result line, detail and status. Include one legacy fixture without display to protect old sessions.

- [ ] **Step 3: Run focused full-path tests**

```bash
uv run pytest \
  tests/unit/application/test_tool_execution_service.py \
  tests/unit/services/test_transcript_projection.py \
  tests/unit/cli/node_tui/test_gateway.py -q
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs \
  --test test/runtime-state.test.ts test/gateway-replay.test.ts test/shell-app.test.ts \
  --test-reporter=dot
```

Expected: all focused tests pass.

- [ ] **Step 4: Run the complete verification gate**

```bash
cd /Users/cosmos/Desktop/mycli/.worktrees/mycli-termcn-tui-polish
uv run pytest -q
uv run ruff check src tests
uv run mypy src/mycli
git diff --check
cd tui/mycli-shell
npm test
npm run typecheck
```

Expected:

- Python suite has zero failures.
- Ruff reports `All checks passed!`.
- mypy reports no issues.
- `git diff --check` emits no output.
- Node suite has zero failures.
- TypeScript typecheck exits 0.

- [ ] **Step 5: Inspect scope and commit integration tests**

```bash
git status --short
git diff --stat
git add tests/unit/application/test_tool_execution_service.py \
  tests/unit/services/test_transcript_projection.py \
  tests/unit/cli/node_tui/test_gateway.py \
  tui/mycli-shell/test/gateway-replay.test.ts
git diff --cached --name-only
git commit -m "Verify live and resumed tool display equality"
```

Do not stage or modify `.codex/config.toml`. If overlapping pre-existing changes make a clean commit impossible, leave the verified changes uncommitted and report the exact files instead of mixing unrelated work.
