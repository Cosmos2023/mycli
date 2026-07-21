from __future__ import annotations

from collections import deque
from threading import Lock

from mycli.domain.runtime import (
    ActiveTurnNotSteerableError,
    MailboxAcceptance,
    NoActiveTurnError,
    TurnIdMismatchError,
    UserMessageIdConflictError,
    UserMessageInput,
)


class ActiveTurnMailbox:
    def __init__(self) -> None:
        self._lock = Lock()
        self._turn_id: str | None = None
        self._turn_kind = "regular"
        self._steerable = False
        self._pending: deque[UserMessageInput] = deque()
        self._accepted: dict[str, UserMessageInput] = {}

    def begin(
        self,
        turn_id: str,
        *,
        steerable: bool,
        turn_kind: str = "regular",
    ) -> None:
        normalized_turn_id = turn_id.strip()
        normalized_turn_kind = turn_kind.strip()
        if not normalized_turn_id:
            raise ValueError("turn_id must be non-empty")
        if not normalized_turn_kind:
            raise ValueError("turn_kind must be non-empty")
        with self._lock:
            if self._turn_id == normalized_turn_id:
                if (
                    self._steerable != steerable
                    or self._turn_kind != normalized_turn_kind
                ):
                    raise RuntimeError(
                        f"active turn {normalized_turn_id} mailbox configuration changed"
                    )
                return
            if self._turn_id is not None:
                raise RuntimeError(f"active turn {self._turn_id} mailbox is still open")
            self._turn_id = normalized_turn_id
            self._turn_kind = normalized_turn_kind
            self._steerable = steerable
            self._pending.clear()
            self._accepted.clear()

    def accept(
        self,
        expected_turn_id: str,
        item: UserMessageInput,
    ) -> MailboxAcceptance:
        with self._lock:
            turn_id = self._require_active_turn(expected_turn_id)
            if not self._steerable:
                raise ActiveTurnNotSteerableError(turn_id, self._turn_kind)
            if item.target_turn_id != expected_turn_id:
                raise TurnIdMismatchError(
                    item.target_turn_id or expected_turn_id,
                    turn_id,
                )
            existing = self._accepted.get(item.client_user_message_id)
            if existing is not None:
                if existing != item:
                    raise UserMessageIdConflictError(item.client_user_message_id)
                return MailboxAcceptance.DUPLICATE
            self._accepted[item.client_user_message_id] = item
            self._pending.append(item)
            return MailboxAcceptance.ACCEPTED

    def has_pending(self, turn_id: str) -> bool:
        with self._lock:
            self._require_active_turn(turn_id)
            return bool(self._pending)

    def drain(self, turn_id: str) -> tuple[UserMessageInput, ...]:
        with self._lock:
            self._require_active_turn(turn_id)
            pending = tuple(self._pending)
            self._pending.clear()
            return pending

    def close_and_drain(self, turn_id: str) -> tuple[UserMessageInput, ...]:
        with self._lock:
            self._require_active_turn(turn_id)
            pending = tuple(self._pending)
            self._turn_id = None
            self._turn_kind = "regular"
            self._steerable = False
            self._pending.clear()
            self._accepted.clear()
            return pending

    def active_turn_id(self) -> str | None:
        with self._lock:
            return self._turn_id

    def _require_active_turn(self, expected_turn_id: str) -> str:
        if self._turn_id is None:
            raise NoActiveTurnError()
        if self._turn_id != expected_turn_id:
            raise TurnIdMismatchError(expected_turn_id, self._turn_id)
        return self._turn_id


__all__ = ["ActiveTurnMailbox"]
