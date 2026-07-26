# Codex-Style Unified Shell Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give mycli Codex-style byte-streamed Shell execution with automatic yielding, resumable `WriteStdin` sessions, optional Unix PTY and Windows ConPTY transports, and one continuously updated TUI Shell card.

**Architecture:** Keep `ShellSessionManager` as the owner of IDs, cursors, bounded output, lifecycle events, timeout, and cleanup. Replace direct text-mode `Popen` ownership with a small `ShellProcessTransport` protocol implemented by pipe, Unix PTY, and Windows ConPTY backends; then layer yield and `WriteStdin` semantics over the transport-neutral manager while retaining hidden legacy adapters.

**Tech Stack:** Python 3.13, `subprocess`, Python `pty`/`fcntl`/`termios` on Unix, Windows-only `pywinpty`, pytest, Ruff, Mypy, Node.js 22.19+, TypeScript 5.9, Node test runner, GitHub Actions.

***

## File Map

### New Python modules

- `src/mycli/tools/shell_transport/__init__.py`: public transport exports.
- `src/mycli/tools/shell_transport/base.py`: chunk type, transport protocol, transport errors, and factory request.
- `src/mycli/tools/shell_transport/factory.py`: lazy platform dispatch for pipe, Unix PTY, and Windows ConPTY.
- `src/mycli/tools/shell_transport/pipe.py`: binary pipe process transport.
- `src/mycli/tools/shell_transport/unix_pty.py`: POSIX PTY process transport.
- `src/mycli/tools/shell_transport/windows_conpty.py`: Windows ConPTY process transport.
- `src/mycli/tools/shell_output_decoder.py`: incremental decoding and terminal-control sanitization.
- `src/mycli/tools/write_stdin.py`: model-visible continuation tool.

### Existing Python modules to modify

- `src/mycli/tools/shell_session_manager.py`: own transports, model cursor, yield state, interaction lock, and wait conditions.
- `src/mycli/tools/shell_registry.py`: expose transport-neutral execute/interact operations and retain legacy facade methods.
- `src/mycli/tools/shell_backend.py`: replace background selection with tty/yield/output-budget request fields while retaining legacy fields.
- `src/mycli/tools/bash.py`: new Shell schema and execution mapping; hidden Bash compatibility behavior.
- `src/mycli/tools/shell_output.py`: hidden compatibility adapter over immediate polling.
- `src/mycli/tools/kill_shell.py`: hidden compatibility adapter over manager termination.
- `src/mycli/tools/model_output.py`: stable Codex-style Shell/WriteStdin response text.
- `src/mycli/tools/registry.py`: register `WriteStdin` while retaining old executors.
- `src/mycli/tools/routing/tool_exposure_planner.py`: expose `Shell` and `WriteStdin`, hide legacy controls.
- `src/mycli/services/approval/safety_policy.py`: auto-allow owned-session continuation and retain legacy normalization.
- `src/mycli/services/context/tool_output_projector.py`: classify `WriteStdin` as Shell output.
- `src/mycli/services/context/tool_result_formatter.py`: format `WriteStdin` as Shell output.
- `src/mycli/application/runtime/tools/tool_execution_service.py`: recognize `WriteStdin` as Shell continuation transport.
- `src/mycli/cli/bootstrap.py`: construct `WriteStdinTool` in production registries.
- `src/mycli/domain/runtime/shell_lifecycle.py`: add transport, tty, and yielded metadata to TUI events.
- `src/mycli/prompts/templates/system.md`: describe yield/continuation behavior without legacy tool names.
- `pyproject.toml` and `uv.lock`: add the Windows-only `pywinpty` dependency.
- `.github/workflows/cross-platform.yml`: add native PTY/ConPTY smoke lanes.

### Node TUI modules to modify

- `tui/mycli-shell/src/model.ts`: retain transport/tty/yielded Shell metadata.
- `tui/mycli-shell/src/adapters/runtime-state.ts`: merge `WriteStdin` and yield transitions into the original Shell block.
- `tui/mycli-shell/src/components/bash-execution.ts`: use yielded/background state for the interrupt hint.

### Tests to add or modify

- `tests/unit/tools/shell_transport/test_contract.py`
- `tests/unit/tools/shell_transport/test_pipe.py`
- `tests/unit/tools/shell_transport/test_unix_pty.py`
- `tests/unit/tools/shell_transport/test_windows_conpty.py`
- `tests/support/shell_transports.py`
- `tests/unit/tools/test_shell_output_decoder.py`
- `tests/unit/tools/test_shell_session_manager.py`
- `tests/unit/tools/test_run_shell.py`
- `tests/unit/tools/test_bash_output.py`
- `tests/unit/tools/test_write_stdin.py`
- `tests/unit/tools/test_tool_registry.py`
- `tests/unit/services/test_safety_policy.py`
- `tests/unit/services/context/test_tool_output_projector.py`
- `tests/integration/test_cross_platform_shell.py`
- `tui/mycli-shell/test/runtime-state.test.ts`
- `tui/mycli-shell/test/shell-app.test.ts`

## Task 1: Define The Transport Contract

**Files:**

- Create: `src/mycli/tools/shell_transport/__init__.py`
- Create: `src/mycli/tools/shell_transport/base.py`
- Create: `tests/support/shell_transports.py`
- Create: `tests/unit/tools/shell_transport/test_contract.py`
- [ ] **Step 1: Write the failing contract tests**

```python
from pathlib import Path

from mycli.tools.shell_transport.base import (
    ShellOutputChunk,
    ShellTransportRequest,
    ShellTransportUnavailable,
)


def test_output_chunk_rejects_unknown_stream() -> None:
    try:
        ShellOutputChunk(sequence=1, stream="unknown", data=b"x")
    except ValueError as exc:
        assert "stream" in str(exc)
    else:
        raise AssertionError("unknown stream must be rejected")


def test_transport_request_is_binary_and_platform_neutral(tmp_path: Path) -> None:
    request = ShellTransportRequest(
        argv=("/bin/sh", "-c", "printf ok"),
        cwd=tmp_path,
        env={"PATH": "/usr/bin"},
        tty=False,
        rows=24,
        columns=80,
    )

    assert request.argv[0] == "/bin/sh"
    assert request.tty is False
    assert request.rows == 24
    assert request.columns == 80


def test_transport_unavailable_has_stable_error_kind() -> None:
    error = ShellTransportUnavailable("conpty_unavailable", "ConPTY unavailable")

    assert error.error_kind == "conpty_unavailable"
    assert str(error) == "ConPTY unavailable"
```

- [ ] **Step 2: Run the tests to verify RED**

Run:

```bash
uv run pytest tests/unit/tools/shell_transport/test_contract.py -q
```

Expected: collection fails because `mycli.tools.shell_transport` does not exist.

- [ ] **Step 3: Implement the transport types and protocol**

