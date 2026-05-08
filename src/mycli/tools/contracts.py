from __future__ import annotations

from typing import Protocol

from mycli.domain.tooling.calls import ToolCall, ToolResult
from mycli.tools.registry import ToolRegistryV2


class Tool(Protocol):
    name: str

    def run(self, call: ToolCall) -> ToolResult:
        """Execute a tool call and return a structured result."""


class ToolRegistry:
    def __init__(self, tools: list[Tool]) -> None:
        self._tools = {tool.name: tool for tool in tools}

    def run(self, call: ToolCall) -> ToolResult:
        tool = self._tools.get(call.name)
        if tool is None:
            raise ValueError(f"Unsupported tool: {call.name}")
        return tool.run(call)

    def list_names(self) -> list[str]:
        return sorted(self._tools)


__all__ = ["Tool", "ToolRegistry", "ToolRegistryV2"]
