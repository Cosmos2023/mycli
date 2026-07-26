from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import StrEnum

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import PlanState, RuntimeBlock, StopReason


class ExitReason(StrEnum):
    TOKEN_BUDGET_EXCEEDED = "token_budget_exceeded"
    TOOL_COUNT_EXCEEDED = "tool_count_exceeded"
    LOOP_DETECTED = "loop_detected"
    REPEATED_TOOL_FAILURE = "repeated_tool_failure"
    REPEATED_REPLANNING = "repeated_replanning"
    NO_PROGRESS = "no_progress"


class ContinueReason(StrEnum):
    COMPACT_CONTEXT = "compact_context"
    REROUTE = "reroute"
    TRUNCATION_AWARE = "truncation_aware"
    NEXT_STEP = "next_step"


@dataclass(slots=True, frozen=True)
class CheckpointResult:
    exit_reason: ExitReason | None = None
    continue_reason: ContinueReason = ContinueReason.NEXT_STEP
    stop_reason: StopReason | None = None
    assistant_message: str | None = None
    reminders: tuple[str, ...] = field(default_factory=tuple)
    diagnostics: dict[str, object] = field(default_factory=dict)


class NoProgressTracker:
    def __init__(self) -> None:
        self._seen_signatures: set[str] = set()
        self._no_progress_count = 0

    def update(self, conversation: Conversation) -> None:
        current_signatures = self._tool_call_signatures(conversation)
        new_signatures = current_signatures - self._seen_signatures
        if new_signatures:
            self._no_progress_count = 0
            self._seen_signatures |= new_signatures
            return
        self._no_progress_count += 1

    def no_progress_count(self) -> int:
        return self._no_progress_count

    @staticmethod
    def _tool_call_signatures(conversation: Conversation) -> set[str]:
        sigs: set[str] = set()
        for message in _messages_in_current_turn(conversation):
            if message.role != "assistant":
                continue
            for call in message.tool_calls:
                sigs.add(_tool_call_signature(call.name, call.arguments))
        return sigs


