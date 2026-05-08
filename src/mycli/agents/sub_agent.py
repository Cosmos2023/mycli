from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from mycli.services.context.token_counter import CachePolicy, Fragment, FragmentKind, Priority


@dataclass(slots=True, frozen=True)
class SubAgentReportFragment(Fragment):
    metadata: dict[str, Any] = field(default_factory=dict)


class SubAgent:
    def __init__(
        self,
        name: str,
        system_prompt: str,
        tools: list[object],
        model: str,
        budget: object,
        max_tool_calls: int = 25,
        cache_prefix: str | None = None,
    ) -> None:
        self.name = name
        self.system_prompt = system_prompt
        self.tools = sorted(tools, key=lambda tool: str(getattr(tool, "name", "")))
        self.model = model
        self.budget = budget
        self.max_tool_calls = max_tool_calls
        self.cache_prefix = cache_prefix or f"sub_agent:{name}"
        self._messages: list[dict[str, object]] = []

    def run(self, task: str) -> Fragment:
        self._messages = self._build_initial_messages(task)
        tool_call_count = 0

        for _ in range(self.max_tool_calls):
            response = self._call_model(self._messages, self.tools)
            if self._is_final(response):
                return self._report_fragment(
                    content=self._response_content(response),
                    tool_call_count=tool_call_count,
                )

            tool_calls = self._response_tool_calls(response)
            for call in tool_calls:
                self._messages.append(self._assistant_tool_call_message(call))
                result = self._execute_tool(call)
                self._messages.append(self._tool_result_message(call, result))
                tool_call_count += 1

        return self._timeout_fragment(tool_call_count)

    def _build_initial_messages(self, task: str) -> list[dict[str, object]]:
        messages = [self._system_message(self.system_prompt)]
        messages.extend(self._tool_schema_messages())
        messages.append(self._user_message(task))
        return messages

    def _tool_schema_messages(self) -> list[dict[str, object]]:
        messages: list[dict[str, object]] = []
        for tool in self.tools:
            render_schema = getattr(tool, "render_schema", None)
            if callable(render_schema):
                messages.append(
                    self._system_message(
                        str(render_schema()),
                        tool_name=str(getattr(tool, "name", "")),
                    )
                )
        return messages

    def _system_message(self, content: str, *, tool_name: str | None = None) -> dict[str, object]:
        message: dict[str, object] = {"role": "system", "content": content}
        if tool_name is not None:
            message["tool_name"] = tool_name
        return message

    def _user_message(self, content: str) -> dict[str, object]:
        return {"role": "user", "content": content}

    def _assistant_tool_call_message(self, call: object) -> dict[str, object]:
        return {
            "role": "assistant",
            "content": "",
            "tool_calls": [call],
        }

    def _tool_result_message(self, call: object, result: object) -> dict[str, object]:
        return {
            "role": "tool",
            "content": self._tool_result_content(result),
            "tool_name": str(getattr(call, "name", "")),
        }

    def _tool_result_content(self, result: object) -> str:
        if hasattr(result, "summary"):
            return str(getattr(result, "summary"))
        if hasattr(result, "content"):
            return str(getattr(result, "content"))
        return str(result)

    def _report_fragment(self, *, content: str, tool_call_count: int) -> SubAgentReportFragment:
        return SubAgentReportFragment(
            id=f"{self.cache_prefix}:report",
            kind=FragmentKind.TOOL_RESULT,
            priority=Priority.HIGH,
            cache_policy=CachePolicy.DYNAMIC,
            content=f"[Sub-agent '{self.name}' report]:\n{content}",
            metadata=self._report_metadata(tool_call_count=tool_call_count),
        )

    def _timeout_fragment(self, tool_call_count: int) -> SubAgentReportFragment:
        metadata = self._report_metadata(tool_call_count=tool_call_count)
        metadata["timeout"] = True
        return SubAgentReportFragment(
            id=f"{self.cache_prefix}:timeout",
            kind=FragmentKind.TOOL_RESULT,
            priority=Priority.LOW,
            cache_policy=CachePolicy.DYNAMIC,
            content=(
                f"[Sub-agent '{self.name}' reached max tool calls "
                f"({self.max_tool_calls})]"
            ),
            metadata=metadata,
        )

    def _report_metadata(self, *, tool_call_count: int) -> dict[str, object]:
        return {
            "source": "sub_agent",
            "sub_agent_name": self.name,
            "tool_calls": tool_call_count,
            "cache_prefix": self.cache_prefix,
        }

    def _call_model(self, messages: list[dict[str, object]], tools: list[object]) -> object:
        raise NotImplementedError

    def _execute_tool(self, call: object) -> object:
        raise NotImplementedError

    def _is_final(self, response: object) -> bool:
        raise NotImplementedError

    def _response_content(self, response: object) -> str:
        raise NotImplementedError

    def _response_tool_calls(self, response: object) -> list[object]:
        raise NotImplementedError


__all__ = ["SubAgent", "SubAgentReportFragment"]
