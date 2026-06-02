from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.conversation import Conversation
from mycli.domain.runtime import PlanState
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.contributed_tools import (
    ToolContributionDescriptor,
    ToolContributionLifecycleState,
    ToolContributionRegistration,
    ToolContributionScope,
    ToolContributionSource,
)
from mycli.domain.tooling.exposure import ToolRouteKey
from mycli.services.skills.registry import SkillRegistry
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec


@dataclass(slots=True)
class _SkillContributionTool:
    registry: SkillRegistry
    skill_name: str
    spec: ToolSpec

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        del arguments
        skill = self.registry.load(self.skill_name)
        if skill is None:
            return ToolResult(
                success=False,
                summary=f"Failed to activate skill: {self.skill_name}",
                error=f"Skill '{self.skill_name}' not found.",
                raw_payload={"skill_name": self.skill_name, "error_kind": "skill_not_found"},
            )
        return ToolResult(
            success=True,
            summary=f"Activated skill: {skill.name}",
            raw_payload={
                "skill_name": skill.name,
                "description": skill.description,
                "content": skill.body,
                "source_path": skill.source_path,
                "source_kind": skill.source_kind,
                "env_dependencies": list(skill.env_dependencies),
                "workspace_dependencies": list(skill.workspace_dependencies),
                "guardrails": list(skill.guardrails),
            },
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


@dataclass(slots=True)
class SkillToolContributionProvider:
    registry: SkillRegistry

    def provide(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
    ) -> tuple[ToolContributionRegistration, ...]:
        del user_message, conversation, plan_state
        registrations: list[ToolContributionRegistration] = []
        for metadata in self.registry.list_metadata():
            route_name = f"skill.{metadata.name}"
            spec = ToolSpec(
                name=route_name,
                description=f"Load skill instructions: {metadata.description}",
                parameters=(
                    ToolParameter(
                        name="reason",
                        type="string",
                        required=False,
                        description="Why this skill is relevant to the current turn.",
                    ),
                ),
                risk_level="low",
            )
            registrations.append(
                ToolContributionRegistration(
                    descriptor=ToolContributionDescriptor(
                        tool_id=f"skill:{metadata.name}",
                        display_name=route_name,
                        description=metadata.description,
                        route_key=ToolRouteKey(namespace="skill", name=metadata.name),
                        source=ToolContributionSource.PROVIDER,
                        scope=ToolContributionScope.THREAD,
                        lifecycle_state=ToolContributionLifecycleState.DECLARED,
                        spec=spec,
                        origin_metadata={
                            "skill": metadata.name,
                            "source_kind": metadata.source_kind,
                            "availability": metadata.availability,
                            "trigger_hints": list(metadata.trigger_hints),
                        },
                    ),
                    tool=_SkillContributionTool(
                        registry=self.registry,
                        skill_name=metadata.name,
                        spec=spec,
                    ),
                )
            )
        return tuple(registrations)
