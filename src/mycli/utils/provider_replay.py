from __future__ import annotations

import hashlib
import json

RESPONSES_ISSUER = "openai_responses"
RESPONSES_PRIVATE_KEYS = frozenset(
    {
        "provider_state",
        "codex_reasoning_items",
        "codex_message_items",
        "reasoning",
        "responses",
    }
)
ANTHROPIC_PRIVATE_KEYS = frozenset(
    {
        "anthropic",
        "cache_control",
        "thinking",
        "signature",
    }
)
WIRE_PRIVATE_KEYS = frozenset(
    {
        "metadata",
        "provider_request_policy",
        "cache_control",
        "provider_state",
    }
)


def deterministic_provider_id(prefix: str, payload: object) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:24]
    return f"{prefix}_{digest}"


def sanitize_provider_private(value: object) -> object:
    if isinstance(value, dict):
        sanitized: dict[str, object] = {}
        for raw_key, raw_value in value.items():
            key = str(raw_key)
            if _private_wire_key(key):
                continue
            sanitized_value = sanitize_provider_private(raw_value)
            sanitized[key] = sanitized_value
        return sanitized
    if isinstance(value, list):
        return [sanitize_provider_private(item) for item in value]
    if isinstance(value, tuple):
        return [sanitize_provider_private(item) for item in value]
    return value


def responses_replay_items(provider_state: object) -> tuple[dict[str, object], ...]:
    if not isinstance(provider_state, dict):
        return ()
    items: list[dict[str, object]] = []
    items.extend(
        _same_issuer_items(
            provider_state.get("codex_reasoning_items"),
            expected_type="reasoning",
            fallback_prefix="rs",
            allowed_keys={
                "id",
                "type",
                "encrypted_content",
                "summary",
                "status",
            },
        )
    )
    items.extend(
        _same_issuer_items(
            provider_state.get("codex_message_items"),
            expected_type="message",
            fallback_prefix="msg",
            allowed_keys={
                "id",
                "type",
                "role",
                "content",
                "status",
            },
        )
    )
    return tuple(items)


def _same_issuer_items(
    value: object,
    *,
    expected_type: str,
    fallback_prefix: str,
    allowed_keys: set[str],
) -> tuple[dict[str, object], ...]:
    if not isinstance(value, list):
        return ()
    items: list[dict[str, object]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        if item.get("type") != expected_type:
            continue
        issuer = item.get("_issuer_kind")
        if isinstance(issuer, str) and issuer and issuer != RESPONSES_ISSUER:
            continue
        sanitized = {
            key: sanitize_provider_private(raw_value)
            for key, raw_value in item.items()
            if key in allowed_keys
        }
        item_id = sanitized.get("id")
        if not isinstance(item_id, str) or not item_id:
            sanitized["id"] = deterministic_provider_id(fallback_prefix, sanitized)
        if sanitized:
            items.append(sanitized)
    return tuple(items)


def _private_wire_key(key: str) -> bool:
    if key.startswith("_"):
        return True
    return (
        key in WIRE_PRIVATE_KEYS
        or key in RESPONSES_PRIVATE_KEYS
        or key in ANTHROPIC_PRIVATE_KEYS
    )


__all__ = [
    "RESPONSES_ISSUER",
    "deterministic_provider_id",
    "responses_replay_items",
    "sanitize_provider_private",
]
