from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

import mycli.services.diagnostics.doctor as doctor_module
from mycli.services.diagnostics.doctor import (
    DoctorService,
    DoctorStatus,
    render_doctor_report,
)


NODE_TUI_MARKERS = (
    "node_modules/.bin/tsx",
    "node_modules/.bin/tsc",
    "node_modules/ink",
    "node_modules/react",
    "node_modules/tsx",
    "node_modules/typescript",
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


def _create_sessions_db(path: Path, *, foreign_keys: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    message_fk = (
        ",\n                FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE"
        if foreign_keys
        else ""
    )
    tree_fk = (
        ",\n                FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE"
        if foreign_keys
        else ""
    )
    history_fk = (
        ",\n                FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE"
        if foreign_keys
        else ""
    )
    rollout_fk = (
        ",\n                FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE"
        if foreign_keys
        else ""
    )
    state_fk = (
        ",\n                FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE"
        if foreign_keys
        else ""
    )
    summary_fk = (
        ",\n                FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE"
        if foreign_keys
        else ""
    )
    with sqlite3.connect(path) as connection:
        connection.executescript(
            f"""
            CREATE TABLE sessions (
                session_id TEXT PRIMARY KEY,
                workspace_root TEXT NOT NULL DEFAULT '',
                thread_id TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                last_active_at TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'active'
            );
            CREATE TABLE conversation_messages (
                session_id TEXT NOT NULL,
                message_index INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                PRIMARY KEY (session_id, message_index)
                {message_fk}
            );
            CREATE TABLE conversation_trees (
                session_id TEXT PRIMARY KEY,
                parent_id TEXT,
                fork_point INTEGER,
                updated_at TEXT NOT NULL
                {tree_fk}
            );
            CREATE TABLE history_items (
                session_id TEXT NOT NULL,
                sequence_no INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id TEXT NOT NULL,
                payload_json TEXT NOT NULL
                {history_fk}
            );
            CREATE TABLE turn_rollouts (
                session_id TEXT NOT NULL,
                sequence_no INTEGER PRIMARY KEY AUTOINCREMENT,
                turn_id TEXT NOT NULL,
                payload_json TEXT NOT NULL
                {rollout_fk}
            );
            CREATE TABLE session_state (
                session_id TEXT NOT NULL,
                state_key TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (session_id, state_key)
                {state_fk}
            );
            CREATE TABLE session_summaries (
                session_id TEXT NOT NULL,
                summary_index INTEGER PRIMARY KEY AUTOINCREMENT,
                summary_text TEXT NOT NULL,
                created_at TEXT NOT NULL
                {summary_fk}
            );
            """
        )


def _insert_session(connection: sqlite3.Connection, session_id: str) -> None:
    connection.execute(
        """
        INSERT INTO sessions (
            session_id,
            workspace_root,
            thread_id,
            created_at,
            updated_at,
            last_active_at,
            status
        )
        VALUES (?, '/workspace', ?, 'now', 'now', 'now', 'active')
        """,
        (session_id, session_id),
    )


def _create_node_tui_dependencies(node_tui: Path) -> None:
    for marker in NODE_TUI_MARKERS:
        path = node_tui / marker
        path.parent.mkdir(parents=True, exist_ok=True)
        if marker.startswith("node_modules/.bin/"):
            path.write_text("#!/usr/bin/env node\n", encoding="utf-8")
        else:
            path.mkdir(parents=True, exist_ok=True)


def test_doctor_service_reports_local_runtime_health_without_leaking_secrets(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
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
    node_tui = tmp_path / "repo" / "tui" / "node"
    _create_node_tui_dependencies(node_tui)
    monkeypatch.setattr(doctor_module, "_node_tui_source_root", lambda: node_tui)

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
    assert "storage_layout" in rendered
    assert "Summary:" in rendered
    logs_redaction = next(check for check in report.checks if check.name == "logs_redaction")
    assert logs_redaction.status is DoctorStatus.OK


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
    assert not any(check.name == "logs_redaction" for check in report.checks)
    assert report.failed_count == 1


def test_doctor_service_fails_session_db_missing_recovery_tables(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    db_path.parent.mkdir(parents=True)
    with sqlite3.connect(db_path) as connection:
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

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "sessions_db")
    assert check.status is DoctorStatus.FAILED
    assert "missing tables:" in check.message
    assert "conversation_trees" in check.message
    assert "session_state" in check.message


def test_doctor_service_fails_session_db_foreign_key_violations(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """
            INSERT INTO conversation_messages (session_id, message_index, payload_json)
            VALUES ('missing', 0, '{}')
            """
        )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "sessions_db")
    assert check.status is DoctorStatus.FAILED
    assert check.message == "1 foreign key violation(s): conversation_messages#1"


def test_doctor_service_fails_session_db_legacy_orphan_rows(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path, foreign_keys=False)
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """
            INSERT INTO conversation_messages (session_id, message_index, payload_json)
            VALUES ('missing', 0, '{}')
            """
        )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "sessions_db")
    assert check.status is DoctorStatus.FAILED
    assert check.message == "orphan session rows: conversation_messages=1"