```python
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

from mycli.tools.process_controller import ProcessTerminationOutcome


ShellStream = Literal["stdout", "stderr", "terminal"]


@dataclass(frozen=True, slots=True)
class ShellOutputChunk:
    sequence: int
    stream: ShellStream
    data: bytes

    def __post_init__(self) -> None:
        if self.stream not in {"stdout", "stderr", "terminal"}:
            raise ValueError(f"Unsupported shell output stream: {self.stream}")


@dataclass(frozen=True, slots=True)
class ShellTransportRequest:
    argv: tuple[str, ...]
    cwd: Path
    env: dict[str, str] | None
    tty: bool
    rows: int = 24
    columns: int = 80


class ShellTransportUnavailable(RuntimeError):
    def __init__(self, error_kind: str, message: str) -> None:
        super().__init__(message)
        self.error_kind = error_kind


class ShellProcessTransport(Protocol):
    kind: Literal["pipe", "unix_pty", "windows_conpty"]
    tty: bool

    def read_chunks(self) -> Iterator[ShellOutputChunk]:
        raise NotImplementedError

    def write(self, data: bytes) -> None:
        raise NotImplementedError

    def poll(self) -> int | None:
        raise NotImplementedError

    def wait(self) -> int:
        raise NotImplementedError

    def interrupt(self) -> ProcessTerminationOutcome:
        raise NotImplementedError

    def terminate(self) -> ProcessTerminationOutcome:
        raise NotImplementedError

    def resize(self, rows: int, columns: int) -> None:
        raise NotImplementedError

    def close(self) -> None:
        raise NotImplementedError

    def compatibility_process(self) -> object | None:
        raise NotImplementedError
```

Export the types from `shell_transport/__init__.py`.

Add one reusable deterministic transport under `tests/support/shell_transports.py`:

```python
from __future__ import annotations

from collections.abc import Iterator
from queue import Queue
from threading import Event

from mycli.tools.process_controller import ProcessTerminationOutcome
from mycli.tools.shell_transport.base import ShellOutputChunk, ShellStream


class FakeShellTransport:
    kind = "pipe"

    def __init__(self, *, tty: bool = False) -> None:
        self.tty = tty
        self.writes: list[bytes] = []
        self.resizes: list[tuple[int, int]] = []
        self._chunks: Queue[ShellOutputChunk | None] = Queue()
        self._exited = Event()
        self._exit_code: int | None = None
        self._sequence = 0

    def publish(self, data: bytes, *, stream: ShellStream | None = None) -> None:
        self._sequence += 1
        self._chunks.put(
            ShellOutputChunk(
                sequence=self._sequence,
                stream=stream or ("terminal" if self.tty else "stdout"),
                data=data,
            )
        )

    def finish(self, exit_code: int = 0) -> None:
        self._exit_code = exit_code
        self._exited.set()
        self._chunks.put(None)

    def read_chunks(self) -> Iterator[ShellOutputChunk]:
        while True:
            chunk = self._chunks.get()
            if chunk is None:
                return
            yield chunk

    def write(self, data: bytes) -> None:
        if not self.tty:
            raise RuntimeError("stdin_closed")
        self.writes.append(data)

    def poll(self) -> int | None:
        return self._exit_code if self._exited.is_set() else None

    def wait(self) -> int:
        self._exited.wait(timeout=2)
        return -1 if self._exit_code is None else self._exit_code

    def interrupt(self) -> ProcessTerminationOutcome:
        self.finish(130)
        return ProcessTerminationOutcome("interrupted", terminal=True)

    def terminate(self) -> ProcessTerminationOutcome:
        self.finish(143)
        return ProcessTerminationOutcome("terminated", terminal=True)

    def resize(self, rows: int, columns: int) -> None:
        self.resizes.append((rows, columns))

    def close(self) -> None:
        return

    def compatibility_process(self) -> object | None:
        return None
```

- [ ] **Step 4: Run tests and static checks**

```bash
uv run pytest tests/unit/tools/shell_transport/test_contract.py -q
uv run ruff check src/mycli/tools/shell_transport tests/unit/tools/shell_transport
uv run mypy src/mycli/tools/shell_transport
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/shell_transport tests/support/shell_transports.py tests/unit/tools/shell_transport/test_contract.py
git commit -m "feat: define shell process transport contract"
```

## Task 2: Add Incremental Output Decoding And Sanitization

**Files:**

- Create: `src/mycli/tools/shell_output_decoder.py`
- Create: `tests/unit/tools/test_shell_output_decoder.py`
- [ ] **Step 1: Write failing decoder tests**

```python
from mycli.tools.shell_output_decoder import ShellOutputDecoder


def test_decoder_preserves_utf8_split_across_chunks() -> None:
    decoder = ShellOutputDecoder()
    encoded = "你好".encode()

    first = decoder.feed("stdout", encoded[:2])
    second = decoder.feed("stdout", encoded[2:])

    assert first + second == "你好"
    assert "�" not in first + second


def test_decoder_normalizes_terminal_controls() -> None:
    decoder = ShellOutputDecoder()

    text = decoder.feed("terminal", b"\x1b[31mred\x1b[0m\rnext\x1b]0;title\x07\n")

    assert text == "red\nnext\n"
    assert "\x1b" not in text


def test_decoder_flushes_incomplete_invalid_bytes_once() -> None:
    decoder = ShellOutputDecoder()

    assert decoder.feed("stdout", b"\xe4") == ""
    assert decoder.flush("stdout") == "�"
    assert decoder.replacement_count == 1
```

- [ ] **Step 2: Run the tests to verify RED**

```bash
uv run pytest tests/unit/tools/test_shell_output_decoder.py -q
```

Expected: collection fails because `ShellOutputDecoder` does not exist.

- [ ] **Step 3: Implement a stateful decoder**

Implement `ShellOutputDecoder` with one `codecs.getincrementaldecoder("utf-8")` instance per
stream. Feed decoded text through a stateful sanitizer that:

```python
_ALLOWED_CONTROL = {"\n", "\t"}


def _stable_terminal_text(text: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    output: list[str] = []
    for character in normalized:
        if character == "\b":
            if output and output[-1] not in _ALLOWED_CONTROL:
                output.pop()
            continue
        if ord(character) < 32 and character not in _ALLOWED_CONTROL:
            continue
        output.append(character)
    return "".join(output)
```

The class must also buffer incomplete CSI/OSC escape sequences across chunk boundaries, discard
them when complete, count Unicode replacement characters, and flush each stream exactly once at
EOF. Do not use a broad regex that can leak a split OSC payload into the TUI.

- [ ] **Step 4: Run focused tests**

```bash
uv run pytest tests/unit/tools/test_shell_output_decoder.py -q
uv run ruff check src/mycli/tools/shell_output_decoder.py tests/unit/tools/test_shell_output_decoder.py
uv run mypy src/mycli/tools/shell_output_decoder.py
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/shell_output_decoder.py tests/unit/tools/test_shell_output_decoder.py
git commit -m "feat: normalize streamed shell output"
```

