from __future__ import annotations

from mycli.domain.runtime import DecisionAction
from mycli.domain.runtime.gateway_contract import (
    APPROVAL_DECISION_CHOICES,
    GATEWAY_ERROR_CODES,
    TERMINAL_TURN_STATES,
    SUPPORTED_GATEWAY_RPC_METHODS,
    gateway_event_payload_schemas,
)


def test_gateway_contract_exposes_command_manifest_method() -> None:
    assert "command.list" in SUPPORTED_GATEWAY_RPC_METHODS
    assert "model.list" in SUPPORTED_GATEWAY_RPC_METHODS
    assert "model.select" in SUPPORTED_GATEWAY_RPC_METHODS


def test_stream_retrying_schema_exposes_error_details() -> None:
    schema = gateway_event_payload_schemas()["stream.retrying"]

    assert schema["properties"]["additional_details"] == {"type": "string"}


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
        "not_slash_command",
        "unknown_command",
        "unavailable_surface",
        "unavailable_platform",
        "unavailable_feature",
        "invalid_arguments",
        "unavailable_during_turn",
        "stale_turn",
        "queue_conflict",
        "queue_capacity",
        "queue_worker_start_failed",
        "no_active_turn",
        "turn_id_mismatch",
        "active_turn_not_steerable",
        "input_too_large",
        "message_id_conflict",
        "session_not_found",
        "session_state_invalid",
        "session_state_version_unsupported",
        "approval_not_pending",
        "approval_conflict",
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
        "always_allow",
    ]


def test_approval_request_options_schema_uses_decision_choice_taxonomy() -> None:
    schema = gateway_event_payload_schemas()["approval.request"]
    options = schema["properties"]["options"]

    assert options["type"] == "array"
    assert options["items"]["properties"]["choice"]["enum"] == list(APPROVAL_DECISION_CHOICES)


def test_approval_request_schema_exposes_file_change_previews() -> None:
    schema = gateway_event_payload_schemas()["approval.request"]

    assert schema["properties"]["content_preview"] == {"type": "string"}
    assert schema["properties"]["content_line_count"] == {"type": "integer"}
    assert schema["properties"]["content_truncated"] == {"type": "boolean"}
    assert schema["properties"]["diff"] == {"type": "string"}
    assert schema["properties"]["diff_truncated"] == {"type": "boolean"}


def test_approval_request_schema_exposes_bounded_persistent_rule_preview() -> None:
    schema = gateway_event_payload_schemas()["approval.request"]

    assert schema["properties"]["persistent_rule_preview"] == {"type": "string"}


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
        "turn_id",
        "queued_steering",
        "queued_follow_up",
        "has_pending_input",
        "queue_activity",
        "queue_revision",
        "queue_items",
    ]
    assert sorted(schema["properties"]) == [
        "context_window",
        "has_pending_input",
        "model",
        "pending_decision",
        "provider",
        "queue_activity",
        "queue_items",
        "queue_revision",
        "queued_follow_up",
        "queued_follow_up_items",
        "queued_steering",
        "queued_steering_items",
        "session_id",
        "suspended_turn",
        "trust",
        "turn_id",
        "turn_running",
        "workspace",
    ]
    assert "trust" not in schema["required"]
    assert schema["properties"]["pending_decision"] == {"type": "boolean"}
    assert schema["properties"]["suspended_turn"] == {"type": "boolean"}
    assert schema["properties"]["turn_running"] == {"type": "boolean"}
    assert schema["properties"]["queued_steering"] == {"type": "array"}
    assert schema["properties"]["queued_steering_items"]["type"] == "array"
    assert schema["properties"]["queued_follow_up_items"]["type"] == "array"
    for field in ("queued_steering_items", "queued_follow_up_items"):
        assert schema["properties"][field]["items"]["properties"]["kind"]["enum"] == [
            "steering",
            "rejected_steer",
            "follow_up",
        ]
    assert schema["properties"]["queued_follow_up"] == {"type": "array"}
    assert schema["properties"]["has_pending_input"] == {"type": "boolean"}
    assert schema["properties"]["queue_activity"]["properties"]["kind"]["enum"] == ["idle", "pending_input"]
    assert sorted(schema["properties"]["context_window"]["properties"]) == [
        "max_tokens",
        "source",
        "used_tokens",
    ]


