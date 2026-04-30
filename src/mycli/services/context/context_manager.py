from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.conversation import Message
from mycli.domain.runtime import HistoryItem, HistoryItemType, RuntimeBlock
from mycli.domain.tools import ToolEvidence
from mycli.tools.base import ToolResultV2


@dataclass(slots=True, frozen=True)
class ManagedContext:
    messages: tuple[Message, ...]
    summary: str | None = None


class ContextManager:
    def build(
        self,
        *,
        conversation: tuple[Message, ...],
        history_items: tuple[HistoryItem, ...] = (),
        recent_message_count: int,
        max_summary_chars: int = 512,
    ) -> ManagedContext:
        if not conversation and history_items:
            conversation = self.messages_from_history(history_items)

        recent: tuple[Message, ...]
        older: tuple[Message, ...]
        if recent_message_count <= 0:
            recent = ()
            older = conversation
        else:
            recent_start = max(0, len(conversation) - recent_message_count)
            recent_start = self._expand_recent_start_to_tool_boundary(
                conversation,
                recent_start,
            )
            recent = conversation[recent_start:]
            older = conversation[:recent_start]

        summary = None
        if older:
            lines = [
                f"- {message.role}: {content[:96]}"
                for message in older
                if (content := self._summary_content(message))
            ]
            rendered = "\n".join(lines)
            if rendered:
                summary = (
                    rendered
                    if len(rendered) <= max_summary_chars
                    else rendered[: max_summary_chars - 3].rstrip() + "..."
                )
        return ManagedContext(messages=recent, summary=summary)

    def _summary_content(self, message: Message) -> str:
        if not message.blocks:
            return " ".join(message.content.split())
        text = Message.text_content_from_blocks(message.blocks)
        return " ".join(text.split())

    def _expand_recent_start_to_tool_boundary(
        self,
        conversation: tuple[Message, ...],
        recent_start: int,
    ) -> int:
        while recent_start > 0 and conversation[recent_start].role == "tool":
            recent_start -= 1
        return recent_start

    def messages_from_history(
        self,
        history_items: tuple[HistoryItem, ...],
    ) -> tuple[Message, ...]:
        messages: list[Message] = []
        for item in history_items:
            if item.type is HistoryItemType.USER_MESSAGE:
                messages.append(
                    Message(
                        role="user",
                        content=item.text or "",
                        blocks=(() if not item.text else (RuntimeBlock(type="text", text=item.text),)),
                    )
                )
            elif item.type is HistoryItemType.ASSISTANT_MESSAGE:
                messages.append(
                    Message(
                        role="assistant",
                        content=item.text or "",
                        blocks=(
                            ()
                            if not item.text
                            else (
                                RuntimeBlock(
                                    type="text",
                                    text=item.text,
                                    provider_id=self._provider_id(item),
                                    metadata=dict(item.metadata),
                                ),
                            )
                        ),
                    )
                )
            elif item.type is HistoryItemType.REASONING:
                if not item.text:
                    continue
                messages.append(
                    Message(
                        role="assistant",
                        content=item.text,
                        blocks=(
                            RuntimeBlock(
                                type="reasoning",
                                text=item.text,
                                provider_id=self._provider_id(item),
                                metadata=dict(item.metadata),
                            ),
                        ),
                    )
                )
            elif item.type is HistoryItemType.TOOL_CALL:
                arguments = item.metadata.get("arguments")
                tool_arguments = arguments if isinstance(arguments, dict) else {}
                messages.append(
                    Message(
                        role="assistant",
                        content=item.text or "",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                text=item.text,
                                tool_name=item.tool_name,
                                tool_arguments=tool_arguments,
                                call_id=item.call_id,
                                provider_id=self._provider_id(item),
                                metadata=dict(item.metadata),
                            ),
                        ),
                    )
                )
            elif item.type is HistoryItemType.TOOL_RESULT:
                content = item.metadata.get("transcript_content")
                if not isinstance(content, str):
                    content = item.text or ""
                messages.append(
                    Message(
                        role="tool",
                        content=content,
                        tool_call_id=item.call_id,
                        blocks=(
                            RuntimeBlock(
                                type="tool_result",
                                text=content,
                                tool_name=item.tool_name,
                                call_id=item.call_id,
                                provider_id=self._provider_id(item),
                                metadata=dict(item.metadata),
                            ),
                        ),
                    )
                )
        return tuple(messages)

    def _provider_id(self, item: HistoryItem) -> str | None:
        provider_id = item.metadata.get("provider_id")
        if isinstance(provider_id, str):
            return provider_id
        return None

    def render_tool_result(
        self,
        result: ToolResultV2,
        *,
        max_chars: int = 1600,
    ) -> str:
        rendered = self._render_tool_result_details(result)
        if len(rendered) <= max_chars:
            return rendered
        return rendered[: max_chars - 3] + "..."

    def _render_tool_result_details(self, result: ToolResultV2) -> str:
        if not result.success:
            details = [result.summary]
            if result.error:
                details.append(f"Error: {result.error}")
            error_kind = result.raw_payload.get("error_kind")
            if isinstance(error_kind, str) and error_kind:
                details.append(f"Error kind: {error_kind}")
            payload_path = result.raw_payload.get("path")
            if isinstance(payload_path, str) and payload_path:
                details.append(f"Path: {payload_path}")
            return "\n".join(details)
        if result.evidence:
            return self._render_tool_result_from_evidence(result)
        return self._render_tool_result_from_payload(result)

    def _render_tool_result_from_evidence(self, result: ToolResultV2) -> str:
        details: list[str] = [result.summary]
        details.append("Evidence:")
        for evidence in result.evidence:
            details.append(self._format_evidence_header(evidence))
            if evidence.snippet:
                details.extend(self._format_evidence_snippet(evidence))
        return "\n".join(details)

    def _format_evidence_snippet(self, evidence: ToolEvidence) -> list[str]:
        normalized = self._normalize_whitespace(evidence.snippet or "")
        if not normalized:
            return []

        if evidence.kind != "file_excerpt":
            return [f"  snippet: {normalized[:200]}"]

        if len(normalized) <= 1200:
            return [f"  snippet: {normalized}"]

        if len(normalized) <= 4000:
            return [
                f"  snippet: {normalized[:1200]}...",
                "  note: excerpt truncated; use read_file_range for exact sections if needed.",
            ]

        return [
            f"  snippet: {normalized[:400]}...",
            "  note: file is large; use read_file_range for exact sections.",
        ]

    def _format_evidence_header(self, evidence: ToolEvidence) -> str:
        location = evidence.path or evidence.title
        if evidence.path and evidence.line_start is not None and evidence.line_end is not None:
            if evidence.line_start == evidence.line_end:
                location = f"{evidence.path}:{evidence.line_start}"
            else:
                location = f"{evidence.path}:{evidence.line_start}-{evidence.line_end}"
        return f"- [{evidence.kind}] {location}"

    def _render_tool_result_from_payload(self, result: ToolResultV2) -> str:
        details: list[str] = [result.summary]
        payload = result.raw_payload

        query = payload.get("query")
        if isinstance(query, str) and query:
            details.append(f"Search query: {query}")

        payload_path = payload.get("path")
        glob = payload.get("glob")
        case_sensitive = payload.get("case_sensitive")
        max_matches = payload.get("max_matches")
        if (
            isinstance(payload_path, str)
            and payload_path
            and isinstance(glob, str)
            and glob
            and isinstance(case_sensitive, bool)
            and isinstance(max_matches, int)
        ):
            details.append(
                "Search scope: "
                f"path={payload_path} glob={glob} "
                f"case_sensitive={case_sensitive} max_matches={max_matches}"
            )

        matches = payload.get("matches")
        if isinstance(matches, list) and matches:
            lines: list[str] = []
            for item in matches[:5]:
                if not isinstance(item, dict):
                    continue
                match_path = item.get("path")
                line_number = item.get("line_number")
                line = item.get("line")
                if (
                    isinstance(match_path, str)
                    and isinstance(line_number, int)
                    and isinstance(line, str)
                ):
                    lines.append(f"{match_path}:{line_number}: {line}")
            if lines:
                details.append("Matches:")
                details.extend(lines)

        content = payload.get("content")
        if isinstance(content, str) and content:
            if isinstance(payload_path, str) and payload_path:
                details.append(f"File path: {payload_path}")
            preview = self._normalize_whitespace(content)[:240]
            if preview:
                details.append(f"Content preview: {preview}")
            if isinstance(payload_path, str) and payload_path.lower().endswith("readme.md"):
                details.append(
                    "Note: README is supporting context; verify entrypoints and module boundaries in real source or config files."
                )

        diff = payload.get("diff")
        if isinstance(diff, str) and diff:
            preview = diff[:240]
            if preview:
                details.append(f"Diff preview: {preview}")

        stdout = payload.get("stdout")
        if isinstance(stdout, str) and stdout.strip():
            preview = self._normalize_whitespace(stdout)[:240]
            if preview:
                details.append(f"Stdout preview: {preview}")

        stderr = payload.get("stderr")
        if isinstance(stderr, str) and stderr.strip():
            preview = self._normalize_whitespace(stderr)[:240]
            if preview:
                details.append(f"Stderr preview: {preview}")

        return "\n".join(details)

    def _normalize_whitespace(self, value: str) -> str:
        return " ".join(value.split())
