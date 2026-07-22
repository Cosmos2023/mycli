# Codex-Style File Change Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace generic Write/Edit/Patch result cards with Codex-style typed file-change cells while returning compact mutation receipts to the model and preserving live/resume parity.

**Architecture:** Python projects mutation results into a versioned `FileChangeDisplay` carried by the existing tool display envelope; the model output projector emits a separate compact receipt. TypeScript parses that contract into a dedicated transcript block and renders unified diffs through focused parser, syntax-highlighting, and file-change components. Durable tool call/result pairs remain the only persisted source, and both live and resumed paths use the same adapter.

**Tech Stack:** Python 3.13 dataclasses and pytest; TypeScript 5.9 on Node 22; existing custom TUI core; `parse-diff@0.12.0`; `cli-highlight@2.1.11`; Node test runner.

---

## File Map

**Create:**

- `src/mycli/services/file_change_display.py` - versioned file-change types, classification, line counts, and bounds.
- `tests/unit/services/test_file_change_display.py` - backend contract and projection coverage.
- `tui/mycli-shell/src/components/diff-renderer.ts` - unified-diff parsing, numbering, wrapping, and semantic row styling.
- `tui/mycli-shell/src/components/file-change.ts` - single/multi-file transcript component.
- `tui/mycli-shell/src/components/syntax-highlight.ts` - bounded `cli-highlight` adapter using mycli theme tokens.
- `tui/mycli-shell/test/file-change-component.test.ts` - component, width, theme, and fallback tests.
- `tui/mycli-shell/test/fixtures/render-file-change-theme.ts` - isolated light/dark/no-color rendering fixture.

**Modify:**

- `src/mycli/services/tool_display.py` - carry typed file changes and stop overloading successful mutation detail.
- `src/mycli/tools/model_output.py` - compact successful and failed mutation receipts.
- `src/mycli/services/context/tool_result_formatter.py` - keep legacy mutation fallback consistent with the adapter.
- `src/mycli/application/runtime/tools/tool_execution_service.py` - publish the same display contract to live events and durable metadata.
- `src/mycli/services/transcript_projection.py` - preserve typed display data in resumed snapshots.
- `tests/unit/services/test_tool_display.py` - envelope integration and fallback tests.
- `tests/unit/tools/test_model_output.py` - exact model-visible mutation output.
- `tests/unit/services/context/test_tool_result_formatter.py` - legacy formatter alignment.
- `tests/unit/application/test_tool_execution_service.py` - stored/live metadata equivalence.
- `tests/unit/services/test_transcript_projection.py` - resume round-trip coverage.
- `tui/mycli-shell/package.json` and `package-lock.json` - exact parser/highlighter dependencies.
- `tui/mycli-shell/src/model.ts` - typed file-change state and transcript union member.
- `tui/mycli-shell/src/adapters/runtime-state.ts` - shared live/resume conversion and legacy fallback.
- `tui/mycli-shell/src/theme/theme.ts` - semantic diff background tokens and color capability accessors.
- `tui/mycli-shell/src/shell-app.ts` - static transcript renderer integration.
- `tui/mycli-shell/src/shell-runtime.ts` - incremental component cache integration.
- `tui/mycli-shell/src/index.ts` - export the dedicated component.
- `tui/mycli-shell/test/runtime-state.test.ts` - typed adapter and identity tests.
- `tui/mycli-shell/test/shell-app.test.ts` - replace obsolete generic mutation expectations.

### Task 1: Add The Backend File-Change Contract

**Files:**
- Create: `src/mycli/services/file_change_display.py`
- Create: `tests/unit/services/test_file_change_display.py`

- [ ] **Step 1: Write failing contract and projection tests**

Add tests for add, update, no-op, failure, count exclusion, malformed input, and bounds:

```python
from mycli.domain.tooling.calls import ToolCall, ToolResult
from mycli.services.file_change_display import (
    FILE_CHANGE_VERSION,
    FileChangeDisplay,
    FileChangeKind,
    project_file_changes,
)


def test_projects_created_write_as_add() -> None:
    changes = project_file_changes(
        ToolCall(name="Write", arguments={"file_path": "src/new.py", "content": "x\n"}, call_id="c1"),
        ToolResult(
            success=True,
            summary="Wrote src/new.py",
            raw_payload={
                "path": "src/new.py",
                "status": "created",
                "diff": "--- src/new.py:before\n+++ src/new.py:after\n@@ -0,0 +1 @@\n+x\n",
            },
        ),
    )

    assert changes == (
        FileChangeDisplay(
            version=FILE_CHANGE_VERSION,
            kind=FileChangeKind.ADD,
            path="src/new.py",
            diff="--- src/new.py:before\n+++ src/new.py:after\n@@ -0,0 +1 @@\n+x\n",
            added_lines=1,
            removed_lines=0,
            language="py",
        ),
    )


def test_diff_counts_ignore_headers() -> None:
    change = project_file_changes(
        ToolCall(name="Edit", arguments={"file_path": "app.py"}, call_id="c2"),
        ToolResult(
            success=True,
            summary="Edited app.py",
            raw_payload={
                "path": "app.py",
                "status": "edited",
                "diff": "--- app.py:before\n+++ app.py:after\n@@ -1 +1 @@\n-old\n+new\n",
            },
        ),
    )[0]
    assert (change.added_lines, change.removed_lines) == (1, 1)
    assert change.kind is FileChangeKind.UPDATE


def test_unchanged_and_failed_results_do_not_claim_file_changes() -> None:
    call = ToolCall(name="Write", arguments={"file_path": "app.py", "content": "x"}, call_id="c3")
    unchanged = ToolResult(success=True, summary="Wrote app.py", raw_payload={"path": "app.py", "status": "unchanged", "diff": ""})
    failed = ToolResult(success=False, summary="Failed to write app.py", error="denied", raw_payload={"path": "app.py"})
    assert project_file_changes(call, unchanged) == ()
    assert project_file_changes(call, failed) == ()


def test_file_change_round_trip_rejects_unsupported_version() -> None:
    assert FileChangeDisplay.from_mapping({"version": 2, "kind": "update", "path": "app.py"}) is None


def test_large_diff_is_bounded_with_explicit_omission() -> None:
    diff = "@@ -0,0 +1,6000 @@\n" + "".join(f"+line {index}\n" for index in range(6000))
    change = project_file_changes(
        ToolCall(name="Write", arguments={"file_path": "large.py"}, call_id="c4"),
        ToolResult(success=True, summary="Wrote large.py", raw_payload={"path": "large.py", "status": "created", "diff": diff}),
    )[0]
    assert change.truncated is True
    assert change.omitted_chars > 0
    assert "omitted" in change.diff
    assert len(change.diff) <= 200_000
    assert len(change.diff.splitlines()) <= 5_000
```

