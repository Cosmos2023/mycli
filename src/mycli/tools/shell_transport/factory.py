from __future__ import annotations

from importlib import import_module
import os
from typing import cast

from mycli.tools.shell_transport.base import (
    ShellProcessTransport,
    ShellTransportRequest,
    ShellTransportUnavailable,
)
from mycli.tools.shell_transport.pipe import PipeTransport


def create_shell_transport(request: ShellTransportRequest) -> ShellProcessTransport:
    if not request.tty:
        return PipeTransport.start(request)

    module_name = (
        "mycli.tools.shell_transport.windows_conpty"
        if os.name == "nt"
        else "mycli.tools.shell_transport.unix_pty"
    )
    class_name = "WindowsConPtyTransport" if os.name == "nt" else "UnixPtyTransport"
    error_kind = "conpty_unavailable" if os.name == "nt" else "pty_unavailable"
    try:
        transport_type = getattr(import_module(module_name), class_name)
        transport = transport_type.start(request)
    except (ImportError, AttributeError) as exc:
        raise ShellTransportUnavailable(
            error_kind,
            f"Requested terminal transport is unavailable: {exc}",
        ) from exc
    return cast(ShellProcessTransport, transport)


__all__ = ["create_shell_transport"]
