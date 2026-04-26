from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from mycli.domain.tools import ToolCall
from mycli.infrastructure.models.base import ModelToolDefinition, ModelToolParameter
from mycli.tools.base import SchemaTool, ToolSpec, ToolResultV2


@dataclass(slots=True)
class ToolRegistryV2:
    specs: dict[str, ToolSpec]
    executors: dict[str, SchemaTool]

    @classmethod
    def from_tools(cls, tools: list[SchemaTool]) -> ToolRegistryV2:
        return cls(
            specs={tool.spec.name: tool.spec for tool in tools},
            executors={tool.spec.name: tool for tool in tools},
        )

    def list_names(self) -> list[str]:
        return sorted(self.specs)

    def render_for_model(self, tool_names: tuple[str, ...] | None = None) -> list[ModelToolDefinition]:
        selected_names = tuple(self.specs) if tool_names is None else tool_names
        return [
            ModelToolDefinition(
                name=spec.name,
                description=spec.description,
                parameters=tuple(
                    ModelToolParameter(
                        name=parameter.name,
                        type=parameter.type,
                        required=parameter.required,
                        description=parameter.description,
                        items_schema=parameter.items_schema,
                    )
                    for parameter in spec.parameters
                ),
            )
            for name in selected_names
            if (spec := self.specs.get(name)) is not None
        ]

    def validate(self, name: str, arguments: dict[str, Any]) -> None:
        spec = self.specs.get(name)
        if spec is None:
            raise ValueError(f"Unsupported tool: {name}")
        missing = [
            parameter.name
            for parameter in spec.parameters
            if parameter.required and parameter.name not in arguments
        ]
        if missing:
            raise ValueError(f"Missing required arguments: {', '.join(missing)}")

    def execute(self, call: ToolCall) -> ToolResultV2:
        self.validate(call.name, call.arguments)
        executor = self.executors.get(call.name)
        if executor is None:
            raise ValueError(f"Unsupported tool: {call.name}")
        return executor.execute(call.arguments)