- [ ] **Step 2: Run the new test file and verify it fails**

Run: `uv run pytest tests/unit/services/test_file_change_display.py -q`

Expected: collection fails with `ModuleNotFoundError: mycli.services.file_change_display`.

- [ ] **Step 3: Implement the versioned projection module**

Create immutable types and the public projection API:

```python
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import PurePath
from typing import Any

from mycli.domain.tooling.calls import ToolCall, ToolResult

FILE_CHANGE_VERSION = 1
FILE_CHANGE_MAX_CHARS = 200_000
FILE_CHANGE_MAX_LINES = 5_000


class FileChangeKind(StrEnum):
    ADD = "add"
    UPDATE = "update"
    DELETE = "delete"
    RENAME = "rename"


@dataclass(frozen=True, slots=True)
class FileChangeDisplay:
    version: int
    kind: FileChangeKind
    path: str
    previous_path: str | None = None
    diff: str = ""
    added_lines: int = 0
    removed_lines: int = 0
    truncated: bool = False
    omitted_chars: int = 0
    language: str | None = None

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "version": self.version,
            "kind": self.kind.value,
            "path": self.path,
            "diff": self.diff,
            "added_lines": self.added_lines,
            "removed_lines": self.removed_lines,
        }
        if self.previous_path:
            payload["previous_path"] = self.previous_path
        if self.truncated:
            payload["truncated"] = True
            payload["omitted_chars"] = self.omitted_chars
        if self.language:
            payload["language"] = self.language
        return payload

    @classmethod
    def from_mapping(cls, value: object) -> FileChangeDisplay | None:
        if not isinstance(value, dict) or value.get("version") != FILE_CHANGE_VERSION:
            return None
        raw_kind = value.get("kind")
        raw_path = value.get("path")
        raw_diff = value.get("diff", "")
        if not isinstance(raw_kind, str) or not isinstance(raw_path, str):
            return None
        if not isinstance(raw_diff, str):
            return None
        try:
            kind = FileChangeKind(raw_kind)
        except ValueError:
            return None
        path = raw_path.strip()
        if not path:
            return None
        return cls(
            version=FILE_CHANGE_VERSION,
            kind=kind,
            path=path,
            previous_path=_optional_text(value.get("previous_path")),
            diff=raw_diff,
            added_lines=_nonnegative_int(value.get("added_lines")),
            removed_lines=_nonnegative_int(value.get("removed_lines")),
            truncated=value.get("truncated") is True,
            omitted_chars=_nonnegative_int(value.get("omitted_chars")),
            language=_optional_text(value.get("language")),
        )


def _optional_text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _nonnegative_int(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0
```

Implement `project_file_changes(call, result)` with these exact status mappings:

```python
_STATUS_KINDS = {
    "created": FileChangeKind.ADD,
    "added": FileChangeKind.ADD,
    "written": FileChangeKind.UPDATE,
    "overwritten": FileChangeKind.UPDATE,
    "edited": FileChangeKind.UPDATE,
    "patched": FileChangeKind.UPDATE,
    "deleted": FileChangeKind.DELETE,
    "renamed": FileChangeKind.RENAME,
}
```

Prefer `raw_payload["file_changes"]` when it is a list of version-1 mappings.
Otherwise derive one entry from `status`, `path`, and `diff`. Normalize CRLF to
LF, count only content lines (not `+++`/`---`), derive `language` from the final
suffix, and bound by both constants. Preserve complete first and last hunks around
an omission marker; never classify from `call.name` alone.

- [ ] **Step 4: Run the backend contract tests**

Run: `uv run pytest tests/unit/services/test_file_change_display.py -q`

Expected: all tests pass.

- [ ] **Step 5: Commit the backend contract**

```bash
git add src/mycli/services/file_change_display.py tests/unit/services/test_file_change_display.py
git commit -m "feat: add typed file change display contract"
```