## Task 3: Implement Binary Pipe Transport

**Files:**

- Create: `src/mycli/tools/shell_transport/pipe.py`
- Create: `src/mycli/tools/shell_transport/factory.py`
- Modify: `src/mycli/tools/shell_transport/__init__.py`
- Create: `tests/unit/tools/shell_transport/test_pipe.py`
- Modify: `src/mycli/tools/process_controller.py`
- [ ] **Step 1: Write failing pipe transport tests**

```python
import sys
import time

from mycli.tools.shell_transport.base import ShellTransportRequest
from mycli.tools.shell_transport.pipe import PipeTransport


def test_pipe_yields_flushed_partial_line_before_exit(tmp_path) -> None:
    request = ShellTransportRequest(
        argv=(
            sys.executable,
            "-c",
            "import os,time; os.write(1,b'ready'); time.sleep(1)",
        ),
        cwd=tmp_path,
        env=None,
        tty=False,
    )
    transport = PipeTransport.start(request)
    started = time.monotonic()

    first = next(transport.read_chunks())

    try:
        assert first.data == b"ready"
        assert time.monotonic() - started < 0.8
        assert first.stream == "stdout"
    finally:
        transport.terminate()
        transport.close()


def test_pipe_keeps_stdout_and_stderr_labels(tmp_path) -> None:
    request = ShellTransportRequest(
        argv=(sys.executable, "-c", "import os; os.write(1,b'out'); os.write(2,b'err')"),
        cwd=tmp_path,
        env=None,
        tty=False,
    )
    transport = PipeTransport.start(request)

    chunks = list(transport.read_chunks())

    assert {chunk.stream for chunk in chunks} == {"stdout", "stderr"}
    assert transport.wait() == 0
```

- [ ] **Step 2: Run the tests to verify RED**

```bash
uv run pytest tests/unit/tools/shell_transport/test_pipe.py -q
```

Expected: import fails because `PipeTransport` does not exist.

- [ ] **Step 3: Implement queue-backed binary readers**

`PipeTransport.start()` must launch `subprocess.Popen[bytes]` with `stdin=DEVNULL`,
`stdout=PIPE`, `stderr=PIPE`, `text=False`, `bufsize=0`, and current
`process_spawn_options()`. Two producer threads call `read(8192)` and publish chunks into one
queue. Sequence allocation is protected by one lock. `read_chunks()` yields until both producers
publish EOF sentinels.

Use the existing process controller for `interrupt()` and `terminate()`. Generalize its annotations
from `Popen[str]` to `Popen[bytes] | Popen[str]` without changing platform behavior. `resize()` on
the pipe transport raises
`ShellTransportUnavailable("shell_resize_failed", "Pipe sessions cannot be resized.")`.

- [ ] **Step 4: Add the factory's default branch**

```python
def create_shell_transport(request: ShellTransportRequest) -> ShellProcessTransport:
    if not request.tty:
        return PipeTransport.start(request)
    if os.name == "nt":
        from mycli.tools.shell_transport.windows_conpty import WindowsConPtyTransport

        return WindowsConPtyTransport.start(request)
    from mycli.tools.shell_transport.unix_pty import UnixPtyTransport

    return UnixPtyTransport.start(request)
```

The PTY imports are intentionally lazy; their modules are added in later tasks.

- [ ] **Step 5: Run tests and static checks**

```bash
uv run pytest tests/unit/tools/shell_transport/test_pipe.py tests/unit/tools/test_process_controller.py -q
uv run ruff check src/mycli/tools/shell_transport src/mycli/tools/process_controller.py
uv run mypy src/mycli/tools/shell_transport src/mycli/tools/process_controller.py
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/tools/shell_transport src/mycli/tools/process_controller.py tests/unit/tools/shell_transport/test_pipe.py
git commit -m "feat: stream shell output through binary pipes"
```

## Task 4: Move ShellSessionManager Onto Transports

**Files:**

- Modify: `src/mycli/tools/shell_session_manager.py`
- Modify: `src/mycli/tools/shell_registry.py`
- Modify: `tests/unit/tools/test_shell_session_manager.py`
- [ ] **Step 1: Add failing manager transport tests**

Create a deterministic fake transport in the test module with queue-backed chunks, explicit exit,
and recorded writes. Add these assertions:

```python
from tests.support.shell_transports import FakeShellTransport


def test_manager_decodes_partial_binary_chunks_without_line_wait(tmp_path) -> None:
    transport = FakeShellTransport()
    transport.publish(b"rea")
    transport.publish(b"dy")
    transport.finish(0)
    manager = ShellSessionManager(transport_factory=lambda _request: transport)

    snapshot = manager.start(_request(tmp_path, "ignored", background=False))

    assert snapshot.output == "ready"
    assert snapshot.stdout == "ready"
    assert snapshot.stderr == ""
    assert snapshot.transport == "pipe"
    assert snapshot.tty is False


def test_manager_flushes_decoder_before_completed_event(tmp_path) -> None:
    events = []
    transport = FakeShellTransport()
    transport.publish(b"\xe4")
    transport.finish(0)
    manager = ShellSessionManager(
        transport_factory=lambda _request: transport,
        output_event_interval_seconds=0,
    )

    snapshot = manager.start(_request(tmp_path, "ignored", background=False, lifecycle_sink=events.append))

    assert snapshot.output == "�"
    assert [event.kind for event in events][-1] == "shell.completed"
    assert any(event.kind == "shell.output" and "�" in event.output_delta for event in events)
```

Update `_request` to accept `background`, `tty`, and lifecycle overrides explicitly.

- [ ] **Step 2: Run the tests to verify RED**

```bash
uv run pytest tests/unit/tools/test_shell_session_manager.py -q
```

Expected: new tests fail because the manager still owns text-mode `Popen` directly.

- [ ] **Step 3: Refactor session state and startup**

Replace `_ShellSession.process` with:

```python
transport: ShellProcessTransport
decoder: ShellOutputDecoder
transport_kind: str
tty: bool
model_cursor: int = 0
interaction_lock: Lock = field(default_factory=Lock)
state_changed: Condition = field(default_factory=Condition)
```

Add `tty`, `transport`, and `decode_replacement_count` to `ShellSessionSnapshot`. Extend
`ShellStartRequest` with `tty: bool = False` while keeping `background` unchanged in this task.

Build `ShellTransportRequest` from `shell_profile.exec_argv(request.command)`, cwd, env, tty, and
default 24x80 dimensions. Catch `ShellTransportUnavailable` separately so its `error_kind` reaches
the result. Replace stdout/stderr drain threads with one manager reader thread over
`transport.read_chunks()`. Decode each chunk by stream, append to the matching buffer and combined
buffer, write normalized text to the output file, and schedule the existing lifecycle flush.

- [ ] **Step 4: Preserve compatibility process inspection**

