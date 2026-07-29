from __future__ import annotations

from mycli.domain.conversation import Message
from mycli.domain.runtime import HistoryItem, HistoryItemType, RuntimeBlock
from mycli.domain.tooling.calls import ToolCall


class ContextManager:
    def provider_replay_messages(
        self,
        *,
        conversation: tuple[Message, ...],
        history_items: tuple[HistoryItem, ...] = (),
    ) -> tuple[Message, ...]:
        if conversation:
            baseline_messages = self._baseline_messages_from_history(history_items)
            return (*self._deduplicate_baseline_messages(baseline_messages, conversation), *conversation)
        if history_items:
            return self.messages_from_history(history_items)
        return ()

    def messages_from_history(
        self,
        history_items: tuple[HistoryItem, ...],
        *,
        include_context_baseline_updates: bool = True,
    ) -> tuple[Message, ...]:
        messages: list[Message] = []
        index = 0
        while index < len(history_items):
            item = history_items[index]
            if item.type is HistoryItemType.USER_MESSAGE:
                messages.append(
                    Message(
                        role=(
                            "developer"
                            if item.metadata.get("model_role") == "developer"
                            else "user"
                        ),
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
            elif item.type is HistoryItemType.CONTEXT_BASELINE_UPDATE:
                if include_context_baseline_updates:
                    message = self._context_baseline_update_message(item)
                    if message is not None:
                        messages.append(message)
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

    def _context_baseline_update_message(self, item: HistoryItem) -> Message | None:
        if item.metadata.get("model_visible") is False:
            return None
        if item.metadata.get("replayable") is False:
            return None
        content = item.text or ""
        if not content.strip():
            return None
        metadata = dict(item.metadata)
        return Message(
            role="user",
            content=content,
            blocks=(
                RuntimeBlock(
                    type="text",
                    text=content,
                    metadata=metadata,
                ),
            ),
            metadata=metadata,
        )

    def _baseline_messages_from_history(
        self,
        history_items: tuple[HistoryItem, ...],
    ) -> tuple[Message, ...]:
        messages: list[Message] = []
        for item in history_items:
            if item.type is not HistoryItemType.CONTEXT_BASELINE_UPDATE:
                continue
            message = self._context_baseline_update_message(item)
            if message is not None:
                messages.append(message)
        return tuple(messages)

    def _deduplicate_baseline_messages(
        self,
        baseline_messages: tuple[Message, ...],
        conversation: tuple[Message, ...],
    ) -> tuple[Message, ...]:
        existing = {
            (
                message.content,
                str(message.metadata.get("context_kind") or ""),
            )
            for message in conversation
            if message.role == "user"
        }
        deduplicated: list[Message] = []
        for message in baseline_messages:
            key = (
                message.content,
                str(message.metadata.get("context_kind") or ""),
            )
            if key in existing:
                continue
            existing.add(key)
            deduplicated.append(message)
        return tuple(deduplicated)

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
