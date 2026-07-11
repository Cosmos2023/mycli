# Shell Session Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mycli's split and unbounded background-shell implementation with a bounded, session-aware local process manager while preserving the existing `Bash`, `BashOutput`, and `KillShell` schemas.

**Architecture:** Add a focused output buffer and a `ShellSessionManager` that owns subprocess creation, output draining, timeout enforcement, process-group termination, ownership, and retention. Keep `shell_registry.py` as the compatibility projection used by CLI and doctor, and configure all three shell tools with the active mycli session ID from `AgentRuntime`.

**Tech Stack:** Python 3.13, standard-library `subprocess`, `threading`, `signal`, dataclasses, pytest, uv, ruff, mypy.

---

## File Map

- Create `src/mycli/tools/shell_output_buffer.py`: bounded head-tail storage with absolute output cursors.
- Create `src/mycli/tools/shell_session_manager.py`: typed shell sessions and all process lifecycle operations.
- Modify `src/mycli/tools/shell_registry.py`: compatibility facade and background-job projections backed by the manager.
- Modify `src/mycli/tools/bash.py`: delegate foreground and background execution to the manager and carry owner session ID.
- Modify `src/mycli/tools/shell_backend.py`: add owner session ID to backend requests.
- Modify `src/mycli/tools/bash_output.py`: owner-aware polling and actual model-visible output.
- Modify `src/mycli/tools/kill_shell.py`: owner-aware process-group termination.
- Modify `src/mycli/application/runtime/agent_runtime.py`: configure shell tools and terminate owned sessions on close.
- Modify `src/mycli/services/context/tool_result_formatter.py`: render `BashOutput` as shell output with a hard budget.
- Add focused tests under `tests/unit/tools/`, `tests/unit/services/context/`, and `tests/unit/application/`.

### Task 0: Land Existing DeepSeek Parallel-Tool Change Separately

**Files:**
- Existing modifications: `src/mycli/application/runtime/agent_runtime.py`
- Existing modifications: `src/mycli/application/runtime/tools/tool_execution_service.py`
- Existing tests: `tests/unit/application/test_agent_runtime.py`
- Existing tests: `tests/unit/application/test_parallel_tool_execution.py`

- [ ] **Step 1: Verify focused behavior**

```bash
uv run pytest tests/unit/application/test_parallel_tool_execution.py \
  tests/unit/application/test_agent_runtime.py::test_agent_runtime_runs_deepseek_multi_tool_batch_in_parallel -q
```

Expected: PASS with overlapping DeepSeek read calls and ordered result replay.

- [ ] **Step 2: Run static checks**

```bash
uv run ruff check src/mycli/application/runtime/agent_runtime.py \
  src/mycli/application/runtime/tools/tool_execution_service.py \
  tests/unit/application/test_agent_runtime.py \
  tests/unit/application/test_parallel_tool_execution.py
```

Expected: no lint errors.

- [ ] **Step 3: Commit only these four files**

```bash
git add src/mycli/application/runtime/agent_runtime.py \
  src/mycli/application/runtime/tools/tool_execution_service.py \
  tests/unit/application/test_agent_runtime.py \
  tests/unit/application/test_parallel_tool_execution.py
git commit -m "Enable tool metadata concurrency for DeepSeek"
```

### Task 1: Render BashOutput Content Into The Model Transcript

**Files:**
- Modify: `src/mycli/services/context/tool_result_formatter.py:9-43,118-155,397-447`
- Test: `tests/unit/services/context/test_tool_result_formatter.py`

- [ ] **Step 1: Write the failing formatter test**

```python
def test_bash_output_renders_incremental_output_and_status() -> None:
    formatter = ToolResultFormatter(run_shell_max_chars=1200)
    result = ToolResult(
        success=True,
        summary="Read shell shell_123 output",
        raw_payload={
            "shell_id": "shell_123",
            "status": "running",
            "process_state": "running_background",
            "output": "ready\nprogress 50%\n",
            "new_output_chars": 19,
        },
    )

    output = formatter.format("BashOutput", result)

    assert "Shell ID: shell_123" in output
    assert "Status: running" in output
    assert "ready" in output
    assert "progress 50%" in output
```

- [ ] **Step 2: Verify RED**

```bash
uv run pytest tests/unit/services/context/test_tool_result_formatter.py::test_bash_output_renders_incremental_output_and_status -q
```

Expected: FAIL because the formatter currently returns only the summary.

- [ ] **Step 3: Implement minimal formatter support**

