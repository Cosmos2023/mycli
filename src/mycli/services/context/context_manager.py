from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.conversation import Message
from mycli.domain.runtime import HistoryItem, HistoryItemType, RuntimeBlock
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.calls import ToolEvidence
from mycli.tools.base import ToolResult
from mycli.services.context.tool_result_formatter import ToolResultFormatter


@dataclass(slots=True, frozen=True)
class ManagedContext:
    messages: tuple[Message, ...]
    summary: str | None = None


class ContextManager:
    def __init__(self, *, formatter: ToolResultFormatter | None = None) -> None:
        self._formatter = formatter

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

    def provider_replay_messages(
        self,
        *,
        conversation: tuple[Message, ...],
        history_items: tuple[HistoryItem, ...] = (),
    ) -> tuple[Message, ...]:
        if conversation:
            return conversation
        if history_items:
            return self.messages_from_history(history_items)
        return ()

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
        index = 0
        while index < len(history_items):
            item = history_items[index]
            if item.type is HistoryItemType.USER_MESSAGE:
                messages.append(
                    Message(
                        role="user",
                        content=item.text or "",
                        blocks=(
                            ()
                            if not item.text
                            else (
                                RuntimeBlock(
                                    type="text",
                                    text=item.text,
                                    metadata=dict(item.metadata),
                                ),
                            )
                        ),
                        metadata=dict(item.metadata),
                    )
                )
                index += 1
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
                index += 1
            elif item.type is HistoryItemType.REASONING:
                index += 1
            elif item.type is HistoryItemType.SKILL_INSTRUCTIONS:
                messages.append(self._skill_instruction_message(item))
                index += 1
            elif item.type is HistoryItemType.TOOL_CALL:
                index = self._append_tool_call_batch(
                    messages=messages,
                    history_items=history_items,
                    start_index=index,
                )
            elif item.type is HistoryItemType.TOOL_RESULT:
                messages.append(self._tool_result_message(item))
                index += 1
            else:
                index += 1
        return tuple(messages)

    def _skill_instruction_message(self, item: HistoryItem) -> Message:
        content = item.text or ""
        metadata = dict(item.metadata)
        return Message(
            role="user",
            content=content,
            blocks=(
                ()
                if not content
                else (
                    RuntimeBlock(
                        type="text",
                        text=content,
                        metadata=metadata,
                    ),
                )
            ),
            metadata=metadata,
        )

    def _append_tool_call_batch(
        self,
        *,
        messages: list[Message],
        history_items: tuple[HistoryItem, ...],
        start_index: int,
    ) -> int:
        first_item = history_items[start_index]
        provider_id = self._provider_id(first_item)
        tool_calls: list[ToolCall] = []
        tool_call_blocks: list[RuntimeBlock] = []
        tool_result_messages: list[Message] = []
        index = start_index

        while index < len(history_items):
            item = history_items[index]
            if item.type is not HistoryItemType.TOOL_CALL:
                break
            if index > start_index and provider_id is None:
                break
            if provider_id is not None and self._provider_id(item) != provider_id:
                break

            tool_call_payload = self._tool_call_payload(item)
            if tool_call_payload is None:
                index += 1
                continue
            tool_call, tool_call_block = tool_call_payload
            tool_calls.append(tool_call)
            tool_call_blocks.append(tool_call_block)
            index += 1

            if index >= len(history_items):
                continue
            maybe_result = history_items[index]
            if (
                maybe_result.type is HistoryItemType.TOOL_RESULT
                and maybe_result.call_id == item.call_id
            ):
                tool_result_messages.append(self._tool_result_message(maybe_result))
                index += 1

        if not tool_calls:
            return max(index, start_index + 1)

        prefix = self._pop_joinable_assistant_prefix(messages, first_item)
        messages.append(
            Message(
                role="assistant",
                content="" if prefix is None else prefix.content,
                tool_calls=(
                    tuple(tool_calls)
                    if prefix is None
                    else (*prefix.tool_calls, *tool_calls)
                ),
                blocks=(
                    tuple(tool_call_blocks)
                    if prefix is None
                    else (*prefix.blocks, *tool_call_blocks)
                ),
                response_id=None if prefix is None else prefix.response_id,
            )
        )
        messages.extend(tool_result_messages)
        return index

    def _tool_call_payload(
        self,
        item: HistoryItem,
    ) -> tuple[ToolCall, RuntimeBlock] | None:
        if not item.tool_name or not item.call_id:
            return None
        arguments = item.metadata.get("arguments")
        tool_arguments = arguments if isinstance(arguments, dict) else {}
        return (
            ToolCall(
                name=item.tool_name,
                arguments=tool_arguments,
                reason="model requested tool",
                call_id=item.call_id,
            ),
            RuntimeBlock(
                type="tool_call",
                text=item.text,
                tool_name=item.tool_name,
                tool_arguments=tool_arguments,
                call_id=item.call_id,
                provider_id=self._provider_id(item),
                metadata=dict(item.metadata),
            ),
        )

    def _tool_result_message(self, item: HistoryItem) -> Message:
        content = item.metadata.get("transcript_content")
        if not isinstance(content, str):
            content = item.text or ""
        return Message(
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

    def _provider_id(self, item: HistoryItem) -> str | None:
        provider_id = item.metadata.get("provider_id")
        if isinstance(provider_id, str):
            return provider_id
        return None

    def _can_join_assistant_tool_call(
        self,
        messages: list[Message],
        item: HistoryItem,
    ) -> bool:
        if not messages:
            return False
        previous = messages[-1]
        if previous.role != "assistant" or previous.tool_calls:
            return False
        if not previous.blocks or not any(block.type == "text" for block in previous.blocks):
            return False
        previous_provider_id = self._message_provider_id(previous)
        current_provider_id = self._provider_id(item)
        return (
            previous_provider_id is None
            or current_provider_id is None
            or previous_provider_id == current_provider_id
        )

    def _pop_joinable_assistant_prefix(
        self,
        messages: list[Message],
        item: HistoryItem,
    ) -> Message | None:
        if not self._can_join_assistant_tool_call(messages, item):
            return None
        return messages.pop()

    def _message_provider_id(self, message: Message) -> str | None:
        for block in message.blocks:
            if block.provider_id:
                return block.provider_id
            provider_id = block.metadata.get("provider_id")
            if isinstance(provider_id, str):
                return provider_id
        return None

    def render_tool_result(
        self,
        result: ToolResult,
        *,
        tool_name: str = "",
        max_chars: int = 1600,
    ) -> str:
        if tool_name == "Skill" and result.success:
            content = result.raw_payload.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
        if self._formatter is not None:
            return self._formatter.format(tool_name, result)
        rendered = self._render_tool_result_details(result)
        if len(rendered) <= max_chars:
            return rendered
        return rendered[: max_chars - 3] + "..."

    def _render_tool_result_details(self, result: ToolResult) -> str:
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

    def _render_tool_result_from_evidence(self, result: ToolResult) -> str:
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
                "  note: excerpt truncated; use Read with offset/limit for exact sections if needed.",
            ]

        return [
            f"  snippet: {normalized[:400]}...",
            "  note: file is large; use Read with offset/limit for exact sections.",
        ]

    def _format_evidence_header(self, evidence: ToolEvidence) -> str:
        location = evidence.path or evidence.title
        if evidence.path and evidence.line_start is not None and evidence.line_end is not None:
            if evidence.line_start == evidence.line_end:
                location = f"{evidence.path}:{evidence.line_start}"
            else:
                location = f"{evidence.path}:{evidence.line_start}-{evidence.line_end}"
        return f"- [{evidence.kind}] {location}"

    def _render_tool_result_from_payload(self, result: ToolResult) -> str:
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
