from __future__ import annotations

from importlib.resources import files
import json
from typing import Any, cast


JsonObject = dict[str, Any]


def _load_json(name: str) -> JsonObject:
    resource = files("mycli.schemas.generated").joinpath(name)
    value = json.loads(resource.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"Generated gateway contract must be an object: {name}")
    return cast(JsonObject, value)


def load_gateway_contract_resources() -> tuple[JsonObject, JsonObject]:
    return _load_json("catalog.json"), _load_json("gateway-events.schema.json")
