from __future__ import annotations

from io import StringIO
from pathlib import Path
from typing import cast

from mycli.application.turn_service import TurnService
from mycli.cli.node_tui.stdio import run_stdio_gateway
from tests.unit.cli.node_tui.test_gateway import FakeService


def test_run_stdio_gateway_processes_bootstrap_and_shutdown(tmp_path: Path) -> None:
    incoming = StringIO(
        '{"jsonrpc":"2.0","id":"1","method":"session.bootstrap",'
        '"params":{"protocol_version":1}}\n'
        '{"jsonrpc":"2.0","id":"2","method":"shutdown","params":{}}\n'
    )
    outgoing = StringIO()

    result = run_stdio_gateway(
        service=cast(TurnService, FakeService(tmp_path)),
        input_stream=incoming,
        output_stream=outgoing,
    )

    assert result == 0
    output = outgoing.getvalue()
    assert '"method":"runtime.ready"' in output
    assert '"session_id":"demo"' in output
    assert '"id":"1"' in output
    assert '"id":"2"' in output


def test_run_stdio_gateway_does_not_close_caller_owned_streams(tmp_path: Path) -> None:
    incoming = StringIO(
        '{"jsonrpc":"2.0","id":"1","method":"shutdown","params":{}}\n'
    )
    outgoing = StringIO()

    run_stdio_gateway(
        service=cast(TurnService, FakeService(tmp_path)),
        input_stream=incoming,
        output_stream=outgoing,
    )

    assert incoming.closed is False
    assert outgoing.closed is False