Define `SHELL_RESULT_TOOLS = frozenset({"run_shell", "Bash", "BashOutput"})`. Use it in `_limit_for()`, failure rendering, and `_render_from_payload()`. Extend `_render_shell_metadata()` with stable `Shell ID`, `Status`, and `Process state` fields while preserving existing Bash metadata.

- [ ] **Step 4: Verify GREEN and commit**

```bash
uv run pytest tests/unit/services/context/test_tool_result_formatter.py -q
git add src/mycli/services/context/tool_result_formatter.py tests/unit/services/context/test_tool_result_formatter.py
git commit -m "Render background shell output for the model"
```

### Task 2: Add A Bounded Cursor-Aware Output Buffer

**Files:**
- Create: `src/mycli/tools/shell_output_buffer.py`
- Test: `tests/unit/tools/test_shell_output_buffer.py`

- [ ] **Step 1: Write failing buffer tests**

```python
from mycli.tools.shell_output_buffer import ShellOutputBuffer


def test_shell_output_buffer_retains_head_and_tail_with_hard_limit() -> None:
    buffer = ShellOutputBuffer(max_chars=10)
    buffer.append("abcdefgh")
    buffer.append("ijklmnop")

    snapshot = buffer.snapshot()

    assert snapshot.retained_chars <= 10
    assert snapshot.total_chars == 16
    assert snapshot.omitted_chars == 6
    assert snapshot.text.startswith("abcde")
    assert snapshot.text.endswith("lmnop")


def test_shell_output_buffer_reports_cursor_eviction() -> None:
    buffer = ShellOutputBuffer(max_chars=8)
    buffer.append("abcdefgh")
    cursor = buffer.end_cursor
    buffer.append("ijklmnop")

    chunk = buffer.read_from(cursor - 6)

    assert chunk.cursor_was_evicted is True
    assert chunk.omitted_before_chunk > 0
    assert chunk.next_cursor == buffer.end_cursor
```

- [ ] **Step 2: Verify RED**

```bash
uv run pytest tests/unit/tools/test_shell_output_buffer.py -q
```

Expected: import failure because `ShellOutputBuffer` does not exist.

- [ ] **Step 3: Implement typed snapshots and buffer**

```python
@dataclass(frozen=True, slots=True)
class ShellOutputSnapshot:
    text: str
    total_chars: int
    retained_chars: int
    omitted_chars: int


@dataclass(frozen=True, slots=True)
class ShellOutputChunk:
    text: str
    next_cursor: int
    cursor_was_evicted: bool
    omitted_before_chunk: int
```

`append()` fills a fixed head budget and keeps the newest suffix. `read_from()` accepts an absolute cursor and reports when requested output was evicted.

- [ ] **Step 4: Verify GREEN and commit**

```bash
uv run pytest tests/unit/tools/test_shell_output_buffer.py -q
git add src/mycli/tools/shell_output_buffer.py tests/unit/tools/test_shell_output_buffer.py
git commit -m "Add bounded shell output buffer"
```

### Task 3: Introduce ShellSessionManager Lifecycle Semantics

**Files:**
- Create: `src/mycli/tools/shell_session_manager.py`
- Test: `tests/unit/tools/test_shell_session_manager.py`

- [ ] **Step 1: Write failing real-process tests**

```python
def test_background_timeout_completes_without_polling(tmp_path: Path) -> None:
    manager = ShellSessionManager(max_sessions=8, output_max_chars=1024)
    started = manager.start(
        ShellStartRequest(
            owner_session_id="session-a",
            command="python3 -c 'import time; time.sleep(30)'",
            cwd=tmp_path,
            timeout_seconds=0,
            background=True,
        )
    )

    snapshot = wait_for_terminal(manager, "session-a", started.shell_id)

    assert snapshot.terminal_state == "timed_out"
    assert snapshot.process_state == "timed_out"


def test_manager_rejects_cross_session_poll(tmp_path: Path) -> None:
    manager = ShellSessionManager(max_sessions=8, output_max_chars=1024)
    started = manager.start(background_sleep_request(tmp_path, owner="session-a"))
    try:
        result = manager.poll("session-b", started.shell_id)
        assert result.error_kind == "shell_session_forbidden"
    finally:
        manager.terminate("session-a", started.shell_id)
```

Add a POSIX-only test that starts a descendant process, terminates the shell session, and verifies the descendant is no longer alive. Add a capacity test proving completed sessions are pruned before running sessions.

- [ ] **Step 2: Verify RED**

```bash
uv run pytest tests/unit/tools/test_shell_session_manager.py -q
```

Expected: import failure because the manager does not exist.

