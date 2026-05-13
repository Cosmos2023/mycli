from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Protocol

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import RuntimeBlock
from mycli.domain.tooling.calls import ToolEvidence
from mycli.services.context.compaction.budget import ContextBudget
from mycli.services.context.compaction.cache_zones import CacheZones
from mycli.services.context.token_counter import TokenCounter
from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.services.hooks import HookContext, HookManager, HookPoint
from mycli.tools.base import ToolResultV2

_TOKEN_COUNTER = TokenCounter()


@dataclass(slots=True, frozen=True)
class CompactionCostProfile:
    input_cost_per_1k: float = 0.0
    output_cost_per_1k: float = 0.0
    carry_cost_per_1k: float = 0.0
    carry_turns: int = 1
    expected_summary_tokens: int = 500
    min_savings_ratio: float | None = None


class CompactionStrategy(Protocol):
    def apply(
        self,
        conversation: Conversation,
        zones: CacheZones,
        budget: ContextBudget,
    ) -> Conversation: ...


class ToolResultBudget:
    def __init__(self, formatter: ToolResultFormatter) -> None:
        self._formatter = formatter

    def apply(
        self,
        conversation: Conversation,
        zones: CacheZones,
        budget: ContextBudget,
    ) -> Conversation:
        del budget
        compacted = _copy_conversation(conversation)
        changed = False
        for index in range(zones.fresh_start, len(compacted.messages)):
            message = compacted.messages[index]
            if message.role != "tool":
                continue
            if message.metadata.get("cache_frozen"):
                continue

            tool_name = _tool_name_for_message(message)
            raw_payload = _tool_raw_payload(message)
            result = ToolResultV2(
                success=_tool_success_for_message(message),
                summary=_tool_summary_for_message(message),
                raw_payload=raw_payload,
                evidence=_tool_evidence_for_message(message),
                error=_tool_error_for_message(message),
            )
            formatted = self._formatter.format(tool_name, result)
            if formatted == message.content:
                continue

            compacted.messages[index] = _replace_tool_message(
                message,
                content=formatted,
                metadata_updates={
                    "cache_frozen": True,
                    "l1_truncated": True,
                },
                block_metadata_updates={"compacted": True},
            )
            changed = True
        return compacted if changed else conversation

    def format_result(self, tool_name: str, result: ToolResultV2) -> str:
        return self._formatter.format(tool_name, result)


class ToolResultDedup:
    def __init__(self, *, trigger_ratio: float = 0.4) -> None:
        self._trigger_ratio = trigger_ratio

    def apply(
        self,
        conversation: Conversation,
        zones: CacheZones,
        budget: ContextBudget,
    ) -> Conversation:
        if budget.usage_ratio < self._trigger_ratio:
            return conversation

        compacted = _copy_conversation(conversation)
        seen: dict[str, int] = {}
        for index in range(zones.fresh_start, len(compacted.messages)):
            message = compacted.messages[index]
            if message.role != "tool":
                continue
            if message.metadata.get("cache_frozen"):
                continue
            signature = self._tool_result_signature(message)
            if signature is None:
                continue
            if signature in seen:
                compacted.messages[index] = _placeholder_tool_message(
                    message,
                    content=f"[cleared: same tool result as message #{seen[signature]}]",
                )
                continue
            seen[signature] = index
        return compacted

    @staticmethod
    def _tool_result_signature(message: Message) -> str | None:
        tool_name = None
        path = None
        summary = None
        for block in message.blocks:
            if block.type != "tool_result":
                continue
            tool_name = block.metadata.get("tool_name")
            path = block.metadata.get("path")
            summary = block.metadata.get("summary")
            break
        if tool_name is None:
            return None
        return json.dumps(
            {
                "path": path,
                "summary": summary,
                "tool_name": tool_name,
            },
            ensure_ascii=False,
            sort_keys=True,
        )


class SlidingWindowEviction:
    def __init__(
        self,
        *,
        trigger_ratio: float = 0.7,
        keep_recent: int = 8,
    ) -> None:
        self._trigger_ratio = trigger_ratio
        self._keep_recent = keep_recent

    def apply(
        self,
        conversation: Conversation,
        zones: CacheZones,
        budget: ContextBudget,
    ) -> Conversation:
        if budget.usage_ratio < self._trigger_ratio:
            return conversation

        compacted = _copy_conversation(conversation)
        tool_result_indices = [
            index
            for index in range(zones.fresh_start, len(compacted.messages))
            if compacted.messages[index].role == "tool"
            and not compacted.messages[index].metadata.get("cache_frozen")
        ]
        if len(tool_result_indices) <= self._keep_recent:
            return compacted

        for index in tool_result_indices[: -self._keep_recent]:
            message = compacted.messages[index]
            call_id = message.tool_call_id or "unknown"
            compacted.messages[index] = _placeholder_tool_message(
                message,
                content=f"[archived: earlier tool result. call_id: {call_id}]",
            )
        return compacted


