from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from mycli.domain.logging import LogLevel, ModelLogEvent
from mycli.services.workspace_log_service import WorkspaceLogService


def _build_service(tmp_path: Path) -> WorkspaceLogService:
    return WorkspaceLogService(
        workspace_root=tmp_path,
        now_provider=lambda: datetime(2026, 4, 11, 12, 30, 45, tzinfo=timezone.utc),
    )


def test_workspace_log_service_creates_log_directory_and_writes_app_and_error_logs(
    tmp_path: Path,
) -> None:
    service = _build_service(tmp_path)

    service.log(level=LogLevel.INFO, event="turn_started", message="Turn started")
    service.log(level=LogLevel.ERROR, event="turn_failed", message="Turn failed")

    app_log = (tmp_path / "log" / "app.log").read_text(encoding="utf-8")
    error_log = (tmp_path / "log" / "error.log").read_text(encoding="utf-8")

    assert (tmp_path / "log").is_dir()
    assert "INFO turn_started Turn started" in app_log
    assert "ERROR turn_failed Turn failed" in app_log
    assert "ERROR turn_failed Turn failed" in error_log
    assert "turn_started" not in error_log


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

    assert request_path.name.endswith("-request.json")
    assert error_path.name.endswith("-error.json")
    assert json.loads(request_path.read_text(encoding="utf-8"))["model"] == "gpt-test"
    assert json.loads(error_path.read_text(encoding="utf-8"))["error_type"] == "ModelResponseError"


def test_workspace_log_service_supports_external_logs_root(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    logs_root = tmp_path / "home" / ".mycli" / "logs" / "demo"
    service = WorkspaceLogService(
        workspace_root=workspace_root,
        logs_root=logs_root,
        now_provider=lambda: datetime(2026, 4, 11, 12, 30, 45, tzinfo=timezone.utc),
    )

    request_path = service.write_raw_model_payload(
        kind="request",
        payload={"hello": "world"},
        session_id="demo",
        turn_id="turn_1",
    )

    assert request_path.parent == logs_root / "model-raw"
    assert service.error_log_path() == logs_root / "error.log"
    assert service.error_log_display_path() == str(logs_root / "error.log")
    assert service.relative_path(request_path) == str(request_path)
