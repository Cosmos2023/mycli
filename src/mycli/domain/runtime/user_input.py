from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal

UserMessageSource = Literal["submit", "steer"]


class MailboxAcceptance(StrEnum):
    ACCEPTED = "accepted"
    DUPLICATE = "duplicate"


@dataclass(frozen=True, slots=True)
class UserMessageInput:
    client_user_message_id: str
    text: str
    image_paths: tuple[str, ...] = ()
    source: UserMessageSource = "submit"
    target_turn_id: str | None = None

    def __post_init__(self) -> None:
        message_id = self.client_user_message_id.strip()
        text = self.text.strip()
        if not message_id:
            raise ValueError("client user message id must be non-empty")
        if not text:
            raise ValueError("user message text must be non-empty")
        if self.source not in {"submit", "steer"}:
            raise ValueError("invalid user message source")

        target_turn_id = self.target_turn_id
        if self.source == "steer":
            if not isinstance(target_turn_id, str) or not target_turn_id.strip():
                raise ValueError("steer input requires target_turn_id")
            target_turn_id = target_turn_id.strip()
        elif target_turn_id is not None:
            raise ValueError("submit input cannot set target_turn_id")

        if not isinstance(self.image_paths, tuple) or not all(
            isinstance(path, str) and path for path in self.image_paths
        ):
            raise ValueError("image_paths must contain non-empty strings")

        object.__setattr__(self, "client_user_message_id", message_id)
        object.__setattr__(self, "text", text)
        object.__setattr__(self, "target_turn_id", target_turn_id)
        object.__setattr__(
            self,
            "image_paths",
            tuple(dict.fromkeys(self.image_paths)),
        )


class NoActiveTurnError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("no active turn to steer")


class TurnIdMismatchError(RuntimeError):
    def __init__(self, expected_turn_id: str, actual_turn_id: str) -> None:
        self.expected_turn_id = expected_turn_id
        self.actual_turn_id = actual_turn_id
        super().__init__(
            f"expected active turn {expected_turn_id} but found {actual_turn_id}"
        )


class ActiveTurnNotSteerableError(RuntimeError):
    def __init__(self, turn_id: str, turn_kind: str) -> None:
        self.turn_id = turn_id
        self.turn_kind = turn_kind
        super().__init__(f"cannot steer {turn_kind} turn {turn_id}")


class UserMessageIdConflictError(RuntimeError):
    def __init__(self, client_user_message_id: str) -> None:
        self.client_user_message_id = client_user_message_id
        super().__init__(
            f"user message id has conflicting content: {client_user_message_id}"
        )


__all__ = [
    "ActiveTurnNotSteerableError",
    "MailboxAcceptance",
    "NoActiveTurnError",
    "TurnIdMismatchError",
    "UserMessageIdConflictError",
    "UserMessageInput",
    "UserMessageSource",
]