Change `ShellSessionManager.processes()` and `ShellProcessRegistry.processes()` to return
`dict[str, object]`. Include only non-`None` values from `transport.compatibility_process()` so old
tests and diagnostics can still terminate local pipe processes during migration.

- [ ] **Step 5: Run the existing manager regression suite**

```bash
uv run pytest tests/unit/tools/test_shell_session_manager.py tests/unit/tools/test_shell_command_runtime.py tests/unit/tools/test_bash_output.py tests/unit/test_kill_shell.py -q
uv run ruff check src/mycli/tools/shell_session_manager.py src/mycli/tools/shell_registry.py
uv run mypy src/mycli/tools/shell_session_manager.py src/mycli/tools/shell_registry.py
```

Expected: all existing foreground/background lifecycle behavior still passes through
`PipeTransport`.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/tools/shell_session_manager.py src/mycli/tools/shell_registry.py tests/unit/tools/test_shell_session_manager.py
git commit -m "refactor: run shell sessions through transports"
```

## Task 5: Implement Yield-Based Session Semantics

**Files:**

- Modify: `src/mycli/tools/shell_session_manager.py`
- Modify: `src/mycli/tools/shell_registry.py`
- Modify: `src/mycli/tools/shell_backend.py`
- Modify: `tests/unit/tools/test_shell_session_manager.py`
- Modify: `tests/unit/tools/test_shell_command_runtime.py`
- [ ] **Step 1: Write failing yield and race tests**

```python
from threading import Timer

from tests.support.shell_transports import FakeShellTransport


def test_new_session_yields_to_background_after_deadline(tmp_path) -> None:
    transport = FakeShellTransport()
    events = []
    manager = ShellSessionManager(transport_factory=lambda _request: transport)

    snapshot = manager.start(
        _request(
            tmp_path,
            "ignored",
            background=None,
            yield_time_ms=25,
            lifecycle_sink=events.append,
        )
    )

    assert snapshot.background is True
    assert snapshot.process_state == "running_background"
    assert snapshot.yielded is True
    assert any(event.kind == "shell.list.updated" and event.active_background_count == 1 for event in events)


def test_completion_wins_race_with_yield(tmp_path) -> None:
    transport = FakeShellTransport()
    manager = ShellSessionManager(transport_factory=lambda _request: transport)
    timer = Timer(0.01, lambda: transport.finish(0))
    timer.start()

    snapshot = manager.start(_request(tmp_path, "ignored", background=None, yield_time_ms=25))
    timer.join(timeout=1)

    assert snapshot.terminal_state == "completed"
    assert snapshot.background is False
    assert snapshot.yielded is False
```

- [ ] **Step 2: Run the tests to verify RED**

```bash
uv run pytest tests/unit/tools/test_shell_session_manager.py -k "yield or deadline" -q
```

Expected: tests fail because `background=None` and `yield_time_ms` are not implemented.

- [ ] **Step 3: Add tri-state compatibility semantics**

Change `ShellStartRequest` to:

```python
background: bool | None = None
yield_time_ms: int = 10_000
```

Interpret states as follows:

- `None`: new behavior; wait at most clamped `yield_time_ms`, then atomically set background.
- `True`: legacy behavior; return after successful startup.
- `False`: legacy behavior; wait for terminal state or absolute timeout.

Add `yielded: bool` to session and snapshot state. Implement `_wait_for_initial_result()` using the
per-session `Condition`; do not poll every 10 ms. Output publication and terminal finalization must
notify the condition. Clamp new-mode yield to 250-30000 ms.

- [ ] **Step 4: Thread new fields through registry and backend**

Add `tty`, `yield_time_ms`, `max_output_tokens`, and `legacy_background` to
`ShellBackendRequest`. `ShellProcessRegistry.execute()` passes `background=None` for new calls and
the explicit legacy boolean only when the compatibility adapter supplied it.

Add this explicit new-style registry entry point; keep `execute()` as the legacy facade:

```python
def execute_new(
    self,
    command: str,
    *,
    owner_session_id: str = LEGACY_SHELL_OWNER,
    workdir: str | None = None,
    env: dict[str, str] | None = None,
    timeout_seconds: int = 120,
    tty: bool = False,
    yield_time_ms: int = 10_000,
    max_output_tokens: int = 10_000,
    shell_path: str | None = None,
    shell_profile: ShellProfile | None = None,
    command_pattern: str | None = None,
    output_file: Path | None = None,
    notification_sink: Callable[[TaskNotification], None] | None = None,
    call_id: str | None = None,
    lifecycle_sink: Callable[[ShellLifecycleEvent], None] | None = None,
    interrupt_token: RuntimeInterruptToken | None = None,
) -> dict[str, object]:
    snapshot = self._manager.start(
        ShellStartRequest(
            owner_session_id=owner_session_id,
            command=command,
            cwd=Path(workdir or ".").resolve(),
            timeout_seconds=timeout_seconds,
            background=None,
            tty=tty,
            yield_time_ms=yield_time_ms,
            shell_path=shell_path,
            shell_profile=shell_profile,
            env=env,
            command_pattern=command_pattern,
            output_file=output_file,
            notification_sink=notification_sink,
            call_id=call_id,
            lifecycle_sink=lifecycle_sink,
            interrupt_token=interrupt_token,
        )
    )
    payload = _snapshot_payload(snapshot)
    payload["max_output_tokens"] = max_output_tokens
    return payload
```

- [ ] **Step 5: Run manager and backend tests**

```bash
uv run pytest tests/unit/tools/test_shell_session_manager.py tests/unit/tools/test_shell_command_runtime.py tests/unit/tools/test_run_shell.py -q
uv run ruff check src/mycli/tools/shell_session_manager.py src/mycli/tools/shell_registry.py src/mycli/tools/shell_backend.py
uv run mypy src/mycli/tools/shell_session_manager.py src/mycli/tools/shell_registry.py src/mycli/tools/shell_backend.py
```

Expected: all pass, including existing explicit foreground/background tests.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/tools/shell_session_manager.py src/mycli/tools/shell_registry.py src/mycli/tools/shell_backend.py tests/unit/tools/test_shell_session_manager.py tests/unit/tools/test_shell_command_runtime.py tests/unit/tools/test_run_shell.py
git commit -m "feat: yield long-running shell sessions"
```

## Task 6: Add WriteStdin And Stable Model Output

**Files:**

- Create: `src/mycli/tools/write_stdin.py`
- Create: `tests/unit/tools/test_write_stdin.py`
- Modify: `src/mycli/tools/shell_session_manager.py`
- Modify: `src/mycli/tools/shell_registry.py`
- Modify: `src/mycli/tools/model_output.py`
- Modify: `tests/unit/tools/test_run_shell.py`
- [ ] **Step 1: Write failing interaction tests**

