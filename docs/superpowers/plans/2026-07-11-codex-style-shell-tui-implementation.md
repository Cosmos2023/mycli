# Codex-Style Shell TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mycli render foreground and background shell processes with Codex-style `Running`/`Ran` transcript cells, owner-scoped `/ps` and `/stop`, and a live background-terminal footer without changing the model-visible shell tool schemas.

**Architecture:** Add typed shell lifecycle events at the domain boundary and emit them from `ShellSessionManager` through an owner-scoped `AgentRuntime` listener registry. `NodeTuiGateway` serializes asynchronous JSON-RPC notifications into the TypeScript runtime reducer, which owns monotonic shell state, Codex-style command cells, the footer count, and `/ps` history blocks. Main-agent task notifications remain independent and continue to enter the steering queue exactly once.

**Tech Stack:** Python 3.13, dataclasses, threading, JSON-RPC, pytest, uv, ruff, mypy, TypeScript 5.9, Node test runner, custom mycli TUI components.

---

## File Map

- Create `src/mycli/domain/runtime/shell_lifecycle.py`: immutable lifecycle event type, event kinds, and safe TUI payload projection.
- Modify `src/mycli/domain/runtime/__init__.py`: export shell lifecycle types.
- Modify `src/mycli/application/runtime/tools/tool_execution_service.py`: attach the normalized tool call ID as an internal runtime-only shell argument.
- Modify `src/mycli/tools/shell_backend.py`: carry call ID and lifecycle sink through the backend request.
- Modify `src/mycli/tools/bash.py`: configure the lifecycle sink and pass internal call correlation to the backend.
- Modify `src/mycli/tools/shell_session_manager.py`: emit started/output/completed events, coalesce output, and preserve terminal ordering.
- Modify `src/mycli/tools/shell_registry.py`: expose owner-scoped active snapshots and stop-all compatibility methods.
- Modify `src/mycli/application/runtime/agent_runtime.py`: register/unregister listeners and publish lifecycle events independently of task notifications.
- Modify `src/mycli/application/turn_service.py`: expose owner-scoped shell snapshots, stop-all behavior, and listener registration to the gateway.
- Modify `src/mycli/cli/repl.py`: add `/ps` and `/stop` aliases while preserving existing `/tasks bashes` behavior.
- Modify `src/mycli/cli/node_tui/gateway.py`: serialize concurrent writes, subscribe to shell events, emit shell notifications, and include bootstrap snapshots.
- Modify `tui/mycli-shell/src/model.ts`: extend Bash state and add background-terminal history/state types.
- Modify `tui/mycli-shell/src/adapters/runtime-state.ts`: reduce shell events monotonically and project bootstrap snapshots.
- Modify `tui/mycli-shell/src/components/bash-execution.ts`: render Codex-style `Running` and `Ran` cells.
- Create `tui/mycli-shell/src/components/background-terminals.ts`: render `/ps` transcript blocks.
- Modify `tui/mycli-shell/src/components/footer.ts`: render the active background-terminal count and slash-command hints.
- Modify `tui/mycli-shell/src/shell-runtime.ts`: register slash commands, render the new transcript block, and keep live components synchronized.
- Modify Python and TypeScript tests listed in each task.

### Task 0: Verify The Shell Runtime And TUI Baseline

**Files:**
- Verify only; no source changes.

- [ ] **Step 1: Run the focused Python baseline**

```bash
uv run pytest tests/unit/tools/test_shell_session_manager.py \
  tests/unit/tools/test_bash_output.py tests/unit/application/test_agent_runtime.py \
  tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py -q
```

Expected: PASS.

- [ ] **Step 2: Run the TypeScript baseline**

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern='bash|runtime adapter|footer|gateway'
npm --prefix tui/mycli-shell run typecheck
```

Expected: PASS.

- [ ] **Step 3: Confirm the worktree contains no uncommitted source changes**

```bash
git status --short
```

Expected: empty output. If only ignored `.superpowers/` files exist, continue; otherwise inspect and preserve user changes before editing.

### Task 1: Define Shell Lifecycle Events And Tool Call Correlation

**Files:**
- Create: `src/mycli/domain/runtime/shell_lifecycle.py`
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py:852-874`
- Modify: `src/mycli/tools/shell_backend.py:12-52`
- Modify: `src/mycli/tools/bash.py:153-290`
- Test: `tests/unit/application/test_tool_execution_service.py`
- Test: `tests/unit/tools/test_shell_session_manager.py`

- [ ] **Step 1: Write failing event serialization tests**

Add to `tests/unit/tools/test_shell_session_manager.py`:

```python
from mycli.domain.runtime import ShellLifecycleEvent


def test_shell_lifecycle_event_projects_safe_tui_payload() -> None:
    event = ShellLifecycleEvent(
        kind="shell.started",
        shell_id="shell-1",
        owner_session_id="session-a",
        call_id="call-1",
        sequence=1,
        command_preview="python3 -m http.server",
        background=True,
        process_state="running_background",
        output_delta="",
        next_cursor=0,
        output_chars=0,
        omitted_output_chars=0,
    )

    payload = event.to_tui_payload()

    assert payload["shell_id"] == "shell-1"
    assert payload["call_id"] == "call-1"
    assert payload["sequence"] == 1
    assert payload["command_preview"] == "python3 -m http.server"
    assert "owner_session_id" not in payload
```

- [ ] **Step 2: Write the failing internal call-ID propagation test**

Add this test-local tool next to `FakeTool` in `tests/unit/application/test_tool_execution_service.py`:

```python
class FakeBashTool:
    spec = ToolSpec(
        name="Bash",
        description="Capture Bash runtime arguments",
        parameters=(ToolParameter("command", "string"),),
    )

    def __init__(self) -> None:
        self.seen_arguments: list[dict[str, object]] = []

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        self.seen_arguments.append(dict(arguments))
        return ToolResult(success=True, summary="captured", raw_payload={"exit_code": 0})


def test_shell_call_receives_internal_runtime_call_id(tmp_path: Path) -> None:
    tool = FakeBashTool()
    service, _ = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([tool]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Bash"),
                source=ToolRouteSource.REGISTRY,
                spec=tool.spec,
            ),
        )
    )

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Bash",
            arguments={"command": "printf ok"},
            call_id="call-shell",
        ),
        tool_router=router,
        tool_exposure=exposure,
        plan_state=PlanState(),
        turn_id="turn-1",
        activity_events=[],
        turn_items=[],
    )

    assert tool.seen_arguments[0]["_runtime_tool_call_id"] == "call-shell"
```

