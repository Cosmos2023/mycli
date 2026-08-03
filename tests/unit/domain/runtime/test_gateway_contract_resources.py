from __future__ import annotations

import json
from pathlib import Path

from mycli.domain.runtime.gateway_contract import (
    APPROVAL_DECISION_CHOICES,
    GATEWAY_ERROR_CODES,
    SUPPORTED_GATEWAY_EVENT_STREAMS,
    SUPPORTED_GATEWAY_RPC_METHODS,
    TERMINAL_TURN_STATES,
    gateway_event_payload_schemas,
)


CONTRACT_ROOT = Path("packages/contracts/schemas")
PYTHON_COPY_ROOT = Path("src/mycli/schemas/generated")


def test_canonical_gateway_contract_matches_python_contract() -> None:
    catalog = json.loads((CONTRACT_ROOT / "catalog.json").read_text(encoding="utf-8"))
    events = json.loads(
        (CONTRACT_ROOT / "gateway-events.schema.json").read_text(encoding="utf-8")
    )

    assert catalog["protocolVersion"] == 1
    assert catalog["rpcMethods"] == sorted(SUPPORTED_GATEWAY_RPC_METHODS)
    assert catalog["eventStreams"] == sorted(SUPPORTED_GATEWAY_EVENT_STREAMS)
    assert catalog["errorCodes"] == list(GATEWAY_ERROR_CODES)
    assert catalog["approvalDecisionChoices"] == list(APPROVAL_DECISION_CHOICES)
    assert catalog["terminalTurnStates"] == list(TERMINAL_TURN_STATES)
    assert events["$defs"] == gateway_event_payload_schemas()


def test_python_contract_resources_are_exact_generated_copies() -> None:
    for name in ("catalog.json", "gateway-events.schema.json"):
        assert (PYTHON_COPY_ROOT / name).read_bytes() == (CONTRACT_ROOT / name).read_bytes()


def test_python_gateway_contract_is_loaded_from_packaged_resources() -> None:
    source = Path("src/mycli/domain/runtime/gateway_contract.py").read_text(encoding="utf-8")

    assert "load_gateway_contract_resources" in source
    assert "GATEWAY_EVENT_PAYLOAD_SCHEMAS: dict" not in source
    assert "def _schema(" not in source
