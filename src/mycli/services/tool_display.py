from __future__ import annotations

from dataclasses import dataclass, field, replace
from math import isfinite
import re

from mycli.domain.tooling.calls import ToolCall, ToolEvidence, ToolResult
from mycli.services.file_change_display import FileChangeDisplay, project_file_changes


DISPLAY_TARGET_MAX_CHARS = 240
DISPLAY_SUMMARY_MAX_CHARS = 500
DISPLAY_DETAIL_MAX_CHARS = 8_000
DISPLAY_ERROR_MAX_CHARS = 2_000
DISPLAY_METRICS_MAX_ITEMS = 16
DISPLAY_FILE_CHANGES_MAX_ITEMS = 64

DISPLAY_STATUSES = frozenset({"running", "success", "error", "cancelled", "waiting"})
DISPLAY_PRESENTATIONS = frozenset(
    {
        "tool",
        "context",
        "mutation",
        "shell",
        "skill",
        "web",
        "diagnostic",
        "control",
        "external",
    }
)

_STATUS_ALIASES = {
    "done": "success",
    "completed": "success",
    "succeeded": "success",
    "failed": "error",
    "denied": "error",
    "interrupted": "cancelled",
}
_ACCEPTED_STATUS_INPUTS = DISPLAY_STATUSES | frozenset(_STATUS_ALIASES)

MetricValue = int | float | str | bool

CONTEXT_TOOLS = frozenset(
    {
        "read",
        "readfile",
        "grep",
        "searchtext",
        "glob",
        "ls",
        "listdirectory",
        "gitstatus",
        "gitlog",
        "gitshow",
    }
)
MUTATION_TOOLS = frozenset(
    {"write", "writefile", "edit", "editfile", "patch", "patchfile", "gitdiff"}
)
SHELL_TOOLS = frozenset(
    {
        "shell",
        "bash",
        "runshell",
        "writestdin",
        "shelloutput",
        "bashoutput",
        "killshell",
    }
)
WEB_TOOLS = frozenset({"websearch", "webfetch"})
DIAGNOSTIC_TOOLS = frozenset({"lint"})
SKILL_TOOLS = frozenset({"skill"})
CONTROL_TOOLS = frozenset(
    {
        "askuserquestion",
        "plan",
        "enterplanmode",
        "exitplanmode",
        "task",
        "subagentoutput",
        "sendmessage",
    }
)

_PRESENTATION_TOOLS = (
    ("context", CONTEXT_TOOLS),
    ("mutation", MUTATION_TOOLS),
    ("shell", SHELL_TOOLS),
    ("web", WEB_TOOLS),
    ("diagnostic", DIAGNOSTIC_TOOLS),
    ("skill", SKILL_TOOLS),
    ("control", CONTROL_TOOLS),
)


