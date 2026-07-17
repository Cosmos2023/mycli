from pathlib import Path

import pytest

from mycli.tools.shell_transport.base import (
    ShellOutputChunk,
    ShellTransportRequest,
    ShellTransportUnavailable,
)


def test_output_chunk_rejects_unknown_stream() -> None:
    with pytest.raises(ValueError, match="stream"):
        ShellOutputChunk(sequence=1, stream="unknown", data=b"x")  # type: ignore[arg-type]


def test_transport_request_is_binary_and_platform_neutral(tmp_path: Path) -> None:
    request = ShellTransportRequest(
        argv=("/bin/sh", "-c", "printf ok"),
        cwd=tmp_path,
        env={"PATH": "/usr/bin"},
        tty=False,
        rows=24,
        columns=80,
    )

    assert request.argv[0] == "/bin/sh"
    assert request.tty is False
    assert request.rows == 24
    assert request.columns == 80


def test_transport_unavailable_has_stable_error_kind() -> None:
    error = ShellTransportUnavailable("conpty_unavailable", "ConPTY unavailable")

    assert error.error_kind == "conpty_unavailable"
    assert str(error) == "ConPTY unavailable"