### Task 2: Return Compact Mutation Receipts To The Model

**Files:**
- Modify: `src/mycli/tools/model_output.py`
- Modify: `src/mycli/services/context/tool_result_formatter.py`
- Modify: `tests/unit/tools/test_model_output.py`
- Modify: `tests/unit/services/context/test_tool_result_formatter.py`

- [ ] **Step 1: Add exact failing receipt tests**

Add these cases to `tests/unit/tools/test_model_output.py`:

```python
def test_mutation_model_output_returns_compact_file_receipt_without_diff() -> None:
    diff = "--- app.py:before\n+++ app.py:after\n@@ -1 +1 @@\n-old\n+new\n"
    result = ToolResult(
        success=True,
        summary="Edited app.py",
        raw_payload={"path": "app.py", "status": "edited", "diff": diff},
    )

    output = mutation_model_output(result).text_content()

    assert output == "Success. Updated the following files:\nM app.py"
    assert diff not in output


def test_mutation_model_output_reports_add_delete_rename_and_noop() -> None:
    result = ToolResult(
        success=True,
        summary="Updated files",
        raw_payload={
            "file_changes": [
                {"version": 1, "kind": "add", "path": "a.py"},
                {"version": 1, "kind": "delete", "path": "b.py"},
                {"version": 1, "kind": "rename", "path": "new.py", "previous_path": "old.py"},
            ]
        },
    )
    assert mutation_model_output(result).text_content() == (
        "Success. Updated the following files:\nA a.py\nD b.py\nR old.py -> new.py"
    )

    unchanged = ToolResult(success=True, summary="Wrote app.py", raw_payload={"path": "app.py", "status": "unchanged"})
    assert mutation_model_output(unchanged).text_content() == "No changes to app.py"


def test_mutation_model_output_returns_actionable_failure_only() -> None:
    result = ToolResult(
        success=False,
        summary="Failed to edit app.py",
        error="expected lines were not found",
        raw_payload={"path": "app.py", "error_kind": "string_not_found"},
    )
    assert mutation_model_output(result).text_content() == (
        "Failed to update app.py: expected lines were not found"
    )
```

Replace the old formatter diff-preview assertion with the same compact receipt so
legacy tools cannot reintroduce a second model-visible representation.

- [ ] **Step 2: Run the focused tests and verify the old output fails**

Run: `uv run pytest tests/unit/tools/test_model_output.py tests/unit/services/context/test_tool_result_formatter.py -q`

Expected: mutation assertions fail because output still contains `Path:` and
`Diff:` or a diff preview.

- [ ] **Step 3: Implement one shared receipt formatter**

Add a helper in `file_change_display.py`:

```python
def mutation_receipt(result: ToolResult) -> str:
    path = _optional_text(result.raw_payload.get("path"))
    if not result.success:
        subject = path or "file"
        reason = result.error or result.summary
        return f"Failed to update {subject}: {reason}"
    if result.raw_payload.get("status") == "unchanged":
        return f"No changes to {path or 'file'}"
    entries = receipt_entries(result.raw_payload)
    if not entries and path:
        entries = (("M", path),)
    lines = ["Success. Updated the following files:"]
    lines.extend(f"{status} {label}" for status, label in entries)
    return "\n".join(lines)


def receipt_entries(payload: dict[str, object]) -> tuple[tuple[str, str], ...]:
    labels = {
        FileChangeKind.ADD: "A",
        FileChangeKind.UPDATE: "M",
        FileChangeKind.DELETE: "D",
        FileChangeKind.RENAME: "R",
    }
    entries: list[tuple[str, str]] = []
    raw_changes = payload.get("file_changes")
    if isinstance(raw_changes, list):
        for raw_change in raw_changes:
            change = FileChangeDisplay.from_mapping(raw_change)
            if change is None:
                continue
            path = (
                f"{change.previous_path} -> {change.path}"
                if change.kind is FileChangeKind.RENAME and change.previous_path
                else change.path
            )
            entries.append((labels[change.kind], path))
    if entries:
        return tuple(entries)
    path = _optional_text(payload.get("path"))
    status = _optional_text(payload.get("status"))
    kind = _STATUS_KINDS.get(status or "")
    return ((labels[kind], path),) if kind is not None and path else ()
```

Make `mutation_model_output` return `ToolModelOutput.from_text(mutation_receipt(result),
success=result.success)`. Make the mutation branch in `ToolResultFormatter` call
the same helper. Remove diff previews from both paths, but leave raw payloads and
session metadata unchanged.

- [ ] **Step 4: Run model output and projector tests**

Run: `uv run pytest tests/unit/tools/test_model_output.py tests/unit/services/context/test_tool_result_formatter.py tests/unit/services/context/test_tool_output_projector.py -q`

Expected: all tests pass and no successful mutation output contains `Diff:`.

- [ ] **Step 5: Commit compact model receipts**

```bash
git add src/mycli/services/file_change_display.py src/mycli/tools/model_output.py src/mycli/services/context/tool_result_formatter.py tests/unit/tools/test_model_output.py tests/unit/services/context/test_tool_result_formatter.py
git commit -m "feat: compact mutation output for model context"
```

### Task 3: Carry File Changes Through Display And Session Projection

