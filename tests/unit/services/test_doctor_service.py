from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from mycli.services.diagnostics.doctor import (
    DoctorService,
    DoctorStatus,
    render_doctor_report,
)


def _write_project_config(workspace: Path, *, api_key: str = "sk-secret") -> None:
    config_dir = workspace / ".mycli"
    config_dir.mkdir(parents=True)
    (config_dir / "config.toml").write_text(
        "\n".join(
            [
                f'api_key = "{api_key}"',
                'provider = "deepseek"',
                'protocol = "chat_completions"',
                'model = "deepseek-v4-flash"',
                'api_base_url = "https://api.deepseek.com"',
            ]
        ),
        encoding="utf-8",
    )


def _create_sessions_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
            CREATE TABLE conversation_messages (
                session_id TEXT NOT NULL,
                message_index INTEGER NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE TABLE turn_rollouts (
                session_id TEXT NOT NULL,
                sequence_no INTEGER PRIMARY KEY AUTOINCREMENT,
                turn_id TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );
            """
        )


def test_doctor_service_reports_local_runtime_health_without_leaking_secrets(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace, api_key="sk-do-not-print")
    layout_root = home / ".mycli"
    _create_sessions_db(layout_root / "sessions.db")
    logs = layout_root / "logs"
    logs.mkdir(parents=True)
    for name in ("agent.log", "errors.log", "model-events.jsonl"):
        (logs / name).write_text("", encoding="utf-8")
    (logs / "model-raw").mkdir()
    history = layout_root / "file-history" / "default"
    history.mkdir(parents=True)
    (history / "index.json").write_text(json.dumps({"snapshots": []}), encoding="utf-8")
    (workspace / ".mycli" / "mcp_servers.toml").write_text(
        "[servers.demo]\ncommand = \"python\"\n",
        encoding="utf-8",
    )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()
    rendered = "\n".join(render_doctor_report(report))

    assert report.failed_count == 0
    assert report.warning_count == 0
    assert "sk-do-not-print" not in rendered
    assert "provider=deepseek" in rendered
    assert "api_key: present" in rendered
    assert "mcp: 1 configured, 1 enabled" in rendered
    assert "Summary:" in rendered


def test_doctor_service_reports_warnings_and_mcp_parse_failures(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    (workspace / ".mycli" / "mcp_servers.toml").write_text(
        "[servers.bad]\ntransport = \"bad\"\n",
        encoding="utf-8",
    )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda _command: None,
        import_checker=lambda _module: False,
    ).run()

    assert any(check.name == "sessions_db" and check.status is DoctorStatus.WARNING for check in report.checks)
    assert any(check.name == "file_history" and check.status is DoctorStatus.WARNING for check in report.checks)
    assert any(check.name == "mcp" and check.status is DoctorStatus.FAILED for check in report.checks)
    assert report.failed_count == 1


def test_doctor_service_allows_missing_errors_log_when_no_errors_were_recorded(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    layout_root = home / ".mycli"
    _create_sessions_db(layout_root / "sessions.db")
    logs = layout_root / "logs"
    logs.mkdir(parents=True)
    (logs / "agent.log").write_text("", encoding="utf-8")
    (logs / "model-events.jsonl").write_text("", encoding="utf-8")
    (logs / "model-raw").mkdir()
    history = layout_root / "file-history" / "default"
    history.mkdir(parents=True)
    (history / "index.json").write_text(json.dumps({"snapshots": []}), encoding="utf-8")

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    logs_check = next(check for check in report.checks if check.name == "logs")
    assert logs_check.status is DoctorStatus.OK
    assert "errors.log" not in logs_check.message
