from __future__ import annotations

from collections import OrderedDict
from collections.abc import Mapping
from pathlib import Path
import re

from mycli.domain.capabilities import (
    CapabilityActivation,
    CapabilityActivationDependencyStatus,
    CapabilityActivationSource,
)
from mycli.domain.skills import SkillDefinition
from mycli.services.skills import SkillRegistry


class CapabilityResolver:
    def __init__(
        self,
        *,
        skill_registry: SkillRegistry,
        workspace_root: Path,
        env: Mapping[str, str] | None = None,
    ) -> None:
        self._skill_registry = skill_registry
        self._workspace_root = workspace_root
        self._env = dict(env or {})

    def resolve(self, user_message: str) -> tuple[CapabilityActivation, ...]:
        resolved: OrderedDict[str, CapabilityActivation] = OrderedDict()
        for name in self._explicit_mentions(user_message):
            skill = self._skill_registry.load(name)
            if skill is None:
                continue
            resolved[name] = self._activation_from_skill(
                skill,
                source=CapabilityActivationSource.EXPLICIT_MENTION,
            )

        lowered = user_message.lower()
        for name in self._skill_registry.list_names():
            if name in resolved:
                continue
            metadata = self._skill_registry.get_metadata(name)
            if metadata is None:
                continue
            if not any(hint in lowered for hint in metadata.trigger_hints):
                continue
            skill = self._skill_registry.load(name)
            if skill is None:
                continue
            resolved[name] = self._activation_from_skill(
                skill,
                source=CapabilityActivationSource.TRIGGER_HINT,
            )

        return tuple(resolved.values())

    def _explicit_mentions(self, user_message: str) -> tuple[str, ...]:
        return tuple(
            match.group(1)
            for match in re.finditer(r"(?<!\w)\$([A-Za-z0-9][A-Za-z0-9_-]*)", user_message)
        )

    def _activation_from_skill(
        self,
        skill: SkillDefinition,
        *,
        source: CapabilityActivationSource,
    ) -> CapabilityActivation:
        missing_env_dependencies = [
            dependency for dependency in skill.env_dependencies if not self._env.get(dependency)
        ]
        missing_workspace_dependencies = [
            dependency
            for dependency in skill.workspace_dependencies
            if not (self._workspace_root / dependency).exists()
        ]

        dependency_status = CapabilityActivationDependencyStatus.READY
        if missing_env_dependencies:
            dependency_status = CapabilityActivationDependencyStatus.MISSING_ENV
        elif missing_workspace_dependencies:
            dependency_status = CapabilityActivationDependencyStatus.MISSING_WORKSPACE_RESOURCE

        return CapabilityActivation(
            name=skill.name,
            description=skill.description,
            instructions=skill.body,
            source=source,
            dependency_status=dependency_status,
            source_path=skill.source_path,
            metadata={
                "missing_env_dependencies": missing_env_dependencies,
                "missing_workspace_dependencies": missing_workspace_dependencies,
            },
        )
