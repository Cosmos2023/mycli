from __future__ import annotations

from mycli.domain.conversation import Message
from mycli.domain.runtime import InstructionContract, RuntimeBlock, RuntimeItem
from mycli.llms.adapters.base import ModelMessage


def build_runtime_items(*, contract: InstructionContract) -> list[RuntimeItem]:
    items: list[RuntimeItem] = [
        RuntimeItem(
            role="system",
            blocks=(RuntimeBlock(type="text", text=contract.base_instructions),),
        ),
    ]
    if contract.developer_sections:
        items.append(
            RuntimeItem(
                role="developer",
                blocks=tuple(
                    RuntimeBlock(type="text", text=section.content)
                    for section in contract.developer_sections
                ),
            ),
        )
    if contract.contextual_user_sections:
        items.append(
            RuntimeItem(
                role="user",
                blocks=tuple(
                    RuntimeBlock(type="text", text=section.content)
                    for section in contract.contextual_user_sections
                ),
            )
        )
    if contract.assistant_scaffold:
        items.append(
            RuntimeItem(
                role="assistant",
                blocks=(RuntimeBlock(type="text", text=contract.assistant_scaffold),),
            )
        )
    for message in contract.conversation_messages:
        blocks = runtime_blocks_from_message(message)
        if not blocks:
            continue
        items.append(RuntimeItem(role=message.role, blocks=blocks))
    return items


def runtime_blocks_from_message(message: Message) -> tuple[RuntimeBlock, ...]:
    if message.blocks:
        return message.blocks

    blocks: list[RuntimeBlock] = []
    if message.role == "assistant":
        if message.content:
            blocks.append(RuntimeBlock(type="text", text=message.content))
        for call in message.tool_calls:
            if not call.call_id:
                continue
            blocks.append(
                RuntimeBlock(
                    type="tool_call",
                    tool_name=call.name,
                    tool_arguments=call.arguments,
                    call_id=call.call_id,
                )
            )
        return tuple(blocks)

    if message.role == "tool":
        if not message.tool_call_id:
            return ()
        return (
            RuntimeBlock(
                type="tool_result",
                text=message.content,
                call_id=message.tool_call_id,
            ),
        )

    if message.content:
        return (RuntimeBlock(type="text", text=message.content),)
    return ()


def message_metadata_from_blocks(message: Message) -> dict[str, object]:
    metadata: dict[str, object] = {}
    for block in message.blocks:
        for key, value in block.metadata.items():
            existing = metadata.get(key)
            if isinstance(existing, dict) and isinstance(value, dict):
                nested = dict(existing)
                nested.update(value)
                metadata[key] = nested
                continue
            metadata[key] = value
    return metadata


def build_legacy_messages(*, contract: InstructionContract) -> list[ModelMessage]:
    messages: list[ModelMessage] = [
        ModelMessage(role="system", content=contract.base_instructions),
    ]
    messages.extend(
        ModelMessage(role="developer", content=section.content)
        for section in contract.developer_sections
    )
    messages.extend(
        ModelMessage(role="user", content=section.content)
        for section in contract.contextual_user_sections
    )
    if contract.assistant_scaffold:
        messages.append(
            ModelMessage(
                role="assistant",
                content=contract.assistant_scaffold,
            )
        )
    messages.extend(
        ModelMessage(
            role=message.role,
            content=message.content,
            tool_call_id=message.tool_call_id,
            tool_calls=message.tool_calls,
            metadata=message_metadata_from_blocks(message),
        )
        for message in contract.conversation_messages
    )
    return messages