```python
from tests.support.shell_transports import FakeShellTransport


def test_write_stdin_empty_chars_waits_for_incremental_output(tmp_path) -> None:
    transport = FakeShellTransport(tty=True)
    manager = ShellSessionManager(transport_factory=lambda _request: transport)
    registry = ShellProcessRegistry(manager)
    started = registry.execute_new("ignored", owner_session_id="session-a", workdir=str(tmp_path), tty=True, yield_time_ms=25)
    transport.publish(b"prompt> ")
    tool = WriteStdinTool(session_id="session-a", registry=registry)

    result = tool.execute({"session_id": started["shell_id"], "chars": "", "yield_time_ms": 250})

    assert result.success is True
    assert result.raw_payload["output"] == "prompt> "
    assert transport.writes == []


def test_write_stdin_writes_only_to_tty_session(tmp_path) -> None:
    transport = FakeShellTransport(tty=True)
    manager = ShellSessionManager(transport_factory=lambda _request: transport)
    registry = ShellProcessRegistry(manager)
    started = registry.execute_new("ignored", owner_session_id="session-a", workdir=str(tmp_path), tty=True, yield_time_ms=25)
    tool = WriteStdinTool(session_id="session-a", registry=registry)

    result = tool.execute({"session_id": started["shell_id"], "chars": "yes\n"})

    assert result.success is True
    assert transport.writes == [b"yes\n"]


def test_write_stdin_rejects_nonempty_pipe_input(tmp_path) -> None:
    transport = FakeShellTransport(tty=False)
    manager = ShellSessionManager(transport_factory=lambda _request: transport)
    registry = ShellProcessRegistry(manager)
    started = registry.execute_new("ignored", owner_session_id="session-a", workdir=str(tmp_path), tty=False, yield_time_ms=25)
    tool = WriteStdinTool(session_id="session-a", registry=registry)

    result = tool.execute({"session_id": started["shell_id"], "chars": "yes\n"})

    assert result.success is False
    assert result.raw_payload["error_kind"] == "stdin_closed"
```

- [ ] **Step 2: Run the tests to verify RED**

```bash
uv run pytest tests/unit/tools/test_write_stdin.py -q
```

Expected: collection fails because `WriteStdinTool` and registry interaction do not exist.

- [ ] **Step 3: Implement manager interaction**

Add `ShellSessionManager.interact(owner_session_id, shell_id, *, chars, yield_time_ms,
max_output_tokens)` that:

1. checks owner and acquires `interaction_lock`;
2. maps `b"\x03"` to `interrupt()` for pipe sessions;
3. rejects other non-empty input when `transport.tty` is false;
4. writes bytes for PTY/ConPTY sessions;
5. waits on `state_changed` until output advances beyond `model_cursor`, the process exits, or the
   clamped deadline expires;
6. returns a snapshot from `model_cursor` and advances only `model_cursor`.

The initial new-style `Shell` result must also advance `model_cursor` so `WriteStdin` does not
repeat output already returned by `Shell`. Keep legacy `read_cursor` and lifecycle cursor separate.

- [ ] **Step 4: Implement WriteStdinTool**

Use this schema:

```python
spec = ToolSpec(
    name="WriteStdin",
    description="Wait for output from a running Shell session or write input to a PTY session.",
    parameters=(
        ToolParameter(name="session_id", type="string", required=True),
        ToolParameter(name="chars", type="string", required=False),
        ToolParameter(name="yield_time_ms", type="integer", required=False),
        ToolParameter(name="max_output_tokens", type="integer", required=False),
    ),
    risk_level="low",
    model_output_adapter=shell_model_output,
)
```

Validate positive output budgets, clamp yield intervals, accept hidden `shell_id`/`bash_id`
aliases, and never include `chars` in result payloads or trace metadata.

- [ ] **Step 5: Replace Shell model output text**

Update `shell_model_output()` to render fields in this fixed order:

```python
def _shell_response_text(payload: dict[str, object]) -> str:
    chunk_id = str(payload["chunk_id"])
    wall_time = float(payload.get("wall_time_seconds", 0.0))
    output = str(payload.get("output") or "")
    session_id = payload.get("shell_id")
    if payload.get("terminal_state") is None and isinstance(session_id, str):
        status = f"Process running with session ID {session_id}"
        heading = "Live output:"
    else:
        status = f"Process exited with code {int(payload.get('exit_code', -1))}"
        heading = "Final output:"
    lines = [f"Chunk ID: {chunk_id}", f"Wall time: {wall_time:.2f} seconds", status, heading]
    if output:
        lines.append(output)
    return "\n".join(lines)
```

Generate an eight-character chunk ID for each Shell/WriteStdin response. Convert
`max_output_tokens` to a conservative character cap of four characters per token before the
existing global `ToolOutputBudgeter` applies its policy cap. Record `original_token_count` before
head/tail truncation.

- [ ] **Step 6: Run focused tests**

```bash
uv run pytest tests/unit/tools/test_write_stdin.py tests/unit/tools/test_run_shell.py tests/unit/services/context/test_tool_output_budget.py -q
uv run ruff check src/mycli/tools/write_stdin.py src/mycli/tools/model_output.py src/mycli/tools/shell_session_manager.py
uv run mypy src/mycli/tools/write_stdin.py src/mycli/tools/model_output.py src/mycli/tools/shell_session_manager.py
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/mycli/tools/write_stdin.py src/mycli/tools/model_output.py src/mycli/tools/shell_session_manager.py src/mycli/tools/shell_registry.py tests/unit/tools/test_write_stdin.py tests/unit/tools/test_run_shell.py
git commit -m "feat: continue shell sessions with WriteStdin"
```

## Task 7: Switch The Model-Visible Tool Contract

**Files:**

- Modify: `src/mycli/tools/bash.py`
- Modify: `src/mycli/tools/registry.py`
- Modify: `src/mycli/tools/routing/tool_exposure_planner.py`
- Modify: `src/mycli/cli/bootstrap.py`
- Modify: `src/mycli/services/approval/safety_policy.py`
- Modify: `src/mycli/services/context/tool_output_projector.py`
- Modify: `src/mycli/services/context/tool_result_formatter.py`
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py`
- Modify: `src/mycli/prompts/templates/system.md`
- Modify: `tests/unit/tools/test_tool_registry.py`
- Modify: `tests/unit/services/test_safety_policy.py`
- Modify: `tests/unit/prompts/test_prompts.py`
- [ ] **Step 1: Write failing schema and exposure tests**

```python
def test_shell_schema_exposes_codex_style_parameters() -> None:
    parameters = {parameter.name for parameter in ShellTool.spec.parameters}

    assert parameters == {"command", "cwd", "tty", "yield_time_ms", "max_output_tokens"}


def test_model_exposure_uses_write_stdin_and_hides_legacy_controls(tmp_path) -> None:
    registry = ToolRegistry(workspace_root=tmp_path)
    planner = ToolExposurePlanner(tool_registry=registry)

    names = planner.plan(user_message="run tests").exposure.callable_tool_names()

    assert "Shell" in names
    assert "WriteStdin" in names
    assert "ShellOutput" not in names
    assert "BashOutput" not in names
    assert "KillShell" not in names
