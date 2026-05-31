from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from enum import StrEnum
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3

from mycli.config.settings import resolve_config
from mycli.domain.runtime.tracing import RuntimeTraceEvent
from mycli.services.mcp.client import load_mcp_server_configs
from mycli.services.storage_layout import MycliStorageLayout

_TRACE_SCAN_LIMIT = 50
_TRACE_DETAIL_LIMIT = 3
_SESSION_DB_DETAIL_LIMIT = 3
_SESSION_DB_REQUIRED_TABLES = {
    "sessions",
    "conversation_messages",
    "conversation_trees",
    "history_items",
    "turn_rollouts",
    "session_state",
    "session_summaries",
}
_SESSION_DB_CHILD_TABLES = (
    "conversation_messages",
    "conversation_trees",
    "history_items",
    "turn_rollouts",
    "session_state",
    "session_summaries",
)


@dataclass(frozen=True, slots=True)
class _NodeTuiDependencyConfig:
    required_paths: tuple[str, ...]
    install_command: str
    cleanup_command: str


class DoctorStatus(StrEnum):
    OK = "ok"
    WARNING = "warning"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class DoctorCheck:
    name: str
    status: DoctorStatus
    message: str
    detail: str | None = None


@dataclass(frozen=True, slots=True)
class DoctorReport:
    checks: tuple[DoctorCheck, ...]

    @property
    def ok_count(self) -> int:
        return self._count(DoctorStatus.OK)

    @property
    def warning_count(self) -> int:
        return self._count(DoctorStatus.WARNING)

    @property
    def failed_count(self) -> int:
        return self._count(DoctorStatus.FAILED)

    def _count(self, status: DoctorStatus) -> int:
        return sum(1 for check in self.checks if check.status is status)


WhichFunc = Callable[[str], str | None]
ImportChecker = Callable[[str], bool]


