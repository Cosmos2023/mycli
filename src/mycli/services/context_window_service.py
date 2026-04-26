from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.conversation import Conversation, Message


@dataclass(slots=True, frozen=True)
class ContextWindow:
    recent_messages: tuple[Message, ...] = ()
    summary: str | None = None


class ContextWindowService:
    def estimate_tokens(self, text: str) -> int:
        return max(1, len(text) // 4)

    def build(
        self,
        conversation: Conversation,
        *,
        max_prompt_tokens: int,
        compression_threshold_tokens: int,
        recent_message_count: int,
    ) -> ContextWindow:
        messages = tuple(conversation.messages)
        if not messages:
            return ContextWindow()

        rendered_full = self._render_messages(messages)
        if self.estimate_tokens(rendered_full) <= compression_threshold_tokens:
            return ContextWindow(recent_messages=messages)

        if recent_message_count <= 0:
            recent_messages: tuple[Message, ...] = ()
            older_messages = messages
        else:
            recent_messages = messages[-recent_message_count:]
            older_messages = messages[:-recent_message_count]

        summary = self._build_summary(
            older_messages,
            max_prompt_tokens=max_prompt_tokens,
            recent_messages=recent_messages,
        )
        return ContextWindow(recent_messages=recent_messages, summary=summary)

    def _build_summary(
        self,
        messages: tuple[Message, ...],
        *,
        max_prompt_tokens: int,
        recent_messages: tuple[Message, ...],
    ) -> str | None:
        if not messages:
            return None

        recent_budget = self.estimate_tokens(self._render_messages(recent_messages))
        summary_token_budget = max(32, max_prompt_tokens - recent_budget - 128)
        summary_char_budget = max(128, summary_token_budget * 4)

        lines = [
            f"- {message.role}: {self._truncate(message.content, 96)}"
            for message in messages
        ]
        summary = "\n".join(lines)
        if len(summary) > summary_char_budget:
            summary = summary[: summary_char_budget - 3].rstrip() + "..."
        return summary

    def _render_messages(self, messages: tuple[Message, ...]) -> str:
        return "\n".join(f"{message.role}: {message.content}" for message in messages)

    def _truncate(self, content: str, limit: int) -> str:
        compact = " ".join(content.split())
        if len(compact) <= limit:
            return compact
        return compact[: limit - 3].rstrip() + "..."
