from __future__ import annotations

from collections.abc import Iterator
import contextlib
import errno
import os
import subprocess
from threading import Lock

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


class UnixPtyTransport:
    kind: ShellTransportKind = "unix_pty"
    tty = True

    def __init__(self, process: subprocess.Popen[bytes], master_fd: int) -> None:
        self._process = process
        self._master_fd = master_fd
        self._sequence = 0
        self._closed = False
        self._close_lock = Lock()

    @classmethod
    def start(cls, request: ShellTransportRequest) -> UnixPtyTransport:
        if os.name != "posix":
            raise ShellTransportUnavailable(
                "pty_unavailable",
                "Unix PTY transport is available only on POSIX systems.",
            )

        import pty

        master_fd, slave_fd = pty.openpty()
        try:
            _resize_fd(master_fd, request.rows, request.columns)
            process = subprocess.Popen(
                request.argv,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                text=False,
                bufsize=0,
                cwd=request.cwd,
                env=request.env,
                start_new_session=True,
                close_fds=True,
            )
        except BaseException:
            os.close(master_fd)
            raise
        finally:
            os.close(slave_fd)
        return cls(process, master_fd)

    def read_chunks(self) -> Iterator[ShellOutputChunk]:
        while not self._closed:
            try:
                data = os.read(self._master_fd, 8192)
            except OSError as exc:
                if exc.errno in {errno.EIO, errno.EBADF}:
                    return
                raise
            if not data:
                return
            self._sequence += 1
            yield ShellOutputChunk(
                sequence=self._sequence,
                stream="terminal",
                data=data,
            )

    def write(self, data: bytes) -> None:
        if self._closed:
            raise ShellTransportUnavailable("stdin_closed", "Shell PTY is closed.")
        remaining = memoryview(data)
        try:
            while remaining:
                written = os.write(self._master_fd, remaining)
                remaining = remaining[written:]
        except OSError as exc:
            raise ShellTransportUnavailable("stdin_closed", str(exc)) from exc

    def poll(self) -> int | None:
        return self._process.poll()

    def wait(self) -> int:
        return self._process.wait()

    def interrupt(self) -> ProcessTerminationOutcome:
        return terminate_process_tree(self._process, prefer_interrupt=True)

    def terminate(self) -> ProcessTerminationOutcome:
        return terminate_process_tree(self._process, prefer_interrupt=False)

    def resize(self, rows: int, columns: int) -> None:
        if rows <= 0 or columns <= 0:
            raise ShellTransportUnavailable(
                "shell_resize_failed",
                "Shell terminal dimensions must be positive.",
            )
        try:
            _resize_fd(self._master_fd, rows, columns)
        except OSError as exc:
            raise ShellTransportUnavailable("shell_resize_failed", str(exc)) from exc

    def close(self) -> None:
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
            with contextlib.suppress(OSError):
                os.close(self._master_fd)

    def compatibility_process(self) -> object | None:
        return self._process


def _resize_fd(fd: int, rows: int, columns: int) -> None:
    import fcntl
    import struct
    import termios

    window = struct.pack("HHHH", rows, columns, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, window)


__all__ = ["UnixPtyTransport"]
