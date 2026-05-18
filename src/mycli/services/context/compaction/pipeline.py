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
from mycli.tools.base import ToolResult

_TOKEN_COUNTER = TokenCounter()
CompactionCostMetrics = dict[str, int | float | str | list[str]]


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


class SummarizerClient(Protocol):
    def complete(
        self,
        *,
        messages: list[dict[str, str]],
        model: str,
        max_tokens: int,
    ) -> object: ...


@dataclass(slots=True, frozen=True)
class FullContextSnapshot:
    messages: tuple[Message, ...]


@dataclass(slots=True, frozen=True)
class ContextWindowMetrics:
    total_tokens: int
    max_tokens: int
    usage_ratio: float
    remaining_tokens: int
    fresh_message_count: int
    fresh_tokens: int
    tool_result_count: int
    tool_result_tokens: int
    append_only_tool_result_count: int
    append_only_tool_result_tokens: int
    duplicate_tool_result_count: int
    duplicate_tool_result_tokens: int
    evictable_tool_result_count: int
    evictable_tool_result_tokens: int

    def to_dict(self) -> dict[str, int | float]:
        return {
            "total_tokens": self.total_tokens,
            "max_tokens": self.max_tokens,
            "usage_ratio": self.usage_ratio,
            "remaining_tokens": self.remaining_tokens,
            "fresh_message_count": self.fresh_message_count,
            "fresh_tokens": self.fresh_tokens,
            "tool_result_count": self.tool_result_count,
            "tool_result_tokens": self.tool_result_tokens,
            "append_only_tool_result_count": self.append_only_tool_result_count,
            "append_only_tool_result_tokens": self.append_only_tool_result_tokens,
            "duplicate_tool_result_count": self.duplicate_tool_result_count,
            "duplicate_tool_result_tokens": self.duplicate_tool_result_tokens,
            "evictable_tool_result_count": self.evictable_tool_result_count,
            "evictable_tool_result_tokens": self.evictable_tool_result_tokens,
        }


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
            if _is_append_only(message):
                continue

            tool_name = _tool_name_for_message(message)
            raw_payload = _tool_raw_payload(message)
            result = ToolResult(
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
                    "append_only": True,
                    "l1_truncated": True,
                },
                block_metadata_updates={"compacted": True},
            )
            changed = True
        return compacted if changed else conversation

    def format_result(self, tool_name: str, result: ToolResult) -> str:
        return self._formatter.format(tool_name, result)


class ContextWindowAnalyzer:
    def __init__(
        self,
        *,
        dedup_trigger_ratio: float = 0.4,
        eviction_trigger_ratio: float = 0.7,
        keep_recent_tool_results: int = 8,
    ) -> None:
        self._dedup_trigger_ratio = dedup_trigger_ratio
        self._eviction_trigger_ratio = eviction_trigger_ratio
        self._keep_recent_tool_results = keep_recent_tool_results
        self._last_metrics: ContextWindowMetrics | None = None

    @property
    def last_metrics(self) -> ContextWindowMetrics | None:
        return self._last_metrics

    def apply(
        self,
        conversation: Conversation,
        zones: CacheZones,
        budget: ContextBudget,
    ) -> Conversation:
        fresh_messages = conversation.messages[zones.fresh_start :]
        tool_messages = [message for message in fresh_messages if message.role == "tool"]
        tool_tokens = {
            id(message): _estimate_message_tokens(message)
            for message in tool_messages
        }
        append_only_messages = [
            message for message in tool_messages if _is_append_only(message)
        ]
        duplicate_count = 0
        duplicate_tokens = 0
        if budget.usage_ratio >= self._dedup_trigger_ratio:
            seen: set[str] = set()
            for message in tool_messages:
                signature = _tool_result_signature(message)
                if signature is None:
                    continue
                if signature in seen:
                    duplicate_count += 1
                    duplicate_tokens += tool_tokens[id(message)]
                    continue
                seen.add(signature)
        evictable_messages: list[Message] = []
        if budget.usage_ratio >= self._eviction_trigger_ratio:
            if self._keep_recent_tool_results <= 0:
                evictable_messages = tool_messages
            else:
                evictable_messages = tool_messages[: -self._keep_recent_tool_results]
        self._last_metrics = ContextWindowMetrics(
            total_tokens=budget.total_tokens,
            max_tokens=budget.max_tokens,
            usage_ratio=budget.usage_ratio,
            remaining_tokens=budget.remaining,
            fresh_message_count=len(fresh_messages),
            fresh_tokens=sum(
                _estimate_message_tokens(message) for message in fresh_messages
            ),
            tool_result_count=len(tool_messages),
            tool_result_tokens=sum(tool_tokens.values()),
            append_only_tool_result_count=len(append_only_messages),
            append_only_tool_result_tokens=sum(
                tool_tokens[id(message)] for message in append_only_messages
            ),
            duplicate_tool_result_count=duplicate_count,
            duplicate_tool_result_tokens=duplicate_tokens,
            evictable_tool_result_count=len(evictable_messages),
            evictable_tool_result_tokens=sum(
                tool_tokens[id(message)] for message in evictable_messages
            ),
        )
        return conversation


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
        summarizer_client: SummarizerClient | None = None,
        summarizer_model_name: str | None = None,
    ) -> None:
        self._trigger_ratio = trigger_ratio
        self._model_name = model_name
        self._trigger_ratios_by_model = dict(trigger_ratios_by_model or {})
        self._cost_profile = cost_profile or CompactionCostProfile()
        self._cost_profiles_by_model = dict(cost_profiles_by_model or {})
        self._max_failures = max_consecutive_failures
        self._failure_count = 0
        self._last_cost_metrics: CompactionCostMetrics | None = None
        self._summarizer_client = summarizer_client
        self._summarizer_model_name = summarizer_model_name

    @property
    def last_cost_metrics(self) -> CompactionCostMetrics | None:
        if self._last_cost_metrics is None:
            return None
        return dict(self._last_cost_metrics)

    def apply(
        self,
        conversation: Conversation,
        zones: CacheZones,
        budget: ContextBudget,
        *,
        snapshot: FullContextSnapshot | None = None,
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
        cost_metrics["recent_files"] = _collect_recent_files(to_summarize, n=3)
        if self._should_skip_for_cost(cost_metrics):
            cost_metrics["decision"] = "skip_cost"
            self._last_cost_metrics = cost_metrics
            return conversation

        try:
            summary_messages = list(snapshot.messages) if snapshot is not None else to_summarize
            summary = self._call_summarizer(summary_messages)
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
    ) -> CompactionCostMetrics:
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

    def _should_skip_for_cost(self, metrics: CompactionCostMetrics) -> bool:
        profile = self._active_cost_profile()
        if profile.min_savings_ratio is None:
            return False
        raw_carry_cost = metrics["carry_cost"]
        if not isinstance(raw_carry_cost, int | float | str):
            return False
        carry_cost = float(raw_carry_cost)
        if carry_cost <= 0:
            return False
        raw_savings_ratio = metrics["savings_ratio"]
        if not isinstance(raw_savings_ratio, int | float | str):
            return False
        return float(raw_savings_ratio) < profile.min_savings_ratio

    def _call_summarizer(self, messages: list[Message]) -> str:
        if self._summarizer_client is None:
            return self._fallback_summary(messages)

        conversation_text = "\n\n".join(
            f"[{message.role}]\n{message.content}"
            for message in messages
            if message.content.strip()
        )
        if not conversation_text:
            return "Conversation summary unavailable."

        prompt = SUMMARY_PROMPT.format(conversation_text=conversation_text)
        response = self._summarizer_client.complete(
            messages=[{"role": "user", "content": prompt}],
            model=self._summarizer_model_name or self._model_name or "deepseek-lite",
            max_tokens=600,
        )
        content = getattr(response, "content", str(response))
        return content.strip()

    def _fallback_summary(self, messages: list[Message]) -> str:
        lines = [
            f"- {message.role}: {' '.join(message.content.split())[:120]}"
            for message in messages
            if message.content.strip()
        ]
        if not lines:
            return "Conversation summary unavailable."
        return "Conversation summary:\n" + "\n".join(lines)