- [ ] **Step 3: Implement requests and snapshots**

```python
@dataclass(frozen=True, slots=True)
class ShellStartRequest:
    owner_session_id: str
    command: str
    cwd: Path
    timeout_seconds: int
    background: bool
    env: dict[str, str] | None = None
    command_pattern: str | None = None
    output_file: Path | None = None
    notification_sink: Callable[[TaskNotification], None] | None = None
    interrupt_token: RuntimeInterruptToken | None = None


@dataclass(frozen=True, slots=True)
class ShellSessionSnapshot:
    shell_id: str
    owner_session_id: str
    status: str
    process_state: str
    terminal_state: str | None
    exit_code: int | None
    output: str
    next_cursor: int
    output_chars: int
    omitted_output_chars: int
    cursor_was_evicted: bool
    cleanup_result: str | None
    error_kind: str | None = None
```

Use `start_new_session=True` on POSIX. One drain thread owns stream capture; one timeout watcher enforces the deadline. Route completion, timeout, interruption, and explicit kill through an idempotent finalizer that emits at most one notification.

- [ ] **Step 4: Implement termination and retention**

Terminate the POSIX process group with SIGTERM, wait up to two seconds, then SIGKILL. Before insertion, prune the least-recently-observed completed session. If all slots are running, return `shell_capacity_exceeded`.

- [ ] **Step 5: Verify GREEN and commit**

```bash
uv run pytest tests/unit/tools/test_shell_session_manager.py -q
git add src/mycli/tools/shell_session_manager.py tests/unit/tools/test_shell_session_manager.py
git commit -m "Add session-aware shell process manager"
```

### Task 4: Migrate Existing Shell Tools Through The Manager

**Files:**
- Modify: `src/mycli/tools/shell_registry.py`
- Modify: `src/mycli/tools/bash.py`
- Modify: `src/mycli/tools/shell_backend.py`
- Modify: `src/mycli/tools/bash_output.py`
- Modify: `src/mycli/tools/kill_shell.py`
- Test: `tests/unit/tools/test_shell_command_runtime.py`
- Test: `tests/unit/tools/test_run_shell.py`
- Test: `tests/unit/tools/test_bash_output.py`
- Test: `tests/unit/test_kill_shell.py`

- [ ] **Step 1: Write failing compatibility tests**

```python
def test_bash_output_rejects_shell_owned_by_another_session(tmp_path: Path) -> None:
    first = BashTool(tmp_path)
    first.configure_shell_session("session-a")
    started = first.execute({"command": "sleep 30", "run_in_background": True})
    try:
        output = BashOutputTool(session_id="session-b").execute(
            {"shell_id": started.raw_payload["shell_id"]}
        )
        assert output.success is False
        assert output.raw_payload["error_kind"] == "shell_session_forbidden"
    finally:
        KillShellTool(session_id="session-a").execute(
            {"shell_id": started.raw_payload["shell_id"]}
        )
```

Add assertions that background timeout becomes terminal and payloads include `omitted_output_chars`, `next_cursor`, and `cursor_was_evicted`.

- [ ] **Step 2: Verify RED**

```bash
uv run pytest tests/unit/tools/test_shell_command_runtime.py tests/unit/tools/test_run_shell.py \
  tests/unit/tools/test_bash_output.py tests/unit/test_kill_shell.py -q
```

Expected: new ownership and bounded-output assertions fail.

- [ ] **Step 3: Migrate backend request ownership**

Add `owner_session_id: str = "legacy"` to `ShellBackendRequest`. `BashTool.configure_shell_session()` stores the active owner and passes it through the backend.

- [ ] **Step 4: Replace registry logic with a facade**

Keep `SHELL_REGISTRY` and its `start/read/list/kill/processes/background_jobs` methods, but delegate to one `ShellSessionManager`. Preserve the legacy default owner for direct helper calls and existing tests.

- [ ] **Step 5: Migrate BashOutput and KillShell**

Both tools accept an injected or configured session ID and pass it to the registry facade. Keep `bash_id` as an input alias and preserve existing error kinds where compatible.

- [ ] **Step 6: Verify GREEN and commit**

```bash
uv run pytest tests/unit/tools/test_shell_command_runtime.py tests/unit/tools/test_run_shell.py \
  tests/unit/tools/test_bash_output.py tests/unit/test_kill_shell.py -q
git add src/mycli/tools/shell_registry.py src/mycli/tools/bash.py src/mycli/tools/shell_backend.py \
  src/mycli/tools/bash_output.py src/mycli/tools/kill_shell.py \
  tests/unit/tools/test_shell_command_runtime.py tests/unit/tools/test_run_shell.py \
  tests/unit/tools/test_bash_output.py tests/unit/test_kill_shell.py
git commit -m "Route shell tools through session manager"
```

