from __future__ import annotations

from typing import Protocol, Sequence

from mycli.domain.conversation import Conversation, Message
from mycli.services.context.compaction.replacement import CompactionReplacementBuilder
from mycli.services.context.compaction.trigger import CompactDecision
from mycli.services.context.token_counter import TokenCounter


def effective_l4_trigger_ratio(
    *,
    configured_ratio: float,
    max_tokens: int,
    buffer_tokens: int,
) -> float:
    """Translate legacy ratio/buffer settings into an absolute-trigger ratio."""
    if max_tokens <= 0:
        return max(0.0, configured_ratio)
    normalized_configured = max(0.0, min(1.0, configured_ratio))
    normalized_buffer = max(0, buffer_tokens)
    if max_tokens <= normalized_buffer:
        normalized_buffer = max(0, int(max_tokens * 0.20))
    buffer_ratio = max(0.0, (max_tokens - normalized_buffer) / max_tokens)
    return min(normalized_configured, buffer_ratio)


class SummarizerClient(Protocol):
    def complete(
        self,
        *,
        messages: list[dict[str, str]],
        model: str,
        max_tokens: int,
    ) -> object: ...


class CompactProvider(Protocol):
    path: str

    def compact(self, messages: tuple[Message, ...]) -> tuple[Message, ...]: ...


class LocalCompactProvider:
    path = "local"

    def __init__(
        self,
        *,
        summarizer_client: SummarizerClient | None,
        model_name: str,
        max_output_tokens: int = 600,
    ) -> None:
        self._summarizer_client = summarizer_client
        self._model_name = model_name
        self._max_output_tokens = max_output_tokens

    def compact(self, messages: tuple[Message, ...]) -> tuple[Message, ...]:
        conversation_text = "\n\n".join(
            f"[{message.role}]\n{content}"
            for message in messages
            if (content := _summary_visible_content(message))
        )
        if not conversation_text:
            raise ValueError("compact input contains no visible conversation text")
        if self._summarizer_client is None:
            summary = _fallback_summary(messages)
        else:
            prompt = SUMMARY_PROMPT.format(conversation_text=conversation_text)
            response = self._summarizer_client.complete(
                messages=[{"role": "user", "content": prompt}],
                model=self._model_name,
                max_tokens=self._max_output_tokens,
            )
            summary = getattr(response, "content", str(response)).strip()
        return (Message(role="assistant", content=summary),)


class CompactProviderNormalizer:
    def summary_text(self, messages: tuple[Message, ...]) -> str:
        preferred = [message for message in messages if message.metadata.get("compaction")]
        candidates = [
            *preferred,
            *[message for message in messages if message not in preferred],
        ]
        for message in candidates:
            if message.role not in {"user", "assistant"}:
                continue
            if message.tool_call_id or message.tool_calls:
                continue
            content = _summary_visible_content(message).strip()
            if not content:
                continue
            marker = "[compact-summary]\n"
            return content[len(marker) :].strip() if content.startswith(marker) else content
        raise ValueError("compact provider returned no usable summary text")


