# P3 Sub-agent Follow-up Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add child transcript sidechains and explicit background `Task` execution without polluting parent context.

**Architecture:** Reuse the current sync sub-agent path and add two narrow layers around it: a `SubAgentTranscriptRecorder` that writes child-only history items via `SessionService`, and a background run path in `SubAgentService` that schedules the existing child loop in a bounded in-process executor. Background execution is guarded by a small concurrency cap, a shared model-request lock, a transcript-write lock, explicit failed-state handling, and shutdown cleanup. Parent conversation continues to receive only `Task` tool results; child internals are inspected by child session id.

**Tech Stack:** Python 3.13, dataclasses, `ThreadPoolExecutor`, existing `SessionService`, `HistoryItem`, `SubAgentService`, `SubAgentChildLoop`, pytest, ruff, mypy. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-21-p3-sub-agent-follow-up-pack.md`

---

## File Structure

- `src/mycli/domain/subagents.py`: extend sub-agent invocation/result/run summary with mode and lifecycle fields.
- `src/mycli/application/runtime/subagents/transcript.py`: child transcript sidechain recorder using `SessionService.append_history_items()`.
- `src/mycli/application/runtime/subagents/loop.py`: record child loop messages, tool calls, tool results, and final status through an optional recorder; child model requests pass through an injected lock in the runtime requester.
- `src/mycli/application/runtime/subagents/service.py`: own sync/background orchestration, run state updates, concurrency cap, exception-to-failed handling, shutdown, and transcript inspection.
- `src/mycli/tools/task.py`: add optional `mode` parameter and pass it to the service.
- `src/mycli/application/runtime/agent_runtime.py`: construct and inject transcript recorder, session service, model-request lock, and transcript-write lock into `SubAgentService`.
- `src/mycli/application/turn_service.py`: add child transcript inspection formatting.
- `src/mycli/cli/repl.py`: route `/subagents <child_session_id>`.
- `tests/unit/application/runtime/subagents/test_background_concurrency.py`: verify lock and concurrency behavior without real provider calls.
- `docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md`: update sidechain/background rows after implementation.
- `docs/superpowers/reports/2026-05-21-p3-sub-agent-follow-up-pack-smoke.md`: final verification evidence.

---

### Task 1: Domain Run State And Task Mode Contracts

**Files:**
- Modify: `src/mycli/domain/subagents.py`
- Modify: `tests/unit/domain/test_subagents.py`

- [ ] **Step 1: Write failing tests for mode and lifecycle summary**

Append to `tests/unit/domain/test_subagents.py`:

```python
def test_invocation_defaults_to_sync_mode() -> None:
    invocation = SubAgentInvocation(
        agent_type="explore",
        description="Find entry points",
        allowed_tools=("Read",),
        parent_session_id="demo",
        parent_turn_id="turn_1",
    )

    assert invocation.mode == "sync"


def test_invocation_accepts_background_mode() -> None:
    invocation = SubAgentInvocation(
        agent_type="explore",
        description="Find entry points",
        allowed_tools=("Read",),
        parent_session_id="demo",
        parent_turn_id="turn_1",
        mode="background",
    )

    assert invocation.mode == "background"


def test_invalid_invocation_mode_is_rejected() -> None:
    with pytest.raises(ValueError, match="mode"):
        SubAgentInvocation(
            agent_type="explore",
            description="Find entry points",
            allowed_tools=("Read",),
            parent_session_id="demo",
            parent_turn_id="turn_1",
            mode="fork",
        )


def test_run_summary_includes_lifecycle_fields() -> None:
    invocation = SubAgentInvocation(
        agent_type="review",
        description="Review diff",
        allowed_tools=("Read",),
        parent_session_id="demo",
        parent_turn_id="turn_1",
        mode="background",
    )
    result = SubAgentResult(
        status="running",
        report="<sub-agent-report agent=\"review\" status=\"running\">started</sub-agent-report>",
        child_session_id="demo:sub:turn_1:abcd1234",
        tool_calls=0,
    )

    summary = SubAgentRunSummary.from_result(
        invocation=invocation,
        result=result,
        started_at="2026-05-21T00:00:00+00:00",
        completed_at=None,
    )

    assert summary.mode == "background"
    assert summary.parent_session_id == "demo"
    assert summary.parent_turn_id == "turn_1"
    assert summary.started_at == "2026-05-21T00:00:00+00:00"
    assert summary.completed_at is None


def test_budget_defaults_include_background_concurrency_cap() -> None:
    budget = SubAgentBudget()

    assert budget.max_concurrent_background_tasks == 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
uv run pytest tests/unit/domain/test_subagents.py -q
```

Expected: fails because `SubAgentInvocation.mode`, `SubAgentBudget.max_concurrent_background_tasks`, and new summary fields do not exist.

- [ ] **Step 3: Implement mode and lifecycle contracts**

Update `src/mycli/domain/subagents.py`:

```python
SubAgentMode = str


def _mode(value: str) -> str:
    normalized = value.strip()
    if normalized not in {"sync", "background"}:
        raise ValueError("Sub-agent mode must be 'sync' or 'background'.")
    return normalized
