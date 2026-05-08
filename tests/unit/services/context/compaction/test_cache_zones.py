from __future__ import annotations

from mycli.domain.conversation import Conversation, Message
from mycli.services.context.compaction.cache_zones import CacheZones


def test_frozen_boundary_is_first_dynamic_message() -> None:
    conv = Conversation(
        session_id="test",
        messages=[
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            Message(
                role="assistant",
                content="tool defs",
                metadata={"cache_policy": "STATIC"},
            ),
            Message(role="user", content="hello", metadata={"cache_policy": "DYNAMIC"}),
        ],
    )
    zones = CacheZones.from_conversation(conv)
    assert zones.frozen_boundary == 2
    assert zones.fresh_start == 2


def test_frozen_boundary_when_no_dynamic_message() -> None:
    conv = Conversation(
        session_id="test",
        messages=[
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
        ],
    )
    zones = CacheZones.from_conversation(conv)
    assert zones.frozen_boundary == 1
    assert zones.fresh_start == 1


def test_dead_zone_does_not_exist() -> None:
    conv = Conversation(
        session_id="test",
        messages=[
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="turn1", metadata={"cache_policy": "DYNAMIC"}),
            Message(
                role="assistant",
                content="resp1",
                metadata={"cache_policy": "DYNAMIC"},
            ),
            Message(role="tool", content="result1", metadata={"cache_policy": "EPHEMERAL"}),
            Message(role="user", content="turn2", metadata={"cache_policy": "DYNAMIC"}),
        ],
    )
    zones = CacheZones.from_conversation(conv)
    assert zones.frozen_boundary == 1
    assert zones.fresh_start == 1
    assert len(conv.messages) - zones.fresh_start == 4


def test_validate_detects_boundary_change() -> None:
    previous = CacheZones(frozen_boundary=2, fresh_start=2)
    current = CacheZones(frozen_boundary=1, fresh_start=1)
    assert current.validate(previous) is False


def test_validate_detects_static_prefix_content_change() -> None:
    first = Conversation(
        session_id="test",
        messages=[
            Message(role="system", content="sys v1", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="hello", metadata={"cache_policy": "DYNAMIC"}),
        ],
    )
    second = Conversation(
        session_id="test",
        messages=[
            Message(role="system", content="sys v2", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="hello", metadata={"cache_policy": "DYNAMIC"}),
        ],
    )

    assert CacheZones.from_conversation(second).validate(CacheZones.from_conversation(first)) is False


def test_validate_accepts_same_boundary() -> None:
    conversation = Conversation(
        session_id="test",
        messages=[
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="hello", metadata={"cache_policy": "DYNAMIC"}),
        ],
    )
    previous = CacheZones.from_conversation(conversation)
    current = CacheZones.from_conversation(conversation)
    assert current.validate(previous) is True


def test_is_frozen_before_boundary() -> None:
    zones = CacheZones(frozen_boundary=2, fresh_start=2)
    assert zones.is_frozen(0) is True
    assert zones.is_frozen(1) is True
    assert zones.is_frozen(2) is False


def test_is_fresh_at_and_after_start() -> None:
    zones = CacheZones(frozen_boundary=2, fresh_start=3)
    assert zones.is_fresh(2) is False
    assert zones.is_fresh(3) is True
    assert zones.is_fresh(4) is True
