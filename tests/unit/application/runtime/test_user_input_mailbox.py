from __future__ import annotations

import pytest

from mycli.application.runtime.user_input_mailbox import ActiveTurnMailbox
from mycli.domain.runtime import (
    ActiveTurnNotSteerableError,
    MailboxAcceptance,
    NoActiveTurnError,
    TurnIdMismatchError,
    UserMessageIdConflictError,
    UserMessageInput,
)


def _steer(
    message_id: str,
    text: str,
    turn_id: str = "turn-1",
) -> UserMessageInput:
    return UserMessageInput(
        client_user_message_id=message_id,
        text=text,
        source="steer",
        target_turn_id=turn_id,
    )


def test_mailbox_accepts_duplicate_identity_once() -> None:
    mailbox = ActiveTurnMailbox()
    mailbox.begin("turn-1", steerable=True)
    item = _steer("client-1", "inspect")

    assert mailbox.accept("turn-1", item) is MailboxAcceptance.ACCEPTED
    assert mailbox.accept("turn-1", item) is MailboxAcceptance.DUPLICATE
    assert mailbox.drain("turn-1") == (item,)
    assert mailbox.drain("turn-1") == ()


def test_mailbox_rejects_conflicting_duplicate_identity() -> None:
    mailbox = ActiveTurnMailbox()
    mailbox.begin("turn-1", steerable=True)
    mailbox.accept("turn-1", _steer("client-1", "inspect"))

    with pytest.raises(UserMessageIdConflictError, match="client-1"):
        mailbox.accept("turn-1", _steer("client-1", "different"))


def test_mailbox_drains_multiple_inputs_in_acceptance_order() -> None:
    mailbox = ActiveTurnMailbox()
    mailbox.begin("turn-1", steerable=True)
    first = _steer("client-1", "first")
    second = _steer("client-2", "second")

    mailbox.accept("turn-1", first)
    mailbox.accept("turn-1", second)

    assert mailbox.has_pending("turn-1") is True
    assert mailbox.drain("turn-1") == (first, second)
    assert mailbox.has_pending("turn-1") is False


def test_mailbox_reports_actual_turn_on_mismatch() -> None:
    mailbox = ActiveTurnMailbox()
    mailbox.begin("turn-actual", steerable=True)

    with pytest.raises(TurnIdMismatchError) as raised:
        mailbox.accept(
            "turn-stale",
            _steer("client-1", "inspect", "turn-stale"),
        )

    assert raised.value.expected_turn_id == "turn-stale"
    assert raised.value.actual_turn_id == "turn-actual"


def test_mailbox_rejects_non_steerable_turn_with_kind() -> None:
    mailbox = ActiveTurnMailbox()
    mailbox.begin("turn-1", steerable=False, turn_kind="review")

    with pytest.raises(ActiveTurnNotSteerableError) as raised:
        mailbox.accept("turn-1", _steer("client-1", "inspect"))

    assert raised.value.turn_id == "turn-1"
    assert raised.value.turn_kind == "review"


def test_mailbox_close_returns_leftovers_and_rejects_later_steers() -> None:
    mailbox = ActiveTurnMailbox()
    mailbox.begin("turn-1", steerable=True)
    item = _steer("client-1", "inspect")
    mailbox.accept("turn-1", item)

    assert mailbox.close_and_drain("turn-1") == (item,)
    with pytest.raises(NoActiveTurnError, match="no active turn"):
        mailbox.accept("turn-1", item)


def test_mailbox_begin_is_idempotent_for_the_same_turn() -> None:
    mailbox = ActiveTurnMailbox()

    mailbox.begin("turn-1", steerable=True)
    mailbox.begin("turn-1", steerable=True)

    assert mailbox.active_turn_id() == "turn-1"


def test_mailbox_rejects_replacing_an_active_turn() -> None:
    mailbox = ActiveTurnMailbox()
    mailbox.begin("turn-1", steerable=True)

    with pytest.raises(RuntimeError, match="turn-1"):
        mailbox.begin("turn-2", steerable=True)


def test_mailbox_can_begin_a_new_turn_after_close() -> None:
    mailbox = ActiveTurnMailbox()
    mailbox.begin("turn-1", steerable=True)
    mailbox.close_and_drain("turn-1")

    mailbox.begin("turn-2", steerable=True)

    assert mailbox.active_turn_id() == "turn-2"
