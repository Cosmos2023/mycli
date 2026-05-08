from __future__ import annotations

import json

from mycli.domain.conversation import Conversation, Message

REPEATED_FAILURE_STOP_THRESHOLD = 3


class RuntimePolicySignals:
    def max_repeated_tool_calls(self, conversation: Conversation) -> int:
        signatures: dict[str, int] = {}
        max_count = 0
        for message in conversation.messages:
            if message.role != "assistant":
                continue
            for call in message.tool_calls:
                signature = json.dumps(
                    {"name": call.name, "arguments": call.arguments},
                    ensure_ascii=False,
                    sort_keys=True,
                )
                signatures[signature] = signatures.get(signature, 0) + 1
                max_count = max(max_count, signatures[signature])
        return max_count

    def count_tool_calls_in_current_turn(
        self,
        *,
        conversation: Conversation,
        tool_name: str,
    ) -> int:
        count = 0
        for message in self.messages_in_current_turn(conversation):
            if message.role != "assistant":
                continue
            for call in message.tool_calls:
                if call.name == tool_name:
                    count += 1
        return count

    def messages_in_current_turn(self, conversation: Conversation) -> tuple[Message, ...]:
        current_turn: list[Message] = []
        for message in reversed(conversation.messages):
            if message.role == "user":
                break
            current_turn.append(message)
        current_turn.reverse()
        return tuple(current_turn)

    def has_repeated_recoverable_failures(self, conversation: Conversation) -> bool:
        signatures: dict[str, int] = {}
        for message in conversation.messages:
            if message.role != "tool":
                continue
            for block in message.blocks:
                if block.type != "tool_result":
                    continue
                if block.metadata.get("success") is not False:
                    continue
                signature = json.dumps(
                    {
                        "tool_name": block.metadata.get("tool_name"),
                        "path": block.metadata.get("path"),
                        "error_kind": block.metadata.get("error_kind"),
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                )
                signatures[signature] = signatures.get(signature, 0) + 1
                if signatures[signature] >= REPEATED_FAILURE_STOP_THRESHOLD:
                    return True
        return False
