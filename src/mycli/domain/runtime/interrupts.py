from __future__ import annotations

from dataclasses import dataclass, field
from threading import Event, Lock, Thread
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
    _rollback_user_input: bool = False

    @property
    def interrupted(self) -> bool:
        return self._event.is_set()

    @property
    def reason(self) -> str | None:
        return self._reason

    @property
    def rollback_user_input(self) -> bool:
        return self._rollback_user_input

    def request(
        self,
        reason: str = "interrupt",
        *,
        rollback_user_input: bool = False,
    ) -> None:
        callbacks = self._mark_interrupted(
            reason,
            rollback_user_input=rollback_user_input,
        )
        self._run_callbacks(callbacks)

    def request_nonblocking(
        self,
        reason: str = "interrupt",
        *,
        rollback_user_input: bool = False,
    ) -> None:
        callbacks = self._mark_interrupted(
            reason,
            rollback_user_input=rollback_user_input,
        )
        for index, callback in enumerate(callbacks, start=1):
            Thread(
                target=self._run_callback,
                args=(callback,),
                name=f"mycli-interrupt-cleanup-{self.source}-{index}",
                daemon=True,
            ).start()

    def _mark_interrupted(
        self,
        reason: str,
        *,
        rollback_user_input: bool,
    ) -> tuple[InterruptCallback, ...]:
        with self._lock:
            self._reason = reason
            self._rollback_user_input = (
                self._rollback_user_input or rollback_user_input
            )
            self._event.set()
            callbacks = tuple(self._callbacks)
            self._callbacks.clear()
        return callbacks

    @staticmethod
    def _run_callbacks(callbacks: tuple[InterruptCallback, ...]) -> None:
        for callback in callbacks:
            RuntimeInterruptToken._run_callback(callback)

    @staticmethod
    def _run_callback(callback: InterruptCallback) -> None:
        try:
            callback()
        except Exception:
            pass

    def add_callback(self, callback: InterruptCallback) -> InterruptCallback:
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
                pass

        def unregister() -> None:
            with self._lock:
                try:
                    self._callbacks.remove(callback)
                except ValueError:
                    pass

        return unregister

    def raise_if_interrupted(self) -> None:
        if self.interrupted:
            raise KeyboardInterrupt()

    def wait(self, timeout: float) -> bool:
        return self._event.wait(max(0.0, timeout))
