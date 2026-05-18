from __future__ import annotations

from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.services.skills import SkillRegistry
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec


class SkillTool:
    spec = ToolSpec(
        name="Skill",
        description=(
            "Load a skill's detailed instructions when the available skill catalog "
            "shows that the skill is relevant to the current task."
        ),
        parameters=(
            ToolParameter(
                name="skill_name",
                type="string",
                required=True,
                description="Exact skill name from the available skill catalog.",
            ),
        ),
        risk_level="low",
    )

    def __init__(self, skill_registry: SkillRegistry) -> None:
        self._skill_registry = skill_registry

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        skill_name = str(arguments.get("skill_name", "")).strip()
        if not skill_name:
            return ToolResult(
                success=False,
                summary="Failed to activate skill",
                error="skill_name is required.",
            )

        skill = self._skill_registry.load(skill_name)
        if skill is None:
            return ToolResult(
                success=False,
                summary=f"Failed to activate skill: {skill_name}",
                error=f"Skill '{skill_name}' not found.",
            )

        return ToolResult(
            success=True,
            summary=f"Activated skill: {skill.name}",
            raw_payload={
                "skill_name": skill.name,
                "description": skill.description,
                "content": skill.body,
                "source_path": skill.source_path,
                "env_dependencies": list(skill.env_dependencies),
                "workspace_dependencies": list(skill.workspace_dependencies),
                "guardrails": list(skill.guardrails),
            },
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)
