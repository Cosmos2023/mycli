from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from enum import StrEnum
import importlib.util
import json
from pathlib import Path
import re
import shutil
import sqlite3

from mycli.config.settings import resolve_config
from mycli.cli.node_tui.gateway import supported_event_streams, supported_rpc_methods
from mycli.domain.runtime.tracing import RuntimeTraceEvent
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore
from mycli.services.extensions import ExtensionManifestService
from mycli.services.mcp.client import load_mcp_server_configs
from mycli.services.storage_layout import MycliStorageLayout

_TRACE_SCAN_LIMIT = 50
_TRACE_DETAIL_LIMIT = 3
_LOG_REDACTION_TEXT_BYTES = 512_000
_LOG_REDACTION_RAW_FILE_LIMIT = 20
_LOG_REDACTION_DETAIL_LIMIT = 3
_LOG_SECRET_PATTERNS = (
    re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{6,}\b"),
    re.compile(r"(?i)\bBearer\s+(?!\[REDACTED\]\b)[A-Za-z0-9_./+=:-]{6,}\b"),
    re.compile(
        r"(?i)\b[A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_.-]*"
        r"\s*[:=]\s*[\"']?(?!\[REDACTED\][\"']?(?:\s|$|[,;}]))[^\"'\s,;}]{6,}"
    ),
)
_SESSION_DB_DETAIL_LIMIT = 3
_SESSION_DB_REQUIRED_TABLES = {
    "schema_version",
    "sessions",
    "conversation_messages",
    "conversation_trees",
    "history_items",
    "turn_rollouts",
    "session_state",
    "session_summaries",
}
_SESSION_DB_REQUIRED_SEARCH_OBJECTS = {
    "conversation_messages_fts": "table",
    "conversation_messages_fts_insert": "trigger",
    "conversation_messages_fts_delete": "trigger",
    "conversation_messages_fts_update": "trigger",
}
_SESSION_DB_CHILD_TABLES = (
    "conversation_messages",
    "conversation_trees",
    "history_items",
    "turn_rollouts",
    "session_state",
    "session_summaries",
)
_SESSION_DB_RECOVERY_STATE_KEYS = {
    "pending_decision",
    "responses_continuation_state",
    "suspended_turn",
    "turn_record",
}
_RUNTIME_CONTRACT_REQUIRED_STREAMS = {
    "approval.request",
    "clarify.request",
    "message.complete",
    "message.delta",
    "runtime.event",
    "tool.complete",
    "tool.failed",
    "tool.start",
    "turn.status",
}


@dataclass(frozen=True, slots=True)
class _NodeTuiDependencyConfig:
    required_paths: tuple[str, ...]
    install_command: str
    cleanup_command: str