- [ ] **Step 3: Run both tests to verify RED**

```bash
uv run pytest tests/unit/tools/test_shell_session_manager.py::test_shell_lifecycle_event_projects_safe_tui_payload \
  tests/unit/application/test_tool_execution_service.py::test_shell_call_receives_internal_runtime_call_id -q
```

Expected: FAIL because `ShellLifecycleEvent` and `_runtime_tool_call_id` do not exist.

- [ ] **Step 4: Implement the immutable event type**

Create `src/mycli/domain/runtime/shell_lifecycle.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


ShellLifecycleKind = Literal[
    "shell.started",
    "shell.output",
    "shell.completed",
    "shell.removed",
    "shell.list.updated",
]


@dataclass(frozen=True, slots=True)
class ShellLifecycleEvent:
    kind: ShellLifecycleKind
    shell_id: str
    owner_session_id: str
    call_id: str | None
    sequence: int
    command_preview: str
    background: bool
    process_state: str
    terminal_state: str | None = None
    exit_code: int | None = None
    output_delta: str = ""
    next_cursor: int = 0
    output_chars: int = 0
    omitted_output_chars: int = 0
    cleanup_result: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    active_background_count: int | None = None

    def to_tui_payload(self) -> dict[str, object]:
        return {
            "shell_id": self.shell_id,
            "call_id": self.call_id,
            "sequence": self.sequence,
            "command_preview": self.command_preview,
            "background": self.background,
            "process_state": self.process_state,
            "terminal_state": self.terminal_state,
            "exit_code": self.exit_code,
            "output_delta": self.output_delta,
            "next_cursor": self.next_cursor,
            "output_chars": self.output_chars,
            "omitted_output_chars": self.omitted_output_chars,
            "cleanup_result": self.cleanup_result,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "active_background_count": self.active_background_count,
        }


__all__ = ["ShellLifecycleEvent", "ShellLifecycleKind"]
```

Export both names from `src/mycli/domain/runtime/__init__.py`.

- [ ] **Step 5: Attach the internal call ID and thread both runtime-only values through every shell layer**

In `_with_runtime_execution_options()`:

```python
if call.call_id:
    arguments["_runtime_tool_call_id"] = call.call_id
```

Keep this inside the existing `if call.name not in SHELL_TOOL_NAMES: return call` guard so non-shell tools never receive the internal argument.

Add these fields:

```python
# ShellBackendRequest
call_id: str | None = None
lifecycle_sink: Callable[[ShellLifecycleEvent], None] | None = None

# ShellStartRequest
call_id: str | None = None
lifecycle_sink: Callable[[ShellLifecycleEvent], None] | None = None
```

Add `BashTool.configure_shell_lifecycle()` and pass only a string `_runtime_tool_call_id` to `ShellBackendRequest.call_id`. Do not add either internal field to `BashTool.spec`.

Thread `call_id` and `lifecycle_sink` without transformation through this complete path:

```text
BashTool.execute
  -> ShellBackendRequest
  -> LocalShellBackend.execute
  -> execute_bash
  -> ShellCommandRuntime.execute
  -> ShellProcessRegistry.execute
  -> ShellStartRequest
```

`BashTool.execute()` passes the lifecycle sink for foreground and background commands. It continues to pass `notification_sink` only for background commands, preserving the existing exactly-once task-notification behavior.

- [ ] **Step 6: Verify GREEN and static checks**

```bash
uv run pytest tests/unit/tools/test_shell_session_manager.py::test_shell_lifecycle_event_projects_safe_tui_payload \
  tests/unit/application/test_tool_execution_service.py::test_shell_call_receives_internal_runtime_call_id -q
uv run ruff check src/mycli/domain/runtime/shell_lifecycle.py src/mycli/domain/runtime/__init__.py \
  src/mycli/application/runtime/tools/tool_execution_service.py src/mycli/tools/shell_backend.py \
  src/mycli/tools/bash.py tests/unit/application/test_tool_execution_service.py \
  tests/unit/tools/test_shell_session_manager.py
uv run mypy src/mycli/domain/runtime/shell_lifecycle.py src/mycli/tools/shell_backend.py src/mycli/tools/bash.py
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mycli/domain/runtime/shell_lifecycle.py src/mycli/domain/runtime/__init__.py \
  src/mycli/application/runtime/tools/tool_execution_service.py src/mycli/tools/shell_backend.py \
  src/mycli/tools/bash.py tests/unit/application/test_tool_execution_service.py \
  tests/unit/tools/test_shell_session_manager.py
git commit -m "Define shell lifecycle events"
```

### Task 2: Emit Ordered And Coalesced Events From ShellSessionManager

**Files:**
- Modify: `src/mycli/tools/shell_session_manager.py`
- Modify: `src/mycli/tools/shell_registry.py`
- Test: `tests/unit/tools/test_shell_session_manager.py`

- [ ] **Step 1: Add failing lifecycle-order tests**

Add these lifecycle-order tests, reusing the existing `_wait_for_terminal()` helper:

```python
def test_manager_emits_started_output_and_completed_in_order(tmp_path: Path) -> None:
    events: list[ShellLifecycleEvent] = []
    manager = ShellSessionManager(
        max_sessions=8,
        output_max_chars=1024,
        output_event_interval_seconds=0.01,
        output_event_max_chars=4096,
    )
    started = manager.start(
        ShellStartRequest(
            owner_session_id="session-a",
            call_id="call-a",
            command="printf 'one\\ntwo\\n'",
            cwd=tmp_path,
            timeout_seconds=30,
            background=True,
            lifecycle_sink=events.append,
        )
    )

    snapshot = _wait_for_terminal(manager, "session-a", started.shell_id)
    deadline = time.monotonic() + 1
    while (not events or events[-1].kind != "shell.completed") and time.monotonic() < deadline:
        time.sleep(0.01)

    assert snapshot.terminal_state == "completed"
    assert events[0].kind == "shell.started"
    assert any(event.kind == "shell.output" and "one" in event.output_delta for event in events)
    assert events[-1].kind == "shell.completed"
    assert [event.sequence for event in events] == sorted(event.sequence for event in events)
    assert events[-1].call_id == "call-a"
```

