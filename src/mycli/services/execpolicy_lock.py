from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
import importlib
import os
from pathlib import Path
from typing import BinaryIO, Protocol, cast

from mycli.config.file_permissions import harden_private_path


LockOperation = Callable[[BinaryIO], None]


class _WindowsLockModule(Protocol):
    LK_LOCK: int
    LK_UNLCK: int

    def locking(self, file_descriptor: int, mode: int, byte_count: int, /) -> None: ...


def _posix_lock(handle: BinaryIO) -> None:
    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)


def _posix_unlock(handle: BinaryIO) -> None:
    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _windows_lock(handle: BinaryIO) -> None:
    msvcrt = cast(_WindowsLockModule, importlib.import_module("msvcrt"))

    handle.seek(0, os.SEEK_END)
    if handle.tell() == 0:
        handle.write(b"\0")
        handle.flush()
    handle.seek(0)
    msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)


def _windows_unlock(handle: BinaryIO) -> None:
    msvcrt = cast(_WindowsLockModule, importlib.import_module("msvcrt"))

    handle.seek(0)
    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


@contextmanager
def execpolicy_file_lock(
    path: Path,
    *,
    os_name: str = os.name,
    posix_lock: LockOperation = _posix_lock,
    posix_unlock: LockOperation = _posix_unlock,
    windows_lock: LockOperation = _windows_lock,
    windows_unlock: LockOperation = _windows_unlock,
) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        harden_private_path(path, mode=0o600, os_name=os_name)
        acquire = windows_lock if os_name == "nt" else posix_lock
        release = windows_unlock if os_name == "nt" else posix_unlock
        acquire(handle)
        try:
            yield
        finally:
            release(handle)
