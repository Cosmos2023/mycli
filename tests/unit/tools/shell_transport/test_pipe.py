import sys
import time

import pytest

from mycli.tools.shell_transport.base import (
    ShellTransportRequest,
    ShellTransportUnavailable,
)
from mycli.tools.shell_transport.pipe import PipeTransport


def test_pipe_yields_flushed_partial_line_before_exit(tmp_path) -> None:
    request = ShellTransportRequest(
        argv=(
            sys.executable,
            "-c",
            "import os,time; os.write(1,b'ready'); time.sleep(1)",
        ),
        cwd=tmp_path,
        env=None,
        tty=False,
    )
    transport = PipeTransport.start(request)
    started = time.monotonic()

    first = next(transport.read_chunks())

    try:
        assert first.data == b"ready"
        assert time.monotonic() - started < 0.8
        assert first.stream == "stdout"
    finally:
        transport.terminate()
        transport.close()


def test_pipe_keeps_stdout_and_stderr_labels(tmp_path) -> None:
    request = ShellTransportRequest(
        argv=(
            sys.executable,
            "-c",
            "import os; os.write(1,b'out'); os.write(2,b'err')",
        ),
        cwd=tmp_path,
        env=None,
        tty=False,
    )
    transport = PipeTransport.start(request)

    chunks = list(transport.read_chunks())

    assert {chunk.stream for chunk in chunks} == {"stdout", "stderr"}
    assert transport.wait() == 0


def test_pipe_closes_stdin_and_rejects_writes(tmp_path) -> None:
    request = ShellTransportRequest(
        argv=(sys.executable, "-c", "print('done')"),
        cwd=tmp_path,
        env=None,
        tty=False,
    )
    transport = PipeTransport.start(request)

    with pytest.raises(ShellTransportUnavailable, match="stdin is closed") as exc_info:
        transport.write(b"input\n")

    assert exc_info.value.error_kind == "stdin_closed"
    list(transport.read_chunks())
    assert transport.wait() == 0
