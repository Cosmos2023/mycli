from __future__ import annotations

from typing import Protocol

from mycli.domain.subagents import SubAgentInvocation, SubAgentProfile, SubAgentResult
from mycli.domain.tooling.calls import ToolCall
from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.tools.base import ToolResult


class ChildTurn(Protocol):
    text: str
    tool_calls: tuple[ToolCall, ...]


class ChildTurnRequester(Protocol):
    def request_child_turn(
        self,
        *,
        messages: list[dict[str, object]],
        tool_names: tuple[str, ...],
        child_session_id: str,
    ) -> ChildTurn:
        ...


class ChildToolExecutor(Protocol):
    def execute_child_tool(
        self,
        *,
        call: ToolCall,
        child_session_id: str,
        tool_names: tuple[str, ...],
    ) -> ToolResult:
        ...


class SubAgentChildLoop:
    def __init__(self, *, requester: ChildTurnRequester, executor: ChildToolExecutor) -> None:
        self._requester = requester
        self._executor = executor
        self._formatter = ToolResultFormatter()

    def run(
        self,
        *,
        invocation: SubAgentInvocation,
        profile: SubAgentProfile,
        child_session_id: str,
        tool_names: tuple[str, ...],
    ) -> SubAgentResult:
        messages: list[dict[str, object]] = [
            {"role": "system", "content": profile.system_prompt},
            {"role": "user", "content": invocation.description},
        ]
        tool_calls = 0
        no_progress_turns = 0

        for _turn_index in range(profile.budget.max_turns):
            turn = self._requester.request_child_turn(
                messages=messages,
                tool_names=tool_names,
                child_session_id=child_session_id,
            )
            text = (turn.text or "").strip()
            calls = tuple(turn.tool_calls)
            if text and not calls:
                return SubAgentResult(
                    status="completed",
                    report=text,
                    child_session_id=child_session_id,
                    tool_calls=tool_calls,
                )
            if not text and not calls:
                no_progress_turns += 1
                if no_progress_turns >= profile.budget.no_progress_turn_limit:
                    return SubAgentResult(
                        status="max_no_progress",
                        report="Child sub-agent stopped after repeated no-progress turns.",
                        child_session_id=child_session_id,
                        tool_calls=tool_calls,
                    )
                continue
            no_progress_turns = 0
            for call in calls:
                if tool_calls >= profile.budget.max_tool_calls:
                    return SubAgentResult(
                        status="max_tool_calls",
                        report="Child sub-agent reached the max tool call limit.",
                        child_session_id=child_session_id,
                        tool_calls=tool_calls,
                    )
                result = self._executor.execute_child_tool(
                    call=call,
                    child_session_id=child_session_id,
                    tool_names=tool_names,
                )
                tool_calls += 1
                if result.raw_payload.get("error_kind") == "approval_required":
                    return SubAgentResult(
                        status="approval_required",
                        report=f"Child sub-agent stopped because {call.name} requires approval.",
                        child_session_id=child_session_id,
                        tool_calls=tool_calls,
                        error=result.error,
                    )
                messages.append(
                    {
                        "role": "assistant",
                        "content": text,
                        "tool_calls": [call],
                    }
                )
                messages.append(
                    {
                        "role": "tool",
                        "tool_name": call.name,
                        "content": self._formatter.format(call.name, result),
                    }
                )

        return SubAgentResult(
            status="max_turns",
            report="Child sub-agent reached the max turn limit.",
            child_session_id=child_session_id,
            tool_calls=tool_calls,
        )


__all__ = ["ChildToolExecutor", "ChildTurnRequester", "SubAgentChildLoop"]