class TurnCheckpoint:
    def __init__(
        self,
        *,
        max_tokens_per_turn: int = 200_000,
        no_progress_threshold: int = 6,
        reroute_threshold: int = 3,
        repeated_replanning_threshold: int = 2,
        repeated_failed_tool_threshold: int = 3,
    ) -> None:
        self._max_tokens = max_tokens_per_turn
        self._no_progress_threshold = no_progress_threshold
        self._reroute_threshold = reroute_threshold
        self._repeated_replanning_threshold = repeated_replanning_threshold
        self._repeated_failed_tool_threshold = repeated_failed_tool_threshold

    def evaluate(
        self,
        *,
        step_index: int,
        conversation: Conversation,
        current_window_tokens: int = 0,
        plan_state: PlanState | None = None,
        no_progress_tracker: NoProgressTracker | None = None,
    ) -> CheckpointResult:
        max_repeated = self._max_repeated_tool_signatures(conversation)
        repeated_failure = self._repeated_failed_tool_result(conversation)

        plan_state_obj = plan_state or PlanState()
        replan_count = self._count_tool_calls_in_current_turn(
            conversation,
            "update_plan",
        )
        if replan_count >= self._repeated_replanning_threshold and plan_state_obj.items:
            return CheckpointResult(
                exit_reason=ExitReason.REPEATED_REPLANNING,
                stop_reason=StopReason.LOOP_DETECTED,
                assistant_message=(
                    "I stopped due to repeated replanning without executing the current plan. "
                    "Continue the existing plan or narrow the request."
                ),
            )

        if (
            no_progress_tracker is not None
            and no_progress_tracker.no_progress_count() >= self._no_progress_threshold
        ):
            return CheckpointResult(
                exit_reason=ExitReason.NO_PROGRESS,
                stop_reason=StopReason.LOOP_DETECTED,
                assistant_message=(
                    "No new evidence after multiple tool calls. "
                    "Summarizing what is known so far."
                ),
            )

        reminders: list[str] = []
        continue_reason = ContinueReason.NEXT_STEP

        if repeated_failure is not None:
            continue_reason = ContinueReason.REROUTE
            reminders.append(
                "A tool has failed repeatedly for the same target. Use the failures as evidence, "
                "change approach, or answer with what is known instead of retrying it."
            )

        if current_window_tokens >= self._max_tokens:
            continue_reason = ContinueReason.COMPACT_CONTEXT
            reminders.append(
                "Context window is at or over budget. Compact context before the next model request, then continue the current turn."
            )

        if max_repeated == self._reroute_threshold:
            if continue_reason is ContinueReason.NEXT_STEP:
                continue_reason = ContinueReason.REROUTE
            reminders.append(
                "You are repeating the same tool exploration. Summarize what is already known or choose a different confirmed path."
            )

        if self._has_truncation_signal(conversation):
            if continue_reason == ContinueReason.NEXT_STEP:
                continue_reason = ContinueReason.TRUNCATION_AWARE
            reminders.append(
                "A recent file excerpt was truncated. Prefer Read with offset/limit on the confirmed path instead of repeating broad Read."
            )

        return CheckpointResult(
            continue_reason=continue_reason,
            reminders=tuple(dict.fromkeys(reminders)),
            diagnostics=repeated_failure or {},
        )

    def _max_repeated_tool_signatures(self, conversation: Conversation) -> int:
        signatures: dict[str, int] = {}
        max_count = 0
        for message in _messages_in_current_turn(conversation):
            if message.role != "assistant":
                continue
            for call in message.tool_calls:
                signature = _tool_call_signature(call.name, call.arguments)
                signatures[signature] = signatures.get(signature, 0) + 1
                max_count = max(max_count, signatures[signature])
        return max_count

    def _count_tool_calls_in_current_turn(
        self,
        conversation: Conversation,
        tool_name: str,
    ) -> int:
        count = 0
        for message in _messages_in_current_turn(conversation):
            if message.role != "assistant":
                continue
            for call in message.tool_calls:
                if call.name == tool_name:
                    count += 1
        return count

    def _has_truncation_signal(self, conversation: Conversation) -> bool:
        for message in _messages_in_current_turn(conversation):
            if message.role != "tool":
                continue
            for block in message.blocks:
                if _is_truncated_tool_result(block):
                    return True
        return False

    def _repeated_failed_tool_result(
        self,
        conversation: Conversation,
    ) -> dict[str, object] | None:
        signatures: dict[str, dict[str, object]] = {}
        for message in _messages_in_current_turn(conversation):
            if message.role != "tool":
                continue
            for block in message.blocks:
                if block.type != "tool_result":
                    continue
                metadata = block.metadata
                if metadata.get("success") is not False:
                    continue
                tool_name = metadata.get("tool_name")
                if not isinstance(tool_name, str) or not tool_name:
                    continue
                path = metadata.get("path")
                error_kind = metadata.get("error_kind")
                command = _failed_tool_command(metadata)
                target = path if isinstance(path, str) and path else command
                if not target:
                    continue
                signature = _tool_call_signature(
                    tool_name,
                    {
                        "target": target,
                        "error_kind": error_kind if isinstance(error_kind, str) else "",
                    },
                )
                diagnostic = signatures.setdefault(
                    signature,
                    {
                        "trigger": "repeated_failed_tool_result",
                        "count": 0,
                        "tool_name": tool_name,
                    },
                )
                raw_count = diagnostic.get("count")
                count = raw_count if isinstance(raw_count, int) else 0
                count += 1
                diagnostic["count"] = count
                if isinstance(path, str) and path:
                    diagnostic["path"] = path
                elif command:
                    diagnostic["command"] = command
                if isinstance(error_kind, str) and error_kind:
                    diagnostic["error_kind"] = error_kind
        for diagnostic in signatures.values():
            if diagnostic.get("count") == self._repeated_failed_tool_threshold:
                return diagnostic
        return None


def _messages_in_current_turn(conversation: Conversation) -> tuple[Message, ...]:
    current_turn: list[Message] = []
    for message in reversed(conversation.messages):
        if message.role == "user":
            break
        current_turn.append(message)
    current_turn.reverse()
    return tuple(current_turn)


def _tool_call_signature(name: str, arguments: dict[str, object]) -> str:
    return json.dumps(
        {"name": name, "arguments": arguments},
        ensure_ascii=False,
        sort_keys=True,
    )


def _failed_tool_command(metadata: dict[str, object]) -> str:
    raw_payload = metadata.get("raw_payload")
    if not isinstance(raw_payload, dict):
        return ""
    command = raw_payload.get("command")
    return command if isinstance(command, str) else ""


def _is_truncated_tool_result(block: RuntimeBlock) -> bool:
    if block.type != "tool_result":
        return False
    lowered = (block.text or "").lower()
    return (
        "excerpt truncated" in lowered
        or "use read with offset/limit" in lowered
        or "use read using offset/limit" in lowered
        or "use read_file_range" in lowered
    )