def test_doctor_service_fails_session_db_missing_lineage_parent(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        _insert_session(connection, "child")
        connection.execute(
            """
            INSERT INTO conversation_trees (session_id, parent_id, fork_point, updated_at)
            VALUES ('child', 'missing-parent', 0, 'now')
            """
        )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "sessions_db")
    assert check.status is DoctorStatus.FAILED
    assert check.message == "missing lineage parents: child->missing-parent"


def test_doctor_service_fails_session_db_lineage_cycle(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        for session_id in ("one", "two"):
            _insert_session(connection, session_id)
        connection.executemany(
            """
            INSERT INTO conversation_trees (session_id, parent_id, fork_point, updated_at)
            VALUES (?, ?, NULL, 'now')
            """,
            (("one", "two"), ("two", "one")),
        )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "sessions_db")
    assert check.status is DoctorStatus.FAILED
    assert check.message in {
        "conversation lineage cycle detected at one",
        "conversation lineage cycle detected at two",
    }


def test_doctor_service_fails_session_db_invalid_fork_point(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        _insert_session(connection, "child")
        connection.execute(
            """
            INSERT INTO conversation_messages (session_id, message_index, payload_json)
            VALUES ('child', 0, '{}')
            """
        )
        connection.execute(
            """
            INSERT INTO conversation_trees (session_id, parent_id, fork_point, updated_at)
            VALUES ('child', NULL, 2, 'now')
            """
        )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "sessions_db")
    assert check.status is DoctorStatus.FAILED
    assert check.message == "invalid fork points: child=2/1"


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


def test_doctor_service_reports_clean_log_redaction_scan(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    logs = home / ".mycli" / "logs"
    logs.mkdir(parents=True)
    (logs / "agent.log").write_text(
        "2026-05-31 INFO [demo] request Authorization: Bearer [REDACTED]\n",
        encoding="utf-8",
    )
    (logs / "errors.log").write_text("", encoding="utf-8")
    (logs / "model-events.jsonl").write_text(
        json.dumps({"message": "api_key=[REDACTED]"}) + "\n",
        encoding="utf-8",
    )
    raw_dir = logs / "model-raw" / "demo"
    raw_dir.mkdir(parents=True)
    (raw_dir / "request.json").write_text(
        json.dumps({"headers": {"Authorization": "Bearer [REDACTED]"}}),
        encoding="utf-8",
    )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "logs_redaction")
    assert check.status is DoctorStatus.OK
    assert check.message == "scanned 4 log file(s) for obvious secrets"


