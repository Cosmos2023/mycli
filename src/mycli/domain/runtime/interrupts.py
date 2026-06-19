from __future__ import annotations

from dataclasses import dataclass, field
from threading import Event, Lock
from typing import Callable

InterruptCallback = Callable[[], None]


@dataclass(slots=True)
class RuntimeInterruptToken:
    """Cooperative cancellation token for a running agent turn."""

    source: str = "runtime"
    _event: Event = field(default_factory=Event)
    _lock: Lock = field(default_factory=Lock)
    _callbacks: list[InterruptCallback] = field(default_factory=list)
    _reason: str | None = None

    @property
    def interrupted(self) -> bool:
        return self._event.is_set()

    @property
    def reason(self) -> str | None:
        return self._reason

    def request(self, reason: str = "interrupt") -> None:
        callbacks: tuple[InterruptCallback, ...]
        with self._lock:
            self._reason = reason
            self._event.set()
            callbacks = tuple(self._callbacks)
            self._callbacks.clear()
        for callback in callbacks:
            try:
                callback()
            except Exception:
                continue

    def add_callback(self, callback: InterruptCallback) -> None:
        run_now = False
        with self._lock:
            if self.interrupted:
                run_now = True
            else:
                self._callbacks.append(callback)
        if run_now:
            try:
                callback()
            except Exception:
                return

    def raise_if_interrupted(self) -> None:
        if self.interrupted:
            raise KeyboardInterrupt()