@dataclass(frozen=True, slots=True)
class ToolDisplayEnvelope:
    target: str | None = None
    status: str = "running"
    summary: str = ""
    detail: str | None = None
    error: str | None = None
    metrics: dict[str, MetricValue] = field(default_factory=dict)
    truncated: bool = False
    omitted_chars: int = 0
    presentation: str = "tool"
    file_changes: tuple[FileChangeDisplay, ...] = ()

    @classmethod
    def create(
        cls,
        *,
        target: object = None,
        status: object = "running",
        summary: object = "",
        detail: object = None,
        error: object = None,
        metrics: object = None,
        presentation: object = "tool",
        file_changes: object = None,
    ) -> ToolDisplayEnvelope:
        bounded_target, target_omitted = _bounded_single_line(
            target,
            DISPLAY_TARGET_MAX_CHARS,
        )
        bounded_summary, summary_omitted = _bounded_single_line(
            summary,
            DISPLAY_SUMMARY_MAX_CHARS,
        )
        bounded_detail, detail_omitted = _bounded_head_tail(
            detail,
            DISPLAY_DETAIL_MAX_CHARS,
        )
        bounded_error, error_omitted = _bounded_head_tail(
            error,
            DISPLAY_ERROR_MAX_CHARS,
        )
        omitted_chars = (
            target_omitted + summary_omitted + detail_omitted + error_omitted
        )
        normalized_presentation = (
            presentation
            if isinstance(presentation, str)
            and presentation in DISPLAY_PRESENTATIONS
            else "tool"
        )
        return cls(
            target=bounded_target,
            status=_normalize_status(status),
            summary=bounded_summary or "",
            detail=bounded_detail,
            error=bounded_error,
            metrics=_scalar_metrics(metrics),
            truncated=omitted_chars > 0,
            omitted_chars=omitted_chars,
            presentation=normalized_presentation,
            file_changes=_file_changes(file_changes),
        )

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "status": self.status,
            "summary": self.summary,
            "presentation": self.presentation,
        }
        if self.target:
            payload["target"] = self.target
        if self.detail:
            payload["detail"] = self.detail
        if self.error:
            payload["error"] = self.error
        if self.metrics:
            payload["metrics"] = dict(self.metrics)
        if self.truncated:
            payload["truncated"] = True
        if self.omitted_chars:
            payload["omitted_chars"] = self.omitted_chars
        if self.file_changes:
            payload["file_changes"] = [change.to_dict() for change in self.file_changes]
        return payload

    @classmethod
    def from_mapping(cls, value: object) -> ToolDisplayEnvelope | None:
        if not isinstance(value, dict):
            return None
        raw_status = value.get("status")
        raw_summary = value.get("summary")
        if (
            not isinstance(raw_status, str)
            or raw_status.lower() not in _ACCEPTED_STATUS_INPUTS
            or not isinstance(raw_summary, str)
        ):
            return None
        envelope = cls.create(
            target=value.get("target"),
            status=raw_status,
            summary=raw_summary,
            detail=value.get("detail"),
            error=value.get("error"),
            metrics=value.get("metrics"),
            presentation=value.get("presentation"),
            file_changes=value.get("file_changes"),
        )
        previous_omitted = value.get("omitted_chars")
        if not isinstance(previous_omitted, int) or isinstance(previous_omitted, bool):
            previous_omitted = 0
        return replace(
            envelope,
            truncated=(
                envelope.truncated
                or value.get("truncated") is True
                or previous_omitted > 0
            ),
            omitted_chars=envelope.omitted_chars + max(0, previous_omitted),
        )


class ToolDisplayProjector:
    def presentation_for(self, tool_name: str) -> str:
        normalized = _normalized_tool_name(tool_name)
        for presentation, tool_names in _PRESENTATION_TOOLS:
            if normalized in tool_names:
                return presentation
        return "external"

    def project_start(self, call: ToolCall) -> ToolDisplayEnvelope:
        presentation = self.presentation_for(call.name)
        try:
            return ToolDisplayEnvelope.create(
                target=_target_for(call, {}),
                status="running",
                summary=_running_summary(call.name, presentation),
                detail=_start_detail(call, presentation),
                metrics=_start_metrics(call, presentation),
                presentation=presentation,
            )
        except (AttributeError, TypeError, ValueError):
            return ToolDisplayEnvelope.create(
                status="running",
                summary="Running",
                presentation=presentation,
            )

    def project_result(
        self,
        call: ToolCall,
        result: ToolResult,
        *,
        duration_ms: int | None = None,
    ) -> ToolDisplayEnvelope:
        presentation = self.presentation_for(call.name)
        try:
            metrics = _result_metrics(call, result, presentation)
            if duration_ms is not None:
                metrics["duration_ms"] = max(0, duration_ms)
            file_changes = (
                project_file_changes(call, result)
                if presentation == "mutation"
                else ()
            )
            envelope = ToolDisplayEnvelope.create(
                target=_target_for(call, result.raw_payload),
                status=_result_status(result, presentation),
                summary=_result_summary(call, result, presentation),
                detail=(
                    None
                    if file_changes
                    else _result_detail(call, result, presentation)
                ),
                error=result.error if not result.success else None,
                metrics=metrics,
                presentation=presentation,
                file_changes=file_changes,
            )
            return _preserve_payload_truncation(envelope, result.raw_payload)
        except (AttributeError, TypeError, ValueError):
            return ToolDisplayEnvelope.create(
                status="success" if result.success else "error",
                summary=result.summary,
                error=result.error if not result.success else None,
                presentation=presentation,
            )


