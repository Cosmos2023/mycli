from __future__ import annotations

import json

import pytest

from mycli.cli.node_tui.protocol import (
    JsonRpcError,
    RpcNotification,
    RpcRequest,
    RpcResponse,
    decode_message,
    encode_message,
    error_response,
    notification,
    result_response,
)


def test_protocol_decodes_request_response_and_notification() -> None:
    request = decode_message(
        '{"jsonrpc":"2.0","id":"req_1","method":"status.inspect","params":{"x":1}}'
    )
    response = decode_message('{"jsonrpc":"2.0","id":"req_1","result":{"ok":true}}')
    note = decode_message('{"jsonrpc":"2.0","method":"runtime.ready","params":{"ok":true}}')

    assert isinstance(request, RpcRequest)
    assert request.id == "req_1"
    assert request.method == "status.inspect"
    assert request.params == {"x": 1}
    assert isinstance(response, RpcResponse)
    assert response.result == {"ok": True}
    assert isinstance(note, RpcNotification)
    assert note.method == "runtime.ready"


def test_protocol_encode_outputs_one_json_line() -> None:
    line = encode_message(result_response("req_1", {"ok": True}))

    assert line.endswith("\n")
    payload = json.loads(line)
    assert payload == {"jsonrpc": "2.0", "id": "req_1", "result": {"ok": True}}


def test_protocol_rejects_invalid_json() -> None:
    with pytest.raises(JsonRpcError) as exc_info:
        decode_message("{not json")

    assert exc_info.value.code == "parse_error"


def test_protocol_rejects_unknown_shape() -> None:
    with pytest.raises(JsonRpcError) as exc_info:
        decode_message('{"jsonrpc":"2.0","id":"req_1","params":{}}')

    assert exc_info.value.code == "invalid_request"


def test_protocol_builds_error_and_notification() -> None:
    error = error_response("req_1", code="invalid_params", message="Missing message")
    note = notification("turn.started", {"client_turn_id": "c1"})

    assert error.id == "req_1"
    assert error.error == {"code": "invalid_params", "message": "Missing message"}
    assert note.method == "turn.started"
    assert note.params == {"client_turn_id": "c1"}


def test_protocol_error_response_includes_structured_data() -> None:
    error = error_response(
        "req_1",
        code="turn_id_mismatch",
        message="expected active turn stale but found actual",
        data={"actual_turn_id": "actual"},
    )

    assert error.error == {
        "code": "turn_id_mismatch",
        "message": "expected active turn stale but found actual",
        "data": {"actual_turn_id": "actual"},
    }