@dataclass(frozen=True, slots=True)
class _LogRedactionScanResult:
    files_scanned: int
    leaks: tuple[str, ...]


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
            self._check_logs_redaction,
            self._check_storage_layout,
            self._check_traces,
            self._check_file_history,
            self._check_tui,
            self._check_runtime_contract,
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

    def _check_logs_redaction(self) -> Iterable[DoctorCheck]:
        logs_dir = self._layout.logs_dir
        if not logs_dir.exists() or not logs_dir.is_dir():
            return ()
        try:
            scan_result = _scan_logs_for_secret_leaks(logs_dir)
        except OSError as exc:
            return (
                DoctorCheck(
                    "logs_redaction",
                    DoctorStatus.FAILED,
                    f"log redaction scan failed: {exc}",
                    detail=str(logs_dir),
                ),
            )
        if scan_result.leaks:
            detail = ", ".join(scan_result.leaks[:_LOG_REDACTION_DETAIL_LIMIT])
            if len(scan_result.leaks) > _LOG_REDACTION_DETAIL_LIMIT:
                detail = f"{detail}, ..."
            return (
                DoctorCheck(
                    "logs_redaction",
                    DoctorStatus.FAILED,
                    f"{len(scan_result.leaks)} possible secret leak(s) in diagnostic logs",
                    detail=detail,
                ),
            )
        return (
            DoctorCheck(
                "logs_redaction",
                DoctorStatus.OK,
                f"scanned {scan_result.files_scanned} log file(s) for obvious secrets",
                detail=str(logs_dir),
            ),
        )

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

    def _check_runtime_contract(self) -> Iterable[DoctorCheck]:
        manifest = ExtensionManifestService().manifest()
        rpc_methods = _manifest_named_entries(manifest.get("rpc_methods"))
        event_streams = _manifest_named_entries(manifest.get("event_streams"))
        expected_rpc_methods = supported_rpc_methods()
        expected_event_streams = supported_event_streams()

        rpc_message = _set_mismatch_message(
            "manifest RPC mismatch",
            expected=expected_rpc_methods,
            actual=rpc_methods,
        )
        event_message = _set_mismatch_message(
            "event streams mismatch",
            expected=expected_event_streams,
            actual=event_streams,
        )
        required_stream_message = (
            None
            if event_message is not None
            else _set_mismatch_message(
                "required streams missing",
                expected=_RUNTIME_CONTRACT_REQUIRED_STREAMS,
                actual=event_streams,
                include_extra=False,
            )
        )
        problems = [
            message
            for message in (rpc_message, event_message, required_stream_message)
            if message is not None
        ]
        if problems:
            return (
                DoctorCheck(
                    "runtime_contract",
                    DoctorStatus.FAILED,
                    problems[0],
                    detail="; ".join(problems[1:]) if len(problems) > 1 else None,
                ),
            )
        return (
            DoctorCheck(
                "runtime_contract",
                DoctorStatus.OK,
                "gateway manifest matches supported contract",
                detail=f"{len(rpc_methods)} rpc method(s), {len(event_streams)} event stream(s)",
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


def _manifest_named_entries(value: object) -> set[str]:
    if not isinstance(value, list):
        return set()
    names: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if isinstance(name, str) and name:
            names.add(name)
    return names


def _set_mismatch_message(
    label: str,
    *,
    expected: set[str] | frozenset[str],
    actual: set[str],
    include_extra: bool = True,
) -> str | None:
    missing = sorted(set(expected) - actual)
    extra = sorted(actual - set(expected)) if include_extra else []
    parts: list[str] = []
    if missing:
        parts.append(f"missing {_bounded_name_list(missing)}")
    if extra:
        parts.append(f"extra {_bounded_name_list(extra)}")
    if not parts:
        return None
    return f"{label}: {'; '.join(parts)}"


def _bounded_name_list(names: list[str]) -> str:
    if len(names) <= _SESSION_DB_DETAIL_LIMIT:
        return ", ".join(names)
    return f"{', '.join(names[:_SESSION_DB_DETAIL_LIMIT])}, ..."


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


def _scan_logs_for_secret_leaks(logs_dir: Path) -> _LogRedactionScanResult:
    paths = _log_redaction_scan_paths(logs_dir)
    leaks: list[str] = []
    for path in paths:
        relative = path.relative_to(logs_dir)
        if path.suffix == ".json":
            leaks.extend(f"{relative}:{reference}" for reference in _json_secret_references(path))
        else:
            leaks.extend(f"{relative}:{line_no}" for line_no in _text_secret_line_numbers(path))
        if len(leaks) >= _LOG_REDACTION_DETAIL_LIMIT:
            break
    return _LogRedactionScanResult(files_scanned=len(paths), leaks=tuple(leaks))


def _log_redaction_scan_paths(logs_dir: Path) -> tuple[Path, ...]:
    paths: list[Path] = []
    for name in ("agent.log", "errors.log", "model-events.jsonl"):
        path = logs_dir / name
        if path.exists() and path.is_file():
            paths.append(path)
    raw_root = logs_dir / "model-raw"
    if raw_root.exists() and raw_root.is_dir():
        paths.extend(sorted(raw_root.glob("*/*.json"))[:_LOG_REDACTION_RAW_FILE_LIMIT])
    return tuple(paths)


def _text_secret_line_numbers(path: Path) -> tuple[int, ...]:
    matches: list[int] = []
    bytes_read = 0
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line_number, line in enumerate(handle, start=1):
            bytes_read += len(line.encode("utf-8", errors="replace"))
            if _contains_probable_secret(line):
                matches.append(line_number)
                if len(matches) >= _LOG_REDACTION_DETAIL_LIMIT:
                    break
            if bytes_read >= _LOG_REDACTION_TEXT_BYTES:
                break
    return tuple(matches)


def _json_secret_references(path: Path) -> tuple[str, ...]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError:
        return _text_secret_line_numbers(path)
    matches = list(_iter_json_secret_references(payload))
    return tuple(matches[:_LOG_REDACTION_DETAIL_LIMIT])


def _iter_json_secret_references(payload: object, *, path: str = "$") -> Iterable[str]:
    if isinstance(payload, dict):
        for key, value in payload.items():
            key_text = str(key)
            child_path = f"{path}.{key_text}"
            if _is_sensitive_log_key(key_text) and _json_value_contains_unredacted_secret(value):
                yield child_path
                continue
            yield from _iter_json_secret_references(value, path=child_path)
    elif isinstance(payload, list):
        for index, value in enumerate(payload):
            yield from _iter_json_secret_references(value, path=f"{path}[{index}]")
    elif isinstance(payload, str) and _contains_probable_secret(payload):
        yield path


def _json_value_contains_unredacted_secret(value: object) -> bool:
    if isinstance(value, str):
        return value not in {"", "[REDACTED]", "Bearer [REDACTED]"}
    if isinstance(value, (dict, list)):
        return any(True for _ in _iter_json_secret_references(value))
    return False


def _contains_probable_secret(value: str) -> bool:
    return any(pattern.search(value) is not None for pattern in _LOG_SECRET_PATTERNS)


def _is_sensitive_log_key(key: str) -> bool:
    normalized = key.strip().lower().replace("-", "_")
    if normalized in {
        "authorization",
        "api_key",
        "apikey",
        "x_api_key",
        "token",
        "access_token",
        "refresh_token",
        "secret",
        "password",
    }:
        return True
    return any(part in normalized for part in ("api_key", "apikey", "token", "secret", "password"))


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

    schema_version_problem = _session_db_schema_version_problem(connection)
    if schema_version_problem is not None:
        return schema_version_problem

    missing_search_objects = _session_db_missing_search_objects(connection)
    if missing_search_objects:
        return f"missing search objects: {', '.join(missing_search_objects)}"

    missing_parent_details = _session_db_missing_parent_details(connection)
    if missing_parent_details:
        return f"missing lineage parents: {', '.join(missing_parent_details)}"

    cycle_session = _session_db_lineage_cycle(connection)
    if cycle_session is not None:
        return f"conversation lineage cycle detected at {cycle_session}"

    invalid_fork_details = _session_db_invalid_fork_details(connection)
    if invalid_fork_details:
        return f"invalid fork points: {', '.join(invalid_fork_details)}"

    invalid_recovery_state_details = _session_db_invalid_recovery_state_details(connection)
    if invalid_recovery_state_details:
        return f"invalid recovery state payloads: {', '.join(invalid_recovery_state_details)}"

    return None


def _session_db_schema_version_problem(connection: sqlite3.Connection) -> str | None:
    rows = connection.execute("SELECT version FROM schema_version").fetchall()
    if not rows:
        return "schema version missing"
    versions: list[int] = []
    for row in rows:
        try:
            versions.append(int(row["version"]))
        except (TypeError, ValueError):
            return "schema version invalid"
    expected = SQLiteSessionStore.SCHEMA_VERSION
    if len(versions) != 1 or versions[0] != expected:
        found = ", ".join(str(version) for version in versions) if versions else "none"
        return f"schema version mismatch: expected {expected}, found {found}"
    return None


def _session_db_missing_search_objects(connection: sqlite3.Connection) -> list[str]:
    details: list[str] = []
    for name, object_type in sorted(_SESSION_DB_REQUIRED_SEARCH_OBJECTS.items()):
        row = connection.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE name = ? AND type = ?
            """,
            (name, object_type),
        ).fetchone()
        if row is None:
            details.append(name)
            if len(details) >= _SESSION_DB_DETAIL_LIMIT:
                break
    return details


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


def _session_db_invalid_recovery_state_details(connection: sqlite3.Connection) -> list[str]:
    placeholders = ", ".join("?" for _ in _SESSION_DB_RECOVERY_STATE_KEYS)
    rows = connection.execute(
        f"""
        SELECT session_id, state_key, payload_json
        FROM session_state
        WHERE state_key IN ({placeholders})
        ORDER BY session_id, state_key
        """,
        tuple(sorted(_SESSION_DB_RECOVERY_STATE_KEYS)),
    ).fetchall()
    details: list[str] = []
    for row in rows:
        detail = _session_db_recovery_state_problem(
            session_id=str(row["session_id"]),
            state_key=str(row["state_key"]),
            payload_json=str(row["payload_json"]),
        )
        if detail is not None:
            details.append(detail)
            if len(details) >= _SESSION_DB_DETAIL_LIMIT:
                break
    return details


def _session_db_recovery_state_problem(
    *,
    session_id: str,
    state_key: str,
    payload_json: str,
) -> str | None:
    prefix = f"{session_id}:{state_key}"
    try:
        payload = json.loads(payload_json)
    except json.JSONDecodeError:
        return f"{prefix} invalid json"
    if not isinstance(payload, dict):
        return f"{prefix} not object"
    reason = _session_db_recovery_object_problem(state_key, payload)
    if reason is not None:
        return f"{prefix} {reason}"
    return None


def _session_db_recovery_object_problem(state_key: str, payload: Mapping[str, object]) -> str | None:
    if state_key == "pending_decision":
        return _required_object_problem(payload, "tool_call")
    if state_key == "suspended_turn":
        user_message = payload.get("user_message")
        if not isinstance(user_message, str):
            return "user_message missing"
        conversation = payload.get("conversation")
        if conversation is not None and not isinstance(conversation, list):
            return "conversation not list"
        pending_approval = payload.get("pending_approval")
        if pending_approval is not None:
            if not isinstance(pending_approval, dict):
                return "pending_approval not object"
            nested_problem = _required_object_problem(pending_approval, "tool_call")
            if nested_problem is not None:
                return f"pending_approval.{nested_problem}"
        pending_clarification = payload.get("pending_clarification")
        if pending_clarification is not None:
            if not isinstance(pending_clarification, dict):
                return "pending_clarification not object"
            nested_problem = _required_object_problem(pending_clarification, "tool_call")
            if nested_problem is not None:
                return f"pending_clarification.{nested_problem}"
    return None


def _required_object_problem(payload: Mapping[str, object], key: str) -> str | None:
    value = payload.get(key)
    if not isinstance(value, dict):
        return f"{key} missing"
    return None


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