```

Add `mode: SubAgentMode = "sync"` to `SubAgentInvocation` and set it in `__post_init__`:

```python
object.__setattr__(self, "mode", _mode(self.mode))
```

Extend `SubAgentRunSummary`:

```python
@dataclass(slots=True, frozen=True)
class SubAgentRunSummary:
    agent_type: str
    description: str
    status: SubAgentStatus
    child_session_id: str
    tool_calls: int
    mode: SubAgentMode = "sync"
    parent_session_id: str = ""
    parent_turn_id: str = ""
    started_at: str | None = None
    completed_at: str | None = None
    error: str | None = None

    @classmethod
    def from_result(
        cls,
        *,
        invocation: SubAgentInvocation,
        result: SubAgentResult,
        started_at: str | None = None,
        completed_at: str | None = None,
    ) -> SubAgentRunSummary:
        return cls(
            agent_type=invocation.agent_type,
            description=invocation.description,
            status=result.status,
            child_session_id=result.child_session_id,
            tool_calls=result.tool_calls,
            mode=invocation.mode,
            parent_session_id=invocation.parent_session_id,
            parent_turn_id=invocation.parent_turn_id,
            started_at=started_at,
            completed_at=completed_at,
            error=result.error,
        )
```

Add `"SubAgentMode"` to `__all__`.

Add `max_concurrent_background_tasks: int = 2` to `SubAgentBudget`, and include it in the positive integer validation loop:

```python
for field_name in (
    "max_turns",
    "max_tool_calls",
    "no_progress_turn_limit",
    "report_char_limit",
    "max_concurrent_background_tasks",
):
    if getattr(self, field_name) <= 0:
        raise ValueError(f"Sub-agent {field_name} must be positive.")
```

- [ ] **Step 4: Run domain tests**

Run:

```bash
uv run pytest tests/unit/domain/test_subagents.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/domain/subagents.py tests/unit/domain/test_subagents.py
git commit -m "Track sub-agent run modes"
```

Use Lore trailers:

```text
Constraint: Background Task must remain explicit and separate from fork/worktree modes.
Rejected: Boolean background flag | mode leaves room for future modes without overloading status.
Confidence: high
Scope-risk: narrow
Tested: uv run pytest tests/unit/domain/test_subagents.py -q
```

---

### Task 2: Child Transcript Sidechain Recorder

**Files:**
- Create: `src/mycli/application/runtime/subagents/transcript.py`
- Create: `tests/unit/application/runtime/subagents/test_transcript.py`

- [ ] **Step 1: Write failing transcript recorder tests**

Create `tests/unit/application/runtime/subagents/test_transcript.py`:

```python
from __future__ import annotations

import threading

from mycli.application.runtime.subagents.transcript import SubAgentTranscriptRecorder
from mycli.domain.runtime import HistoryItemType


class FakeSessionService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[object, ...]]] = []
        self.active_writes = 0
        self.max_active_writes = 0

    def append_history_items(self, session_id: str, items: tuple[object, ...]) -> None:
        self.active_writes += 1
        self.max_active_writes = max(self.max_active_writes, self.active_writes)
        self.calls.append((session_id, items))
        self.active_writes -= 1


def test_recorder_writes_child_history_items_only() -> None:
    session_service = FakeSessionService()
    recorder = SubAgentTranscriptRecorder(
        session_service=session_service,
        parent_session_id="parent",
        child_session_id="parent:sub:turn_1:abcd",
        parent_turn_id="turn_1",
    )

    recorder.record_user_text("explore repo")
    recorder.record_assistant_text("I will inspect pyproject.")
    recorder.record_tool_call(call_id="call_1", tool_name="Read", arguments={"path": "pyproject.toml"})
    recorder.record_tool_result(call_id="call_1", tool_name="Read", content="name = 'mycli'")
    recorder.record_final(status="completed", report="Project is mycli.", tool_calls=1)

    assert [call[0] for call in session_service.calls] == [
        "parent:sub:turn_1:abcd",
        "parent:sub:turn_1:abcd",
        "parent:sub:turn_1:abcd",
        "parent:sub:turn_1:abcd",
        "parent:sub:turn_1:abcd",
    ]
    items = [call[1][0] for call in session_service.calls]
    assert [item.type for item in items] == [
        HistoryItemType.USER_MESSAGE,
        HistoryItemType.ASSISTANT_MESSAGE,
        HistoryItemType.TOOL_CALL,
        HistoryItemType.TOOL_RESULT,
        HistoryItemType.ASSISTANT_MESSAGE,
    ]
    assert items[0].thread_id == "parent:sub:turn_1:abcd"
    assert items[0].metadata["parent_session_id"] == "parent"
    assert items[2].call_id == "call_1"
    assert items[3].call_id == "call_1"
    assert items[4].metadata["sub_agent_status"] == "completed"
    assert items[4].metadata["tool_calls"] == 1


def test_recorder_uses_write_lock() -> None:
    session_service = FakeSessionService()
    lock = threading.Lock()
    recorder = SubAgentTranscriptRecorder(
        session_service=session_service,
        parent_session_id="parent",
        child_session_id="parent:sub:turn_1:abcd",
        parent_turn_id="turn_1",
        write_lock=lock,
    )

    recorder.record_user_text("explore repo")

    assert session_service.max_active_writes == 1
```

- [ ] **Step 2: Run transcript tests to verify they fail**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_transcript.py -q
```

Expected: fails because `transcript.py` does not exist.

- [ ] **Step 3: Implement recorder**

Create `src/mycli/application/runtime/subagents/transcript.py`:

```python
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from threading import Lock
from typing import Any, Protocol
from uuid import uuid4

from mycli.domain.runtime import HistoryItem, HistoryItemType


class SupportsHistoryAppend(Protocol):
    def append_history_items(self, session_id: str, items: tuple[HistoryItem, ...]) -> None:
        ...


@dataclass(slots=True)
class SubAgentTranscriptRecorder:
    session_service: SupportsHistoryAppend
    parent_session_id: str
    child_session_id: str
    parent_turn_id: str
    write_lock: Lock | None = None

    def record_system_text(self, text: str) -> None:
        self._append(HistoryItemType.USER_MESSAGE, text=text, metadata={"role": "system"})

    def record_user_text(self, text: str) -> None:
        self._append(HistoryItemType.USER_MESSAGE, text=text)

    def record_assistant_text(self, text: str) -> None:
        self._append(HistoryItemType.ASSISTANT_MESSAGE, text=text)

    def record_tool_call(
        self,
        *,
        call_id: str | None,
        tool_name: str,
        arguments: Mapping[str, Any],
    ) -> None:
        self._append(
            HistoryItemType.TOOL_CALL,
            tool_name=tool_name,
            call_id=call_id,
            metadata={"arguments": dict(arguments)},
        )

    def record_tool_result(
        self,
        *,
        call_id: str | None,
        tool_name: str,
        content: str,
    ) -> None:
        self._append(
            HistoryItemType.TOOL_RESULT,
            text=content,
            tool_name=tool_name,
            call_id=call_id,
        )

    def record_final(self, *, status: str, report: str, tool_calls: int) -> None:
        self._append(
            HistoryItemType.ASSISTANT_MESSAGE,
            text=report,
            metadata={"sub_agent_status": status, "tool_calls": tool_calls},
        )

    def _append(
        self,
        item_type: HistoryItemType,
        *,
        text: str | None = None,
        tool_name: str | None = None,
        call_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        payload = {
            "parent_session_id": self.parent_session_id,
            "parent_turn_id": self.parent_turn_id,
            **(metadata or {}),
        }
        item = HistoryItem(
            id=f"{self.child_session_id}:{uuid4().hex}",
            thread_id=self.child_session_id,
            turn_id=self.parent_turn_id,
            type=item_type,
            text=text,
            tool_name=tool_name,
            call_id=call_id,
            metadata=payload,
        )
        if self.write_lock is None:
            self.session_service.append_history_items(self.child_session_id, (item,))
            return
        with self.write_lock:
            self.session_service.append_history_items(self.child_session_id, (item,))


__all__ = ["SubAgentTranscriptRecorder", "SupportsHistoryAppend"]
```

- [ ] **Step 4: Run transcript tests**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_transcript.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/subagents/transcript.py tests/unit/application/runtime/subagents/test_transcript.py
git commit -m "Persist child sub-agent transcripts"
```

Use Lore trailers:

```text
Constraint: Child internals must be inspectable without entering parent context replay.
Rejected: Store transcript in parent tool result | it would bloat parent context and break P3 isolation.
Confidence: high
Scope-risk: narrow
Tested: uv run pytest tests/unit/application/runtime/subagents/test_transcript.py -q
```

---

### Task 3: Record Child Loop Transcript Events

**Files:**
- Modify: `src/mycli/application/runtime/subagents/loop.py`
- Modify: `tests/unit/application/runtime/subagents/test_child_loop.py`

- [ ] **Step 1: Write failing child loop transcript test**

Append to `tests/unit/application/runtime/subagents/test_child_loop.py`:

```python
class FakeTranscriptRecorder:
    def __init__(self) -> None:
        self.events: list[tuple[str, object]] = []

    def record_system_text(self, text: str) -> None:
        self.events.append(("system", text))

    def record_user_text(self, text: str) -> None:
        self.events.append(("user", text))

    def record_assistant_text(self, text: str) -> None:
        self.events.append(("assistant", text))

    def record_tool_call(self, *, call_id, tool_name, arguments) -> None:
        self.events.append(("tool_call", (call_id, tool_name, arguments)))

    def record_tool_result(self, *, call_id, tool_name, content) -> None:
        self.events.append(("tool_result", (call_id, tool_name, content)))

    def record_final(self, *, status: str, report: str, tool_calls: int) -> None:
        self.events.append(("final", (status, report, tool_calls)))


def test_child_loop_records_transcript_events() -> None:
    requester = FakeRequester(
        [
            FakeTurn(text="Need file", tool_calls=(ToolCall(name="Read", arguments={"path": "README.md"}, reason="", call_id="call_1"),)),
            FakeTurn(text="README says mycli.", tool_calls=()),
        ]
    )
    executor = FakeExecutor()
    recorder = FakeTranscriptRecorder()
    loop = SubAgentChildLoop(requester=requester, executor=executor)

    result = loop.run(
        invocation=invocation(),
        profile=profile(),
        child_session_id="demo:sub:turn_1:abcd1234",
        tool_names=("Read",),
        transcript=recorder,
    )

    assert result.status == "completed"
    assert [event[0] for event in recorder.events] == [
        "system",
        "user",
        "assistant",
        "tool_call",
        "tool_result",
        "final",
    ]
```

- [ ] **Step 2: Run child loop tests to verify they fail**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_child_loop.py -q
```

Expected: fails because `SubAgentChildLoop.run()` does not accept `transcript`.

- [ ] **Step 3: Add optional transcript protocol to child loop**

In `src/mycli/application/runtime/subagents/loop.py`, add:

```python
class ChildTranscriptRecorder(Protocol):
    def record_system_text(self, text: str) -> None: ...
    def record_user_text(self, text: str) -> None: ...
    def record_assistant_text(self, text: str) -> None: ...
    def record_tool_call(self, *, call_id: str | None, tool_name: str, arguments: dict[str, object]) -> None: ...
    def record_tool_result(self, *, call_id: str | None, tool_name: str, content: str) -> None: ...
    def record_final(self, *, status: str, report: str, tool_calls: int) -> None: ...
```