### Task 5: Configure Runtime Ownership And Shutdown

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py:496,1009-1017,1042-1046`
- Test: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write failing runtime tests**

Add a fake shell tool exposing `configure_shell_session()` and assert `AgentRuntime` supplies `config.session_id`. Add a manager-backed test asserting `runtime.close()` terminates a shell owned by that runtime without affecting another owner.

- [ ] **Step 2: Verify RED**

```bash
uv run pytest tests/unit/application/test_agent_runtime.py::test_agent_runtime_configures_shell_tool_session_owner \
  tests/unit/application/test_agent_runtime.py::test_agent_runtime_close_terminates_owned_shell_sessions -q
```

Expected: FAIL because runtime does not configure or terminate ownership.

- [ ] **Step 3: Configure and terminate owned sessions**

Call `configure_shell_session(self._config.session_id)` on tools that expose it. Keep output-directory and notification configuration on `BashTool`. In `close()`, call `SHELL_REGISTRY.terminate_owner(self._config.session_id)` before the session-end hook.

- [ ] **Step 4: Verify GREEN and commit**

```bash
uv run pytest tests/unit/application/test_agent_runtime.py::test_agent_runtime_configures_shell_tool_session_owner \
  tests/unit/application/test_agent_runtime.py::test_agent_runtime_close_terminates_owned_shell_sessions -q
git add src/mycli/application/runtime/agent_runtime.py tests/unit/application/test_agent_runtime.py
git commit -m "Scope shell sessions to agent runtime"
```

### Task 6: Preserve Diagnostics, Notifications, And Full Runtime Behavior

**Files:**
- Modify if required: `src/mycli/application/turn_service.py`
- Modify if required: `src/mycli/services/diagnostics/doctor.py`
- Test: `tests/unit/services/test_doctor_service.py`
- Test: `tests/unit/application/test_tool_execution_service.py`
- Test: `tests/integration/test_toolset_smoke.py`

- [ ] **Step 1: Add notification idempotency regression test**

Start a short background command with a notification sink, poll repeatedly after completion, and assert exactly one notification with the expected task ID and terminal status.

- [ ] **Step 2: Run compatibility suites**

```bash
uv run pytest tests/unit/services/test_doctor_service.py \
  tests/unit/application/test_tool_execution_service.py tests/integration/test_toolset_smoke.py -q
```

Expected before any required projection fix: failures identify a missing manager projection field or duplicate notification.

- [ ] **Step 3: Adapt projections without raw command leakage**

Keep `shell_id`, state, timestamps, timeout, command hash/length, output counts, terminal state, and cleanup result. Do not expose raw command text in diagnostic payloads.

- [ ] **Step 4: Run focused regression suites**

```bash
uv run pytest tests/unit/tools/test_shell_output_buffer.py \
  tests/unit/tools/test_shell_session_manager.py tests/unit/tools/test_shell_command_runtime.py \
  tests/unit/tools/test_run_shell.py tests/unit/tools/test_bash_output.py \
  tests/unit/test_kill_shell.py tests/unit/services/context/test_tool_result_formatter.py \
  tests/unit/services/test_doctor_service.py tests/unit/application/test_tool_execution_service.py \
  tests/unit/application/test_agent_runtime.py tests/integration/test_toolset_smoke.py -q
```

Expected: PASS.

- [ ] **Step 5: Run quality gates**

```bash
uv run ruff check .
uv run mypy src
uv run pytest -q
```

Expected: no lint or type errors and the full test suite passes.

- [ ] **Step 6: Commit projection adjustments if files changed**

```bash
git add src/mycli/application/turn_service.py src/mycli/services/diagnostics/doctor.py \
  tests/unit/services/test_doctor_service.py tests/unit/application/test_tool_execution_service.py \
  tests/integration/test_toolset_smoke.py
git commit -m "Preserve shell runtime diagnostics and notifications"
```

## Completion Criteria

- All model-visible shell output has a hard context budget.
- Background timeout is enforced without polling.
- Background termination cleans up the process group.
- In-memory output retention is bounded.
- Shell access is scoped to the owning mycli session.
- Completed sessions are pruned before capacity can grow without bound.
- Existing model-visible tool names and arguments remain compatible.
- DeepSeek parallel-tool behavior remains in its own commit.
- `ruff`, `mypy`, and the full pytest suite pass.

