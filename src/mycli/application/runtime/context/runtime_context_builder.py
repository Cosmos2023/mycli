from __future__ import annotations

from mycli.domain.capabilities import (
    CapabilityActivation,
    CapabilityActivationDependencyStatus,
)
from mycli.domain.conversation import Conversation
from mycli.domain.logging import LogLevel
from mycli.domain.runtime import (
    AgentConfig,
    ExecutionContext,
    PlanState,
    TurnContext,
)
from mycli.domain.skills import SkillDefinition, SkillMetadata
from mycli.domain.tooling.exposure import ToolExposure
from mycli.memory.service import MemoryService
from mycli.services.capabilities import CapabilityResolver
from mycli.services.context.context_manager import ContextManager
from mycli.services.context.turn_context_assembler import TurnContextAssembler
from mycli.services.skills import SkillRegistry
from mycli.state.session_service import SessionService
from mycli.tools.registry import ToolRegistryV2
from mycli.utils.workspace_logger import WorkspaceLogService


class RuntimeContextBuilder:
    def __init__(
        self,
        *,
        config: AgentConfig,
        session_service: SessionService,
        memory_service: MemoryService,
        context_manager: ContextManager,
        turn_context_assembler: TurnContextAssembler,
        capability_resolver: CapabilityResolver,
        skill_registry: SkillRegistry,
        tool_registry: ToolRegistryV2,
        workspace_log_service: WorkspaceLogService,
    ) -> None:
        self._config = config
        self._session_service = session_service
        self._memory_service = memory_service
        self._context_manager = context_manager
        self._turn_context_assembler = turn_context_assembler
        self._capability_resolver = capability_resolver
        self._skill_registry = skill_registry
        self._tool_registry = tool_registry
        self._workspace_log_service = workspace_log_service

    def set_config(self, config: AgentConfig) -> None:
        self._config = config

    def resolve_capability_activations(
        self,
        user_message: str,
    ) -> tuple[CapabilityActivation, ...]:
        return self._capability_resolver.resolve(user_message)

    def select_skill_metadata(self, user_message: str) -> SkillMetadata | None:
        lowered = user_message.lower()
        for name in self._skill_registry.list_names():
            skill = self._skill_registry.get_metadata(name)
            if skill and any(hint in lowered for hint in skill.trigger_hints):
                return skill
        return None

    def load_selected_skill(self, user_message: str) -> SkillDefinition | None:
        metadata = self.select_skill_metadata(user_message)
        if metadata is None:
            return None
        return self._skill_registry.load(metadata.name)

    def active_skill_from_activations(
        self,
        capability_activations: tuple[CapabilityActivation, ...],
    ) -> SkillDefinition | None:
        for activation in capability_activations:
            if activation.dependency_status is not CapabilityActivationDependencyStatus.READY:
                continue
            return SkillDefinition(
                name=activation.name,
                description=activation.description,
                trigger_hints=(),
                body=activation.instructions,
                source_path=activation.source_path,
            )
        return None

    def build_context(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        runtime_reminders: tuple[str, ...] = (),
        runtime_policy_state: dict[str, object] | None = None,
        capability_activations: tuple[CapabilityActivation, ...] = (),
        tool_exposure: ToolExposure | None = None,
    ) -> ExecutionContext:
        runtime_snapshot = self._session_service.load_runtime_snapshot(
            self._config.session_id
        )
        history_items = () if runtime_snapshot is None else runtime_snapshot.history_items
        context_baseline = None if runtime_snapshot is None else runtime_snapshot.context_baseline
        managed = self._context_manager.build(
            conversation=tuple(conversation.messages),
            history_items=history_items,
            recent_message_count=self._config.recent_message_count,
        )
        provider_replay_messages = self._context_manager.provider_replay_messages(
            conversation=tuple(conversation.messages),
            history_items=history_items,
        )
        available_tool_names = (
            tool_exposure.callable_tool_names()
            if tool_exposure is not None
            else tuple(self._tool_registry.list_names())
        )
        return ExecutionContext(
            config=self._config,
            memory_records=self._memory_service.collect_runtime_context(
                user_message=user_message,
                session_id=self._config.session_id,
            ),
            active_skill=self.active_skill_from_activations(capability_activations)
            or self.load_selected_skill(user_message),
            capability_activations=capability_activations,
            tool_exposure=tool_exposure,
            available_tool_names=available_tool_names,
            plan_state=plan_state,
            conversation_messages=provider_replay_messages,
            conversation_summary=managed.summary,
            history_items=history_items,
            context_baseline=context_baseline,
            runtime_reminders=runtime_reminders,
            runtime_policy_state={} if runtime_policy_state is None else dict(runtime_policy_state),
        )

    def assemble_turn_context(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        runtime_reminders: tuple[str, ...] = (),
        runtime_policy_state: dict[str, object] | None = None,
        capability_activations: tuple[CapabilityActivation, ...] = (),
        tool_exposure: ToolExposure | None = None,
    ) -> tuple[ExecutionContext, TurnContext]:
        context = self.build_context(
            user_message=user_message,
            conversation=conversation,
            plan_state=plan_state,
            runtime_reminders=runtime_reminders,
            runtime_policy_state=runtime_policy_state,
            capability_activations=capability_activations,
            tool_exposure=tool_exposure,
        )
        turn_context = self._turn_context_assembler.assemble(
            user_message=user_message,
            context=context,
        )
        summary = turn_context.debug_summary()
        self._workspace_log_service.log(
            level=LogLevel.INFO,
            event="turn_context_assembled",
            message="Assembled turn context",
            context={
                "session_id": self._config.session_id,
                "enabled_sections": summary["enabled_sections"],
                "section_order": summary["section_order"],
            },
        )
        return context, turn_context