Update `SubAgentChildLoop.run()` signature:

```python
transcript: ChildTranscriptRecorder | None = None,
```

After creating initial messages:

```python
if transcript is not None:
    transcript.record_system_text(profile.system_prompt)
    transcript.record_user_text(invocation.description)
```

Before returning final text:

```python
if transcript is not None:
    transcript.record_final(status="completed", report=text, tool_calls=tool_calls)
```

When assistant has text and tool calls:

```python
if text and transcript is not None:
    transcript.record_assistant_text(text)
```

Before executing each call:

```python
if transcript is not None:
    transcript.record_tool_call(
        call_id=call.call_id,
        tool_name=call.name,
        arguments=call.arguments,
    )
```

After formatting tool result:

```python
formatted_result = self._formatter.format(call.name, result)
if transcript is not None:
    transcript.record_tool_result(
        call_id=call.call_id,
        tool_name=call.name,
        content=formatted_result,
    )
```

Use `formatted_result` for the message content.

For every non-completed return (`max_no_progress`, `max_tool_calls`, `approval_required`, `max_turns`), call `record_final()` with the same status/report/tool_calls.

- [ ] **Step 4: Run child loop tests**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_child_loop.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/subagents/loop.py tests/unit/application/runtime/subagents/test_child_loop.py
git commit -m "Record child loop sidechain events"
```

Use Lore trailers:

```text
Constraint: Parent conversation must continue to receive only Task tool results.
Rejected: Reconstruct sidechain after completion | provider errors and partial tool progress would be lost.
Confidence: medium
Scope-risk: moderate
Tested: uv run pytest tests/unit/application/runtime/subagents/test_child_loop.py -q
```

---

### Task 4: Service-Level Sidechain Inspection

**Files:**
- Modify: `src/mycli/application/runtime/subagents/service.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/cli/repl.py`
- Modify: `tests/unit/application/runtime/subagents/test_sub_agent_service.py`
- Modify: `tests/unit/application/test_turn_service_subagents.py`
- Modify: `tests/integration/test_cli_repl.py`

- [ ] **Step 1: Write failing service inspection test**

Append to `tests/unit/application/runtime/subagents/test_sub_agent_service.py`:

```python
from mycli.domain.runtime import HistoryItem, HistoryItemType


class FakeHistorySessionService:
    def __init__(self) -> None:
        self.items: dict[str, tuple[HistoryItem, ...]] = {}

    def load_history_items(self, session_id: str) -> tuple[HistoryItem, ...]:
        return self.items.get(session_id, ())


def test_service_formats_child_transcript() -> None:
    session_service = FakeHistorySessionService()
    session_service.items["demo:sub:turn_1:abcd1234"] = (
        HistoryItem(
            id="1",
            thread_id="demo:sub:turn_1:abcd1234",
            turn_id="turn_1",
            type=HistoryItemType.USER_MESSAGE,
            text="Inspect repo",
        ),
        HistoryItem(
            id="2",
            thread_id="demo:sub:turn_1:abcd1234",
            turn_id="turn_1",
            type=HistoryItemType.TOOL_CALL,
            tool_name="Read",
            call_id="call_1",
            metadata={"arguments": {"path": "pyproject.toml"}},
        ),
        HistoryItem(
            id="3",
            thread_id="demo:sub:turn_1:abcd1234",
            turn_id="turn_1",
            type=HistoryItemType.TOOL_RESULT,
            text="name = 'mycli'",
            tool_name="Read",
            call_id="call_1",
        ),
    )
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeChildLoop(SubAgentResult(status="completed", report="ok", child_session_id="ignored", tool_calls=0)),
        session_service=session_service,
    )

    lines = service.inspect_transcript("demo:sub:turn_1:abcd1234")

    assert lines == (
        "demo:sub:turn_1:abcd1234",
        "  user Inspect repo",
        "  tool_call Read call_1 {'path': 'pyproject.toml'}",
        "  tool_result Read call_1 14 chars name = 'mycli'",
    )
```

- [ ] **Step 2: Run service test to verify it fails**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_sub_agent_service.py::test_service_formats_child_transcript -q
```

Expected: fails because `SubAgentService` has no `session_service` or `inspect_transcript`.

- [ ] **Step 3: Implement transcript inspection**

In `src/mycli/application/runtime/subagents/service.py`:

- Add optional `session_service` constructor dependency.
- Add `inspect_transcript(child_session_id: str) -> tuple[str, ...]`.
- Load `session_service.load_history_items(child_session_id)`.
- Format:

```python
header = child_session_id
if item.type is HistoryItemType.TOOL_CALL:
    args = item.metadata.get("arguments", {})
    return f"  tool_call {item.tool_name or ''} {item.call_id or ''} {args}".strip()
if item.type is HistoryItemType.TOOL_RESULT:
    preview = (item.text or "").replace("\n", "\\n")[:500]
    size = len(item.text or "")
    return f"  tool_result {item.tool_name or ''} {item.call_id or ''} {size} chars {preview}".strip()
if item.type is HistoryItemType.ASSISTANT_MESSAGE:
    status = item.metadata.get("sub_agent_status")
    label = "final" if isinstance(status, str) else "assistant"
    prefix = f"{label} {status}" if label == "final" else label
    return f"  {prefix} {(item.text or '').replace(chr(10), ' ')[:500]}".strip()
return f"  user {(item.text or '').replace(chr(10), ' ')[:500]}".strip()
```

Return `("sub-agent transcript not found: <id>",)` when no items exist.

If the child id is present in recent run summaries, the first line should be:

```text
<agent_type> <status> mode=<mode> tools=<tool_calls> <child_session_id>
```

Otherwise use `child_session_id` as the first line.

- [ ] **Step 4: Wire runtime and slash command inspection**

In `src/mycli/application/runtime/agent_runtime.py`, pass `session_service=self._session_service` to `SubAgentService`.

Add method:

```python
def inspect_subagent_transcript(self, child_session_id: str) -> tuple[str, ...]:
    return self._sub_agent_service.inspect_transcript(child_session_id)
```

In `src/mycli/application/turn_service.py`, change:

```python
def inspect_subagents(self, child_session_id: str | None = None) -> tuple[str, ...]:
    if child_session_id:
        inspect = getattr(self._runtime, "inspect_subagent_transcript", None)
        if callable(inspect):
            return tuple(inspect(child_session_id))
        return (f"sub-agent transcript not found: {child_session_id}",)
    ...
```

In `src/mycli/cli/repl.py`, route:

```python
if command.startswith("/subagents"):
    parts = command.split(maxsplit=1)
    child_session_id = parts[1] if len(parts) > 1 else None
    return [f"[subagent] {line}" for line in service.inspect_subagents(child_session_id)]
```

- [ ] **Step 5: Add focused TurnService and REPL tests**

Update `tests/unit/application/test_turn_service_subagents.py` with a fake runtime method:

```python
def inspect_subagent_transcript(self, child_session_id: str) -> tuple[str, ...]:
    return (f"transcript {child_session_id}",)
```

Add:

```python
def test_turn_service_formats_child_transcript_request() -> None:
    service = object.__new__(TurnService)
    service._runtime = FakeRuntime()

    assert service.inspect_subagents("demo:sub:turn_1:abcd1234") == (
        "transcript demo:sub:turn_1:abcd1234",
    )
```

Update `tests/integration/test_cli_repl.py` command routing test to include `/subagents demo:sub:turn_1:abcd1234` and assert the command handler receives the full command.

Add an assertion in the service inspection test that the default summary format is stable after a completed run:

```python
assert service.recent_runs()[0].mode == "sync"
```

- [ ] **Step 6: Run inspection tests**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_sub_agent_service.py::test_service_formats_child_transcript tests/unit/application/test_turn_service_subagents.py tests/integration/test_cli_repl.py -q
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/mycli/application/runtime/subagents/service.py src/mycli/application/runtime/agent_runtime.py src/mycli/application/turn_service.py src/mycli/cli/repl.py tests/unit/application/runtime/subagents/test_sub_agent_service.py tests/unit/application/test_turn_service_subagents.py tests/integration/test_cli_repl.py
git commit -m "Expose child sub-agent transcripts"
```

Use Lore trailers:

```text
Constraint: Transcript inspection must not replay child history into parent context.
Rejected: Show full transcript in default /subagents | it is noisy and can leak large tool results into the terminal unexpectedly.
Confidence: high
Scope-risk: moderate
Tested: uv run pytest tests/unit/application/runtime/subagents/test_sub_agent_service.py::test_service_formats_child_transcript tests/unit/application/test_turn_service_subagents.py tests/integration/test_cli_repl.py -q
```

---

### Task 5: Model Request Lock

**Files:**
- Modify: `src/mycli/application/runtime/subagents/loop.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Create: `tests/unit/application/runtime/subagents/test_background_concurrency.py`

- [ ] **Step 1: Write failing model lock test**

Create `tests/unit/application/runtime/subagents/test_background_concurrency.py`:

```python
from __future__ import annotations

import threading

from mycli.application.runtime.subagents.loop import RuntimeChildTurnRequester
from mycli.domain.runtime import ModelTurnResult


class FakeRequester:
    def __init__(self) -> None:
        self.active = 0
        self.max_active = 0

    def request_model_turn(self, *, runtime_items, legacy_messages, tools):
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        self.active -= 1
        return ModelTurnResult(items=(), done=True), ()


def test_runtime_child_turn_requester_uses_model_request_lock() -> None:
    requester = FakeRequester()
    lock = threading.Lock()
    child_requester = RuntimeChildTurnRequester(
        requester=requester,
        tool_exposure_builder=lambda tool_names: None,
        tool_renderer=lambda exposure: [],
        model_request_lock=lock,
    )

    child_requester.request_child_turn(
        messages=[{"role": "user", "content": "hello"}],
        tool_names=(),
        child_session_id="demo:sub:turn_1:abcd",
    )

    assert requester.max_active == 1
```

- [ ] **Step 2: Run lock test to verify it fails**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_background_concurrency.py::test_runtime_child_turn_requester_uses_model_request_lock -q
```

Expected: fails because `RuntimeChildTurnRequester` has no `model_request_lock` field.

- [ ] **Step 3: Implement model request lock**

In `src/mycli/application/runtime/subagents/loop.py`, add `model_request_lock` to `RuntimeChildTurnRequester`:

```python
from threading import Lock

@dataclass(slots=True)
class RuntimeChildTurnRequester:
    requester: RuntimeModelTurnRequester
    tool_exposure_builder: Callable[[tuple[str, ...]], ToolExposure]
    tool_renderer: Callable[[ToolExposure], list[ModelToolDefinition]]
    model_request_lock: Lock | None = None
```

Wrap the model request:

```python
if self.model_request_lock is None:
    turn_result, _streamed = self.requester.request_model_turn(...)
else:
    with self.model_request_lock:
        turn_result, _streamed = self.requester.request_model_turn(...)
```

In `src/mycli/application/runtime/agent_runtime.py`, create one lock:

```python
from threading import Lock