def _normalize_status(value: object) -> str:
    if not isinstance(value, str):
        return "running"
    normalized = value.lower()
    if normalized in DISPLAY_STATUSES:
        return normalized
    return _STATUS_ALIASES.get(normalized, "running")


def _bounded_single_line(value: object, max_chars: int) -> tuple[str | None, int]:
    if not isinstance(value, str):
        return None, 0
    normalized = re.sub(r"\s+", " ", value).strip()
    if not normalized:
        return None, 0
    if len(normalized) <= max_chars:
        return normalized, 0
    suffix = "..."
    retained = max(0, max_chars - len(suffix))
    return f"{normalized[:retained].rstrip()}{suffix}", len(normalized) - retained


def _bounded_head_tail(value: object, max_chars: int) -> tuple[str | None, int]:
    if not isinstance(value, str) or not value:
        return None, 0
    if len(value) <= max_chars:
        return value, 0
    omitted = max(1, len(value) - max_chars)
    while True:
        marker = f"\n... {omitted} chars omitted ...\n"
        retained = max(0, max_chars - len(marker))
        updated = len(value) - retained
        if updated == omitted:
            break
        omitted = updated
    head_chars = retained // 2
    tail_chars = retained - head_chars
    tail = value[-tail_chars:] if tail_chars else ""
    return f"{value[:head_chars]}{marker}{tail}", omitted


def _scalar_metrics(value: object) -> dict[str, MetricValue]:
    if not isinstance(value, dict):
        return {}
    metrics: dict[str, MetricValue] = {}
    for raw_key, raw_value in value.items():
        if len(metrics) >= DISPLAY_METRICS_MAX_ITEMS:
            break
        if not isinstance(raw_key, str) or not raw_key.strip():
            continue
        key = raw_key.strip()[:80]
        if isinstance(raw_value, bool):
            metrics[key] = raw_value
        elif isinstance(raw_value, int):
            metrics[key] = raw_value
        elif isinstance(raw_value, float) and isfinite(raw_value):
            metrics[key] = raw_value
        elif isinstance(raw_value, str) and raw_value:
            metrics[key] = raw_value[:500]
    return metrics