```python
def test_manager_caps_output_event_delta_and_flushes_before_terminal(tmp_path: Path) -> None:
    events: list[ShellLifecycleEvent] = []
    manager = ShellSessionManager(
        max_sessions=8,
        output_max_chars=4096,
        output_event_interval_seconds=0.01,
        output_event_max_chars=32,
    )
    started = manager.start(
        ShellStartRequest(
            owner_session_id="session-a",
            command="python3 -c \"print('x' * 200)\"",
            cwd=tmp_path,
            timeout_seconds=30,
            background=True,
            lifecycle_sink=events.append,
        )
    )

    _wait_for_terminal(manager, "session-a", started.shell_id)
    deadline = time.monotonic() + 1
    while (not events or events[-1].kind != "shell.completed") and time.monotonic() < deadline:
        time.sleep(0.01)

    output_events = [event for event in events if event.kind == "shell.output"]
    assert output_events
    assert all(len(event.output_delta) <= 32 for event in output_events)
    assert events[-1].kind == "shell.completed"
    assert events[-1].output_chars >= 200
```

- [ ] **Step 2: Verify RED**

```bash
uv run pytest tests/unit/tools/test_shell_session_manager.py::test_manager_emits_started_output_and_completed_in_order \
  tests/unit/tools/test_shell_session_manager.py::test_manager_caps_output_event_delta_and_flushes_before_terminal -q
```

Expected: FAIL because the manager does not emit lifecycle events.

- [ ] **Step 3: Add session event state**

Extend `_ShellSession` with:

```python
lifecycle_sink: Callable[[ShellLifecycleEvent], None] | None
call_id: str | None
event_sequence: int = 0
lifecycle_cursor: int = 0
output_event_scheduled: bool = False
lifecycle_terminal_emitted: bool = False
```

Add constructor options with production defaults:

```python
def __init__(
    self,
    *,
    max_sessions: int = 64,
    output_max_chars: int = 1_048_576,
    output_event_interval_seconds: float = 0.05,
    output_event_max_chars: int = 4096,
) -> None:
```

Validate that the interval is non-negative and the event max is positive.

- [ ] **Step 4: Implement event construction and safe delivery**

Add private helpers:

```python
def _next_event_locked(
    self,
    session: _ShellSession,
    *,
    kind: ShellLifecycleKind,
    output_delta: str = "",
    next_cursor: int | None = None,
    additional_omitted_chars: int = 0,
) -> ShellLifecycleEvent:
    session.event_sequence += 1
    snapshot = session.output.snapshot()
    return ShellLifecycleEvent(
        kind=kind,
        shell_id=session.shell_id,
        owner_session_id=session.owner_session_id,
        call_id=session.call_id,
        sequence=session.event_sequence,
        command_preview=_command_preview(session.command),
        background=session.background,
        process_state=session.terminal_state or (
            "running_background" if session.background else "running_foreground"
        ),
        terminal_state=session.terminal_state,
        exit_code=session.process.poll(),
        output_delta=output_delta,
        next_cursor=snapshot.total_chars if next_cursor is None else next_cursor,
        output_chars=snapshot.total_chars,
        omitted_output_chars=snapshot.omitted_chars + additional_omitted_chars,
        cleanup_result=session.cleanup_result,
        started_at=session.started_at,
        completed_at=session.completed_at,
    )
```

`_deliver_lifecycle_event()` must invoke the sink outside the manager lock and suppress sink exceptions.

Use a bounded one-line `_command_preview()` with a 160-character maximum and no newlines.

Add `call_id: str | None` and `command_preview: str | None` to `ShellSessionSnapshot`, populate them from the session, and include both in `ShellProcessRegistry._snapshot_payload()`. Bootstrap recovery can then correlate a still-running process with an existing transcript tool call. Do not add raw `command` to snapshots or diagnostic projections.

- [ ] **Step 5: Implement output coalescing and terminal flush**

After either drain thread appends output, schedule one daemon flush thread if none is pending. The flush thread sleeps for the configured interval and calls `session.output.read_from(session.lifecycle_cursor)`. If the returned text exceeds `output_event_max_chars`, retain only the newest suffix that fits and pass the discarded delta length as `additional_omitted_chars`. Advance `lifecycle_cursor` directly to the chunk's absolute `next_cursor`; do not queue every skipped byte for later delivery.

Before delivering `shell.completed`, synchronously flush the latest pending chunk using the same bounded rule. Mark `lifecycle_terminal_emitted` under the lock so explicit termination and the process watcher cannot emit two terminal events.

Any delayed coalescing thread that wakes after `lifecycle_terminal_emitted` becomes true must clear `output_event_scheduled` and return without emitting. This prevents `shell.output` from appearing after `shell.completed`.

Emit `shell.started` immediately after session insertion. Emit the terminal event only after stdout/stderr drain threads have joined, including sessions whose terminal state was set by timeout, interruption, `/stop`, or `KillShell`.

After each background start and terminal transition, emit `shell.list.updated` with the owner-scoped active background count. When capacity pruning removes a completed session from manager retention, emit `shell.removed` for that shell after releasing the manager lock. Add tests asserting start produces count one, completion produces count zero, and pruning emits one removal event.

For explicit termination, timeout, and interruption, `_terminate()` may set terminal state and deliver the existing task notification immediately after process-group cleanup, but it must not deliver `shell.completed`. `_watch_process()` always joins both drain threads, performs the final bounded output flush, emits exactly one `shell.completed`, and then emits the zero-or-lower `shell.list.updated` count. This keeps lifecycle ordering correct without changing main-agent notification timing.

- [ ] **Step 6: Verify manager tests and existing lifecycle behavior**

```bash
uv run pytest tests/unit/tools/test_shell_session_manager.py -q
uv run ruff check src/mycli/tools/shell_session_manager.py src/mycli/tools/shell_registry.py \
  tests/unit/tools/test_shell_session_manager.py
uv run mypy src/mycli/tools/shell_session_manager.py src/mycli/tools/shell_registry.py
```

Expected: PASS, including existing notification idempotency and process-group cleanup tests.

- [ ] **Step 7: Commit**

```bash
git add src/mycli/tools/shell_session_manager.py src/mycli/tools/shell_registry.py \
  tests/unit/tools/test_shell_session_manager.py
git commit -m "Emit bounded shell lifecycle events"
```