self._sub_agent_model_request_lock = Lock()
```

Pass it to `RuntimeChildTurnRequester`.

- [ ] **Step 4: Run lock test**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_background_concurrency.py::test_runtime_child_turn_requester_uses_model_request_lock -q
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/subagents/loop.py src/mycli/application/runtime/agent_runtime.py tests/unit/application/runtime/subagents/test_background_concurrency.py
git commit -m "Serialize child model requests"
```

Use Lore trailers:

```text
Constraint: Provider adapters and HTTP clients are not assumed to be thread-safe.
Rejected: Let parent and background child call the shared adapter concurrently | undefined provider/client behavior is harder to debug than bounded serialization.
Confidence: medium
Scope-risk: moderate
Tested: uv run pytest tests/unit/application/runtime/subagents/test_background_concurrency.py::test_runtime_child_turn_requester_uses_model_request_lock -q
```

---

### Task 6: Explicit Background Task Execution

**Files:**
- Modify: `src/mycli/application/runtime/subagents/service.py`
- Modify: `src/mycli/tools/task.py`
- Modify: `tests/unit/application/runtime/subagents/test_sub_agent_service.py`
- Modify: `tests/unit/tools/test_task_tool.py`
- Modify: `tests/unit/application/runtime/subagents/test_background_concurrency.py`

- [ ] **Step 1: Write failing background service test**

Append to `tests/unit/application/runtime/subagents/test_sub_agent_service.py`:

```python
class InlineBackgroundExecutor:
    def submit(self, fn, *args, **kwargs):
        class DoneFuture:
            def result(self):
                return fn(*args, **kwargs)
        return DoneFuture()


class HoldingBackgroundExecutor:
    def __init__(self) -> None:
        self.submitted: list[tuple[object, tuple[object, ...], dict[str, object]]] = []

    def submit(self, fn, *args, **kwargs):
        self.submitted.append((fn, args, kwargs))

        class PendingFuture:
            def result(self, timeout=None):
                raise TimeoutError("still running")

        return PendingFuture()


class ExplodingChildLoop:
    def __init__(self, exc: Exception) -> None:
        self.exc = exc

    def run(self, **kwargs):
        raise self.exc


def test_background_task_returns_running_then_records_completion() -> None:
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeChildLoop(
            SubAgentResult(
                status="completed",
                report="done",
                child_session_id="ignored",
                tool_calls=1,
            )
        ),
        background_executor=InlineBackgroundExecutor(),
    )

    result = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )

    assert result.status == "running"
    assert result.tool_calls == 0
    summaries = service.recent_runs()
    assert summaries[0].status == "completed"
    assert summaries[0].mode == "background"


def test_background_task_rejects_when_concurrency_cap_is_reached() -> None:
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeChildLoop(SubAgentResult(status="completed", report="done", child_session_id="ignored", tool_calls=1)),
        background_executor=HoldingBackgroundExecutor(),
        max_concurrent_background_tasks=1,
    )

    first = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )
    second = service.run_task(
        description="Inspect repo again",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )

    assert first.status == "running"
    assert second.status == "failed"
    assert second.error == "Background sub-agent concurrency limit reached."


def test_background_task_exception_becomes_failed_summary() -> None:
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=ExplodingChildLoop(RuntimeError("provider failed")),
        background_executor=InlineBackgroundExecutor(),
    )

    result = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )

    assert result.status == "running"
    assert service.recent_runs()[0].status == "failed"
    assert service.recent_runs()[0].error == "provider failed"
```

- [ ] **Step 2: Run background service test to verify it fails**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_sub_agent_service.py::test_background_task_returns_running_then_records_completion -q
```

Expected: fails because `run_task()` has no `mode`, service has no background executor, and helper fakes do not exist yet.

- [ ] **Step 3: Implement background path**

In `src/mycli/application/runtime/subagents/service.py`:

- Add constructor dependency:

```python
background_executor: object | None = None
max_concurrent_background_tasks: int = 2
```

If `None`, create:

```python
from concurrent.futures import ThreadPoolExecutor
self._background_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="mycli-subagent")
```

- Update `run_task(..., mode: str = "sync")`.
- Create `SubAgentInvocation(..., mode=mode)`.
- If `mode == "background"`:
  - if current running background count is greater than or equal to `max_concurrent_background_tasks`, return failed result immediately.
  - record a running summary/result immediately.
  - submit a closure that calls the existing sync execution helper and updates recent runs with final result.
  - return running `SubAgentResult` with started XML.

Extract the existing profile/scope/loop path into:

```python
def _run_sync_invocation(self, invocation: SubAgentInvocation, child_session_id: str) -> SubAgentResult:
    ...
```

For background completion, remove or supersede the running summary for the same `child_session_id` before appending final summary. A simple implementation can rebuild the deque:

```python
self._recent_runs = deque(
    (summary for summary in self._recent_runs if summary.child_session_id != child_session_id),
    maxlen=self._recent_runs.maxlen,
)
self._record(invocation, final_result, started_at=started_at, completed_at=self._timestamp())
```

The background closure must be:

```python
try:
    final_result = self._run_sync_invocation(invocation, child_session_id)
except Exception as exc:
    final_result = SubAgentResult(
        status="failed",
        report=self._xml_report(
            agent=invocation.agent_type,
            status="failed",
            tool_calls=0,
            child_session_id=child_session_id,
            body=f"Background sub-agent failed: {exc}",
            limit=8000,
        ),
        child_session_id=child_session_id,
        tool_calls=0,
        error=str(exc),
    )
finally:
    self._mark_background_finished(invocation, final_result, started_at)
