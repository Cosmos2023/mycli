from __future__ import annotations

from collections.abc import Iterator
import contextlib
from dataclasses import dataclass
from queue import Queue
import subprocess
from threading import Lock, Thread
from typing import IO, cast

from mycli.tools.process_controller import (
    ProcessTerminationOutcome,
    process_spawn_options,
    terminate_process_tree,
)
from mycli.tools.shell_transport.base import (
    ShellOutputChunk,
    ShellStream,
    ShellTransportKind,
    ShellTransportRequest,
    ShellTransportUnavailable,
)


@dataclass(frozen=True, slots=True)
class _StreamClosed:
    stream: ShellStream


class PipeTransport:
    kind: ShellTransportKind = "pipe"
    tty = False

    def __init__(self, process: subprocess.Popen[bytes]) -> None:
        self._process = process
        self._queue: Queue[ShellOutputChunk | _StreamClosed] = Queue()
        self._sequence = 0
        self._sequence_lock = Lock()
        self._closed = False
        assert process.stdout is not None
        assert process.stderr is not None
        self._reader_threads = (
            self._start_reader("stdout", process.stdout),
            self._start_reader("stderr", process.stderr),
        )

    @classmethod
    def start(cls, request: ShellTransportRequest) -> PipeTransport:
        spawn_options = process_spawn_options()
        process = subprocess.Popen(
            request.argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
            bufsize=0,
            cwd=request.cwd,
            env=request.env,
            creationflags=cast(int, spawn_options.get("creationflags", 0)),
            start_new_session=cast(bool, spawn_options.get("start_new_session", False)),
        )
        return cls(process)

    def read_chunks(self) -> Iterator[ShellOutputChunk]:
        closed_streams: set[ShellStream] = set()
        while len(closed_streams) < 2:
            item = self._queue.get()
            if isinstance(item, _StreamClosed):
                closed_streams.add(item.stream)
                continue
            yield item

    def write(self, data: bytes) -> None:
        del data
        raise ShellTransportUnavailable(
            "stdin_closed",
            "Shell stdin is closed; rerun Shell with tty=true to send input.",
        )

    def poll(self) -> int | None:
        return self._process.poll()

    def wait(self) -> int:
        return self._process.wait()

    def interrupt(self) -> ProcessTerminationOutcome:
        return terminate_process_tree(self._process, prefer_interrupt=True)

    def terminate(self) -> ProcessTerminationOutcome:
        return terminate_process_tree(self._process, prefer_interrupt=False)

    def resize(self, rows: int, columns: int) -> None:
        del rows, columns
        raise ShellTransportUnavailable(
            "shell_resize_failed",
            "Pipe sessions cannot be resized.",
        )

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for stream in (self._process.stdout, self._process.stderr):
            if stream is not None:
                with contextlib.suppress(OSError):
                    stream.close()
        for thread in self._reader_threads:
            thread.join(timeout=1)

    def compatibility_process(self) -> object | None:
        return self._process

    def _start_reader(self, stream: ShellStream, source: IO[bytes]) -> Thread:
        thread = Thread(
            target=self._drain,
            args=(stream, source),
            daemon=True,
            name=f"mycli-shell-{stream}",
        )
        thread.start()
        return thread

    def _drain(self, stream: ShellStream, source: IO[bytes]) -> None:
        try:
            while True:
                data = source.read(8192)
                if not data:
                    return
                with self._sequence_lock:
                    self._sequence += 1
                    sequence = self._sequence
                self._queue.put(
                    ShellOutputChunk(
                        sequence=sequence,
                        stream=stream,
                        data=data,
                    )
                )
        except OSError:
            return
        finally:
            self._queue.put(_StreamClosed(stream))


__all__ = ["PipeTransport"]
