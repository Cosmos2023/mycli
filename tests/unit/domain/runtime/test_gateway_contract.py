from __future__ import annotations

from mycli.domain.runtime import DecisionAction
from mycli.domain.runtime.gateway_contract import (
    APPROVAL_DECISION_CHOICES,
    GATEWAY_ERROR_CODES,
    TERMINAL_TURN_STATES,
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
        "turn_running",
        "queued_steering",
        "queued_follow_up",
    ]
    assert sorted(schema["properties"]) == [
        "context_window",
        "model",
        "pending_decision",
        "provider",
        "queued_follow_up",
        "queued_steering",
        "session_id",
        "suspended_turn",
        "trust",
        "turn_running",
        "workspace",
    ]
    assert "trust" not in schema["required"]
    assert schema["properties"]["pending_decision"] == {"type": "boolean"}
    assert schema["properties"]["suspended_turn"] == {"type": "boolean"}
    assert schema["properties"]["turn_running"] == {"type": "boolean"}
    assert schema["properties"]["queued_steering"] == {"type": "array"}
    assert schema["properties"]["queued_follow_up"] == {"type": "array"}
    assert sorted(schema["properties"]["context_window"]["properties"]) == [
        "max_tokens",
        "source",
        "used_tokens",
    ]


def test_turn_queue_updated_schema_exposes_split_queue_snapshot() -> None:
    schema = gateway_event_payload_schemas()["turn.queue.updated"]

    assert schema["required"] == ["steering", "follow_up"]
    assert schema["properties"]["steering"] == {"type": "array"}
    assert schema["properties"]["follow_up"] == {"type": "array"}


def test_turn_completed_schema_exposes_terminal_payload_shape() -> None:
    schema = gateway_event_payload_schemas()["turn.completed"]

    assert schema["required"] == [
        "client_turn_id",
        "assistant_message",
        "activity_events",
        "progress_updates",
        "plan_steps",
        "pending_decision",
        "turn_state",
        "usage",
    ]
    assert sorted(schema["properties"]) == [
        "activity_events",
        "assistant_message",
        "client_turn_id",
        "pending_decision",
        "plan_steps",
        "progress_updates",
        "turn_state",
        "usage",
    ]
    assert schema["properties"]["pending_decision"] == {"type": "boolean"}
    assert schema["properties"]["turn_state"]["enum"] == [
        "running",
        "waiting_approval",
        "waiting_clarification",
        "completed",
        "failed",
        "interrupted",
        "rejected",
    ]


def test_turn_status_schema_exposes_terminal_routing_contract() -> None:
    schema = gateway_event_payload_schemas()["turn.status"]

    assert schema["required"] == ["state", "kind", "text", "terminal"]
    assert sorted(schema["properties"]) == [
        "client_turn_id",
        "kind",
        "message",
        "state",
        "terminal",
        "text",
    ]
    assert schema["properties"]["state"]["enum"] == list(TERMINAL_TURN_STATES)
    assert schema["properties"]["terminal"] == {"type": "boolean"}


def test_tool_lifecycle_schemas_require_turn_correlation() -> None:
    schemas = gateway_event_payload_schemas()

    assert schemas["tool.start"]["required"] == [
        "client_turn_id",
        "tool_id",
        "call_id",
        "name",
        "context",
    ]
    assert schemas["tool.progress"]["required"] == [
        "client_turn_id",
        "tool_id",
        "call_id",
        "name",
        "stage",
        "message",
    ]
    assert schemas["tool.complete"]["required"] == [
        "client_turn_id",
        "tool_id",
        "call_id",
        "name",
        "duration_s",
        "summary",
        "summary_chars",
        "summary_truncated",
        "success",
    ]
    assert schemas["tool.failed"]["required"] == [
        "client_turn_id",
        "tool_id",
        "call_id",
        "name",
        "duration_s",
        "summary",
        "summary_chars",
        "summary_truncated",
        "success",
    ]
