from __future__ import annotations

from collections import Counter
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
from mycli.domain.runtime.gateway_contract import gateway_event_payload_schemas
from mycli.domain.runtime.tracing import RuntimeTraceEvent
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore
from mycli.services.extensions import ExtensionManifestService
from mycli.services.hooks import HookAllowlist, HookConfigRegistry, HookManager, HookPoint
from mycli.services.hooks.config import HookEnvPolicy
from mycli.services.hooks.builtin import permission_guard
from mycli.services.mcp.diagnostics import discover_mcp_servers
from mycli.services.skills import SkillRegistry
from mycli.services.subagents import inspect_subagent_profiles
from mycli.services.plugins import PluginLoadStatus, load_enabled_plugins
from mycli.services.storage_layout import MycliStorageLayout
from mycli.tools.registry import ToolRegistry

_TRACE_SCAN_LIMIT = 50
_TRACE_DETAIL_LIMIT = 3
_LOG_REDACTION_TEXT_BYTES = 512_000
_LOG_REDACTION_RAW_FILE_LIMIT = 20
_LOG_REDACTION_TRACE_FILE_LIMIT = 20
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
    "history_items_fts": "table",
    "history_items_fts_insert": "trigger",
    "history_items_fts_delete": "trigger",
    "history_items_fts_update": "trigger",
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
_SUCCESSFUL_APPROVAL_RESULTS = frozenset({"approved", "rejected"})
_SUCCESSFUL_CLARIFICATION_RESULTS = frozenset({"answered"})


@dataclass(frozen=True, slots=True)
class _NodeTuiDependencyConfig:
    required_paths: tuple[str, ...]
    install_command: str
    cleanup_command: str


