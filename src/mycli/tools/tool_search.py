from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from mycli.domain.tooling.calls import ToolCall, ToolResult
from mycli.domain.tooling.exposure import ToolExposureEntry
from mycli.tools.base import ToolParameter, ToolSpec
from mycli.tools.model_output import structured_model_output

TOOL_SEARCH_NAME = "ToolSearch"
TOOL_SEARCH_DEFAULT_LIMIT = 8
TOOL_SEARCH_MAX_LIMIT = 20


@dataclass(slots=True)
class ToolSearchTool:
    entries: tuple[ToolExposureEntry, ...]
    spec: ToolSpec = field(init=False)

    def __post_init__(self) -> None:
        self.spec = ToolSpec(
            name=TOOL_SEARCH_NAME,
            description=(
                "Search deferred tools by capability. Returns complete tool definitions "
                "that can be called in the same turn."
            ),
            parameters=(
                ToolParameter(
                    name="query",
                    type="string",
                    description="Capability, action, or domain to search for.",
                ),
                ToolParameter(
                    name="limit",
                    type="integer",
                    required=False,
                    description="Maximum number of matching tools to return (1-20).",
                ),
            ),
            risk_level="low",
            supports_parallel_tool_calls=True,
            model_output_adapter=structured_model_output,
        )

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        query = str(arguments.get("query") or "").strip()
        if not query:
            return ToolResult(
                success=False,
                summary="Tool search requires a non-empty query.",
                error="query must not be empty",
                raw_payload={"tools": [], "error": "query must not be empty"},
            )
        raw_limit = arguments.get("limit", TOOL_SEARCH_DEFAULT_LIMIT)
        if isinstance(raw_limit, bool):
            raw_limit = 0
        try:
            limit = int(raw_limit)
        except (TypeError, ValueError):
            limit = 0
        if not 1 <= limit <= TOOL_SEARCH_MAX_LIMIT:
            return ToolResult(
                success=False,
                summary=f"Tool search limit must be between 1 and {TOOL_SEARCH_MAX_LIMIT}.",
                error="invalid limit",
                raw_payload={"tools": [], "error": "invalid limit"},
            )

        ranked = sorted(
            self.entries,
            key=lambda entry: (-_search_score(entry, query), entry.name),
        )
        matched = [entry for entry in ranked if _search_score(entry, query) > 0][:limit]
        tools = [_tool_definition(entry) for entry in matched]
        return ToolResult(
            success=True,
            summary=f"Found {len(tools)} matching tool{'s' if len(tools) != 1 else ''}.",
            raw_payload={"tools": tools},
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


def _search_score(entry: ToolExposureEntry, query: str) -> int:
    query_text = query.casefold()
    searchable = _searchable_text(entry)
    score = 20 if query_text in searchable else 0
    for token in _tokens(query_text):
        if token in entry.name.casefold():
            score += 8
        score += min(searchable.count(token), 4)
    return score


def _searchable_text(entry: ToolExposureEntry) -> str:
    parts = [entry.name, entry.name.replace("_", " "), entry.spec.description]
    for parameter in entry.spec.parameters:
        parts.extend((parameter.name, parameter.description or ""))
    for key in ("server", "tool", "provider_name", "skill"):
        value = entry.metadata.get(key)
        if isinstance(value, str):
            parts.append(value)
    return " ".join(parts).casefold()


def _tokens(value: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys(re.findall(r"[\w-]+", value.casefold())))


def _tool_definition(entry: ToolExposureEntry) -> dict[str, object]:
    properties: dict[str, object] = {}
    required: list[str] = []
    for parameter in entry.spec.parameters:
        schema: dict[str, object] = {"type": parameter.type}
        if parameter.description:
            schema["description"] = parameter.description
        if parameter.items_schema is not None:
            schema["items"] = parameter.items_schema
        properties[parameter.name] = schema
        if parameter.required:
            required.append(parameter.name)
    return {
        "type": "function",
        "name": entry.name,
        "description": entry.spec.description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        },
    }


__all__ = [
    "TOOL_SEARCH_DEFAULT_LIMIT",
    "TOOL_SEARCH_NAME",
    "ToolSearchTool",
]
