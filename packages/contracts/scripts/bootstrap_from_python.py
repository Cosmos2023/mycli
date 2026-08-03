from __future__ import annotations

import json
from pathlib import Path
import shutil

from mycli.domain.runtime.gateway_contract import (
    APPROVAL_DECISION_CHOICES,
    GATEWAY_ERROR_CODES,
    SUPPORTED_GATEWAY_EVENT_STREAMS,
    SUPPORTED_GATEWAY_RPC_METHODS,
    TERMINAL_TURN_STATES,
    gateway_event_payload_schemas,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_ROOT = REPO_ROOT / "packages" / "contracts" / "schemas"
PYTHON_ROOT = REPO_ROOT / "src" / "mycli" / "schemas" / "generated"


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    payload_schemas = gateway_event_payload_schemas()
    event_names = sorted(SUPPORTED_GATEWAY_EVENT_STREAMS)
    catalog = {
        "$schema": "./catalog.schema.json",
        "protocolVersion": 1,
        "rpcMethods": sorted(SUPPORTED_GATEWAY_RPC_METHODS),
        "eventStreams": event_names,
        "errorCodes": list(GATEWAY_ERROR_CODES),
        "approvalDecisionChoices": list(APPROVAL_DECISION_CHOICES),
        "terminalTurnStates": list(TERMINAL_TURN_STATES),
    }
    events = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://mycli.local/contracts/gateway-events.schema.json",
        "title": "GatewayEventNotification",
        "oneOf": [
            {
                "type": "object",
                "additionalProperties": False,
                "required": ["jsonrpc", "method", "params"],
                "properties": {
                    "jsonrpc": {"const": "2.0"},
                    "method": {"const": name},
                    "params": {"$ref": f"#/$defs/{name}"},
                },
            }
            for name in event_names
        ],
        "$defs": payload_schemas,
    }
    write_json(SCHEMA_ROOT / "catalog.json", catalog)
    write_json(SCHEMA_ROOT / "gateway-events.schema.json", events)
    PYTHON_ROOT.mkdir(parents=True, exist_ok=True)
    for name in ("catalog.json", "gateway-events.schema.json"):
        shutil.copyfile(SCHEMA_ROOT / name, PYTHON_ROOT / name)


if __name__ == "__main__":
    main()
