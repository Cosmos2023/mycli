from __future__ import annotations

import os
import sys

import pytest

from mycli.tools.shell_transport.base import ShellTransportRequest
from mycli.tools.shell_transport.unix_pty import UnixPtyTransport


pytestmark = pytest.mark.skipif(os.name != "posix", reason="requires POSIX PTY")


def test_unix_pty_reports_terminal_and_accepts_input(tmp_path) -> None:
    request = ShellTransportRequest(
        argv=(
            sys.executable,
            "-c",
            "value=input('prompt> '); print('got:'+value, flush=True)",
        ),
        cwd=tmp_path,
        env=None,
        tty=True,
    )
    transport = UnixPtyTransport.start(request)
    chunks = transport.read_chunks()

    prompt = next(chunks)
    transport.write(b"yes\n")
    remaining = b"".join(chunk.data for chunk in chunks)

    assert prompt.stream == "terminal"
    assert b"prompt> " in prompt.data
    assert b"got:yes" in remaining
    assert transport.wait() == 0


def test_unix_pty_resize_does_not_close_session(tmp_path) -> None:
    request = ShellTransportRequest(
        argv=(sys.executable, "-c", "import time; time.sleep(.2)"),
        cwd=tmp_path,
        env=None,
        tty=True,
    )
    transport = UnixPtyTransport.start(request)

    transport.resize(40, 120)

    assert transport.poll() is None
    transport.terminate()
    transport.close()