**Files:**
- Modify: `src/mycli/services/tool_display.py`
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py`
- Modify: `src/mycli/services/transcript_projection.py`
- Modify: `tests/unit/services/test_tool_display.py`
- Modify: `tests/unit/application/test_tool_execution_service.py`
- Modify: `tests/unit/services/test_transcript_projection.py`

- [ ] **Step 1: Write failing envelope and round-trip tests**

Add a tool display test proving completed Write detail is no longer ambiguous:

```python
def test_completed_write_exposes_typed_diff_not_content_detail() -> None:
    call = ToolCall(name="Write", arguments={"file_path": "app.py", "content": "new\n"}, call_id="c1")
    result = ToolResult(
        success=True,
        summary="Wrote app.py",
        raw_payload={
            "path": "app.py",
            "status": "overwritten",
            "diff": "--- app.py:before\n+++ app.py:after\n@@ -1 +1 @@\n-old\n+new\n",
        },
    )
    display = ToolDisplayProjector().project_result(call, result)

    assert display.detail is None
    assert display.file_changes[0].kind is FileChangeKind.UPDATE
    assert display.file_changes[0].added_lines == 1
    assert ToolDisplayEnvelope.from_mapping(display.to_dict()) == display
```

Add application and transcript tests asserting `display.file_changes` is equal in
the finish lifecycle payload, durable `TOOL_RESULT` metadata, and resumed snapshot.
Assert a 200,000-character bounded diff survives without falling back to the old
8,000-character generic `detail` limit.

- [ ] **Step 2: Run the projection tests and verify failure**

Run: `uv run pytest tests/unit/services/test_tool_display.py tests/unit/application/test_tool_execution_service.py tests/unit/services/test_transcript_projection.py -q`

Expected: failures show no `file_changes` field and completed Write still places
the diff in `detail`.

- [ ] **Step 3: Extend `ToolDisplayEnvelope` and projector**

Add `file_changes: tuple[FileChangeDisplay, ...] = ()` to the dataclass. Extend
`create`, `to_dict`, and `from_mapping` to validate each entry independently:

```python
raw_changes = value.get("file_changes") if isinstance(value, dict) else None
parsed_changes: list[FileChangeDisplay] = []
if isinstance(raw_changes, list):
    for item in raw_changes:
        change = FileChangeDisplay.from_mapping(item)
        if change is not None:
            parsed_changes.append(change)
file_changes = tuple(parsed_changes)
```

In `project_result`, call `project_file_changes(call, result)` for successful
mutations. Set `detail=None` only when typed file changes are present; preserve
`GitDiff` and unknown mutation detail, running Write content in `project_start`,
and failed mutation error text.

- [ ] **Step 4: Publish one envelope in execution metadata**

In each result-recording path in `tool_execution_service.py`, compute the display
once:

```python
display = self._tool_display_projector.project_result(
    normalized_call,
    result,
    duration_ms=round(duration_seconds * 1000),
)
result_metadata = {
    # existing fields stay unchanged
    "file_changes": [change.to_dict() for change in display.file_changes],
    "display": display.to_dict(),
}
```

Replace `_file_changes_for_tool_result` with this structured source or delete it
when no caller remains. Ensure lifecycle notification and durable history receive
the same serialized display object. Keep top-level `file_changes` temporarily for
legacy clients, generated from the envelope rather than independently.

- [ ] **Step 5: Preserve structured data during resume**

Allow `display.file_changes` through `_merge_tool_display` and snapshot metadata
without flattening or applying generic detail bounds. Keep old top-level
`file_changes`, `path`, and `diff` metadata for compatibility, but make the display
envelope authoritative.

- [ ] **Step 6: Run the backend projection suite**

Run: `uv run pytest tests/unit/services/test_file_change_display.py tests/unit/services/test_tool_display.py tests/unit/application/test_tool_execution_service.py tests/unit/services/test_transcript_projection.py -q`

Expected: all tests pass; live and resumed serialized `file_changes` are equal.

- [ ] **Step 7: Commit display and history transport**

```bash
git add src/mycli/services/tool_display.py src/mycli/application/runtime/tools/tool_execution_service.py src/mycli/services/transcript_projection.py tests/unit/services/test_tool_display.py tests/unit/application/test_tool_execution_service.py tests/unit/services/test_transcript_projection.py
git commit -m "feat: transport typed file changes through sessions"
```

### Task 4: Project A Dedicated TUI Transcript Block

**Files:**
- Modify: `tui/mycli-shell/src/model.ts`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Modify: `tui/mycli-shell/test/runtime-state.test.ts`

- [ ] **Step 1: Add failing live/resume adapter tests**

Use one display fixture for both paths:

```typescript
const editDisplay = {
	target: "src/app.py",
	status: "success",
	summary: "Updated",
	presentation: "mutation",
	file_changes: [{
		version: 1,
		kind: "update",
		path: "src/app.py",
		diff: "--- src/app.py:before\n+++ src/app.py:after\n@@ -1 +1 @@\n-old\n+new\n",
		added_lines: 1,
		removed_lines: 1,
		language: "py",
	}],
};

