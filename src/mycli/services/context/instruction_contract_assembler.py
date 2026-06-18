from __future__ import annotations

from mycli.domain.conversation import Message
from mycli.domain.runtime import (
    CanonicalTimelineDurability,
    CollaborationMode,
    InstructionContract,
    InstructionFragment,
    InstructionFragmentKind,
    TurnContext,
    TurnContextSection,
    TurnContextSectionType,
)
from mycli.services.context.developer_instructions import (
    DeveloperInstructionSection,
    render_collaboration_mode,
    render_permissions_instructions,
    render_skills_instructions,
)


class InstructionContractAssembler:
    def assemble(
        self,
        *,
        turn_context: TurnContext,
        base_instructions: str,
        conversation_messages: tuple[Message, ...],
        assistant_scaffold: str | None = None,
    ) -> InstructionContract:
        developer_sections: list[InstructionFragment] = []
        contextual_user_sections: list[InstructionFragment] = []
        current_user_request = turn_context.user_message

        for section in turn_context.enabled_sections():
            if section.durability is CanonicalTimelineDurability.API_ONLY:
                continue
            if section.type is TurnContextSectionType.BASE_INSTRUCTIONS:
                continue
            if section.type is TurnContextSectionType.COLLABORATION_MODE:
                developer_sections.append(
                    self._developer_instruction_fragment(
                        render_collaboration_mode(self._collaboration_mode(section))
                    )
                )
                continue
            if section.type is TurnContextSectionType.RUNTIME_REMINDERS:
                contextual_user_sections.append(
                    self._runtime_reminders_fragment(section)
                )
                continue
            if section.type is TurnContextSectionType.TOOL_EXPOSURE:
                developer_sections.append(self._tool_exposure_fragment(section))
                continue
            if section.type is TurnContextSectionType.WORKSPACE_INSTRUCTIONS:
                contextual_user_sections.append(
                    self._workspace_fragment(section)
                )
                continue
            if section.type is TurnContextSectionType.CONVERSATION_CONTEXT:
                contextual_user_sections.append(
                    self._directed_fragment(
                        section=section,
                        kind=InstructionFragmentKind.CONVERSATION_CONTEXT,
                        include_in_memory=False,
                        prefix="这是本轮相关的近期对话上下文。",
                    )
                )
                continue
            if section.type is TurnContextSectionType.MEMORY:
                contextual_user_sections.append(
                    self._directed_fragment(
                        section=section,
                        kind=InstructionFragmentKind.MEMORY,
                        include_in_memory=False,
                        prefix="这是本轮召回的相关记忆。",
                    )
                )
                continue
            if section.type is TurnContextSectionType.PLAN:
                contextual_user_sections.append(
                    self._directed_fragment(
                        section=section,
                        kind=InstructionFragmentKind.PLAN,
                        include_in_memory=False,
                        prefix="这是本轮当前的计划状态。",
                    )
                )
                continue
            if section.type is TurnContextSectionType.COMPACTION_REHYDRATION:
                contextual_user_sections.append(
                    self._directed_fragment(
                        section=section,
                        kind=InstructionFragmentKind.COMPACTION_REHYDRATION,
                        include_in_memory=False,
                        prefix=(
                            "这是压缩后的复水上下文。"
                            "它补充当前文件快照和已调用 skill 指令，不是用户的新请求。"
                        ),
                    )
                )
                continue
            if section.type is TurnContextSectionType.HOOK_CONTEXT:
                contextual_user_sections.append(
                    self._directed_fragment(
                        section=section,
                        kind=InstructionFragmentKind.HOOK_CONTEXT,
                        include_in_memory=False,
                        prefix="这是本轮 hook 提供的附加上下文，不是用户的新请求。",
                    )
                )
                continue
            if section.type is TurnContextSectionType.ENVIRONMENT_CONTEXT:
                permissions = render_permissions_instructions(section)
                if permissions is not None:
                    developer_sections.append(
                        self._developer_instruction_fragment(permissions)
                    )
                if not section.metadata.get("suppress_contextual_environment_fragment"):
                    contextual_user_sections.append(
                        self._directed_fragment(
                            section=section,
                            kind=InstructionFragmentKind.ENVIRONMENT_CONTEXT,
                            include_in_memory=False,
                            prefix="这是本轮相关的环境事实。",
                        )
                    )
                continue
            if section.type is TurnContextSectionType.SKILL_CATALOG:
                skill_instructions = render_skills_instructions(section.content)
                if skill_instructions is not None:
                    developer_sections.append(
                        self._developer_instruction_fragment(skill_instructions)
                    )
                continue
            if section.type is TurnContextSectionType.USER_REQUEST:
                current_user_request = turn_context.user_message

        return InstructionContract(
            base_instructions=base_instructions,
            developer_sections=tuple(developer_sections),
            contextual_user_sections=tuple(contextual_user_sections),
            conversation_messages=conversation_messages,
            current_user_request=current_user_request,
            assistant_scaffold=assistant_scaffold,
        )

    def _collaboration_mode(self, section: TurnContextSection) -> CollaborationMode:
        value = section.metadata.get("mode") or section.content
        try:
            return CollaborationMode(str(value).strip().lower())
        except ValueError:
            return CollaborationMode.DEFAULT

    def _developer_instruction_fragment(
        self,
        section: DeveloperInstructionSection,
    ) -> InstructionFragment:
        metadata = dict(section.metadata)
        metadata.setdefault("cache_class", section.cache_class.value)
        metadata.setdefault("durability", CanonicalTimelineDurability.PERSISTENT.value)
        metadata.setdefault("scope", "turn")
        metadata.setdefault("model_visible", True)
        metadata.setdefault("replayable", False)
        return InstructionFragment(
            kind=section.kind,
            title=section.title,
            content=section.content,
            source=section.source,
            metadata=metadata,
            include_in_memory=False,
        )

    def _fragment(
        self,
        *,
        section: TurnContextSection,
        kind: InstructionFragmentKind,
        include_in_memory: bool,
    ) -> InstructionFragment:
        metadata = dict(section.metadata)
        metadata.setdefault("cache_class", section.cache_class.value)
        metadata.setdefault("durability", section.durability.value)
        metadata.setdefault("scope", section.scope.value)
        metadata.setdefault(
            "model_visible",
            section.durability is not CanonicalTimelineDurability.API_ONLY,
        )
        metadata.setdefault(
            "replayable",
            section.durability is CanonicalTimelineDurability.PERSISTENT
            and section.scope.value == "transcript",
        )
        return InstructionFragment(
            kind=kind,
            title=section.title,
            content=section.content,
            source=section.source,
            metadata=metadata,
            include_in_memory=include_in_memory,
        )

    def _directed_fragment(
        self,
        *,
        section: TurnContextSection,
        kind: InstructionFragmentKind,
        include_in_memory: bool,
        prefix: str,
    ) -> InstructionFragment:
        metadata = dict(section.metadata)
        metadata.setdefault("cache_class", section.cache_class.value)
        metadata.setdefault("durability", section.durability.value)
        metadata.setdefault("scope", section.scope.value)
        metadata.setdefault(
            "model_visible",
            section.durability is not CanonicalTimelineDurability.API_ONLY,
        )
        metadata.setdefault(
            "replayable",
            section.durability is CanonicalTimelineDurability.PERSISTENT
            and section.scope.value == "transcript",
        )
        return InstructionFragment(
            kind=kind,
            title=section.title,
            content=f"{prefix}\n{section.content}",
            source=section.source,
            metadata=metadata,
            include_in_memory=include_in_memory,
        )

    def _runtime_reminders_fragment(self, section: TurnContextSection) -> InstructionFragment:
        return self._directed_fragment(
            section=section,
            kind=InstructionFragmentKind.RUNTIME_REMINDERS,
            include_in_memory=False,
            prefix="这是本轮运行时提醒。",
        )

    def _workspace_fragment(self, section: TurnContextSection) -> InstructionFragment:
        return self._directed_fragment(
            section=section,
            kind=InstructionFragmentKind.WORKSPACE_INSTRUCTIONS,
            include_in_memory=False,
            prefix="这是本轮的工作区/项目说明。它适用于当前任务或你将要接触的文件时，请遵循它。",
        )

    def _tool_exposure_fragment(self, section: TurnContextSection) -> InstructionFragment:
        metadata = dict(section.metadata)
        metadata.setdefault("cache_class", section.cache_class.value)
        metadata.setdefault("durability", section.durability.value)
        metadata.setdefault("scope", section.scope.value)
        metadata.setdefault(
            "model_visible",
            section.durability is not CanonicalTimelineDurability.API_ONLY,
        )
        metadata.setdefault(
            "replayable",
            section.durability is CanonicalTimelineDurability.PERSISTENT
            and section.scope.value == "transcript",
        )
        return InstructionFragment(
            kind=InstructionFragmentKind.TOOL_EXPOSURE,
            title=section.title,
            content=(
                "本轮只使用已暴露且可调用的工具。所有工具都属于同一个平等工具集；"
                "能用专门工具解决时，优先不要退化成临时 shell 操作。\n"
                f"{section.content}"
            ),
            source=section.source,
            metadata=metadata,
            include_in_memory=False,
        )