class DoctorService:
    def __init__(
        self,
        *,
        workspace_root: Path,
        home_dir: Path,
        env: Mapping[str, str],
        which: WhichFunc | None = None,
        import_checker: ImportChecker | None = None,
    ) -> None:
        self._workspace_root = workspace_root
        self._home_dir = home_dir
        self._env = env
        self._layout = MycliStorageLayout.from_home_dir(home_dir)
        self._which = which or shutil.which
        self._import_checker = import_checker or _can_import

    def run(self) -> DoctorReport:
        checks: list[DoctorCheck] = []
        for collector in (
            self._check_config,
            self._check_sessions_db,
            self._check_logs,
            self._check_storage_layout,
            self._check_traces,
            self._check_file_history,
            self._check_tui,
            self._check_mcp,
        ):
            try:
                checks.extend(collector())
            except Exception as exc:  # pragma: no cover - defensive boundary
                checks.append(
                    DoctorCheck(
                        collector.__name__.removeprefix("_check_"),
                        DoctorStatus.FAILED,
                        f"diagnostic failed: {exc}",
                    )
                )
        return DoctorReport(checks=tuple(checks))

    def _check_config(self) -> Iterable[DoctorCheck]:
        try:
            config = resolve_config(
                cli_args={"session": "doctor", "model": None},
                env=self._env,
                cwd=self._workspace_root,
                home=self._home_dir,
            )
        except Exception as exc:
            return (
                DoctorCheck("config", DoctorStatus.FAILED, f"configuration invalid: {exc}"),
                DoctorCheck("api_key", DoctorStatus.WARNING, "api_key: unknown"),
            )
        checks = [
            DoctorCheck(
                "config",
                DoctorStatus.OK,
                " ".join(
                    (
                        f"provider={config.provider.value}",
                        f"protocol={config.protocol.value}",
                        f"model={config.model}",
                        f"base_url={config.api_base_url}",
                    )
                ),
            )
        ]
        if config.api_key:
            checks.append(DoctorCheck("api_key", DoctorStatus.OK, "api_key: present"))
        else:
            checks.append(DoctorCheck("api_key", DoctorStatus.WARNING, "api_key: missing"))
        return tuple(checks)

    def _check_sessions_db(self) -> Iterable[DoctorCheck]:
        path = self._layout.sessions_db_path
        if not path.exists():
            return (DoctorCheck("sessions_db", DoctorStatus.WARNING, f"missing {path}"),)
        try:
            with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as connection:
                connection.row_factory = sqlite3.Row
                connection.execute("PRAGMA foreign_keys = ON")
                rows = connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
                present_tables = {str(row[0]) for row in rows}
                missing_tables = sorted(_SESSION_DB_REQUIRED_TABLES - present_tables)
                if missing_tables:
                    return (
                        DoctorCheck(
                            "sessions_db",
                            DoctorStatus.FAILED,
                            f"missing tables: {', '.join(missing_tables)}",
                            detail=str(path),
                        ),
                    )
                integrity_problem = _session_db_integrity_problem(connection)
        except sqlite3.Error as exc:
            return (DoctorCheck("sessions_db", DoctorStatus.FAILED, f"not openable: {exc}"),)

        if integrity_problem is not None:
            return (
                DoctorCheck(
                    "sessions_db",
                    DoctorStatus.FAILED,
                    integrity_problem,
                    detail=str(path),
                ),
            )
        return (DoctorCheck("sessions_db", DoctorStatus.OK, f"openable {path}"),)

    def _check_logs(self) -> Iterable[DoctorCheck]:
        logs_dir = self._layout.logs_dir
        if not logs_dir.exists():
            return (DoctorCheck("logs", DoctorStatus.WARNING, f"missing {logs_dir}"),)
        if not logs_dir.is_dir():
            return (DoctorCheck("logs", DoctorStatus.FAILED, f"not a directory {logs_dir}"),)
        required_paths = ("agent.log", "model-events.jsonl", "model-raw")
        missing = [name for name in required_paths if not (logs_dir / name).exists()]
        status = DoctorStatus.WARNING if missing else DoctorStatus.OK
        message = "logs present"
        if missing:
            message = f"logs missing: {', '.join(missing)}"
        if not _is_writable(logs_dir):
            return (
                DoctorCheck(
                    "logs",
                    DoctorStatus.FAILED,
                    f"{message}; logs dir is not writable",
                    detail=str(logs_dir),
                ),
            )
        return (DoctorCheck("logs", status, message, detail=str(logs_dir)),)

    def _check_storage_layout(self) -> Iterable[DoctorCheck]:
        reserved_dirs = {
            "traces": self._layout.traces_dir,
            "artifacts": self._layout.artifacts_dir,
        }
        conflicts = [
            f"{name} is not a directory: {path}"
            for name, path in reserved_dirs.items()
            if path.exists() and not path.is_dir()
        ]
        if conflicts:
            return (
                DoctorCheck(
                    "storage_layout",
                    DoctorStatus.FAILED,
                    "; ".join(conflicts),
                    detail=str(self._layout.root),
                ),
            )
        not_writable = [
            f"{name} is not writable: {path}"
            for name, path in reserved_dirs.items()
            if path.exists() and not _is_writable(path)
        ]
        if not_writable:
            return (
                DoctorCheck(
                    "storage_layout",
                    DoctorStatus.FAILED,
                    "; ".join(not_writable),
                    detail=str(self._layout.root),
                ),
            )
        existing = [name for name, path in reserved_dirs.items() if path.exists()]
        if existing:
            message = f"reserved paths usable: {', '.join(existing)}"
        else:
            message = "reserved paths available"
        return (DoctorCheck("storage_layout", DoctorStatus.OK, message, detail=str(self._layout.root)),)

    def _check_traces(self) -> Iterable[DoctorCheck]:
        traces_dir = self._layout.traces_dir
        if not traces_dir.exists():
            return (DoctorCheck("traces", DoctorStatus.OK, "trace directory not created yet"),)
        if not traces_dir.is_dir():
            return (DoctorCheck("traces", DoctorStatus.FAILED, f"not a directory {traces_dir}"),)

        trace_paths = sorted(traces_dir.glob("*.jsonl"))
        if not trace_paths:
            return (DoctorCheck("traces", DoctorStatus.OK, "no trace files found", detail=str(traces_dir)),)

        inspected_paths = trace_paths[:_TRACE_SCAN_LIMIT]
        total_valid_rows = 0
        invalid_rows: list[str] = []
        unreadable: list[str] = []
        for path in inspected_paths:
            try:
                valid_count, invalid_lines = _inspect_trace_file(path)
            except OSError as exc:
                unreadable.append(f"{path.name}: {exc}")
                continue
            total_valid_rows += valid_count
            invalid_rows.extend(f"{path.name}:{line_no}" for line_no in invalid_lines)

        suffix = ""
        if len(trace_paths) > len(inspected_paths):
            suffix = f"; scanned first {len(inspected_paths)} of {len(trace_paths)} files"

        if unreadable:
            detail = "; ".join(unreadable[:_TRACE_DETAIL_LIMIT])
            return (
                DoctorCheck(
                    "traces",
                    DoctorStatus.FAILED,
                    f"{len(unreadable)} trace file(s) unreadable{suffix}",
                    detail=detail,
                ),
            )
        if invalid_rows:
            detail = ", ".join(invalid_rows[:_TRACE_DETAIL_LIMIT])
            if len(invalid_rows) > _TRACE_DETAIL_LIMIT:
                detail = f"{detail}, ..."
            return (
                DoctorCheck(
                    "traces",
                    DoctorStatus.WARNING,
                    f"{len(invalid_rows)} invalid trace row(s); {total_valid_rows} valid row(s){suffix}",
                    detail=detail,
                ),
            )
        return (
            DoctorCheck(
                "traces",
                DoctorStatus.OK,
                f"{len(inspected_paths)} trace file(s), {total_valid_rows} valid row(s){suffix}",
                detail=str(traces_dir),
            ),
        )

    def _check_file_history(self) -> Iterable[DoctorCheck]:
        history_root = self._layout.root / "file-history"
        if not history_root.exists():
            return (DoctorCheck("file_history", DoctorStatus.WARNING, f"missing {history_root}"),)
        index_paths = sorted(history_root.glob("*/index.json"))
        if not index_paths:
            return (
                DoctorCheck(
                    "file_history",
                    DoctorStatus.WARNING,
                    f"no index.json files under {history_root}",
                ),
            )
        try:
            with index_paths[0].open("r", encoding="utf-8") as handle:
                json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            return (
                DoctorCheck(
                    "file_history",
                    DoctorStatus.FAILED,
                    f"index not parseable: {exc}",
                    detail=str(index_paths[0]),
                ),
            )
        return (
            DoctorCheck(
                "file_history",
                DoctorStatus.OK,
                f"{len(index_paths)} index file(s) found",
                detail=str(history_root),
            ),
        )

    def _check_tui(self) -> Iterable[DoctorCheck]:
        checks: list[DoctorCheck] = []
        if self._import_checker("mycli.cli.tui"):
            checks.append(DoctorCheck("python_tui", DoctorStatus.OK, "mycli.cli.tui importable"))
        else:
            checks.append(
                DoctorCheck("python_tui", DoctorStatus.WARNING, "mycli.cli.tui not importable")
            )
        node_tui_root = _node_tui_source_root()
        if node_tui_root.exists():
            checks.append(DoctorCheck("node_tui", DoctorStatus.OK, f"source present {node_tui_root}"))
            dependency_config = _node_tui_dependency_config(node_tui_root)
            missing_markers = [
                marker
                for marker in dependency_config.required_paths
                if not (node_tui_root / marker).exists()
            ]
            if not missing_markers:
                checks.append(
                    DoctorCheck(
                        "node_tui_dependencies",
                        DoctorStatus.OK,
                        "required Node TUI dependencies present",
                        detail=str(node_tui_root / "node_modules"),
                    )
                )
            else:
                node_modules = node_tui_root / "node_modules"
                state = "incomplete" if node_modules.exists() else "missing"
                detail = ", ".join(missing_markers[:3])
                if len(missing_markers) > 3:
                    detail = f"{detail}, ..."
                cleanup = (
                    "; if a previous install was interrupted, run: "
                    f"{dependency_config.cleanup_command}"
                    if state == "incomplete"
                    else ""
                )
                checks.append(
                    DoctorCheck(
                        "node_tui_dependencies",
                        DoctorStatus.WARNING,
                        (
                            f"Node TUI dependencies {state}; "
                            f"run: {dependency_config.install_command}{cleanup}"
                        ),
                        detail=detail,
                    )
                )
        else:
            checks.append(
                DoctorCheck(
                    "node_tui",
                    DoctorStatus.WARNING,
                    f"missing source {node_tui_root}",
                )
            )
        for command in ("node", "npm"):
            resolved = self._which(command)
            if resolved:
                checks.append(DoctorCheck(command, DoctorStatus.OK, f"{command}: {resolved}"))
            else:
                checks.append(DoctorCheck(command, DoctorStatus.WARNING, f"{command}: not found"))
        return tuple(checks)

    def _check_mcp(self) -> Iterable[DoctorCheck]:
        try:
            configs = load_mcp_server_configs(self._workspace_root, environ=self._env)
        except Exception as exc:
            return (DoctorCheck("mcp", DoctorStatus.FAILED, f"mcp config invalid: {exc}"),)
        enabled_count = sum(1 for config in configs.values() if config.enabled)
        return (
            DoctorCheck(
                "mcp",
                DoctorStatus.OK,
                f"mcp: {len(configs)} configured, {enabled_count} enabled",
            ),
        )