```

- [ ] **Step 2: Run the tests to verify RED**

```bash
uv run pytest tests/unit/tools/test_run_shell.py tests/unit/tools/test_tool_registry.py tests/unit/services/test_tool_exposure_planner.py -q
```

Expected: assertions fail because the old model-visible schema is still active.

- [ ] **Step 3: Update Shell execution mapping**

`ShellTool` passes `legacy_background=None`, `tty`, clamped `yield-time_ms`, and validated
`max_output_tokens` into `ShellBackendRequest`. It always supplies the configured notification sink
and a candidate output-file path; the manager emits a task notification only if the command
actually yielded.

`BashTool` retains the old schema and maps explicit `run_in_background`/`timeout` into the tri-state
compatibility fields. Do not share `ShellTool.spec.parameters` with `BashTool`.

- [ ] **Step 4: Register and expose tools**

Add `WriteStdinTool()` to both registry construction paths. Keep `ShellOutputTool`,
`BashOutputTool`, and `KillShellTool` registered for replay and plugins. In exposure constants:

```python
MODEL_VISIBLE_BUILTIN_TOOLS = frozenset(
    {
        "AskUserQuestion",
        "Shell",
        "WriteStdin",
        "Edit",
        "LS",
        "Plan",
        "Read",
        "SendMessage",
        "Skill",
        "Task",
        "WebFetch",
        "WebSearch",
        "Write",
    }
)
```

Move `ShellOutput` and `KillShell` into `HIDDEN_BY_DEFAULT_BUILTIN_TOOLS` alongside legacy aliases.

- [ ] **Step 5: Update policy, formatter, and prompt classifications**

Treat `WriteStdin` as an owned process continuation with no second approval. Add it to Shell result
budgeting/formatting and tool execution continuation sets. Update the stable system prompt to say:

```text
Shell waits briefly for completion. If it returns a session ID, use WriteStdin with empty chars to
wait for more output, or non-empty chars only for a Shell started with tty=true.
```

Remove model guidance for `run_in_background`, `ShellOutput`, and `KillShell`.

- [ ] **Step 6: Run registry, policy, prompt, and request-shape tests**

```bash
uv run pytest tests/unit/tools/test_run_shell.py tests/unit/tools/test_tool_registry.py tests/unit/services/test_tool_exposure_planner.py tests/unit/services/test_safety_policy.py tests/unit/services/context/test_tool_output_projector.py tests/unit/prompts/test_prompts.py -q
uv run ruff check src/mycli/tools src/mycli/services/approval/safety_policy.py src/mycli/services/context src/mycli/tools/routing/tool_exposure_planner.py
uv run mypy src/mycli/tools src/mycli/services/approval/safety_policy.py src/mycli/services/context
```

Expected: all pass and only new names appear in fresh model requests.

- [ ] **Step 7: Commit**

```bash
git add src/mycli/tools/bash.py src/mycli/tools/registry.py src/mycli/tools/routing/tool_exposure_planner.py src/mycli/cli/bootstrap.py src/mycli/services/approval/safety_policy.py src/mycli/services/context src/mycli/application/runtime/tools/tool_execution_service.py src/mycli/prompts/templates/system.md tests/unit/tools tests/unit/services tests/unit/prompts
git commit -m "feat: expose Codex-style Shell continuation tools"
```

## Task 8: Implement Unix PTY Transport

**Files:**

- Create: `src/mycli/tools/shell_transport/unix_pty.py`
- Create: `tests/unit/tools/shell_transport/test_unix_pty.py`
- [ ] **Step 1: Write POSIX-only PTY tests**

```python
import os
import sys

import pytest

from mycli.tools.shell_transport.base import ShellTransportRequest
from mycli.tools.shell_transport.unix_pty import UnixPtyTransport


pytestmark = pytest.mark.skipif(os.name != "posix", reason="requires POSIX PTY")


def test_unix_pty_reports_terminal_and_accepts_input(tmp_path) -> None:
    request = ShellTransportRequest(
        argv=(sys.executable, "-c", "value=input('prompt> '); print('got:'+value, flush=True)"),
        cwd=tmp_path,
        env=None,
        tty=True,
    )
    transport = UnixPtyTransport.start(request)
    chunks = transport.read_chunks()

    prompt = next(chunks)
    transport.write(b"yes\n")
    remaining = b"".join(chunk.data for chunk in chunks)

    assert prompt.stream == "terminal"
    assert b"prompt> " in prompt.data
    assert b"got:yes" in remaining
    assert transport.wait() == 0


def test_unix_pty_resize_does_not_close_session(tmp_path) -> None:
    request = ShellTransportRequest(
        argv=(sys.executable, "-c", "import time; time.sleep(.2)"),
        cwd=tmp_path,
        env=None,
        tty=True,
    )
    transport = UnixPtyTransport.start(request)

    transport.resize(40, 120)

    assert transport.poll() is None
    transport.terminate()
```

- [ ] **Step 2: Run the tests to verify RED**

```bash
uv run pytest tests/unit/tools/shell_transport/test_unix_pty.py -q
```

Expected on POSIX: import fails because `UnixPtyTransport` does not exist.

- [ ] **Step 3: Implement the Unix PTY backend**

Use `pty.openpty()`, attach the slave descriptor to child stdin/stdout/stderr, launch with
`start_new_session=True`, close the parent's slave descriptor immediately, and read the master with
`os.read(master_fd, 8192)`. Emit only `terminal` chunks. Handle Linux/macOS PTY EOF variants (`b""`
and `OSError` with `errno.EIO`) as normal EOF.

Implement resize with:

```python
window = struct.pack("HHHH", rows, columns, 0, 0)
fcntl.ioctl(master_fd, termios.TIOCSWINSZ, window)
```

Write with a loop around `os.write`, and reuse process-controller interruption/termination.

- [ ] **Step 4: Run PTY and manager integration tests**

```bash
uv run pytest tests/unit/tools/shell_transport/test_unix_pty.py tests/unit/tools/test_write_stdin.py tests/unit/tools/test_shell_session_manager.py -q
uv run ruff check src/mycli/tools/shell_transport/unix_pty.py tests/unit/tools/shell_transport/test_unix_pty.py
uv run mypy src/mycli/tools/shell_transport/unix_pty.py
```

Expected: all pass on Linux/macOS; test module skips cleanly on Windows.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/shell_transport/unix_pty.py tests/unit/tools/shell_transport/test_unix_pty.py
git commit -m "feat: run interactive shells through Unix PTY"
```

## Task 9: Implement Windows ConPTY Transport

**Files:**

- Modify: `pyproject.toml`
- Modify: `uv.lock`
- Create: `src/mycli/tools/shell_transport/windows_conpty.py`
- Create: `tests/unit/tools/shell_transport/test_windows_conpty.py`
- Modify: `.github/workflows/cross-platform.yml`
- [ ] **Step 1: Add the Windows-only dependency and lock it**

Add this project dependency:

