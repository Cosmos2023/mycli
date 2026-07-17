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
        if self._exited.is_set():
            return
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
        if not self._exited.wait(timeout=2):
            return -1
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
