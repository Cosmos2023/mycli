from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

from mycli.tools.process_controller import ProcessTerminationOutcome


ShellStream = Literal["stdout", "stderr", "terminal"]
ShellTransportKind = Literal["pipe", "unix_pty", "windows_conpty"]


@dataclass(frozen=True, slots=True)
class ShellOutputChunk:
    sequence: int
    stream: ShellStream
    data: bytes

    def __post_init__(self) -> None:
        if self.sequence <= 0:
            raise ValueError("Shell output chunk sequence must be positive.")
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

    def __post_init__(self) -> None:
        if not self.argv or not self.argv[0]:
            raise ValueError("Shell transport request requires an executable.")
        if self.rows <= 0 or self.columns <= 0:
            raise ValueError("Shell terminal dimensions must be positive.")


class ShellTransportUnavailable(RuntimeError):
    def __init__(self, error_kind: str, message: str) -> None:
        super().__init__(message)
        self.error_kind = error_kind


class ShellProcessTransport(Protocol):
    kind: ShellTransportKind
    tty: bool

    def read_chunks(self) -> Iterator[ShellOutputChunk]: ...

    def write(self, data: bytes) -> None: ...

    def poll(self) -> int | None: ...

    def wait(self) -> int: ...

    def interrupt(self) -> ProcessTerminationOutcome: ...

    def terminate(self) -> ProcessTerminationOutcome: ...

    def resize(self, rows: int, columns: int) -> None: ...

    def close(self) -> None: ...

    def compatibility_process(self) -> object | None: ...


__all__ = [
    "ShellOutputChunk",
    "ShellProcessTransport",
    "ShellStream",
    "ShellTransportKind",
    "ShellTransportRequest",
    "ShellTransportUnavailable",
]
