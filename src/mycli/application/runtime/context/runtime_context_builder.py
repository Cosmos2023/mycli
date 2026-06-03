from __future__ import annotations

from mycli.domain.conversation import Conversation
from mycli.domain.logging import LogLevel
from mycli.domain.runtime import (
    AgentConfig,
    CompactionRehydrationContext,
    ExecutionContext,
    PlanState,
    TurnContext,
)
from mycli.domain.tooling.exposure import ToolExposure
from mycli.memory.service import MemoryService
from mycli.services.context.context_manager import ContextManager
from mycli.services.context.context_files import ContextFileLoader
from mycli.services.context.skill_catalog import render_skill_catalog
from mycli.services.context.turn_context_assembler import TurnContextAssembler
from mycli.services.skills import SkillRegistry
from mycli.state.session_service import SessionService
from mycli.tools.registry import ToolRegistry
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
        skill_registry: SkillRegistry,
        tool_registry: ToolRegistry,
        workspace_log_service: WorkspaceLogService,
        context_file_loader: ContextFileLoader | None = None,
    ) -> None:
        self._config = config
        self._session_service = session_service
        self._memory_service = memory_service
        self._context_manager = context_manager
        self._turn_context_assembler = turn_context_assembler
        self._skill_registry = skill_registry
        self._tool_registry = tool_registry
        self._workspace_log_service = workspace_log_service
        self._context_file_loader = context_file_loader or ContextFileLoader()

    def set_config(self, config: AgentConfig) -> None:
        self._config = config

    def build_context(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        runtime_reminders: tuple[str, ...] = (),
        compaction_rehydration: CompactionRehydrationContext | None = None,
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
        loaded_context = self._context_file_loader.load(
            workspace_root=self._config.workspace_root,
        )
        return ExecutionContext(
            config=self._config,
            memory_records=self._memory_service.collect_runtime_context(
                user_message=user_message,
                session_id=self._config.session_id,
            ),
            skill_catalog=render_skill_catalog(self._skill_registry),
            tool_exposure=tool_exposure,
            available_tool_names=available_tool_names,
            plan_state=plan_state,
            conversation_messages=provider_replay_messages,
            conversation_summary=managed.summary,
            history_items=history_items,
            context_baseline=context_baseline,
            runtime_reminders=runtime_reminders,
            compaction_rehydration=(
                compaction_rehydration or CompactionRehydrationContext()
            ),
            context_file_content=loaded_context.content,
            context_file_diagnostics=loaded_context.diagnostics.to_dict(),
        )

    def assemble_turn_context(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        runtime_reminders: tuple[str, ...] = (),
        compaction_rehydration: CompactionRehydrationContext | None = None,
        tool_exposure: ToolExposure | None = None,
    ) -> tuple[ExecutionContext, TurnContext]:
        context = self.build_context(
            user_message=user_message,
            conversation=conversation,
            plan_state=plan_state,
            runtime_reminders=runtime_reminders,
            compaction_rehydration=compaction_rehydration,
            tool_exposure=tool_exposure,
        )
        turn_context = self._turn_context_assembler.assemble(
            user_message=user_message,
            context=context,
            workspace_instructions=context.context_file_content or None,
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
                "cache_classes": summary["cache_classes"],
                "context_file": context.context_file_diagnostics,
            },
        )
        return context, turn_context