### Task 3: Publish Owner-Scoped Shell Events From AgentRuntime

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/tools/bash.py`
- Test: `tests/unit/application/test_agent_runtime.py`
- Test: `tests/integration/test_turn_service.py`

- [ ] **Step 1: Write failing listener tests**

Add to `tests/unit/application/test_agent_runtime.py`:

```python
def test_agent_runtime_publishes_shell_lifecycle_events_to_registered_listener(
    tmp_path: Path,
) -> None:
    bash = BashTool(tmp_path)
    runtime = AgentRuntime(
        model_adapter=LegacySingleTurnCaptureAdapter(),
        tool_registry=ToolRegistry.from_tools([bash]),
        config=AgentConfig(workspace_root=tmp_path, session_id="session-shell-events"),
        home_dir=tmp_path / "home",
    )
    events: list[ShellLifecycleEvent] = []
    unsubscribe = runtime.register_shell_lifecycle_listener(events.append)

    result = bash.execute({"command": "printf ready", "run_in_background": True})
    shell_id = str(result.raw_payload["shell_id"])
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        snapshot = SHELL_REGISTRY.read(
            shell_id,
            owner_session_id="session-shell-events",
        )
        if snapshot.get("terminal_state") is not None:
            break
        time.sleep(0.01)
    unsubscribe()

    assert events[0].kind == "shell.started"
    assert events[-1].kind == "shell.completed"
    assert all(event.owner_session_id == "session-shell-events" for event in events)
```

Add the unsubscribe regression:

```python
def test_agent_runtime_stops_shell_events_after_listener_unsubscribe(tmp_path: Path) -> None:
    bash = BashTool(tmp_path)
    runtime = AgentRuntime(
        model_adapter=LegacySingleTurnCaptureAdapter(),
        tool_registry=ToolRegistry.from_tools([bash]),
        config=AgentConfig(workspace_root=tmp_path, session_id="session-unsubscribe"),
        home_dir=tmp_path / "home",
    )
    events: list[ShellLifecycleEvent] = []
    unsubscribe = runtime.register_shell_lifecycle_listener(events.append)
    unsubscribe()

    result = bash.execute({"command": "printf ready", "run_in_background": True})
    shell_id = str(result.raw_payload["shell_id"])
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        snapshot = SHELL_REGISTRY.read(
            shell_id,
            owner_session_id="session-unsubscribe",
        )
        if snapshot.get("terminal_state") is not None:
            break
        time.sleep(0.01)

    assert events == []
```

- [ ] **Step 2: Verify RED**

```bash
uv run pytest tests/unit/application/test_agent_runtime.py::test_agent_runtime_publishes_shell_lifecycle_events_to_registered_listener -q
```

Expected: FAIL because listener registration is missing.

- [ ] **Step 3: Implement the runtime listener registry**

Add:

```python
self._shell_lifecycle_lock = Lock()
self._shell_lifecycle_listeners: dict[int, Callable[[ShellLifecycleEvent], None]] = {}
self._next_shell_lifecycle_listener_id = 0
```

Implement:

```python
def register_shell_lifecycle_listener(
    self,
    listener: Callable[[ShellLifecycleEvent], None],
) -> Callable[[], None]:
    with self._shell_lifecycle_lock:
        listener_id = self._next_shell_lifecycle_listener_id
        self._next_shell_lifecycle_listener_id += 1
        self._shell_lifecycle_listeners[listener_id] = listener

    def unsubscribe() -> None:
        with self._shell_lifecycle_lock:
            self._shell_lifecycle_listeners.pop(listener_id, None)

    return unsubscribe

def _publish_shell_lifecycle_event(self, event: ShellLifecycleEvent) -> None:
    if event.owner_session_id != self._config.session_id:
        return
    with self._shell_lifecycle_lock:
        listeners = tuple(self._shell_lifecycle_listeners.values())
    for listener in listeners:
        with contextlib.suppress(Exception):
            listener(event)
```

Configure Bash tools with `_publish_shell_lifecycle_event` in `_configure_background_shell_tasks()` while preserving task notification configuration.

- [ ] **Step 4: Expose registration through TurnService**

Add typed proxy methods:

```python
def register_shell_lifecycle_listener(
    self,
    listener: Callable[[ShellLifecycleEvent], None],
) -> Callable[[], None]:
    runtime = self._runtime
    if runtime is None:
        return lambda: None
    return runtime.register_shell_lifecycle_listener(listener)

def active_background_shells(self) -> tuple[dict[str, object], ...]:
    from mycli.tools.shell_registry import SHELL_REGISTRY
    return tuple(
        row
        for row in SHELL_REGISTRY.list(owner_session_id=self._config.session_id)
        if row.get("background") is True and row.get("status") == "running"
    )
```

Add both methods to `NodeTuiServiceLike` in Task 4's gateway change. `register_shell_lifecycle_listener()` returns a no-op unsubscribe only when no runtime is bound; session resume creates/rebinds the runtime before the gateway registers its replacement listener.

- [ ] **Step 5: Verify listener and TurnService tests**

```bash
uv run pytest tests/unit/application/test_agent_runtime.py \
  tests/integration/test_turn_service.py -q
uv run ruff check src/mycli/application/runtime/agent_runtime.py \
  src/mycli/application/turn_service.py src/mycli/tools/bash.py \
  tests/unit/application/test_agent_runtime.py tests/integration/test_turn_service.py
uv run mypy src/mycli/application/runtime/agent_runtime.py src/mycli/application/turn_service.py
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/application/runtime/agent_runtime.py src/mycli/application/turn_service.py \
  src/mycli/tools/bash.py tests/unit/application/test_agent_runtime.py \
  tests/integration/test_turn_service.py
git commit -m "Publish owner-scoped shell lifecycle events"
```

### Task 4: Bridge Shell Events Through The Node TUI Gateway

**Files:**
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Test: `tests/unit/cli/node_tui/test_gateway.py`
- Test: `tests/integration/test_node_tui_gateway.py`

- [ ] **Step 1: Write failing gateway event tests**

Extend the existing `FakeService` in `tests/unit/cli/node_tui/test_gateway.py`:

At the end of the existing `FakeService.__init__`, add:

```python
self.shell_listener: Callable[[ShellLifecycleEvent], None] | None = None
self.shell_unsubscribe_count = 0
self.active_shell_rows: tuple[dict[str, object], ...] = ()
```

Add these methods to `FakeService`:

```python

def register_shell_lifecycle_listener(
    self,
    listener: Callable[[ShellLifecycleEvent], None],
) -> Callable[[], None]:
    self.shell_listener = listener

    def unsubscribe() -> None:
        self.shell_unsubscribe_count += 1
        self.shell_listener = None

    return unsubscribe

def active_background_shells(self) -> tuple[dict[str, object], ...]:
    return self.active_shell_rows

def emit_shell_event(self, event: ShellLifecycleEvent) -> None:
    assert self.shell_listener is not None
    self.shell_listener(event)
