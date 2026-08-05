from __future__ import annotations

from copy import deepcopy
from typing import Any, cast

from mycli.schemas.gateway_contract_loader import load_gateway_contract_resources


_CATALOG, _EVENT_SCHEMA = load_gateway_contract_resources()
PROTOCOL_VERSION = cast(int, _CATALOG["protocolVersion"])
SUPPORTED_GATEWAY_RPC_METHODS = frozenset(cast(list[str], _CATALOG["rpcMethods"]))
SUPPORTED_GATEWAY_EVENT_STREAMS = frozenset(cast(list[str], _CATALOG["eventStreams"]))
GATEWAY_ERROR_CODES = tuple(cast(list[str], _CATALOG["errorCodes"]))
APPROVAL_DECISION_CHOICES = tuple(cast(list[str], _CATALOG["approvalDecisionChoices"]))
TERMINAL_TURN_STATES = tuple(cast(list[str], _CATALOG["terminalTurnStates"]))
_GATEWAY_SCHEMA_DEFINITIONS = cast(dict[str, dict[str, Any]], _EVENT_SCHEMA["$defs"])
GATEWAY_EVENT_PAYLOAD_SCHEMAS = {
    name: schema
    for name, schema in _GATEWAY_SCHEMA_DEFINITIONS.items()
    if name in SUPPORTED_GATEWAY_EVENT_STREAMS
}


def gateway_event_payload_schemas() -> dict[str, dict[str, Any]]:
    """Return machine-readable payload schemas for gateway event streams."""

    return deepcopy(GATEWAY_EVENT_PAYLOAD_SCHEMAS)


if set(GATEWAY_EVENT_PAYLOAD_SCHEMAS) != SUPPORTED_GATEWAY_EVENT_STREAMS:
    raise RuntimeError("Generated gateway event schema does not match the event catalog.")
