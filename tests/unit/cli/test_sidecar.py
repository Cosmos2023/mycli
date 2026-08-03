from __future__ import annotations

from typing import Any

from mycli.cli import sidecar


class _ClosableService:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


def test_sidecar_main_builds_gateway_service_and_closes_it(monkeypatch: Any) -> None:
    service = _ClosableService()
    observed: dict[str, object] = {}

    def build(cli_args: dict[str, object]) -> _ClosableService:
        observed["cli_args"] = cli_args
        return service

    def run(**kwargs: object) -> int:
        observed.update(kwargs)
        return 7

    monkeypatch.setattr(sidecar, "build_turn_service", build)
    monkeypatch.setattr(sidecar, "run_stdio_gateway", run)

    result = sidecar.main(["--session", "session-1", "--model", "model-1"])

    assert result == 7
    assert observed["cli_args"] == {"session": "session-1", "model": "model-1"}
    assert observed["service"] is service
    assert service.closed is True


def test_sidecar_main_reports_startup_failure_on_stderr(
    monkeypatch: Any,
    capsys: Any,
) -> None:
    def fail(_cli_args: dict[str, object]) -> _ClosableService:
        raise RuntimeError("Invalid mycli configuration")

    monkeypatch.setattr(sidecar, "build_turn_service", fail)

    result = sidecar.main([])

    assert result == 2
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == "[mycli-sidecar] Invalid mycli configuration\n"


def test_sidecar_main_redacts_secret_like_startup_failure(
    monkeypatch: Any,
    capsys: Any,
) -> None:
    def fail(_cli_args: dict[str, object]) -> _ClosableService:
        raise RuntimeError("api_key=do-not-print")

    monkeypatch.setattr(sidecar, "build_turn_service", fail)

    result = sidecar.main([])

    assert result == 2
    captured = capsys.readouterr()
    assert "do-not-print" not in captured.err
    assert captured.err == "[mycli-sidecar] api_key=[REDACTED]\n"
