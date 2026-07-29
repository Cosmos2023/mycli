from __future__ import annotations

from collections.abc import Callable

from mycli.domain.conversation import Conversation
from mycli.domain.logging import LogLevel
from mycli.domain.runtime import (
    AgentConfig,
    CompactionRehydrationContext,
    ExecPolicyRuleSet,
    ExecutionContext,
    ExecutionPolicy,
    PlanState,
    RuntimeEnvironmentContract,
    RuntimeTraceEvent,
    TurnContext,
    TurnContextSection,
    TurnContextSectionType,
    stable_hash,
)
from mycli.domain.tooling.exposure import ToolExposure
from mycli.memory.service import MemoryService
from mycli.services.context.context_manager import ContextManager
from mycli.services.context.context_files import ContextFileLoader
from mycli.services.context.section_budget import TurnContextBudgeter
from mycli.services.context.skill_catalog import render_skill_catalog
from mycli.services.context.turn_context_assembler import TurnContextAssembler
from mycli.services.skills import SkillRegistry
from mycli.services.tracing import TraceService
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
        policy_provider: Callable[[], ExecutionPolicy],
        context_file_loader: ContextFileLoader | None = None,
        trace_service: TraceService | None = None,
        turn_context_budgeter: TurnContextBudgeter | None = None,
        execpolicy_rules: ExecPolicyRuleSet | None = None,
    ) -> None:
        self._config = config
        self._session_service = session_service
        self._memory_service = memory_service
        self._context_manager = context_manager
        self._turn_context_assembler = turn_context_assembler
        self._skill_registry = skill_registry
        self._tool_registry = tool_registry
        self._workspace_log_service = workspace_log_service
        self._policy_provider = policy_provider
        self._context_file_loader = context_file_loader or ContextFileLoader()
        self._trace_service = trace_service
        self._turn_context_budgeter = turn_context_budgeter or TurnContextBudgeter()
        self._execpolicy_rules = execpolicy_rules or ExecPolicyRuleSet()

    def set_config(self, config: AgentConfig) -> None:
        self._config = config

    def set_execpolicy_rules(self, rules: ExecPolicyRuleSet) -> None:
        self._execpolicy_rules = rules

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
                enabled=self._config.memory_enabled,
            ),
            skill_catalog=render_skill_catalog(self._skill_registry),
            tool_exposure=tool_exposure,
            available_tool_names=available_tool_names,
            plan_state=plan_state,
            conversation_messages=provider_replay_messages,
            conversation_summary=None,
            history_items=history_items,
            context_baseline=context_baseline,
            hook_contexts=tuple(
                item
                for item in runtime_reminders
                if item.strip().startswith("[hook:")
            ),
            runtime_reminders=runtime_reminders,
            compaction_rehydration=(
                compaction_rehydration or CompactionRehydrationContext()
            ),
            runtime_environment=self._runtime_environment_contract(),
            context_file_content=loaded_context.content,
            context_file_diagnostics=loaded_context.diagnostics.to_dict(),
        )

    def _runtime_environment_contract(self) -> RuntimeEnvironmentContract:
        policy = self._policy_provider()
        sources = tuple(rule.source.value for rule in self._execpolicy_rules.rules)
        from mycli.tools.process_sandbox import process_sandbox_backend_profile

        return RuntimeEnvironmentContract.from_policy(
            policy,
            execpolicy_rule_count=len(self._execpolicy_rules.rules),
            execpolicy_sources=sources,
            shell_backend=process_sandbox_backend_profile(policy.sandbox),
        )

    def assemble_turn_context(
        self,
        *,
        turn_id: str,
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
        turn_context = self._suppress_redundant_environment_context(
            turn_id=turn_id,
            turn_context=turn_context,
        )
        turn_context, budget_diagnostic = self._turn_context_budgeter.apply(
            turn_context=turn_context,
            max_tokens=self._config.max_prompt_tokens,
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
                "budget": {
                    "target_tokens": budget_diagnostic.target_tokens,
                    "before_tokens": budget_diagnostic.before_tokens,
                    "after_tokens": budget_diagnostic.after_tokens,
                    "trimmed_section_count": budget_diagnostic.trimmed_section_count,
                },
            },
        )
        if self._trace_service is not None:
            self._trace_service.append(
                self._config.session_id,
                RuntimeTraceEvent(
                    kind="context_budget_diagnostic",
                    turn_id=turn_id,
                    payload=budget_diagnostic.to_dict(),
                ),
            )
        return context, turn_context

    def _suppress_redundant_environment_context(
        self,
        *,
        turn_id: str,
        turn_context: TurnContext,
    ) -> TurnContext:
        environment = next(
            (
                section
                for section in turn_context.sections
                if section.type is TurnContextSectionType.ENVIRONMENT_CONTEXT
            ),
            None,
        )
        if environment is None or not environment.enabled:
            return turn_context
        content_hash = stable_hash(environment.content)
        previous = self._session_service.load_runtime_environment_context_state(
            self._config.session_id
        )
        if (
            previous is not None
            and previous.get("content_hash") == content_hash
        ):
            return TurnContext(
                user_message=turn_context.user_message,
                sections=tuple(
                    section
                    if section.type is not TurnContextSectionType.ENVIRONMENT_CONTEXT
                    else TurnContextSection(
                        type=section.type,
                        title=section.title,
                        content=section.content,
                        enabled=section.enabled,
                        source=section.source,
                        metadata={
                            **dict(section.metadata),
                            "suppressed_by_runtime_environment_cache": True,
                            "suppress_contextual_environment_fragment": True,
                            "runtime_environment_hash": content_hash,
                        },
                        cache_class=section.cache_class,
                        durability=section.durability,
                        scope=section.scope,
                    )
                    for section in turn_context.sections
                ),
            )
        return turn_context
