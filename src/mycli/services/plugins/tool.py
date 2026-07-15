from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Callable

from mycli.domain.tooling.calls import ToolCall, ToolResult
from mycli.domain.tooling.output import ToolModelOutput
from mycli.tools.base import ToolEffectProfile, ToolParameter, ToolSpec

PluginToolHandler = Callable[
    [dict[str, Any]],
    ToolResult | ToolModelOutput | dict[str, Any] | str,
]


@dataclass(slots=True)
class PluginTool:
    spec: ToolSpec
    handler: PluginToolHandler
    plugin_id: str
    toolset: str = "plugin"
    capability_tags: tuple[str, ...] = ()

    @property
    def manifest_metadata(self) -> dict[str, object]:
        return {
            "id": f"plugin:{self.plugin_id}:{self.spec.name}",
            "source": "plugin",
            "toolset": self.toolset,
            "approval_policy": "auto_allow",
            "capability_tags": ("plugin", self.plugin_id, *self.capability_tags),
        }

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        try:
            result = self.handler(dict(arguments))
        except Exception as exc:
            return ToolResult(
                success=False,
                summary="plugin tool failed",
                error=exc.__class__.__name__,
                model_output=ToolModelOutput.from_text(
                    f"Plugin tool failed: {exc.__class__.__name__}",
                    success=False,
                ),
            )
        if isinstance(result, ToolResult):
            if result.model_output is not None:
                return result
            text = result.summary or result.error or "plugin tool completed"
            return replace(
                result,
                model_output=ToolModelOutput.from_text(text, success=result.success),
            )
        if isinstance(result, ToolModelOutput):
            success = result.success is not False
            return ToolResult(
                success=success,
                summary=result.text_content() or "plugin tool completed",
                model_output=result,
            )
        if isinstance(result, dict):
            summary = result.get("summary") or result.get("content") or result.get("message") or "plugin tool completed"
            return ToolResult(
                success=True,
                summary=str(summary),
                raw_payload=dict(result),
                model_output=ToolModelOutput.from_json(result, success=True),
            )
        return ToolResult(
            success=True,
            summary=str(result),
            model_output=ToolModelOutput.from_text(str(result), success=True),
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(filesystem="none")


def tool_spec_from_schema(name: str, schema: dict[str, Any]) -> ToolSpec:
    description = schema.get("description")
    risk_level = schema.get("risk_level")
    return ToolSpec(
        name=name,
        description=str(description) if description else f"Plugin tool {name}",
        parameters=_parameters(schema.get("parameters")),
        risk_level=str(risk_level) if risk_level in {"low", "medium", "high"} else "low",
    )


def _parameters(value: object) -> tuple[ToolParameter, ...]:
    if isinstance(value, list):
        parsed: list[ToolParameter] = []
        for item in value:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            if not isinstance(name, str) or not name.strip():
                continue
            parameter_type = item.get("type")
            required = item.get("required", True)
            description = item.get("description")
            items_schema = item.get("items_schema")
            parsed.append(
                ToolParameter(
                    name=name.strip(),
                    type=str(parameter_type or "string"),
                    required=bool(required),
                    description=str(description) if description else None,
                    items_schema=dict(items_schema) if isinstance(items_schema, dict) else None,
                )
            )
        return tuple(parsed)
    if isinstance(value, dict):
        properties = value.get("properties")
        required_values = value.get("required", [])
        required = set(required_values) if isinstance(required_values, list) else set()
        if isinstance(properties, dict):
            parsed = []
            for name, prop in properties.items():
                if not isinstance(name, str) or not isinstance(prop, dict):
                    continue
                parsed.append(
                    ToolParameter(
                        name=name,
                        type=str(prop.get("type") or "string"),
                        required=name in required,
                        description=str(prop.get("description")) if prop.get("description") else None,
                    )
                )
            return tuple(parsed)
    return ()