def test_turn_queue_updated_schema_exposes_split_queue_snapshot() -> None:
    schema = gateway_event_payload_schemas()["turn.queue.updated"]

    assert schema["required"] == [
        "queue_revision",
        "queue_items",
        "steering",
        "follow_up",
    ]
    assert schema["properties"]["steering"] == {"type": "array"}
    assert schema["properties"]["follow_up"] == {"type": "array"}
    assert schema["properties"]["has_pending_input"] == {"type": "boolean"}
    assert schema["properties"]["activity"]["properties"]["kind"]["enum"] == ["idle", "pending_input"]
    assert schema["properties"]["activity"]["properties"]["steering_count"] == {"type": "integer"}
    assert schema["properties"]["activity"]["properties"]["follow_up_count"] == {"type": "integer"}
    assert schema["properties"]["steering_items"]["type"] == "array"
    assert schema["properties"]["follow_up_items"]["type"] == "array"
    queued_item = schema["properties"]["steering_items"]["items"]
    assert queued_item["properties"]["kind"]["enum"] == [
        "steering",
        "rejected_steer",
        "follow_up",
    ]
    assert queued_item["properties"]["message"] == {"type": "string"}
    assert queued_item["properties"]["text"] == {"type": "string"}
    assert queued_item["properties"]["source"] == {"type": "string"}
    assert queued_item["properties"]["client_turn_id"] == {"type": "string"}
    local_images = queued_item["properties"]["local_images"]
    assert local_images["type"] == "array"
    assert local_images["items"]["properties"]["path"] == {"type": "string"}
    assert local_images["items"]["properties"]["placeholder"] == {"type": "string"}


def test_gateway_contract_exposes_server_turn_and_revisioned_queue_fields() -> None:
    schemas = gateway_event_payload_schemas()

    assert "turn_id" in schemas["turn.started"]["required"]
    assert "turn_id" in schemas["turn.completed"]["required"]
    assert schemas["turn.queue.updated"]["required"] == [
        "queue_revision",
        "queue_items",
        "steering",
        "follow_up",
    ]
    queue_items = schemas["turn.queue.updated"]["properties"]["queue_items"]
    assert sorted(queue_items["properties"]) == [
        "follow_ups",
        "pending_steers",
        "rejected_steers",
    ]
    queued_record = queue_items["properties"]["pending_steers"]["items"]
    assert queued_record["properties"]["target_turn_id"] == {
        "type": ["string", "null"]
    }
    assert queued_record["properties"]["kind"]["enum"] == [
        "pending_steer",
        "rejected_steer",
        "follow_up",
    ]
    assert "stale_turn" in GATEWAY_ERROR_CODES
    assert "queue_conflict" in GATEWAY_ERROR_CODES
    assert "queue_capacity" in GATEWAY_ERROR_CODES
    assert "queue_worker_start_failed" in GATEWAY_ERROR_CODES


def test_turn_completed_schema_exposes_terminal_payload_shape() -> None:
    schema = gateway_event_payload_schemas()["turn.completed"]

    assert schema["required"] == [
        "client_turn_id",
        "turn_id",
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
        "input_rolled_back",
        "pending_decision",
        "plan_steps",
        "progress_updates",
        "turn_id",
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


def test_plan_updated_schema_exposes_structured_plan_payload() -> None:
    schema = gateway_event_payload_schemas()["plan.updated"]

    assert schema["required"] == ["client_turn_id", "plan_steps"]
    assert schema["properties"]["plan"] == {"type": "object"}
    assert schema["properties"]["completed"] == {"type": "integer"}
    assert schema["properties"]["total"] == {"type": "integer"}


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
        "turn_id",
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


def test_user_message_lifecycle_schemas_require_identity_and_content() -> None:
    schemas = gateway_event_payload_schemas()

    for event_type in ("item.started", "item.completed"):
        schema = schemas[event_type]
        assert schema["required"] == ["client_turn_id", "turn_id", "item"]
        item = schema["properties"]["item"]
        assert item["required"] == [
            "id",
            "type",
            "client_user_message_id",
            "content",
            "source",
        ]
        assert item["properties"]["type"]["enum"] == ["user_message"]
