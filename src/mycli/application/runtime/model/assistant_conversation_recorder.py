from __future__ import annotations

import shlex
from typing import SupportsInt
from uuid import uuid4

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import RuntimeBlock
from mycli.domain.tooling.calls import ToolCall

LEGACY_TOOL_NAMES = {
    "read_file": "Read",
    "read_file_range": "Read",
    "edit_file": "Edit",
    "write_file": "Write",
    "search_text": "Grep",
    "list_directory": "LS",
    "run_shell": "Bash",
    "update_plan": "Plan",
}


class AssistantConversationRecorder:
    def normalize_tool_call(self, call: ToolCall) -> ToolCall:
        tool_name = LEGACY_TOOL_NAMES.get(call.name, call.name)
        arguments = _normalize_tool_arguments(tool_name, call.arguments)
        if call.call_id:
            if tool_name == call.name and arguments is call.arguments:
                return call
            return ToolCall(
                name=tool_name,
                arguments=arguments,
                reason=call.reason,
                call_id=call.call_id,
            )
        return ToolCall(
            name=tool_name,
            arguments=arguments,
            reason=call.reason,
            call_id=f"call_{uuid4().hex}",
        )

    def tool_call_from_block(self, block: RuntimeBlock) -> ToolCall:
        tool_arguments = block.tool_arguments
        return self.normalize_tool_call(
            ToolCall(
                name=block.tool_name or "",
                arguments=tool_arguments if isinstance(tool_arguments, dict) else {},
                reason="model requested tool",
                call_id=block.call_id,
            )
        )

    def record_text_block(
        self,
        conversation: Conversation,
        *,
        block: RuntimeBlock,
        response_id: str | None,
    ) -> None:
        if not block.text:
            return
        conversation.append(
            Message(
                role="assistant",
                content=block.text,
                blocks=(block,),
                response_id=response_id,
            )
        )

    def record_tool_calls(
        self,
        conversation: Conversation,
        *,
        tool_calls: tuple[ToolCall, ...],
        blocks: tuple[RuntimeBlock, ...],
        response_id: str | None = None,
    ) -> None:
        normalized_calls = tuple(self.normalize_tool_call(call) for call in tool_calls)
        conversation.append(
            Message(
                role="assistant",
                content="",
                tool_calls=normalized_calls,
                blocks=blocks,
                response_id=response_id,
            )
        )


def _normalize_tool_arguments(
    tool_name: str,
    arguments: dict[str, object],
) -> dict[str, object]:
    normalized = dict(arguments)
    if tool_name == "Read":
        _copy_alias(normalized, "path", "file_path")
        if "start_line" in normalized and "offset" not in normalized:
            normalized["offset"] = normalized["start_line"]
        if "end_line" in normalized and "limit" not in normalized:
            try:
                offset = _coerce_int(normalized.get("offset", 1))
                end_line = _coerce_int(normalized["end_line"])
            except (TypeError, ValueError):
                pass
            else:
                normalized["limit"] = max(0, end_line - offset + 1)
    elif tool_name == "Grep":
        _copy_alias(normalized, "query", "pattern")
        _copy_alias(normalized, "glob", "include")
        if "case_sensitive" in normalized and "ignore_case" not in normalized:
            normalized["ignore_case"] = not bool(normalized["case_sensitive"])
        _copy_alias(normalized, "max_matches", "head_limit")
    elif tool_name == "Bash":
        args = normalized.get("args")
        if "command" not in normalized and isinstance(args, list):
            parts = [part for part in args if isinstance(part, str)]
            if parts:
                normalized["command"] = shlex.join(parts)
    elif tool_name in {"Edit", "Write"}:
        _copy_alias(normalized, "path", "file_path")
        if tool_name == "Edit":
            _copy_alias(normalized, "old_text", "old_string")
            _copy_alias(normalized, "new_text", "new_string")
            _copy_alias(normalized, "new_content", "new_string")
            if "new_content" in normalized and "old_string" not in normalized:
                normalized["old_string"] = ""
        else:
            _copy_alias(normalized, "new_content", "content")
    return normalized


def _copy_alias(
    arguments: dict[str, object],
    source: str,
    target: str,
) -> None:
    if target not in arguments and source in arguments:
        arguments[target] = arguments[source]


def _coerce_int(value: object) -> int:
    if isinstance(value, str | bytes | bytearray):
        return int(value)
    if isinstance(value, SupportsInt):
        return int(value)
    raise TypeError(f"Cannot convert {type(value).__name__} to int.")
