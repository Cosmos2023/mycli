from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True, frozen=True)
class ResponsesOutputItem:
    provider_id: str | None
    item_type: str
    payload: dict[str, object]


@dataclass(slots=True, frozen=True)
class ResponsesStreamEnvelope:
    event_type: str
    payload: dict[str, object]


def parse_responses_output_item(item: dict[str, object]) -> ResponsesOutputItem:
    provider_id = item.get("id")
    return ResponsesOutputItem(
        provider_id=provider_id if isinstance(provider_id, str) else None,
        item_type=str(item.get("type", "")),
        payload=item,
    )


def parse_responses_stream_event(payload: dict[str, object]) -> ResponsesStreamEnvelope:
    return ResponsesStreamEnvelope(
        event_type=str(payload.get("type", "")),
        payload=payload,
    )