@dataclass(frozen=True, slots=True)
class _LogRedactionScanResult:
    files_scanned: int
    leaks: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class _StreamDiagnosticsSummary:
    stream_count: int
    failure_count: int
    max_ttfb_ms: int | None
    max_elapsed_ms: int | None
    text_bytes: int
    failure_kinds: tuple[tuple[str, int], ...]
    unreadable: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class _ApprovalDiagnosticsSummary:
    approval_count: int
    resolution_count: int
    allowance_count: int
    auto_allowed_count: int
    safety_metadata_count: int
    resolution_results: tuple[tuple[str, int], ...]
    risk_levels: tuple[tuple[str, int], ...]
    policies: tuple[tuple[str, int], ...]
    warning_results: tuple[tuple[str, int], ...]
    unreadable: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class _ClarificationDiagnosticsSummary:
    clarification_count: int
    result_counts: tuple[tuple[str, int], ...]
    warning_results: tuple[tuple[str, int], ...]
    unreadable: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class _ToolExecutionDiagnosticsSummary:
    tool_count: int
    failure_count: int
    interrupted_count: int
    denied_count: int
    truncated_output_count: int
    write_diagnostics_error_count: int
    argument_summary_count: int
    error_kinds: tuple[tuple[str, int], ...]
    unreadable: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class _TurnFailureDiagnosticsSummary:
    failure_count: int
    stop_reasons: tuple[tuple[str, int], ...]
    phases: tuple[tuple[str, int], ...]
    unreadable: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class _TurnInterruptDiagnosticsSummary:
    request_count: int
    finalized_count: int
    sources: tuple[tuple[str, int], ...]
    unreadable: tuple[str, ...]


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
            self._check_stream_diagnostics,
            self._check_approval_diagnostics,
            self._check_clarification_diagnostics,
            self._check_tool_execution_diagnostics,
            self._check_turn_interrupt_diagnostics,
            self._check_turn_failure_diagnostics,
            self._check_tool_manifest,
            self._check_hooks,
            self._check_plugins,
            self._check_tool_manifest_runtime,
            self._check_tool_environment,
            self._check_skills,
            self._check_subagents,
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
                maintenance_check = _session_db_maintenance_check(
                    connection,
                    workspace_root=self._workspace_root,
                )
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
        return (
            DoctorCheck("sessions_db", DoctorStatus.OK, f"openable {path}"),
            maintenance_check,
        )

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
            scan_result = _scan_diagnostics_for_secret_leaks(
                logs_dir=logs_dir,
                traces_dir=self._layout.traces_dir,
            )
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
                    f"{len(scan_result.leaks)} possible secret leak(s) in diagnostic logs/traces",
                    detail=detail,
                ),
            )
        return (
            DoctorCheck(
                "logs_redaction",
                DoctorStatus.OK,
                f"scanned {scan_result.files_scanned} diagnostic file(s) for obvious secrets",
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

    def _check_stream_diagnostics(self) -> Iterable[DoctorCheck]:
        traces_dir = self._layout.traces_dir
        if not traces_dir.exists():
            return (
                DoctorCheck(
                    "stream_diagnostics",
                    DoctorStatus.OK,
                    "no stream diagnostics found",
                ),
            )
        if not traces_dir.is_dir():
            return (
                DoctorCheck(
                    "stream_diagnostics",
                    DoctorStatus.FAILED,
                    f"trace path is not a directory {traces_dir}",
                ),
            )

        trace_paths = sorted(traces_dir.glob("*.jsonl"))
        if not trace_paths:
            return (
                DoctorCheck(
                    "stream_diagnostics",
                    DoctorStatus.OK,
                    "no stream diagnostics found",
                    detail=str(traces_dir),
                ),
            )

        inspected_paths = trace_paths[:_TRACE_SCAN_LIMIT]
        summary = _summarize_stream_diagnostics(inspected_paths)
        suffix = ""
        if len(trace_paths) > len(inspected_paths):
            suffix = f"; scanned first {len(inspected_paths)} of {len(trace_paths)} files"

        if summary.unreadable:
            detail = "; ".join(summary.unreadable[:_TRACE_DETAIL_LIMIT])
            return (
                DoctorCheck(
                    "stream_diagnostics",
                    DoctorStatus.FAILED,
                    f"{len(summary.unreadable)} trace file(s) unreadable{suffix}",
                    detail=detail,
                ),
            )
        if summary.stream_count == 0:
            return (
                DoctorCheck(
                    "stream_diagnostics",
                    DoctorStatus.OK,
                    f"no stream diagnostics found{suffix}",
                    detail=str(traces_dir),
                ),
            )

        message = (
            f"{summary.stream_count} stream diagnostic(s), "
            f"failures={summary.failure_count} "
            f"max_ttfb_ms={_format_optional_int(summary.max_ttfb_ms)} "
            f"max_elapsed_ms={_format_optional_int(summary.max_elapsed_ms)} "
            f"text_bytes={summary.text_bytes}"
            f"{suffix}"
        )
        if summary.failure_count:
            return (
                DoctorCheck(
                    "stream_diagnostics",
                    DoctorStatus.WARNING,
                    message,
                    detail=f"failure_kinds: {_format_failure_kind_counts(summary.failure_kinds)}",
                ),
            )
        return (
            DoctorCheck(
                "stream_diagnostics",
                DoctorStatus.OK,
                message,
                detail=str(traces_dir),
            ),
        )

    def _check_approval_diagnostics(self) -> Iterable[DoctorCheck]:
        traces_dir = self._layout.traces_dir
        if not traces_dir.exists():
            return (
                DoctorCheck(
                    "approval_diagnostics",
                    DoctorStatus.OK,
                    "no approval diagnostics found",
                ),
            )
        if not traces_dir.is_dir():
            return (
                DoctorCheck(
                    "approval_diagnostics",
                    DoctorStatus.FAILED,
                    f"trace path is not a directory {traces_dir}",
                ),
            )

        trace_paths = sorted(traces_dir.glob("*.jsonl"))
        if not trace_paths:
            return (
                DoctorCheck(
                    "approval_diagnostics",
                    DoctorStatus.OK,
                    "no approval diagnostics found",
                    detail=str(traces_dir),
                ),
            )

        inspected_paths = trace_paths[:_TRACE_SCAN_LIMIT]
        summary = _summarize_approval_diagnostics(inspected_paths)
        suffix = ""
        if len(trace_paths) > len(inspected_paths):
            suffix = f"; scanned first {len(inspected_paths)} of {len(trace_paths)} files"

        if summary.unreadable:
            detail = "; ".join(summary.unreadable[:_TRACE_DETAIL_LIMIT])
            return (
                DoctorCheck(
                    "approval_diagnostics",
                    DoctorStatus.FAILED,
                    f"{len(summary.unreadable)} trace file(s) unreadable{suffix}",
                    detail=detail,
                ),
            )
        if summary.approval_count == 0:
            return (
                DoctorCheck(
                    "approval_diagnostics",
                    DoctorStatus.OK,
                    f"no approval diagnostics found{suffix}",
                    detail=str(traces_dir),
                ),
            )

        message = (
            f"{summary.approval_count} approval diagnostic(s), "
            f"resolutions={summary.resolution_count} "
            f"allowances={summary.allowance_count} "
            f"auto_allowed={summary.auto_allowed_count}"
            f" safety_metadata={summary.safety_metadata_count}"
            f"{suffix}"
        )
        detail_parts = [
            f"resolution_results: {_format_count_pairs(summary.resolution_results)}"
        ]
        if summary.risk_levels:
            detail_parts.append(f"risk_levels: {_format_count_pairs(summary.risk_levels)}")
        if summary.policies:
            detail_parts.append(f"policies: {_format_count_pairs(summary.policies)}")
        detail = "; ".join(detail_parts)
        if summary.warning_results:
            return (
                DoctorCheck(
                    "approval_diagnostics",
                    DoctorStatus.WARNING,
                    message,
                    detail=f"warning_results: {_format_count_pairs(summary.warning_results)}",
                ),
            )
        return (
            DoctorCheck(
                "approval_diagnostics",
                DoctorStatus.OK,
                message,
                detail=detail,
            ),
        )

    def _check_clarification_diagnostics(self) -> Iterable[DoctorCheck]:
        traces_dir = self._layout.traces_dir
        if not traces_dir.exists():
            return (
                DoctorCheck(
                    "clarification_diagnostics",
                    DoctorStatus.OK,
                    "no clarification diagnostics found",
                ),
            )
        if not traces_dir.is_dir():
            return (
                DoctorCheck(
                    "clarification_diagnostics",
                    DoctorStatus.FAILED,
                    f"trace path is not a directory {traces_dir}",
                ),
            )

        trace_paths = sorted(traces_dir.glob("*.jsonl"))
        if not trace_paths:
            return (
                DoctorCheck(
                    "clarification_diagnostics",
                    DoctorStatus.OK,
                    "no clarification diagnostics found",
                    detail=str(traces_dir),
                ),
            )

        inspected_paths = trace_paths[:_TRACE_SCAN_LIMIT]
        summary = _summarize_clarification_diagnostics(inspected_paths)
        suffix = ""
        if len(trace_paths) > len(inspected_paths):
            suffix = f"; scanned first {len(inspected_paths)} of {len(trace_paths)} files"

        if summary.unreadable:
            detail = "; ".join(summary.unreadable[:_TRACE_DETAIL_LIMIT])
            return (
                DoctorCheck(
                    "clarification_diagnostics",
                    DoctorStatus.FAILED,
                    f"{len(summary.unreadable)} trace file(s) unreadable{suffix}",
                    detail=detail,
                ),
            )
        if summary.clarification_count == 0:
            return (
                DoctorCheck(
                    "clarification_diagnostics",
                    DoctorStatus.OK,
                    f"no clarification diagnostics found{suffix}",
                    detail=str(traces_dir),
                ),
            )

        message = f"{summary.clarification_count} clarification diagnostic(s){suffix}"
        detail = f"resolution_results: {_format_count_pairs(summary.result_counts)}"
        if summary.warning_results:
            return (
                DoctorCheck(
                    "clarification_diagnostics",
                    DoctorStatus.WARNING,
                    message,
                    detail=f"warning_results: {_format_count_pairs(summary.warning_results)}",
                ),
            )
        return (
            DoctorCheck(
                "clarification_diagnostics",
                DoctorStatus.OK,
                message,
                detail=detail,
            ),
        )

    def _check_tool_execution_diagnostics(self) -> Iterable[DoctorCheck]:
        traces_dir = self._layout.traces_dir
        if not traces_dir.exists():
            return (
                DoctorCheck(
                    "tool_execution_diagnostics",
                    DoctorStatus.OK,
                    "no tool execution diagnostics found",
                ),
            )
        if not traces_dir.is_dir():
            return (
                DoctorCheck(
                    "tool_execution_diagnostics",
                    DoctorStatus.FAILED,
                    f"trace path is not a directory {traces_dir}",
                ),
            )

        trace_paths = sorted(traces_dir.glob("*.jsonl"))
        if not trace_paths:
            return (
                DoctorCheck(
                    "tool_execution_diagnostics",
                    DoctorStatus.OK,
                    "no tool execution diagnostics found",
                    detail=str(traces_dir),
                ),
            )

        inspected_paths = trace_paths[:_TRACE_SCAN_LIMIT]
        summary = _summarize_tool_execution_diagnostics(inspected_paths)
        suffix = ""
        if len(trace_paths) > len(inspected_paths):
            suffix = f"; scanned first {len(inspected_paths)} of {len(trace_paths)} files"

        if summary.unreadable:
            detail = "; ".join(summary.unreadable[:_TRACE_DETAIL_LIMIT])
            return (
                DoctorCheck(
                    "tool_execution_diagnostics",
                    DoctorStatus.FAILED,
                    f"{len(summary.unreadable)} trace file(s) unreadable{suffix}",
                    detail=detail,
                ),
            )
        if summary.tool_count == 0:
            return (
                DoctorCheck(
                    "tool_execution_diagnostics",
                    DoctorStatus.OK,
                    f"no tool execution diagnostics found{suffix}",
                    detail=str(traces_dir),
                ),
            )

        message = (
            f"{summary.tool_count} tool execution diagnostic(s), "
            f"failures={summary.failure_count} "
            f"interrupted={summary.interrupted_count} "
            f"denied={summary.denied_count} "
            f"truncated_output={summary.truncated_output_count} "
            f"write_diagnostic_errors={summary.write_diagnostics_error_count} "
            f"argument_summaries={summary.argument_summary_count}"
            f"{suffix}"
        )
        detail = f"error_kinds: {_format_count_pairs(summary.error_kinds)}"
        if summary.failure_count:
            return (
                DoctorCheck(
                    "tool_execution_diagnostics",
                    DoctorStatus.WARNING,
                    message,
                    detail=detail,
                ),
            )
        return (
            DoctorCheck(
                "tool_execution_diagnostics",
                DoctorStatus.OK,
                message,
                detail=detail,
            ),
        )

    def _check_turn_interrupt_diagnostics(self) -> Iterable[DoctorCheck]:
        traces_dir = self._layout.traces_dir
        if not traces_dir.exists():
            return (
                DoctorCheck(
                    "turn_interrupt_diagnostics",
                    DoctorStatus.OK,
                    "no turn interrupt diagnostics found",
                ),
            )
        if not traces_dir.is_dir():
            return (
                DoctorCheck(
                    "turn_interrupt_diagnostics",
                    DoctorStatus.FAILED,
                    f"trace path is not a directory {traces_dir}",
                ),
            )
        trace_paths = sorted(traces_dir.glob("*.jsonl"))
        if not trace_paths:
            return (
                DoctorCheck(
                    "turn_interrupt_diagnostics",
                    DoctorStatus.OK,
                    "no turn interrupt diagnostics found",
                    detail=str(traces_dir),
                ),
            )

        inspected_paths = trace_paths[:_TRACE_SCAN_LIMIT]
        summary = _summarize_turn_interrupt_diagnostics(inspected_paths)
        suffix = ""
        if len(trace_paths) > len(inspected_paths):
            suffix = f"; scanned first {len(inspected_paths)} of {len(trace_paths)} files"

        if summary.unreadable:
            detail = "; ".join(summary.unreadable[:_TRACE_DETAIL_LIMIT])
            return (
                DoctorCheck(
                    "turn_interrupt_diagnostics",
                    DoctorStatus.FAILED,
                    f"{len(summary.unreadable)} trace file(s) unreadable{suffix}",
                    detail=detail,
                ),
            )
        if summary.request_count == 0 and summary.finalized_count == 0:
            return (
                DoctorCheck(
                    "turn_interrupt_diagnostics",
                    DoctorStatus.OK,
                    f"no turn interrupt diagnostics found{suffix}",
                    detail=str(traces_dir),
                ),
            )

        return (
            DoctorCheck(
                "turn_interrupt_diagnostics",
                DoctorStatus.OK,
                (
                    f"interrupt_requests={summary.request_count} "
                    f"interrupt_finalized={summary.finalized_count}"
                    f"{suffix}"
                ),
                detail=f"sources: {_format_count_pairs(summary.sources)}",
            ),
        )

    def _check_turn_failure_diagnostics(self) -> Iterable[DoctorCheck]:
        traces_dir = self._layout.traces_dir
        if not traces_dir.exists():
            return (
                DoctorCheck(
                    "turn_failure_diagnostics",
                    DoctorStatus.OK,
                    "no turn failure diagnostics found",
                ),
            )
        if not traces_dir.is_dir():
            return (
                DoctorCheck(
                    "turn_failure_diagnostics",
                    DoctorStatus.FAILED,
                    f"trace path is not a directory {traces_dir}",
                ),
            )

        trace_paths = sorted(traces_dir.glob("*.jsonl"))
        if not trace_paths:
            return (
                DoctorCheck(
                    "turn_failure_diagnostics",
                    DoctorStatus.OK,
                    "no turn failure diagnostics found",
                    detail=str(traces_dir),
                ),
            )

        inspected_paths = trace_paths[:_TRACE_SCAN_LIMIT]
        summary = _summarize_turn_failure_diagnostics(inspected_paths)
        suffix = ""
        if len(trace_paths) > len(inspected_paths):
            suffix = f"; scanned first {len(inspected_paths)} of {len(trace_paths)} files"

        if summary.unreadable:
            detail = "; ".join(summary.unreadable[:_TRACE_DETAIL_LIMIT])
            return (
                DoctorCheck(
                    "turn_failure_diagnostics",
                    DoctorStatus.FAILED,
                    f"{len(summary.unreadable)} trace file(s) unreadable{suffix}",
                    detail=detail,
                ),
            )
        if summary.failure_count == 0:
            return (
                DoctorCheck(
                    "turn_failure_diagnostics",
                    DoctorStatus.OK,
                    f"no turn failure diagnostics found{suffix}",
                    detail=str(traces_dir),
                ),
            )

        return (
            DoctorCheck(
                "turn_failure_diagnostics",
                DoctorStatus.WARNING,
                f"{summary.failure_count} turn failure diagnostic(s){suffix}",
                detail=(
                    f"stop_reasons: {_format_count_pairs(summary.stop_reasons)}; "
                    f"phases: {_format_count_pairs(summary.phases)}"
                ),
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
            diagnostics = discover_mcp_servers(self._workspace_root, environ=self._env)
        except Exception as exc:
            return (DoctorCheck("mcp", DoctorStatus.FAILED, f"mcp config invalid: {exc}"),)
        status = DoctorStatus.WARNING if diagnostics.failure_count else DoctorStatus.OK
        message = (
            f"mcp: {diagnostics.configured_count} configured, "
            f"{diagnostics.enabled_count} enabled, "
            f"{diagnostics.tool_count} tools discovered"
        )
        return (
            DoctorCheck(
                "mcp",
                status,
                message,
                detail=diagnostics.safe_detail(),
            ),
        )

    def _check_skills(self) -> Iterable[DoctorCheck]:
        registry = SkillRegistry(
            builtin_root=Path(__file__).resolve().parents[2] / "prompts" / "skills",
            user_root=self._home_dir / ".mycli" / "skills",
            repo_root=self._workspace_root / ".mycli" / "skills",
        )
        diagnostics = registry.diagnostics()
        status = DoctorStatus.WARNING if diagnostics.warning_count else DoctorStatus.OK
        message = (
            f"skills: {diagnostics.loaded_count} loaded, "
            f"{diagnostics.duplicate_count} duplicate, "
            f"{diagnostics.issue_count} issue(s)"
        )
        return (
            DoctorCheck(
                "skills",
                status,
                message,
                detail=diagnostics.safe_detail(),
            ),
        )

    def _check_subagents(self) -> Iterable[DoctorCheck]:
        diagnostics = inspect_subagent_profiles()
        status = DoctorStatus.WARNING if diagnostics.issue_count else DoctorStatus.OK
        message = (
            f"subagents: {diagnostics.profile_count} profiles, "
            f"{diagnostics.available_count} available"
        )
        return (
            DoctorCheck(
                "subagents",
                status,
                message,
                detail=diagnostics.safe_detail(),
            ),
        )

    def _check_runtime_contract(self) -> Iterable[DoctorCheck]:
        manifest = ExtensionManifestService().manifest()
        rpc_methods = _manifest_named_entries(manifest.get("rpc_methods"))
        event_streams = _manifest_named_entries(manifest.get("event_streams"))
        event_payload_schemas = _manifest_event_payload_schema_names(manifest.get("event_streams"))
        expected_rpc_methods = supported_rpc_methods()
        expected_event_streams = supported_event_streams()
        expected_event_payload_schemas = set(gateway_event_payload_schemas())

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
        event_schema_message = _set_mismatch_message(
            "event payload schemas mismatch",
            expected=expected_event_payload_schemas,
            actual=event_payload_schemas,
        )
        problems = [
            message
            for message in (
                rpc_message,
                event_message,
                required_stream_message,
                event_schema_message,
            )
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

    def _check_tool_manifest(self) -> Iterable[DoctorCheck]:
        registry = ToolRegistry(workspace_root=self._workspace_root)
        manifest = registry.manifest()
        issues = ToolRegistry.manifest_issues(manifest)
        if issues:
            return (
                DoctorCheck(
                    "tool_manifest",
                    DoctorStatus.FAILED,
                    f"tool manifest invalid: {_bounded_name_list(list(issues))}",
                ),
            )
        tools = manifest.get("tools")
        toolsets = manifest.get("toolsets")
        if not isinstance(tools, list) or not isinstance(toolsets, list):
            return (
                DoctorCheck(
                    "tool_manifest",
                    DoctorStatus.FAILED,
                    "tool manifest missing tools or toolsets",
                ),
            )
        risk_counts: Counter[str] = Counter(
            str(item["risk_level"])
            for item in tools
            if isinstance(item, dict) and isinstance(item.get("risk_level"), str)
        )
        toolset_counts: Counter[str] = Counter(
            str(item["toolset"])
            for item in tools
            if isinstance(item, dict) and isinstance(item.get("toolset"), str)
        )
        detail_parts = [
            f"toolsets: {_format_count_pairs(tuple(sorted(toolset_counts.items())))}",
            f"risk_levels: {_format_count_pairs(tuple(sorted(risk_counts.items())))}",
        ]
        toolset_registry = registry.toolset_registry()
        toolset_issues = toolset_registry.manifest_issues()
        if toolset_issues:
            return (
                DoctorCheck(
                    "tool_manifest",
                    DoctorStatus.FAILED,
                    f"toolset manifest invalid: {_bounded_name_list(list(toolset_issues))}",
                ),
            )
        toolset_manifest = toolset_registry.manifest()
        summary = toolset_manifest.get("summary")
        if isinstance(summary, dict):
            detail_parts.append(
                "toolset_registry: "
                f"enabled={summary.get('enabled_toolsets', 0)} "
                f"disabled={summary.get('disabled_toolsets', 0)} "
                f"conflicts={summary.get('conflict_count', 0)}"
            )
        return (
            DoctorCheck(
                "tool_manifest",
                DoctorStatus.OK,
                f"{len(tools)} builtin tools across {len(toolsets)} toolsets",
                detail="; ".join(detail_parts),
            ),
        )

    def _check_tool_manifest_runtime(self) -> Iterable[DoctorCheck]:
        registry = ToolRegistry(workspace_root=self._workspace_root)
        builtin_manifest = registry.manifest()
        extension_manifest = ExtensionManifestService(tool_registry=registry).manifest()
        tool_manifest = extension_manifest.get("tool_manifest")
        toolset_manifest = extension_manifest.get("toolset_manifest")
        if not isinstance(tool_manifest, dict) or not isinstance(toolset_manifest, dict):
            return (
                DoctorCheck(
                    "tool_manifest_runtime",
                    DoctorStatus.FAILED,
                    "extension manifest missing tool_manifest or toolset_manifest",
                ),
            )
        issues = list(ToolRegistry.manifest_issues(tool_manifest))
        toolset_issues = list(ToolRegistry.toolset_registry_from_manifest(
            tool_manifest
        ).manifest_issues())
        if issues or toolset_issues:
            return (
                DoctorCheck(
                    "tool_manifest_runtime",
                    DoctorStatus.FAILED,
                    "extension manifest tool surfaces invalid: "
                    f"{_bounded_name_list([*issues, *toolset_issues])}",
                ),
            )
        builtin_tools_payload = builtin_manifest.get("tools")
        builtin_tool_rows = builtin_tools_payload if isinstance(builtin_tools_payload, list) else []
        extension_tools_payload = tool_manifest.get("tools")
        extension_tool_rows = (
            extension_tools_payload if isinstance(extension_tools_payload, list) else []
        )
        builtin_tools = {
            str(tool["name"])
            for tool in builtin_tool_rows
            if isinstance(tool, dict) and isinstance(tool.get("name"), str)
        }
        extension_tools = {
            str(tool["name"])
            for tool in extension_tool_rows
            if isinstance(tool, dict) and isinstance(tool.get("name"), str)
        }
        missing = sorted(builtin_tools - extension_tools)
        if missing:
            return (
                DoctorCheck(
                    "tool_manifest_runtime",
                    DoctorStatus.FAILED,
                    f"extension manifest missing runtime tools: {_bounded_name_list(missing)}",
                ),
            )
        return (
            DoctorCheck(
                "tool_manifest_runtime",
                DoctorStatus.OK,
                "extension manifest matches runtime-visible tools",
                detail=(
                    f"builtin_tools={len(builtin_tools)} "
                    f"extension_tools={len(extension_tools)}"
                ),
            ),
        )

    def _check_hooks(self) -> Iterable[DoctorCheck]:
        manager = HookManager()
        manager.register(HookPoint.PRE_TOOL_USE, permission_guard)
        discovery = HookConfigRegistry(
            workspace_root=self._workspace_root,
            home_dir=self._home_dir,
        ).discover()
        snapshots = manager.snapshot()
        if not snapshots:
            return (DoctorCheck("hooks", DoctorStatus.FAILED, "no hooks registered"),)
        hook_points = sorted(
            {snapshot.hook_point.value for snapshot in snapshots}
            | {spec.hook_point.value for spec in discovery.hooks}
        )
        hook_names = sorted({snapshot.hook_name for snapshot in snapshots} | {spec.name for spec in discovery.hooks})
        missing_required = [
            name for name in ("permission_guard",) if name not in hook_names
        ]
        if missing_required:
            return (
                DoctorCheck(
                    "hooks",
                    DoctorStatus.FAILED,
                    f"missing required hook(s): {', '.join(missing_required)}",
                    detail=f"points={', '.join(hook_points)}",
                ),
            )
        problems = [issue.safe_line() for issue in discovery.issues]
        warnings: list[str] = []
        allowlist = HookAllowlist(home_dir=self._home_dir)
        for spec in discovery.hooks:
            if not spec.enabled:
                warnings.append(f"{spec.name}: disabled")
            if spec.env_policy is HookEnvPolicy.INHERIT_SAFE:
                warnings.append(f"{spec.name}: env_policy=inherit_safe")
            allowlist_status = allowlist.status_for(spec)
            if not allowlist_status.allowed:
                warnings.append(f"{spec.name}: allowlist={allowlist_status.reason}")
            for command_part in spec.command:
                command_path = Path(command_part).expanduser()
                if not command_path.is_absolute():
                    continue
                if not command_path.exists():
                    problems.append(f"{spec.name}: missing command path")
                    break
                if command_part == spec.command[0] and not _is_executable_file(command_path):
                    warnings.append(f"{spec.name}: command not executable")
        warnings.extend(f"hook_allowlist: {issue}" for issue in allowlist.issues)
        if problems:
            return (
                DoctorCheck(
                    "hooks",
                    DoctorStatus.FAILED,
                    f"hook config invalid: {_bounded_name_list(problems)}",
                    detail=f"registered={len(snapshots)}",
                ),
            )
        status = DoctorStatus.WARNING if warnings else DoctorStatus.OK
        detail_parts = [
            f"points={', '.join(hook_points)}",
            f"hooks={', '.join(hook_names)}",
        ]
        if warnings:
            detail_parts.append(f"warnings={_bounded_name_list(warnings)}")
        if discovery.hooks:
            allowlist_lines = [
                allowlist.status_for(spec).safe_line(spec) for spec in discovery.hooks
            ]
            detail_parts.append(f"allowlist={_bounded_name_list(allowlist_lines)}")
        if allowlist.issues:
            detail_parts.append(f"allowlist_issues={_bounded_name_list(list(allowlist.issues))}")
        return (
            DoctorCheck(
                "hooks",
                status,
                f"hooks: {len(snapshots) + len(discovery.hooks)} registered, configured={len(discovery.hooks)}",
                detail="; ".join(detail_parts),
            ),
        )

    def _check_plugins(self) -> Iterable[DoctorCheck]:
        state = load_enabled_plugins(
            workspace_root=self._workspace_root,
            home_dir=self._home_dir,
            hook_manager=HookManager(),
            tool_registry=ToolRegistry(workspace_root=self._workspace_root),
            env=dict(self._env),
        )
        plugin_count = len(state.discovery.selected)
        if plugin_count == 0 and not state.issues:
            return (DoctorCheck("plugins", DoctorStatus.OK, "plugins: 0 discovered"),)
        loaded = sum(1 for item in state.loaded if item.status is PluginLoadStatus.LOADED)
        disabled = sum(1 for item in state.loaded if item.status is PluginLoadStatus.DISABLED)
        errored = sum(1 for item in state.loaded if item.status is PluginLoadStatus.ERROR)
        issue_lines = [issue.safe_line() for issue in state.issues]
        status = DoctorStatus.FAILED if errored else DoctorStatus.WARNING if issue_lines or disabled else DoctorStatus.OK
        detail_parts = [
            f"discovered={plugin_count}",
            f"loaded={loaded}",
            f"disabled={disabled}",
            f"errors={errored}",
        ]
        if issue_lines:
            detail_parts.append(f"issues={_bounded_name_list(issue_lines)}")
        return (
            DoctorCheck(
                "plugins",
                status,
                f"plugins: {plugin_count} discovered, loaded={loaded}",
                detail="; ".join(detail_parts),
            ),
        )

    def _check_tool_environment(self) -> Iterable[DoctorCheck]:
        issues: list[str] = []
        details: list[str] = []
        shell = self._env.get("SHELL") or "/bin/bash"
        shell_path = Path(shell).expanduser()
        if shell_path.is_absolute():
            if shell_path.exists() and _is_executable_file(shell_path):
                details.append(f"shell={shell_path}")
            else:
                issues.append(f"shell not executable: {shell_path}")
        else:
            resolved_shell = self._which(shell)
            if resolved_shell:
                details.append(f"shell={resolved_shell}")
            else:
                issues.append(f"shell not found: {shell}")
        git_path = self._which("git")
        if git_path:
            details.append(f"git={git_path}")
        else:
            issues.append("git not found")
        if issues:
            return (
                DoctorCheck(
                    "tool_environment",
                    DoctorStatus.WARNING,
                    f"tool environment issues: {_bounded_name_list(issues)}",
                    detail="; ".join(details),
                ),
            )
        return (
            DoctorCheck(
                "tool_environment",
                DoctorStatus.OK,
                "shell and git available",
                detail="; ".join(details),
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


def _manifest_event_payload_schema_names(value: object) -> set[str]:
    if not isinstance(value, list):
        return set()
    names: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            continue
        payload_schema = item.get("payload_schema")
        if not isinstance(payload_schema, dict):
            continue
        if payload_schema.get("type") != "object":
            continue
        schema_name = payload_schema.get("name")
        if isinstance(schema_name, str) and schema_name:
            names.add(schema_name)
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
                _parse_trace_event_line(line)
            except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                invalid_lines.append(line_number)
                continue
            valid_count += 1
    return valid_count, tuple(invalid_lines)


def _summarize_stream_diagnostics(paths: Iterable[Path]) -> _StreamDiagnosticsSummary:
    stream_count = 0
    failure_count = 0
    max_ttfb_ms: int | None = None
    max_elapsed_ms: int | None = None
    text_bytes = 0
    failure_kinds: Counter[str] = Counter()
    unreadable: list[str] = []

    for path in paths:
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    try:
                        event = _parse_trace_event_line(line)
                    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                        continue
                    if event.kind != "model_stream_diagnostics":
                        continue
                    stream_count += 1
                    ttfb_ms = _optional_non_negative_int(event.payload.get("ttfb_ms"))
                    elapsed_ms = _optional_non_negative_int(event.payload.get("elapsed_ms"))
                    event_text_bytes = _optional_non_negative_int(event.payload.get("text_bytes"))
                    if ttfb_ms is not None:
                        max_ttfb_ms = ttfb_ms if max_ttfb_ms is None else max(max_ttfb_ms, ttfb_ms)
                    if elapsed_ms is not None:
                        max_elapsed_ms = (
                            elapsed_ms
                            if max_elapsed_ms is None
                            else max(max_elapsed_ms, elapsed_ms)
                        )
                    if event_text_bytes is not None:
                        text_bytes += event_text_bytes
                    if event.payload.get("success") is False:
                        failure_count += 1
                        failure_kinds[_safe_failure_kind(event.payload.get("failure_kind"))] += 1
        except OSError as exc:
            unreadable.append(f"{path.name}: {exc}")

    ordered_failure_kinds = tuple(
        sorted(failure_kinds.items(), key=lambda item: (-item[1], item[0]))
    )
    return _StreamDiagnosticsSummary(
        stream_count=stream_count,
        failure_count=failure_count,
        max_ttfb_ms=max_ttfb_ms,
        max_elapsed_ms=max_elapsed_ms,
        text_bytes=text_bytes,
        failure_kinds=ordered_failure_kinds,
        unreadable=tuple(unreadable),
    )


def _summarize_approval_diagnostics(paths: Iterable[Path]) -> _ApprovalDiagnosticsSummary:
    resolution_count = 0
    allowance_count = 0
    auto_allowed_count = 0
    safety_metadata_count = 0
    resolution_results: Counter[str] = Counter()
    risk_levels: Counter[str] = Counter()
    policies: Counter[str] = Counter()
    unreadable: list[str] = []

    for path in paths:
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    try:
                        event = _parse_trace_event_line(line)
                    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                        continue
                    if event.kind == "approval_resolution":
                        resolution_count += 1
                        resolution_results[
                            _safe_approval_result(event.payload.get("result"))
                        ] += 1
                    elif event.kind == "approval_allowance":
                        allowance_count += 1
                    elif event.kind == "approval_auto_allowed":
                        auto_allowed_count += 1
                    else:
                        continue
                    metadata = event.payload.get("safety_metadata")
                    if isinstance(metadata, dict):
                        safety_metadata_count += 1
                        risk_levels[
                            _safe_safety_metadata_value(metadata.get("risk_level"))
                        ] += 1
                        policies[
                            _safe_safety_metadata_value(metadata.get("policy"))
                        ] += 1
        except OSError as exc:
            unreadable.append(f"{path.name}: {exc}")

    ordered_results = tuple(
        sorted(resolution_results.items(), key=lambda item: (-item[1], item[0]))
    )
    warning_results = tuple(
        (result, count)
        for result, count in ordered_results
        if result not in _SUCCESSFUL_APPROVAL_RESULTS
    )
    ordered_risk_levels = tuple(
        sorted(risk_levels.items(), key=lambda item: (-item[1], item[0]))
    )
    ordered_policies = tuple(
        sorted(policies.items(), key=lambda item: (-item[1], item[0]))
    )
    return _ApprovalDiagnosticsSummary(
        approval_count=resolution_count + allowance_count + auto_allowed_count,
        resolution_count=resolution_count,
        allowance_count=allowance_count,
        auto_allowed_count=auto_allowed_count,
        safety_metadata_count=safety_metadata_count,
        resolution_results=ordered_results,
        risk_levels=ordered_risk_levels,
        policies=ordered_policies,
        warning_results=warning_results,
        unreadable=tuple(unreadable),
    )


def _summarize_clarification_diagnostics(
    paths: Iterable[Path],
) -> _ClarificationDiagnosticsSummary:
    result_counts: Counter[str] = Counter()
    unreadable: list[str] = []

    for path in paths:
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    try:
                        event = _parse_trace_event_line(line)
                    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                        continue
                    if event.kind != "clarification_resolution":
                        continue
                    result_counts[_safe_diagnostic_result(event.payload.get("result"))] += 1
        except OSError as exc:
            unreadable.append(f"{path.name}: {exc}")

    ordered_results = tuple(sorted(result_counts.items(), key=lambda item: (-item[1], item[0])))
    warning_results = tuple(
        (result, count)
        for result, count in ordered_results
        if result not in _SUCCESSFUL_CLARIFICATION_RESULTS
    )
    return _ClarificationDiagnosticsSummary(
        clarification_count=sum(result_counts.values()),
        result_counts=ordered_results,
        warning_results=warning_results,
        unreadable=tuple(unreadable),
    )


def _summarize_tool_execution_diagnostics(
    paths: Iterable[Path],
) -> _ToolExecutionDiagnosticsSummary:
    tool_count = 0
    failure_count = 0
    interrupted_count = 0
    denied_count = 0
    truncated_output_count = 0
    write_diagnostics_error_count = 0
    argument_summary_count = 0
    error_kinds: Counter[str] = Counter()
    unreadable: list[str] = []

    for path in paths:
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    try:
                        event = _parse_trace_event_line(line)
                    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                        continue
                    if event.kind != "tool_execution":
                        continue
                    tool_count += 1
                    payload = event.payload
                    error_kind = _safe_diagnostic_result(payload.get("error_kind"))
                    failed = payload.get("success") is False or payload.get("status") == "failed"
                    if failed:
                        failure_count += 1
                        error_kinds[error_kind] += 1
                    if error_kind == "tool_interrupted":
                        interrupted_count += 1
                    if error_kind == "tool_denied_by_hook":
                        denied_count += 1
                    if payload.get("stdout_truncated") is True or payload.get("stderr_truncated") is True:
                        truncated_output_count += 1
                    write_error = payload.get("write_diagnostics_error")
                    if isinstance(write_error, str) and write_error.strip():
                        write_diagnostics_error_count += 1
                    argument_keys = payload.get("argument_keys")
                    argument_count = payload.get("argument_count")
                    if isinstance(argument_keys, list) and isinstance(argument_count, int):
                        argument_summary_count += 1
        except OSError as exc:
            unreadable.append(f"{path.name}: {exc}")

    ordered_error_kinds = tuple(
        sorted(error_kinds.items(), key=lambda item: (-item[1], item[0]))
    )
    return _ToolExecutionDiagnosticsSummary(
        tool_count=tool_count,
        failure_count=failure_count,
        interrupted_count=interrupted_count,
        denied_count=denied_count,
        truncated_output_count=truncated_output_count,
        write_diagnostics_error_count=write_diagnostics_error_count,
        argument_summary_count=argument_summary_count,
        error_kinds=ordered_error_kinds,
        unreadable=tuple(unreadable),
    )


def _summarize_turn_failure_diagnostics(
    paths: Iterable[Path],
) -> _TurnFailureDiagnosticsSummary:
    failure_count = 0
    stop_reasons: Counter[str] = Counter()
    phases: Counter[str] = Counter()
    unreadable: list[str] = []

    for path in paths:
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    try:
                        event = _parse_trace_event_line(line)
                    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                        continue
                    if event.kind != "turn_failed":
                        continue
                    failure_count += 1
                    stop_reasons[
                        _safe_diagnostic_result(event.payload.get("stop_reason"))
                    ] += 1
                    phases[_safe_diagnostic_result(event.payload.get("phase"))] += 1
        except OSError as exc:
            unreadable.append(f"{path.name}: {exc}")

    ordered_stop_reasons = tuple(
        sorted(stop_reasons.items(), key=lambda item: (-item[1], item[0]))
    )
    ordered_phases = tuple(sorted(phases.items(), key=lambda item: (-item[1], item[0])))
    return _TurnFailureDiagnosticsSummary(
        failure_count=failure_count,
        stop_reasons=ordered_stop_reasons,
        phases=ordered_phases,
        unreadable=tuple(unreadable),
    )


def _summarize_turn_interrupt_diagnostics(
    paths: Iterable[Path],
) -> _TurnInterruptDiagnosticsSummary:
    request_count = 0
    finalized_count = 0
    sources: Counter[str] = Counter()
    unreadable: list[str] = []

    for path in paths:
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    try:
                        event = _parse_trace_event_line(line)
                    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                        continue
                    if event.kind == "turn_interrupt_requested":
                        request_count += 1
                        sources[_safe_diagnostic_result(event.payload.get("source"))] += 1
                    elif event.kind == "turn_interrupted":
                        finalized_count += 1
        except OSError as exc:
            unreadable.append(f"{path.name}: {exc}")

    ordered_sources = tuple(sorted(sources.items(), key=lambda item: (-item[1], item[0])))
    return _TurnInterruptDiagnosticsSummary(
        request_count=request_count,
        finalized_count=finalized_count,
        sources=ordered_sources,
        unreadable=tuple(unreadable),
    )


def _parse_trace_event_line(line: str) -> RuntimeTraceEvent:
    payload = json.loads(line)
    if not isinstance(payload, dict):
        raise ValueError("trace row must be a JSON object")
    return RuntimeTraceEvent.from_dict(payload)


def _optional_non_negative_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float) and value >= 0:
        return int(value)
    return None


def _format_optional_int(value: int | None) -> str:
    if value is None:
        return "n/a"
    return str(value)


def _safe_failure_kind(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        return "unknown"
    normalized = value.strip()[:80]
    if _contains_probable_secret(normalized):
        return "redacted"
    if re.fullmatch(r"[A-Za-z0-9_.:-]+", normalized) is None:
        return "other"
    return normalized


def _safe_approval_result(value: object) -> str:
    return _safe_diagnostic_result(value)


def _safe_safety_metadata_value(value: object) -> str:
    return _safe_diagnostic_result(value)


def _safe_diagnostic_result(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        return "unknown"
    normalized = value.strip()[:80]
    if _contains_probable_secret(normalized):
        return "redacted"
    if re.fullmatch(r"[A-Za-z0-9_.:-]+", normalized) is None:
        return "other"
    return normalized


def _format_failure_kind_counts(failure_kinds: tuple[tuple[str, int], ...]) -> str:
    if not failure_kinds:
        return "unknown=0"
    parts = [f"{kind}={count}" for kind, count in failure_kinds[:_TRACE_DETAIL_LIMIT]]
    if len(failure_kinds) > _TRACE_DETAIL_LIMIT:
        parts.append("...")
    return ", ".join(parts)


def _format_count_pairs(counts: tuple[tuple[str, int], ...]) -> str:
    if not counts:
        return "none"
    parts = [f"{name}={count}" for name, count in counts[:_TRACE_DETAIL_LIMIT]]
    if len(counts) > _TRACE_DETAIL_LIMIT:
        parts.append("...")
    return ", ".join(parts)


def _scan_diagnostics_for_secret_leaks(
    *,
    logs_dir: Path,
    traces_dir: Path,
) -> _LogRedactionScanResult:
    paths = _log_redaction_scan_paths(logs_dir) + _trace_redaction_scan_paths(traces_dir)
    leaks: list[str] = []
    for path in paths:
        relative = _diagnostic_scan_relative_path(path, logs_dir=logs_dir, traces_dir=traces_dir)
        if path.suffix == ".json":
            leaks.extend(f"{relative}:{reference}" for reference in _json_secret_references(path))
        elif path.suffix == ".jsonl":
            leaks.extend(f"{relative}:{reference}" for reference in _jsonl_secret_references(path))
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


def _trace_redaction_scan_paths(traces_dir: Path) -> tuple[Path, ...]:
    if not traces_dir.exists() or not traces_dir.is_dir():
        return ()
    return tuple(sorted(traces_dir.glob("*.jsonl"))[:_LOG_REDACTION_TRACE_FILE_LIMIT])


def _diagnostic_scan_relative_path(
    path: Path,
    *,
    logs_dir: Path,
    traces_dir: Path,
) -> Path:
    try:
        return path.relative_to(logs_dir)
    except ValueError:
        try:
            return Path("traces") / path.relative_to(traces_dir)
        except ValueError:
            return Path(path.name)


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


def _jsonl_secret_references(path: Path) -> tuple[str, ...]:
    matches: list[str] = []
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                if _contains_probable_secret(line):
                    matches.append(str(line_number))
            else:
                for reference in _iter_json_secret_references(payload):
                    matches.append(f"{line_number}:{reference}")
                    if len(matches) >= _LOG_REDACTION_DETAIL_LIMIT:
                        break
            if len(matches) >= _LOG_REDACTION_DETAIL_LIMIT:
                break
    return tuple(matches)


def _json_secret_references(path: Path) -> tuple[str, ...]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError:
        return tuple(str(line_number) for line_number in _text_secret_line_numbers(path))
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

    unresumable_approval_details = _session_db_unresumable_pending_approval_details(connection)
    if unresumable_approval_details:
        return f"unresumable pending approvals: {', '.join(unresumable_approval_details)}"

    unresumable_clarification_details = (
        _session_db_unresumable_pending_clarification_details(connection)
    )
    if unresumable_clarification_details:
        return f"unresumable pending clarifications: {', '.join(unresumable_clarification_details)}"

    return None


def _session_db_maintenance_check(
    connection: sqlite3.Connection,
    *,
    workspace_root: Path,
) -> DoctorCheck:
    session_count = _session_db_workspace_session_count(connection, workspace_root=workspace_root)
    empty_session_count = _session_db_empty_workspace_session_count(
        connection,
        workspace_root=workspace_root,
    )
    freelist_count = int(connection.execute("PRAGMA freelist_count").fetchone()[0])
    message = (
        f"workspace_sessions={session_count} "
        f"empty_sessions={empty_session_count} "
        f"freelist_pages={freelist_count}"
    )
    if empty_session_count or freelist_count:
        return DoctorCheck(
            "session_maintenance",
            DoctorStatus.WARNING,
            f"{message}; inspect with /session-maintenance",
        )
    return DoctorCheck("session_maintenance", DoctorStatus.OK, message)


def _session_db_workspace_session_count(
    connection: sqlite3.Connection,
    *,
    workspace_root: Path,
) -> int:
    row = connection.execute(
        """
        SELECT COUNT(*) AS count
        FROM sessions
        WHERE workspace_root = ?
        """,
        (str(workspace_root),),
    ).fetchone()
    return int(row["count"]) if row is not None else 0


def _session_db_empty_workspace_session_count(
    connection: sqlite3.Connection,
    *,
    workspace_root: Path,
) -> int:
    row = connection.execute(
        """
        SELECT COUNT(*) AS count
        FROM (
            SELECT sessions.session_id
            FROM sessions
            LEFT JOIN conversation_messages
                ON conversation_messages.session_id = sessions.session_id
            LEFT JOIN session_summaries
                ON session_summaries.session_id = sessions.session_id
            LEFT JOIN history_items
                ON history_items.session_id = sessions.session_id
            LEFT JOIN turn_rollouts
                ON turn_rollouts.session_id = sessions.session_id
            LEFT JOIN session_state
                ON session_state.session_id = sessions.session_id
            WHERE sessions.workspace_root = ?
            GROUP BY sessions.session_id
            HAVING COUNT(conversation_messages.message_index) = 0
               AND COUNT(session_summaries.summary_index) = 0
               AND COUNT(history_items.sequence_no) = 0
               AND COUNT(turn_rollouts.sequence_no) = 0
               AND COUNT(session_state.state_key) = 0
        )
        """,
        (str(workspace_root),),
    ).fetchone()
    return int(row["count"]) if row is not None else 0


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
            conversation_trees.parent_id AS parent_id,
            conversation_trees.fork_point AS fork_point,
            COALESCE(child_counts.message_count, 0) AS child_message_count,
            COALESCE(parent_counts.message_count, 0) AS parent_message_count
        FROM conversation_trees
        LEFT JOIN (
            SELECT session_id, COUNT(*) AS message_count
            FROM conversation_messages
            GROUP BY session_id
        ) AS child_counts
            ON child_counts.session_id = conversation_trees.session_id
        LEFT JOIN (
            SELECT session_id, COUNT(*) AS message_count
            FROM conversation_messages
            GROUP BY session_id
        ) AS parent_counts
            ON parent_counts.session_id = conversation_trees.parent_id
        WHERE conversation_trees.fork_point IS NOT NULL
        ORDER BY conversation_trees.session_id
        """
    ).fetchall()
    details: list[str] = []
    for row in rows:
        fork_point = int(row["fork_point"])
        child_message_count = int(row["child_message_count"])
        parent_message_count = int(row["parent_message_count"])
        parent_id = row["parent_id"]
        if fork_point < 0 or fork_point > child_message_count:
            details.append(f"{row['session_id']}={fork_point}/{child_message_count}")
        elif parent_id is not None and fork_point > parent_message_count:
            details.append(f"{row['session_id']}={fork_point}/parent:{parent_message_count}")
        if details and len(details) >= _SESSION_DB_DETAIL_LIMIT:
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


def _session_db_unresumable_pending_approval_details(
    connection: sqlite3.Connection,
) -> list[str]:
    rows = connection.execute(
        """
        SELECT pending.session_id
        FROM session_state AS pending
        LEFT JOIN session_state AS suspended
            ON suspended.session_id = pending.session_id
            AND suspended.state_key = 'suspended_turn'
        LEFT JOIN session_state AS turn_record
            ON turn_record.session_id = pending.session_id
            AND turn_record.state_key = 'turn_record'
        WHERE pending.state_key = 'pending_decision'
        ORDER BY pending.session_id
        """
    ).fetchall()
    details: list[str] = []
    for row in rows:
        session_id = str(row["session_id"])
        if not _session_db_pending_approval_has_resume_evidence(connection, session_id):
            details.append(session_id)
            if len(details) >= _SESSION_DB_DETAIL_LIMIT:
                break
    return details


def _session_db_pending_approval_has_resume_evidence(
    connection: sqlite3.Connection,
    session_id: str,
) -> bool:
    suspended = connection.execute(
        """
        SELECT payload_json
        FROM session_state
        WHERE session_id = ? AND state_key = 'suspended_turn'
        """,
        (session_id,),
    ).fetchone()
    if suspended is not None:
        problem = _session_db_recovery_state_problem(
            session_id=session_id,
            state_key="suspended_turn",
            payload_json=str(suspended["payload_json"]),
        )
        if problem is None:
            return True

    turn_record = connection.execute(
        """
        SELECT payload_json
        FROM session_state
        WHERE session_id = ? AND state_key = 'turn_record'
        """,
        (session_id,),
    ).fetchone()
    if turn_record is not None and _turn_record_payload_has_waiting_approval_user_message(
        str(turn_record["payload_json"])
    ):
        return True

    return _session_db_has_waiting_approval_rollout_user_message(connection, session_id)


def _turn_record_payload_has_waiting_approval_user_message(payload_json: str) -> bool:
    try:
        payload = json.loads(payload_json)
    except json.JSONDecodeError:
        return False
    if not isinstance(payload, dict):
        return False
    return (
        payload.get("status") == "waiting_approval"
        and isinstance(payload.get("user_message"), str)
        and bool(str(payload["user_message"]).strip())
    )


def _session_db_has_waiting_approval_rollout_user_message(
    connection: sqlite3.Connection,
    session_id: str,
) -> bool:
    rollout_rows = connection.execute(
        """
        SELECT payload_json
        FROM turn_rollouts
        WHERE session_id = ?
        ORDER BY sequence_no DESC
        """,
        (session_id,),
    ).fetchall()
    for row in rollout_rows:
        turn_id = _waiting_approval_turn_id(str(row["payload_json"]))
        if turn_id is not None and _session_db_has_user_message_for_turn(
            connection,
            session_id=session_id,
            turn_id=turn_id,
        ):
            return True
    return False


def _waiting_approval_turn_id(payload_json: str) -> str | None:
    try:
        payload = json.loads(payload_json)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("status") != "waiting_approval":
        return None
    turn_id = payload.get("turn_id")
    if isinstance(turn_id, str) and turn_id.strip():
        return turn_id
    return None


def _session_db_has_user_message_for_turn(
    connection: sqlite3.Connection,
    *,
    session_id: str,
    turn_id: str,
) -> bool:
    rows = connection.execute(
        """
        SELECT payload_json
        FROM history_items
        WHERE session_id = ?
        """,
        (session_id,),
    ).fetchall()
    for row in rows:
        try:
            payload = json.loads(str(row["payload_json"]))
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        if (
            payload.get("turn_id") == turn_id
            and payload.get("type") == "user_message"
            and isinstance(payload.get("text"), str)
            and bool(str(payload["text"]).strip())
        ):
            return True
    return False


def _session_db_unresumable_pending_clarification_details(
    connection: sqlite3.Connection,
) -> list[str]:
    rows = connection.execute(
        """
        SELECT session_id, payload_json
        FROM session_state
        WHERE state_key = 'suspended_turn'
        ORDER BY session_id
        """
    ).fetchall()
    details: list[str] = []
    for row in rows:
        session_id = str(row["session_id"])
        if not _suspended_turn_payload_has_pending_clarification(str(row["payload_json"])):
            continue
        if not _session_db_pending_clarification_has_resume_evidence(
            connection,
            session_id,
            payload_json=str(row["payload_json"]),
        ):
            details.append(session_id)
            if len(details) >= _SESSION_DB_DETAIL_LIMIT:
                break
    return details


def _session_db_pending_clarification_has_resume_evidence(
    connection: sqlite3.Connection,
    session_id: str,
    *,
    payload_json: str,
) -> bool:
    if _suspended_turn_payload_has_user_message(payload_json):
        return True

    turn_record = connection.execute(
        """
        SELECT payload_json
        FROM session_state
        WHERE session_id = ? AND state_key = 'turn_record'
        """,
        (session_id,),
    ).fetchone()
    if turn_record is not None and _turn_record_payload_has_waiting_clarification_user_message(
        str(turn_record["payload_json"])
    ):
        return True

    return _session_db_has_waiting_clarification_rollout_user_message(connection, session_id)


def _suspended_turn_payload_has_pending_clarification(payload_json: str) -> bool:
    try:
        payload = json.loads(payload_json)
    except json.JSONDecodeError:
        return False
    if not isinstance(payload, dict):
        return False
    return isinstance(payload.get("pending_clarification"), dict)


def _suspended_turn_payload_has_user_message(payload_json: str) -> bool:
    try:
        payload = json.loads(payload_json)
    except json.JSONDecodeError:
        return False
    if not isinstance(payload, dict):
        return False
    user_message = payload.get("user_message")
    return isinstance(user_message, str) and bool(user_message.strip())


def _turn_record_payload_has_waiting_clarification_user_message(payload_json: str) -> bool:
    try:
        payload = json.loads(payload_json)
    except json.JSONDecodeError:
        return False
    if not isinstance(payload, dict):
        return False
    return (
        payload.get("status") == "waiting_clarification"
        and isinstance(payload.get("user_message"), str)
        and bool(str(payload["user_message"]).strip())
    )


def _session_db_has_waiting_clarification_rollout_user_message(
    connection: sqlite3.Connection,
    session_id: str,
) -> bool:
    rollout_rows = connection.execute(
        """
        SELECT payload_json
        FROM turn_rollouts
        WHERE session_id = ?
        ORDER BY sequence_no DESC
        """,
        (session_id,),
    ).fetchall()
    for row in rollout_rows:
        turn_id = _waiting_clarification_turn_id(str(row["payload_json"]))
        if turn_id is not None and _session_db_has_user_message_for_turn(
            connection,
            session_id=session_id,
            turn_id=turn_id,
        ):
            return True
    return False


def _waiting_clarification_turn_id(payload_json: str) -> str | None:
    try:
        payload = json.loads(payload_json)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("status") != "waiting_clarification":
        return None
    turn_id = payload.get("turn_id")
    if isinstance(turn_id, str) and turn_id.strip():
        return turn_id
    return None


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
        return _pending_decision_payload_problem(payload)
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
            nested_problem = _pending_approval_payload_problem(pending_approval)
            if nested_problem is not None:
                return f"pending_approval.{nested_problem}"
        pending_clarification = payload.get("pending_clarification")
        if pending_clarification is not None:
            if not isinstance(pending_clarification, dict):
                return "pending_clarification not object"
            nested_problem = _pending_clarification_payload_problem(pending_clarification)
            if nested_problem is not None:
                return f"pending_clarification.{nested_problem}"
    return None


def _pending_decision_payload_problem(payload: Mapping[str, object]) -> str | None:
    tool_problem = _prefixed_tool_call_payload_problem(payload.get("tool_call"))
    if tool_problem is not None:
        return tool_problem
    if not isinstance(payload.get("kind"), str):
        return "kind missing"
    if not isinstance(payload.get("preview"), str):
        return "preview missing"
    if not isinstance(payload.get("options"), list):
        return "options not list"
    return None


def _pending_approval_payload_problem(payload: Mapping[str, object]) -> str | None:
    tool_problem = _prefixed_tool_call_payload_problem(payload.get("tool_call"))
    if tool_problem is not None:
        return tool_problem
    if not isinstance(payload.get("reason"), str):
        return "reason missing"
    if not isinstance(payload.get("preview"), str):
        return "preview missing"
    return None


def _pending_clarification_payload_problem(payload: Mapping[str, object]) -> str | None:
    tool_problem = _prefixed_tool_call_payload_problem(payload.get("tool_call"))
    if tool_problem is not None:
        return tool_problem
    if not isinstance(payload.get("request_id"), str):
        return "request_id missing"
    if not isinstance(payload.get("question"), str):
        return "question missing"
    options = payload.get("options")
    if options is not None and not isinstance(options, list):
        return "options not list"
    multi_select = payload.get("multi_select")
    if multi_select is not None and not isinstance(multi_select, bool):
        return "multi_select not boolean"
    return None


def _prefixed_tool_call_payload_problem(value: object) -> str | None:
    problem = _tool_call_payload_problem(value)
    if problem is None:
        return None
    if problem == "missing":
        return "tool_call missing"
    return f"tool_call.{problem}"


def _tool_call_payload_problem(value: object) -> str | None:
    if not isinstance(value, dict):
        return "missing"
    if not isinstance(value.get("name"), str):
        return "name missing"
    if not isinstance(value.get("arguments"), dict):
        return "arguments not object"
    if not isinstance(value.get("reason"), str):
        return "reason missing"
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


def _is_executable_file(path: Path) -> bool:
    return path.exists() and path.is_file() and path.stat().st_mode & 0o111 != 0


__all__ = [
    "DoctorCheck",
    "DoctorReport",
    "DoctorService",
    "DoctorStatus",
    "render_doctor_report",
]
