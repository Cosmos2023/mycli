from __future__ import annotations

from pathlib import Path
from threading import Thread, Timer
import time

from mycli.domain.runtime import RuntimeInterruptToken
from mycli.tools.shell_registry import ShellProcessRegistry
from mycli.tools.shell_session_manager import (
    ShellSessionManager,
    _interaction_yield_time_ms,
)
from mycli.tools.invocation_context import ToolInvocationContext, tool_invocation_scope
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
    transport.finish(0)
    tool = WriteStdinTool(session_id="session-a", registry=registry)

    result = tool.execute(
        {"session_id": started["shell_id"], "chars": "", "yield_time_ms": 250}
    )

    assert result.success is True
    assert result.raw_payload["output"] == "prompt> "
    assert transport.writes == []


def test_write_stdin_uses_invocation_owner(tmp_path: Path) -> None:
    transport = FakeShellTransport(tty=True)
    registry, started = _start_session(tmp_path, transport)
    transport.publish(b"child output")
    transport.finish(0)
    tool = WriteStdinTool(session_id="main-session", registry=registry)

    with tool_invocation_scope(ToolInvocationContext("session-a")):
        result = tool.execute(
            {"session_id": started["shell_id"], "chars": "", "yield_time_ms": 250}
        )

    assert result.success is True
    assert result.raw_payload["output"] == "child output"


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
    transport.finish(0)
    tool = WriteStdinTool(session_id="session-a", registry=registry)

    result = tool.execute({"session_id": started["shell_id"], "chars": ""})

    assert started["output"] == "initial"
    assert result.raw_payload["output"] == "next"


def test_write_stdin_uses_codex_yield_bounds() -> None:
    assert _interaction_yield_time_ms(chars="", requested_ms=250) == 5_000
    assert _interaction_yield_time_ms(chars="", requested_ms=999_999) == 300_000
    assert _interaction_yield_time_ms(chars="x", requested_ms=1) == 250
    assert _interaction_yield_time_ms(chars="x", requested_ms=999_999) == 30_000


def test_write_stdin_collects_output_until_process_exits(tmp_path: Path) -> None:
    transport = FakeShellTransport(tty=True)
    registry, started = _start_session(tmp_path, transport)
    tool = WriteStdinTool(session_id="session-a", registry=registry)
    first = Timer(0.03, lambda: transport.publish(b"first\n"))
    second = Timer(0.08, lambda: (transport.publish(b"second\n"), transport.finish(0)))
    first.start()
    second.start()
    started_at = time.monotonic()

    result = tool.execute(
        {
            "session_id": started["shell_id"],
            "chars": "\n",
            "yield_time_ms": 250,
        }
    )

    first.join(timeout=1)
    second.join(timeout=1)
    assert time.monotonic() - started_at >= 0.07
    assert result.raw_payload["output"] == "first\nsecond\n"
    assert result.raw_payload["terminal_state"] == "completed"


def test_write_stdin_empty_poll_wakes_when_turn_is_interrupted(tmp_path: Path) -> None:
    transport = FakeShellTransport(tty=True)
    registry, started = _start_session(tmp_path, transport)
    token = RuntimeInterruptToken(source="test")
    tool = WriteStdinTool(session_id="session-a", registry=registry)
    results = []
    worker = Thread(
        target=lambda: results.append(
            tool.execute(
                {
                    "session_id": started["shell_id"],
                    "chars": "",
                    "yield_time_ms": 300_000,
                    "_runtime_interrupt_token": token,
                }
            )
        )
    )

    worker.start()
    time.sleep(0.05)
    token.request("test_interrupt")
    worker.join(timeout=0.5)
    interrupted_promptly = not worker.is_alive()
    process_survived = transport.poll() is None
    transport.finish(0)
    worker.join(timeout=2.0)
    terminal = registry.read(
        str(started["shell_id"]),
        owner_session_id="session-a",
    )

    assert interrupted_promptly
    assert process_survived
    assert results[0].success is True
    assert terminal["terminal_state"] == "completed"
