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
from mycli.services.mcp.client import load_mcp_server_configs
from mycli.services.storage_layout import MycliStorageLayout


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
        required_tables = {"sessions", "conversation_messages", "turn_rollouts"}
        try:
            with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as connection:
                rows = connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
        except sqlite3.Error as exc:
            return (DoctorCheck("sessions_db", DoctorStatus.FAILED, f"not openable: {exc}"),)
        present_tables = {str(row[0]) for row in rows}
        missing_tables = sorted(required_tables - present_tables)
        if missing_tables:
            return (
                DoctorCheck(
                    "sessions_db",
                    DoctorStatus.FAILED,
                    f"missing tables: {', '.join(missing_tables)}",
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
            dependency_marker = _node_tui_dependency_marker(node_tui_root)
            if dependency_marker.is_file():
                checks.append(
                    DoctorCheck(
                        "node_tui_dependencies",
                        DoctorStatus.OK,
                        f"tsx present {dependency_marker}",
                    )
                )
            else:
                checks.append(
                    DoctorCheck(
                        "node_tui_dependencies",
                        DoctorStatus.WARNING,
                        "missing Node TUI dependencies; run: npm --prefix tui/node install",
                        detail=str(dependency_marker),
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


def _node_tui_dependency_marker(node_tui_root: Path) -> Path:
    return node_tui_root / "node_modules" / ".bin" / "tsx"


def _is_writable(path: Path) -> bool:
    return path.exists() and path.is_dir() and path.stat().st_mode & 0o222 != 0


__all__ = [
    "DoctorCheck",
    "DoctorReport",
    "DoctorService",
    "DoctorStatus",
    "render_doctor_report",
]