class CompactService:
    def __init__(
        self,
        *,
        provider: CompactProvider,
        replacement_builder: CompactionReplacementBuilder,
        token_counter: TokenCounter | None = None,
        summary_max_tokens: int = 600,
        normalizer: CompactProviderNormalizer | None = None,
    ) -> None:
        if summary_max_tokens <= 0:
            raise ValueError("summary_max_tokens must be positive")
        self._provider = provider
        self._replacement_builder = replacement_builder
        self._token_counter = token_counter or TokenCounter()
        self._summary_max_tokens = summary_max_tokens
        self._normalizer = normalizer or CompactProviderNormalizer()
        self.last_status = "idle"
        self.last_failure_kind: str | None = None
        self.last_removed_items = 0
        self.last_retained_turns = 0
        self.last_summary_tokens = 0

    def compact(
        self,
        conversation: Conversation,
        decision: CompactDecision,
    ) -> Conversation:
        selection = self._replacement_builder.select(conversation)
        self.last_removed_items = len(selection.removed_prefix)
        self.last_retained_turns = selection.retained_turns
        self.last_summary_tokens = 0
        has_meaningful_removed_history = any(
            not message.metadata.get("compaction") for message in selection.removed_prefix
        )
        if selection.retained_turns == 0 or not has_meaningful_removed_history:
            self.last_status = "skipped"
            self.last_failure_kind = None
            return conversation
        try:
            provider_messages = self._provider.compact(selection.removed_prefix)
            summary = self._normalizer.summary_text(provider_messages)
            summary_tokens = self._token_counter.count(summary)
            if summary_tokens > self._summary_max_tokens:
                raise ValueError("compact summary exceeds token limit")
            replacement = self._replacement_builder.build(
                conversation=conversation,
                selection=selection,
                summary=summary,
            )
        except Exception as exc:
            self.last_status = "failed"
            self.last_failure_kind = type(exc).__name__
            return conversation

        self.last_summary_tokens = summary_tokens
        summary_message = replacement.messages[0]
        reason = decision.reason.value if decision.reason is not None else ""
        replacement.messages[0] = Message(
            role="user",
            content=summary_message.content,
            metadata={
                **summary_message.metadata,
                "compaction_reason": reason,
                "compaction_phase": decision.phase.value,
            },
        )
        self.last_status = "compressed"
        self.last_failure_kind = None
        return replacement


SUMMARY_PROMPT = (
    "CRITICAL: Respond with TEXT ONLY. "
    "Do NOT call tools. "
    "Do NOT output JSON, XML, or code fences. "
    "Do NOT ask the user for confirmation. "
    "Do NOT continue the task. "
    "Only produce the summary requested below.\n\n"
    "Summarize this conversation. Output exactly these 9 sections. "
    "Each section 1-3 sentences unless noted. Keep total output under 300 words.\n\n"
    "## 1. Primary Request\n"
    "The user's original goal.\n\n"
    "## 2. Key Technical Concepts\n"
    "Frameworks, patterns, architectures. List only.\n\n"
    "## 3. Files Examined or Edited\n"
    "Full paths. Mark edited files with [EDITED].\n\n"
    "## 4. Errors and Fixes\n"
    "Each error -> resolution. Write 'None.' if none.\n\n"
    "## 5. Decisions Made\n"
    "What was decided and why. One line each.\n\n"
    "## 6. All User Messages\n"
    "Preserved as close to verbatim as possible.\n\n"
    "## 7. Pending Tasks\n"
    "Work not yet done. Write 'None.' if none.\n\n"
    "## 8. Current Work\n"
    "What was in progress when this summary was created.\n\n"
    "## 9. Optional Next Step\n"
    "Write 'N/A' if unclear.\n\n"
    "---\n\n"
    "Conversation:\n"
    "{conversation_text}\n\n"
    "---\n\n"
    "Summary:"
)


def _summary_visible_content(message: Message) -> str:
    if _is_provider_private_reasoning_message(message):
        return ""
    if message.blocks:
        text_parts = [
            block.text
            for block in message.blocks
            if block.type == "text" and isinstance(block.text, str) and block.text.strip()
        ]
        if text_parts:
            return " ".join(part.strip() for part in text_parts)
        if all(block.type == "reasoning" for block in message.blocks):
            return ""
    return message.content.strip()


def _fallback_summary(messages: Sequence[Message]) -> str:
    lines = [
        f"- {message.role}: {' '.join(content.split())[:120]}"
        for message in messages
        if (content := _summary_visible_content(message))
    ]
    if not lines:
        raise ValueError("compact input contains no visible conversation text")
    return "Conversation summary:\n" + "\n".join(lines)


def _is_provider_private_reasoning_message(message: Message) -> bool:
    if message.blocks and all(block.type == "reasoning" for block in message.blocks):
        return True
    provider_state = message.metadata.get("provider_state")
    if isinstance(provider_state, dict) and any(
        key in provider_state
        for key in (
            "codex_reasoning_items",
            "anthropic_thinking",
            "reasoning",
            "thinking",
        )
    ):
        return True
    return bool(message.metadata.get("provider_private_reasoning"))