```toml
"pywinpty>=3.0.2; sys_platform == 'win32'",
```

Run:

```bash
uv lock
uv sync --locked --dev
```

Expected: non-Windows resolves the marker without installing `pywinpty`; Windows CI installs a
Python 3.13-compatible wheel.

- [ ] **Step 2: Write ConPTY tests**

```python
import os

import pytest

from mycli.tools.shell_transport.base import ShellTransportRequest
from mycli.tools.shell_transport.windows_conpty import WindowsConPtyTransport


pytestmark = pytest.mark.skipif(os.name != "nt", reason="requires Windows ConPTY")


def test_conpty_accepts_input_and_reports_terminal_stream(tmp_path) -> None:
    request = ShellTransportRequest(
        argv=(
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "$v=[Console]::ReadLine(); [Console]::WriteLine('got:'+$v)",
        ),
        cwd=tmp_path,
        env=None,
        tty=True,
    )
    transport = WindowsConPtyTransport.start(request)
    transport.write(b"yes\r\n")

    output = b"".join(chunk.data for chunk in transport.read_chunks())

    assert b"got:yes" in output
    assert transport.wait() == 0


def test_conpty_resize_keeps_process_alive(tmp_path) -> None:
    request = ShellTransportRequest(
        argv=(
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "Start-Sleep -Seconds 30",
        ),
        cwd=tmp_path,
        env=None,
        tty=True,
    )
    transport = WindowsConPtyTransport.start(request)

    transport.resize(40, 120)

    assert transport.poll() is None
    transport.terminate()
```

- [ ] **Step 3: Run the test to verify RED on Windows**

```bash
uv run pytest tests/unit/tools/shell_transport/test_windows_conpty.py -q
```

Expected on Windows: import fails because `WindowsConPtyTransport` does not exist.

- [ ] **Step 4: Implement the lazy ConPTY adapter**

Import `PtyProcess` from `winpty` only inside `start()`. Convert the argv tuple with
`subprocess.list2cmdline`, start with cwd/env and initial dimensions, read ConPTY text in a dedicated
producer thread, encode published chunks as UTF-8 `terminal` bytes, and delegate `write`,
`setwinsize`, liveness, exit status, and forced close to the pywinpty process.

Translate import/start failures into
`ShellTransportUnavailable("conpty_unavailable", f"ConPTY is unavailable: {exc}")`. Preserve the
existing `taskkill` process-tree fallback when the ConPTY process does not terminate conclusively.

- [ ] **Step 5: Add a dedicated Windows CI smoke**

Add a `windows-conpty-smoke` job that runs only:

```yaml
- run: uv sync --locked --dev
- run: uv run pytest tests/unit/tools/shell_transport/test_windows_conpty.py tests/integration/test_cross_platform_shell.py -q
```

- [ ] **Step 6: Run local non-Windows checks**

```bash
uv run pytest tests/unit/tools/shell_transport/test_windows_conpty.py -q
uv run ruff check src/mycli/tools/shell_transport/windows_conpty.py tests/unit/tools/shell_transport/test_windows_conpty.py
uv run mypy src/mycli/tools/shell_transport/windows_conpty.py
uv lock --check
```

Expected: ConPTY tests skip outside Windows; static checks and lock check pass.

- [ ] **Step 7: Commit**

```bash
git add pyproject.toml uv.lock src/mycli/tools/shell_transport/windows_conpty.py tests/unit/tools/shell_transport/test_windows_conpty.py .github/workflows/cross-platform.yml
git commit -m "feat: support interactive Windows shells with ConPTY"
```

## Task 10: Preserve Hidden Legacy Calls

**Files:**

- Modify: `src/mycli/tools/bash.py`
- Modify: `src/mycli/tools/shell_output.py`
- Modify: `src/mycli/tools/bash_output.py`
- Modify: `src/mycli/tools/kill_shell.py`
- Modify: `tests/unit/tools/test_run_shell.py`
- Modify: `tests/unit/tools/test_bash_output.py`
- Modify: `tests/unit/test_kill_shell.py`
- Modify: `tests/unit/tools/test_tool_registry.py`
- [ ] **Step 1: Add compatibility regression tests**

```python
def test_legacy_background_true_returns_immediately(tmp_path) -> None:
    tool = BashTool(tmp_path)

    result = tool.execute({"command": "sleep 30", "run_in_background": True})

    try:
        assert result.success is True
        assert result.raw_payload["process_state"] == "running_background"
    finally:
        KillShellTool().execute({"shell_id": result.raw_payload["shell_id"]})


def test_legacy_background_false_waits_for_completion(tmp_path) -> None:
    tool = BashTool(tmp_path)

    result = tool.execute({"command": "printf done", "run_in_background": False})

    assert result.raw_payload["terminal_state"] == "completed"
    assert result.raw_payload["output"] == "done"


def test_shell_output_alias_performs_immediate_poll(tmp_path) -> None:
    started = BashTool(tmp_path).execute({"command": "sleep 30", "run_in_background": True})

    try:
        result = ShellOutputTool().execute({"shell_id": started.raw_payload["shell_id"]})
        assert result.success is True
    finally:
        KillShellTool().execute({"shell_id": started.raw_payload["shell_id"]})
```

- [ ] **Step 2: Run compatibility tests**

```bash
uv run pytest tests/unit/tools/test_run_shell.py tests/unit/tools/test_bash_output.py tests/unit/test_kill_shell.py tests/unit/tools/test_tool_registry.py -q
```

Expected: any regression from the new default contract fails here.

- [ ] **Step 3: Complete hidden adapters**

Ensure the old tools remain registered and executable but absent from model exposure. Preserve old
argument aliases (`bash_id`, `shell_id`) and old timeout capping. `ShellOutputTool` calls the legacy
cursor path without consuming the new model cursor. `KillShellTool` calls manager termination and
refreshes observed state before reporting success.

- [ ] **Step 4: Run compatibility and provider replay tests**

```bash
uv run pytest tests/unit/tools/test_run_shell.py tests/unit/tools/test_bash_output.py tests/unit/test_kill_shell.py tests/unit/tools/test_tool_registry.py tests/unit/application/test_agent_runtime.py -k "legacy or provider_replay" -q
uv run ruff check src/mycli/tools/bash.py src/mycli/tools/shell_output.py src/mycli/tools/bash_output.py src/mycli/tools/kill_shell.py
uv run mypy src/mycli/tools/bash.py src/mycli/tools/shell_output.py src/mycli/tools/bash_output.py src/mycli/tools/kill_shell.py
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/bash.py src/mycli/tools/shell_output.py src/mycli/tools/bash_output.py src/mycli/tools/kill_shell.py tests/unit/tools tests/unit/test_kill_shell.py
git commit -m "fix: preserve legacy shell tool compatibility"
```

## Task 11: Carry Yield And Transport State Through Lifecycle Events And TUI

**Files:**

