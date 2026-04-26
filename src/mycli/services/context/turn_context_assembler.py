from __future__ import annotations

from mycli.domain.capabilities import CapabilityActivationDependencyStatus
from mycli.domain.conversation import Message
from mycli.domain.runtime import (
    ExecutionContext,
    HistoryItemType,
    TurnContext,
    TurnContextSection,
    TurnContextSectionType,
)


class TurnContextAssembler:
    def assemble(
        self,
        *,
        user_message: str,
        context: ExecutionContext,
        workspace_instructions: str | None = None,
    ) -> TurnContext:
        sections = (
            TurnContextSection(
                type=TurnContextSectionType.BASE_INSTRUCTIONS,
                title="Base instructions",
                content="Follow the runtime operating rules already provided in the system prompt.",
                enabled=True,
                source="system_prompt",
            ),
            TurnContextSection(
                type=TurnContextSectionType.WORKSPACE_INSTRUCTIONS,
                title="Workspace instructions",
                content=self._workspace_instructions(context, workspace_instructions),
                enabled=bool(self._workspace_instructions(context, workspace_instructions)),
                source="workspace" if workspace_instructions else "baseline",
            ),
            TurnContextSection(
                type=TurnContextSectionType.ENVIRONMENT_CONTEXT,
                title="Environment context",
                content=self._render_environment_context(context),
                enabled=True,
                source="runtime",
                metadata={
                    "workspace_root": str(context.config.workspace_root),
                    "session_id": context.config.session_id,
                    "model": context.config.model,
                    "protocol": context.config.protocol,
                },
            ),
            TurnContextSection(
                type=TurnContextSectionType.CONVERSATION_CONTEXT,
                title="Conversation context",
                content=self._render_conversation_context(context),
                enabled=bool(
                    context.conversation_summary
                    or context.conversation_messages
                    or context.history_items
                ),
                source="conversation",
            ),
            TurnContextSection(
                type=TurnContextSectionType.MEMORY,
                title="Memory",
                content=self._render_memory(context),
                enabled=bool(context.memory_records),
                source="memory",
            ),
            TurnContextSection(
                type=TurnContextSectionType.PLAN,
                title="Current plan",
                content=self._render_plan(context),
                enabled=bool(context.plan_state.items),
                source="plan",
            ),
            TurnContextSection(
                type=TurnContextSectionType.RUNTIME_REMINDERS,
                title="Runtime reminders",
                content=self._render_runtime_reminders(context),
                enabled=bool(context.runtime_reminders) or bool(context.runtime_policy_state),
                source="runtime_policy",
                metadata=dict(context.runtime_policy_state),
            ),
            TurnContextSection(
                type=TurnContextSectionType.CAPABILITY,
                title="Capability",
                content=self._render_capability(context),
                enabled=bool(context.capability_activations) or context.active_skill is not None,
                source="skill",
                metadata=self._capability_metadata(context),
            ),
            TurnContextSection(
                type=TurnContextSectionType.TOOL_EXPOSURE,
                title="Tool exposure",
                content=self._render_tool_exposure(context),
                enabled=bool(context.tool_exposure is not None and context.tool_exposure.all_entries())
                or bool(context.available_tool_names),
                source="tool_registry",
                metadata=self._tool_exposure_metadata(context),
            ),
            TurnContextSection(
                type=TurnContextSectionType.USER_REQUEST,
                title="Current user request",
                content=f"Current user request: {user_message}",
                enabled=True,
                source="user",
            ),
        )
        return TurnContext(user_message=user_message, sections=sections)

    def _render_environment_context(self, context: ExecutionContext) -> str:
        runtime_context = (
            f"Workspace root: {context.config.workspace_root}\n"
            f"Session id: {context.config.session_id}\n"
            f"Model: {context.config.model}\n"
            f"Protocol: {context.config.protocol}"
        )
        baseline_environment = self._baseline_fragment_content(context, "environment_context")
        if baseline_environment:
            return f"{baseline_environment}\n{runtime_context}"
        return runtime_context

    def _render_conversation_context(self, context: ExecutionContext) -> str:
        messages = context.conversation_messages or self._messages_from_history(context)
        summary = context.conversation_summary or ("none" if not messages else "Derived from structured history.")
        return f"Conversation summary: {summary}\nRecent conversation:\n{messages}"

    def _render_messages(self, messages: tuple[Message, ...]) -> str:
        if not messages:
            return "none"
        return "\n".join(f"{message.role}: {message.content}" for message in messages)

    def _messages_from_history(self, context: ExecutionContext) -> tuple[Message, ...]:
        messages: list[Message] = []
        for item in context.history_items:
            if item.type is HistoryItemType.USER_MESSAGE:
                messages.append(Message(role="user", content=item.text or ""))
            elif item.type is HistoryItemType.ASSISTANT_MESSAGE:
                messages.append(Message(role="assistant", content=item.text or ""))
            elif item.type is HistoryItemType.TOOL_RESULT:
                messages.append(Message(role="tool", content=item.text or ""))
        return tuple(messages)

    def _workspace_instructions(
        self,
        context: ExecutionContext,
        workspace_instructions: str | None,
    ) -> str:
        if workspace_instructions:
            return workspace_instructions
        return self._baseline_fragment_content(context, "workspace_instructions")

    def _baseline_fragment_content(
        self,
        context: ExecutionContext,
        kind: str,
    ) -> str:
        baseline = context.context_baseline
        if baseline is None:
            return ""
        fragments = [fragment.content for fragment in baseline.fragments if fragment.kind == kind]
        return "\n".join(fragment for fragment in fragments if fragment)

    def _render_memory(self, context: ExecutionContext) -> str:
        return "Memory: " + ("; ".join(record.value for record in context.memory_records) or "none")

    def _render_plan(self, context: ExecutionContext) -> str:
        summary = (
            "\n".join(
                f"- {item.status.value}: {item.content}" for item in context.plan_state.items
            )
            or "none"
        )
        return f"Current plan:\n{summary}"

    def _render_runtime_reminders(self, context: ExecutionContext) -> str:
        lines: list[str] = []
        if context.runtime_policy_state:
            lines.append("Runtime policy state:")
            for key, value in context.runtime_policy_state.items():
                lines.append(f"- {key}: {value}")
        reminders = "\n".join(f"- {item}" for item in context.runtime_reminders) or "none"
        lines.append("Runtime reminders:")
        lines.append(reminders)
        return "\n".join(lines)

    def _render_capability(self, context: ExecutionContext) -> str:
        if context.capability_activations:
            rendered: list[str] = []
            for activation in context.capability_activations:
                rendered.append(
                    "Activated capability: "
                    f"{activation.name} "
                    f"(source={activation.source.value}, status={activation.dependency_status.value})"
                )
                rendered.append(f"Capability instructions ({activation.name}):")
                rendered.append(activation.instructions)
                missing_env_dependencies = activation.metadata.get("missing_env_dependencies", [])
                if missing_env_dependencies:
                    rendered.append(
                        "Missing env dependencies: "
                        + ", ".join(str(item) for item in missing_env_dependencies)
                    )
                missing_workspace_dependencies = activation.metadata.get(
                    "missing_workspace_dependencies",
                    [],
                )
                if missing_workspace_dependencies:
                    rendered.append(
                        "Missing workspace dependencies: "
                        + ", ".join(str(item) for item in missing_workspace_dependencies)
                    )
            return "\n".join(rendered)
        if context.active_skill is None:
            return ""
        return (
            f"Active skill: {context.active_skill.name}\n"
            f"Active skill instructions ({context.active_skill.name}):\n"
            f"{context.active_skill.body}"
        )

    def _capability_metadata(self, context: ExecutionContext) -> dict[str, object]:
        if context.capability_activations:
            return {
                "capability_names": [activation.name for activation in context.capability_activations],
                "dependency_statuses": {
                    activation.name: activation.dependency_status.value
                    for activation in context.capability_activations
                },
            }
        return {
            "skill_name": context.active_skill.name if context.active_skill else None,
            "source_path": context.active_skill.source_path if context.active_skill else None,
            "dependency_statuses": (
                {}
                if context.active_skill is None
                else {context.active_skill.name: CapabilityActivationDependencyStatus.READY.value}
            ),
        }

    def _render_tool_exposure(self, context: ExecutionContext) -> str:
        if context.tool_exposure is not None:
            summary = context.tool_exposure.summary()
            direct = ", ".join(summary["direct"]) or "none"
            deferred = ", ".join(summary["deferred"]) or "none"
            dynamic = self._render_dynamic_tools(context)
            return (
                f"Direct tools: {direct}\n"
                f"Deferred tools: {deferred}\n"
                f"Dynamic tools: {dynamic}"
            )
        tools = ", ".join(context.available_tool_names) or "none"
        return f"Available tools: {tools}"

    def _tool_exposure_metadata(self, context: ExecutionContext) -> dict[str, object]:
        if context.tool_exposure is None:
            return {"tool_names": list(context.available_tool_names)}
        summary = context.tool_exposure.summary()
        return {
            "direct_tool_names": summary["direct"],
            "deferred_tool_names": summary["deferred"],
            "dynamic_tool_names": summary["dynamic"],
            "dynamic_tools": self._dynamic_tool_metadata(context),
            "tool_names": summary["direct"] + summary["deferred"] + summary["dynamic"],
        }

    def _render_dynamic_tools(self, context: ExecutionContext) -> str:
        if context.tool_exposure is None or not context.tool_exposure.dynamic:
            return "none"
        rendered: list[str] = []
        for entry in context.tool_exposure.dynamic:
            descriptor = entry.dynamic_descriptor
            if descriptor is None:
                rendered.append(entry.name)
                continue
            rendered.append(
                f"{entry.name} "
                f"[scope={descriptor.scope.value} "
                f"state={descriptor.lifecycle_state.value} "
                f"source={descriptor.source.value}]"
            )
        return ", ".join(rendered)

    def _dynamic_tool_metadata(self, context: ExecutionContext) -> list[dict[str, object]]:
        if context.tool_exposure is None:
            return []
        metadata: list[dict[str, object]] = []
        for entry in context.tool_exposure.dynamic:
            descriptor = entry.dynamic_descriptor
            if descriptor is None:
                metadata.append({"name": entry.name})
                continue
            metadata.append(
                {
                    "name": entry.name,
                    "tool_id": descriptor.tool_id,
                    "scope": descriptor.scope.value,
                    "state": descriptor.lifecycle_state.value,
                    "source": descriptor.source.value,
                }
            )
        return metadata