test("runtime adapter projects equal live and resumed file changes", () => {
	const resumed = runtimeStateFromTranscript(initialRuntimeState(), {
		items: [{ id: "edit-resumed", type: "tool_summary", text: "Edit", metadata: { tool_name: "Write", call_id: "c1", display: editDisplay } }],
	});
	const live = reduceRuntimeEvent(initialRuntimeState(), "tool.complete", {
		tool_id: "edit-live", call_id: "c1", name: "Write", display: editDisplay,
	});
	const resumedBlock = projectRuntimeState(resumed).transcript?.[0];
	const liveBlock = projectRuntimeState(live).transcript?.[0];
	assert.equal(resumedBlock?.kind, "file_change");
	assert.deepEqual(
		{ ...(liveBlock?.kind === "file_change" ? liveBlock.fileChange : {}), id: "stable" },
		{ ...(resumedBlock?.kind === "file_change" ? resumedBlock.fileChange : {}), id: "stable" },
	);
});
```

Add tests for running Write remaining a generic tool, successful completion
replacing the same item ID, malformed version fallback, legacy safe update
classification, unchanged notice, and failure block. Replace current tests that
expect completed Write `contentPreview`.

- [ ] **Step 2: Run adapter tests and verify failure**

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern="file change|write content preview|mutation diff"`

Expected: typed block assertions fail because the union has no `file_change` kind.

- [ ] **Step 3: Add TUI file-change types**

Add these types to `model.ts`:

```typescript
export type MycliShellFileChangeEntry = {
	version: 1;
	kind: "add" | "update" | "delete" | "rename";
	path: string;
	previousPath?: string;
	diff: string;
	addedLines: number;
	removedLines: number;
	truncated: boolean;
	omittedChars: number;
	language?: string;
};

export type MycliShellFileChange = {
	id: string;
	callId?: string;
	status: "success" | "error" | "unchanged";
	summary: string;
	files: MycliShellFileChangeEntry[];
	error?: string;
};
```

Add `{ id: string; kind: "file_change"; fileChange: MycliShellFileChange }` to
`MycliShellTranscriptBlock`.

- [ ] **Step 4: Parse file changes once for live and resume**

Add `fileChangeFromTranscriptItem(item)` beside `toolFromTranscriptItem`. It must:

1. require typed file-change entries or a recognized Write/Edit/Patch tool;
2. return `null` while status is running;
3. validate only version `1` entries and nonnegative counts;
4. create success, unchanged, or error blocks;
5. use `item.id` and metadata `call_id` for stable identity;
6. use legacy `path`/`diff` only when `status` proves update semantics;
7. return `null` for unsafe legacy add/delete guesses.

In `projectRuntimeState`, call this function before `toolFromTranscriptItem`:

```typescript
const fileChange = fileChangeFromTranscriptItem(item);
if (fileChange) {
	transcript.push({ id: item.id, kind: "file_change", fileChange });
	continue;
}
```

Do not push completed file changes into `state.tools`; this prevents the generic
component and `Ctrl+O` from owning them.

- [ ] **Step 5: Run and typecheck the adapter**

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern="file change|write content preview|mutation diff"`

Expected: focused tests pass.

Run: `cd tui/mycli-shell && npm run typecheck`

Expected: no TypeScript errors.

- [ ] **Step 6: Commit the typed TUI projection**

```bash
git add tui/mycli-shell/src/model.ts tui/mycli-shell/src/adapters/runtime-state.ts tui/mycli-shell/test/runtime-state.test.ts
git commit -m "feat: project file changes as transcript blocks"
```

### Task 5: Add Unified-Diff Parsing And Width-Safe Layout

**Files:**
- Modify: `tui/mycli-shell/package.json`
- Modify: `tui/mycli-shell/package-lock.json`
- Create: `tui/mycli-shell/src/components/diff-renderer.ts`
- Create: `tui/mycli-shell/test/file-change-component.test.ts`

- [ ] **Step 1: Install the exact unified-diff parser**

Run: `cd tui/mycli-shell && npm install --save-exact parse-diff@0.12.0`

Expected: `package.json` and `package-lock.json` record `parse-diff` version
`0.12.0` exactly.

- [ ] **Step 2: Write failing parser and layout tests**

Create tests for content lines, headers, old/new numbers, wrapping, CJK, malformed
diff, and omission markers:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "../src/tui-core/utils.ts";
import { renderUnifiedDiff } from "../src/components/diff-renderer.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("diff renderer numbers old and new lines independently", () => {
	const lines = renderUnifiedDiff(
		"--- src/app.py:before\n+++ src/app.py:after\n@@ -24,2 +24,2 @@\n-old\n+new\n context\n",
		{ width: 80, indent: 4, language: "py" },
	).map(stripAnsi);
	assert.match(lines.join("\n"), /24 - old/);
	assert.match(lines.join("\n"), /24 \+ new/);
	assert.doesNotMatch(lines.join("\n"), /---|\+\+\+/);
});

test("diff renderer keeps every visual row within CJK terminal width", () => {
	const lines = renderUnifiedDiff("--- a.txt:before\n+++ a.txt:after\n@@ -1 +1 @@\n-旧值🙂\n+新值🙂\n", { width: 18, indent: 2 });
	for (const line of lines) assert.ok(visibleWidth(line) <= 18);
});

test("malformed diff falls back to bounded preformatted rows", () => {
	const lines = renderUnifiedDiff("not a unified diff\n+still visible", { width: 30, indent: 2 }).map(stripAnsi);
	assert.deepEqual(lines, ["  not a unified diff", "  +still visible"]);
});
```