def _file_changes(value: object) -> tuple[FileChangeDisplay, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    changes: list[FileChangeDisplay] = []
    for item in value[:DISPLAY_FILE_CHANGES_MAX_ITEMS]:
        change = (
            item
            if isinstance(item, FileChangeDisplay)
            else FileChangeDisplay.from_mapping(item)
        )
        if change is not None:
            changes.append(change)
    return tuple(changes)


def _normalized_tool_name(value: str) -> str:
    return re.sub(r"[_-]", "", value.strip().lower())


def _string_from(mapping: dict[str, object], *keys: str) -> str | None:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _target_for(call: ToolCall, payload: dict[str, object]) -> str | None:
    arguments = call.arguments
    normalized = _normalized_tool_name(call.name)
    if normalized in {"grep", "glob"}:
        pattern = _string_from(arguments, "pattern", "query")
        path = _string_from(arguments, "path", "file_path")
        if path and pattern:
            return f"{path}: {pattern}"
        return pattern or path
    if normalized == "skill":
        return _string_from(payload, "skill_name") or _string_from(
            arguments,
            "skill_name",
        )
    if normalized in {"sendmessage", "subagentoutput", "task"}:
        return _string_from(payload, "child_session_id") or _string_from(
            arguments,
            "child_session_id",
            "description",
        )
    if normalized in SHELL_TOOLS:
        command = _string_from(arguments, "command")
        if command:
            return command
        args = arguments.get("args")
        if isinstance(args, list) and all(isinstance(item, str) for item in args):
            joined = " ".join(item for item in args if item)
            if joined:
                return joined
        return _string_from(payload, "command", "shell_id", "bash_id") or _string_from(
            arguments,
            "shell_id",
            "bash_id",
        )
    if normalized == "websearch":
        return _string_from(payload, "query") or _string_from(arguments, "query")
    if normalized == "webfetch":
        return _string_from(payload, "url") or _string_from(arguments, "url")
    if normalized == "lint":
        return _string_from(arguments, "paths") or "workspace"
    if normalized in {"gitstatus"}:
        return "workspace"
    if normalized in {"gitlog", "gitshow"}:
        return _string_from(payload, "path", "ref") or _string_from(
            arguments,
            "path",
            "ref",
        ) or "workspace"
    return _string_from(payload, "path", "file_path", "query", "url", "command") or _string_from(
        arguments,
        "file_path",
        "path",
        "query",
        "url",
        "command",
        "name",
        "id",
    )


def _running_summary(tool_name: str, presentation: str) -> str:
    normalized = _normalized_tool_name(tool_name)
    if normalized in {"read", "readfile"}:
        return "Reading"
    if normalized in {"grep", "searchtext", "glob"}:
        return "Searching"
    if normalized == "ls":
        return "Listing"
    return {
        "mutation": "Preparing change",
        "shell": "Running",
        "web": "Fetching",
        "diagnostic": "Checking",
        "skill": "Activating",
        "control": "Running",
        "external": "Running",
    }.get(presentation, "Running")


def _start_detail(call: ToolCall, presentation: str) -> str | None:
    if presentation != "mutation" or _normalized_tool_name(call.name) not in {
        "write",
        "writefile",
    }:
        return None
    return _string_from(call.arguments, "content")


def _start_metrics(call: ToolCall, presentation: str) -> dict[str, MetricValue]:
    if presentation != "mutation":
        return {}
    content = call.arguments.get("content")
    if not isinstance(content, str):
        return {}
    return {"line_count": _line_count(content)}


def _result_summary(
    call: ToolCall,
    result: ToolResult,
    presentation: str,
) -> str:
    if not result.success:
        return result.summary
    normalized = _normalized_tool_name(call.name)
    payload = result.raw_payload
    if presentation == "skill":
        return "Activated"
    if presentation == "mutation":
        if payload.get("status") == "unchanged":
            return "No changes"
        if normalized in {"write", "writefile"}:
            content = call.arguments.get("content")
            if isinstance(content, str):
                count = _line_count(content)
                return f"Wrote {count} {'line' if count == 1 else 'lines'}"
        return "Updated"
    if normalized in {"grep", "searchtext"}:
        count = _item_count(payload, "structured_matches", "matches")
        return f"{count} {'match' if count == 1 else 'matches'}"
    if normalized in {"glob", "ls"}:
        count = _entry_count(payload)
        return f"{count} {'entry' if count == 1 else 'entries'}"
    if normalized == "websearch":
        count = _item_count(payload, "results")
        return f"{count} {'result' if count == 1 else 'results'}"
    if normalized == "lint":
        lint_count = _int_from(payload, "count")
        if lint_count is not None:
            return f"{lint_count} {'issue' if lint_count == 1 else 'issues'}"
    if presentation == "shell":
        status = _string_from(payload, "status", "process_state")
        if status and "running" in status:
            return "Running"
        exit_code = _int_from(payload, "exit_code")
        if exit_code is not None:
            return f"Exit {exit_code}"
    return result.summary


def _result_status(result: ToolResult, presentation: str) -> str:
    if not result.success:
        return "error"
    raw_status = _string_from(result.raw_payload, "status", "process_state")
    if raw_status:
        normalized = raw_status.lower()
        if "interrupted" in normalized or "cancelled" in normalized:
            return "cancelled"
        if "await" in normalized or "waiting" in normalized:
            return "waiting"
        if presentation == "shell" and "running" in normalized:
            return "running"
    return "success"


def _result_detail(
    call: ToolCall,
    result: ToolResult,
    presentation: str,
) -> str | None:
    payload = result.raw_payload
    normalized = _normalized_tool_name(call.name)
    if normalized in {"read", "readfile"}:
        return _string_from(payload, "content")
    if normalized in {"grep", "searchtext"}:
        return _render_matches(payload)
    if normalized in {"glob", "ls"}:
        return _render_entries(payload)
    if normalized in {"gitstatus", "gitlog", "gitshow"}:
        return _render_git_detail(normalized, payload)
    if presentation == "mutation":
        return _string_from(payload, "diff") or (
            _string_from(call.arguments, "content")
            if normalized in {"write", "writefile"}
            else None
        )
    if presentation == "shell":
        return _render_shell_output(payload)
    if presentation == "web":
        return _render_web_detail(payload)
    if presentation == "diagnostic":
        return _render_diagnostic_detail(payload)
    if presentation in {"skill", "control"}:
        return None
    if result.evidence:
        return _render_evidence(result.evidence)
    return _string_from(payload, "content", "output", "stdout", "stderr")


def _result_metrics(
    call: ToolCall,
    result: ToolResult,
    presentation: str,
) -> dict[str, MetricValue]:
    payload = result.raw_payload
    metrics: dict[str, MetricValue] = {}
    for source_key, target_key in (
        ("exit_code", "exit_code"),
        ("duration_ms", "duration_ms"),
        ("shell_id", "shell_id"),
        ("bash_id", "shell_id"),
    ):
        value = payload.get(source_key)
        if isinstance(value, (str, int, float, bool)) and not (
            isinstance(value, float) and not isfinite(value)
        ):
            metrics.setdefault(target_key, value)
    normalized = _normalized_tool_name(call.name)
    if normalized in {"grep", "searchtext"}:
        metrics["match_count"] = _item_count(payload, "structured_matches", "matches")
    elif normalized in {"glob", "ls"}:
        metrics["entry_count"] = _entry_count(payload)
    elif normalized == "websearch":
        metrics["result_count"] = _item_count(payload, "results")
    elif normalized == "lint":
        count = _int_from(payload, "count")
        if count is not None:
            metrics["issue_count"] = count
    elif presentation == "mutation":
        matches = _int_from(payload, "matches")
        if matches is not None:
            metrics["match_count"] = matches
        content = call.arguments.get("content")
        if isinstance(content, str):
            metrics["line_count"] = _line_count(content)
        diagnostics = payload.get("write_diagnostics")
        if isinstance(diagnostics, dict):
            count = _int_from(diagnostics, "count")
            if count is not None:
                metrics["diagnostic_count"] = count
    return metrics


def _line_count(value: str) -> int:
    stripped = value.rstrip("\n")
    return len(stripped.splitlines()) if stripped else 0


def _int_from(mapping: dict[str, object], key: str) -> int | None:
    value = mapping.get(key)
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _item_count(mapping: dict[str, object], *keys: str) -> int:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            return max(0, value)
        if isinstance(value, list):
            return len(value)
    total = _int_from(mapping, "total")
    return max(0, total or 0)


def _entry_count(payload: dict[str, object]) -> int:
    total = _int_from(payload, "total")
    if total is not None:
        return max(0, total)
    entries = payload.get("entries")
    if isinstance(entries, list):
        return len(entries)
    return sum(
        len(value)
        for key in ("dirs", "files", "hidden")
        if isinstance((value := payload.get(key)), list)
    )


def _render_matches(payload: dict[str, object]) -> str | None:
    matches = payload.get("structured_matches")
    if not isinstance(matches, list):
        matches = payload.get("matches")
    if not isinstance(matches, list):
        return None
    lines: list[str] = []
    for item in matches:
        if isinstance(item, str):
            lines.append(item)
            continue
        if not isinstance(item, dict):
            continue
        path = item.get("path")
        line_number = item.get("line_number")
        text = item.get("line") or item.get("text")
        if isinstance(path, str) and isinstance(text, str):
            prefix = f"{path}:{line_number}" if isinstance(line_number, int) else path
            lines.append(f"{prefix}: {text}")
    return "\n".join(lines) or None


def _render_entries(payload: dict[str, object]) -> str | None:
    lines: list[str] = []
    entries = payload.get("entries")
    if isinstance(entries, list):
        lines.extend(item for item in entries if isinstance(item, str))
    for key, suffix in (("dirs", "/"), ("files", ""), ("hidden", "")):
        values = payload.get(key)
        if isinstance(values, list):
            lines.extend(f"{item}{suffix}" for item in values if isinstance(item, str))
    return "\n".join(dict.fromkeys(lines)) or None


def _render_git_detail(normalized: str, payload: dict[str, object]) -> str | None:
    if normalized == "gitstatus":
        entries = payload.get("entries")
        if isinstance(entries, list):
            lines = []
            for item in entries:
                if isinstance(item, dict):
                    status = item.get("status")
                    path = item.get("path")
                    if isinstance(status, str) and isinstance(path, str):
                        lines.append(f"{status} {path}")
            return "\n".join(lines) or None
    if normalized == "gitlog":
        commits = payload.get("commits")
        if isinstance(commits, list):
            lines = []
            for item in commits:
                if isinstance(item, dict):
                    commit = item.get("short_hash") or item.get("hash")
                    subject = item.get("subject")
                    if isinstance(commit, str) and isinstance(subject, str):
                        lines.append(f"{commit} {subject}")
            return "\n".join(lines) or None
    return _string_from(payload, "content", "diff", "stat")


def _render_shell_output(payload: dict[str, object]) -> str | None:
    combined = _string_from(payload, "output")
    if combined:
        return combined
    chunks = [
        value
        for key in ("stdout", "stderr")
        if isinstance((value := payload.get(key)), str) and value
    ]
    return "\n".join(chunks) or None


def _render_web_detail(payload: dict[str, object]) -> str | None:
    content = _string_from(payload, "content", "markdown", "answer")
    if content:
        return content
    results = payload.get("results")
    if not isinstance(results, list):
        return None
    lines: list[str] = []
    for item in results:
        if not isinstance(item, dict):
            continue
        title = item.get("title")
        url = item.get("url") or item.get("link")
        if isinstance(title, str) and isinstance(url, str):
            lines.append(f"{title}\n  {url}")
        elif isinstance(title, str):
            lines.append(title)
    return "\n".join(lines) or None


def _render_diagnostic_detail(payload: dict[str, object]) -> str | None:
    output = _string_from(payload, "output", "stdout", "stderr")
    if output:
        return output
    diagnostics = payload.get("diagnostics")
    if not isinstance(diagnostics, list):
        return None
    lines: list[str] = []
    for item in diagnostics:
        if isinstance(item, str):
            lines.append(item)
        elif isinstance(item, dict):
            path = item.get("path")
            line = item.get("line") or item.get("line_number")
            message = item.get("message") or item.get("text")
            if isinstance(path, str) and isinstance(message, str):
                prefix = f"{path}:{line}" if isinstance(line, int) else path
                lines.append(f"{prefix}: {message}")
    return "\n".join(lines) or None


def _render_evidence(evidence_items: tuple[ToolEvidence, ...]) -> str | None:
    lines: list[str] = []
    for evidence in evidence_items:
        location = evidence.path or evidence.title
        if evidence.line_start is not None:
            location = f"{location}:{evidence.line_start}"
        lines.append(f"[{evidence.kind}] {location}")
        if evidence.snippet:
            lines.append(f"  {evidence.snippet.strip()}")
    return "\n".join(lines) or None


def _preserve_payload_truncation(
    envelope: ToolDisplayEnvelope,
    payload: dict[str, object],
) -> ToolDisplayEnvelope:
    if payload.get("truncated") is not True:
        return envelope
    raw_omitted = payload.get("omitted_chars")
    if not isinstance(raw_omitted, int) or isinstance(raw_omitted, bool):
        raw_omitted = payload.get("truncated_chars")
    if not isinstance(raw_omitted, int) or isinstance(raw_omitted, bool):
        raw_omitted = 0
    return replace(
        envelope,
        truncated=True,
        omitted_chars=envelope.omitted_chars + max(0, raw_omitted),
    )


__all__ = [
    "DISPLAY_DETAIL_MAX_CHARS",
    "DISPLAY_ERROR_MAX_CHARS",
    "DISPLAY_METRICS_MAX_ITEMS",
    "DISPLAY_PRESENTATIONS",
    "DISPLAY_STATUSES",
    "DISPLAY_SUMMARY_MAX_CHARS",
    "DISPLAY_TARGET_MAX_CHARS",
    "ToolDisplayEnvelope",
    "ToolDisplayProjector",
]
