from __future__ import annotations

from mycli.domain.conversation import Message
from mycli.domain.runtime import (
    InstructionContract,
    InstructionFragment,
    InstructionFragmentKind,
    TurnContext,
    TurnContextSection,
    TurnContextSectionType,
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
            if section.type is TurnContextSectionType.BASE_INSTRUCTIONS:
                continue
            if section.type is TurnContextSectionType.RUNTIME_REMINDERS:
                developer_sections.append(
                    self._runtime_policy_fragment(section)
                )
                continue
            if section.type is TurnContextSectionType.TOOL_EXPOSURE:
                developer_sections.append(self._tool_exposure_fragment(section))
                contextual_user_sections.extend(self._dynamic_tool_fragments(section))
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
            if section.type is TurnContextSectionType.ENVIRONMENT_CONTEXT:
                contextual_user_sections.append(
                    self._directed_fragment(
                        section=section,
                        kind=InstructionFragmentKind.ENVIRONMENT_CONTEXT,
                        include_in_memory=False,
                        prefix="这是本轮相关的环境事实。",
                    )
                )
                continue
            if section.type is TurnContextSectionType.CAPABILITY:
                contextual_user_sections.append(
                    self._capability_fragment(section)
                )
                continue
            if section.type is TurnContextSectionType.USER_REQUEST:
                current_user_request = turn_context.user_message
                contextual_user_sections.append(
                    self._directed_fragment(
                        section=section,
                        kind=InstructionFragmentKind.USER_REQUEST,
                        include_in_memory=True,
                        prefix="这是当前用户请求。请围绕这个请求推进，不要漂移到无关工作上。",
                    )
                )

        return InstructionContract(
            base_instructions=base_instructions,
            developer_sections=tuple(developer_sections),
            contextual_user_sections=tuple(contextual_user_sections),
            conversation_messages=conversation_messages,
            current_user_request=current_user_request,
            assistant_scaffold=assistant_scaffold,
        )

    def _fragment(
        self,
        *,
        section: TurnContextSection,
        kind: InstructionFragmentKind,
        include_in_memory: bool,
    ) -> InstructionFragment:
        return InstructionFragment(
            kind=kind,
            title=section.title,
            content=section.content,
            source=section.source,
            metadata=dict(section.metadata),
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
        return InstructionFragment(
            kind=kind,
            title=section.title,
            content=f"{prefix}\n{section.content}",
            source=section.source,
            metadata=dict(section.metadata),
            include_in_memory=include_in_memory,
        )

    def _runtime_policy_fragment(self, section: TurnContextSection) -> InstructionFragment:
        return self._directed_fragment(
            section=section,
            kind=InstructionFragmentKind.RUNTIME_POLICY,
            include_in_memory=False,
            prefix="本轮请遵循这组 runtime policy。",
        )

    def _workspace_fragment(self, section: TurnContextSection) -> InstructionFragment:
        return self._directed_fragment(
            section=section,
            kind=InstructionFragmentKind.WORKSPACE_INSTRUCTIONS,
            include_in_memory=False,
            prefix="这是本轮的工作区/项目说明。它适用于当前任务或你将要接触的文件时，请遵循它。",
        )

    def _capability_fragment(self, section: TurnContextSection) -> InstructionFragment:
        return self._directed_fragment(
            section=section,
            kind=InstructionFragmentKind.CAPABILITY_BODY,
            include_in_memory=False,
            prefix="这是本轮可用的 capability。它相关时可以使用，但不要暗示系统具备未明确提供的能力。",
        )

    def _tool_exposure_fragment(self, section: TurnContextSection) -> InstructionFragment:
        metadata = dict(section.metadata)
        metadata.pop("dynamic_tools", None)
        return InstructionFragment(
            kind=InstructionFragmentKind.TOOL_EXPOSURE,
            title=section.title,
            content=(
                "本轮只使用已暴露且可调用的工具。能用专门工具解决时，优先不要退化成临时 shell 操作。\n"
                f"{section.content}"
            ),
            source=section.source,
            metadata=metadata,
            include_in_memory=False,
        )

    def _dynamic_tool_fragments(
        self,
        section: TurnContextSection,
    ) -> tuple[InstructionFragment, ...]:
        dynamic_tools = section.metadata.get("dynamic_tools", [])
        if not isinstance(dynamic_tools, list):
            return ()
        rendered: list[InstructionFragment] = []
        for item in dynamic_tools:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", "dynamic_tool"))
            rendered.append(
                InstructionFragment(
                    kind=InstructionFragmentKind.DYNAMIC_TOOL_CONTEXT,
                    title=f"Dynamic tool context: {name}",
                    content=(
                        "这是本轮可用的动态工具。只有在它确实有帮助、且作用域/状态适合当前任务时才使用它。\n"
                        f"Dynamic tool: {name}\n"
                        f"Tool id: {item.get('tool_id', '')}\n"
                        f"Scope: {item.get('scope', '')}\n"
                        f"State: {item.get('state', '')}\n"
                        f"Source: {item.get('source', '')}"
                    ),
                    source=section.source,
                    metadata=dict(item),
                    include_in_memory=False,
                )
            )
        return tuple(rendered)
