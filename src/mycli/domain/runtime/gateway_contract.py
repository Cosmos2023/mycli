from __future__ import annotations

from copy import deepcopy
from typing import Any

SUPPORTED_GATEWAY_RPC_METHODS = frozenset(
    {
        "approval.respond",
        "clarify.respond",
        "command.run",
        "completion.path",
        "completion.slash",
        "decision.resolve",
        "extension.manifest",
        "session.bootstrap",
        "session.list",
        "session.resume",
        "shutdown",
        "status.inspect",
        "trace.export",
        "transcript.load",
        "turn.interrupt",
        "turn.submit",
        "workspace.trust.set",
        "workspace.trust.status",
    }
)

SUPPORTED_GATEWAY_EVENT_STREAMS = frozenset(
    {
        "approval.request",
        "approval.respond",
        "clarify.request",
        "clarify.respond",
        "compaction.completed",
        "compaction.started",
        "gateway.error",
        "message.complete",
        "message.delta",
        "plan.proposed",
        "plan.updated",
        "reasoning.delta",
        "runtime.event",
        "session.changed",
        "status.changed",
        "status.update",
        "thinking.delta",
        "tool.complete",
        "tool.failed",
        "tool.progress",
        "tool.start",
        "turn.completed",
        "turn.completion_suppressed",
        "turn.event",
        "turn.failed",
        "turn.interrupted",
        "turn.started",
        "turn.status",
        "workspace.trust.changed",
    }
)

_STRING = {"type": "string"}
_OPTIONAL_STRING = {"type": ["string", "null"]}
_NUMBER = {"type": "number"}
_INTEGER = {"type": "integer"}
_BOOLEAN = {"type": "boolean"}
_OBJECT = {"type": "object"}
_ARRAY = {"type": "array"}
_CONTEXT_WINDOW = {
    "type": "object",
    "properties": {
        "used_tokens": _INTEGER,
        "max_tokens": _INTEGER,
        "source": _STRING,
    },
}
GATEWAY_ERROR_CODES = (
    "internal_error",
    "invalid_params",
    "method_not_found",
    "turn_in_progress",
    "decision_not_pending",
    "clarification_not_pending",
    "incompatible_protocol",
)
_GATEWAY_ERROR_CODE = {"type": "string", "enum": list(GATEWAY_ERROR_CODES)}
APPROVAL_DECISION_CHOICES = (
    "approve_once",
    "reject",
    "allow_session",
)
_APPROVAL_DECISION_CHOICE = {"type": "string", "enum": list(APPROVAL_DECISION_CHOICES)}
_APPROVAL_OPTIONS = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "choice": _APPROVAL_DECISION_CHOICE,
            "label": _STRING,
        },
    },
}
_TURN_STATE = {
    "type": "string",
    "enum": [
        "running",
        "waiting_approval",
        "waiting_clarification",
        "completed",
        "failed",
        "interrupted",
        "rejected",
    ],
}
_TERMINAL_TURN_STATE = {
    "type": "string",
    "enum": [
        "waiting_approval",
        "waiting_clarification",
        "completed",
        "failed",
        "interrupted",
        "rejected",
    ],
}
TERMINAL_TURN_STATES = tuple(_TERMINAL_TURN_STATE["enum"])


def gateway_event_payload_schemas() -> dict[str, dict[str, Any]]:
    """Return machine-readable payload schemas for gateway event streams."""

    return deepcopy(GATEWAY_EVENT_PAYLOAD_SCHEMAS)


def _schema(
    name: str,
    *,
    required: tuple[str, ...] = (),
    properties: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "name": name,
        "type": "object",
        "required": list(required),
        "properties": dict(properties or {}),
    }