- Modify: `src/mycli/domain/runtime/shell_lifecycle.py`
- Modify: `src/mycli/tools/shell_session_manager.py`
- Modify: `tests/unit/tools/test_shell_session_manager.py`
- Modify: `tui/mycli-shell/src/model.ts`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Modify: `tui/mycli-shell/src/components/bash-execution.ts`
- Modify: `tui/mycli-shell/test/runtime-state.test.ts`
- Modify: `tui/mycli-shell/test/shell-app.test.ts`
- [ ] **Step 1: Write failing lifecycle projection tests**

```typescript
test("WriteStdin poll merges into yielded Shell without a second card", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "shell.started", {
		shell_id: "shell-1",
		call_id: "call-shell",
		command_preview: "pytest -q",
		background: false,
		process_state: "running_foreground",
		transport: "pipe",
		tty: false,
	});
	state = reduceRuntimeEvent(state, "shell.list.updated", {
		shell_id: "shell-1",
		background: true,
		yielded: true,
		process_state: "running_background",
		active_background_count: 1,
	});
	state = reduceRuntimeEvent(state, "tool.complete", {
		name: "WriteStdin",
		call_id: "call-poll",
		raw_payload: { shell_id: "shell-1", output: "50% complete" },
	});

	const shell = projectRuntimeState(state);
	const bashBlocks = shell.transcript?.filter((block) => block.kind === "bash") ?? [];

	assert.equal(bashBlocks.length, 1);
	assert.equal(bashBlocks[0]?.bash.background, true);
	assert.match(bashBlocks[0]?.bash.outputPreview ?? "", /50% complete/);
});
```

Add a rendering test asserting yielded/background sessions omit `esc to interrupt`, while the same
card before yield includes it.

- [ ] **Step 2: Run Node tests to verify RED**

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern="WriteStdin|yielded"
```

Expected: adapter test fails because `WriteStdin` is not treated as Shell continuation and yielded
metadata is absent.

- [ ] **Step 3: Extend lifecycle payloads**

Add `transport`, `tty`, and `yielded` to `ShellLifecycleEvent` and `to_tui_payload()`. Emit a
`shell.list.updated` event at the exact foreground-to-background transition. Keep sequence numbers
strictly monotonic and final output before completion.

- [ ] **Step 4: Merge WriteStdin into the original Shell block**

Extend `isShellOutputLifecycle()` to accept normalized `writestdin`. Resolve its `session_id` or
`shell_id` from raw payload/display metrics, remove the temporary polling item, and merge output,
terminal state, exit code, transport, tty, background, and yielded state into the original Shell
metadata. Never persist or display `chars`.

- [ ] **Step 5: Run backend and Node TUI suites**

```bash
uv run pytest tests/unit/tools/test_shell_session_manager.py tests/unit/cli/node_tui/test_gateway.py -q
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/domain/runtime/shell_lifecycle.py src/mycli/tools/shell_session_manager.py tests/unit/tools/test_shell_session_manager.py tui/mycli-shell/src/model.ts tui/mycli-shell/src/adapters/runtime-state.ts tui/mycli-shell/src/components/bash-execution.ts tui/mycli-shell/test/runtime-state.test.ts tui/mycli-shell/test/shell-app.test.ts
git commit -m "feat: render yielded shell sessions in one TUI block"
```

## Task 12: Add End-To-End Cross-Platform Coverage

**Files:**

- Modify: `tests/integration/test_cross_platform_shell.py`
- Modify: `.github/workflows/cross-platform.yml`
- Modify: `docs/superpowers/specs/README.md`
- Modify: `docs/superpowers/plans/README.md`
- [ ] **Step 1: Add integration scenarios**

Parameterize active shell profiles and add these end-to-end assertions:

```python
def test_pipe_streams_partial_output_before_newline(shell_case, tmp_path) -> None:
    tool = ShellTool(tmp_path)
    events = []
    tool.configure_shell_lifecycle(events.append)

    result = tool.execute(
        {
            "command": shell_case.partial_then_sleep,
            "yield_time_ms": 250,
            "tty": False,
        }
    )

    try:
        assert result.raw_payload["process_state"] == "running_background"
        assert "ready" in result.raw_payload["output"]
        assert any(event.kind == "shell.output" and "ready" in event.output_delta for event in events)
    finally:
        KillShellTool().execute({"shell_id": result.raw_payload["shell_id"]})


def test_native_terminal_round_trip(shell_case, tmp_path) -> None:
    shell = ShellTool(tmp_path)
    started = shell.execute({"command": shell_case.prompt, "yield_time_ms": 250, "tty": True})
    writer = WriteStdinTool()

    result = writer.execute(
        {
            "session_id": started.raw_payload["shell_id"],
            "chars": shell_case.input_text,
            "yield_time_ms": 2000,
        }
    )

    assert result.raw_payload["terminal_state"] == "completed"
    assert shell_case.expected_response in result.raw_payload["output"]
```

Use profile-specific command strings for POSIX, PowerShell Core/Desktop, and CMD. Use synchronization
through expected output and manager conditions; do not add fixed multi-second sleeps.

- [ ] **Step 2: Run the integration test locally**

```bash
uv run pytest tests/integration/test_cross_platform_shell.py -q
```

Expected: the current platform's pipe and native-terminal scenarios pass; unavailable profile lanes
skip with an explicit reason.

- [ ] **Step 3: Run the full Python quality gate**

```bash
uv run pytest -q
uv run ruff check .
uv run mypy src/mycli
```

Expected: all pass.

- [ ] **Step 4: Run the full Node quality gate**

```bash
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
```

Expected: all pass.

- [ ] **Step 5: Verify repository and commit history**

```bash
git diff --check
git status --short
git log --oneline -12
```

Expected: only the pre-existing `.codex/config.toml` change remains unstaged; implementation files
are committed in the task commits above.

- [ ] **Step 6: Update spec/plan indexes and commit**

Add links for the 2026-07-17 design and implementation plan to their README indexes, then run:

```bash
git add tests/integration/test_cross_platform_shell.py .github/workflows/cross-platform.yml docs/superpowers/specs/README.md docs/superpowers/plans/README.md
git commit -m "test: verify unified shell runtime across platforms"
```

## Final Verification

- [ ] Confirm fresh model tool schemas contain `Shell` and `WriteStdin`, not `ShellOutput`,
  `BashOutput`, or `KillShell`.
- [ ] Confirm a flushed partial line reaches `shell.output` before process exit under `tty=false`.
- [ ] Confirm a command still running after `yield-time_ms` keeps one shell ID and one TUI block.
- [ ] Confirm empty `WriteStdin` polling does not add a TUI tool block.
- [ ] Confirm non-empty `WriteStdin` works on Unix PTY and Windows ConPTY.
- [ ] Confirm legacy calls and old resume history still pass regression tests.
- [ ] Confirm output budgets, omission markers, timeout, owner isolation, and cleanup behavior.
- [ ] Confirm full Python and Node test/type/lint gates pass.
