from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, TypeAlias

JsonObject: TypeAlias = dict[str, Any]
JsonValue: TypeAlias = str | int | float | bool | None | JsonObject | list[Any]


@dataclass(slots=True, frozen=True)
class JsonRpcError(Exception):
    code: str
    message: str
    id: str | int | None = None

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


@dataclass(slots=True, frozen=True)
class RpcRequest:
    id: str | int
    method: str
    params: JsonObject


@dataclass(slots=True, frozen=True)
class RpcNotification:
    method: str
    params: JsonObject


@dataclass(slots=True, frozen=True)
class RpcResponse:
    id: str | int | None
    result: JsonObject | None = None
    error: JsonObject | None = None


RpcMessage = RpcRequest | RpcNotification | RpcResponse


def decode_message(line: str) -> RpcMessage:
    try:
        raw = json.loads(line)
    except json.JSONDecodeError as exc:
        raise JsonRpcError(code="parse_error", message=str(exc)) from exc
    if not isinstance(raw, dict):
        raise JsonRpcError(code="invalid_request", message="Message must be an object.")
    if raw.get("jsonrpc") != "2.0":
        raise JsonRpcError(code="invalid_request", message="jsonrpc must be '2.0'.")
    message_id = raw.get("id")
    method = raw.get("method")
    params = raw.get("params", {})
    if "result" in raw or "error" in raw:
        error = raw.get("error")
        result = raw.get("result")
        if error is not None and not isinstance(error, dict):
            raise JsonRpcError(code="invalid_request", message="error must be an object.")
        if result is not None and not isinstance(result, dict):
            raise JsonRpcError(code="invalid_request", message="result must be an object.")
        return RpcResponse(
            id=_valid_id_or_none(message_id),
            result=result if isinstance(result, dict) else None,
            error=error if isinstance(error, dict) else None,
        )
    if not isinstance(method, str) or not method:
        raise JsonRpcError(code="invalid_request", message="method is required.")
    if not isinstance(params, dict):
        raise JsonRpcError(code="invalid_request", message="params must be an object.")
    if message_id is None:
        return RpcNotification(method=method, params=params)
    if not isinstance(message_id, (str, int)) or isinstance(message_id, bool):
        raise JsonRpcError(code="invalid_request", message="id must be a string or integer.")
    return RpcRequest(id=message_id, method=method, params=params)


def encode_message(message: RpcMessage) -> str:
    payload: JsonObject = {"jsonrpc": "2.0"}
    if isinstance(message, RpcRequest):
        payload.update({"id": message.id, "method": message.method, "params": message.params})
    elif isinstance(message, RpcNotification):
        payload.update({"method": message.method, "params": message.params})
    else:
        payload["id"] = message.id
        if message.error is not None:
            payload["error"] = message.error
        else:
            payload["result"] = message.result or {}
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"


def result_response(message_id: str | int, result: JsonObject) -> RpcResponse:
    return RpcResponse(id=message_id, result=result)


def error_response(
    message_id: str | int | None,
    *,
    code: str,
    message: str,
    data: JsonObject | None = None,
) -> RpcResponse:
    error: JsonObject = {"code": code, "message": message}
    if data:
        error["data"] = data
    return RpcResponse(id=message_id, error=error)


def notification(method: str, params: JsonObject | None = None) -> RpcNotification:
    return RpcNotification(method=method, params=params or {})


def _valid_id_or_none(value: object) -> str | int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise JsonRpcError(code="invalid_request", message="id must be a string or integer.")
    return value