def _with_client_turn(properties: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {"client_turn_id": _STRING, **properties}


_TOOL_LIFECYCLE_BASE = {
    "client_turn_id": _STRING,
    "tool_id": _STRING,
    "call_id": _STRING,
    "name": _STRING,
}
_TOOL_COMPLETION_PROPERTIES = {
    **_TOOL_LIFECYCLE_BASE,
    "duration_s": _NUMBER,
    "summary": _STRING,
    "summary_chars": _INTEGER,
    "summary_truncated": _BOOLEAN,
    "success": _BOOLEAN,
}
_TOOL_COMPLETION_REQUIRED = (
    "client_turn_id",
    "tool_id",
    "call_id",
    "name",
    "duration_s",
    "summary",
    "summary_chars",
    "summary_truncated",
    "success",
)
_COMPACTION_BASE_PROPERTIES = {
    "client_turn_id": _STRING,
    "source": _STRING,
    "before_tokens": _INTEGER,
    "max_tokens": _INTEGER,
}
_COMPACTION_COMPLETED_STATUS = {
    "type": "string",
    "enum": ["compressed", "skipped", "failed"],
}

GATEWAY_EVENT_PAYLOAD_SCHEMAS: dict[str, dict[str, Any]] = {
    "approval.request": _schema(
        "approval.request",
        required=("decision_id", "preview", "options"),
        properties=_with_client_turn(
            {
                "decision_id": _STRING,
                "preview": _STRING,
                "reason": _STRING,
                "tool_name": _STRING,
                "options": _APPROVAL_OPTIONS,
                "action": _STRING,
                "cwd": _STRING,
                "risk": _STRING,
                "risk_reason": _STRING,
            }
        ),
    ),
    "approval.respond": _schema(
        "approval.respond",
        required=("decision_id", "choice"),
        properties=_with_client_turn({"decision_id": _STRING, "choice": _APPROVAL_DECISION_CHOICE}),
    ),
    "clarify.request": _schema(
        "clarify.request",
        required=("request_id", "tool_id", "call_id", "tool_name", "question", "options", "multi_select"),
        properties=_with_client_turn(
            {
                "request_id": _STRING,
                "tool_id": _STRING,
                "call_id": _STRING,
                "tool_name": _STRING,
                "question": _STRING,
                "options": _ARRAY,
                "header": _STRING,
                "multi_select": _BOOLEAN,
            }
        ),
    ),
    "clarify.respond": _schema(
        "clarify.respond",
        required=("request_id", "response"),
        properties=_with_client_turn({"request_id": _STRING, "response": _STRING}),
    ),
    "compaction.started": _schema(
        "compaction.started",
        required=("client_turn_id", "source", "before_tokens", "max_tokens"),
        properties=_COMPACTION_BASE_PROPERTIES,
    ),
    "compaction.completed": _schema(
        "compaction.completed",
        required=(
            "client_turn_id",
            "source",
            "status",
            "before_tokens",
            "after_tokens",
            "max_tokens",
            "duration_s",
        ),
        properties={
            **_COMPACTION_BASE_PROPERTIES,
            "status": _COMPACTION_COMPLETED_STATUS,
            "after_tokens": _INTEGER,
            "duration_s": _NUMBER,
        },
    ),
    "gateway.error": _schema(
        "gateway.error",
        required=("code", "message"),
        properties={
            "code": _GATEWAY_ERROR_CODE,
            "message": _STRING,
            "detail": _STRING,
            "method": _STRING,
        },
    ),
    "message.complete": _schema(
        "message.complete",
        properties=_with_client_turn({"text": _STRING, "final": _BOOLEAN, "source": _STRING}),
    ),
    "message.delta": _schema(
        "message.delta",
        required=("text",),
        properties=_with_client_turn({"text": _STRING}),
    ),
    "plan.proposed": _schema(
        "plan.proposed",
        required=("client_turn_id", "text"),
        properties=_with_client_turn(
            {
                "text": _STRING,
                "source": _STRING,
            }
        ),
    ),
    "plan.updated": _schema(
        "plan.updated",
        required=("client_turn_id", "plan_steps"),
        properties=_with_client_turn({"plan_steps": _ARRAY, "source": _STRING}),
    ),
    "reasoning.delta": _schema(
        "reasoning.delta",
        required=("text",),
        properties=_with_client_turn({"text": _STRING}),
    ),
    "runtime.event": _schema(
        "runtime.event",
        required=("version", "sequence", "type", "payload", "timestamp"),
        properties={
            "version": _INTEGER,
            "sequence": _INTEGER,
            "type": _STRING,
            "payload": _OBJECT,
            "timestamp": _NUMBER,
        },
    ),
    "session.changed": _schema(
        "session.changed",
        required=("session_id",),
        properties={"session_id": _STRING},
    ),
    "status.changed": _schema(
        "status.changed",
        required=(
            "session_id",
            "workspace",
            "model",
            "provider",
            "context_window",
            "pending_decision",
            "suspended_turn",
        ),
        properties={
            "session_id": _STRING,
            "workspace": _STRING,
            "model": _STRING,
            "provider": _STRING,
            "context_window": _CONTEXT_WINDOW,
            "pending_decision": _BOOLEAN,
            "suspended_turn": _BOOLEAN,
            "trust": _OBJECT,
        },
    ),
    "status.update": _schema(
        "status.update",
        required=("state", "kind", "text"),
        properties=_with_client_turn(
            {
                "state": _TURN_STATE,
                "kind": _STRING,
                "text": _STRING,
                "message": _STRING,
                "severity": _STRING,
            }
        ),
    ),
    "thinking.delta": _schema(
        "thinking.delta",
        required=("text",),
        properties=_with_client_turn({"text": _STRING}),
    ),
    "tool.complete": _schema(
        "tool.complete",
        required=_TOOL_COMPLETION_REQUIRED,
        properties=_TOOL_COMPLETION_PROPERTIES,
    ),
    "tool.failed": _schema(
        "tool.failed",
        required=_TOOL_COMPLETION_REQUIRED,
        properties={
            **_TOOL_COMPLETION_PROPERTIES,
            "error": _STRING,
            "error_chars": _INTEGER,
            "error_truncated": _BOOLEAN,
        },
    ),
    "tool.progress": _schema(
        "tool.progress",
        required=("client_turn_id", "tool_id", "call_id", "name", "stage", "message"),
        properties={
            **_TOOL_LIFECYCLE_BASE,
            "stage": _STRING,
            "message": _STRING,
            "args_preview": _STRING,
        },
    ),
    "tool.start": _schema(
        "tool.start",
        required=("client_turn_id", "tool_id", "call_id", "name", "context"),
        properties={**_TOOL_LIFECYCLE_BASE, "context": _STRING, "args_preview": _STRING},
    ),
    "turn.completed": _schema(
        "turn.completed",
        required=(
            "client_turn_id",
            "assistant_message",
            "activity_events",
            "progress_updates",
            "plan_steps",
            "pending_decision",
            "turn_state",
            "usage",
        ),
        properties=_with_client_turn(
            {
                "assistant_message": _STRING,
                "turn_state": _TURN_STATE,
                "pending_decision": _BOOLEAN,
                "activity_events": _ARRAY,
                "progress_updates": _ARRAY,
                "plan_steps": _ARRAY,
                "usage": _OBJECT,
            }
        ),
    ),
    "turn.completion_suppressed": _schema(
        "turn.completion_suppressed",
        required=("client_turn_id", "reason", "suppressed_state"),
        properties=_with_client_turn(
            {
                "reason": _STRING,
                "suppressed_state": _TERMINAL_TURN_STATE,
            }
        ),
    ),
    "turn.event": _schema(
        "turn.event",
        required=("phase", "kind"),
        properties=_with_client_turn(
            {
                "phase": _STRING,
                "kind": _STRING,
                "text": _STRING,
                "tool_name": _OPTIONAL_STRING,
                "metadata": _OBJECT,
            }
        ),
    ),
    "turn.failed": _schema(
        "turn.failed",
        properties=_with_client_turn({"message": _STRING}),
    ),
    "turn.interrupted": _schema(
        "turn.interrupted",
        properties=_with_client_turn({"requested": _BOOLEAN}),
    ),
    "turn.started": _schema(
        "turn.started",
        required=("client_turn_id",),
        properties={"client_turn_id": _STRING},
    ),
    "turn.status": _schema(
        "turn.status",
        required=("state", "kind", "text", "terminal"),
        properties=_with_client_turn(
            {
                "state": _TERMINAL_TURN_STATE,
                "kind": _STRING,
                "text": _STRING,
                "terminal": _BOOLEAN,
                "message": _STRING,
            }
        ),
    ),
    "workspace.trust.changed": _schema(
        "workspace.trust.changed",
        required=("state", "workspace", "enforced"),
        properties={
            "state": _STRING,
            "workspace": _STRING,
            "source": _STRING,
            "enforced": _BOOLEAN,
            "message": _STRING,
            "requested_state": _STRING,
        },
    ),
}

if set(GATEWAY_EVENT_PAYLOAD_SCHEMAS) != SUPPORTED_GATEWAY_EVENT_STREAMS:
    missing = SUPPORTED_GATEWAY_EVENT_STREAMS - set(GATEWAY_EVENT_PAYLOAD_SCHEMAS)
    extra = set(GATEWAY_EVENT_PAYLOAD_SCHEMAS) - SUPPORTED_GATEWAY_EVENT_STREAMS
    raise RuntimeError(
        "Gateway event payload schemas do not match supported event streams: "
        f"missing={sorted(missing)} extra={sorted(extra)}"
    )