```

Keep a dict of running futures by `child_session_id` so concurrency and shutdown can inspect them.

- [ ] **Step 4: Add Task tool mode tests**

Update `tests/unit/tools/test_task_tool.py` fake service signature:

```python
def run_task(..., mode: str = "sync") -> SubAgentResult:
    self.calls.append({"description": description, "agent_type": agent_type, "allowed_tools": allowed_tools, "mode": mode})
```

Add:

```python
def test_task_tool_passes_background_mode() -> None:
    service = FakeSubAgentService()
    tool = TaskTool(service=service)

    result = tool.execute(
        {
            "description": "Inspect repo",
            "agent_type": "explore",
            "allowed_tools": ["Read"],
            "mode": "background",
        }
    )

    assert result.raw_payload["kind"] == "sub_agent_report"
    assert service.calls[0]["mode"] == "background"
```

- [ ] **Step 5: Update Task tool schema and execution**

In `src/mycli/tools/task.py`:

- Add optional `mode` parameter to `ToolSpec`.
- Update protocol:

```python
mode: str = "sync",
```

- Parse:

```python
mode = str(arguments.get("mode", "sync"))
```

- Pass mode to `run_task()`.

- [ ] **Step 6: Run background tests**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_sub_agent_service.py::test_background_task_returns_running_then_records_completion tests/unit/application/runtime/subagents/test_sub_agent_service.py::test_background_task_rejects_when_concurrency_cap_is_reached tests/unit/application/runtime/subagents/test_sub_agent_service.py::test_background_task_exception_becomes_failed_summary tests/unit/tools/test_task_tool.py -q
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/mycli/application/runtime/subagents/service.py src/mycli/tools/task.py tests/unit/application/runtime/subagents/test_sub_agent_service.py tests/unit/tools/test_task_tool.py
git commit -m "Run Task sub-agents in background mode"
```

Use Lore trailers:

```text
Constraint: P3.2 background mode is explicit and in-process only; no cross-process recovery.
Rejected: Automatic backgrounding after a timer | it adds cancellation and notification semantics before sidechain inspection is mature.
Confidence: medium
Scope-risk: moderate
Tested: uv run pytest tests/unit/application/runtime/subagents/test_sub_agent_service.py::test_background_task_returns_running_then_records_completion tests/unit/application/runtime/subagents/test_sub_agent_service.py::test_background_task_rejects_when_concurrency_cap_is_reached tests/unit/application/runtime/subagents/test_sub_agent_service.py::test_background_task_exception_becomes_failed_summary tests/unit/tools/test_task_tool.py -q
```

---

### Task 7: Background Shutdown

**Files:**
- Modify: `src/mycli/application/runtime/subagents/service.py`
- Modify: `tests/unit/application/runtime/subagents/test_sub_agent_service.py`

- [ ] **Step 1: Write failing shutdown test**

Append to `tests/unit/application/runtime/subagents/test_sub_agent_service.py`:

```python
def test_shutdown_marks_unfinished_background_runs_failed() -> None:
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeChildLoop(SubAgentResult(status="completed", report="done", child_session_id="ignored", tool_calls=1)),
        background_executor=HoldingBackgroundExecutor(),
        max_concurrent_background_tasks=1,
    )
    started = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )

    service.shutdown(timeout_seconds=0)

    summary = service.recent_runs()[0]
    assert started.status == "running"
    assert summary.child_session_id == started.child_session_id
    assert summary.status == "failed"
    assert summary.error == "Background sub-agent shutdown timeout."
```

- [ ] **Step 2: Run shutdown test to verify it fails**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_sub_agent_service.py::test_shutdown_marks_unfinished_background_runs_failed -q
```

Expected: fails because `SubAgentService.shutdown()` does not exist.

- [ ] **Step 3: Implement shutdown**

In `src/mycli/application/runtime/subagents/service.py`, add:

```python
def shutdown(self, *, timeout_seconds: float = 2.0) -> None:
    deadline = monotonic() + timeout_seconds
    for child_session_id, run in list(self._running_background.items()):
        remaining = max(0.0, deadline - monotonic())
        try:
            run.future.result(timeout=remaining)
        except TimeoutError:
            failed = SubAgentResult(
                status="failed",
                report=self._xml_report(...),
                child_session_id=child_session_id,
                tool_calls=run.tool_calls,
                error="Background sub-agent shutdown timeout.",
            )
            self._mark_background_finished(run.invocation, failed, run.started_at)
```

Also call `shutdown(wait=False)` or equivalent on internally owned `ThreadPoolExecutor` after marking runs, if available. Do not attempt cross-process recovery.

- [ ] **Step 4: Run shutdown test**

Run:

```bash
uv run pytest tests/unit/application/runtime/subagents/test_sub_agent_service.py::test_shutdown_marks_unfinished_background_runs_failed -q
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/subagents/service.py tests/unit/application/runtime/subagents/test_sub_agent_service.py
git commit -m "Fail unfinished background sub-agents on shutdown"
```

Use Lore trailers:

```text
Constraint: P3.2 does not support cross-process background recovery.
Rejected: Let unfinished futures disappear on process exit | running summaries would remain misleading.
Confidence: medium
Scope-risk: narrow
Tested: uv run pytest tests/unit/application/runtime/subagents/test_sub_agent_service.py::test_shutdown_marks_unfinished_background_runs_failed -q
```

---

### Task 8: Gap Doc, Smoke Report, And Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md`
- Create: `docs/superpowers/reports/2026-05-21-p3-sub-agent-follow-up-pack-smoke.md`

