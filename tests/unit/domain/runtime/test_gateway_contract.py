from __future__ import annotations

from mycli.domain.runtime import DecisionAction
from mycli.domain.runtime.gateway_contract import (
    APPROVAL_DECISION_CHOICES,
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
        "incompatible_protocol",
    ]


def test_approval_respond_schema_exposes_stable_decision_choice_taxonomy() -> None:
    schema = gateway_event_payload_schemas()["approval.respond"]

    assert schema["required"] == ["decision_id", "choice"]
    assert schema["properties"]["choice"]["enum"] == list(APPROVAL_DECISION_CHOICES)
    assert schema["properties"]["choice"]["enum"] == [action.value for action in DecisionAction]
    assert schema["properties"]["choice"]["enum"] == [
        "approve_once",
        "reject",
        "allow_session",
    ]


def test_approval_request_options_schema_uses_decision_choice_taxonomy() -> None:
    schema = gateway_event_payload_schemas()["approval.request"]
    options = schema["properties"]["options"]

    assert options["type"] == "array"
    assert options["items"]["properties"]["choice"]["enum"] == list(APPROVAL_DECISION_CHOICES)


def test_status_changed_schema_exposes_runtime_snapshot_shape() -> None:
    schema = gateway_event_payload_schemas()["status.changed"]

    assert schema["required"] == [
        "session_id",
        "workspace",
        "model",
        "provider",
        "context_window",
        "pending_decision",
        "suspended_turn",
    ]
    assert sorted(schema["properties"]) == [
        "context_window",
        "model",
        "pending_decision",
        "provider",
        "session_id",
        "suspended_turn",
        "workspace",
    ]
    assert schema["properties"]["pending_decision"] == {"type": "boolean"}
    assert schema["properties"]["suspended_turn"] == {"type": "boolean"}
    assert sorted(schema["properties"]["context_window"]["properties"]) == [
        "max_tokens",
        "source",
        "used_tokens",
    ]
