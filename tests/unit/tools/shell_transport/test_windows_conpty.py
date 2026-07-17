from __future__ import annotations

import os
from threading import Event

import pytest

from mycli.tools.shell_transport.base import ShellTransportRequest
from mycli.tools.shell_transport.windows_conpty import WindowsConPtyTransport


class _FakePtyProcess:
    def __init__(self, output: list[str] | None = None) -> None:
        self.pid = 123
        self.exitstatus: int | None = None
        self._alive = True
        self._output = list(output or [])
        self._input_received = Event()
        self.writes: list[str] = []
        self.resizes: list[tuple[int, int]] = []

    def read(self, size: int = 1024) -> str:
        del size
        if self._output:
            return self._output.pop(0)
        self._input_received.wait(timeout=1)
        self._alive = False
        self.exitstatus = 0
        raise EOFError("closed")

    def write(self, text: str) -> int:
        self.writes.append(text)
        self._input_received.set()
        return len(text)

    def isalive(self) -> bool:
        return self._alive

    def wait(self) -> int:
        self._alive = False
        self.exitstatus = 0
        return 0

    def sendintr(self) -> None:
        self._alive = False
        self.exitstatus = 130

    def terminate(self, force: bool = False) -> bool:
        del force
        self._alive = False
        self.exitstatus = 143
        return True

    def setwinsize(self, rows: int, columns: int) -> None:
        self.resizes.append((rows, columns))

    def close(self, force: bool = False) -> None:
        del force
        self._alive = False


def test_conpty_adapter_streams_utf8_and_delegates_io(tmp_path) -> None:
    fake = _FakePtyProcess(["prompt> ", "done\n"])
    captured: dict[str, object] = {}

    def spawn(
        argv: list[str],
        *,
        cwd: str,
        env: dict[str, str] | None,
        dimensions: tuple[int, int],
        backend: object,
    ) -> _FakePtyProcess:
        captured.update(
            argv=argv,
            cwd=cwd,
            env=env,
            dimensions=dimensions,
            backend=backend,
        )
        return fake

    request = ShellTransportRequest(
        argv=("pwsh.exe", "-Command", "Write-Host ok"),
        cwd=tmp_path,
        env={"DEMO": "1"},
        tty=True,
        rows=30,
        columns=100,
    )
    transport = WindowsConPtyTransport.start(
        request,
        process_factory=spawn,
        conpty_backend=object(),
    )

    transport.write("yes\r\n".encode())
    output = b"".join(chunk.data for chunk in transport.read_chunks())
    transport.resize(40, 120)

    assert captured["argv"] == list(request.argv)
    assert captured["cwd"] == str(tmp_path)
    assert captured["dimensions"] == (30, 100)
    assert output == b"prompt> done\n"
    assert fake.writes == ["yes\r\n"]
    assert fake.resizes == [(40, 120)]
    assert transport.poll() == 0


@pytest.mark.skipif(os.name != "nt", reason="requires Windows ConPTY")
def test_conpty_accepts_input_and_reports_terminal_stream(tmp_path) -> None:
    request = ShellTransportRequest(
        argv=(
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "$v=[Console]::ReadLine(); [Console]::WriteLine('got:'+$v)",
        ),
        cwd=tmp_path,
        env=None,
        tty=True,
    )
    transport = WindowsConPtyTransport.start(request)
    transport.write(b"yes\r\n")

    output = b"".join(chunk.data for chunk in transport.read_chunks())

    assert b"got:yes" in output
    assert transport.wait() == 0


@pytest.mark.skipif(os.name != "nt", reason="requires Windows ConPTY")
def test_conpty_resize_keeps_process_alive(tmp_path) -> None:
    request = ShellTransportRequest(
        argv=(
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "Start-Sleep -Seconds 30",
        ),
        cwd=tmp_path,
        env=None,
        tty=True,
    )
    transport = WindowsConPtyTransport.start(request)

    transport.resize(40, 120)

    assert transport.poll() is None
    transport.terminate()