- [ ] **Step 3: Run tests and verify the missing renderer failure**

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern="diff renderer"`

Expected: collection fails because `components/diff-renderer.ts` does not exist.

- [ ] **Step 4: Implement semantic rows and layout**

Export these stable interfaces:

```typescript
export type DiffRowKind = "context" | "add" | "remove" | "hunk" | "marker";

export type DiffRenderOptions = {
	width: number;
	indent: number;
	language?: string;
	highlight?: (code: string, language?: string) => string;
};

export function renderUnifiedDiff(diff: string, options: DiffRenderOptions): string[];
```

Use `parse-diff` for valid unified diffs. Maintain independent old/new counters
from chunk metadata, exclude file headers from content rows, and render hunk
headers in muted/accent text. Detect the backend omission marker before parser
conversion and emit a marker row. Use `wrapTextWithAnsi`, `truncateToWidth`, and
`visibleWidth` from the existing TUI utilities; continuation rows align under code
and do not repeat numbers. At narrow widths reduce indentation, then hide line
numbers before hiding signs. Fall back to bounded preformatted rows if parsing
throws or returns no chunks.

- [ ] **Step 5: Run the parser/layout tests**

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern="diff renderer"`

Expected: all parser and width tests pass.

- [ ] **Step 6: Commit parser and layout support**

```bash
git add tui/mycli-shell/package.json tui/mycli-shell/package-lock.json tui/mycli-shell/src/components/diff-renderer.ts tui/mycli-shell/test/file-change-component.test.ts
git commit -m "feat: add width-safe unified diff renderer"
```

### Task 6: Add Theme-Aware Backgrounds And Syntax Foregrounds

**Files:**
- Modify: `tui/mycli-shell/package.json`
- Modify: `tui/mycli-shell/package-lock.json`
- Modify: `tui/mycli-shell/src/theme/theme.ts`
- Create: `tui/mycli-shell/src/components/syntax-highlight.ts`
- Create: `tui/mycli-shell/test/fixtures/render-file-change-theme.ts`
- Modify: `tui/mycli-shell/test/file-change-component.test.ts`

- [ ] **Step 1: Install the exact terminal syntax highlighter**

Run: `cd tui/mycli-shell && npm install --save-exact cli-highlight@2.1.11`

Expected: package files record `cli-highlight` version `2.1.11` exactly.

- [ ] **Step 2: Write failing dark/light/no-color tests**

The fixture must import the renderer in a child process so module-level theme
environment is isolated. Define the helpers in the new test file, then add the
assertions:

```typescript
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderThemeFixture(env: NodeJS.ProcessEnv): string {
	const fixture = fileURLToPath(new URL("./fixtures/render-file-change-theme.ts", import.meta.url));
	const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/esm/index.mjs", import.meta.url));
	const result = spawnSync(process.execPath, ["--import", tsx, fixture], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

function backgroundSequenceFor(text: string, needle: string): string {
	const line = text.split("\n").find((candidate) => stripAnsi(candidate).includes(needle)) ?? "";
	return line.match(/\x1b\[48;[^m]+m/)?.[0] ?? "";
}

// test/fixtures/render-file-change-theme.ts writes one deterministic edit diff.
// It imports the renderer only after the child process environment is set.
```

Create `test/fixtures/render-file-change-theme.ts` with this body:

```typescript
import { renderUnifiedDiff } from "../../src/components/diff-renderer.ts";

const diff = "--- src/app.py:before\n+++ src/app.py:after\n@@ -24,2 +24,2 @@\n-value = \"old\"\n+value = \"new\"\n context = \"visible\"\n";
const lines = [
	"• Edited src/app.py (+1 -1)",
	...renderUnifiedDiff(diff, { width: 100, indent: 4, language: "py" }),
];
process.stdout.write(lines.join("\n"));
```

Then add the assertions:

```typescript

test("added and removed rows use distinct full-line backgrounds", () => {
	const dark = renderThemeFixture({ MYCLI_TUI_THEME: "dark", MYCLI_TUI_COLOR: "always", COLORTERM: "truecolor" });
	assert.match(dark, /\x1b\[48;2;[^m]+m.*\+ new/);
	assert.match(dark, /\x1b\[48;2;[^m]+m.*- old/);
	assert.notEqual(backgroundSequenceFor(dark, "+ new"), backgroundSequenceFor(dark, "- old"));
});

test("light theme keeps ordinary code and strings readable", () => {
	const light = renderThemeFixture({ MYCLI_TUI_THEME: "light", MYCLI_TUI_COLOR: "always", COLORTERM: "truecolor" });
	assert.match(stripAnsi(light), /value = "new"/);
	assert.match(stripAnsi(light), /context = "visible"/);
	assert.match(light, /\x1b\[38;2;/);
	assert.match(light, /\x1b\[48;2;/);
});

test("NO_COLOR preserves operation words and diff signs without escapes", () => {
	const plain = renderThemeFixture({ NO_COLOR: "1", MYCLI_TUI_COLOR: "never" });
	assert.doesNotMatch(plain, /\x1b\[/);
	assert.match(plain, /Edited src\/app\.py \(\+1 -1\)/);
	assert.match(plain, /24 - old/);
	assert.match(plain, /24 \+ new/);
});

test("256-color and 16-color fallbacks avoid truecolor escapes", () => {
	const color256 = renderThemeFixture({ COLORTERM: "", TERM: "xterm-256color", MYCLI_TUI_COLOR: "always" });
	assert.match(color256, /\x1b\[48;5;/);
	assert.doesNotMatch(color256, /\x1b\[48;2;/);
	const color16 = renderThemeFixture({ COLORTERM: "", TERM: "xterm", MYCLI_TUI_COLOR: "always" });
	assert.match(color16, /\x1b\[4[0-7]m/);
	assert.doesNotMatch(color16, /\x1b\[(?:38|48);(?:2|5);/);
});
```