```

Merge the new assignments into the existing constructor rather than creating a second `__init__`. Then add:

```python
def test_gateway_emits_shell_lifecycle_notification(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    emitted: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(service=service, emit=lambda method, params: emitted.append((method, params)))

    service.emit_shell_event(
        ShellLifecycleEvent(
            kind="shell.started",
            shell_id="shell-1",
            owner_session_id=service._config.session_id,
            call_id="call-1",
            sequence=1,
            command_preview="uv run dev",
            background=True,
            process_state="running_background",
        )
    )

    method, payload = next(item for item in emitted if item[0] == "shell.started")
    assert method == "shell.started"
    assert payload["shell_id"] == "shell-1"
    assert payload["call_id"] == "call-1"
    assert payload["sequence"] == 1
```

Add a bootstrap test with `service.active_shell_rows` containing one running owner-scoped snapshot and assert both `gateway._handle_bootstrap({"protocol_version": PROTOCOL_VERSION})["background_shells"]` and `gateway._status_payload()["background_shells"]` equal that row.

Add a resume test that records the current listener, calls `_handle_session_resume({"session_id": "resumed"})`, and asserts `shell_unsubscribe_count == 1`, `service.shell_listener` is non-`None`, and it is not the previous listener. Update `FakeService.resume_session()` to change `self._config.session_id` so the test exercises owner rebinding rather than merely replacing the callback.

- [ ] **Step 2: Add a failing concurrent-writer test**

Add a small `_SerializedGatewayWriter` helper in `gateway.py`, then test it directly with:

```python
class ConcurrentWriteProcess:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.entered = 0
        self.max_entered = 0
        self.lock = Lock()

    def write_line(self, line: str) -> None:
        with self.lock:
            self.entered += 1
            self.max_entered = max(self.max_entered, self.entered)
        time.sleep(0.02)
        self.lines.append(line)
        with self.lock:
            self.entered -= 1


def test_serialized_gateway_writer_prevents_concurrent_process_writes() -> None:
    process = ConcurrentWriteProcess()
    writer = _SerializedGatewayWriter(process)
    threads = [
        Thread(
            target=writer.write,
            args=(notification("shell.output", {"sequence": index}),),
        )
        for index in range(2)
    ]

    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert process.max_entered == 1
    assert len(process.lines) == 2
    assert all(isinstance(decode_message(line), RpcNotification) for line in process.lines)
```

- [ ] **Step 3: Verify RED**

```bash
uv run pytest tests/unit/cli/node_tui/test_gateway.py -k 'shell_lifecycle or concurrent_writer or background_shells' -q
```

Expected: FAIL because the gateway does not subscribe or serialize writes.

- [ ] **Step 4: Serialize all process writes**

Implement:

```python
class _SerializedGatewayWriter:
    def __init__(self, process: NodeTuiProcessLike) -> None:
        self._process = process
        self._lock = Lock()
        self._pipe_closed = False

    def write(self, message: RpcMessage) -> bool:
        with self._lock:
            if self._pipe_closed:
                return False
            try:
                self._process.write_line(encode_message(message))
            except BrokenPipeError:
                self._pipe_closed = True
                return False
        return True
```

`run_node_tui_gateway()` creates one writer. `emit()` calls `writer.write(notification(method, params))`; normal request responses call `writer.write(response)` and follow the existing closed-pipe return behavior when it returns false.

- [ ] **Step 5: Subscribe, filter, and rebind gateway events**

Add `_shell_unsubscribe`, `_bind_shell_lifecycle_listener()`, and `close()` to `NodeTuiGateway`. The listener must compare `event.owner_session_id` with `service._config.session_id` before calling:

```python
self._emit_event(event.kind, event.to_tui_payload())
```

Call the bind method at initialization and after successful session resume. Call `gateway.close()` from `run_node_tui_gateway()`'s `finally` block before terminating the Node process.

Extend `NodeTuiServiceLike` with the exact methods used by the gateway:

```python
def register_shell_lifecycle_listener(
    self,
    listener: Callable[[ShellLifecycleEvent], None],
) -> Callable[[], None]: ...

def active_background_shells(self) -> tuple[dict[str, object], ...]: ...
```

`_bind_shell_lifecycle_listener()` must call and clear the previous unsubscribe before reading the new session ID and registering the replacement. `close()` is idempotent and clears the stored unsubscribe after invoking it.

- [ ] **Step 6: Add bootstrap snapshots**

Add:

```python
"background_shells": list(self.service.active_background_shells()),
```

to bootstrap and status payloads. Keep rows owner-scoped and do not include raw command text beyond the bounded `command_preview` field.

- [ ] **Step 7: Verify gateway tests and commit**

```bash
uv run pytest tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py -q
uv run ruff check src/mycli/cli/node_tui/gateway.py \
  tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py
uv run mypy src/mycli/cli/node_tui/gateway.py
git add src/mycli/cli/node_tui/gateway.py tests/unit/cli/node_tui/test_gateway.py \
  tests/integration/test_node_tui_gateway.py
git commit -m "Stream shell lifecycle events to the TUI"
```

### Task 5: Add Owner-Scoped `/ps` And `/stop`

**Files:**
- Modify: `src/mycli/tools/shell_registry.py`
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/cli/repl.py`
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Test: `tests/integration/test_cli_repl.py`
- Test: `tests/integration/test_turn_service.py`
- Test: `tests/unit/cli/node_tui/test_gateway.py`

- [ ] **Step 1: Write failing owner-scoped `/ps` and `/stop` tests**

Start shells for `session-a` and `session-b`, configure `TurnService` for `session-a`, and add:

```python
lines = service.inspect_bashes()
assert len(lines) == 1
assert session_a_shell_id in lines[0]
assert "state=running_background" in lines[0]
assert session_b_shell_id not in lines[0]
```

Assert the session B shell is absent. Add:

```python
lines = tuple(build_command_handler(service)("/stop"))
assert lines == ("[bash] Stopping all background terminals.",)
assert session_a_shell_id not in SHELL_REGISTRY.processes()
assert session_b_shell_id in SHELL_REGISTRY.processes()
```

Use `try/finally` to terminate the session B shell.

- [ ] **Step 2: Add failing structured `/ps` gateway test**

Call `command.run` with `/ps` and assert the response contains:

```python
assert result["command_kind"] == "background_shells"
assert result["processes"][0]["shell_id"] == shell_id
assert "command_preview" in result["processes"][0]
assert "output" in result["processes"][0]
```

- [ ] **Step 3: Verify RED**

```bash
uv run pytest tests/integration/test_cli_repl.py tests/integration/test_turn_service.py \
  tests/unit/cli/node_tui/test_gateway.py -k 'ps or stop or inspect_bashes' -q
```

Expected: FAIL because aliases, owner filtering, and structured results are missing.

- [ ] **Step 4: Implement owner-scoped service methods**

Make `inspect_bashes()` call `SHELL_REGISTRY.list(owner_session_id=self._config.session_id)`.

Add:

```python
def stop_background_shells(self) -> tuple[str, ...]:
    from mycli.tools.shell_registry import SHELL_REGISTRY
    SHELL_REGISTRY.terminate_owner(self._config.session_id)
    return ("Stopping all background terminals.",)
```

Keep `inspect_bashes()` owner-scoped for backward-compatible `/tasks bashes` diagnostics. Make `active_background_shells()` filter to rows where `background is True`, `status == "running"`, and `process_state == "running_background"`; `/ps`, bootstrap, status, and the footer use this active-only method.

- [ ] **Step 5: Add slash aliases and structured gateway results**

In `canonical_slash_command()` map `/ps` to `/tasks bashes`. In `build_command_handler()`, add `/stop` before the `/tasks` branch:

```python
if command == "/stop":
    return [f"[bash] {line}" for line in service.stop_background_shells()]
```

Keep the original input available in `_handle_command_run()` so `/ps` can return:

```python
{
    "command_kind": "background_shells",
    "processes": list(self.service.active_background_shells()),
    "lines": list(self._command_handler("/tasks bashes")),
}
```

Handle `/stop` directly through `service.stop_background_shells()` and return `command_kind="shell_stop"` with the confirmation lines.

The gateway `/stop` response uses unprefixed service lines so the transcript renders exactly `Stopping all background terminals.`; the plain REPL command handler retains its existing `[bash]` prefix convention.

- [ ] **Step 6: Verify Python command behavior and commit**

```bash
uv run pytest tests/integration/test_cli_repl.py tests/integration/test_turn_service.py \
  tests/unit/cli/node_tui/test_gateway.py -q
uv run ruff check src/mycli/tools/shell_registry.py src/mycli/application/turn_service.py \
  src/mycli/cli/repl.py src/mycli/cli/node_tui/gateway.py \
  tests/integration/test_cli_repl.py tests/integration/test_turn_service.py \
  tests/unit/cli/node_tui/test_gateway.py
uv run mypy src/mycli/tools/shell_registry.py src/mycli/application/turn_service.py \
  src/mycli/cli/repl.py src/mycli/cli/node_tui/gateway.py
git add src/mycli/tools/shell_registry.py src/mycli/application/turn_service.py \
  src/mycli/cli/repl.py src/mycli/cli/node_tui/gateway.py \
  tests/integration/test_cli_repl.py tests/integration/test_turn_service.py \
  tests/unit/cli/node_tui/test_gateway.py
git commit -m "Add Codex-style shell process commands"
```

### Task 6: Reduce Shell Events Into Monotonic TypeScript State

**Files:**
- Modify: `tui/mycli-shell/src/model.ts`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Test: `tui/mycli-shell/test/runtime-state.test.ts`
- Test: `tui/mycli-shell/test/gateway-events.test.ts`

- [ ] **Step 1: Write failing reducer tests**

Add tests that apply `shell.started`, `shell.output`, and `shell.completed`:

```typescript
test("shell lifecycle keeps background Bash running until terminal event", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "shell.started", {
		shell_id: "shell-1",
		call_id: "call-1",
		sequence: 1,
		command_preview: "uv run dev",
		background: true,
		process_state: "running_background",
		output_delta: "",
	});
	state = reduceRuntimeEvent(state, "shell.output", {
		shell_id: "shell-1",
		call_id: "call-1",
		sequence: 2,
		process_state: "running_background",
		output_delta: "ready\n",
		next_cursor: 6,
		output_chars: 6,
	});

	let shell = projectRuntimeState(state);
	assert.equal(shell.bash[0]?.status, "running");
	assert.equal(shell.bash[0]?.outputPreview, "ready\n");
	assert.equal(shell.footer.backgroundShellCount, 1);

	state = reduceRuntimeEvent(state, "shell.completed", {
		shell_id: "shell-1",
		call_id: "call-1",
		sequence: 3,
		process_state: "completed",
		terminal_state: "completed",
		exit_code: 0,
	});
	shell = projectRuntimeState(state);
	assert.equal(shell.bash[0]?.status, "success");
	assert.equal(shell.footer.backgroundShellCount, 0);
});
```

Add the stale and list-event regressions:

```typescript
test("stale shell events cannot revive a terminal command", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "shell.completed", {
		shell_id: "shell-1",
		call_id: "call-1",
		sequence: 5,
		background: true,
		process_state: "failed",
		terminal_state: "failed",
		exit_code: 2,
	});
	state = reduceRuntimeEvent(state, "shell.output", {
		shell_id: "shell-1",
		call_id: "call-1",
		sequence: 4,
		background: true,
		process_state: "running_background",
		output_delta: "late output",
	});

	const bash = projectRuntimeState(state).bash[0];
	assert.equal(bash?.status, "error");
	assert.equal(bash?.terminalState, "failed");
});

test("shell list and removal events update count without deleting transcript history", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "shell.started", {
		shell_id: "shell-1",
		call_id: "call-1",
		sequence: 1,
		command_preview: "uv run dev",
		background: true,
		process_state: "running_background",
	});
	state = reduceRuntimeEvent(state, "shell.completed", {
		shell_id: "shell-1",
		call_id: "call-1",
		sequence: 2,
		background: true,
		process_state: "completed",
		terminal_state: "completed",
		exit_code: 0,
	});
	state = reduceRuntimeEvent(state, "shell.list.updated", {
		shell_id: "shell-1",
		sequence: 3,
		active_background_count: 3,
	});
	assert.equal(projectRuntimeState(state).footer.backgroundShellCount, 3);

	state = reduceRuntimeEvent(state, "shell.removed", {
		shell_id: "shell-1",
		sequence: 4,
	});
	assert.equal(state.backgroundShells["shell-1"], undefined);
	assert.equal(projectRuntimeState(state).bash[0]?.status, "success");
});
```

Add a bootstrap test passing one `background_shells` row with `command_preview`, `output`, and `shell_id`; assert it creates a running Bash cell, one `backgroundShells` entry, and footer count one.

- [ ] **Step 2: Verify RED**

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern='shell lifecycle|stale shell|background shell bootstrap'
```

Expected: FAIL because shell events and fields are unknown.

- [ ] **Step 3: Extend TypeScript models**

Add to `MycliShellBash`:

```typescript
shellId?: string;
callId?: string;
background?: boolean;
processState?: string;
terminalState?: string;
sequence?: number;
startedAt?: string;
completedAt?: string;
outputChars?: number;
omittedOutputChars?: number;
cleanupResult?: string;
```

Add `backgroundShellCount?: number` to `MycliShellFooterData`. Add an internal `RuntimeShellProcess` type containing the lifecycle payload fields needed by projection (`shellId`, `callId`, `commandPreview`, `background`, `processState`, `terminalState`, `exitCode`, `sequence`, timestamps, output preview/cursors/counts, and cleanup result). Add both `backgroundShells: Record<string, RuntimeShellProcess>` and `backgroundShellCount: number` to `RuntimeShellState`, initialized to `{}` and `0`.

- [ ] **Step 4: Implement monotonic reducers**

Add an `applyShellLifecycle()` helper that:

- requires a nonempty `shell_id` and integer `sequence`;
- ignores events whose sequence is not greater than the stored sequence;
- appends bounded output deltas;
- creates missing state from output or terminal events;
- removes terminal background shells from `backgroundShells`;
- applies `shell.list.updated` counts without recreating missing command cells;
- removes retained process state on `shell.removed` while preserving persisted transcript cells;
- never changes a terminal shell back to running;
- upserts transcript metadata by `call_id`, then `shell_id`.

Use a fixed TUI preview budget of 10,000 characters with head/tail omission text. Populate bootstrap state from `background_shells` using sequence zero. Bootstrap merging must not overwrite a process already observed at sequence greater than zero and must never replace a terminal transcript cell with a running snapshot; this covers lifecycle notifications that arrive between gateway listener binding and the bootstrap response.

For `shell.started` and terminal events, recompute `backgroundShellCount` from the active collection. For `shell.list.updated`, set it from nonnegative integer `active_background_count`; this repairs the footer if a start or terminal notification was missed. `shell.removed` deletes only the retained process/snapshot entry and never deletes an existing transcript item.

- [ ] **Step 5: Verify reducer tests and typecheck**

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern='shell lifecycle|stale shell|background shell bootstrap|gateway event'
npm --prefix tui/mycli-shell run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tui/mycli-shell/src/model.ts tui/mycli-shell/src/adapters/runtime-state.ts \
  tui/mycli-shell/test/runtime-state.test.ts tui/mycli-shell/test/gateway-events.test.ts
git commit -m "Project shell lifecycle into TUI state"
```

### Task 7: Render Codex-Style Running And Ran Command Cells

**Files:**
- Modify: `tui/mycli-shell/src/components/bash-execution.ts`
- Modify: `tui/mycli-shell/src/shell-runtime.ts`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Write failing command-cell snapshots**

Add tests for these visible strings using direct component rendering:

```typescript
const now = Date.parse("2026-07-11T12:00:08Z");
const foreground = new BashExecutionComponent({
	id: "bash-1",
	command: "uv run pytest -q",
	status: "running",
	background: false,
	startedAt: "2026-07-11T12:00:00Z",
}, () => now);
const foregroundOutput = stripAnsi(foreground.render(100).join("\n"));
assert.match(foregroundOutput, /• Running uv run pytest -q \(8s · esc to interrupt\)/);
```

```typescript
const background = new BashExecutionComponent({
	id: "bash-2",
	command: "uv run dev",
	status: "running",
	background: true,
}, () => now);
const backgroundOutput = stripAnsi(background.render(100).join("\n"));
assert.match(backgroundOutput, /• Running uv run dev/);
assert.doesNotMatch(backgroundOutput, /esc to interrupt/);
```

```typescript
const failed = new BashExecutionComponent({
	id: "bash-3",
	command: "uv run pytest -q",
	status: "error",
	exitCode: 2,
	terminalState: "failed",
}, () => now);
const failedOutput = stripAnsi(failed.render(100).join("\n"));
assert.match(failedOutput, /• Ran uv run pytest -q/);
assert.match(failedOutput, /exit 2/);
```

- [ ] **Step 2: Verify RED**

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern='Codex-style Bash|background Bash interrupt hint|failed Bash exit'
```

Expected: FAIL because the existing component renders `⏺ Bash` and generic status text.

- [ ] **Step 3: Replace the Bash heading with a command cell**

Render one status line with:

- animated/activity bullet while running;
- green bullet for exit zero;
- red bullet for nonzero exit, timeout, interruption, or kill;
- `Running` while process state is nonterminal;
- `Ran` for every terminal process;
- elapsed seconds from `startedAt` while running;
- the interrupt hint only for nonbackground running commands.

Keep existing bounded output preview, expansion behavior, visual-width truncation, and hidden-line hint.

- [ ] **Step 4: Make elapsed text render-time dynamic**

Store `now: () => number` on `BashExecutionComponent`, defaulting to `Date.now`. Build the status line as a lightweight child component whose `render()` computes elapsed time from `startedAt`, rather than freezing the value in `rebuild()`.

Pass the shell runtime's existing clock into newly created Bash components so existing event-driven/tick redraws update elapsed time without a new timer per command.

- [ ] **Step 5: Verify component tests and commit**

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern='Bash|command cell|interrupt hint|exit'
npm --prefix tui/mycli-shell run typecheck
git add tui/mycli-shell/src/components/bash-execution.ts \
  tui/mycli-shell/src/shell-runtime.ts tui/mycli-shell/test/shell-app.test.ts
git commit -m "Render Codex-style shell command cells"
```

### Task 8: Add The Background-Terminal Footer And `/ps` History Block

**Files:**
- Create: `tui/mycli-shell/src/components/background-terminals.ts`
- Modify: `tui/mycli-shell/src/model.ts`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Modify: `tui/mycli-shell/src/components/footer.ts`
- Modify: `tui/mycli-shell/src/shell-runtime.ts`
- Test: `tui/mycli-shell/test/runtime-state.test.ts`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Write failing footer tests**

Add these direct component assertions to `tui/mycli-shell/test/shell-app.test.ts`:

```typescript
const one = stripAnsi(new FooterComponent({ cwd: "/repo", backgroundShellCount: 1 }).render(120).join("\n"));
const two = stripAnsi(new FooterComponent({ cwd: "/repo", backgroundShellCount: 2 }).render(120).join("\n"));
const zero = stripAnsi(new FooterComponent({ cwd: "/repo", backgroundShellCount: 0 }).render(120).join("\n"));

assert.match(one, /1 background terminal running · \/ps to view · \/stop to close/);
assert.match(two, /2 background terminals running · \/ps to view · \/stop to close/);
assert.doesNotMatch(zero, /background terminal/);
```

- [ ] **Step 2: Write failing `/ps` projection and rendering tests**

Feed `runtimeStateWithCommandResult()`:

```typescript
{
	command_kind: "background_shells",
	processes: [
		{ shell_id: "shell-1", command_preview: "uv run dev", output: "ready\n" },
	],
	lines: [],
}
```

Assert the transcript contains a `background_terminals` block and renders:

```text
/ps

Background terminals

  • uv run dev
    ↳ ready
```

Add empty, multiline-output, long-command, and 20-process tests; the final case must show 16 rows and `... and 4 more running`.

- [ ] **Step 3: Verify RED**

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern='background terminal footer|ps history|Background terminals'
```

Expected: FAIL because neither footer data nor the transcript block exists.

- [ ] **Step 4: Implement the history block model and component**

Add:

```typescript
export type MycliShellBackgroundProcess = {
	shellId: string;
	commandPreview: string;
	recentOutput: string[];
};

export type MycliShellBackgroundTerminals = {
	id: string;
	processes: MycliShellBackgroundProcess[];
};
```

Add `background_terminals` to `MycliShellTranscriptBlock`. Implement `BackgroundTerminalsComponent` with a 16-process cap, one bounded command line, bounded recent output lines, and the exact empty-state text `No background terminals running.`.

- [ ] **Step 5: Project structured `/ps` results and render the footer**

Teach `runtimeStateWithCommandResult()` to create the typed block when `command_kind === "background_shells"`. Register the component in `shell-runtime.ts` caching and rendering.

In `FooterComponent`, append the singular/plural background summary before `liveState`. Use `truncateToWidth()` so narrow terminals preserve a valid one-line footer.

Register `/ps` and `/stop` in `BACKEND_COMMANDS`; keep `/tasks bashes` for backward compatibility.

- [ ] **Step 6: Verify TypeScript suite and commit**

```bash
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
git add tui/mycli-shell/src/components/background-terminals.ts \
  tui/mycli-shell/src/model.ts tui/mycli-shell/src/adapters/runtime-state.ts \
  tui/mycli-shell/src/components/footer.ts tui/mycli-shell/src/shell-runtime.ts \
  tui/mycli-shell/test/runtime-state.test.ts tui/mycli-shell/test/shell-app.test.ts
git commit -m "Add Codex-style background terminal surfaces"
```

### Task 9: Verify Stop-All, Recovery, Notifications, And Full Quality Gates

**Files:**
- Modify: `tests/integration/test_node_tui_gateway.py`
- Modify: `tests/unit/application/test_agent_runtime.py`
- Modify: `tui/mycli-shell/test/gateway-replay.test.ts`
- Modify: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Add the end-to-end real-process regression**

Start two background commands owned by the active session and one owned by another session. Capture gateway events, run `/ps`, then `/stop`. Assert:

```python
active_rows = gateway._status_payload()["background_shells"]
assert isinstance(active_rows, list)
assert len(active_rows) == 2
assert ps_result["command_kind"] == "background_shells"
assert {row["shell_id"] for row in ps_result["processes"]} == {first_id, second_id}
assert first_id not in SHELL_REGISTRY.processes()
assert second_id not in SHELL_REGISTRY.processes()
assert foreign_id in SHELL_REGISTRY.processes()
terminal_ids = [
    payload["shell_id"]
    for method, payload in events
    if method == "shell.completed"
]
assert terminal_ids.count(first_id) == 1
assert terminal_ids.count(second_id) == 1
```

Also assert the runtime steering queue contains one task notification per stopped shell and no model adapter call count changes solely because lifecycle events were emitted.

- [ ] **Step 2: Add replay recovery coverage**

Create a gateway replay containing bootstrap `background_shells`, a later `shell.output`, and `shell.completed`. Assert the TUI starts with one running footer item, appends output, changes the cell to `Ran`, and removes the footer summary.

- [ ] **Step 3: Run focused Python and TypeScript regressions**

```bash
uv run pytest tests/unit/tools/test_shell_session_manager.py \
  tests/unit/tools/test_bash_output.py tests/unit/application/test_tool_execution_service.py \
  tests/unit/application/test_agent_runtime.py tests/integration/test_turn_service.py \
  tests/integration/test_cli_repl.py tests/unit/cli/node_tui/test_gateway.py \
  tests/integration/test_node_tui_gateway.py -q
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run repository quality gates**

```bash
uv run ruff check .
uv run mypy src
uv run pytest -q
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
```

Expected: no lint or type errors; all Python and TypeScript tests pass.

- [ ] **Step 5: Inspect the final diff for protocol and privacy regressions**

```bash
git diff --check
git diff --stat 3a60ff5..HEAD
rg -n 'exec_command|write_stdin' src/mycli/tools tui/mycli-shell/src
```

Expected: no whitespace errors; existing tool names remain; no model-visible schema rename is introduced. Review shell lifecycle payloads to confirm `owner_session_id` and unbounded raw command text are not sent to the TUI or diagnostics.

- [ ] **Step 6: Commit any final integration-only changes**

```bash
git add tests/integration/test_node_tui_gateway.py \
  tests/unit/application/test_agent_runtime.py \
  tui/mycli-shell/test/gateway-replay.test.ts \
  tui/mycli-shell/test/shell-app.test.ts
git commit -m "Verify Codex-style shell TUI lifecycle"
```

## Completion Criteria

- Shell tool schemas remain `Bash`, `BashOutput`, and `KillShell` with unchanged model-visible arguments.
- Foreground and background processes render as Codex-style `Running` cells and settle to `Ran` only on process terminal state.
- Background command cells remain running across model turns after the initial Bash tool result returns.
- Main-agent task notifications remain exactly-once and independent of TUI lifecycle events.
- TUI lifecycle events never cause a model request.
- Output events are bounded to 4,096 characters and coalesced to at most one event per 50 milliseconds per shell.
- Event sequence and terminal monotonicity reject duplicate and stale state.
- The footer shows owner-scoped active background terminal count with `/ps` and `/stop` hints.
- `/ps` produces a read-only transcript block capped at 16 processes.
- `/stop` terminates every active-session background shell and no foreign-session shell.
- Bootstrap/session resume restores active background shell state and listener ownership correctly.
- Python ruff, mypy, full pytest, TypeScript tests, and TypeScript typecheck pass.