def test_doctor_service_fails_log_redaction_scan_without_printing_secret(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    secret = "sk-leakedsecret"
    logs = home / ".mycli" / "logs"
    logs.mkdir(parents=True)
    (logs / "agent.log").write_text(
        f"2026-05-31 ERROR [demo] request failed api_key={secret}\n",
        encoding="utf-8",
    )
    (logs / "model-events.jsonl").write_text("", encoding="utf-8")
    (logs / "model-raw").mkdir()

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()
    rendered = "\n".join(render_doctor_report(report))

    check = next(check for check in report.checks if check.name == "logs_redaction")
    assert check.status is DoctorStatus.FAILED
    assert check.message == "1 possible secret leak(s) in diagnostic logs"
    assert check.detail == "agent.log:1"
    assert secret not in rendered


def test_doctor_service_fails_model_raw_redaction_scan_without_printing_secret(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    secret = "raw-token-secret"
    logs = home / ".mycli" / "logs"
    raw_dir = logs / "model-raw" / "demo"
    raw_dir.mkdir(parents=True)
    (logs / "agent.log").write_text("", encoding="utf-8")
    (logs / "model-events.jsonl").write_text("", encoding="utf-8")
    (raw_dir / "request.json").write_text(
        json.dumps({"body": {"nested": [{"token": secret}]}}),
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

    check = next(check for check in report.checks if check.name == "logs_redaction")
    assert check.status is DoctorStatus.FAILED
    assert check.message == "1 possible secret leak(s) in diagnostic logs"
    assert check.detail == "model-raw/demo/request.json:$.body.nested[0].token"
    assert secret not in rendered


def test_doctor_service_reports_storage_layout_missing_reserved_dirs_as_ok(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "storage_layout")
    assert check.status is DoctorStatus.OK
    assert check.message == "reserved paths available"
    assert not (home / ".mycli" / "traces").exists()
    assert not (home / ".mycli" / "artifacts").exists()


def test_doctor_service_reports_missing_trace_directory_as_ok_without_creating_it(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "traces")
    assert check.status is DoctorStatus.OK
    assert check.message == "trace directory not created yet"
    assert not (home / ".mycli" / "traces").exists()


def test_doctor_service_reports_valid_trace_files_as_ok(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    (traces / "demo-trace.jsonl").write_text(
        "\n".join(
            (
                json.dumps({"kind": "status", "turn_id": "turn-1", "payload": {"state": "running"}}),
                "",
                json.dumps({"kind": "tool_execution", "turn_id": "turn-1", "payload": {}}),
            )
        ),
        encoding="utf-8",
    )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "traces")
    assert check.status is DoctorStatus.OK
    assert check.message == "1 trace file(s), 2 valid row(s)"
    assert check.detail == str(traces)


def test_doctor_service_warns_for_invalid_trace_rows(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    (traces / "demo-trace.jsonl").write_text(
        "\n".join(
            (
                json.dumps({"kind": "status", "turn_id": "turn-1", "payload": {}}),
                "{bad json",
                json.dumps(["not", "an", "object"]),
                json.dumps({"kind": "missing turn"}),
            )
        ),
        encoding="utf-8",
    )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "traces")
    assert check.status is DoctorStatus.WARNING
    assert check.message == "3 invalid trace row(s); 1 valid row(s)"
    assert check.detail == "demo-trace.jsonl:2, demo-trace.jsonl:3, demo-trace.jsonl:4"


def test_doctor_service_bounds_trace_file_scan(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    payload = json.dumps({"kind": "status", "turn_id": "turn-1", "payload": {}})
    for index in range(55):
        (traces / f"{index:02d}-trace.jsonl").write_text(payload, encoding="utf-8")

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "traces")
    assert check.status is DoctorStatus.OK
    assert check.message == "50 trace file(s), 50 valid row(s); scanned first 50 of 55 files"


def test_doctor_service_reports_storage_layout_reserved_dirs_as_ok(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    layout_root = home / ".mycli"
    (layout_root / "traces").mkdir(parents=True)
    (layout_root / "artifacts").mkdir()

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "storage_layout")
    assert check.status is DoctorStatus.OK
    assert check.message == "reserved paths usable: traces, artifacts"
    assert check.detail == str(layout_root)


def test_doctor_service_fails_storage_layout_when_reserved_path_is_file(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    layout_root = home / ".mycli"
    layout_root.mkdir()
    (layout_root / "traces").write_text("not a directory", encoding="utf-8")

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "storage_layout")
    assert check.status is DoctorStatus.FAILED
    assert "traces is not a directory" in check.message


def test_doctor_service_fails_storage_layout_when_reserved_dir_is_not_writable(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    traces.chmod(0o555)

    try:
        report = DoctorService(
            workspace_root=workspace,
            home_dir=home,
            env={},
            which=lambda command: f"/usr/bin/{command}",
            import_checker=lambda module: module == "mycli.cli.tui",
        ).run()
    finally:
        traces.chmod(0o755)

    check = next(check for check in report.checks if check.name == "storage_layout")
    assert check.status is DoctorStatus.FAILED
    assert "traces is not writable" in check.message


def test_doctor_service_reports_node_tui_dependency_status(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    node_tui = tmp_path / "repo" / "tui" / "node"
    _create_node_tui_dependencies(node_tui)
    monkeypatch.setattr(doctor_module, "_node_tui_source_root", lambda: node_tui)

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    dependency_check = next(check for check in report.checks if check.name == "node_tui_dependencies")
    assert dependency_check.status is DoctorStatus.OK
    assert dependency_check.message == "required Node TUI dependencies present"


def test_doctor_service_warns_when_node_tui_dependencies_are_missing_without_creating_them(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    node_tui = tmp_path / "repo" / "tui" / "node"
    node_tui.mkdir(parents=True)
    monkeypatch.setattr(doctor_module, "_node_tui_source_root", lambda: node_tui)

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    dependency_check = next(check for check in report.checks if check.name == "node_tui_dependencies")
    assert dependency_check.status is DoctorStatus.WARNING
    assert "npm --prefix tui/node ci" in dependency_check.message
    assert "rm -rf tui/node/node_modules" not in dependency_check.message
    assert not (node_tui / "node_modules").exists()


def test_doctor_service_warns_when_node_tui_dependencies_are_incomplete(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    node_tui = tmp_path / "repo" / "tui" / "node"
    (node_tui / "node_modules" / "es-toolkit").mkdir(parents=True)
    monkeypatch.setattr(doctor_module, "_node_tui_source_root", lambda: node_tui)

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    dependency_check = next(check for check in report.checks if check.name == "node_tui_dependencies")
    assert dependency_check.status is DoctorStatus.WARNING
    assert "Node TUI dependencies incomplete" in dependency_check.message
    assert "npm --prefix tui/node ci" in dependency_check.message
    assert "rm -rf tui/node/node_modules" in dependency_check.message
    assert "node_modules/.bin/tsx" in str(dependency_check.detail)