- [ ] **Step 3: Run theme tests and verify failure**

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern="background|light theme|NO_COLOR|fallback"`

Expected: tests fail because semantic backgrounds and syntax adapter do not exist.

- [ ] **Step 4: Add semantic background tokens and color capability accessors**

Extend `ThemeBg` with `toolDiffAddedBg` and `toolDiffRemovedBg`. Add dark values
equivalent to low-luminance green/red and light values equivalent to pale
green/red. Extend `ColorMode` with `16color`: choose truecolor from `COLORTERM`,
256 color from a `TERM` containing `256color`, and 16 color otherwise. Map RGB
values to the nearest basic ANSI foreground/background code for that fallback.
Export read-only methods so renderers do not inspect environment:

```typescript
isColorEnabled(): boolean { return colorEnabled; }
name(): "dark" | "light" { return themeName; }
```

Keep existing `toolDiffAdded`, `toolDiffRemoved`, and `toolDiffContext` foreground
tokens. Verify both background tokens resolve in truecolor, 256-color, and
16-color modes.

- [ ] **Step 5: Implement bounded syntax highlighting**

Export:

```typescript
import { highlight, supportsLanguage, type Theme as CliHighlightTheme } from "cli-highlight";
import { theme } from "../theme/theme.ts";

export function highlightDiffCode(code: string, language: string | undefined, lineCount: number): string {
	if (!theme.isColorEnabled() || !language || lineCount > 2_000 || !supportsLanguage(language)) return code;
	return highlight(code, {
		language,
		ignoreIllegals: true,
		theme: mycliHighlightTheme(),
	});
}

function mycliHighlightTheme(): CliHighlightTheme {
	return {
		default: (text) => theme.fg("text", text),
		keyword: (text) => theme.fg("syntaxKeyword", text),
		built_in: (text) => theme.fg("syntaxType", text),
		type: (text) => theme.fg("syntaxType", text),
		title: (text) => theme.fg("syntaxFunction", text),
		function: (text) => theme.fg("syntaxFunction", text),
		variable: (text) => theme.fg("syntaxVariable", text),
		string: (text) => theme.fg("syntaxString", text),
		number: (text) => theme.fg("syntaxNumber", text),
		operator: (text) => theme.fg("syntaxOperator", text),
		punctuation: (text) => theme.fg("syntaxPunctuation", text),
		comment: (text) => theme.fg("syntaxComment", text),
	};
}
```

Map `keyword`, `built_in`, `type`, `title`, `function`, `variable`, `string`,
`number`, `operator`, `punctuation`, `comment`, and default categories to existing
`syntax*` tokens. Do not auto-detect unknown languages. In `diff-renderer.ts`,
highlight raw code first and then wrap the complete visual row with
`theme.bg("toolDiffAddedBg", row)` or `theme.bg("toolDiffRemovedBg", row)` so
foreground ANSI does not erase the semantic background. Add a direct test that
`highlightDiffCode(code, "py", 2_001)` returns the original string unchanged.

- [ ] **Step 6: Run theme, width, and parser tests**

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern="diff renderer|background|light theme|NO_COLOR|fallback|2000"`

Expected: all focused tests pass in isolated child processes.

- [ ] **Step 7: Commit color and syntax support**

```bash
git add tui/mycli-shell/package.json tui/mycli-shell/package-lock.json tui/mycli-shell/src/theme/theme.ts tui/mycli-shell/src/components/syntax-highlight.ts tui/mycli-shell/src/components/diff-renderer.ts tui/mycli-shell/test/file-change-component.test.ts tui/mycli-shell/test/fixtures/render-file-change-theme.ts
git commit -m "feat: highlight file diffs across terminal themes"
```

### Task 7: Render And Incrementally Update File-Change Cells

**Files:**
- Create: `tui/mycli-shell/src/components/file-change.ts`
- Modify: `tui/mycli-shell/src/shell-app.ts`
- Modify: `tui/mycli-shell/src/shell-runtime.ts`
- Modify: `tui/mycli-shell/src/index.ts`
- Modify: `tui/mycli-shell/test/file-change-component.test.ts`
- Modify: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Write failing single/multi-file and runtime tests**

Add component tests matching the approved rendering:

```typescript
test("file change component renders a single edited file without a tool card", () => {
	const output = stripAnsi(new FileChangeComponent({
		id: "c1",
		callId: "call-1",
		status: "success",
		summary: "Updated",
		files: [{
			version: 1, kind: "update", path: "src/app.py",
			diff: "@@ -24 +24 @@\n-old\n+new\n", addedLines: 1, removedLines: 1,
			truncated: false, omittedChars: 0, language: "py",
		}],
	}).render(100).join("\n"));

	assert.match(output, /• Edited src\/app\.py \(\+1 -1\)/);
	assert.match(output, /24 - old/);
	assert.match(output, /24 \+ new/);
	assert.doesNotMatch(output, /⏺ Write|⏺ Edit|⎿ Wrote/);
});
```

