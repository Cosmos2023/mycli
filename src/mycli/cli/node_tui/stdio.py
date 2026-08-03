from __future__ import annotations

from typing import TextIO

from mycli.application.turn_service import TurnService
from mycli.cli.node_tui.gateway import run_gateway_peer


class StdioGatewayPeer:
    def __init__(self, input_stream: TextIO, output_stream: TextIO) -> None:
        self._input_stream = input_stream
        self._output_stream = output_stream

    def start(self) -> None:
        return None

    def write_line(self, line: str) -> None:
        self._output_stream.write(line)
        self._output_stream.flush()

    def read_line(self) -> str:
        return self._input_stream.readline()

    def wait(self) -> int:
        return 0

    def terminate(self) -> None:
        return None


def run_stdio_gateway(
    *,
    service: TurnService,
    input_stream: TextIO,
    output_stream: TextIO,
) -> int:
    peer = StdioGatewayPeer(input_stream=input_stream, output_stream=output_stream)
    return run_gateway_peer(service=service, peer=peer)
