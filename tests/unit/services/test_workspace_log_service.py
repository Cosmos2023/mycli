from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from mycli.domain.logging import LogLevel, ModelLogEvent
from mycli.utils.workspace_logger import WorkspaceLogService


def _build_service(tmp_path: Path) -> WorkspaceLogService:
    return WorkspaceLogService(
        workspace_root=tmp_path,
        now_provider=lambda: datetime(2026, 4, 11, 12, 30, 45, tzinfo=timezone.utc),
    )


def test_workspace_log_service_creates_log_directory_and_writes_app_and_error_logs(
    tmp_path: Path,
) -> None:
    service = WorkspaceLogService(
        workspace_root=tmp_path,
        session_id="demo",
        now_provider=lambda: datetime(2026, 4, 11, 12, 30, 45, tzinfo=timezone.utc),
    )

    service.log(level=LogLevel.INFO, event="turn_started", message="Turn started")
    service.log(level=LogLevel.ERROR, event="turn_failed", message="Turn failed")

    agent_log = (tmp_path / "log" / "agent.log").read_text(encoding="utf-8")
    errors_log = (tmp_path / "log" / "errors.log").read_text(encoding="utf-8")

    assert (tmp_path / "log").is_dir()
    assert "INFO [demo] turn_started Turn started" in agent_log
    assert "ERROR [demo] turn_failed Turn failed" in agent_log
    assert "ERROR [demo] turn_failed Turn failed" in errors_log
    assert "turn_started" not in errors_log


def test_workspace_log_service_writes_model_event_jsonl(tmp_path: Path) -> None:
    service = _build_service(tmp_path)

    service.log_model_event(
        ModelLogEvent(
            timestamp="2026-04-11T12:30:45Z",
            level=LogLevel.INFO,
            event="model_request_started",
            session_id="demo",
            turn_id="turn_1",
            protocol="responses",
            model="gpt-test",
            provider="example.invalid",
            message="Sent model request",
            request_path="log/model-raw/20260411T123045Z-demo-turn_1-request.json",
        )
    )

    payload = json.loads((tmp_path / "log" / "model-events.jsonl").read_text(encoding="utf-8").splitlines()[0])

    assert payload["event"] == "model_request_started"
    assert payload["level"] == "info"
    assert payload["session_id"] == "demo"
    assert payload["turn_id"] == "turn_1"
    assert payload["request_path"].endswith("-request.json")


def test_workspace_log_service_writes_raw_model_payload_files(tmp_path: Path) -> None:
    service = _build_service(tmp_path)

    request_path = service.write_raw_model_payload(
        kind="request",
        payload={"model": "gpt-test", "input": [{"role": "user", "content": "inspect"}]},
        session_id="demo",
        turn_id="turn_1",
    )
    error_path = service.write_error_payload(
        payload={"error_type": "ModelResponseError", "message": "invalid JSON"},
        session_id="demo",
        turn_id="turn_1",
    )

    assert request_path.parent == tmp_path / "log" / "model-raw" / "demo"
    assert error_path.parent == tmp_path / "log" / "model-raw" / "demo"
    assert request_path.name.endswith("-request.json")
    assert error_path.name.endswith("-error.json")
    assert json.loads(request_path.read_text(encoding="utf-8"))["model"] == "gpt-test"
    assert json.loads(error_path.read_text(encoding="utf-8"))["error_type"] == "ModelResponseError"


def test_workspace_log_service_supports_external_logs_root(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    logs_root = tmp_path / "home" / ".mycli" / "logs"
    service = WorkspaceLogService(
        workspace_root=workspace_root,
        logs_root=logs_root,
        session_id="demo",
        now_provider=lambda: datetime(2026, 4, 11, 12, 30, 45, tzinfo=timezone.utc),
    )

    request_path = service.write_raw_model_payload(
        kind="request",
        payload={"hello": "world"},
        session_id="demo",
        turn_id="turn_1",
    )

    assert request_path.parent == logs_root / "model-raw" / "demo"
    assert service.agent_log_path() == logs_root / "agent.log"
    assert service.error_log_path() == logs_root / "errors.log"
    assert service.error_log_display_path() == str(logs_root / "errors.log")
    assert service.relative_path(request_path) == str(request_path)


def test_workspace_log_service_rebinds_session_context_and_raw_payload_bucket(tmp_path: Path) -> None:
    service = WorkspaceLogService(
        workspace_root=tmp_path,
        session_id="root",
        now_provider=lambda: datetime(2026, 4, 11, 12, 30, 45, tzinfo=timezone.utc),
    )

    first_path = service.write_raw_model_payload(
        kind="request",
        payload={"message": "root"},
        session_id="root",
        turn_id="turn_1",
    )
    service.set_session_id("branch/id")
    second_path = service.write_raw_model_payload(
        kind="request",
        payload={"message": "branch"},
        session_id="branch/id",
        turn_id="turn_2",
    )
    service.log(level=LogLevel.INFO, event="turn_started", message="Turn started")

    agent_log = service.agent_log_path().read_text(encoding="utf-8")

    assert first_path.parent == tmp_path / "log" / "model-raw" / "root"
    assert second_path.parent == tmp_path / "log" / "model-raw" / "branch-id"
    assert "INFO [branch/id] turn_started Turn started" in agent_log


def test_workspace_log_service_redacts_text_and_raw_json_payloads(tmp_path: Path) -> None:
    service = WorkspaceLogService(
        workspace_root=tmp_path,
        session_id="demo",
        now_provider=lambda: datetime(2026, 4, 11, 12, 30, 45, tzinfo=timezone.utc),
    )

    service.log(
        level=LogLevel.ERROR,
        event="request_failed",
        message="Authorization: Bearer sk-secret api_key=plain-token",
        context={"token": "secret-token", "safe": "value"},
    )
    raw_path = service.write_raw_model_payload(
        kind="request",
        payload={
            "headers": {"Authorization": "Bearer sk-secret"},
            "body": {"api_key": "plain-token", "nested": [{"token": "secret-token"}]},
        },
        session_id="demo",
        turn_id="turn_1",
    )

    agent_log = service.agent_log_path().read_text(encoding="utf-8")
    raw_payload = json.loads(raw_path.read_text(encoding="utf-8"))

    assert "sk-secret" not in agent_log
    assert "plain-token" not in agent_log
    assert "secret-token" not in agent_log
    assert "[REDACTED]" in agent_log
    assert raw_payload["headers"]["Authorization"] == "Bearer [REDACTED]"
    assert raw_payload["body"]["api_key"] == "[REDACTED]"
    assert raw_payload["body"]["nested"][0]["token"] == "[REDACTED]"


def test_workspace_log_service_inspects_log_paths_and_recent_lines(tmp_path: Path) -> None:
    service = WorkspaceLogService(
        workspace_root=tmp_path,
        session_id="demo",
        now_provider=lambda: datetime(2026, 4, 11, 12, 30, 45, tzinfo=timezone.utc),
    )
    service.log(level=LogLevel.INFO, event="first", message="one")
    service.log(level=LogLevel.ERROR, event="second", message="two")

    lines = service.inspect_logs(tail=1)

    assert lines[0] == f"agent_log={tmp_path / 'log' / 'agent.log'}"
    assert lines[1] == f"errors_log={tmp_path / 'log' / 'errors.log'}"
    assert lines[2] == f"model_events={tmp_path / 'log' / 'model-events.jsonl'}"
    assert lines[3] == f"model_raw={tmp_path / 'log' / 'model-raw' / 'demo'}"
    assert any("ERROR [demo] second two" in line for line in lines)
    assert all("first one" not in line for line in lines)
