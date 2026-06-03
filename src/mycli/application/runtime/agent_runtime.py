from __future__ import annotations

from collections.abc import Callable
import os
from pathlib import Path
from threading import Lock
import time

from mycli.domain.conversation import Conversation, Message, Role
from mycli.domain.tooling.contributed_tools import (
    ToolContributionLifecycleEvent,
    ToolContributionRegistration,
)
from mycli.domain.runtime import (
    ActivityEvent,
    AgentConfig,
    CompactionRehydrationContext,
    ContextBaseline,
    DecisionAction,
    ExecutionContext,
    FileRehydrationCandidate,
    InstructionContract,
    ModelTurnResult,
    PendingApproval,
    PendingClarification,
    PendingDecision,
    PlanState,
    RuntimeBlock,
    RuntimeItem,
    RuntimeRole,
    RuntimeStreamEvent,
    RuntimeTraceEvent,
    RequestShape,
    ReasoningEffort,
    RehydrationBudget,
    StopReason,
    TurnContext,
    TurnItem,
    TurnItemType,
    TurnRecord,
    TurnResponse,
    TurnStatus,
    stable_hash,
)
from mycli.domain.logging import LogLevel
from mycli.domain.subagents import SubAgentRunSummary
from mycli.domain.tooling.exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.llms.adapters.base import ModelAdapter, ModelMessage, ModelToolDefinition
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore
from mycli.services.approval.approval_service import ApprovalService
from mycli.services.approval.safety_policy import SafetyPolicy
from mycli.services.context.context_manager import ContextManager
from mycli.services.context.compaction import (
    CompactionRehydrationService,
    CompactionCostProfile,
    ContextBudget,
    CompactionPipeline,
    ContextWindowAnalyzer,
    FullContextSnapshot,
    LLMSummarization,
    ToolResultBudget,
)
from mycli.services.context.token_counter import TokenCounter
from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.services.file_history import FileHistoryService
from mycli.services.hooks.allowlist import HookAllowlist
from mycli.services.hooks import (
    HookConfigDiscovery,
    HookContext,
    HookManager,
    HookPoint,
    register_configured_hooks,
)
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
from mycli.services.extensions import ExtensionManifestService
from mycli.services.subagents import SubAgentProfileRegistry, SubAgentToolContributionProvider
from mycli.services.plugins import PluginCommandRegistry, load_enabled_plugins
from mycli.tools.routing.tool_exposure_planner import PlannedToolExposure, ToolExposurePlanner
from mycli.tools.routing.tool_router import ToolRouter
from mycli.services.tracing import TraceService
from mycli.services.write_diagnostics import WriteDiagnosticsService
from mycli.services.turn_guard import TurnCheckpoint
from mycli.utils.workspace_logger import WorkspaceLogService
from mycli.tools.registry import ToolRegistry
from mycli.tools.skill import SkillTool
from mycli.application.runtime.context import RuntimeContextBuilder
from mycli.application.runtime.approval_decisions import RuntimeApprovalDecisions
from mycli.application.runtime.ledger import RuntimeEventLedger
from mycli.application.runtime.model import (
    AssistantConversationRecorder,
    AssistantBlockConsumer,
    ModelStreamDiagnostics,
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
from mycli.application.runtime.subagents.loop import (
    RuntimeChildToolExecutor,
    RuntimeChildTurnRequester,
    SubAgentChildLoop,
)
from mycli.application.runtime.subagents.service import SubAgentService
from mycli.application.runtime.tools import ToolExecutionService, ToolOrchestrator
from mycli.tools.task import TaskTool


class _SummarizerClientAdapter:
    """Adapt the normal model requester into the L4 summarizer protocol."""

    def __init__(
        self,
        requester: ModelTurnRequester,
        *,
        set_model: Callable[[str], None] | None = None,
        restore_model: Callable[[], None] | None = None,
        set_max_output_tokens: Callable[[int], None] | None = None,
        restore_max_output_tokens: Callable[[], None] | None = None,
        disable_thinking: Callable[[], None] | None = None,
        restore_thinking: Callable[[], None] | None = None,
    ) -> None:
        self._requester = requester
        self._set_model = set_model
        self._restore_model = restore_model
        self._set_max_output_tokens = set_max_output_tokens
        self._restore_max_output_tokens = restore_max_output_tokens
        self._disable_thinking = disable_thinking
        self._restore_thinking = restore_thinking

    def complete(
        self,
        *,
        messages: list[dict[str, str]],
        model: str,
        max_tokens: int,
    ) -> str:
        legacy_messages = [
            ModelMessage(
                role=message["role"],
                content=message["content"],
            )
            for message in messages
        ]
        runtime_items = [
            RuntimeItem(
                role=_runtime_role(message["role"]),
                blocks=(RuntimeBlock(type="text", text=message["content"]),),
            )
            for message in messages
        ]
        if self._set_model is not None:
            self._set_model(model)
        if self._set_max_output_tokens is not None:
            self._set_max_output_tokens(max_tokens)
        if self._disable_thinking is not None:
            self._disable_thinking()
        try:
            turn_result, _ = self._requester.request_model_turn(
                runtime_items=runtime_items,
                legacy_messages=legacy_messages,
                tools=[],
            )
        finally:
            if self._restore_thinking is not None:
                self._restore_thinking()
            if self._restore_max_output_tokens is not None:
                self._restore_max_output_tokens()
            if self._restore_model is not None:
                self._restore_model()
        content = "\n".join(
            block.text or ""
            for item in turn_result.items
            for block in item.blocks
            if block.type == "text" and block.text
        ).strip()
        return content


def _runtime_role(role: str) -> RuntimeRole:
    if role == "developer":
        return "developer"
    if role == "user":
        return "user"
    if role == "assistant":
        return "assistant"
    if role == "tool":
        return "tool"
    return "system"


class AgentRuntime:
    def __init__(
        self,
        *,
        model_adapter: ModelAdapter,
        tool_registry: ToolRegistry,
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
        self._home_dir = home_dir
        self._recovery_sleep = time.sleep
        self._monotonic = time.monotonic
        self._approval_service = approval_service or ApprovalService(
            safety_policy=SafetyPolicy(
                workspace_root=config.workspace_root,
                auto_approve_medium=config.auto_approve_medium,
            )
        )
        self._tool_result_formatter = ToolResultFormatter()
        self._token_counter = TokenCounter()
        self._observability_service = observability_service or ObservabilityService()
        self._hook_manager = HookManager()
        self._hook_manager.register(HookPoint.PRE_TOOL_USE, permission_guard)
        self._hook_config_discovery = HookConfigDiscovery(hooks=(), issues=())
        self._plugin_command_registry = PluginCommandRegistry()
        self._model_turn_requester = ModelTurnRequester(
            model_adapter=model_adapter,
            normalize_tool_call=self._normalize_tool_call,
            stream_diagnostics_sink=self._record_model_stream_diagnostics,
        )
        llm_summarization = LLMSummarization(
            summarizer_client=_SummarizerClientAdapter(
                self._model_turn_requester,
                set_model=self._set_model,
                restore_model=self._restore_model,
                set_max_output_tokens=self._set_model_max_output_tokens,
                restore_max_output_tokens=self._restore_model_max_output_tokens,
                disable_thinking=self._disable_model_thinking,
                restore_thinking=self._restore_model_thinking,
            ),
        )
        self._configure_l4_summarization(llm_summarization, config)
        self._compaction_pipeline = CompactionPipeline(
            tool_result_budget=ToolResultBudget(self._tool_result_formatter),
            context_window_analyzer=ContextWindowAnalyzer(
                dedup_trigger_ratio=0.4,
                eviction_trigger_ratio=0.7,
                keep_recent_tool_results=8,
            ),
            llm_summarization=llm_summarization,
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
            repo_root=config.workspace_root / ".mycli" / "skills",
        )
        self._tool_registry.register(SkillTool(self._skill_registry))
        self._trace_service = trace_service or TraceService(home_dir=home_dir)
        self._hook_config_discovery = register_configured_hooks(
            manager=self._hook_manager,
            workspace_root=config.workspace_root,
            home_dir=home_dir,
            trace_service=self._trace_service,
            session_id=config.session_id,
            monotonic_provider=self._monotonic,
        )
        self._plugin_runtime_state = load_enabled_plugins(
            workspace_root=config.workspace_root,
            home_dir=home_dir,
            hook_manager=self._hook_manager,
            tool_registry=self._tool_registry,
            command_registry=self._plugin_command_registry,
            env=dict(os.environ),
        )
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
        self._tool_exposure_planner = ToolExposurePlanner(tool_registry=self._tool_registry)
        self._contributed_tool_registry = ToolContributionRegistry()
        self._contributed_tool_providers = tuple(contributed_tool_providers)
        self._workspace_log_service = workspace_log_service or WorkspaceLogService(
            workspace_root=config.workspace_root
        )
        self._workspace_log_service.set_session_id(config.session_id)
        self._event_ledger = RuntimeEventLedger(
            session_id=config.session_id,
            session_service=self._session_service,
            trace_service=self._trace_service,
            continuation_state_provider=self._model_continuation_state,
        )
        self._assistant_conversation_recorder = AssistantConversationRecorder()
        self._approval_decisions = RuntimeApprovalDecisions(self._approval_service)
        self._planning_effects = RuntimePlanningEffects(
            session_id=config.session_id,
            planning_service=self._planning_service,
            session_service=self._session_service,
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
            tool_registry=self._tool_registry,
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
            record_invoked_skill=lambda snapshot: self._session_service.record_invoked_skill_snapshot(
                self._config.session_id,
                snapshot,
            ),
            write_diagnostics_runner=WriteDiagnosticsService(
                workspace_root=config.workspace_root,
            ).run,
        )
        child_executor = RuntimeChildToolExecutor(
            tool_router=ToolRouter(tool_registry=self._tool_registry),
            tool_specs=dict(self._tool_registry.specs or {}),
        )
        self._sub_agent_model_request_lock = Lock()
        child_requester = RuntimeChildTurnRequester(
            requester=self._model_turn_requester,
            tool_exposure_builder=self._child_tool_exposure,
            tool_renderer=lambda exposure: self._render_model_tools(
                tool_exposure=exposure,
                tool_router=ToolRouter(tool_registry=self._tool_registry),
                allow_tools=True,
            ),
            model_request_lock=self._sub_agent_model_request_lock,
        )
        self._sub_agent_child_loop = SubAgentChildLoop(
            requester=child_requester,
            executor=child_executor,
        )
        self._sub_agent_service = SubAgentService(
            session_id=config.session_id,
            turn_id_provider=lambda: getattr(self, "_current_turn_id", "turn_unknown"),
            parent_tool_names=lambda: tuple(self._tool_registry.list_names()),
            child_loop=self._sub_agent_child_loop,
            profile_lookup=SubAgentProfileRegistry(
                workspace_root=config.workspace_root,
                home_dir=home_dir,
            ).get_profile,
            session_service=self._session_service,
        )
        self._tool_registry.register(TaskTool(service=self._sub_agent_service))
        self._contributed_tool_providers = (
            *self._contributed_tool_providers,
            SubAgentToolContributionProvider(
                service=self._sub_agent_service,
                list_profiles=SubAgentProfileRegistry(
                    workspace_root=config.workspace_root,
                    home_dir=home_dir,
                ).list_profiles,
            ),
        )
        self._tool_orchestrator = ToolOrchestrator(
            session_id=config.session_id,
            tool_registry=self._tool_registry,
            tool_exposure_planner=self._tool_exposure_planner,
            contributed_tool_registry=self._contributed_tool_registry,
            contributed_tool_providers=self._contributed_tool_providers,
            trace_service=self._trace_service,
            append_turn_item=self._append_turn_item,
        )
        self._assistant_block_consumer = AssistantBlockConsumer(
            session_id=config.session_id,
            session_service=self._session_service,
            approval_service=self._approval_service,
            trace_service=self._trace_service,
            workspace_log_service=self._workspace_log_service,
            append_turn_item=self._append_turn_item,
            tool_call_from_block=self._tool_call_from_block,
            record_assistant_text_block=self._record_assistant_text_block,
            record_assistant_tool_calls=self._record_assistant_tool_calls,
            execute_tool_call=self._execute_tool_call,
            execute_tool_call_for_clarification=self._execute_tool_call_for_clarification,
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
            skill_registry=self._skill_registry,
            tool_registry=self._tool_registry,
            workspace_log_service=self._workspace_log_service,
        )
        self._recover_plan_mode_anchor()
        self._closed = False
        self._execute_session_hook(HookPoint.SESSION_START)

    @classmethod
    def for_tests(
        cls,
        workspace_root: Path,
        home_dir: Path,
        model_adapter: ModelAdapter,
        workspace_log_service: WorkspaceLogService | None = None,
    ) -> AgentRuntime:
        from mycli.tools.bash import BashTool
        from mycli.tools.edit import EditTool
        from mycli.tools.file_snapshot import FileSnapshotStore
        from mycli.tools.grep import GrepTool
        from mycli.tools.ls import LSTool
        from mycli.tools.plan_mode import EnterPlanModeTool, ExitPlanModeTool
        from mycli.tools.plan import PlanTool
        from mycli.tools.read import ReadTool

        snapshot_store = FileSnapshotStore()
        tool_registry = ToolRegistry.from_tools(
            [
                LSTool(workspace_root),
                ReadTool(workspace_root, snapshot_store=snapshot_store),
                GrepTool(workspace_root),
                EditTool(workspace_root, snapshot_store=snapshot_store),
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
            workspace_log_service=workspace_log_service,
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

    def _configure_l4_summarization(
        self,
        summarization: LLMSummarization,
        config: AgentConfig,
    ) -> None:
        summarization._trigger_ratio = config.compaction_l4_trigger_ratio
        summarization._buffer_tokens = config.compaction_l4_buffer_tokens
        summarization._model_name = config.model
        summarization._trigger_ratios_by_model = dict(
            config.compaction_l4_trigger_ratios_by_model
        )
        summarization._cost_profile = CompactionCostProfile(
            input_cost_per_1k=config.compaction_l4_input_cost_per_1k,
            output_cost_per_1k=config.compaction_l4_output_cost_per_1k,
            carry_cost_per_1k=config.compaction_l4_carry_cost_per_1k,
            expected_summary_tokens=config.compaction_l4_expected_summary_tokens,
            min_savings_ratio=config.compaction_l4_min_savings_ratio,
            carry_turns=config.compaction_l4_carry_turns,
        )
        summarization._summarizer_model_name = (
            config.compaction_l4_summarizer_model or config.model
        )

    def _set_model(self, model: str) -> None:
        setter = getattr(self._model_adapter, "set_model", None)
        if callable(setter):
            setter(model)

    def _restore_model(self) -> None:
        self._set_model(self._config.model)

    def _set_model_max_output_tokens(self, max_output_tokens: int) -> None:
        setter = getattr(self._model_adapter, "set_max_output_tokens", None)
        if callable(setter):
            setter(max_output_tokens)

    def _restore_model_max_output_tokens(self) -> None:
        self._set_model_max_output_tokens(self._config.max_output_tokens)

    def _disable_model_thinking(self) -> None:
        setter = getattr(self._model_adapter, "set_thinking_config", None)
        if callable(setter):
            setter(enabled=False, effort=None)
            return
        reasoning_setter = getattr(self._model_adapter, "set_reasoning_effort", None)
        if callable(reasoning_setter):
            reasoning_setter(None)

    def _restore_model_thinking(self) -> None:
        self._model_state.set_config(self._config)
        self._model_state.set_reasoning_effort(self._config.reasoning_effort)

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

    def _build_context(
        self,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        runtime_reminders: tuple[str, ...] = (),
        compaction_rehydration: CompactionRehydrationContext | None = None,
        tool_exposure: ToolExposure | None = None,
    ) -> ExecutionContext:
        self._runtime_context_builder.set_config(self._config)
        return self._runtime_context_builder.build_context(
            user_message=user_message,
            conversation=conversation,
            plan_state=plan_state,
            runtime_reminders=runtime_reminders,
            compaction_rehydration=compaction_rehydration,
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
        compaction_rehydration: CompactionRehydrationContext | None = None,
        tool_exposure: ToolExposure | None = None,
    ) -> tuple[ExecutionContext, TurnContext]:
        self._runtime_context_builder.set_config(self._config)
        return self._runtime_context_builder.assemble_turn_context(
            user_message=user_message,
            conversation=conversation,
            plan_state=plan_state,
            runtime_reminders=runtime_reminders,
            compaction_rehydration=compaction_rehydration,
            tool_exposure=tool_exposure,
        )

    def _runtime_contributed_tools(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
    ) -> tuple[object, ...]:
        return self._tool_orchestrator._runtime_contributed_tools(
            user_message=user_message,
            conversation=conversation,
            plan_state=plan_state,
        )

    def _plan_tool_exposure(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
    ) -> PlannedToolExposure:
        runtime_contributed_tools = self._runtime_contributed_tools(
            user_message=user_message,
            conversation=conversation,
            plan_state=plan_state,
        )
        return self._tool_orchestrator.plan_tool_exposure(
            user_message=user_message,
            conversation=conversation,
            plan_state=plan_state,
            runtime_contributed_tools=runtime_contributed_tools,
        )

    def _build_tool_router(self, planned_exposure: PlannedToolExposure) -> ToolRouter:
        return self._tool_orchestrator.build_tool_router(planned_exposure)

    def _child_tool_exposure(self, tool_names: tuple[str, ...]) -> ToolExposure:
        specs = self._tool_registry.specs or {}
        return ToolExposure(
            entries=tuple(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local(name),
                    source=ToolRouteSource.REGISTRY,
                    spec=specs[name],
                )
                for name in tool_names
                if name in specs
            )
        )

    def _set_current_turn_id(self, turn_id: str) -> None:
        self._current_turn_id = turn_id

    def recent_subagents(self) -> tuple[SubAgentRunSummary, ...]:
        return self._sub_agent_service.recent_runs()

    def inspect_subagent_transcript(self, child_session_id: str) -> tuple[str, ...]:
        return self._sub_agent_service.inspect_transcript(child_session_id)

    def inspect_hooks(self) -> tuple[str, ...]:
        lines = [snapshot.safe_line() for snapshot in self._hook_manager.snapshot()]
        allowlist = HookAllowlist(home_dir=self._home_dir)
        for spec in self._hook_config_discovery.hooks:
            lines.append(allowlist.status_for(spec).safe_line(spec))
        for config_issue in self._hook_config_discovery.issues:
            lines.append(f"config_issue {config_issue.safe_line()}")
        for allowlist_issue in allowlist.issues:
            lines.append(f"allowlist_issue {allowlist_issue}")
        for loaded in self._plugin_runtime_state.loaded:
            if loaded.registered_hooks:
                lines.extend(
                    f"plugin_hook {loaded.plugin_id} {hook}" for hook in loaded.registered_hooks
                )
            for issue in loaded.issues:
                lines.append(f"plugin_issue {issue.safe_line()}")
        return tuple(lines) or ("no hooks registered",)

    def inspect_plugin_commands(self) -> tuple[str, ...]:
        lines = [
            (
                f"{entry['id']} plugin={entry['plugin_id']} "
                f"name={entry['name']} kind={entry['kind']}"
            )
            for entry in self._plugin_command_registry.list_entries()
        ]
        lines.extend(f"plugin_command_issue {issue}" for issue in self._plugin_command_registry.issues())
        return tuple(lines) or ("no plugin commands registered",)

    def run_plugin_command(
        self,
        plugin_id: str,
        command_name: str,
        arguments: dict[str, object],
    ) -> dict[str, object]:
        return self._plugin_command_registry.execute(
            plugin_id,
            command_name,
            dict(arguments),
        ).to_dict()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._execute_session_hook(HookPoint.SESSION_END)

    def _execute_session_hook(self, hook_point: HookPoint) -> None:
        self._hook_manager.execute_with_summary(
            hook_point,
            HookContext(
                hook_point=hook_point,
                session_id=self._config.session_id,
                metadata={"turn_id": hook_point.value},
            ),
        )

    def extension_manifest(self) -> dict[str, object]:
        contributed_tools = tuple(
            item
            for item in self._runtime_contributed_tools(
                user_message="",
                conversation=Conversation(session_id=self._config.session_id),
                plan_state=self._session_service.load_plan_state(self._config.session_id),
            )
            if isinstance(item, ToolContributionRegistration)
        )
        return ExtensionManifestService(
            tool_registry=self._tool_registry,
            contributed_tools=contributed_tools,
        ).manifest()

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
        lifecycle_sink: Callable[[RuntimeStreamEvent], None] | None = None,
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
            lifecycle_sink=lifecycle_sink,
        )

    def _execute_tool_call_for_clarification(
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
        lifecycle_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> tuple[PlanState, PendingClarification | None]:
        return self._tool_execution_service.execute_tool_call_for_clarification(
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
            lifecycle_sink=lifecycle_sink,
        )

    def _record_clarification_response_tool_result(
        self,
        conversation: Conversation,
        *,
        call: ToolCall,
        response: str,
    ) -> None:
        self._tool_execution_service.record_clarification_response(
            conversation,
            call=call,
            response=response,
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
        lifecycle_sink: Callable[[RuntimeStreamEvent], None] | None = None,
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
            lifecycle_sink=lifecycle_sink,
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

    def _record_provider_input_budget_metric(
        self,
        *,
        usage: dict[str, object] | None,
        fallback_total_tokens: int,
        max_tokens: int | None = None,
    ) -> None:
        budget = ContextBudget(
            max_tokens=max_tokens or self._config.max_prompt_tokens,
            total_tokens=self._provider_input_tokens(usage) or fallback_total_tokens,
        )
        self._record_budget_metric(
            total_tokens=budget.total_tokens,
            max_tokens=budget.max_tokens,
        )

    def _provider_input_budget_payload(
        self,
        *,
        usage: dict[str, object] | None,
        fallback_total_tokens: int,
        max_tokens: int,
    ) -> dict[str, object]:
        input_tokens = self._provider_input_tokens(usage)
        output_tokens = self._provider_output_tokens(usage)
        total_tokens = self._usage_int(usage, "total_tokens") or input_tokens + output_tokens
        cache_read_tokens = self._cache_read_tokens(usage)
        cache_write_tokens = self._cache_write_tokens(usage)
        source = "provider" if input_tokens > 0 else "estimate"
        max_tokens = max(0, max_tokens)
        budget_input_tokens = input_tokens or max(0, fallback_total_tokens)
        usage_ratio = budget_input_tokens / max_tokens if max_tokens > 0 else 0.0
        payload: dict[str, object] = {
            "input_tokens": input_tokens,
            "budget_input_tokens": budget_input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens or input_tokens + output_tokens,
            "cache_read_tokens": cache_read_tokens,
            "cache_write_tokens": cache_write_tokens,
            "max_tokens": max_tokens,
            "usage_ratio": usage_ratio,
            "source": source,
        }
        if usage is not None:
            payload["provider_usage"] = dict(usage)
        return payload

    @staticmethod
    def _provider_input_tokens(usage: dict[str, object] | None) -> int:
        if usage is None:
            return 0
        for key in ("input_tokens", "prompt_tokens"):
            value = usage.get(key)
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)) and value > 0:
                return int(value)
        return 0

    @classmethod
    def _provider_output_tokens(cls, usage: dict[str, object] | None) -> int:
        return cls._usage_int(usage, "output_tokens") or cls._usage_int(usage, "completion_tokens")

    @staticmethod
    def _usage_int(usage: dict[str, object] | None, key: str) -> int:
        if usage is None:
            return 0
        value = usage.get(key)
        if isinstance(value, bool):
            return 0
        if isinstance(value, (int, float)) and value > 0:
            return int(value)
        return 0

    @classmethod
    def _cache_read_tokens(cls, usage: dict[str, object] | None) -> int:
        direct = cls._usage_int(usage, "cache_read_tokens")
        if direct > 0:
            return direct
        direct = cls._usage_int(usage, "prompt_cache_hit_tokens")
        if direct > 0:
            return direct
        if usage is None:
            return 0
        for detail_key in ("input_tokens_details", "prompt_tokens_details"):
            details = usage.get(detail_key)
            if not isinstance(details, dict):
                continue
            cached_tokens = details.get("cached_tokens")
            if isinstance(cached_tokens, bool):
                continue
            if isinstance(cached_tokens, (int, float)) and cached_tokens > 0:
                return int(cached_tokens)
        return 0

    @classmethod
    def _cache_write_tokens(cls, usage: dict[str, object] | None) -> int:
        direct = cls._usage_int(usage, "cache_write_tokens")
        if direct > 0:
            return direct
        return cls._usage_int(usage, "prompt_cache_creation_tokens")

    def _restore_provider_input_budget_metric(self, session_id: str) -> None:
        for rollout in reversed(self._session_service.load_turn_rollouts(session_id)):
            for event in reversed(rollout.events):
                if event.kind != "turn_item":
                    continue
                payload = event.payload
                if payload.get("type") != TurnItemType.MODEL_USAGE.value:
                    continue
                metadata = payload.get("metadata")
                if not isinstance(metadata, dict):
                    continue
                input_tokens = metadata.get("input_tokens")
                budget_input_tokens = metadata.get("budget_input_tokens")
                max_tokens = metadata.get("max_tokens")
                restored_tokens = 0
                if (
                    isinstance(input_tokens, (int, float))
                    and not isinstance(input_tokens, bool)
                    and input_tokens > 0
                ):
                    restored_tokens = int(input_tokens)
                elif (
                    isinstance(budget_input_tokens, (int, float))
                    and not isinstance(budget_input_tokens, bool)
                    and budget_input_tokens > 0
                ):
                    restored_tokens = int(budget_input_tokens)
                if (
                    restored_tokens > 0
                    and isinstance(max_tokens, (int, float))
                    and not isinstance(max_tokens, bool)
                    and max_tokens > 0
                ):
                    self._record_budget_metric(
                        total_tokens=restored_tokens,
                        max_tokens=int(max_tokens),
                    )
                    return

    def _estimate_window_budget(self, conversation: Conversation) -> ContextBudget:
        return ContextBudget.from_estimate(
            max_tokens=self._config.max_prompt_tokens,
            estimated_input_tokens=self._estimated_conversation_tokens(conversation),
        )

    def _estimate_request_window_budget(self, request_shape: RequestShape) -> ContextBudget:
        return ContextBudget.from_estimate(
            max_tokens=self._config.max_prompt_tokens,
            estimated_input_tokens=self._estimated_request_shape_tokens(request_shape),
        )

    def _full_context_snapshot(self, request_shape: RequestShape) -> FullContextSnapshot:
        messages: list[Message] = []
        for fragment in request_shape.fragments:
            messages.append(
                Message(
                    role="system",
                    content=f"{fragment.id}:\n{fragment.content}",
                )
            )
        for message in request_shape.provider_messages:
            messages.append(
                Message(
                    role=self._snapshot_role(message.role),
                    content=message.content,
                )
            )
        for item in request_shape.provider_runtime_items:
            content = "\n".join(
                block.text or ""
                for block in item.blocks
                if isinstance(block.text, str) and block.text
            )
            if content:
                messages.append(
                    Message(
                        role=self._snapshot_role(str(item.role)),
                        content=content,
                    )
                )
        return FullContextSnapshot(messages=tuple(messages))

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

    def _record_l4_decision_metric(
        self,
        cost_metrics: dict[str, int | float | str | list[str]] | None,
    ) -> None:
        if cost_metrics is None:
            return
        decision = cost_metrics.get("decision")
        if not isinstance(decision, str) or not decision:
            return
        source = cost_metrics.get("source")
        self._observability_service.metrics.record_l4_decision(
            decision=decision,
            source=source if isinstance(source, str) else None,
        )

    def _persist_compaction_summaries(
        self,
        *,
        turn_id: str,
        conversation: Conversation,
    ) -> None:
        existing = {
            stable_hash(summary)
            for summary in self._memory_service.load_session_summaries(
                self._config.session_id
            )
        }
        persisted = 0
        skipped = 0
        for message in conversation.messages:
            if message.role != "assistant" or not message.metadata.get("compaction"):
                continue
            summary = message.content.strip()
            if not summary:
                continue
            digest = stable_hash(summary)
            if digest in existing:
                skipped += 1
                continue
            self._memory_service.append_session_summary(self._config.session_id, summary)
            existing.add(digest)
            persisted += 1
        self._trace_service.append(
            self._config.session_id,
            RuntimeTraceEvent(
                kind="context_summary_persistence",
                turn_id=turn_id,
                payload={
                    "persisted_count": persisted,
                    "duplicate_skipped_count": skipped,
                    "session_summary_count": len(existing),
                },
            ),
        )

    def _build_compaction_rehydration_context(
        self,
        *,
        cost_metrics: dict[str, int | float | str | list[str]] | None,
        conversation_tail: tuple[Message, ...],
    ) -> CompactionRehydrationContext:
        raw_files = [] if cost_metrics is None else cost_metrics.get("recent_files")
        service = CompactionRehydrationService(
            workspace_root=self._config.workspace_root,
            token_counter=self._token_counter,
            file_budget=RehydrationBudget(
                max_total_tokens=self._config.compaction_rehydration_file_max_total_tokens,
                max_item_tokens=self._config.compaction_rehydration_file_max_item_tokens,
            ),
            skill_budget=RehydrationBudget(
                max_total_tokens=self._config.compaction_rehydration_skill_max_total_tokens,
                max_item_tokens=self._config.compaction_rehydration_skill_max_item_tokens,
            ),
            max_files=self._config.compaction_rehydration_max_files,
            max_skills=self._config.compaction_rehydration_max_skills,
        )
        return service.build(
            file_candidates=self._file_rehydration_candidates(raw_files),
            invoked_skills=self._session_service.load_invoked_skill_snapshots(
                self._config.session_id
            ),
            tail_messages=conversation_tail,
        )

    def _file_rehydration_candidates(
        self,
        raw_files: object,
    ) -> tuple[FileRehydrationCandidate, ...]:
        if not isinstance(raw_files, list):
            return ()
        candidates: list[FileRehydrationCandidate] = []
        for index, raw_path in enumerate(raw_files):
            if isinstance(raw_path, str) and raw_path.strip():
                candidates.append(
                    FileRehydrationCandidate(
                        path=raw_path.strip(),
                        tool_name="Read",
                        sequence=index,
                    )
                )
        return tuple(candidates)

    def _record_ptl_metric(self, *, triggered: bool) -> None:
        self._observability_service.metrics.record_ptl_event(triggered=triggered)

    def _estimated_conversation_tokens(self, conversation: Conversation) -> int:
        return sum(
            self._token_counter.count_message(message)
            for message in conversation.messages
        )

    def _estimated_request_shape_tokens(self, request_shape: RequestShape) -> int:
        seen: set[str] = set()
        total = 0
        for fragment in request_shape.fragments:
            content = fragment.content.strip()
            if not content or content in seen:
                continue
            seen.add(content)
            total += self._token_counter.count(content)
        for message in request_shape.provider_messages:
            content = f"{message.role}: {message.content}".strip()
            if not content or content in seen:
                continue
            seen.add(content)
            total += self._token_counter.count(content)
        for item in request_shape.provider_runtime_items:
            for block in item.blocks:
                if block.text:
                    content = str(block.text).strip()
                    if content and content not in seen:
                        seen.add(content)
                        total += self._token_counter.count(content)
                if block.tool_arguments:
                    content = str(block.tool_arguments).strip()
                    if content and content not in seen:
                        seen.add(content)
                        total += self._token_counter.count(content)
        return total

    @staticmethod
    def _snapshot_role(role: str) -> Role:
        if role == "user":
            return "user"
        if role == "assistant":
            return "assistant"
        if role == "tool":
            return "tool"
        return "system"

    @staticmethod
    def _has_l4_compaction(conversation: Conversation) -> bool:
        return any(message.metadata.get("compaction") is True for message in conversation.messages)

    def _request_model_turn(
        self,
        *,
        runtime_items: list[RuntimeItem],
        legacy_messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> tuple[ModelTurnResult, tuple[str, ...]]:
        return self._model_turn_requester.request_model_turn(
            runtime_items=runtime_items,
            legacy_messages=legacy_messages,
            tools=tools,
            stream_sink=stream_sink,
        )

    def _record_model_stream_diagnostics(self, diagnostics: ModelStreamDiagnostics) -> None:
        turn_id = getattr(self, "_current_turn_id", "turn_unknown")
        payload = {
            "success": diagnostics.success,
            "elapsed_ms": diagnostics.elapsed_ms,
            "ttfb_ms": diagnostics.ttfb_ms,
            "provider_event_count": diagnostics.provider_event_count,
            "text_event_count": diagnostics.text_event_count,
            "tool_call_event_count": diagnostics.tool_call_event_count,
            "completed_event_count": diagnostics.completed_event_count,
            "text_bytes": diagnostics.text_bytes,
            "failure_kind": diagnostics.failure_kind,
            "failure_message": diagnostics.failure_message,
        }
        self._trace_service.append(
            self._config.session_id,
            RuntimeTraceEvent(
                kind="model_stream_diagnostics",
                turn_id=turn_id,
                payload=payload,
            ),
        )
        self._workspace_log_service.log(
            level=LogLevel.INFO if diagnostics.success else LogLevel.WARNING,
            event="model_stream_diagnostics",
            message=(
                "Model stream completed"
                if diagnostics.success
                else "Model stream failed"
            ),
            context={
                "session_id": self._config.session_id,
                "turn_id": turn_id,
                **payload,
            },
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
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
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
            stream_sink=stream_sink,
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
        del user_message, conversation, plan_state, step_index
        return self._config.reasoning_effort, (), {}, False, None, None

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
        self._workspace_log_service.set_session_id(session_id)
        self._model_state.set_config(config)
        self._runtime_context_builder.set_config(config)
        self._request_pipeline.set_config(config)
        self._runtime_error_logger.set_config(config)
        self._response_finalizer.set_config(config)
        self._configure_l4_summarization(
            self._compaction_pipeline.llm_summarization,
            config,
        )
        self._tool_execution_service._session_id = session_id
        self._tool_orchestrator._session_id = session_id
        self._event_ledger._session_id = session_id
        self._sub_agent_service._session_id = session_id
        self._assistant_block_consumer.set_session_id(session_id)
        self._planning_effects.set_session_id(session_id)
        self._observability_service.metrics.reset_context_metrics()
        self._restore_provider_input_budget_metric(session_id)

    def handle_user_turn(
        self,
        user_message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        from mycli.application.runtime.turn_executor import TurnExecutor

        return TurnExecutor(self).execute_user_turn(user_message, stream_sink=stream_sink)

    def resolve_pending_approval(self, choice: str) -> TurnResponse:
        from mycli.application.runtime.turn_executor import TurnExecutor

        return TurnExecutor(self).resolve_pending_approval(choice)

    def resolve_pending_clarification(self, *, request_id: str, response: str) -> TurnResponse:
        from mycli.application.runtime.turn_executor import TurnExecutor

        return TurnExecutor(self).resolve_pending_clarification(
            request_id=request_id,
            response=response,
        )