Add multi-file aggregate counts, rename labels, delete labels, no-op, failure,
truncation marker, and 40-column width tests. Add a `MycliShellRuntime` test that
starts with a running Write tool block, applies a complete event, and verifies the
same block ID now owns one `FileChangeComponent` with no duplicate generic tool.
Verify the global detail toggle does not hide its diff. Set `TERM=dumb` in one
isolated render and assert the symbols fall back to `*`, `\`, and `x` while paths,
counts, and diff signs remain unchanged.

- [ ] **Step 2: Run component/runtime tests and verify failure**

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern="file change component|running Write|global detail"`

Expected: collection or assertions fail because `FileChangeComponent` is not
integrated.

- [ ] **Step 3: Implement the file-change component**

Create `FileChangeComponent extends Container` with `updateFileChange`. Header
rules are exact:

```typescript
const VERBS = { add: "Added", update: "Edited", delete: "Deleted", rename: "Renamed" } as const;
```

- One file: `• <Verb> <path> (+A -R)`.
- Multiple files: `• Edited N files (+A -R)` followed by `  └ <path> (+A -R)`.
- Rename path: `<previousPath> -> <path>`.
- Error: `× <summary>` and `  └ <error>`.
- Unchanged: `• No changes to <path>`.
- Blank line between multi-file sections, never between a single header and diff.

Resolve glyphs at render time. Use Unicode symbols normally and
`{ bullet: "*", branch: "\\", error: "x" }` when `TERM=dumb`; color must not be
required for any operation label or count.

Use `renderUnifiedDiff` for each file and preserve all normal rows by default.
Never expose `expanded`, folding, or `Ctrl+O` state on this component.

- [ ] **Step 4: Integrate static and live transcript rendering**

Add a `file_change` branch to `TranscriptBlocksComponent`. Extend
`ChatBlockComponent` with a `FileChangeComponent` variant, update it in place when
the cached kind matches, and construct it in `syncChatBlock`. Export the component
from `index.ts`. `projectTranscriptBlocks` needs no grouping behavior; add a test
in `shell-app.test.ts` that a file change flushes adjacent context-tool groups and
remains in chronology.

- [ ] **Step 5: Remove obsolete generic mutation expectations**

Replace tests that assert `⏺ Write`, `Wrote 13 lines`, collapsed write content, or
generic mutation diffs. Keep generic mutation fallback tests for malformed and
legacy unclassifiable data. Do not alter shell/read/search rendering assertions.

- [ ] **Step 6: Run the complete TUI suite and typecheck**

Run: `cd tui/mycli-shell && npm test`

Expected: all Node tests pass.

Run: `cd tui/mycli-shell && npm run typecheck`

Expected: no TypeScript errors.

- [ ] **Step 7: Commit the dedicated transcript cell**

```bash
git add tui/mycli-shell/src/components/file-change.ts tui/mycli-shell/src/shell-app.ts tui/mycli-shell/src/shell-runtime.ts tui/mycli-shell/src/index.ts tui/mycli-shell/test/file-change-component.test.ts tui/mycli-shell/test/shell-app.test.ts
git commit -m "feat: render Codex-style file change cells"
```

### Task 8: Verify Compatibility And End-To-End Behavior

**Files:**
- No planned file changes; modify only feature files when a verification command
  exposes a regression caused by this work.

- [ ] **Step 1: Run the focused Python feature suite**

Run:

```bash
uv run pytest \
  tests/unit/services/test_file_change_display.py \
  tests/unit/services/test_tool_display.py \
  tests/unit/tools/test_model_output.py \
  tests/unit/services/context/test_tool_result_formatter.py \
  tests/unit/services/context/test_tool_output_projector.py \
  tests/unit/application/test_tool_execution_service.py \
  tests/unit/services/test_transcript_projection.py -q
```

Expected: all selected tests pass.

- [ ] **Step 2: Run the complete Python suite**

Run: `uv run pytest -q`

Expected: all tests pass. Fix only regressions attributable to the file-change
contract, compact mutation output, or transcript projection.

- [ ] **Step 3: Run complete TUI verification**

Run: `cd tui/mycli-shell && npm test`

Expected: all Node tests pass.

Run: `cd tui/mycli-shell && npm run typecheck`

Expected: no TypeScript errors.

- [ ] **Step 4: Re-run the live/resume parity tests from Tasks 3 and 4**

Run: `uv run pytest tests/unit/application/test_tool_execution_service.py tests/unit/services/test_transcript_projection.py -k "file_change" -q`

Expected: backend lifecycle and resumed snapshot file-change payloads are equal.

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern="equal live and resumed file changes"`

Expected: the TUI produces one equivalent `file_change` block per `call_id`, and
no completed mutation is projected into `state.tools`.

- [ ] **Step 5: Inspect the final diff and dependency scope**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only files named in this plan are modified, apart from pre-existing
worktree changes. Confirm `parse-diff` and `cli-highlight` are the only new direct
TUI dependencies.

- [ ] **Step 6: Confirm verification did not leave uncommitted feature fixes**

Run: `git status --short`

Expected: no uncommitted changes from this feature. If a verification regression
required a fix, return to the owning task, rerun that task's focused tests, and
commit the exact files with that task's commit command before repeating Task 8.