- [ ] **Step 1: Update gap doc**

In `docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md`:

- Update current state bullets to include P3 follow-up:

```markdown
- P3 sub-agent follow-up: child transcript sidechain, `/subagents <child_session_id>` inspection, and explicit in-process background `Task` mode.
```

- Change row `5.8 Transcript sidechain` from ❌ to ⚠️ and note:

```markdown
Child sub-agent history is persisted under child session ids and inspectable with `/subagents <child_session_id>`; not yet Claude-style full JSONL sidechain.
```

- Change row `7.1 5 种 agent 模式` note to:

```markdown
P3 covers sync in-process `Task`; P3 follow-up adds explicit background mode. fork/worktree/remote remain open.
```

- Keep `7.2 Fork 缓存共享` as ❌.

- [ ] **Step 2: Run full verification**

Run:

```bash
uv run ruff check src tests
uv run mypy src/mycli
uv run pytest -q
```

Expected:

- ruff: `All checks passed!`
- mypy: `Success: no issues found`
- pytest: all tests pass

- [ ] **Step 3: Run real API smoke**

Use the project config without printing secrets:

```bash
printf '请用 Task background explore 子代理完成一个普通仓库探索任务：读取 pyproject 或 README，找出项目名称和主要语言。父 agent 只需要告诉我子代理已经启动。随后我会用 /subagents 查看状态。\\n/subagents\\n/quit\\n' | uv run mycli --session p3-followup-background-smoke
```

Expected:

- Parent calls `Task` with `mode="background"` or equivalent background request.
- Tool result returns `status=running` quickly.
- `/subagents` shows a running or completed background child.
- The command does not print API keys or provider secrets.

Then inspect the printed child session id:

```bash
printf '/subagents <child_session_id>\\n/quit\\n' | uv run mycli --session p3-followup-background-smoke
```

Expected:

- transcript lines include child user task and at least one assistant/tool event or final report.
- transcript lines follow the fixed two-space-indented child transcript format.

- [ ] **Step 4: Write smoke report**

Create `docs/superpowers/reports/2026-05-21-p3-sub-agent-follow-up-pack-smoke.md`:

```markdown
# P3 Sub-agent Follow-up Pack Smoke

## Commands

- `uv run ruff check src tests`
  - Result: record the exact ruff status line from the command output.
- `uv run mypy src/mycli`
  - Result: record the exact mypy status line from the command output.
- `uv run pytest -q`
  - Result: record the exact pytest summary line from the command output.
- Real API background Task smoke with project `.mycli/config.toml`
  - Result: summarize the observed Task status, child session id, and transcript inspection result without including secrets.

## Evidence

- Child transcript sidechain persists under child session id.
- `/subagents` lists recent sync/background child runs.
- `/subagents <child_session_id>` renders child transcript summary without replaying it into parent context.
- Background Task enforces the configured concurrency cap.
- Child model requests use the shared model request lock.
- Sidechain writes use the transcript write lock.
- Background worker exceptions become failed summaries.
- Shutdown marks unfinished background children failed.
- `Task(mode="background")` returns `running` immediately and later updates run summary.
- Sync Task behavior remains compatible.

## Known Gaps

- No fork cache sharing.
- No async mailbox or SendMessage.
- No automatic 2-minute backgrounding.
- No cross-process background recovery.
- No coordinator/team or worktree/remote agents.
```

Replace placeholder result text with actual outputs.

- [ ] **Step 5: Placeholder scan**

Run:

```bash
rg -n "T[B]D|T[O]DO|PLACE[H]OLDER|implement [l]ater|fill [i]n" docs/superpowers/specs/2026-05-21-p3-sub-agent-follow-up-pack.md docs/superpowers/plans/2026-05-21-p3-sub-agent-follow-up-pack.md docs/superpowers/reports/2026-05-21-p3-sub-agent-follow-up-pack-smoke.md
```

Expected: no matches after the smoke report is filled.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md docs/superpowers/reports/2026-05-21-p3-sub-agent-follow-up-pack-smoke.md
git commit -m "Document sub-agent follow-up verification"
```

Use Lore trailers:

```text
Constraint: Follow-up pack intentionally excludes fork cache sharing and async mailbox.
Confidence: medium
Scope-risk: narrow
Tested: uv run ruff check src tests
Tested: uv run mypy src/mycli
Tested: uv run pytest -q
Tested: Real API background Task smoke
```

---

## Self-Review Checklist

- Spec coverage:
  - Task 1 covers mode/run state contracts.
  - Task 2 covers sidechain persistence.
  - Task 3 covers child loop event recording.
  - Task 4 covers `/subagents <child_session_id>` inspection.
- Task 5 covers model request serialization.
- Task 6 covers explicit background `Task`, concurrency cap, and exception handling.
- Task 7 covers shutdown cleanup.
- Task 8 covers docs and verification.
- Deferred intentionally:
  - fork cache sharing.
  - async mailbox and SendMessage.
  - automatic 2-minute backgrounding.
  - cross-process recovery.
  - coordinator/team/worktree/remote agents.
- Placeholder scan:
  - The plan avoids placeholder tokens in committed docs; Task 8 requires recording real command outputs in the smoke report.
- Type consistency:
  - `mode` is a string literal contract accepted by `SubAgentInvocation`, `TaskTool`, and `SubAgentService.run_task()`.
  - Sidechain recorder writes `HistoryItem` objects to existing `SessionService.append_history_items()`.
  - Background execution uses `max_concurrent_background_tasks`, `model_request_lock`, and `transcript_write_lock` consistently across runtime and service wiring.
