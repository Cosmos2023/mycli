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
from mycli.services.mcp.diagnostics import McpDiscoveryDiagnostics, McpServerDiagnostic


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
            CREATE TABLE schema_version (
                version INTEGER NOT NULL
            );
            CREATE VIRTUAL TABLE conversation_messages_fts USING fts5(
                session_id UNINDEXED,
                message_index UNINDEXED,
                content
            );
            CREATE TRIGGER conversation_messages_fts_insert
            AFTER INSERT ON conversation_messages BEGIN
                INSERT INTO conversation_messages_fts(
                    rowid,
                    session_id,
                    message_index,
                    content
                )
                VALUES (
                    new.rowid,
                    new.session_id,
                    new.message_index,
                    new.payload_json
                );
            END;
            CREATE TRIGGER conversation_messages_fts_delete
            AFTER DELETE ON conversation_messages BEGIN
                DELETE FROM conversation_messages_fts WHERE rowid = old.rowid;
            END;
            CREATE TRIGGER conversation_messages_fts_update
            AFTER UPDATE ON conversation_messages BEGIN
                DELETE FROM conversation_messages_fts WHERE rowid = old.rowid;
                INSERT INTO conversation_messages_fts(
                    rowid,
                    session_id,
                    message_index,
                    content
                )
                VALUES (
                    new.rowid,
                    new.session_id,
                    new.message_index,
                    new.payload_json
                );
            END;
            CREATE VIRTUAL TABLE history_items_fts USING fts5(
                session_id UNINDEXED,
                item_id UNINDEXED,
                sequence_no UNINDEXED,
                content
            );
            CREATE TRIGGER history_items_fts_insert
            AFTER INSERT ON history_items BEGIN
                INSERT INTO history_items_fts(
                    rowid,
                    session_id,
                    item_id,
                    sequence_no,
                    content
                )
                VALUES (
                    new.rowid,
                    new.session_id,
                    new.item_id,
                    new.sequence_no,
                    COALESCE(json_extract(new.payload_json, '$.text'), new.payload_json)
                );
            END;
            CREATE TRIGGER history_items_fts_delete
            AFTER DELETE ON history_items BEGIN
                DELETE FROM history_items_fts WHERE rowid = old.rowid;
            END;
            CREATE TRIGGER history_items_fts_update
            AFTER UPDATE ON history_items BEGIN
                DELETE FROM history_items_fts WHERE rowid = old.rowid;
                INSERT INTO history_items_fts(
                    rowid,
                    session_id,
                    item_id,
                    sequence_no,
                    content
                )
                VALUES (
                    new.rowid,
                    new.session_id,
                    new.item_id,
                    new.sequence_no,
                    COALESCE(json_extract(new.payload_json, '$.text'), new.payload_json)
                );
            END;
            """
        )
        connection.execute("INSERT INTO schema_version (version) VALUES (2)")


def _insert_session(
    connection: sqlite3.Connection,
    session_id: str,
    *,
    workspace_root: Path | str = "/workspace",
) -> None:
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
        VALUES (?, ?, ?, 'now', 'now', 'now', 'active')
        """,
        (session_id, str(workspace_root), session_id),
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
    monkeypatch.setattr(
        doctor_module,
        "discover_mcp_servers",
        lambda *_args, **_kwargs: McpDiscoveryDiagnostics(
            configured_count=1,
            enabled_count=1,
            disabled_count=0,
            tool_count=1,
            servers=(
                McpServerDiagnostic(
                    server_name="demo",
                    transport="stdio",
                    enabled=True,
                    status="ok",
                    tool_count=1,
                ),
            ),
        ),
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
    assert report.warning_count == 0, rendered
    assert "sk-do-not-print" not in rendered
    assert "provider=deepseek" in rendered
    assert "api_key: present" in rendered
    assert "mcp: 1 configured, 1 enabled, 1 tools discovered" in rendered
    assert "demo:ok:tools=1" in rendered
    assert "skills:" in rendered
    assert "subagents: 3 profiles, 3 enabled, 0 disabled" in rendered
    assert "explore:builtin:enabled:tools=Read,Grep,Glob,LS:denied=6" in rendered
    assert "You are a read-only exploration sub-agent" not in rendered
    assert "hooks: 1 registered, configured=0" in rendered
    assert "tool_manifest_runtime: extension manifest matches runtime-visible tools" in rendered
    assert "storage_layout" in rendered
    assert "Summary:" in rendered
    logs_redaction = next(check for check in report.checks if check.name == "logs_redaction")
    assert logs_redaction.status is DoctorStatus.OK
    session_maintenance = next(
        check for check in report.checks if check.name == "session_maintenance"
    )
    assert session_maintenance.status is DoctorStatus.OK
    assert session_maintenance.message == (
        "workspace_sessions=0 empty_sessions=0 freelist_pages=0"
    )
    runtime_contract = next(check for check in report.checks if check.name == "runtime_contract")
    assert runtime_contract.status is DoctorStatus.OK
    assert runtime_contract.message == "gateway manifest matches supported contract"
    tool_manifest = next(check for check in report.checks if check.name == "tool_manifest")
    assert tool_manifest.status is DoctorStatus.OK
    assert "builtin tools" in tool_manifest.message
    hooks = next(check for check in report.checks if check.name == "hooks")
    assert hooks.status is DoctorStatus.OK
    assert hooks.detail == "points=pre_tool_use; hooks=permission_guard"
    tool_environment = next(check for check in report.checks if check.name == "tool_environment")
    assert tool_environment.status is DoctorStatus.OK
    assert tool_environment.message == "shell and git available"


def test_doctor_service_reports_configured_subagent_diagnostics(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    profiles = workspace / ".mycli" / "subagents"
    profiles.mkdir(parents=True)
    home.mkdir()
    profiles.joinpath("risky.toml").write_text(
        "\n".join(
            [
                'id = "risky"',
                'instruction = "Run risky checks."',
                'allowed_tools = ["Read", "Bash", "MissingTool"]',
            ]
        ),
        encoding="utf-8",
    )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda _command: None,
        import_checker=lambda _module: False,
    ).run()

    subagents = next(check for check in report.checks if check.name == "subagents")
    assert subagents.status is DoctorStatus.WARNING
    assert "4 profiles" in subagents.message
    assert "high-risk tools" in (subagents.detail or "")


def test_doctor_service_reports_configured_hook_diagnostics(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.joinpath(".mycli").mkdir(parents=True)
    home.mkdir()
    missing_script = tmp_path / "missing.py"
    (workspace / ".mycli" / "hooks.json").write_text(
        json.dumps(
            {
                "hooks": [
                    {
                        "id": "missing",
                        "hook_point": "pre_tool_use",
                        "command": ["python3", str(missing_script)],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda _command: None,
        import_checker=lambda _module: False,
    ).run()

    hooks = next(check for check in report.checks if check.name == "hooks")
    assert hooks.status is DoctorStatus.FAILED
    assert "hook config invalid" in hooks.message
    assert "configured:repo:missing" in hooks.message


def test_doctor_service_reports_hook_allowlist_status(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.joinpath(".mycli").mkdir(parents=True)
    home.mkdir()
    script = tmp_path / "hook.py"
    script.write_text("print('{}')\n", encoding="utf-8")
    (workspace / ".mycli" / "hooks.json").write_text(
        json.dumps(
            {
                "hooks": [
                    {
                        "id": "repo-hook",
                        "hook_point": "pre_tool_use",
                        "command": ["python3", str(script)],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda _command: None,
        import_checker=lambda _module: False,
    ).run()

    hooks = next(check for check in report.checks if check.name == "hooks")
    assert hooks.status is DoctorStatus.WARNING
    assert hooks.detail is not None
    assert "configured:repo:repo-hook" in hooks.detail
    assert "allowlist_missing" in hooks.detail


def test_doctor_service_warns_for_inherit_safe_hook_env_policy(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.joinpath(".mycli").mkdir(parents=True)
    home.mkdir()
    script = tmp_path / "hook.py"
    script.write_text("print('{}')\n", encoding="utf-8")
    (workspace / ".mycli" / "hooks.json").write_text(
        json.dumps(
            {
                "hooks": [
                    {
                        "id": "repo-hook",
                        "hook_point": "pre_tool_use",
                        "command": ["python3", str(script)],
                        "env_policy": "inherit_safe",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda _command: None,
        import_checker=lambda _module: False,
    ).run()

    hooks = next(check for check in report.checks if check.name == "hooks")
    assert hooks.status is DoctorStatus.WARNING
    assert hooks.detail is not None
    assert "env_policy=inherit_safe" in hooks.detail
    assert "allowlist_missing" in hooks.detail


def test_doctor_service_reports_malformed_hook_allowlist(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.joinpath(".mycli").mkdir(parents=True)
    (home / ".mycli" / "hook-allowlist.json").write_text("{bad", encoding="utf-8")

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda _command: None,
        import_checker=lambda _module: False,
    ).run()

    hooks = next(check for check in report.checks if check.name == "hooks")
    assert hooks.status is DoctorStatus.WARNING
    assert hooks.detail is not None
    assert "allowlist not parseable" in hooks.detail


def test_doctor_service_validates_builtin_tool_manifest(tmp_path: Path) -> None:
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

    check = next(check for check in report.checks if check.name == "tool_manifest")
    assert check.status is DoctorStatus.OK
    assert "builtin tools" in check.message
    assert "toolsets" in check.detail
    assert "toolset_registry" in check.detail


def test_doctor_service_warns_for_missing_tool_environment(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={"SHELL": "missing-shell"},
        which=lambda _command: None,
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "tool_environment")
    assert check.status is DoctorStatus.WARNING
    assert "shell not found" in check.message
    assert "git not found" in check.message


def test_doctor_service_warns_for_mcp_discovery_failure_without_leaking_config(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    (workspace / ".mycli" / "mcp_servers.toml").write_text(
        "\n".join(
            [
                "[servers.bad]",
                'command = "python"',
                'args = ["server.py", "--token", "sk-do-not-print"]',
                'env = { API_KEY = "sk-also-hidden" }',
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        doctor_module,
        "discover_mcp_servers",
        lambda *_args, **_kwargs: McpDiscoveryDiagnostics(
            configured_count=1,
            enabled_count=1,
            disabled_count=0,
            tool_count=0,
            servers=(
                McpServerDiagnostic(
                    server_name="bad",
                    transport="stdio",
                    enabled=True,
                    status="failed",
                    failure_category="timeout",
                    failure_kind="TimeoutError",
                    failure_message="timed out",
                ),
            ),
        ),
    )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda _command: None,
        import_checker=lambda _module: False,
    ).run()
    rendered = "\n".join(render_doctor_report(report))
    check = next(check for check in report.checks if check.name == "mcp")

    assert check.status is DoctorStatus.WARNING
    assert "bad:failed:timeout:TimeoutError" in rendered
    assert "server.py" not in rendered
    assert "--token" not in rendered
    assert "sk-do-not-print" not in rendered
    assert "sk-also-hidden" not in rendered


def test_doctor_service_warns_for_skill_catalog_issues_without_leaking_body(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    skill_dir = workspace / ".mycli" / "skills"
    skill_dir.mkdir(parents=True)
    (skill_dir / "review.md").write_text(
        "---\n"
        'name = "code-review"\n'
        'description = "Repo review"\n'
        "---\n"
        "SECRET SKILL BODY SHOULD NOT LEAK\n",
        encoding="utf-8",
    )
    (skill_dir / "broken.md").write_text("not frontmatter", encoding="utf-8")

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda _command: None,
        import_checker=lambda _module: False,
    ).run()
    rendered = "\n".join(render_doctor_report(report))
    check = next(check for check in report.checks if check.name == "skills")

    assert check.status is DoctorStatus.WARNING
    assert "skills:" in check.message
    assert "invalid_skill:broken.md" in rendered
    assert "SECRET SKILL BODY" not in rendered


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
    assert not any(check.name == "session_maintenance" for check in report.checks)
    assert any(check.name == "file_history" and check.status is DoctorStatus.WARNING for check in report.checks)
    assert any(check.name == "mcp" and check.status is DoctorStatus.FAILED for check in report.checks)
    assert not any(check.name == "logs_redaction" for check in report.checks)
    assert report.failed_count == 1


def test_doctor_service_warns_about_session_maintenance_candidates(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        _insert_session(connection, "empty", workspace_root=workspace)
        _insert_session(connection, "with-message", workspace_root=workspace)
        connection.execute(
            """
            INSERT INTO conversation_messages (session_id, message_index, payload_json)
            VALUES ('with-message', 0, ?)
            """,
            ('{"role": "user", "content": "hello"}',),
        )
        _insert_session(connection, "other-empty", workspace_root=tmp_path / "other")

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda _command: None,
        import_checker=lambda _module: False,
    ).run()

    check = next(check for check in report.checks if check.name == "session_maintenance")
    assert check.status is DoctorStatus.WARNING
    assert check.message.startswith("workspace_sessions=2 empty_sessions=1 freelist_pages=")
    assert "/session-maintenance" in check.message


def test_doctor_service_session_maintenance_ignores_runtime_state_sessions(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        for session_id in ("history-only", "rollout-only", "state-only", "empty"):
            _insert_session(connection, session_id, workspace_root=workspace)
        connection.execute(
            """
            INSERT INTO history_items (session_id, item_id, payload_json)
            VALUES ('history-only', 'hist_user_1', ?)
            """,
            (
                json.dumps(
                    {
                        "id": "hist_user_1",
                        "thread_id": "history-only",
                        "turn_id": "turn_1",
                        "type": "user_message",
                        "text": "hello",
                        "tool_name": None,
                        "call_id": None,
                        "metadata": {},
                    }
                ),
            ),
        )
        connection.execute(
            """
            INSERT INTO turn_rollouts (session_id, turn_id, payload_json)
            VALUES ('rollout-only', 'turn_1', ?)
            """,
            (
                json.dumps(
                    {
                        "thread_id": "rollout-only",
                        "turn_id": "turn_1",
                        "status": "waiting_approval",
                        "started_at": "2026-05-31T00:00:00Z",
                        "completed_at": None,
                        "stop_reason": "approval_required",
                        "events": [],
                        "continuation_state": {},
                    }
                ),
            ),
        )
        connection.execute(
            """
            INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
            VALUES ('state-only', 'turn_record', ?, 'now')
            """,
            (
                json.dumps(
                    {
                        "thread_id": "state-only",
                        "turn_id": "turn_1",
                        "status": "waiting_clarification",
                        "started_at": "2026-05-31T00:00:00Z",
                        "completed_at": None,
                        "stop_reason": "clarification_required",
                        "user_message": "choose runtime",
                        "items": [],
                    }
                ),
            ),
        )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda _command: None,
        import_checker=lambda _module: False,
    ).run()

    check = next(check for check in report.checks if check.name == "session_maintenance")
    assert check.status is DoctorStatus.WARNING
    assert check.message.startswith("workspace_sessions=4 empty_sessions=1 freelist_pages=")
    assert "/session-maintenance" in check.message


def test_doctor_service_skips_session_maintenance_when_sessions_db_is_invalid(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    db_path.parent.mkdir(parents=True)
    with sqlite3.connect(db_path) as connection:
        connection.execute("CREATE TABLE sessions (session_id TEXT PRIMARY KEY)")

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda _command: None,
        import_checker=lambda _module: False,
    ).run()

    sessions_db = next(check for check in report.checks if check.name == "sessions_db")
    assert sessions_db.status is DoctorStatus.FAILED
    assert not any(check.name == "session_maintenance" for check in report.checks)


def test_doctor_service_fails_runtime_contract_manifest_mismatch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)

    class BrokenManifestService:
        def manifest(self) -> dict[str, object]:
            return {
                "schema_version": 1,
                "agent": {"name": "mycli"},
                "rpc_methods": [{"name": "turn.submit"}, {"name": "ghost.rpc"}],
                "event_streams": [{"name": "message.delta"}],
                "capabilities": [],
            }

    monkeypatch.setattr(doctor_module, "ExtensionManifestService", BrokenManifestService)

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda _command: None,
        import_checker=lambda _module: False,
    ).run()

    check = next(check for check in report.checks if check.name == "runtime_contract")
    assert check.status is DoctorStatus.FAILED
    assert check.message == (
        "manifest RPC mismatch: missing approval.respond, clarify.respond, command.run, ...; "
        "extra ghost.rpc"
    )
    assert check.detail == (
        "event streams mismatch: missing approval.request, approval.respond, clarify.request, ...; "
        "event payload schemas mismatch: missing approval.request, approval.respond, "
        "clarify.request, ..."
    )


def test_doctor_service_fails_runtime_contract_missing_payload_schema(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)

    class BrokenManifestService:
        def manifest(self) -> dict[str, object]:
            from mycli.services.extensions import ExtensionManifestService

            manifest = ExtensionManifestService().manifest()
            event_streams = list(manifest["event_streams"])
            event_streams[0] = {
                key: value for key, value in event_streams[0].items() if key != "payload_schema"
            }
            manifest["event_streams"] = event_streams
            return manifest

    monkeypatch.setattr(doctor_module, "ExtensionManifestService", BrokenManifestService)

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda _command: None,
        import_checker=lambda _module: False,
    ).run()

    check = next(check for check in report.checks if check.name == "runtime_contract")
    assert check.status is DoctorStatus.FAILED
    assert check.message.startswith("event payload schemas mismatch: missing ")


def test_doctor_service_fails_runtime_contract_payload_schema_name_drift(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)

    class BrokenManifestService:
        def manifest(self) -> dict[str, object]:
            from mycli.services.extensions import ExtensionManifestService

            manifest = ExtensionManifestService().manifest()
            event_streams = list(manifest["event_streams"])
            payload_schema = dict(event_streams[0]["payload_schema"])
            payload_schema["name"] = "ghost.event"
            event_streams[0] = {**event_streams[0], "payload_schema": payload_schema}
            manifest["event_streams"] = event_streams
            return manifest

    monkeypatch.setattr(doctor_module, "ExtensionManifestService", BrokenManifestService)

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda _command: None,
        import_checker=lambda _module: False,
    ).run()

    check = next(check for check in report.checks if check.name == "runtime_contract")
    assert check.status is DoctorStatus.FAILED
    assert check.message.startswith("event payload schemas mismatch: missing ")


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


def test_doctor_service_fails_session_db_missing_schema_version(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute("DROP TABLE schema_version")

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "sessions_db")
    assert check.status is DoctorStatus.FAILED
    assert check.message == "missing tables: schema_version"
    with sqlite3.connect(db_path) as connection:
        row = connection.execute(
            "SELECT name FROM sqlite_master WHERE name = 'schema_version'"
        ).fetchone()
    assert row is None


def test_doctor_service_fails_session_db_stale_schema_version(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute("DELETE FROM schema_version")
        connection.execute("INSERT INTO schema_version (version) VALUES (1)")

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "sessions_db")
    assert check.status is DoctorStatus.FAILED
    assert check.message == "schema version mismatch: expected 2, found 1"


def test_doctor_service_fails_session_db_missing_search_objects(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute("DROP TRIGGER conversation_messages_fts_update")
        connection.execute("DROP TRIGGER conversation_messages_fts_delete")

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "sessions_db")
    assert check.status is DoctorStatus.FAILED
    assert check.message == (
        "missing search objects: "
        "conversation_messages_fts_delete, conversation_messages_fts_update"
    )


def test_doctor_service_fails_session_db_missing_history_search_objects(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute("DROP TRIGGER history_items_fts_update")
        connection.execute("DROP TRIGGER history_items_fts_delete")
        connection.execute("DROP TABLE history_items_fts")

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "sessions_db")
    assert check.status is DoctorStatus.FAILED
    assert check.message == (
        "missing search objects: "
        "history_items_fts, history_items_fts_delete, history_items_fts_update"
    )


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


def test_doctor_service_fails_session_db_child_fork_beyond_parent_messages(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        _insert_session(connection, "root")
        _insert_session(connection, "child")
        connection.execute(
            """
            INSERT INTO conversation_messages (session_id, message_index, payload_json)
            VALUES ('root', 0, '{}')
            """
        )
        connection.executemany(
            """
            INSERT INTO conversation_messages (session_id, message_index, payload_json)
            VALUES ('child', ?, '{}')
            """,
            ((0,), (1,)),
        )
        connection.executemany(
            """
            INSERT INTO conversation_trees (session_id, parent_id, fork_point, updated_at)
            VALUES (?, ?, ?, 'now')
            """,
            (("root", None, None), ("child", "root", 2)),
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
    assert check.message == "invalid fork points: child=2/parent:1"


def test_doctor_service_fails_session_db_invalid_recovery_state_json(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        _insert_session(connection, "demo")
        connection.execute(
            """
            INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
            VALUES ('demo', 'pending_decision', '{bad json', 'now')
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
    assert check.message == "invalid recovery state payloads: demo:pending_decision invalid json"


def test_doctor_service_fails_session_db_non_object_recovery_state(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        _insert_session(connection, "demo")
        connection.execute(
            """
            INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
            VALUES ('demo', 'turn_record', '[]', 'now')
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
    assert check.message == "invalid recovery state payloads: demo:turn_record not object"


def test_doctor_service_fails_session_db_malformed_suspended_turn_recovery_state(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        _insert_session(connection, "demo")
        connection.execute(
            """
            INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
            VALUES (?, 'suspended_turn', ?, 'now')
            """,
            (
                "demo",
                json.dumps(
                    {
                        "user_message": "continue",
                        "conversation": [],
                        "pending_approval": {"preview": "approve this"},
                    }
                ),
            ),
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
    assert (
        check.message
        == "invalid recovery state payloads: demo:suspended_turn pending_approval.tool_call missing"
    )


def test_doctor_service_fails_session_db_malformed_pending_decision_shape(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        _insert_session(connection, "demo")
        connection.execute(
            """
            INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
            VALUES (?, 'pending_decision', ?, 'now')
            """,
            (
                "demo",
                json.dumps(
                    {
                        "tool_call": {
                            "name": "Bash",
                            "arguments": {"command": "git push"},
                        },
                        "kind": "needs_choice",
                        "reason": "requires approval",
                        "preview": "git push",
                    }
                ),
            ),
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
    assert (
        check.message
        == "invalid recovery state payloads: demo:pending_decision tool_call.reason missing"
    )


def test_doctor_service_fails_session_db_malformed_pending_clarification_shape(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        _insert_session(connection, "demo")
        connection.execute(
            """
            INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
            VALUES (?, 'suspended_turn', ?, 'now')
            """,
            (
                "demo",
                json.dumps(
                    {
                        "user_message": "ask",
                        "conversation": [],
                        "suspend_reason": "clarification_required",
                        "plan_items": [],
                        "pending_approval": None,
                        "pending_clarification": {
                            "tool_call": {
                                "name": "AskUserQuestion",
                                "arguments": {"question": "Which runtime?"},
                                "reason": "needs user input",
                                "call_id": "call_question_1",
                            },
                            "question": "Which runtime?",
                            "options": [],
                            "header": "",
                            "multi_select": False,
                        },
                    }
                ),
            ),
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
    assert (
        check.message
        == "invalid recovery state payloads: demo:suspended_turn "
        "pending_clarification.request_id missing"
    )


def test_doctor_service_fails_unresumable_pending_approval_state(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        _insert_session(connection, "demo")
        connection.execute(
            """
            INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
            VALUES (?, 'pending_decision', ?, 'now')
            """,
            (
                "demo",
                json.dumps(
                    {
                        "tool_call": {
                            "name": "Bash",
                            "arguments": {"command": "git push"},
                            "reason": "publish",
                            "call_id": "call_push_1",
                        },
                        "kind": "needs_choice",
                        "reason": "requires approval",
                        "preview": "git push",
                        "options": ["approve_once", "reject"],
                        "command_pattern": "git push",
                    }
                ),
            ),
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
    assert check.message == "unresumable pending approvals: demo"


def test_doctor_service_accepts_pending_approval_with_waiting_turn_record(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        _insert_session(connection, "demo", workspace_root=workspace)
        connection.execute(
            """
            INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
            VALUES (?, 'pending_decision', ?, 'now')
            """,
            (
                "demo",
                json.dumps(
                    {
                        "tool_call": {
                            "name": "Bash",
                            "arguments": {"command": "git push"},
                            "reason": "publish",
                            "call_id": "call_push_1",
                        },
                        "kind": "needs_choice",
                        "reason": "requires approval",
                        "preview": "git push",
                        "options": ["approve_once", "reject"],
                        "command_pattern": "git push",
                    }
                ),
            ),
        )
        connection.execute(
            """
            INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
            VALUES (?, 'turn_record', ?, 'now')
            """,
            (
                "demo",
                json.dumps(
                    {
                        "thread_id": "demo",
                        "turn_id": "turn_waiting",
                        "status": "waiting_approval",
                        "started_at": "2026-05-31T00:00:00Z",
                        "completed_at": None,
                        "stop_reason": "approval_required",
                        "user_message": "push the branch",
                        "items": [],
                    }
                ),
            ),
        )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "sessions_db")
    assert check.status is DoctorStatus.OK


def test_doctor_service_accepts_pending_approval_with_rollout_history_evidence(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        _insert_session(connection, "demo", workspace_root=workspace)
        connection.execute(
            """
            INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
            VALUES (?, 'pending_decision', ?, 'now')
            """,
            (
                "demo",
                json.dumps(
                    {
                        "tool_call": {
                            "name": "Bash",
                            "arguments": {"command": "git push"},
                            "reason": "publish",
                            "call_id": "call_push_1",
                        },
                        "kind": "needs_choice",
                        "reason": "requires approval",
                        "preview": "git push",
                        "options": ["approve_once", "reject"],
                        "command_pattern": "git push",
                    }
                ),
            ),
        )
        connection.execute(
            """
            INSERT INTO turn_rollouts (session_id, turn_id, payload_json)
            VALUES (?, 'turn_waiting', ?)
            """,
            (
                "demo",
                json.dumps(
                    {
                        "thread_id": "demo",
                        "turn_id": "turn_waiting",
                        "status": "waiting_approval",
                        "started_at": "2026-05-31T00:00:00Z",
                        "completed_at": None,
                        "stop_reason": "approval_required",
                        "events": [],
                        "continuation_state": {},
                    }
                ),
            ),
        )
        connection.execute(
            """
            INSERT INTO history_items (session_id, item_id, payload_json)
            VALUES (?, 'hist_user_1', ?)
            """,
            (
                "demo",
                json.dumps(
                    {
                        "id": "hist_user_1",
                        "thread_id": "demo",
                        "turn_id": "turn_waiting",
                        "type": "user_message",
                        "text": "push the branch",
                        "tool_name": None,
                        "call_id": None,
                        "metadata": {},
                    }
                ),
            ),
        )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "sessions_db")
    assert check.status is DoctorStatus.OK


def test_doctor_service_fails_unresumable_pending_clarification_state(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        _insert_session(connection, "demo")
        connection.execute(
            """
            INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
            VALUES (?, 'suspended_turn', ?, 'now')
            """,
            (
                "demo",
                json.dumps(
                    {
                        "user_message": "   ",
                        "conversation": [],
                        "suspend_reason": "clarification_required",
                        "plan_items": [],
                        "pending_approval": None,
                        "pending_clarification": {
                            "request_id": "call_question_1",
                            "tool_call": {
                                "name": "AskUserQuestion",
                                "arguments": {"question": "Which runtime?"},
                                "reason": "needs user input",
                                "call_id": "call_question_1",
                            },
                            "question": "Which runtime?",
                            "options": [],
                            "header": "",
                            "multi_select": False,
                        },
                    }
                ),
            ),
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
    assert check.message == "unresumable pending clarifications: demo"


def test_doctor_service_accepts_pending_clarification_with_waiting_turn_record(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        _insert_session(connection, "demo", workspace_root=workspace)
        connection.execute(
            """
            INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
            VALUES (?, 'suspended_turn', ?, 'now')
            """,
            (
                "demo",
                json.dumps(
                    {
                        "user_message": "   ",
                        "conversation": [],
                        "suspend_reason": "clarification_required",
                        "plan_items": [],
                        "pending_approval": None,
                        "pending_clarification": {
                            "request_id": "call_question_1",
                            "tool_call": {
                                "name": "AskUserQuestion",
                                "arguments": {"question": "Which runtime?"},
                                "reason": "needs user input",
                                "call_id": "call_question_1",
                            },
                            "question": "Which runtime?",
                            "options": [],
                            "header": "",
                            "multi_select": False,
                        },
                    }
                ),
            ),
        )
        connection.execute(
            """
            INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
            VALUES (?, 'turn_record', ?, 'now')
            """,
            (
                "demo",
                json.dumps(
                    {
                        "thread_id": "demo",
                        "turn_id": "turn_clarify",
                        "status": "waiting_clarification",
                        "started_at": "2026-05-31T00:00:00Z",
                        "completed_at": None,
                        "stop_reason": "clarification_required",
                        "user_message": "ask about runtime",
                        "items": [],
                    }
                ),
            ),
        )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "sessions_db")
    assert check.status is DoctorStatus.OK


def test_doctor_service_accepts_pending_clarification_with_rollout_history_evidence(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    db_path = home / ".mycli" / "sessions.db"
    _create_sessions_db(db_path)
    with sqlite3.connect(db_path) as connection:
        _insert_session(connection, "demo", workspace_root=workspace)
        connection.execute(
            """
            INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
            VALUES (?, 'suspended_turn', ?, 'now')
            """,
            (
                "demo",
                json.dumps(
                    {
                        "user_message": "   ",
                        "conversation": [],
                        "suspend_reason": "clarification_required",
                        "plan_items": [],
                        "pending_approval": None,
                        "pending_clarification": {
                            "request_id": "call_question_1",
                            "tool_call": {
                                "name": "AskUserQuestion",
                                "arguments": {"question": "Which runtime?"},
                                "reason": "needs user input",
                                "call_id": "call_question_1",
                            },
                            "question": "Which runtime?",
                            "options": [],
                            "header": "",
                            "multi_select": False,
                        },
                    }
                ),
            ),
        )
        connection.execute(
            """
            INSERT INTO turn_rollouts (session_id, turn_id, payload_json)
            VALUES (?, 'turn_clarify', ?)
            """,
            (
                "demo",
                json.dumps(
                    {
                        "thread_id": "demo",
                        "turn_id": "turn_clarify",
                        "status": "waiting_clarification",
                        "started_at": "2026-05-31T00:00:00Z",
                        "completed_at": None,
                        "stop_reason": "clarification_required",
                        "events": [],
                        "continuation_state": {},
                    }
                ),
            ),
        )
        connection.execute(
            """
            INSERT INTO history_items (session_id, item_id, payload_json)
            VALUES (?, 'hist_user_1', ?)
            """,
            (
                "demo",
                json.dumps(
                    {
                        "id": "hist_user_1",
                        "thread_id": "demo",
                        "turn_id": "turn_clarify",
                        "type": "user_message",
                        "text": "ask about runtime",
                        "tool_name": None,
                        "call_id": None,
                        "metadata": {},
                    }
                ),
            ),
        )

    report = DoctorService(
        workspace_root=workspace,
        home_dir=home,
        env={},
        which=lambda command: f"/usr/bin/{command}",
        import_checker=lambda module: module == "mycli.cli.tui",
    ).run()

    check = next(check for check in report.checks if check.name == "sessions_db")
    assert check.status is DoctorStatus.OK


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
    assert check.message == "scanned 4 diagnostic file(s) for obvious secrets"


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
    assert check.message == "1 possible secret leak(s) in diagnostic logs/traces"
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
    assert check.message == "1 possible secret leak(s) in diagnostic logs/traces"
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
    stream_check = next(check for check in report.checks if check.name == "stream_diagnostics")
    assert stream_check.status is DoctorStatus.OK
    assert stream_check.message == "no stream diagnostics found"
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


def test_doctor_service_reports_no_stream_diagnostics_rows_as_ok(tmp_path: Path) -> None:
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

    check = next(check for check in report.checks if check.name == "stream_diagnostics")
    assert check.status is DoctorStatus.OK
    assert check.message == "no stream diagnostics found"
    assert check.detail == str(traces)


def test_doctor_service_reports_missing_approval_diagnostics_as_ok(tmp_path: Path) -> None:
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

    check = next(check for check in report.checks if check.name == "approval_diagnostics")
    assert check.status is DoctorStatus.OK
    assert check.message == "no approval diagnostics found"


def test_doctor_service_reports_no_approval_diagnostics_rows_as_ok(tmp_path: Path) -> None:
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

    check = next(check for check in report.checks if check.name == "approval_diagnostics")
    assert check.status is DoctorStatus.OK
    assert check.message == "no approval diagnostics found"
    assert check.detail == str(traces)


def test_doctor_service_summarizes_successful_approval_diagnostics(tmp_path: Path) -> None:
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
                json.dumps(
                    {
                        "kind": "approval_resolution",
                        "turn_id": "turn-1",
                        "payload": {"result": "approved", "choice": "1"},
                    }
                ),
                json.dumps(
                    {
                        "kind": "approval_resolution",
                        "turn_id": "turn-2",
                        "payload": {"result": "rejected", "choice": "2"},
                    }
                ),
                json.dumps(
                    {
                        "kind": "approval_allowance",
                        "turn_id": "turn-3",
                        "payload": {
                            "command_pattern": "git push",
                            "safety_metadata": {
                                "risk_level": "high",
                                "policy": "shell_command_analysis",
                                "command_pattern": "git push",
                            },
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "approval_auto_allowed",
                        "turn_id": "turn-4",
                        "payload": {
                            "source": "session_allowance",
                            "safety_metadata": {
                                "risk_level": "high",
                                "policy": "shell_command_analysis",
                                "reason": "raw reason must stay hidden",
                            },
                        },
                    }
                ),
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

    check = next(check for check in report.checks if check.name == "approval_diagnostics")
    assert check.status is DoctorStatus.OK
    assert check.message == (
        "4 approval diagnostic(s), resolutions=2 allowances=1 auto_allowed=1 "
        "safety_metadata=2"
    )
    assert check.detail == (
        "resolution_results: approved=1, rejected=1; "
        "risk_levels: high=2; "
        "policies: shell_command_analysis=2"
    )
    rendered = "\n".join(render_doctor_report(report))
    assert "git push" not in rendered
    assert "raw reason" not in rendered


def test_doctor_service_warns_for_problem_approval_diagnostics_without_raw_payload(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    secret = "sk-approvalsecret"
    (traces / "demo-trace.jsonl").write_text(
        "\n".join(
            (
                json.dumps(
                    {
                        "kind": "approval_resolution",
                        "turn_id": "turn-1",
                        "payload": {
                            "result": "invalid_choice",
                            "choice": "999",
                            "reason": f"raw provider text {secret}",
                            "command_pattern": "git push --force",
                            "safety_metadata": {
                                "risk_level": "high",
                                "policy": "shell_command_analysis",
                                "command_pattern": "git push --force",
                                "arguments": {"path": "/Users/cosmos/secret.txt"},
                                "reason": f"unsafe reason {secret}",
                            },
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "approval_resolution",
                        "turn_id": "turn-2",
                        "payload": {
                            "result": "missing_suspended_turn",
                            "choice": "1",
                            "command_pattern": "git push --force",
                        },
                    }
                ),
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
    rendered = "\n".join(render_doctor_report(report))

    check = next(check for check in report.checks if check.name == "approval_diagnostics")
    assert check.status is DoctorStatus.WARNING
    assert check.message == (
        "2 approval diagnostic(s), resolutions=2 allowances=0 auto_allowed=0 "
        "safety_metadata=1"
    )
    assert check.detail == "warning_results: invalid_choice=1, missing_suspended_turn=1"
    assert secret not in rendered
    assert "raw provider text" not in rendered
    assert "unsafe reason" not in rendered
    assert "git push --force" not in rendered
    assert "/Users/cosmos/secret.txt" not in rendered


def test_doctor_service_reports_missing_clarification_diagnostics_as_ok(
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

    check = next(check for check in report.checks if check.name == "clarification_diagnostics")
    assert check.status is DoctorStatus.OK
    assert check.message == "no clarification diagnostics found"


def test_doctor_service_reports_no_clarification_diagnostics_rows_as_ok(
    tmp_path: Path,
) -> None:
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

    check = next(check for check in report.checks if check.name == "clarification_diagnostics")
    assert check.status is DoctorStatus.OK
    assert check.message == "no clarification diagnostics found"
    assert check.detail == str(traces)


def test_doctor_service_summarizes_successful_clarification_diagnostics(
    tmp_path: Path,
) -> None:
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
                json.dumps(
                    {
                        "kind": "clarification_resolution",
                        "turn_id": "turn-1",
                        "payload": {
                            "result": "answered",
                            "request_id": "call_question_1",
                            "tool_name": "AskUserQuestion",
                            "response_chars": 7,
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "clarification_resolution",
                        "turn_id": "turn-2",
                        "payload": {"result": "answered", "response_chars": 3},
                    }
                ),
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

    check = next(check for check in report.checks if check.name == "clarification_diagnostics")
    assert check.status is DoctorStatus.OK
    assert check.message == "2 clarification diagnostic(s)"
    assert check.detail == "resolution_results: answered=2"


def test_doctor_service_warns_for_problem_clarification_diagnostics_without_raw_payload(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    secret = "sk-clarificationsecret"
    (traces / "demo-trace.jsonl").write_text(
        "\n".join(
            (
                json.dumps(
                    {
                        "kind": "clarification_resolution",
                        "turn_id": "turn-1",
                        "payload": {
                            "result": "request_id_mismatch",
                            "request_id": "call_question_1",
                            "response": f"raw answer {secret}",
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "clarification_resolution",
                        "turn_id": "turn-2",
                        "payload": {
                            "result": "blank_response",
                            "user_text": "raw answer should stay hidden",
                        },
                    }
                ),
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
    rendered = "\n".join(render_doctor_report(report))

    check = next(check for check in report.checks if check.name == "clarification_diagnostics")
    assert check.status is DoctorStatus.WARNING
    assert check.message == "2 clarification diagnostic(s)"
    assert check.detail == "warning_results: blank_response=1, request_id_mismatch=1"
    assert secret not in rendered
    assert "raw answer" not in rendered


def test_doctor_service_reports_missing_tool_execution_diagnostics_as_ok(
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

    check = next(check for check in report.checks if check.name == "tool_execution_diagnostics")
    assert check.status is DoctorStatus.OK
    assert check.message == "no tool execution diagnostics found"


def test_doctor_service_reports_missing_runtime_policy_diagnostics_as_ok(
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

    check = next(check for check in report.checks if check.name == "runtime_policy_diagnostics")
    assert check.status is DoctorStatus.OK
    assert check.message == "no runtime policy diagnostics found"


def test_doctor_service_summarizes_runtime_policy_diagnostics_without_raw_args(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    secret = "sk-runtimepolicysecret"
    (traces / "demo-trace.jsonl").write_text(
        "\n".join(
            (
                json.dumps(
                    {
                        "kind": "runtime_policy_decision",
                        "turn_id": "turn-1",
                        "payload": {
                            "tool_name": "Read",
                            "decision": "allowed",
                            "policy": "builtin_safe_tool",
                            "risk_level": "low",
                            "arguments": {"path": f"/private/{secret}.txt"},
                            "argument_count": 1,
                            "argument_keys": ["path"],
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "runtime_policy_decision",
                        "turn_id": "turn-2",
                        "payload": {
                            "tool_name": "Write",
                            "decision": "needs_approval",
                            "policy": "medium_risk_requires_approval",
                            "risk_level": "medium",
                            "reason": f"raw reason {secret}",
                            "argument_count": 2,
                            "argument_keys": ["content", "file_path"],
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "runtime_policy_decision",
                        "turn_id": "turn-3",
                        "payload": {
                            "tool_name": "Bash",
                            "decision": "denied",
                            "policy": "shell_command_analysis",
                            "risk_level": "high",
                            "command_pattern": "rm -rf /",
                            "argument_count": 1,
                            "argument_keys": ["command"],
                        },
                    }
                ),
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
    rendered = "\n".join(render_doctor_report(report))

    check = next(check for check in report.checks if check.name == "runtime_policy_diagnostics")
    assert check.status is DoctorStatus.WARNING
    assert check.message == (
        "3 runtime policy diagnostic(s), allowed=1 needs_approval=1 denied=1 "
        "argument_summaries=3"
    )
    assert check.detail == (
        "decisions: allowed=1, denied=1, needs_approval=1; "
        "risk_levels: high=1, low=1, medium=1; "
        "policies: builtin_safe_tool=1, medium_risk_requires_approval=1, shell_command_analysis=1"
    )
    assert secret not in rendered
    assert f"/private/{secret}.txt" not in rendered
    assert "rm -rf" not in rendered
    assert "raw reason" not in rendered


def test_doctor_service_summarizes_tool_runtime_lifecycle_integrity(
    tmp_path: Path,
) -> None:
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
                json.dumps(
                    {
                        "kind": "tool_runtime_lifecycle",
                        "turn_id": "turn-1",
                        "payload": {
                            "tool_name": "Read",
                            "tool_id": "call_read_1",
                            "tool_call_id": "call_read_1",
                            "phase": "planned",
                            "status": "running",
                            "argument_count": 1,
                            "argument_keys": ["path"],
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "tool_runtime_lifecycle",
                        "turn_id": "turn-1",
                        "payload": {
                            "tool_name": "Read",
                            "tool_id": "call_read_1",
                            "tool_call_id": "call_read_1",
                            "phase": "completed",
                            "status": "completed",
                            "argument_count": 1,
                            "argument_keys": ["path"],
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "tool_runtime_lifecycle",
                        "turn_id": "turn-2",
                        "payload": {
                            "tool_name": "Bash",
                            "tool_id": "call_orphan",
                            "tool_call_id": "call_orphan",
                            "phase": "started",
                            "status": "running",
                            "argument_count": 1,
                            "argument_keys": ["command"],
                            "arguments": {"command": "echo sk-secret"},
                        },
                    }
                ),
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
    rendered = "\n".join(render_doctor_report(report))

    check = next(check for check in report.checks if check.name == "tool_lifecycle_diagnostics")
    assert check.status is DoctorStatus.WARNING
    assert check.message == (
        "3 tool lifecycle diagnostic(s), calls=2 terminal=1 "
        "missing_terminal=1 terminal_without_start=0 duplicate_terminal=0 "
        "malformed=0 argument_summaries=3"
    )
    assert check.detail == "phases: completed=1, planned=1, started=1"
    assert "sk-secret" not in rendered
    assert "echo" not in rendered


def test_doctor_service_reports_no_tool_execution_diagnostics_rows_as_ok(
    tmp_path: Path,
) -> None:
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
                json.dumps({"kind": "approval_resolution", "turn_id": "turn-1", "payload": {}}),
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

    check = next(check for check in report.checks if check.name == "tool_execution_diagnostics")
    assert check.status is DoctorStatus.OK
    assert check.message == "no tool execution diagnostics found"
    assert check.detail == str(traces)


def test_doctor_service_summarizes_successful_tool_execution_diagnostics(
    tmp_path: Path,
) -> None:
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
                json.dumps(
                    {
                        "kind": "tool_execution",
                        "turn_id": "turn-1",
                        "payload": {
                            "success": True,
                            "status": "succeeded",
                            "tool_name": "Read",
                            "argument_count": 1,
                            "argument_keys": ["path"],
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "tool_execution",
                        "turn_id": "turn-2",
                        "payload": {
                            "success": True,
                            "status": "succeeded",
                            "tool_name": "Grep",
                            "argument_count": 2,
                            "argument_keys": ["pattern", "path"],
                        },
                    }
                ),
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

    check = next(check for check in report.checks if check.name == "tool_execution_diagnostics")
    assert check.status is DoctorStatus.OK
    assert check.message == (
        "2 tool execution diagnostic(s), failures=0 interrupted=0 denied=0 "
        "truncated_output=0 write_diagnostic_errors=0 argument_summaries=2"
    )
    assert check.detail == "error_kinds: none"


def test_doctor_service_warns_for_problem_tool_execution_diagnostics_without_raw_payload(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    secret = "sk-toolexecutionsecret"
    (traces / "demo-trace.jsonl").write_text(
        "\n".join(
            (
                json.dumps(
                    {
                        "kind": "tool_execution",
                        "turn_id": "turn-1",
                        "payload": {
                            "success": False,
                            "status": "failed",
                            "tool_name": "Bash",
                            "arguments": {"command": f"echo {secret}"},
                            "summary": "raw summary should stay hidden",
                            "stderr": f"raw stderr {secret}",
                            "error_kind": "tool_interrupted",
                            "stderr_truncated": True,
                            "argument_count": 1,
                            "argument_keys": ["command"],
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "tool_execution",
                        "turn_id": "turn-2",
                        "payload": {
                            "success": False,
                            "status": "failed",
                            "tool_name": "Edit",
                            "path": "/private/path/secret.txt",
                            "error_kind": "tool_denied_by_hook",
                            "write_diagnostics_error": "raw diagnostics should stay hidden",
                            "argument_count": 1,
                            "argument_keys": ["path"],
                        },
                    }
                ),
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
    rendered = "\n".join(render_doctor_report(report))

    check = next(check for check in report.checks if check.name == "tool_execution_diagnostics")
    assert check.status is DoctorStatus.WARNING
    assert check.message == (
        "2 tool execution diagnostic(s), failures=2 interrupted=1 denied=1 "
        "truncated_output=1 write_diagnostic_errors=1 argument_summaries=2"
    )
    assert check.detail == "error_kinds: tool_denied_by_hook=1, tool_interrupted=1"
    assert secret not in rendered
    assert "raw summary" not in rendered
    assert "raw stderr" not in rendered
    assert "raw diagnostics" not in rendered
    assert "/private/path" not in rendered
    assert "command" not in rendered


def test_doctor_service_reports_missing_turn_failure_diagnostics_as_ok(
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

    check = next(check for check in report.checks if check.name == "turn_failure_diagnostics")
    assert check.status is DoctorStatus.OK
    assert check.message == "no turn failure diagnostics found"


def test_doctor_service_reports_missing_turn_interrupt_diagnostics_as_ok(
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

    check = next(check for check in report.checks if check.name == "turn_interrupt_diagnostics")
    assert check.status is DoctorStatus.OK
    assert check.message == "no turn interrupt diagnostics found"


def test_doctor_service_summarizes_turn_interrupt_diagnostics_without_raw_payload(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    secret = "sk-interruptsecret"
    (traces / "demo-trace.jsonl").write_text(
        "\n".join(
            (
                json.dumps(
                    {
                        "kind": "turn_interrupt_requested",
                        "turn_id": "client-1",
                        "payload": {
                            "source": "node_tui_gateway",
                            "user_message": f"raw user text {secret}",
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "turn_interrupted",
                        "turn_id": "turn-1",
                        "payload": {"suspend_reason": "interrupted"},
                    }
                ),
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
    rendered = "\n".join(render_doctor_report(report))

    check = next(check for check in report.checks if check.name == "turn_interrupt_diagnostics")
    assert check.status is DoctorStatus.OK
    assert check.message == "interrupt_requests=1 interrupt_finalized=1"
    assert check.detail == "sources: node_tui_gateway=1"
    assert secret not in rendered
    assert "raw user text" not in rendered


def test_doctor_service_summarizes_session_continuity_without_raw_payload(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    secret = "sk-continuitysecret"
    (traces / "demo-trace.jsonl").write_text(
        "\n".join(
            (
                json.dumps(
                    {
                        "kind": "session_continuity",
                        "turn_id": "resume-branch",
                        "payload": {
                            "action": "resume",
                            "result": "resolved",
                            "requested_session_id": "default",
                            "resolved_session_id": "branch",
                            "lineage_switched": True,
                            "message_count": 3,
                            "fork_point": 2,
                            "pending_decision": True,
                            "pending_clarification": False,
                            "raw_user_text": f"do not print {secret}",
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "session_continuity",
                        "turn_id": "fork-branch",
                        "payload": {
                            "action": "fork",
                            "result": "created",
                            "requested_session_id": "default",
                            "resolved_session_id": "branch",
                            "lineage_switched": True,
                            "message_count": 2,
                            "fork_point": 2,
                            "pending_decision": False,
                            "pending_clarification": False,
                        },
                    }
                ),
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
    rendered = "\n".join(render_doctor_report(report))

    check = next(check for check in report.checks if check.name == "session_continuity")
    assert check.status is DoctorStatus.OK
    assert (
        check.message
        == "continuity_events=2 resume=1 fork=1 lineage_switched=2 pending=1"
    )
    assert check.detail == "results: created=1, resolved=1"
    assert secret not in rendered
    assert "do not print" not in rendered


def test_doctor_service_reports_no_turn_failure_diagnostics_rows_as_ok(
    tmp_path: Path,
) -> None:
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
                json.dumps({"kind": "turn_interrupted", "turn_id": "turn-2", "payload": {}}),
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

    check = next(check for check in report.checks if check.name == "turn_failure_diagnostics")
    assert check.status is DoctorStatus.OK
    assert check.message == "no turn failure diagnostics found"
    assert check.detail == str(traces)


def test_doctor_service_warns_for_turn_failure_diagnostics_without_raw_payload(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    secret = "sk-turnfailuresecret"
    (traces / "demo-trace.jsonl").write_text(
        "\n".join(
            (
                json.dumps(
                    {
                        "kind": "turn_failed",
                        "turn_id": "turn-1",
                        "payload": {
                            "stop_reason": "model_error",
                            "phase": "model_error",
                            "error_type": "ModelResponseError",
                            "message": f"raw provider failure {secret}",
                            "traceback": "Traceback should stay hidden",
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "turn_failed",
                        "turn_id": "turn-2",
                        "payload": {
                            "stop_reason": "runtime_error",
                            "phase": "runtime_error",
                            "error_type": "ValueError",
                            "request": {"Authorization": f"Bearer {secret}"},
                        },
                    }
                ),
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
    rendered = "\n".join(render_doctor_report(report))

    check = next(check for check in report.checks if check.name == "turn_failure_diagnostics")
    assert check.status is DoctorStatus.WARNING
    assert check.message == "2 turn failure diagnostic(s)"
    assert check.detail == (
        "stop_reasons: model_error=1, runtime_error=1; "
        "phases: model_error=1, runtime_error=1"
    )
    assert secret not in rendered
    assert "raw provider failure" not in rendered
    assert "Traceback" not in rendered
    assert "Authorization" not in rendered


def test_doctor_service_summarizes_successful_stream_diagnostics(tmp_path: Path) -> None:
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
                json.dumps(
                    {
                        "kind": "model_stream_diagnostics",
                        "turn_id": "turn-1",
                        "payload": {
                            "success": True,
                            "ttfb_ms": 12,
                            "elapsed_ms": 50,
                            "text_bytes": 20,
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "model_stream_diagnostics",
                        "turn_id": "turn-2",
                        "payload": {
                            "success": True,
                            "ttfb_ms": 30,
                            "elapsed_ms": 40,
                            "text_bytes": 8,
                        },
                    }
                ),
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

    check = next(check for check in report.checks if check.name == "stream_diagnostics")
    assert check.status is DoctorStatus.OK
    assert check.message == (
        "2 stream diagnostic(s), failures=0 "
        "max_ttfb_ms=30 max_elapsed_ms=50 text_bytes=28"
    )
    assert check.detail == str(traces)


def test_doctor_service_warns_for_failed_stream_diagnostics_without_failure_message(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    secret = "sk-streamfailuresecret"
    (traces / "demo-trace.jsonl").write_text(
        "\n".join(
            (
                json.dumps(
                    {
                        "kind": "model_stream_diagnostics",
                        "turn_id": "turn-1",
                        "payload": {
                            "success": False,
                            "ttfb_ms": 12,
                            "elapsed_ms": 50,
                            "text_bytes": 20,
                            "failure_kind": "invalid_stream_event_shape",
                            "failure_message": f"provider leaked {secret}",
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "model_stream_diagnostics",
                        "turn_id": "turn-2",
                        "payload": {
                            "success": False,
                            "ttfb_ms": 14,
                            "elapsed_ms": 60,
                            "text_bytes": 0,
                            "failure_kind": "invalid_stream_event_shape",
                            "failure_message": "another raw provider message",
                        },
                    }
                ),
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
    rendered = "\n".join(render_doctor_report(report))

    check = next(check for check in report.checks if check.name == "stream_diagnostics")
    assert check.status is DoctorStatus.WARNING
    assert check.message == (
        "2 stream diagnostic(s), failures=2 "
        "max_ttfb_ms=14 max_elapsed_ms=60 text_bytes=20"
    )
    assert check.detail == "failure_kinds: invalid_stream_event_shape=2"
    assert secret not in rendered
    assert "provider leaked" not in rendered
    assert "another raw provider message" not in rendered


def test_doctor_service_fails_trace_redaction_scan_without_printing_secret(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    logs = home / ".mycli" / "logs"
    logs.mkdir(parents=True)
    (logs / "agent.log").write_text("", encoding="utf-8")
    (logs / "model-events.jsonl").write_text("", encoding="utf-8")
    (logs / "model-raw").mkdir()
    secret = "trace-token-secret"
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    (traces / "demo-trace.jsonl").write_text(
        json.dumps(
            {
                "kind": "status",
                "turn_id": "turn-1",
                "payload": {
                    "headers": {"Authorization": f"Bearer {secret}"},
                    "nested": [{"token": secret}],
                },
            }
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
    rendered = "\n".join(render_doctor_report(report))

    check = next(check for check in report.checks if check.name == "logs_redaction")
    assert check.status is DoctorStatus.FAILED
    assert check.message == "2 possible secret leak(s) in diagnostic logs/traces"
    assert check.detail == (
        "traces/demo-trace.jsonl:1:$.payload.headers.Authorization, "
        "traces/demo-trace.jsonl:1:$.payload.nested[0].token"
    )
    assert secret not in rendered


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


def test_doctor_service_reports_context_diagnostics_without_raw_content(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    _create_sessions_db(home / ".mycli" / "sessions.db")
    (workspace / ".mycli.md").write_text("Project context safe text.", encoding="utf-8")
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    (traces / "demo.jsonl").write_text(
        "\n".join(
            (
                json.dumps(
                    {
                        "kind": "context_diagnostics",
                        "turn_id": "turn_1",
                        "payload": {
                            "estimated_context_tokens": 123,
                            "context_file": {
                                "blocked": False,
                                "truncated": True,
                            },
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "context_summary_persistence",
                        "turn_id": "turn_1",
                        "payload": {
                            "persisted_count": 2,
                            "duplicate_skipped_count": 1,
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "request_shape",
                        "turn_id": "turn_1",
                        "payload": {
                            "cacheable_prefix_hash": "abc123",
                            "section_boundaries": [
                                {
                                    "fragment_id": "stable:system",
                                    "cache_class": "static",
                                }
                            ],
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "cache_shape_diagnostic",
                        "turn_id": "turn_1",
                        "payload": {
                            "cache_boundary": {
                                "fragment_ids": [
                                    "stable:system",
                                    "stable:workspace_instructions",
                                ],
                                "hash": "abc123",
                                "estimated_tokens": 456,
                            },
                            "metadata": {
                                "fragment_metadata_complete": True,
                                "missing_fragment_metadata": [],
                                "provider_request_policy": {
                                    "wire_cache_hint_enabled": True,
                                    "prompt_cache_key_hash": "hash123",
                                    "prompt_cache_key_preview": "mycli:openai:responses:abcd",
                                    "anthropic_cache_control_breakpoint_count": 2,
                                },
                                "provider_cached_tokens": 64,
                            },
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "context_budget_diagnostic",
                        "turn_id": "turn_1",
                        "payload": {
                            "target_tokens": 1000,
                            "before_tokens": 1500,
                            "after_tokens": 900,
                            "remaining_tokens": 100,
                            "trimmed_section_count": 2,
                            "estimated_saved_tokens": 600,
                            "trimmed_sections": [
                                {
                                    "section_type": "memory",
                                    "reason": "memory_over_budget",
                                    "original_chars": 1000,
                                    "trimmed_chars": 300,
                                    "original_tokens": 250,
                                    "trimmed_tokens": 75,
                                }
                            ],
                        },
                    }
                ),
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

    check = next(check for check in report.checks if check.name == "context")
    rendered = "\n".join(render_doctor_report(report))
    assert check.status is DoctorStatus.OK
    assert "context source=.mycli" in check.message
    assert "context_trace_rows=1" in check.message
    assert "request_shape_rows=1" in check.message
    assert "cache_shape_rows=1" in check.message
    assert "context_budget_rows=1" in check.message
    assert "summary_persisted=2" in check.message
    assert "max_estimated_context_tokens=123" in str(check.detail)
    assert "max_estimated_cacheable_prefix_tokens=456" in str(check.detail)
    assert "max_estimated_budget_saved_tokens=600" in str(check.detail)
    assert "trimmed_context_sections=2" in str(check.detail)
    assert "missing_cache_metadata=0" in str(check.detail)
    assert "stable_prefix_changes=0" in str(check.detail)
    assert "wire_cache_hint_rows=1" in str(check.detail)
    assert "prompt_cache_key_hashes=1" in str(check.detail)
    assert "anthropic_cache_control_breakpoints=2" in str(check.detail)
    assert "max_provider_cached_tokens=64" in str(check.detail)
    assert "summary_duplicates_skipped=1" in str(check.detail)
    assert "Project context safe text" not in rendered


def test_doctor_service_warns_when_cache_shape_metadata_is_missing(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    _create_sessions_db(home / ".mycli" / "sessions.db")
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    (traces / "demo.jsonl").write_text(
        json.dumps(
            {
                "kind": "cache_shape_diagnostic",
                "turn_id": "turn_1",
                "payload": {
                    "cache_boundary": {"estimated_tokens": 12},
                    "metadata": {
                        "fragment_metadata_complete": False,
                        "missing_fragment_metadata": ["stable:workspace_instructions"],
                    },
                },
            }
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

    check = next(check for check in report.checks if check.name == "context")
    rendered = "\n".join(render_doctor_report(report))

    assert check.status is DoctorStatus.WARNING
    assert "cache_shape_rows=1" in check.message
    assert "missing_cache_metadata=1" in str(check.detail)
    assert "stable:workspace_instructions" not in rendered


def test_doctor_service_warns_when_stable_prefix_changes(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    _create_sessions_db(home / ".mycli" / "sessions.db")
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    (traces / "demo.jsonl").write_text(
        "\n".join(
            (
                json.dumps(
                    {
                        "kind": "cache_shape_diagnostic",
                        "turn_id": "turn_1",
                        "payload": {
                            "cache_boundary": {"hash": "stable-before", "estimated_tokens": 12},
                            "first_changed_cache_class": None,
                            "metadata": {
                                "fragment_metadata_complete": True,
                                "missing_fragment_metadata": [],
                            },
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "cache_shape_diagnostic",
                        "turn_id": "turn_2",
                        "payload": {
                            "cache_boundary": {"hash": "stable-after", "estimated_tokens": 12},
                            "first_changed_cache_class": "static",
                            "metadata": {
                                "fragment_metadata_complete": True,
                                "missing_fragment_metadata": [],
                            },
                        },
                    }
                ),
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

    check = next(check for check in report.checks if check.name == "context")
    rendered = "\n".join(render_doctor_report(report))

    assert check.status is DoctorStatus.WARNING
    assert "cache_shape_rows=2" in check.message
    assert "stable_prefix_changes=1" in str(check.detail)
    assert "stable-before" not in rendered
    assert "stable-after" not in rendered


def test_doctor_service_reports_cache_miss_triage_distribution(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    _create_sessions_db(home / ".mycli" / "sessions.db")
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    (traces / "demo.jsonl").write_text(
        "\n".join(
            (
                json.dumps(
                    {
                        "kind": "cache_shape_diagnostic",
                        "turn_id": "turn_1",
                        "payload": {
                            "cache_boundary": {"hash": "hash-1", "estimated_tokens": 12},
                            "first_changed_cache_class": "ephemeral",
                            "metadata": {
                                "fragment_metadata_complete": True,
                                "missing_fragment_metadata": [],
                                "provider_request_policy": {
                                    "wire_cache_hint_enabled": True,
                                    "prompt_cache_key_hash": "key-hash-1",
                                },
                                "provider_cached_tokens": 12,
                            },
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "cache_shape_diagnostic",
                        "turn_id": "turn_2",
                        "payload": {
                            "cache_boundary": {"hash": "hash-1", "estimated_tokens": 12},
                            "first_changed_cache_class": "dynamic",
                            "metadata": {
                                "fragment_metadata_complete": True,
                                "missing_fragment_metadata": [],
                                "provider_request_policy": {
                                    "wire_cache_hint_enabled": False,
                                },
                                "provider_cached_tokens": 20,
                            },
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "cache_shape_diagnostic",
                        "turn_id": "turn_3",
                        "payload": {
                            "cache_boundary": {"hash": "hash-2", "estimated_tokens": 12},
                            "first_changed_cache_class": "static",
                            "metadata": {
                                "fragment_metadata_complete": True,
                                "missing_fragment_metadata": [],
                            },
                        },
                    }
                ),
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

    check = next(check for check in report.checks if check.name == "context")
    rendered = "\n".join(render_doctor_report(report))

    assert check.status is DoctorStatus.WARNING
    assert "first_changed_cache_classes=" in str(check.detail)
    assert "dynamic=1" in str(check.detail)
    assert "ephemeral=1" in str(check.detail)
    assert "static=1" in str(check.detail)
    assert "dynamic_changes=1" in str(check.detail)
    assert "ephemeral_changes=1" in str(check.detail)
    assert "wire_cache_hint_enabled=1" in str(check.detail)
    assert "wire_cache_hint_disabled=1" in str(check.detail)
    assert "wire_cache_hint_missing=1" in str(check.detail)
    assert "latest_provider_cached_tokens=20" in str(check.detail)
    assert "max_provider_cached_tokens=20" in str(check.detail)
    assert "remediation=stable prefix changed; inspect static context/tool schema" in str(
        check.detail
    )
    assert "hash-1" not in rendered
    assert "hash-2" not in rendered


def test_doctor_service_reports_cache_policy_validation_states(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    _create_sessions_db(home / ".mycli" / "sessions.db")
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    (traces / "demo.jsonl").write_text(
        "\n".join(
            (
                json.dumps(
                    {
                        "kind": "cache_shape_diagnostic",
                        "turn_id": "turn_enabled",
                        "payload": {
                            "cache_boundary": {"hash": "hash-enabled"},
                            "metadata": {
                                "fragment_metadata_complete": True,
                                "missing_fragment_metadata": [],
                                "provider_request_policy": {
                                    "wire_hint_state": "enabled_and_emitted",
                                    "wire_cache_hint_enabled": True,
                                    "prompt_cache_key_hash": "key-hash",
                                },
                                "provider_cache_usage": {
                                    "cached_tokens": 25,
                                    "telemetry_status": "present",
                                },
                            },
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "cache_shape_diagnostic",
                        "turn_id": "turn_disabled",
                        "payload": {
                            "cache_boundary": {"hash": "hash-disabled"},
                            "metadata": {
                                "fragment_metadata_complete": True,
                                "missing_fragment_metadata": [],
                                "provider_request_policy": {
                                    "wire_hint_state": "disabled_by_policy",
                                    "wire_cache_hint_enabled": False,
                                },
                                "provider_cache_usage": {
                                    "cached_tokens": 0,
                                    "telemetry_status": "missing",
                                },
                            },
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "cache_shape_diagnostic",
                        "turn_id": "turn_missing",
                        "payload": {
                            "cache_boundary": {"hash": "hash-missing"},
                            "metadata": {
                                "fragment_metadata_complete": True,
                                "missing_fragment_metadata": [],
                                "provider_request_policy": {
                                    "wire_hint_state": "enabled_but_missing",
                                    "wire_cache_hint_enabled": None,
                                },
                            },
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "cache_shape_diagnostic",
                        "turn_id": "turn_unsupported",
                        "payload": {
                            "cache_boundary": {"hash": "hash-unsupported"},
                            "metadata": {
                                "fragment_metadata_complete": True,
                                "missing_fragment_metadata": [],
                                "provider_request_policy": {
                                    "wire_hint_state": "unsupported",
                                    "wire_cache_hint_enabled": False,
                                    "provider_family": "deepseek",
                                    "cache_strategy": "automatic_prefix_cache",
                                },
                            },
                        },
                    }
                ),
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

    check = next(check for check in report.checks if check.name == "context")
    rendered = "\n".join(render_doctor_report(report))

    assert check.status is DoctorStatus.WARNING
    assert "wire_hint_enabled_and_emitted=1" in str(check.detail)
    assert "wire_hint_disabled_by_policy=1" in str(check.detail)
    assert "wire_hint_enabled_but_missing=1" in str(check.detail)
    assert "wire_hint_unsupported=1" in str(check.detail)
    assert "automatic_prefix_cache=1" in str(check.detail)
    assert "cache_usage_telemetry_missing=1" in str(check.detail)
    assert "max_provider_cached_tokens=25" in str(check.detail)
    assert "hash-enabled" not in rendered
    assert "key-hash" not in rendered


def test_doctor_service_reports_recovery_diagnostics_without_raw_provider_text(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()
    _write_project_config(workspace)
    _create_sessions_db(home / ".mycli" / "sessions.db")
    traces = home / ".mycli" / "traces"
    traces.mkdir(parents=True)
    (traces / "demo.jsonl").write_text(
        "\n".join(
            (
                json.dumps(
                    {
                        "kind": "recovery_diagnostic",
                        "turn_id": "turn_1",
                        "payload": {
                            "error_class": "invalid_encrypted_content",
                            "action": "strip_encrypted_reasoning_retry",
                            "will_retry": True,
                            "attempt": 1,
                            "max_attempts": 1,
                            "encrypted_content": "opaque-provider-state",
                            "raw_message": "sk-do-not-print",
                        },
                    }
                ),
                json.dumps(
                    {
                        "kind": "recovery_diagnostic",
                        "turn_id": "turn_2",
                        "payload": {
                            "error_class": "schema_rejected",
                            "action": "surface_only",
                            "will_retry": False,
                            "attempt": 0,
                            "max_attempts": 0,
                            "request_payload": {"secret": "value"},
                        },
                    }
                ),
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

    check = next(check for check in report.checks if check.name == "context")
    rendered = "\n".join(render_doctor_report(report))

    assert check.status is DoctorStatus.WARNING
    assert "recovery_rows=2" in str(check.detail)
    assert "recovery_retries=1" in str(check.detail)
    assert "latest_recovery=error_class=schema_rejected action=surface_only will_retry=false" in str(
        check.detail
    )
    assert "invalid_encrypted_content=1" in str(check.detail)
    assert "schema_rejected=1" in str(check.detail)
    assert "strip_encrypted_reasoning_retry=1" in str(check.detail)
    assert "surface_only=1" in str(check.detail)
    assert "opaque-provider-state" not in rendered
    assert "sk-do-not-print" not in rendered
    assert "request_payload" not in rendered


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
