from __future__ import annotations

import re

from mycli.domain.tooling.calls import ToolEvidence
from mycli.tools.base import ToolResult


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
        if tool_name in {"run_shell", "Bash"}:
            return self._run_shell_max
        return self._default_max

    def _render(self, tool_name: str, result: ToolResult) -> str:
        if not result.success:
            return self._render_failure(result)
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

    def _render_failure(self, result: ToolResult) -> str:
        parts = [result.summary]
        if result.error:
            parts.append(f"Error: {result.error}")
        error_kind = result.raw_payload.get("error_kind")
        if isinstance(error_kind, str) and error_kind:
            parts.append(f"Error kind: {error_kind}")
        payload_path = result.raw_payload.get("path")
        if isinstance(payload_path, str) and payload_path:
            parts.append(f"Path: {payload_path}")
        return "\n".join(parts)

    def _render_from_evidence(
        self,
        result: ToolResult,
        *,
        snippet_max_chars: int = 800,
    ) -> str:
        parts = [result.summary, "Evidence:"]
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
        if tool_name in {"list_directory", "LS"}:
            rendered = self._render_directory_result(result)
            if rendered is not None:
                return rendered
        if tool_name in {"run_shell", "Bash"}:
            rendered = self._render_shell_result(result)
            if rendered is not None:
                return rendered
        rendered = self._render_diff_result(result)
        if rendered is not None:
            return rendered

        content = payload.get("content")
        if isinstance(content, str) and content:
            return self._render_content_result(result, content)
        return None

    def _render_search_result(self, result: ToolResult) -> str | None:
        matches = result.raw_payload.get("matches")
        if not isinstance(matches, list):
            return None
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
        entries = result.raw_payload.get("entries")
        if not isinstance(entries, list):
            return None
        display_entries = [str(entry) for entry in entries if isinstance(entry, str)]
        parts = [result.summary, f"Total entries: {len(display_entries)}"]
        preview = display_entries[:10]
        if preview:
            parts.append(f"Entries: {', '.join(preview)}")
        if len(display_entries) > len(preview):
            parts.append(f"... and {len(display_entries) - len(preview)} more entries.")
        return "\n".join(parts)

    def _render_shell_result(self, result: ToolResult) -> str | None:
        stdout = result.raw_payload.get("stdout")
        stderr = result.raw_payload.get("stderr")
        output = stdout if isinstance(stdout, str) and stdout.strip() else stderr
        if not isinstance(output, str) or not output.strip():
            return result.summary
        lines = output.rstrip().splitlines()
        tail = lines[-10:] if len(lines) > 10 else lines
        preview = _normalize_whitespace(output)[:240]
        parts = [
            result.summary,
            f"Stdout preview: {preview}",
            f"Output (last {len(tail)} of {len(lines)} lines):",
            "\n".join(tail),
            "[命令执行完毕。如果你已有足够信息，现在就可以回答。]",
        ]
        return "\n".join(parts)

    def _render_diff_result(self, result: ToolResult) -> str | None:
        diff = result.raw_payload.get("diff")
        if not isinstance(diff, str) or not diff:
            return None
        preview = diff[:800]
        return "\n".join([result.summary, f"Diff preview: {preview}"])

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