class LLMSummarization:
    def __init__(
        self,
        *,
        trigger_ratio: float = 0.9,
        model_name: str | None = None,
        trigger_ratios_by_model: dict[str, float] | None = None,
        cost_profile: CompactionCostProfile | None = None,
        cost_profiles_by_model: dict[str, CompactionCostProfile] | None = None,
        max_consecutive_failures: int = 3,
    ) -> None:
        self._trigger_ratio = trigger_ratio
        self._model_name = model_name
        self._trigger_ratios_by_model = dict(trigger_ratios_by_model or {})
        self._cost_profile = cost_profile or CompactionCostProfile()
        self._cost_profiles_by_model = dict(cost_profiles_by_model or {})
        self._max_failures = max_consecutive_failures
        self._failure_count = 0
        self._last_cost_metrics: dict[str, int | float | str] | None = None

    @property
    def last_cost_metrics(self) -> dict[str, int | float | str] | None:
        if self._last_cost_metrics is None:
            return None
        return dict(self._last_cost_metrics)

    def apply(
        self,
        conversation: Conversation,
        zones: CacheZones,
        budget: ContextBudget,
    ) -> Conversation:
        trigger_ratio = self._active_trigger_ratio()
        if budget.usage_ratio < trigger_ratio:
            self._last_cost_metrics = {
                "decision": "skip_threshold",
                "trigger_ratio": trigger_ratio,
                "usage_ratio": budget.usage_ratio,
            }
            return conversation
        if self._failure_count >= self._max_failures:
            self._last_cost_metrics = {
                "decision": "skip_failures",
                "trigger_ratio": trigger_ratio,
                "usage_ratio": budget.usage_ratio,
            }
            return conversation
        fresh_messages = conversation.messages[zones.fresh_start :]
        if len(fresh_messages) < 4:
            self._last_cost_metrics = {
                "decision": "skip_small_window",
                "fresh_message_count": len(fresh_messages),
                "trigger_ratio": trigger_ratio,
                "usage_ratio": budget.usage_ratio,
            }
            return conversation

        split_index = _find_safe_split(fresh_messages, len(fresh_messages) // 2)
        to_summarize = fresh_messages[:split_index]
        if not to_summarize:
            return conversation
        cost_metrics = self._estimate_cost_metrics(to_summarize, trigger_ratio, budget)
        if self._should_skip_for_cost(cost_metrics):
            cost_metrics["decision"] = "skip_cost"
            self._last_cost_metrics = cost_metrics
            return conversation

        try:
            summary = self._call_summarizer(to_summarize)
        except Exception:
            self._failure_count += 1
            cost_metrics["decision"] = "summarizer_failed"
            self._last_cost_metrics = cost_metrics
            return conversation

        self._failure_count = 0
        cost_metrics["decision"] = "summarize"
        self._last_cost_metrics = cost_metrics
        compacted = _copy_conversation(conversation)
        compacted.messages = [
            *compacted.messages[: zones.fresh_start],
            Message(
                role="assistant",
                content=summary,
                metadata={
                    "cache_policy": "DYNAMIC",
                    "compaction": True,
                    "compaction_cost": dict(cost_metrics),
                    "compressed_turns": len(to_summarize),
                },
            ),
            Message(
                role="assistant",
                content="[Conversation summarized. All key decisions preserved. Continue naturally.]",
                metadata={
                    "cache_policy": "DYNAMIC",
                    "compaction_continuation": True,
                },
            ),
            *fresh_messages[split_index:],
        ]
        return compacted

    def _active_trigger_ratio(self) -> float:
        if self._model_name is None:
            return self._trigger_ratio
        return self._trigger_ratios_by_model.get(self._model_name, self._trigger_ratio)

    def _active_cost_profile(self) -> CompactionCostProfile:
        if self._model_name is None:
            return self._cost_profile
        return self._cost_profiles_by_model.get(self._model_name, self._cost_profile)

    def _estimate_cost_metrics(
        self,
        messages: list[Message],
        trigger_ratio: float,
        budget: ContextBudget,
    ) -> dict[str, int | float | str]:
        profile = self._active_cost_profile()
        input_tokens = sum(_estimate_message_tokens(message) for message in messages)
        summary_tokens = max(0, profile.expected_summary_tokens)
        summary_cost = (input_tokens / 1000) * profile.input_cost_per_1k
        summary_cost += (summary_tokens / 1000) * profile.output_cost_per_1k
        carry_cost = (input_tokens / 1000) * profile.carry_cost_per_1k * max(1, profile.carry_turns)
        savings = carry_cost - summary_cost
        savings_ratio = savings / carry_cost if carry_cost > 0 else 0.0
        return {
            "carry_cost": carry_cost,
            "carry_turns": max(1, profile.carry_turns),
            "decision": "evaluate",
            "input_tokens": input_tokens,
            "min_savings_ratio": profile.min_savings_ratio if profile.min_savings_ratio is not None else -1.0,
            "model_name": self._model_name or "",
            "savings": savings,
            "savings_ratio": savings_ratio,
            "summary_cost": summary_cost,
            "summary_tokens": summary_tokens,
            "trigger_ratio": trigger_ratio,
            "usage_ratio": budget.usage_ratio,
        }

    def _should_skip_for_cost(self, metrics: dict[str, int | float | str]) -> bool:
        profile = self._active_cost_profile()
        if profile.min_savings_ratio is None:
            return False
        carry_cost = float(metrics["carry_cost"])
        if carry_cost <= 0:
            return False
        return float(metrics["savings_ratio"]) < profile.min_savings_ratio

    def _call_summarizer(self, messages: list[Message]) -> str:
        lines = [
            f"- {message.role}: {' '.join(message.content.split())[:120]}"
            for message in messages
            if message.content.strip()
        ]
        if not lines:
            return "Conversation summary unavailable."
        return "Conversation summary:\n" + "\n".join(lines)


def _find_safe_split(messages: list[Message], candidate: int) -> int:
    """Find a split point that does not leave provider tool results orphaned."""
    if not messages:
        return 0
    idx = min(max(0, candidate), len(messages))
    result_ids_after = {
        message.tool_call_id
        for message in messages[idx:]
        if message.role == "tool" and message.tool_call_id
    }

    while idx > 0:
        if idx < len(messages):
            current_response_id = messages[idx].response_id
            previous_response_id = messages[idx - 1].response_id
            if (
                current_response_id
                and previous_response_id
                and current_response_id == previous_response_id
            ):
                idx -= 1
                continue

        previous = messages[idx - 1]
        if previous.role == "assistant" and previous.tool_calls:
            call_ids = {
                call_id
                for call in previous.tool_calls
                if (call_id := _tool_call_identifier(call))
            }
            if call_ids & result_ids_after:
                idx -= 1
                continue

        break
    return idx


def _tool_call_identifier(tool_call: object) -> str | None:
    call_id = getattr(tool_call, "call_id", None)
    if isinstance(call_id, str) and call_id:
        return call_id
    legacy_id = getattr(tool_call, "id", None)
    if isinstance(legacy_id, str) and legacy_id:
        return legacy_id
    return None


class CompactionPipeline:
    def __init__(
        self,
        *,
        tool_result_budget: ToolResultBudget,
        tool_result_dedup: ToolResultDedup,
        sliding_window_eviction: SlidingWindowEviction,
        llm_summarization: LLMSummarization,
        hook_manager: HookManager | None = None,
    ) -> None:
        self.tool_result_budget = tool_result_budget
        self.tool_result_dedup = tool_result_dedup
        self.sliding_window_eviction = sliding_window_eviction
        self.llm_summarization = llm_summarization
        self._hook_manager = hook_manager or HookManager()

    def apply(
        self,
        conversation: Conversation,
        budget: ContextBudget,
    ) -> Conversation:
        self._hook_manager.execute(
            HookPoint.PRE_COMPACT,
            HookContext(
                hook_point=HookPoint.PRE_COMPACT,
                metadata={
                    "usage_ratio": budget.usage_ratio,
                    "message_count": len(conversation.messages),
                },
            ),
        )
        zones = CacheZones.from_conversation(conversation)
        compacted = self.tool_result_budget.apply(conversation, zones, budget)
        compacted = self.tool_result_dedup.apply(compacted, zones, budget)
        compacted = self.sliding_window_eviction.apply(compacted, zones, budget)
        return self.llm_summarization.apply(compacted, zones, budget)


def _copy_conversation(conversation: Conversation) -> Conversation:
    return Conversation(
        session_id=conversation.session_id,
        messages=list(conversation.messages),
    )


def _estimate_message_tokens(message: Message) -> int:
    if not message.content.strip():
        return 0
    return _TOKEN_COUNTER.count_message(message)


def _placeholder_tool_message(message: Message, *, content: str) -> Message:
    return _replace_tool_message(
        message,
        content=content,
        block_metadata_updates={"compacted": True},
    )


def _replace_tool_message(
    message: Message,
    *,
    content: str,
    metadata_updates: dict[str, object] | None = None,
    block_metadata_updates: dict[str, object] | None = None,
) -> Message:
    blocks: tuple[RuntimeBlock, ...] = ()
    message_metadata = dict(message.metadata)
    if metadata_updates:
        message_metadata.update(metadata_updates)
    if message.tool_call_id:
        metadata: dict[str, object] = {}
        for block in message.blocks:
            if block.type == "tool_result":
                metadata = {
                    "tool_name": block.metadata.get("tool_name"),
                    "path": block.metadata.get("path"),
                    "success": block.metadata.get("success"),
                    "summary": block.metadata.get("summary"),
                    "error": block.metadata.get("error"),
                }
                if block_metadata_updates:
                    metadata.update(block_metadata_updates)
                break
        blocks = (
            RuntimeBlock(
                type="tool_result",
                text=content,
                call_id=message.tool_call_id,
                metadata=metadata,
            ),
        )
    return Message(
        role="tool",
        content=content,
        tool_call_id=message.tool_call_id,
        blocks=blocks,
        metadata=message_metadata,
    )


def _tool_name_for_message(message: Message) -> str:
    for block in message.blocks:
        if block.type == "tool_result":
            tool_name = block.metadata.get("tool_name")
            if isinstance(tool_name, str) and tool_name:
                return tool_name
    return "tool"


def _tool_summary_for_message(message: Message) -> str:
    for block in message.blocks:
        if block.type == "tool_result":
            summary = block.metadata.get("summary")
            if isinstance(summary, str) and summary:
                return summary
    return message.content[:120]


def _tool_error_for_message(message: Message) -> str | None:
    for block in message.blocks:
        if block.type == "tool_result":
            error = block.metadata.get("error")
            if isinstance(error, str) and error:
                return error
    return None


def _tool_success_for_message(message: Message) -> bool:
    for block in message.blocks:
        if block.type == "tool_result":
            success = block.metadata.get("success")
            if isinstance(success, bool):
                return success
    return True


def _tool_raw_payload(message: Message) -> dict[str, object]:
    payload: dict[str, object] = {"content": message.content}
    for block in message.blocks:
        if block.type != "tool_result":
            continue
        path = block.metadata.get("path")
        if isinstance(path, str) and path:
            payload["path"] = path
        error_kind = block.metadata.get("error_kind")
        if isinstance(error_kind, str) and error_kind:
            payload["error_kind"] = error_kind
        stdout = block.metadata.get("stdout")
        if isinstance(stdout, str):
            payload["stdout"] = stdout
        stderr = block.metadata.get("stderr")
        if isinstance(stderr, str):
            payload["stderr"] = stderr
        content = block.metadata.get("content")
        if isinstance(content, str) and content:
            payload["content"] = content
        matches = block.metadata.get("matches")
        if isinstance(matches, list):
            payload["matches"] = matches
        break
    return payload


def _tool_evidence_for_message(message: Message) -> tuple[ToolEvidence, ...]:
    for block in message.blocks:
        if block.type != "tool_result":
            continue
        raw_evidence = block.metadata.get("evidence")
        if not isinstance(raw_evidence, list):
            return ()
        evidence_items: list[ToolEvidence] = []
        for item in raw_evidence:
            if not isinstance(item, dict):
                continue
            metadata = item.get("metadata")
            evidence_items.append(
                ToolEvidence(
                    kind=str(item.get("kind", "")),
                    title=str(item.get("title", "")),
                    path=item.get("path") if isinstance(item.get("path"), str) else None,
                    line_start=item.get("line_start") if isinstance(item.get("line_start"), int) else None,
                    line_end=item.get("line_end") if isinstance(item.get("line_end"), int) else None,
                    snippet=item.get("snippet") if isinstance(item.get("snippet"), str) else None,
                    metadata=dict(metadata) if isinstance(metadata, dict) else {},
                )
            )
        return tuple(evidence_items)
    return ()
