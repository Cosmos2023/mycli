from __future__ import annotations

from pathlib import Path

from mycli.tools.shell_registry import ShellProcessRegistry
from mycli.tools.shell_session_manager import ShellSessionManager
from mycli.tools.write_stdin import WriteStdinTool
from tests.support.shell_transports import FakeShellTransport


def _start_session(
    tmp_path: Path,
    transport: FakeShellTransport,
) -> tuple[ShellProcessRegistry, dict[str, object]]:
    manager = ShellSessionManager(transport_factory=lambda _request: transport)
    registry = ShellProcessRegistry(manager)
    started = registry.execute_new(
        "ignored",
        owner_session_id="session-a",
        workdir=str(tmp_path),
        tty=transport.tty,
        yield_time_ms=25,
    )
    return registry, started


def test_write_stdin_empty_chars_waits_for_incremental_output(tmp_path: Path) -> None:
    transport = FakeShellTransport(tty=True)
    registry, started = _start_session(tmp_path, transport)
    transport.publish(b"prompt> ")
    tool = WriteStdinTool(session_id="session-a", registry=registry)

    result = tool.execute(
        {"session_id": started["shell_id"], "chars": "", "yield_time_ms": 250}
    )

    assert result.success is True
    assert result.raw_payload["output"] == "prompt> "
    assert transport.writes == []
    transport.finish(0)


def test_write_stdin_writes_only_to_tty_session(tmp_path: Path) -> None:
    transport = FakeShellTransport(tty=True)
    registry, started = _start_session(tmp_path, transport)
    tool = WriteStdinTool(session_id="session-a", registry=registry)

    result = tool.execute({"session_id": started["shell_id"], "chars": "yes\n"})

    assert result.success is True
    assert transport.writes == [b"yes\n"]
    transport.finish(0)


def test_write_stdin_rejects_nonempty_pipe_input(tmp_path: Path) -> None:
    transport = FakeShellTransport(tty=False)
    registry, started = _start_session(tmp_path, transport)
    tool = WriteStdinTool(session_id="session-a", registry=registry)

    result = tool.execute({"session_id": started["shell_id"], "chars": "yes\n"})

    assert result.success is False
    assert result.raw_payload["error_kind"] == "stdin_closed"
    transport.finish(0)


def test_write_stdin_does_not_repeat_initial_shell_output(tmp_path: Path) -> None:
    transport = FakeShellTransport(tty=True)
    transport.publish(b"initial")
    registry, started = _start_session(tmp_path, transport)
    transport.publish(b"next")
    tool = WriteStdinTool(session_id="session-a", registry=registry)

    result = tool.execute({"session_id": started["shell_id"], "chars": ""})

    assert started["output"] == "initial"
    assert result.raw_payload["output"] == "next"
    transport.finish(0)
