from __future__ import annotations

import json

from openai import APIStatusError, OpenAI

from mycli.llms.clients.user_agent import model_request_headers

DEFAULT_OPENAI_SDK_TIMEOUT_SECONDS = 60.0


def build_openai_sdk_client(*, api_key: str, base_url: str) -> OpenAI:
    return OpenAI(
        api_key=api_key,
        base_url=base_url,
        default_headers=model_request_headers(),
        timeout=DEFAULT_OPENAI_SDK_TIMEOUT_SECONDS,
        max_retries=0,
    )


def sdk_payload_to_dict(payload: object) -> dict[str, object]:
    if isinstance(payload, dict):
        return dict(payload)
    for attr in ("to_dict", "model_dump", "dict"):
        serializer = getattr(payload, attr, None)
        if callable(serializer):
            serialized = serializer()
            if isinstance(serialized, dict):
                return dict(serialized)
    raise TypeError("OpenAI SDK payload must serialize to a dictionary.")


def api_status_error_detail(exc: APIStatusError) -> str:
    body = exc.body
    if isinstance(body, dict):
        error_payload = body.get("error")
        if isinstance(error_payload, dict):
            message = error_payload.get("message")
            if isinstance(message, str) and message.strip():
                return message
        message = body.get("message")
        if isinstance(message, str) and message.strip():
            return message
        return json.dumps(body, ensure_ascii=False)
    if isinstance(body, str) and body.strip():
        return body
    return str(exc)
