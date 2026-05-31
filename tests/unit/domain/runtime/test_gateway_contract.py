from __future__ import annotations

from mycli.domain.runtime.gateway_contract import (
    GATEWAY_ERROR_CODES,
    gateway_event_payload_schemas,
)


def test_gateway_error_schema_exposes_stable_error_code_taxonomy() -> None:
    schema = gateway_event_payload_schemas()["gateway.error"]

    assert schema["required"] == ["code", "message"]
    assert schema["properties"]["code"]["enum"] == list(GATEWAY_ERROR_CODES)
    assert schema["properties"]["code"]["enum"] == [
        "internal_error",
        "invalid_params",
        "method_not_found",
        "turn_in_progress",
        "decision_not_pending",
        "clarification_not_pending",
    ]
