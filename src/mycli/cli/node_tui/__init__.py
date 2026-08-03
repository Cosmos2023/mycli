from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

from mycli.application.turn_service import TurnService
from mycli.cli.node_tui.gateway import NodeTuiGateway as NodeTuiGateway
from mycli.cli.node_tui.gateway import run_gateway_peer as run_gateway_peer
from mycli.cli.node_tui.gateway import run_node_tui_gateway as run_node_tui_gateway
from mycli.cli.node_tui.process import build_node_tui_process
from mycli.cli.node_tui.process import NodeTuiProcessError as NodeTuiProcessError


def run_node_tui(
    service: TurnService,
    *,
    cwd: Path,
    env: Mapping[str, str],
) -> int:
    del cwd
    repo_root = Path(__file__).resolve().parents[4]
    process = build_node_tui_process(repo_root=repo_root, env=env)
    return run_node_tui_gateway(service=service, process=process)


__all__ = [
    "NodeTuiGateway",
    "NodeTuiProcessError",
    "run_gateway_peer",
    "run_node_tui",
    "run_node_tui_gateway",
]
