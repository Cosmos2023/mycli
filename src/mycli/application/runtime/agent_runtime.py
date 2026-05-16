from __future__ import annotations

import os
from pathlib import Path

from mycli.domain.capabilities import CapabilityActivation
from mycli.domain.conversation import Conversation
from mycli.domain.tooling.contributed_tools import (
    ToolContributionLifecycleEvent,
)
from mycli.domain.runtime import (
    ActivityEvent,
    AgentConfig,
    ContextBaseline,
    DecisionAction,
    ExecutionContext,
    InstructionContract,
    ModelTurnResult,
    PendingApproval,
    PendingDecision,
    PlanState,
    RuntimeBlock,
    RuntimeItem,
    RequestShape,
    ReasoningEffort,
    StopReason,
    TurnContext,
    TurnItem,
    TurnRecord,
    TurnResponse,
    TurnStatus,
)
from mycli.domain.skills import SkillDefinition, SkillMetadata
from mycli.domain.tooling.exposure import (
    ToolExposure,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.llms.adapters.base import ModelAdapter, ModelMessage, ModelToolDefinition
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore
from mycli.services.approval.approval_service import ApprovalService
from mycli.services.capabilities import CapabilityResolver
from mycli.services.context.context_manager import ContextManager
from mycli.services.context.compaction import (
    CompactionCostProfile,
    ContextBudget,
    CompactionPipeline,
    ContextWindowAnalyzer,
    LLMSummarization,
    ToolResultBudget,
)
from mycli.services.context.token_counter import TokenCounter
from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.services.file_history import FileHistoryService
from mycli.services.hooks import HookManager, HookPoint
from mycli.services.hooks.builtin import permission_guard
from mycli.services.context.instruction_contract_assembler import InstructionContractAssembler
from mycli.services.context.turn_context_assembler import TurnContextAssembler
from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.application.runtime.tools.contributed_tool_provider import ToolContributionProvider
from mycli.memory.service import MemoryService
from mycli.services.planning import PlanModeService, PlanningService
from mycli.services.observability import ObservabilityService
from mycli.services.session_service import SessionService
from mycli.services.skills import SkillRegistry
from mycli.tools.routing.tool_exposure_planner import PlannedToolExposure, ToolExposurePlanner
from mycli.tools.routing.tool_router import ToolRouter
from mycli.services.tracing import TraceService
from mycli.services.runtime_policy import RuntimePolicy
from mycli.services.turn_guard import TurnCheckpoint
from mycli.utils.workspace_logger import WorkspaceLogService
from mycli.tools.registry import ToolRegistryV2
from mycli.application.runtime.context import RuntimeContextBuilder
from mycli.application.runtime.approval_decisions import RuntimeApprovalDecisions
from mycli.application.runtime.capability_turn_recorder import CapabilityTurnRecorder
from mycli.application.runtime.ledger import RuntimeEventLedger
from mycli.application.runtime.model import (
    AssistantConversationRecorder,
    AssistantBlockConsumer,
    ModelTurnRequester,
    RuntimeModelState,
)
from mycli.application.runtime.planning_effects import RuntimePlanningEffects
from mycli.application.runtime.request import (
    RequestPipeline,
    RequestShapeBuilder,
    RequestShapePayloadFormatter,
)
from mycli.application.runtime.response_finalizer import RuntimeResponseFinalizer
from mycli.application.runtime.runtime_error_logger import RuntimeErrorLogger
from mycli.application.runtime.runtime_policy_coordinator import RuntimePolicyCoordinator
from mycli.application.runtime.tools import ToolExecutionService, ToolOrchestrator


class AgentRuntime:
    def __init__(
        self,
        *,
        model_adapter: ModelAdapter,
        tool_registry: ToolRegistryV2,
        config: AgentConfig,
        home_dir: Path,
        approval_service: ApprovalService | None = None,
        context_manager: ContextManager | None = None,
        session_service: SessionService | None = None,
        memory_service: MemoryService | None = None,
        planning_service: PlanningService | None = None,
        skill_registry: SkillRegistry | None = None,
        trace_service: TraceService | None = None,
        observability_service: ObservabilityService | None = None,
        workspace_log_service: WorkspaceLogService | None = None,
        contributed_tool_providers: tuple[ToolContributionProvider, ...] = (),
    ) -> None:
        self._model_adapter = model_adapter
        self._tool_registry = tool_registry
        self._config = config
        self._approval_service = approval_service or ApprovalService()
        self._tool_result_formatter = ToolResultFormatter()
        self._token_counter = TokenCounter()
        self._observability_service = observability_service or ObservabilityService()
        self._hook_manager = HookManager()
        self._hook_manager.register(HookPoint.PRE_TOOL_USE, permission_guard)
        self._compaction_pipeline = CompactionPipeline(
            tool_result_budget=ToolResultBudget(self._tool_result_formatter),
            context_window_analyzer=ContextWindowAnalyzer(
                dedup_trigger_ratio=0.4,
                eviction_trigger_ratio=0.7,
                keep_recent_tool_results=8,
            ),
            llm_summarization=LLMSummarization(
                trigger_ratio=config.compaction_l4_trigger_ratio,
                model_name=config.model,
                trigger_ratios_by_model=config.compaction_l4_trigger_ratios_by_model,
                cost_profile=CompactionCostProfile(
                    input_cost_per_1k=config.compaction_l4_input_cost_per_1k,
                    output_cost_per_1k=config.compaction_l4_output_cost_per_1k,
                    carry_cost_per_1k=config.compaction_l4_carry_cost_per_1k,
                    expected_summary_tokens=config.compaction_l4_expected_summary_tokens,
                    min_savings_ratio=config.compaction_l4_min_savings_ratio,
                    carry_turns=config.compaction_l4_carry_turns,
                ),
            ),
            token_counter=self._token_counter,
            hook_manager=self._hook_manager,
        )
        self._context_manager = context_manager or ContextManager(
            formatter=self._tool_result_formatter,
        )
        self._file_history_service = FileHistoryService(
            home_dir=home_dir,
            workspace_root=config.workspace_root,
        )
        self._session_store = SQLiteSessionStore(home_dir / ".mycli" / "sessions.db")
        self._session_service = session_service or SessionService(
            home_dir=home_dir,
            workspace_root=config.workspace_root,
            session_store=self._session_store,
        )
        self._memory_service = memory_service or MemoryService(
            home_dir=home_dir,
            workspace_root=config.workspace_root,
            session_store=self._session_store,
        )
        self._planning_service = planning_service or PlanningService()
        self._skill_registry = skill_registry or SkillRegistry(
            builtin_root=Path(__file__).resolve().parents[2] / "prompts" / "skills",
            user_root=home_dir / ".mycli" / "skills",
        )
        self._capability_resolver = CapabilityResolver(
            skill_registry=self._skill_registry,
            workspace_root=config.workspace_root,
            env=dict(os.environ),
        )
        self._trace_service = trace_service or TraceService(home_dir=home_dir)
        self._runtime_policy = RuntimePolicy()
        self._checkpoint = TurnCheckpoint(
            max_tool_calls_per_turn=config.max_tool_calls_per_turn,
            max_tokens_per_turn=config.max_prompt_tokens,
            max_same_tool_calls=config.max_same_tool_calls,
            no_progress_threshold=config.no_progress_threshold,
            force_answer_threshold=config.force_answer_threshold,
            reroute_threshold=config.reroute_threshold,
        )
        self._turn_context_assembler = TurnContextAssembler()
        self._instruction_contract_assembler = InstructionContractAssembler()
        self._request_shape_builder = RequestShapeBuilder()
        self._request_shape_payload_formatter = RequestShapePayloadFormatter()
        self._tool_exposure_planner = ToolExposurePlanner(tool_registry=tool_registry)
        self._contributed_tool_registry = ToolContributionRegistry()
        self._contributed_tool_providers = tuple(contributed_tool_providers)
        self._workspace_log_service = workspace_log_service or WorkspaceLogService(
            workspace_root=config.workspace_root
        )
        self._event_ledger = RuntimeEventLedger(
            session_id=config.session_id,
            session_service=self._session_service,
            trace_service=self._trace_service,
            continuation_state_provider=self._model_continuation_state,
        )
        self._assistant_conversation_recorder = AssistantConversationRecorder()
        self._approval_decisions = RuntimeApprovalDecisions(self._approval_service)
        self._capability_turn_recorder = CapabilityTurnRecorder(self._append_turn_item)
        self._planning_effects = RuntimePlanningEffects(
            session_id=config.session_id,
            planning_service=self._planning_service,
            session_service=self._session_service,
        )
        self._runtime_policy_coordinator = RuntimePolicyCoordinator(
            config=config,
            runtime_policy=self._runtime_policy,
            trace_service=self._trace_service,
            append_turn_item=self._append_turn_item,
        )
        self._response_finalizer = RuntimeResponseFinalizer(
            config=config,
            contributed_tool_registry=self._contributed_tool_registry,
            session_service=self._session_service,
            event_ledger=self._event_ledger,
            append_lifecycle_events=self._append_contributed_tool_lifecycle_events,
        )
        self._request_pipeline = RequestPipeline(
            config=config,
            instruction_contract_assembler=self._instruction_contract_assembler,
            request_shape_builder=self._request_shape_builder,
            request_shape_payload_formatter=self._request_shape_payload_formatter,
            trace_service=self._trace_service,
            workspace_log_service=self._workspace_log_service,
        )
        self._tool_orchestrator = ToolOrchestrator(
            session_id=config.session_id,
            tool_registry=tool_registry,
            tool_exposure_planner=self._tool_exposure_planner,
            contributed_tool_registry=self._contributed_tool_registry,
            contributed_tool_providers=self._contributed_tool_providers,
            trace_service=self._trace_service,
            append_turn_item=self._append_turn_item,
        )
        self._tool_execution_service = ToolExecutionService(
            session_id=config.session_id,
            context_manager=self._context_manager,
            trace_service=self._trace_service,
            append_turn_item=self._append_turn_item,
            append_lifecycle_events=self._append_contributed_tool_lifecycle_events,
            apply_tool_effects=self._apply_tool_effects,
            normalize_tool_call=self._normalize_tool_call,
            hook_manager=self._hook_manager,
            file_history=self._file_history_service,
        )
        self._model_turn_requester = ModelTurnRequester(
            model_adapter=model_adapter,
            normalize_tool_call=self._normalize_tool_call,
        )
        self._assistant_block_consumer = AssistantBlockConsumer(
            session_id=config.session_id,
            session_service=self._session_service,
            approval_service=self._approval_service,
            workspace_log_service=self._workspace_log_service,
            append_turn_item=self._append_turn_item,
            tool_call_from_block=self._tool_call_from_block,
            record_assistant_text_block=self._record_assistant_text_block,
            record_assistant_tool_calls=self._record_assistant_tool_calls,
            execute_tool_call=self._execute_tool_call,
            execute_tool_calls=self._execute_tool_calls,
            pending_decision_from_approval=self._pending_decision_from_approval,
        )
        self._model_state = RuntimeModelState(
            model_adapter=model_adapter,
            config=config,
            session_service=self._session_service,
            trace_service=self._trace_service,
            workspace_log_service=self._workspace_log_service,
        )
        self._runtime_error_logger = RuntimeErrorLogger(
            config=config,
            workspace_log_service=self._workspace_log_service,
        )
        self._runtime_context_builder = RuntimeContextBuilder(
            config=config,
            session_service=self._session_service,
            memory_service=self._memory_service,
            context_manager=self._context_manager,
            turn_context_assembler=self._turn_context_assembler,
            capability_resolver=self._capability_resolver,
            skill_registry=self._skill_registry,
            tool_registry=tool_registry,
            workspace_log_service=self._workspace_log_service,
        )
        self._recover_plan_mode_anchor()

    @classmethod
    def for_tests(
        cls,
        workspace_root: Path,
        home_dir: Path,
        model_adapter: ModelAdapter,
    ) -> AgentRuntime:
        from mycli.tools.bash import BashTool
        from mycli.tools.edit import EditTool
        from mycli.tools.grep import GrepTool
        from mycli.tools.ls import LSTool
        from mycli.tools.plan_mode import EnterPlanModeTool, ExitPlanModeTool
        from mycli.tools.plan import PlanTool
        from mycli.tools.read import ReadTool

        tool_registry = ToolRegistryV2.from_tools(
            [
                LSTool(workspace_root),
                ReadTool(workspace_root),
                GrepTool(workspace_root),
                EditTool(workspace_root),
                BashTool(workspace_root),
                PlanTool(),
                EnterPlanModeTool(workspace_root),
                ExitPlanModeTool(workspace_root),
            ]
        )
        return cls(
            model_adapter=model_adapter,
            tool_registry=tool_registry,
            config=AgentConfig(workspace_root=workspace_root),
            home_dir=home_dir,
        )

    def _set_model_log_context(self, turn_id: str) -> None:
        self._model_state.set_config(self._config)
        self._model_state.set_log_context(turn_id)

    def _recover_plan_mode_anchor(self) -> None:
        plan_mode = PlanModeService(workspace_root=self._config.workspace_root)
        existing = self._session_service.load_plan_state(self._config.session_id)
        recovered = plan_mode.recover_current_plan(existing)
        if recovered.items and not existing.items:
            self._session_service.save_plan_state(self._config.session_id, recovered)

    def _set_model_runtime_event_recorder(self, turn_id: str) -> None:
        self._model_state.set_config(self._config)
        self._model_state.set_runtime_event_recorder(turn_id)

    def _set_model_reasoning_effort(self, reasoning_effort: ReasoningEffort) -> None:
        self._model_state.set_config(self._config)
        self._model_state.set_reasoning_effort(reasoning_effort)

    def _set_model_tool_choice(self, tool_choice: str | None) -> None:
        self._model_state.set_tool_choice(tool_choice)

    def _load_model_continuation_state(self, *, turn_id: str) -> None:
        self._model_state.set_config(self._config)
        self._model_state.load_continuation_state(turn_id=turn_id)

    def _persist_model_continuation_state(self, *, turn_id: str, phase: str) -> None:
        self._model_state.set_config(self._config)
        self._model_state.persist_continuation_state(turn_id=turn_id, phase=phase)

    def _error_details(self, error_path: str | None) -> tuple[str, ...]:
        return self._runtime_error_logger.details(error_path)

    def _log_runtime_exception(
        self,
        *,
        turn_id: str,
        phase: str,
        exc: Exception,
    ) -> str:
        self._runtime_error_logger.set_config(self._config)
        return self._runtime_error_logger.log_exception(
            turn_id=turn_id,
            phase=phase,
            exc=exc,
        )

    def _select_skill_metadata(self, user_message: str) -> SkillMetadata | None:
        return self._runtime_context_builder.select_skill_metadata(user_message)

    def _load_selected_skill(self, user_message: str) -> SkillDefinition | None:
        return self._runtime_context_builder.load_selected_skill(user_message)

    def _build_context(
        self,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        runtime_reminders: tuple[str, ...] = (),
        runtime_policy_state: dict[str, object] | None = None,
        capability_activations: tuple[CapabilityActivation, ...] = (),
        tool_exposure: ToolExposure | None = None,
    ) -> ExecutionContext:
        self._runtime_context_builder.set_config(self._config)
        return self._runtime_context_builder.build_context(
            user_message=user_message,
            conversation=conversation,
            plan_state=plan_state,
            runtime_reminders=runtime_reminders,
            runtime_policy_state=runtime_policy_state,
            capability_activations=capability_activations,
            tool_exposure=tool_exposure,
        )

    def _build_runtime_items(
        self,
        *,
        request_shape: RequestShape,
    ) -> list[RuntimeItem]:
        return self._request_pipeline.runtime_items(request_shape=request_shape)

    def _build_messages(
        self,
        *,
        request_shape: RequestShape,
    ) -> list[ModelMessage]:
        return self._request_pipeline.legacy_messages(request_shape=request_shape)

    def _assemble_instruction_contract(
        self,
        *,
        turn_id: str,
        context: ExecutionContext,
        turn_context: TurnContext,
    ) -> InstructionContract:
        return self._request_pipeline.assemble_instruction_contract(
            turn_id=turn_id,
            context=context,
            turn_context=turn_context,
        )

    def _assemble_turn_context(
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
        self._runtime_context_builder.set_config(self._config)
        return self._runtime_context_builder.assemble_turn_context(
            user_message=user_message,
            conversation=conversation,
            plan_state=plan_state,
            runtime_reminders=runtime_reminders,
            runtime_policy_state=runtime_policy_state,
            capability_activations=capability_activations,
            tool_exposure=tool_exposure,
        )

    def _resolve_capability_activations(
        self,
        user_message: str,
    ) -> tuple[CapabilityActivation, ...]:
        return self._runtime_context_builder.resolve_capability_activations(user_message)

    def _runtime_contributed_tools(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        capability_activations: tuple[CapabilityActivation, ...] = (),
    ) -> tuple[object, ...]:
        return self._tool_orchestrator._runtime_contributed_tools(
            user_message=user_message,
            conversation=conversation,
            plan_state=plan_state,
            capability_activations=capability_activations,
        )

    def _plan_tool_exposure(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        capability_activations: tuple[CapabilityActivation, ...],
    ) -> PlannedToolExposure:
        runtime_contributed_tools = self._runtime_contributed_tools(
            user_message=user_message,
            conversation=conversation,
            plan_state=plan_state,
            capability_activations=capability_activations,
        )
        return self._tool_orchestrator.plan_tool_exposure(
            user_message=user_message,
            conversation=conversation,
            plan_state=plan_state,
            capability_activations=capability_activations,
            runtime_contributed_tools=runtime_contributed_tools,
        )

    def _build_tool_router(self, planned_exposure: PlannedToolExposure) -> ToolRouter:
        return self._tool_orchestrator.build_tool_router(planned_exposure)

    def _append_tool_exposure_turn_item(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        activity_events: list[ActivityEvent],
        tool_exposure: ToolExposure,
    ) -> None:
        self._tool_orchestrator.append_tool_exposure_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            activity_events=activity_events,
            tool_exposure=tool_exposure,
        )

    def _append_contributed_tool_lifecycle_events(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        activity_events: list[ActivityEvent],
        lifecycle_events: tuple[ToolContributionLifecycleEvent, ...],
    ) -> None:
        self._tool_orchestrator.append_tool_lifecycle_events(
            turn_id=turn_id,
            turn_items=turn_items,
            activity_events=activity_events,
            lifecycle_events=lifecycle_events,
        )

    def _active_skill_from_activations(
        self,
        capability_activations: tuple[CapabilityActivation, ...],
    ) -> SkillDefinition | None:
        return self._runtime_context_builder.active_skill_from_activations(
            capability_activations
        )

    def _append_capability_turn_items(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        capability_activations: tuple[CapabilityActivation, ...],
    ) -> None:
        self._capability_turn_recorder.append_capability_turn_items(
            turn_id=turn_id,
            turn_items=turn_items,
            capability_activations=capability_activations,
        )

    def _normalize_tool_call(self, call: ToolCall) -> ToolCall:
        return self._assistant_conversation_recorder.normalize_tool_call(call)

    def _tool_call_from_block(self, block: RuntimeBlock) -> ToolCall:
        return self._assistant_conversation_recorder.tool_call_from_block(block)

    def _record_assistant_text_block(
        self,
        conversation: Conversation,
        *,
        block: RuntimeBlock,
        response_id: str | None,
    ) -> None:
        self._assistant_conversation_recorder.record_text_block(
            conversation,
            block=block,
            response_id=response_id,
        )

    def _record_assistant_tool_calls(
        self,
        conversation: Conversation,
        *,
        tool_calls: tuple[ToolCall, ...],
        blocks: tuple[RuntimeBlock, ...],
        response_id: str | None = None,
    ) -> None:
        self._assistant_conversation_recorder.record_tool_calls(
            conversation,
            tool_calls=tool_calls,
            blocks=blocks,
            response_id=response_id,
        )

    def _execute_tool_call(
        self,
        *,
        conversation: Conversation,
        call: ToolCall,
        tool_router: ToolRouter,
        tool_exposure: ToolExposure,
        plan_state: PlanState,
        turn_id: str,
        activity_events: list[ActivityEvent],
        turn_items: list[TurnItem],
        provider_id: str | None = None,
        response_id: str | None = None,
        metadata: dict[str, object] | None = None,
        record_assistant_call: bool = True,
    ) -> PlanState:
        return self._tool_execution_service.execute_tool_call(
            conversation=conversation,
            call=call,
            tool_router=tool_router,
            tool_exposure=tool_exposure,
            plan_state=plan_state,
            turn_id=turn_id,
            activity_events=activity_events,
            turn_items=turn_items,
            provider_id=provider_id,
            response_id=response_id,
            metadata=metadata,
            record_assistant_call=record_assistant_call,
        )

    def _execute_tool_calls(
        self,
        *,
        conversation: Conversation,
        calls: tuple[ToolCall, ...],
        tool_router: ToolRouter,
        tool_exposure: ToolExposure,
        plan_state: PlanState,
        turn_id: str,
        activity_events: list[ActivityEvent],
        turn_items: list[TurnItem],
        provider_id: str | None = None,
        response_id: str | None = None,
        metadata: dict[str, object] | None = None,
        record_assistant_call: bool = True,
    ) -> PlanState:
        return self._tool_execution_service.execute_tool_calls(
            conversation=conversation,
            calls=calls,
            tool_router=tool_router,
            tool_exposure=tool_exposure,
            plan_state=plan_state,
            turn_id=turn_id,
            activity_events=activity_events,
            turn_items=turn_items,
            provider_id=provider_id,
            response_id=response_id,
            metadata=metadata,
            record_assistant_call=record_assistant_call,
        )

    def _render_model_tools(
        self,
        *,
        tool_exposure: ToolExposure | None,
        tool_router: ToolRouter | None,
        allow_tools: bool,
    ) -> list[ModelToolDefinition]:
        if allow_tools and tool_exposure is not None and tool_router is not None:
            return tool_router.render_for_model(tool_exposure)
        return []

    def _build_and_trace_request_shape(
        self,
        *,
        turn_id: str,
        contract: InstructionContract,
        tools: list[ModelToolDefinition],
    ) -> RequestShape:
        return self._request_pipeline.build_and_trace_request_shape(
            turn_id=turn_id,
            contract=contract,
            tools=tools,
        )

    def _trace_cache_shape_diagnostic(
        self,
        *,
        turn_id: str,
        request_shape: RequestShape,
        usage: dict[str, object] | None,
    ) -> None:
        diagnostic = self._request_pipeline.trace_cache_shape_diagnostic(
            turn_id=turn_id,
            request_shape=request_shape,
            usage=usage,
        )
        self._observability_service.metrics.record_cache_tokens(
            hit_tokens=diagnostic.cache_hit_tokens,
            miss_tokens=diagnostic.cache_miss_tokens,
        )

    def _record_budget_metric(self, *, total_tokens: int, max_tokens: int | None = None) -> None:
        self._observability_service.metrics.record_budget(
            total_tokens=total_tokens,
            max_tokens=max_tokens or self._config.max_tokens_per_turn,
        )

    def _estimate_window_budget(self, conversation: Conversation) -> ContextBudget:
        return ContextBudget.from_estimate(
            max_tokens=self._config.max_prompt_tokens,
            estimated_input_tokens=self._estimated_conversation_tokens(conversation),
        )

    def _record_compaction_metric(
        self,
        *,
        before_messages: Conversation,
        after_messages: Conversation,
    ) -> None:
        before_tokens = self._estimated_conversation_tokens(before_messages)
        after_tokens = self._estimated_conversation_tokens(after_messages)
        if before_tokens <= 0 or after_tokens == before_tokens:
            return
        level = "L4" if self._has_l4_compaction(after_messages) else "L1"
        self._observability_service.metrics.record_compaction(
            before_tokens=before_tokens,
            after_tokens=after_tokens,
            level=level,
        )

    def _record_context_window_metrics(self) -> None:
        metrics = self._compaction_pipeline.last_context_window_metrics
        if metrics is None:
            return
        self._observability_service.metrics.record_context_window(metrics.to_dict())

    def _record_ptl_metric(self, *, triggered: bool) -> None:
        self._observability_service.metrics.record_ptl_event(triggered=triggered)

    def _estimated_conversation_tokens(self, conversation: Conversation) -> int:
        return sum(
            self._token_counter.count_message(message)
            for message in conversation.messages
        )

    @staticmethod
    def _has_l4_compaction(conversation: Conversation) -> bool:
        return any(message.metadata.get("compaction") is True for message in conversation.messages)

    def _request_model_turn(
        self,
        *,
        runtime_items: list[RuntimeItem],
        legacy_messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
    ) -> tuple[ModelTurnResult, tuple[str, ...]]:
        return self._model_turn_requester.request_model_turn(
            runtime_items=runtime_items,
            legacy_messages=legacy_messages,
            tools=tools,
        )

    def _consume_assistant_blocks(
        self,
        *,
        turn_result: ModelTurnResult,
        conversation: Conversation,
        tool_router: ToolRouter,
        tool_exposure: ToolExposure,
        plan_state: PlanState,
        turn_id: str,
        user_message: str,
        progress_updates: list[str],
        activity_events: list[ActivityEvent],
        streamed_chunks: list[str],
        turn_items: list[TurnItem],
    ) -> tuple[
        PlanState,
        bool,
        list[str],
        tuple[TurnResponse, TurnStatus, StopReason] | None,
    ]:
        return self._assistant_block_consumer.consume_assistant_blocks(
            turn_result=turn_result,
            conversation=conversation,
            tool_router=tool_router,
            tool_exposure=tool_exposure,
            plan_state=plan_state,
            turn_id=turn_id,
            user_message=user_message,
            progress_updates=progress_updates,
            activity_events=activity_events,
            streamed_chunks=streamed_chunks,
            turn_items=turn_items,
        )

    def _append_turn_item(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        item: TurnItem,
    ) -> None:
        self._event_ledger.append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=item,
        )

    def _timestamp(self) -> str:
        return self._event_ledger.timestamp()

    def _persist_turn_record(
        self,
        *,
        turn_id: str,
        user_message: str,
        started_at: str,
        status: TurnStatus,
        stop_reason: StopReason | None,
        turn_items: list[TurnItem],
    ) -> TurnRecord:
        return self._response_finalizer.persist_turn_record(
            turn_id=turn_id,
            user_message=user_message,
            started_at=started_at,
            status=status,
            stop_reason=stop_reason,
            turn_items=turn_items,
        )

    def _context_baseline_from_contract(
        self,
        contract: InstructionContract | None,
    ) -> ContextBaseline | None:
        return self._event_ledger.context_baseline_from_contract(contract)

    def _model_continuation_state(self) -> object | None:
        getter = getattr(self._model_adapter, "get_continuation_state", None)
        if not callable(getter):
            return None
        state: object | None = getter()
        return state

    def _persist_structured_runtime_state(
        self,
        *,
        turn: TurnRecord,
        started_at: str,
        context_baseline: ContextBaseline | None,
    ) -> None:
        self._response_finalizer.persist_structured_runtime_state(
            turn=turn,
            started_at=started_at,
            context_baseline=context_baseline,
        )

    def _finalize_response(
        self,
        *,
        response: TurnResponse,
        turn_id: str,
        user_message: str,
        started_at: str,
        status: TurnStatus,
        stop_reason: StopReason | None,
        turn_items: list[TurnItem],
        context_baseline: ContextBaseline | None = None,
    ) -> TurnResponse:
        self._response_finalizer.set_config(self._config)
        return self._response_finalizer.finalize_response(
            response=response,
            turn_id=turn_id,
            user_message=user_message,
            started_at=started_at,
            status=status,
            stop_reason=stop_reason,
            turn_items=turn_items,
            context_baseline=context_baseline,
        )

    def _policy_decision(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        step_index: int,
    ) -> tuple[ReasoningEffort, tuple[str, ...], dict[str, object], bool, str | None, TurnResponse | None]:
        self._runtime_policy_coordinator.set_config(self._config)
        return self._runtime_policy_coordinator.policy_decision(
            user_message=user_message,
            conversation=conversation,
            plan_state=plan_state,
            step_index=step_index,
        )

    def _append_runtime_policy_activity(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        activity_events: list[ActivityEvent],
        policy_state: dict[str, object],
    ) -> None:
        self._runtime_policy_coordinator.set_config(self._config)
        self._runtime_policy_coordinator.append_runtime_policy_activity(
            turn_id=turn_id,
            turn_items=turn_items,
            activity_events=activity_events,
            policy_state=policy_state,
        )

    def _append_structured_repo_activity(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        activity_events: list[ActivityEvent],
        stage_message: str | None,
    ) -> None:
        self._runtime_policy_coordinator.append_structured_repo_activity(
            turn_id=turn_id,
            turn_items=turn_items,
            activity_events=activity_events,
            stage_message=stage_message,
        )

    def _save_runtime_state(
        self,
        *,
        conversation: Conversation,
        plan_state: PlanState,
    ) -> None:
        self._session_service.save_conversation(conversation)
        self._session_service.save_plan_state(self._config.session_id, plan_state)

    def _apply_tool_effects(
        self,
        *,
        call: ToolCall,
        result_summary: str,
        result_payload: dict[str, object],
        plan_state: PlanState,
    ) -> PlanState:
        return self._planning_effects.apply_tool_effects(
            call=call,
            result_payload=result_payload,
            plan_state=plan_state,
        )

    def _complete_task_if_active(
        self,
        plan_state: PlanState,
        item_id: str | None,
    ) -> PlanState:
        return self._planning_effects.complete_task_if_active(plan_state, item_id)

    def _pending_decision_from_approval(
        self,
        approval: PendingApproval,
    ) -> PendingDecision:
        return self._approval_decisions.pending_decision_from_approval(approval)

    def _format_allowed_choices(self, options: tuple[DecisionAction, ...]) -> str:
        return self._approval_decisions.format_allowed_choices(options)

    def rebind_session(self, config: AgentConfig) -> None:
        self._config = config
        session_id = config.session_id
        self._model_state.set_config(config)
        self._runtime_context_builder.set_config(config)
        self._request_pipeline.set_config(config)
        self._runtime_error_logger.set_config(config)
        self._runtime_policy_coordinator.set_config(config)
        self._response_finalizer.set_config(config)
        self._tool_execution_service._session_id = session_id
        self._tool_orchestrator._session_id = session_id
        self._event_ledger._session_id = session_id
        self._assistant_block_consumer.set_session_id(session_id)
        self._planning_effects.set_session_id(session_id)

    def handle_user_turn(self, user_message: str) -> TurnResponse:
        from mycli.application.runtime.turn_executor import TurnExecutor

        return TurnExecutor(self).execute_user_turn(user_message)

    def resolve_pending_approval(self, choice: str) -> TurnResponse:
        from mycli.application.runtime.turn_executor import TurnExecutor

        return TurnExecutor(self).resolve_pending_approval(choice)
