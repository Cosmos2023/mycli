from __future__ import annotations

from collections.abc import Iterator
import contextlib
from importlib import import_module
import os
from queue import Queue
import subprocess
from threading import Thread
import time
from typing import Protocol, cast

from mycli.tools.process_controller import (
    ProcessTerminationOutcome,
    terminate_process_tree,
)
from mycli.tools.shell_transport.base import (
    ShellOutputChunk,
    ShellTransportKind,
    ShellTransportRequest,
    ShellTransportUnavailable,
)


class _PtyProcess(Protocol):
    pid: int
    exitstatus: int | None

    def read(self, size: int = 1024) -> str: ...

    def write(self, text: str) -> int: ...

    def isalive(self) -> bool: ...

    def wait(self) -> int: ...

    def sendintr(self) -> object: ...

    def terminate(self, force: bool = False) -> object: ...

    def setwinsize(self, rows: int, columns: int) -> None: ...

    def close(self, force: bool = False) -> None: ...


class _PtyProcessFactory(Protocol):
    def __call__(
        self,
        argv: list[str],
        *,
        cwd: str,
        env: dict[str, str] | None,
        dimensions: tuple[int, int],
        backend: object,
    ) -> _PtyProcess: ...


class WindowsConPtyTransport:
    kind: ShellTransportKind = "windows_conpty"
    tty = True

    def __init__(self, process: _PtyProcess) -> None:
        self._process = process
        self._queue: Queue[ShellOutputChunk | None] = Queue()
        self._sequence = 0
        self._closed = False
        self._reader = Thread(
            target=self._drain_output,
            daemon=True,
            name="mycli-shell-conpty",
        )
        self._reader.start()

    @classmethod
    def start(
        cls,
        request: ShellTransportRequest,
        *,
        process_factory: _PtyProcessFactory | None = None,
        conpty_backend: object | None = None,
    ) -> WindowsConPtyTransport:
        if process_factory is None:
            if os.name != "nt":
                raise ShellTransportUnavailable(
                    "conpty_unavailable",
                    "ConPTY is available only on Windows.",
                )
            try:
                backend_type = getattr(import_module("winpty.enums"), "Backend")
                process_type = getattr(import_module("winpty.ptyprocess"), "PtyProcess")
            except (ImportError, AttributeError) as exc:
                raise ShellTransportUnavailable(
                    "conpty_unavailable",
                    f"ConPTY is unavailable: {exc}",
                ) from exc
            process_factory = cast(_PtyProcessFactory, process_type.spawn)
            conpty_backend = backend_type.ConPTY

        try:
            process = process_factory(
                list(request.argv),
                cwd=str(request.cwd),
                env=request.env,
                dimensions=(request.rows, request.columns),
                backend=conpty_backend,
            )
        except Exception as exc:
            raise ShellTransportUnavailable(
                "conpty_unavailable",
                f"ConPTY is unavailable: {exc}",
            ) from exc
        return cls(process)

    def read_chunks(self) -> Iterator[ShellOutputChunk]:
        while True:
            chunk = self._queue.get()
            if chunk is None:
                return
            yield chunk

    def write(self, data: bytes) -> None:
        if self._closed or not self._process.isalive():
            raise ShellTransportUnavailable("stdin_closed", "Shell ConPTY is closed.")
        try:
            self._process.write(data.decode("utf-8"))
        except (EOFError, OSError, UnicodeError) as exc:
            raise ShellTransportUnavailable("stdin_closed", str(exc)) from exc

    def poll(self) -> int | None:
        if self._process.isalive():
            return None
        return self._exit_status()

    def wait(self) -> int:
        status = self._process.wait()
        return status if isinstance(status, int) else self._exit_status()

    def interrupt(self) -> ProcessTerminationOutcome:
        return terminate_process_tree(
            _ManagedConPtyProcess(self._process),
            prefer_interrupt=True,
            platform_name="win32",
        )

    def terminate(self) -> ProcessTerminationOutcome:
        return terminate_process_tree(
            _ManagedConPtyProcess(self._process),
            prefer_interrupt=False,
            platform_name="win32",
        )

    def resize(self, rows: int, columns: int) -> None:
        if rows <= 0 or columns <= 0:
            raise ShellTransportUnavailable(
                "shell_resize_failed",
                "Shell terminal dimensions must be positive.",
            )
        try:
            self._process.setwinsize(rows, columns)
        except (EOFError, OSError) as exc:
            raise ShellTransportUnavailable("shell_resize_failed", str(exc)) from exc

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with contextlib.suppress(Exception):
            self._process.close(force=True)
        self._reader.join(timeout=1)

    def compatibility_process(self) -> object | None:
        return None

    def _drain_output(self) -> None:
        try:
            while not self._closed:
                try:
                    text = self._process.read(8192)
                except EOFError:
                    return
                if not text:
                    if not self._process.isalive():
                        return
                    time.sleep(0.001)
                    continue
                self._sequence += 1
                self._queue.put(
                    ShellOutputChunk(
                        sequence=self._sequence,
                        stream="terminal",
                        data=text.encode("utf-8"),
                    )
                )
        except (OSError, UnicodeError):
            return
        finally:
            self._queue.put(None)

    def _exit_status(self) -> int:
        status = self._process.exitstatus
        return status if isinstance(status, int) else -1


class _ManagedConPtyProcess:
    def __init__(self, process: _PtyProcess) -> None:
        self._process = process
        self.pid = process.pid

    def poll(self) -> int | None:
        if self._process.isalive():
            return None
        status = self._process.exitstatus
        return status if isinstance(status, int) else -1

    def wait(self, timeout: float | None = None) -> int:
        if timeout is None:
            return self._process.wait()
        deadline = time.monotonic() + timeout
        while self._process.isalive() and time.monotonic() < deadline:
            time.sleep(0.01)
        if self._process.isalive():
            raise subprocess.TimeoutExpired("ConPTY", timeout)
        status = self._process.exitstatus
        return status if isinstance(status, int) else -1

    def send_signal(self, value: int) -> None:
        del value
        self._process.sendintr()

    def terminate(self) -> None:
        self._process.terminate(force=True)


__all__ = ["WindowsConPtyTransport"]