SUMMARY_PROMPT = (
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
        context_window_analyzer: ContextWindowAnalyzer,
        llm_summarization: LLMSummarization,
        token_counter: TokenCounter | None = None,
        hook_manager: HookManager | None = None,
    ) -> None:
        self.tool_result_budget = tool_result_budget
        self.context_window_analyzer = context_window_analyzer
        self.llm_summarization = llm_summarization
        self._token_counter = token_counter or TokenCounter()
        self._hook_manager = hook_manager or HookManager()

    @property
    def last_context_window_metrics(self) -> ContextWindowMetrics | None:
        return self.context_window_analyzer.last_metrics

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
        current_budget = ContextBudget.from_estimate(
            max_tokens=budget.max_tokens,
            estimated_input_tokens=sum(
                self._token_counter.count_message(message)
                for message in compacted.messages
            ),
        )
        current_zones = CacheZones.from_conversation(compacted)
        self.context_window_analyzer.apply(compacted, current_zones, current_budget)
        return self.llm_summarization.apply(compacted, current_zones, current_budget)


def _copy_conversation(conversation: Conversation) -> Conversation:
    return Conversation(
        session_id=conversation.session_id,
        messages=list(conversation.messages),
    )


def _estimate_message_tokens(message: Message) -> int:
    if not message.content.strip():
        return 0
    return _TOKEN_COUNTER.count_message(message)


def _replace_tool_message(
    message: Message,
    *,
    content: str,
    metadata_updates: dict[str, object] | None = None,
    block_metadata_updates: dict[str, object] | None = None,
) -> Message:
    blocks: tuple[RuntimeBlock, ...] = ()
    message_metadata = dict(message.metadata)
    message_metadata.pop("cache_frozen", None)
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


def _is_append_only(message: Message) -> bool:
    return bool(message.metadata.get("append_only") or message.metadata.get("cache_frozen"))


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


def _collect_recent_files(messages: list[Message], n: int = 3) -> list[str]:
    edited: list[str] = []
    read: list[str] = []
    seen: set[str] = set()

    for message in reversed(messages):
        if message.role != "tool":
            continue
        path = _extract_tool_path(message)
        if not path or path in seen:
            continue
        seen.add(path)
        tool_name = _extract_tool_name(message)
        if tool_name in {"Edit", "Write", "edit_file", "write_file"}:
            edited.append(path)
        elif tool_name in {"Read", "read_file"}:
            read.append(path)

    return (edited + read)[:n]


def _extract_tool_path(message: Message) -> str | None:
    for block in message.blocks:
        if block.type != "tool_result":
            continue
        path = block.metadata.get("path")
        if isinstance(path, str) and path:
            return path
    path = message.metadata.get("path")
    return path if isinstance(path, str) and path else None


def _extract_tool_name(message: Message) -> str:
    for block in message.blocks:
        if block.type != "tool_result":
            continue
        name = block.metadata.get("tool_name")
        if isinstance(name, str) and name:
            return name
    name = message.metadata.get("tool_name")
    return name if isinstance(name, str) else ""


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
