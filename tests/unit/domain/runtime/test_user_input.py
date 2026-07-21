from __future__ import annotations

import pytest

from mycli.domain.runtime import UserMessageInput


def test_user_message_input_normalizes_identity_text_target_and_images() -> None:
    item = UserMessageInput(
        client_user_message_id=" client-1 ",
        text=" inspect output ",
        image_paths=("/tmp/a.png", "/tmp/a.png", "/tmp/b.png"),
        source="steer",
        target_turn_id=" turn-1 ",
    )

    assert item.client_user_message_id == "client-1"
    assert item.text == "inspect output"
    assert item.image_paths == ("/tmp/a.png", "/tmp/b.png")
    assert item.target_turn_id == "turn-1"


@pytest.mark.parametrize(
    ("field", "value", "match"),
    [
        ("client_user_message_id", " ", "id"),
        ("text", " ", "text"),
        ("source", "runtime", "source"),
        ("target_turn_id", None, "target_turn_id"),
    ],
)
def test_user_message_input_rejects_invalid_steer_fields(
    field: str,
    value: object,
    match: str,
) -> None:
    kwargs: dict[str, object] = {
        "client_user_message_id": "client-1",
        "text": "inspect",
        "source": "steer",
        "target_turn_id": "turn-1",
    }
    kwargs[field] = value

    with pytest.raises(ValueError, match=match):
        UserMessageInput(**kwargs)  # type: ignore[arg-type]


def test_submit_input_rejects_a_target_turn() -> None:
    with pytest.raises(ValueError, match="target_turn_id"):
        UserMessageInput(
            client_user_message_id="client-1",
            text="inspect",
            source="submit",
            target_turn_id="turn-1",
        )


@pytest.mark.parametrize("images", [("",), ("/tmp/a.png", 3)])
def test_user_message_input_rejects_invalid_image_paths(images: tuple[object, ...]) -> None:
    with pytest.raises(ValueError, match="image_paths"):
        UserMessageInput(
            client_user_message_id="client-1",
            text="inspect",
            image_paths=images,  # type: ignore[arg-type]
        )