def render_doctor_report(report: DoctorReport) -> tuple[str, ...]:
    lines = ["mycli doctor"]
    for check in report.checks:
        marker = _status_marker(check.status)
        line = f"{marker} {check.name}: {check.message}"
        if check.detail:
            line = f"{line} ({check.detail})"
        lines.append(line)
    lines.append(
        "Summary: "
        f"{report.ok_count} ok, "
        f"{report.warning_count} warning, "
        f"{report.failed_count} failed"
    )
    return tuple(lines)


def _status_marker(status: DoctorStatus) -> str:
    if status is DoctorStatus.OK:
        return "[OK]"
    if status is DoctorStatus.WARNING:
        return "[WARN]"
    return "[FAIL]"


def _can_import(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


def _node_tui_source_root() -> Path:
    return Path(__file__).resolve().parents[4] / "tui" / "node"


def _node_tui_dependency_config(node_tui_root: Path) -> _NodeTuiDependencyConfig:
    config_path = node_tui_root / "dependency-markers.json"
    fallback = _NodeTuiDependencyConfig(
        required_paths=(
            "node_modules/.bin/tsx",
            "node_modules/.bin/tsc",
            "node_modules/ink",
            "node_modules/react",
            "node_modules/tsx",
            "node_modules/typescript",
        ),
        install_command="npm --prefix tui/node ci",
        cleanup_command="rm -rf tui/node/node_modules",
    )
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback
    required_paths = payload.get("required_paths")
    if not isinstance(required_paths, list) or not required_paths:
        return fallback
    return _NodeTuiDependencyConfig(
        required_paths=tuple(str(path) for path in required_paths),
        install_command=str(payload.get("install_command") or fallback.install_command),
        cleanup_command=str(payload.get("cleanup_command") or fallback.cleanup_command),
    )


def _inspect_trace_file(path: Path) -> tuple[int, tuple[int, ...]]:
    valid_count = 0
    invalid_lines: list[int] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                invalid_lines.append(line_number)
                continue
            if not isinstance(payload, dict):
                invalid_lines.append(line_number)
                continue
            try:
                RuntimeTraceEvent.from_dict(payload)
            except (KeyError, TypeError, ValueError):
                invalid_lines.append(line_number)
                continue
            valid_count += 1
    return valid_count, tuple(invalid_lines)


def _session_db_integrity_problem(connection: sqlite3.Connection) -> str | None:
    foreign_key_violations = connection.execute("PRAGMA foreign_key_check").fetchall()
    if foreign_key_violations:
        details = _format_row_references(
            tuple(
                f"{row['table']}#{row['rowid']}"
                for row in foreign_key_violations
                if "table" in row.keys() and "rowid" in row.keys()
            )
        )
        return f"{len(foreign_key_violations)} foreign key violation(s){details}"

    orphan_details = _session_db_orphan_details(connection)
    if orphan_details:
        return f"orphan session rows: {', '.join(orphan_details)}"

    missing_parent_details = _session_db_missing_parent_details(connection)
    if missing_parent_details:
        return f"missing lineage parents: {', '.join(missing_parent_details)}"

    cycle_session = _session_db_lineage_cycle(connection)
    if cycle_session is not None:
        return f"conversation lineage cycle detected at {cycle_session}"

    invalid_fork_details = _session_db_invalid_fork_details(connection)
    if invalid_fork_details:
        return f"invalid fork points: {', '.join(invalid_fork_details)}"

    return None


def _session_db_orphan_details(connection: sqlite3.Connection) -> list[str]:
    details: list[str] = []
    for table in _SESSION_DB_CHILD_TABLES:
        rows = connection.execute(
            f"""
            SELECT COUNT(*) AS count
            FROM {table}
            LEFT JOIN sessions ON sessions.session_id = {table}.session_id
            WHERE sessions.session_id IS NULL
            """
        ).fetchone()
        count = int(rows["count"]) if rows is not None else 0
        if count:
            details.append(f"{table}={count}")
            if len(details) >= _SESSION_DB_DETAIL_LIMIT:
                break
    return details


def _session_db_missing_parent_details(connection: sqlite3.Connection) -> list[str]:
    rows = connection.execute(
        """
        SELECT conversation_trees.session_id, conversation_trees.parent_id
        FROM conversation_trees
        LEFT JOIN sessions
            ON sessions.session_id = conversation_trees.parent_id
        WHERE conversation_trees.parent_id IS NOT NULL
            AND conversation_trees.parent_id != ''
            AND sessions.session_id IS NULL
        ORDER BY conversation_trees.session_id
        LIMIT ?
        """,
        (_SESSION_DB_DETAIL_LIMIT,),
    ).fetchall()
    return [f"{row['session_id']}->{row['parent_id']}" for row in rows]


def _session_db_lineage_cycle(connection: sqlite3.Connection) -> str | None:
    parent_rows = connection.execute(
        """
        SELECT session_id, parent_id
        FROM conversation_trees
        WHERE parent_id IS NOT NULL AND parent_id != ''
        """
    ).fetchall()
    parents = {str(row["session_id"]): str(row["parent_id"]) for row in parent_rows}
    for session_id in sorted(parents):
        current = session_id
        seen: set[str] = set()
        for _ in range(len(parents) + 1):
            if current in seen:
                return current
            seen.add(current)
            parent_id = parents.get(current)
            if parent_id is None:
                break
            current = parent_id
    return None


def _session_db_invalid_fork_details(connection: sqlite3.Connection) -> list[str]:
    rows = connection.execute(
        """
        SELECT
            conversation_trees.session_id AS session_id,
            conversation_trees.fork_point AS fork_point,
            COUNT(conversation_messages.message_index) AS message_count
        FROM conversation_trees
        LEFT JOIN conversation_messages
            ON conversation_messages.session_id = conversation_trees.session_id
        WHERE conversation_trees.fork_point IS NOT NULL
        GROUP BY conversation_trees.session_id, conversation_trees.fork_point
        ORDER BY conversation_trees.session_id
        """
    ).fetchall()
    details: list[str] = []
    for row in rows:
        fork_point = int(row["fork_point"])
        message_count = int(row["message_count"])
        if fork_point < 0 or fork_point > message_count:
            details.append(f"{row['session_id']}={fork_point}/{message_count}")
            if len(details) >= _SESSION_DB_DETAIL_LIMIT:
                break
    return details


def _format_row_references(references: tuple[str, ...]) -> str:
    if not references:
        return ""
    detail = ", ".join(references[:_SESSION_DB_DETAIL_LIMIT])
    if len(references) > _SESSION_DB_DETAIL_LIMIT:
        detail = f"{detail}, ..."
    return f": {detail}"


def _is_writable(path: Path) -> bool:
    return path.exists() and path.is_dir() and path.stat().st_mode & 0o222 != 0


__all__ = [
    "DoctorCheck",
    "DoctorReport",
    "DoctorService",
    "DoctorStatus",
    "render_doctor_report",
]
