from __future__ import annotations

import re

from mycli.domain.tooling.calls import ToolEvidence
from mycli.services.file_change_display import mutation_receipt
from mycli.tools.base import ToolResult


SHELL_RESULT_TOOLS = frozenset(
    {"run_shell", "Shell", "Bash", "ShellOutput", "BashOutput", "WriteStdin"}
)
MUTATION_RESULT_TOOLS = frozenset({"Write", "Edit", "Patch"})


class ToolResultFormatter:
    def __init__(
        self,
        *,
        read_file_max_chars: int = 8000,
        read_file_range_max_chars: int = 6000,
        run_shell_max_chars: int = 500,
        search_max_matches: int = 10,
        default_max_chars: int = 1600,
    ) -> None:
        self._read_file_max = read_file_max_chars
        self._read_file_range_max = read_file_range_max_chars
        self._run_shell_max = run_shell_max_chars
        self._search_max_matches = search_max_matches
        self._default_max = default_max_chars

    def format(self, tool_name: str, result: ToolResult) -> str:
        if tool_name == "Skill" and result.success:
            content = result.raw_payload.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
        rendered = self._render(tool_name, result)
        max_chars = self._limit_for(tool_name)
        if len(rendered) <= max_chars:
            return rendered
        return rendered[: max_chars - 3].rstrip() + "..."

    def _limit_for(self, tool_name: str) -> int:
        if tool_name in {"read_file", "Read"}:
            return self._read_file_max
        if tool_name == "read_file_range":
            return self._read_file_range_max
        if tool_name in SHELL_RESULT_TOOLS:
            return self._run_shell_max
        return self._default_max

    def _render(self, tool_name: str, result: ToolResult) -> str:
        if not result.success:
            if tool_name in MUTATION_RESULT_TOOLS:
                return mutation_receipt(result)
            if tool_name in SHELL_RESULT_TOOLS:
                rendered = self._render_shell_result(result)
                if rendered is not None:
                    return rendered
            return self._render_failure(tool_name, result)
        if tool_name in {"read_file", "read_file_range", "Read"}:
            rendered = self._render_read_result(tool_name, result)
            if rendered is not None:
                return rendered
        if result.evidence and tool_name in {"read_file", "read_file_range", "Read"}:
            notice = (
                "[文件内容较长，已截断。使用 Read with offset/limit 读取后续内容。]"
                if self._payload_content_is_truncated(tool_name, result)
                else "[文件读取完毕。如果你已有足够信息，现在就可以回答。]"
            )
            rendered = self._render_from_evidence(
                result,
                snippet_max_chars=self._evidence_snippet_limit(tool_name, result, notice),
            )
            if self._payload_content_is_truncated(tool_name, result):
                return (
                    f"{rendered}\n"
                    f"{notice}"
                )
            return f"{rendered}\n{notice}"
        payload_rendered = self._render_from_payload(tool_name, result)
        if payload_rendered is not None:
            return payload_rendered
        if result.evidence:
            return self._render_from_evidence(result)
        return result.summary

    def _render_failure(self, tool_name: str, result: ToolResult) -> str:
        parts = [f"{_display_tool_name(tool_name)} failed"]
        payload_path = result.raw_payload.get("path")
        if isinstance(payload_path, str) and payload_path:
            parts.append(f"Path: {payload_path}")
        error_kind = result.raw_payload.get("error_kind")
        if isinstance(error_kind, str) and error_kind:
            parts.append(f"Error kind: {error_kind}")
        if result.error:
            parts.append(f"Error: {result.error}")
        return "\n".join(parts)

    def _render_from_evidence(
        self,
        result: ToolResult,
        *,
        snippet_max_chars: int = 800,
    ) -> str:
        parts = [result.summary]
        path = result.raw_payload.get("path")
        if isinstance(path, str) and path:
            parts.append(f"File: {path}")
        parts.append("Evidence:")
        for evidence in result.evidence:
            parts.append(self._format_evidence_header(evidence))
            if evidence.snippet:
                snippet = _normalize_whitespace(evidence.snippet)
                parts.append(f"  snippet: {snippet[:snippet_max_chars]}")
        return "\n".join(parts)

    def _format_evidence_header(self, evidence: ToolEvidence) -> str:
        location = evidence.path or evidence.title
        if evidence.path and evidence.line_start is not None and evidence.line_end is not None:
            if evidence.line_start == evidence.line_end:
                location = f"{evidence.path}:{evidence.line_start}"
            else:
                location = f"{evidence.path}:{evidence.line_start}-{evidence.line_end}"
        return f"- [{evidence.kind}] {location}"

    def _render_from_payload(
        self,
        tool_name: str,
        result: ToolResult,
    ) -> str | None:
        payload = result.raw_payload
        if tool_name in {"search_text", "Grep"}:
            rendered = self._render_search_result(result)
            if rendered is not None:
                return rendered
        if tool_name == "Glob":
            rendered = self._render_glob_result(result)
            if rendered is not None:
                return rendered
        if tool_name in {"list_directory", "LS"}:
            rendered = self._render_directory_result(result)
            if rendered is not None:
                return rendered
        if tool_name in SHELL_RESULT_TOOLS:
            rendered = self._render_shell_result(result)
            if rendered is not None:
                return rendered
        if tool_name in {"GitStatus", "GitDiff", "GitLog", "GitShow"}:
            rendered = self._render_git_result(tool_name, result)
            if rendered is not None:
                return rendered
        if tool_name in {"Write", "Edit", "Patch"}:
            rendered = self._render_mutation_result(tool_name, result)
            if rendered is not None:
                return rendered
        rendered = self._render_diff_result(result)
        if rendered is not None:
            return rendered

        content = payload.get("content")
        if isinstance(content, str) and content:
            return self._render_content_result(result, content)
        return None

    def _render_read_result(self, tool_name: str, result: ToolResult) -> str | None:
        content = result.raw_payload.get("content")
        if not isinstance(content, str) or not content:
            return None

        path = result.raw_payload.get("path")
        parts = ["Read succeeded"]
        if isinstance(path, str) and path:
            parts.append(f"Path: {path}")

        range_text = self._read_range_text(result)
        if range_text is not None:
            parts.append(range_text)

        if result.raw_payload.get("dedup") is True:
            parts.append("Status: unchanged duplicate")
            parts.append(
                "Note: file is unchanged for this offset/limit; reuse the previous content."
            )
            return "\n".join(parts)

        if self._read_payload_truncated(result):
            next_offset = self._next_read_offset(result)
            if next_offset is not None:
                note = f"Note: output truncated; use Read with offset={next_offset} and limit to continue."
            else:
                note = "Note: output truncated; use Read with offset/limit to continue."
        elif self._payload_content_is_truncated(tool_name, result):
            note = "Note: output truncated; use Read with offset/limit to continue."
        else:
            note = "Note: file read complete."

        output = _strip_read_truncation_notice(content).rstrip()
        if output:
            parts.append("Output:")
            output_budget = self._read_output_budget(tool_name, parts=parts, note=note)
            parts.append(_bounded_block(output, output_budget))

        parts.append(note)
        return "\n".join(parts)

    def _render_mutation_result(self, tool_name: str, result: ToolResult) -> str | None:
        path = result.raw_payload.get("path")
        status = result.raw_payload.get("status")
        diff = result.raw_payload.get("diff")
        file_changes = result.raw_payload.get("file_changes")
        if (
            not isinstance(path, str)
            and not isinstance(status, str)
            and not isinstance(diff, str)
            and not isinstance(file_changes, list)
        ):
            return None
        return mutation_receipt(result)

    def _read_output_budget(self, tool_name: str, *, parts: list[str], note: str) -> int:
        fixed_chars = sum(len(part) + 1 for part in parts) + len(note) + 1
        return max(200, self._limit_for(tool_name) - fixed_chars)

    def _read_range_text(self, result: ToolResult) -> str | None:
        start = _int_payload(result, "actual_start_line", "start_line", "offset")
        end = _int_payload(result, "actual_end_line", "end_line")
        total = _int_payload(result, "total_lines")
        if start is None or end is None:
            evidence = result.evidence[0] if result.evidence else None
            if evidence is not None:
                if start is None:
                    start = evidence.line_start
                if end is None:
                    end = evidence.line_end
        if start is None:
            start = _first_numbered_line(result.raw_payload.get("content"))
        if end is None and start is not None:
            shown_lines = _int_payload(result, "shown_lines")
            if shown_lines is not None and shown_lines > 0:
                end = start + shown_lines - 1
        if start is None or end is None:
            return None
        if total is not None:
            return f"Range: lines {start}-{end} of {total}"
        return f"Range: lines {start}-{end}"

    def _read_payload_truncated(self, result: ToolResult) -> bool:
        return result.raw_payload.get("truncated") is True

    def _next_read_offset(self, result: ToolResult) -> int | None:
        end = _int_payload(result, "actual_end_line", "end_line")
        if end is None:
            start = _int_payload(result, "actual_start_line", "start_line", "offset")
            shown_lines = _int_payload(result, "shown_lines")
            if start is not None and shown_lines is not None and shown_lines > 0:
                end = start + shown_lines - 1
        if end is None:
            return None
        return end + 1

    def _render_search_result(self, result: ToolResult) -> str | None:
        matches = result.raw_payload.get("matches")
        if not isinstance(matches, list):
            return None
        structured = result.raw_payload.get("structured_matches")
        mode = result.raw_payload.get("mode")
        if isinstance(structured, list) and mode == "files_with_matches":
            parts = [result.summary, f"Files with matches ({len(structured)}):"]
            for item in structured[: self._search_max_matches]:
                if isinstance(item, dict) and isinstance(item.get("path"), str):
                    parts.append(f"  {item['path']}")
            if len(structured) > self._search_max_matches:
                parts.append(
                    f"  ... and {len(structured) - self._search_max_matches} more files. "
                    "Narrow path/include if needed."
                )
            parts.append("[搜索完毕。如果你已有足够信息，现在就可以回答。]")
            return "\n".join(parts)

        if isinstance(structured, list):
            parts = [result.summary, f"Matches ({len(structured)} total):"]
            for item in structured[: self._search_max_matches]:
                if not isinstance(item, dict):
                    continue
                path = item.get("path", "")
                line = item.get("line_number", "")
                text = item.get("line", "")
                parts.append(f"  {path}:{line}: {text}")
            if len(structured) > self._search_max_matches:
                parts.append(
                    f"  ... and {len(structured) - self._search_max_matches} more matches. "
                    "Narrow your search if needed."
                )
            parts.append("[搜索完毕。如果你已有足够信息，现在就可以回答。]")
            if result.evidence:
                parts.append("Evidence:")
                for evidence in result.evidence:
                    parts.append(self._format_evidence_header(evidence))
                    if evidence.snippet:
                        snippet = _normalize_whitespace(evidence.snippet)
                        parts.append(f"  snippet: {snippet[:800]}")
            return "\n".join(parts)

        parts = [result.summary, f"Matches ({len(matches)} total):"]
        for item in matches[: self._search_max_matches]:
            if not isinstance(item, dict):
                continue
            path = item.get("path", "")
            line = item.get("line_number", "")
            text = item.get("line", "")
            parts.append(f"  {path}:{line}: {text}")
        if len(matches) > self._search_max_matches:
            parts.append(
                f"  ... and {len(matches) - self._search_max_matches} more matches. "
                "Narrow your search if needed."
            )
        parts.append("[搜索完毕。如果你已有足够信息，现在就可以回答。]")
        if result.evidence:
            parts.append("Evidence:")
            for evidence in result.evidence:
                parts.append(self._format_evidence_header(evidence))
                if evidence.snippet:
                    snippet = _normalize_whitespace(evidence.snippet)
                    parts.append(f"  snippet: {snippet[:800]}")
        return "\n".join(parts)

    def _render_directory_result(self, result: ToolResult) -> str | None:
        dirs = result.raw_payload.get("dirs")
        files = result.raw_payload.get("files")
        hidden = result.raw_payload.get("hidden")
        if not isinstance(dirs, list) or not isinstance(files, list) or not isinstance(hidden, list):
            entries = result.raw_payload.get("entries")
            if not isinstance(entries, list):
                return None
            display_entries = [str(entry) for entry in entries if isinstance(entry, str)]
            parts = ["LS succeeded"]
            path = result.raw_payload.get("path")
            if isinstance(path, str) and path:
                parts.append(f"Path: {path}")
            parts.append(f"Total entries: {len(display_entries)}")
            preview = display_entries[:10]
            if preview:
                parts.append(f"Entries: {', '.join(preview)}")
            if len(display_entries) > len(preview):
                parts.append(f"... and {len(display_entries) - len(preview)} more entries.")
            return "\n".join(parts)
        dir_names = [f"{entry}/" for entry in dirs if isinstance(entry, str)]
        file_names = [entry for entry in files if isinstance(entry, str)]
        hidden_names = [entry for entry in hidden if isinstance(entry, str)]
        total = result.raw_payload.get("total")
        parts = ["LS succeeded"]
        path = result.raw_payload.get("path")
        if isinstance(path, str) and path:
            parts.append(f"Path: {path}")
        parts.append(f"Total entries: {total if isinstance(total, int) else len(dir_names) + len(file_names) + len(hidden_names)}")
        parts.append(f"Directories ({len(dir_names)}): {', '.join(dir_names[:10]) or 'none'}")
        parts.append(f"Files ({len(file_names)}): {', '.join(file_names[:10]) or 'none'}")
        parts.append(f"Hidden ({len(hidden_names)}): {', '.join(hidden_names[:10]) or 'none'}")
        return "\n".join(parts)

    def _render_glob_result(self, result: ToolResult) -> str | None:
        files = result.raw_payload.get("files")
        dirs = result.raw_payload.get("dirs")
        if not isinstance(files, list) or not isinstance(dirs, list):
            return None
        pattern = result.raw_payload.get("pattern")
        pattern_text = pattern if isinstance(pattern, str) and pattern else "<unknown>"
        file_names = [entry for entry in files if isinstance(entry, str)]
        dir_names = [f"{entry}/" for entry in dirs if isinstance(entry, str)]
        parts = [
            result.summary,
            f"Glob matches for {pattern_text}: files={len(file_names)} dirs={len(dir_names)}",
        ]
        preview = [*dir_names[:5], *file_names[:10]]
        if preview:
            parts.append(f"Matches: {', '.join(preview)}")
        if result.raw_payload.get("truncated") is True:
            parts.append("Results truncated. Narrow the glob pattern or path.")
        return "\n".join(parts)

    def _render_shell_result(self, result: ToolResult) -> str | None:
        if not result.raw_payload:
            return None
        metadata = self._render_shell_metadata(result)
        combined = result.raw_payload.get("output")
        stdout = result.raw_payload.get("stdout")
        stderr = result.raw_payload.get("stderr")
        output = combined if isinstance(combined, str) and combined.strip() else stdout
        if not isinstance(output, str) or not output.strip():
            output = stderr
        parts = ["Command succeeded" if result.success else "Command failed", *metadata]
        if isinstance(output, str) and output.strip():
            lines = output.rstrip().splitlines()
            preview_lines = lines[:20]
            parts.append("Output:")
            parts.append("\n".join(preview_lines))
            if len(lines) > len(preview_lines):
                parts.append(
                    f"Note: output truncated; showing first {len(preview_lines)} of {len(lines)} lines."
                )
        if result.raw_payload.get("truncated") is True:
            truncated_chars = result.raw_payload.get("truncated_chars")
            if isinstance(truncated_chars, int) and truncated_chars > 0:
                parts.append(f"Note: output truncated before formatting; {truncated_chars} chars omitted.")
            else:
                parts.append("Note: output truncated before formatting.")
        if result.raw_payload.get("timed_out") is True:
            parts.append("Note: command timed out.")
        if result.raw_payload.get("interrupted") is True:
            parts.append("Note: command was aborted before completion.")
        return "\n".join(parts)

    def _render_shell_metadata(self, result: ToolResult) -> list[str]:
        payload = result.raw_payload
        parts: list[str] = []
        shell_id = payload.get("shell_id") or payload.get("bash_id")
        if isinstance(shell_id, str) and shell_id:
            parts.append(f"Shell ID: {shell_id}")
        status = payload.get("status")
        if isinstance(status, str) and status:
            parts.append(f"Status: {status}")
        process_state = payload.get("process_state")
        if isinstance(process_state, str) and process_state:
            parts.append(f"Process state: {process_state}")
        exit_code = payload.get("exit_code")
        if isinstance(exit_code, int):
            parts.append(f"Exit code: {exit_code}")
        duration_ms = payload.get("duration_ms")
        if isinstance(duration_ms, int):
            parts.append(f"Wall time: {duration_ms / 1000:.3f} seconds")
        cwd = payload.get("cwd")
        if isinstance(cwd, str) and cwd:
            parts.append(f"Cwd: {cwd}")
        error_kind = payload.get("error_kind")
        if isinstance(error_kind, str) and error_kind:
            parts.append(f"Error kind: {error_kind}")
        command_pattern = payload.get("command_pattern")
        if isinstance(command_pattern, str) and command_pattern:
            parts.append(f"Command pattern: {command_pattern}")
        return parts

    def _render_git_result(self, tool_name: str, result: ToolResult) -> str | None:
        if tool_name == "GitStatus":
            entries = result.raw_payload.get("entries")
            if not isinstance(entries, list):
                return None
            parts = ["GitStatus succeeded"]
            branch = result.raw_payload.get("branch")
            upstream = result.raw_payload.get("upstream")
            if isinstance(branch, str) and branch:
                parts.append(f"Branch: {branch}")
            if isinstance(upstream, str) and upstream:
                parts.append(f"Upstream: {upstream}")
            parts.append(f"Changed paths: {len(entries)}")
            for item in entries[:20]:
                if isinstance(item, dict):
                    status = item.get("status", "")
                    path = item.get("path", "")
                    parts.append(f"  {status} {path}")
            if len(entries) > 20:
                parts.append(f"  ... and {len(entries) - 20} more changed path(s).")
            return "\n".join(parts)

        if tool_name == "GitDiff":
            diff = result.raw_payload.get("diff")
            stat = result.raw_payload.get("stat")
            shortstat = result.raw_payload.get("shortstat")
            path = result.raw_payload.get("path")
            parts = ["GitDiff succeeded"]
            parts.append(f"Path: {path if isinstance(path, str) and path else 'workspace'}")
            parts.append(f"Staged: {_bool_text(result.raw_payload.get('staged') is True)}")
            if isinstance(shortstat, str) and shortstat.strip():
                parts.append(f"Shortstat: {shortstat.strip()}")
            if isinstance(stat, str) and stat.strip():
                parts.append(f"Stat:\n{stat.strip()[:500]}")
            if isinstance(diff, str) and diff.strip():
                lines = diff.rstrip().splitlines()
                preview = lines[:40]
                parts.append(f"Diff preview (first {len(preview)} of {len(lines)} lines):")
                parts.append("\n".join(preview))
            if result.raw_payload.get("truncated") is True:
                parts.append("Note: diff truncated; narrow path or staged scope if needed.")
            return "\n".join(parts)

        if tool_name == "GitLog":
            commits = result.raw_payload.get("commits")
            if not isinstance(commits, list):
                return None
            parts = ["GitLog succeeded", f"Commits: {len(commits)}"]
            for item in commits[:20]:
                if not isinstance(item, dict):
                    continue
                short_hash = item.get("short_hash", "")
                subject = item.get("subject", "")
                date = item.get("date", "")
                parts.append(f"  {short_hash} {date} {subject}")
            return "\n".join(parts)

        if tool_name == "GitShow":
            metadata = result.raw_payload.get("metadata")
            content = result.raw_payload.get("content")
            parts = ["GitShow succeeded"]
            ref = result.raw_payload.get("ref")
            path = result.raw_payload.get("path")
            if isinstance(ref, str) and ref:
                parts.append(f"Ref: {ref}")
            if isinstance(path, str) and path:
                parts.append(f"Path: {path}")
            if isinstance(metadata, dict):
                short_hash = metadata.get("short_hash")
                subject = metadata.get("subject")
                author = metadata.get("author")
                date = metadata.get("date")
                if isinstance(short_hash, str) and isinstance(subject, str):
                    parts.append(f"Commit: {short_hash} {subject}")
                if isinstance(author, str) and isinstance(date, str):
                    parts.append(f"Author/date: {author} {date}")
            if isinstance(content, str) and content.strip():
                lines = content.rstrip().splitlines()
                preview = lines[:40]
                parts.append(f"Content preview ({len(preview)} of {len(lines)} lines):")
                parts.append("\n".join(preview))
            if result.raw_payload.get("truncated") is True:
                parts.append("Note: git show output truncated; narrow ref/path if needed.")
            return "\n".join(parts)
        return None

    def _render_diff_result(self, result: ToolResult) -> str | None:
        diff = result.raw_payload.get("diff")
        if not isinstance(diff, str) or not diff:
            return None
        path = result.raw_payload.get("path")
        status = result.raw_payload.get("status")
        matches = result.raw_payload.get("matches")
        preview = diff[:800]
        parts = [result.summary]
        if isinstance(path, str) and path:
            parts.append(f"Path: {path}")
        if isinstance(status, str) and status:
            parts.append(f"Status: {status}")
        if isinstance(matches, int):
            parts.append(f"Matches: {matches}")
        parts.append(f"Diff preview: {preview}")
        return "\n".join(parts)

    def _render_content_result(self, result: ToolResult, content: str) -> str:
        parts = [result.summary]
        path = result.raw_payload.get("path")
        if isinstance(path, str) and path:
            parts.append(f"File: {path}")
        preview = _normalize_whitespace(content)[:1200]
        parts.append(preview)
        if len(content) > 1200:
            parts.append("[文件内容较长，已截断。使用 Read with offset/limit 读取后续内容。]")
        else:
            parts.append("[文件读取完毕。如果你已有足够信息，现在就可以回答。]")
        return "\n".join(parts)

    def _payload_content_is_truncated(self, tool_name: str, result: ToolResult) -> bool:
        content = result.raw_payload.get("content")
        return isinstance(content, str) and len(content) > self._content_limit_for(tool_name)

    def _content_limit_for(self, tool_name: str) -> int:
        if tool_name in {"read_file", "Read"}:
            return self._read_file_max
        if tool_name == "read_file_range":
            return self._read_file_range_max
        return 1200

    def _evidence_snippet_limit(
        self,
        tool_name: str,
        result: ToolResult,
        notice: str,
    ) -> int:
        max_chars = self._limit_for(tool_name)
        fixed_chars = len(result.summary) + len("Evidence:") + len(notice) + 16
        for evidence in result.evidence:
            fixed_chars += len(self._format_evidence_header(evidence)) + len("  snippet: ") + 2
        return max(200, max_chars - fixed_chars)


def _normalize_whitespace(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _display_tool_name(tool_name: str) -> str:
    if tool_name in {"read_file", "read_file_range"}:
        return "Read"
    if tool_name == "run_shell":
        return "Shell"
    if tool_name in {"list_directory"}:
        return "LS"
    return tool_name or "Tool"


def _int_payload(result: ToolResult, *keys: str) -> int | None:
    for key in keys:
        value = result.raw_payload.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
    return None


def _first_numbered_line(value: object) -> int | None:
    if not isinstance(value, str):
        return None
    for line in value.splitlines():
        match = re.match(r"\s*(\d+)\t", line)
        if match is not None:
            return int(match.group(1))
    return None


def _strip_read_truncation_notice(content: str) -> str:
    lines = [
        line
        for line in content.splitlines()
        if not line.startswith("... (output truncated,")
    ]
    return "\n".join(lines)


def _bounded_block(value: str, max_chars: int) -> str:
    if len(value) <= max_chars:
        return value
    return value[: max(0, max_chars - 4)].rstrip() + "\n..."


def _bool_text(value: bool) -> str:
    return "true" if value else "false"
