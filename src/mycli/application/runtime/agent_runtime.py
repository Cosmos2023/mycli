from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime
import os
from pathlib import Path
import traceback
from uuid import uuid4

from mycli.domain.capabilities import (
    CapabilityActivation,
    CapabilityActivationDependencyStatus,
)
from mycli.domain.conversation import Conversation, Message
from mycli.domain.dynamic_tools import (
    DynamicToolLifecycleEvent,
    DynamicToolLifecycleState,
    DynamicToolRegistration,
    DynamicToolSource,
)
from mycli.domain.logging import LogLevel, ModelLogContext
from mycli.domain.runtime import (
    ActivityEvent,
    AgentConfig,
    BaselineFragment,
    ContextBaseline,
    DecisionAction,
    ExecutionContext,
    HistoryItem,
    HistoryItemType,
    InstructionContract,
    ModelTurnResult,
    PendingApproval,
    PendingDecision,
    PlanState,
    RuntimeBlock,
    RuntimeItem,
    RequestShape,
    RuntimeTraceEvent,
    ReasoningEffort,
    StopReason,
    SuspendedTurn,
    TurnContext,
    TurnItem,
    TurnItemType,
    TurnRecord,
    TurnRollout,
    TurnRolloutEvent,
    TurnResponse,
    TurnStatus,
)
from mycli.domain.skills import SkillDefinition, SkillMetadata
from mycli.domain.tool_exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolExposureKind,
    ToolRouteSource,
)
from mycli.domain.tools import ToolCall
from mycli.infrastructure.models.base import ModelAdapter, ModelMessage, ModelToolDefinition
from mycli.infrastructure.openai_client import ModelResponseError
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore
from mycli.prompts.react import build_react_prompt
from mycli.prompts.system import build_system_prompt
from mycli.schemas.responses_protocol import (
    ResponsesContinuationState,
    ResponsesFunctionCallOutputPayload,
)
from mycli.services.approval.approval_service import ApprovalService
from mycli.services.capability_resolver import CapabilityResolver
from mycli.services.context.context_manager import ContextManager
from mycli.services.context.instruction_contract_assembler import InstructionContractAssembler
from mycli.services.context.turn_context_assembler import TurnContextAssembler
from mycli.services.dynamic_tool_registry import DynamicToolRegistry
from mycli.services.dynamic_tool_provider import DynamicToolProvider
from mycli.services.memory_service import MemoryService
from mycli.services.planning.planning_service import PlanningService
from mycli.services.request_shape_builder import RequestShapeBuilder
from mycli.services.request_shape_payload_formatter import RequestShapePayloadFormatter
from mycli.services.session_service import SessionService
from mycli.services.skill_registry import SkillRegistry
from mycli.services.tool_exposure_planner import PlannedToolExposure, ToolExposurePlanner
from mycli.services.tool_router import ToolRouter
from mycli.services.trace_service import TraceService
from mycli.services.runtime_policy import RuntimePolicy
from mycli.services.workspace_log_service import WorkspaceLogService
from mycli.tools.registry import ToolRegistryV2


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
        workspace_log_service: WorkspaceLogService | None = None,
        dynamic_tool_providers: tuple[DynamicToolProvider, ...] = (),
    ) -> None:
        self._model_adapter = model_adapter
        self._tool_registry = tool_registry
        self._config = config
        self._approval_service = approval_service or ApprovalService()
        self._context_manager = context_manager or ContextManager()
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
        self._turn_context_assembler = TurnContextAssembler()
        self._instruction_contract_assembler = InstructionContractAssembler()
        self._request_shape_builder = RequestShapeBuilder()
        self._request_shape_payload_formatter = RequestShapePayloadFormatter()
        self._tool_exposure_planner = ToolExposurePlanner(tool_registry=tool_registry)
        self._dynamic_tool_registry = DynamicToolRegistry()
        self._dynamic_tool_providers = tuple(dynamic_tool_providers)
        self._workspace_log_service = workspace_log_service or WorkspaceLogService(
            workspace_root=config.workspace_root
        )

    @classmethod
    def for_tests(
        cls,
        workspace_root: Path,
        home_dir: Path,
        model_adapter: ModelAdapter,
    ) -> AgentRuntime:
        from mycli.tools.edit_file import EditFileTool
        from mycli.tools.list_directory import ListDirectoryTool
        from mycli.tools.read_file import ReadFileTool
        from mycli.tools.read_file_range import ReadFileRangeTool
        from mycli.tools.run_shell import RunShellTool
        from mycli.tools.search_text import SearchTextTool
        from mycli.tools.update_plan import UpdatePlanTool

        tool_registry = ToolRegistryV2.from_tools(
            [
                ListDirectoryTool(workspace_root),
                ReadFileTool(workspace_root),
                ReadFileRangeTool(workspace_root),
                SearchTextTool(workspace_root),
                EditFileTool(workspace_root),
                RunShellTool(workspace_root),
                UpdatePlanTool(),
            ]
        )
        return cls(
            model_adapter=model_adapter,
            tool_registry=tool_registry,
            config=AgentConfig(workspace_root=workspace_root),
            home_dir=home_dir,
        )

    def _set_model_log_context(self, turn_id: str) -> None:
        setter = getattr(self._model_adapter, "set_log_context_provider", None)
        if not callable(setter):
            return
        setter(
            lambda: ModelLogContext(
                session_id=self._config.session_id,
                turn_id=turn_id,
            )
        )

    def _set_model_runtime_event_recorder(self, turn_id: str) -> None:
        setter = getattr(self._model_adapter, "set_runtime_event_recorder", None)
        if not callable(setter):
            return
        setter(
            lambda kind, payload: self._trace_service.append(
                self._config.session_id,
                RuntimeTraceEvent(
                    kind=kind,
                    turn_id=turn_id,
                    payload=dict(payload),
                ),
            )
        )

    def _set_model_reasoning_effort(self, reasoning_effort: ReasoningEffort) -> None:
        thinking_setter = getattr(self._model_adapter, "set_thinking_config", None)
        if callable(thinking_setter):
            if not self._config.thinking_enabled:
                thinking_setter(enabled=False, effort=None)
                return
            thinking_setter(enabled=True, effort=reasoning_effort)
            return
        setter = getattr(self._model_adapter, "set_reasoning_effort", None)
        if not callable(setter):
            return
        if not self._config.thinking_enabled:
            setter(None)
            return
        setter(reasoning_effort.value)

    def _load_model_continuation_state(self, *, turn_id: str) -> None:
        setter = getattr(self._model_adapter, "set_continuation_state", None)
        if not callable(setter):
            return
        state = self._session_service.load_responses_continuation_state(
            self._config.session_id
        )
        setter(state)
        self._record_responses_continuation_state(
            turn_id=turn_id,
            kind="responses_continuation_loaded",
            state=state,
        )

    def _persist_model_continuation_state(self, *, turn_id: str, phase: str) -> None:
        getter = getattr(self._model_adapter, "get_continuation_state", None)
        if not callable(getter):
            return
        state = getter()
        if state is not None and not isinstance(state, ResponsesContinuationState):
            raise ModelResponseError(
                "Model adapter get_continuation_state must return ResponsesContinuationState or None."
            )
        self._session_service.save_responses_continuation_state(
            self._config.session_id,
            state,
        )
        self._record_responses_continuation_state(
            turn_id=turn_id,
            kind="responses_continuation_persisted",
            state=state,
            phase=phase,
        )

    def _record_responses_continuation_state(
        self,
        *,
        turn_id: str,
        kind: str,
        state: ResponsesContinuationState | None,
        phase: str | None = None,
    ) -> None:
        payload = {
            "phase": phase,
            "has_state": state is not None,
            "response_id": None if state is None else state.response_id,
            "eligible": None if state is None else state.eligible,
            "failure_reason": None if state is None else state.failure_reason,
            "request_input_count": 0 if state is None else len(state.request_input),
            "response_output_count": 0 if state is None else len(state.response_output),
        }
        self._trace_service.append(
            self._config.session_id,
            RuntimeTraceEvent(
                kind=kind,
                turn_id=turn_id,
                payload=payload,
            ),
        )
        self._workspace_log_service.log(
            level=LogLevel.INFO,
            event=kind,
            message="Updated Responses continuation state",
            context={
                "session_id": self._config.session_id,
                "turn_id": turn_id,
                **payload,
            },
        )

    def _error_details(self, error_path: str | None) -> tuple[str, ...]:
        details = [f"Details logged to {self._workspace_log_service.error_log_display_path()}"]
        if error_path:
            details.append(f"Raw error saved to {error_path}")
        return tuple(details)

    def _log_runtime_exception(
        self,
        *,
        turn_id: str,
        phase: str,
        exc: Exception,
    ) -> str:
        payload = {
            "error_type": type(exc).__name__,
            "message": str(exc),
            "traceback": traceback.format_exc(),
            "phase": phase,
            "session_id": self._config.session_id,
            "turn_id": turn_id,
            "model": self._config.model,
            "protocol": self._config.protocol,
        }
        path = self._workspace_log_service.write_error_payload(
            payload=payload,
            session_id=self._config.session_id,
            turn_id=turn_id,
        )
        relative_path = self._workspace_log_service.relative_path(path)
        self._workspace_log_service.log(
            level=LogLevel.ERROR,
            event=phase,
            message=str(exc),
            context={
                "session_id": self._config.session_id,
                "turn_id": turn_id,
                "error_path": relative_path,
            },
        )
        return relative_path

    def _select_skill_metadata(self, user_message: str) -> SkillMetadata | None:
        lowered = user_message.lower()
        for name in self._skill_registry.list_names():
            skill = self._skill_registry.get_metadata(name)
            if skill and any(hint in lowered for hint in skill.trigger_hints):
                return skill
        return None

    def _load_selected_skill(self, user_message: str) -> SkillDefinition | None:
        metadata = self._select_skill_metadata(user_message)
        if metadata is None:
            return None
        return self._skill_registry.load(metadata.name)

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
        runtime_snapshot = self._session_service.load_runtime_snapshot(self._config.session_id)
        history_items = () if runtime_snapshot is None else runtime_snapshot.history_items
        context_baseline = None if runtime_snapshot is None else runtime_snapshot.context_baseline
        managed = self._context_manager.build(
            conversation=tuple(conversation.messages),
            history_items=history_items,
            recent_message_count=self._config.recent_message_count,
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
            active_skill=self._active_skill_from_activations(capability_activations)
            or self._load_selected_skill(user_message),
            capability_activations=capability_activations,
            tool_exposure=tool_exposure,
            available_tool_names=available_tool_names,
            plan_state=plan_state,
            conversation_messages=managed.messages,
            conversation_summary=managed.summary,
            history_items=history_items,
            context_baseline=context_baseline,
            runtime_reminders=runtime_reminders,
            runtime_policy_state={} if runtime_policy_state is None else dict(runtime_policy_state),
        )

    def _build_runtime_items(
        self,
        *,
        contract: InstructionContract,
    ) -> list[RuntimeItem]:
        items: list[RuntimeItem] = [
            RuntimeItem(
                role="system",
                blocks=(RuntimeBlock(type="text", text=contract.base_instructions),),
            ),
        ]
        if contract.developer_sections:
            items.append(
                RuntimeItem(
                    role="developer",
                    blocks=tuple(
                        RuntimeBlock(type="text", text=section.content)
                        for section in contract.developer_sections
                    ),
                ),
            )
        if contract.contextual_user_sections:
            items.append(
                RuntimeItem(
                    role="user",
                    blocks=tuple(
                        RuntimeBlock(type="text", text=section.content)
                        for section in contract.contextual_user_sections
                    ),
                )
            )
        if contract.assistant_scaffold:
            items.append(
                RuntimeItem(
                    role="assistant",
                    blocks=(
                        RuntimeBlock(
                            type="text",
                            text=contract.assistant_scaffold,
                        ),
                    ),
                )
            )
        for message in contract.conversation_messages:
            blocks = self._runtime_blocks_from_message(message)
            if not blocks:
                continue
            items.append(RuntimeItem(role=message.role, blocks=blocks))
        return items

    def _runtime_blocks_from_message(self, message: Message) -> tuple[RuntimeBlock, ...]:
        if message.blocks:
            return message.blocks

        blocks: list[RuntimeBlock] = []
        if message.role == "assistant":
            if message.content:
                blocks.append(RuntimeBlock(type="text", text=message.content))
            for call in message.tool_calls:
                if not call.call_id:
                    continue
                blocks.append(
                    RuntimeBlock(
                        type="tool_call",
                        tool_name=call.name,
                        tool_arguments=call.arguments,
                        call_id=call.call_id,
                    )
                )
            return tuple(blocks)

        if message.role == "tool":
            if not message.tool_call_id:
                return ()
            return (
                RuntimeBlock(
                    type="tool_result",
                    text=message.content,
                    call_id=message.tool_call_id,
                ),
            )

        if message.content:
            return (RuntimeBlock(type="text", text=message.content),)
        return ()

    def _message_metadata_from_blocks(self, message: Message) -> dict[str, object]:
        metadata: dict[str, object] = {}
        for block in message.blocks:
            for key, value in block.metadata.items():
                existing = metadata.get(key)
                if isinstance(existing, dict) and isinstance(value, dict):
                    nested = dict(existing)
                    nested.update(value)
                    metadata[key] = nested
                    continue
                metadata[key] = value
        return metadata

    def _build_messages(
        self,
        *,
        request_shape: RequestShape,
    ) -> list[ModelMessage]:
        return self._request_shape_payload_formatter.legacy_messages(request_shape)

    def _assemble_instruction_contract(
        self,
        *,
        turn_id: str,
        context: ExecutionContext,
        turn_context: TurnContext,
    ) -> InstructionContract:
        contract = self._instruction_contract_assembler.assemble(
            turn_context=turn_context,
            base_instructions=build_system_prompt(),
            conversation_messages=context.conversation_messages,
        )
        stable_action_guidance = build_react_prompt(
            contract,
            include_context_sections=False,
            include_dynamic_guidance=False,
        )
        contract = InstructionContract(
            base_instructions=f"{contract.base_instructions}\n\n{stable_action_guidance}",
            developer_sections=contract.developer_sections,
            contextual_user_sections=contract.contextual_user_sections,
            conversation_messages=contract.conversation_messages,
            current_user_request=contract.current_user_request,
            assistant_scaffold=None,
        )
        self._trace_service.append(
            self._config.session_id,
            RuntimeTraceEvent(
                kind="instruction_contract",
                turn_id=turn_id,
                payload=contract.trace_summary(),
            ),
        )
        self._workspace_log_service.log(
            level=LogLevel.INFO,
            event="instruction_contract_assembled",
            message="Assembled instruction contract",
            context={
                "session_id": self._config.session_id,
                "developer_kinds": [
                    str(section.kind) for section in contract.developer_sections
                ],
                "contextual_kinds": [
                    str(section.kind) for section in contract.contextual_user_sections
                ],
                "memory_excluded_contextual_kinds": [
                    str(section.kind)
                    for section in contract.memory_excluded_contextual_sections()
                ],
            },
        )
        return contract

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
        context = self._build_context(
            user_message,
            conversation,
            plan_state,
            runtime_reminders,
            runtime_policy_state,
            capability_activations,
            tool_exposure,
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

    def _resolve_capability_activations(
        self,
        user_message: str,
    ) -> tuple[CapabilityActivation, ...]:
        return self._capability_resolver.resolve(user_message)

    def _dynamic_tool_route_source(
        self,
        source: DynamicToolSource,
    ) -> ToolRouteSource:
        if source is DynamicToolSource.RUNTIME:
            return ToolRouteSource.RUNTIME
        if source is DynamicToolSource.CAPABILITY:
            return ToolRouteSource.CAPABILITY
        return ToolRouteSource.PROVIDER

    def _dynamic_tool_entry(
        self,
        registration: DynamicToolRegistration,
    ) -> ToolExposureEntry:
        descriptor = registration.descriptor
        metadata = {
            "tool_id": descriptor.tool_id,
            "scope": descriptor.scope.value,
            "state": descriptor.lifecycle_state.value,
        }
        metadata.update(descriptor.origin_metadata)
        return ToolExposureEntry(
            route_key=descriptor.route_key,
            kind=ToolExposureKind.DYNAMIC,
            source=self._dynamic_tool_route_source(descriptor.source),
            spec=descriptor.spec,
            metadata=metadata,
            dynamic_descriptor=descriptor,
        )

    def _bind_visible_dynamic_registrations(
        self,
        exposure: ToolExposure,
    ) -> tuple[ToolExposure, dict[str, DynamicToolRegistration]]:
        blocked_names = {entry.name for entry in (*exposure.direct, *exposure.deferred)}
        visible_dynamic: dict[str, DynamicToolRegistration] = {}
        dynamic_entries: list[ToolExposureEntry] = []

        for registration in self._dynamic_tool_registry.get_visible_registrations():
            route_name = registration.descriptor.route_name
            if route_name in blocked_names:
                continue
            visible_dynamic[route_name] = registration
            dynamic_entries.append(self._dynamic_tool_entry(registration))

        return (
            ToolExposure(
                direct=exposure.direct,
                deferred=exposure.deferred,
                dynamic=tuple(dynamic_entries),
            ),
            visible_dynamic,
        )

    def _runtime_dynamic_tools(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        capability_activations: tuple[CapabilityActivation, ...] = (),
    ) -> tuple[object, ...]:
        registrations: list[object] = []
        for provider in self._dynamic_tool_providers:
            provided = provider.provide(
                user_message=user_message,
                conversation=conversation,
                plan_state=plan_state,
                capability_activations=capability_activations,
            )
            registrations.extend(provided)
        return tuple(registrations)

    def _plan_tool_exposure(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        capability_activations: tuple[CapabilityActivation, ...],
    ) -> PlannedToolExposure:
        runtime_dynamic_tools = self._runtime_dynamic_tools(
            user_message=user_message,
            conversation=conversation,
            plan_state=plan_state,
            capability_activations=capability_activations,
        )
        planned = self._tool_exposure_planner.plan(
            user_message=user_message,
            capability_activations=capability_activations,
            runtime_dynamic_tools=runtime_dynamic_tools,
        )
        lifecycle_events: list[DynamicToolLifecycleEvent] = []

        for registration in planned.dynamic_tools.values():
            result = self._dynamic_tool_registry.register(registration)
            if result.lifecycle_event is not None:
                lifecycle_events.append(result.lifecycle_event)

        rebound_exposure, visible_dynamic_tools = self._bind_visible_dynamic_registrations(
            planned.exposure
        )

        for registration in tuple(visible_dynamic_tools.values()):
            if registration.descriptor.lifecycle_state is not DynamicToolLifecycleState.DECLARED:
                continue
            event = self._dynamic_tool_registry.transition(
                registration.descriptor.tool_id,
                DynamicToolLifecycleState.EXPOSED,
            )
            if event is not None:
                lifecycle_events.append(event)

        rebound_exposure, visible_dynamic_tools = self._bind_visible_dynamic_registrations(
            planned.exposure
        )
        return PlannedToolExposure(
            exposure=rebound_exposure,
            dynamic_tools=visible_dynamic_tools,
            lifecycle_events=tuple(lifecycle_events),
        )

    def _build_tool_router(self, planned_exposure: PlannedToolExposure) -> ToolRouter:
        return ToolRouter(
            tool_registry=self._tool_registry,
            dynamic_tools=planned_exposure.dynamic_tools,
            dynamic_tool_registry=self._dynamic_tool_registry,
        )

    def _append_tool_exposure_turn_item(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        activity_events: list[ActivityEvent],
        tool_exposure: ToolExposure,
    ) -> None:
        summary = tool_exposure.summary()
        text = (
            "Tool exposure: "
            f"direct={', '.join(summary['direct']) or 'none'}; "
            f"deferred={', '.join(summary['deferred']) or 'none'}; "
            f"dynamic={', '.join(summary['dynamic']) or 'none'}"
        )
        self._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.TOOL_EXPOSURE,
                text=text,
                metadata={
                    "direct_tool_names": summary["direct"],
                    "deferred_tool_names": summary["deferred"],
                    "dynamic_tool_names": summary["dynamic"],
                },
            ),
        )
        activity_events.append(ActivityEvent(kind="tool_exposure", message=text))
        self._trace_service.append(
            self._config.session_id,
            RuntimeTraceEvent(
                kind="tool_exposure",
                turn_id=turn_id,
                payload={
                    "direct_tool_names": summary["direct"],
                    "deferred_tool_names": summary["deferred"],
                    "dynamic_tool_names": summary["dynamic"],
                },
            ),
        )

    def _append_dynamic_tool_lifecycle_events(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        activity_events: list[ActivityEvent],
        lifecycle_events: tuple[DynamicToolLifecycleEvent, ...],
    ) -> None:
        for event in lifecycle_events:
            text = (
                f"Dynamic tool: {event.route_name} "
                f"[scope={event.scope.value} state={event.state.value} source={event.source.value}]"
            )
            self._append_turn_item(
                turn_id=turn_id,
                turn_items=turn_items,
                item=TurnItem(
                    type=TurnItemType.DYNAMIC_TOOL,
                    text=text,
                    tool_name=event.route_name,
                    metadata=event.to_dict(),
                ),
            )
            activity_events.append(
                ActivityEvent(
                    kind="dynamic_tool_lifecycle",
                    message=text,
                    tool_name=event.route_name,
                    preview=event.state.value,
                )
            )
            self._trace_service.append(
                self._config.session_id,
                RuntimeTraceEvent(
                    kind="dynamic_tool_lifecycle",
                    turn_id=turn_id,
                    payload=event.to_dict(),
                ),
            )

    def _active_skill_from_activations(
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

    def _append_capability_turn_items(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        capability_activations: tuple[CapabilityActivation, ...],
    ) -> None:
        for activation in capability_activations:
            text = (
                f"Capability activated: {activation.name}"
                if activation.dependency_status is CapabilityActivationDependencyStatus.READY
                else f"Capability unavailable: {activation.name}"
            )
            self._append_turn_item(
                turn_id=turn_id,
                turn_items=turn_items,
                item=TurnItem(
                    type=TurnItemType.CAPABILITY,
                    text=text,
                    metadata={
                        "capability_name": activation.name,
                        "source": activation.source.value,
                        "dependency_status": activation.dependency_status.value,
                        "source_path": activation.source_path,
                        **activation.metadata,
                    },
                ),
            )

    def _normalize_tool_call(self, call: ToolCall) -> ToolCall:
        if call.call_id:
            return call
        return ToolCall(
            name=call.name,
            arguments=call.arguments,
            reason=call.reason,
            call_id=f"call_{uuid4().hex}",
        )

    def _tool_call_from_block(self, block: RuntimeBlock) -> ToolCall:
        tool_arguments = block.tool_arguments
        return self._normalize_tool_call(
            ToolCall(
                name=block.tool_name or "",
                arguments=tool_arguments if isinstance(tool_arguments, dict) else {},
                reason="model requested tool",
                call_id=block.call_id,
            )
        )

    def _record_assistant_text_block(
        self,
        conversation: Conversation,
        *,
        block: RuntimeBlock,
        response_id: str | None,
    ) -> None:
        if not block.text:
            return
        conversation.append(
            Message(
                role="assistant",
                content=block.text,
                blocks=(block,),
                response_id=response_id,
            )
        )

    def _record_tool_message(
        self,
        conversation: Conversation,
        *,
        tool_name: str,
        content: str,
        success: bool,
        summary: str,
        error: str | None,
        raw_payload: dict[str, object],
        tool_call_id: str | None = None,
    ) -> None:
        blocks: tuple[RuntimeBlock, ...] = ()
        if tool_call_id:
            blocks = (
                RuntimeBlock(
                    type="tool_result",
                    text=content,
                    call_id=tool_call_id,
                    metadata={
                        "tool_name": tool_name,
                        "success": success,
                        "summary": summary,
                        "error": error,
                        "path": raw_payload.get("path"),
                        "error_kind": raw_payload.get("error_kind"),
                        "function_call_output_payload": (
                            ResponsesFunctionCallOutputPayload.from_text(
                                content,
                                success=success,
                            ).to_dict()
                        ),
                    },
                ),
            )
        conversation.append(
            Message(
                role="tool",
                content=f"Tool {tool_name}: {content}",
                tool_call_id=tool_call_id,
                blocks=blocks,
            )
        )

    def _record_assistant_tool_call(
        self,
        conversation: Conversation,
        *,
        tool_call: ToolCall,
        provider_id: str | None = None,
        response_id: str | None = None,
        metadata: dict[str, object] | None = None,
    ) -> None:
        normalized_call = self._normalize_tool_call(tool_call)
        block_metadata = {} if metadata is None else dict(metadata)
        conversation.append(
            Message(
                role="assistant",
                content="",
                tool_calls=(normalized_call,),
                blocks=(
                    RuntimeBlock(
                        type="tool_call",
                        tool_name=normalized_call.name,
                        tool_arguments=normalized_call.arguments,
                        call_id=normalized_call.call_id or "",
                        provider_id=provider_id,
                        metadata=block_metadata,
                    ),
                ),
                response_id=response_id,
            )
        )

    def _record_assistant_tool_calls(
        self,
        conversation: Conversation,
        *,
        tool_calls: tuple[ToolCall, ...],
        blocks: tuple[RuntimeBlock, ...],
        response_id: str | None = None,
    ) -> None:
        normalized_calls = tuple(self._normalize_tool_call(call) for call in tool_calls)
        conversation.append(
            Message(
                role="assistant",
                content="",
                tool_calls=normalized_calls,
                blocks=blocks,
                response_id=response_id,
            )
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
        normalized_call = self._normalize_tool_call(call)
        turn_metadata = dict(metadata or {})
        turn_metadata["arguments"] = normalized_call.arguments
        turn_metadata["provider_id"] = provider_id
        start_event = self._tool_activity_event(normalized_call, phase="start")
        activity_events.append(start_event)
        self._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.TOOL_CALL,
                text=start_event.message,
                tool_name=normalized_call.name,
                call_id=normalized_call.call_id,
                metadata=turn_metadata,
            ),
        )
        if record_assistant_call:
            self._record_assistant_tool_call(
                conversation,
                tool_call=normalized_call,
                provider_id=provider_id,
                response_id=response_id,
                metadata=metadata,
            )
        try:
            result = tool_router.execute(normalized_call, exposure=tool_exposure)
            next_plan_state = self._apply_tool_effects(
                call=normalized_call,
                result_summary=result.summary,
                result_payload=result.raw_payload,
                plan_state=plan_state,
            )
            tool_transcript_content = self._context_manager.render_tool_result(result)
            self._record_tool_message(
                conversation,
                tool_name=normalized_call.name,
                content=tool_transcript_content,
                success=result.success,
                summary=result.summary,
                error=result.error,
                raw_payload=result.raw_payload,
                tool_call_id=normalized_call.call_id,
            )
            finish_event = self._tool_activity_event(
                normalized_call,
                phase="finish",
                result_summary=result.summary,
            )
            activity_events.append(finish_event)
            self._append_turn_item(
                turn_id=turn_id,
                turn_items=turn_items,
                item=TurnItem(
                    type=TurnItemType.TOOL_RESULT,
                    text=finish_event.message,
                    tool_name=normalized_call.name,
                    call_id=normalized_call.call_id,
                    metadata={
                        "success": result.success,
                        "summary": result.summary,
                        "error": result.error,
                        "path": result.raw_payload.get("path"),
                        "error_kind": result.raw_payload.get("error_kind"),
                        "raw_payload": dict(result.raw_payload),
                        "transcript_content": tool_transcript_content,
                        "file_changes": self._file_changes_for_tool_result(
                            call=normalized_call,
                            result_payload=result.raw_payload,
                        ),
                    },
                ),
            )
            self._trace_service.append(
                self._config.session_id,
                RuntimeTraceEvent(
                    kind="tool_execution",
                    turn_id=turn_id,
                    payload={
                        "tool_name": normalized_call.name,
                        "tool_call_id": normalized_call.call_id or "",
                        "arguments": normalized_call.arguments,
                        "summary": result.summary,
                        "success": result.success,
                        "stdout_preview": self._trace_preview(result.raw_payload.get("stdout")),
                        "stderr_preview": self._trace_preview(result.raw_payload.get("stderr")),
                    },
                ),
            )
            return next_plan_state
        finally:
            lifecycle_events = tool_router.pop_lifecycle_events()
            if lifecycle_events:
                self._append_dynamic_tool_lifecycle_events(
                    turn_id=turn_id,
                    turn_items=turn_items,
                    activity_events=activity_events,
                    lifecycle_events=lifecycle_events,
                )

    def _file_changes_for_tool_result(
        self,
        *,
        call: ToolCall,
        result_payload: dict[str, object],
    ) -> list[dict[str, object]]:
        if call.name in {"create_file", "edit_file", "replace_in_file", "append_file"}:
            path = result_payload.get("path") or call.arguments.get("path")
            if isinstance(path, str) and path:
                return [{"kind": call.name, "path": path}]
        if call.name == "delete_path":
            path = result_payload.get("path") or call.arguments.get("path")
            if isinstance(path, str) and path:
                return [{"kind": "delete", "path": path}]
        if call.name == "mkdir":
            path = result_payload.get("path") or call.arguments.get("path")
            if isinstance(path, str) and path:
                return [{"kind": "mkdir", "path": path}]
        if call.name == "move_path":
            source = result_payload.get("source") or call.arguments.get("source")
            destination = result_payload.get("destination") or call.arguments.get("destination")
            if isinstance(source, str) and source and isinstance(destination, str) and destination:
                return [
                    {
                        "kind": "move",
                        "source": source,
                        "destination": destination,
                    }
                ]
        return []

    def _tool_activity_event(
        self,
        call: ToolCall,
        *,
        phase: str,
        result_summary: str | None = None,
    ) -> ActivityEvent:
        prefix = self._tool_activity_prefix(call)
        if phase == "start":
            return ActivityEvent(
                kind="tool_started",
                message=prefix,
                tool_name=call.name,
                path=self._activity_path(call),
                query=self._activity_query(call),
                preview=self._activity_preview(call),
            )
        done_message = self._tool_finished_message(call, result_summary=result_summary)
        return ActivityEvent(
            kind="tool_finished",
            message=done_message,
            tool_name=call.name,
            path=self._activity_path(call),
            query=self._activity_query(call),
            preview=self._activity_preview(call),
        )

    def _tool_activity_prefix(self, call: ToolCall) -> str:
        path = self._activity_path(call)
        query = self._activity_query(call)
        if call.name == "list_directory":
            return f"Listing: {path or '.'}"
        if call.name == "read_file":
            return f"Reading: {path or '<unknown>'}"
        if call.name == "read_file_range":
            start = call.arguments.get("start_line")
            end = call.arguments.get("end_line")
            if path and isinstance(start, int) and isinstance(end, int):
                return f"Reading: {path}:{start}-{end}"
            return f"Reading: {path or '<unknown>'}"
        if call.name == "search_text":
            message = f"Searching: query={query or '<unknown>'}"
            glob = call.arguments.get("glob")
            if isinstance(glob, str) and glob:
                message += f" glob={glob}"
            return message
        if call.name in {"edit_file", "replace_in_file", "append_file"}:
            verb = "Appending" if call.name == "append_file" else "Editing"
            return f"{verb}: {path or '<unknown>'}"
        if call.name == "update_plan":
            return "Planning: updating task plan"
        if call.name.startswith("git_"):
            return f"Git: {call.name.removeprefix('git_')}"
        if call.name == "run_shell":
            return f"Shell: {self._activity_preview(call) or call.name}"
        return f"Tool: {call.name}"

    def _tool_finished_message(self, call: ToolCall, *, result_summary: str | None) -> str:
        path = self._activity_path(call)
        query = self._activity_query(call)
        if call.name == "search_text":
            return f"Done searching: query={query or '<unknown>'}"
        if call.name in {"read_file", "read_file_range"}:
            return f"Done reading: {path or '<unknown>'}"
        if call.name in {"edit_file", "replace_in_file"}:
            return f"Done editing: {path or '<unknown>'}"
        if call.name == "append_file":
            return f"Done appending: {path or '<unknown>'}"
        if call.name.startswith("git_"):
            return f"Done git: {call.name.removeprefix('git_')}"
        if call.name == "run_shell":
            return f"Done shell: {self._activity_preview(call) or (result_summary or call.name)}"
        if call.name == "update_plan":
            return "Done planning: updated task plan"
        return f"Done: {call.name}"

    def _activity_path(self, call: ToolCall) -> str | None:
        value = call.arguments.get("path")
        return value if isinstance(value, str) and value else None

    def _activity_query(self, call: ToolCall) -> str | None:
        value = call.arguments.get("query")
        return value if isinstance(value, str) and value else None

    def _activity_preview(self, call: ToolCall) -> str | None:
        args = call.arguments.get("args")
        if isinstance(args, list):
            parts = [item for item in args if isinstance(item, str)]
            if parts:
                return " ".join(parts)
        return None

    def _trace_preview(self, value: object, *, max_chars: int = 120) -> str | None:
        if not isinstance(value, str) or not value.strip():
            return None
        normalized = self._context_manager._normalize_whitespace(value)
        if len(normalized) <= max_chars:
            return normalized
        return normalized[: max_chars - 3] + "..."

    def _legacy_action_to_turn_result(self, action: object) -> ModelTurnResult:
        blocks: list[RuntimeBlock] = []
        progress_message = getattr(action, "progress_message", None)
        if isinstance(progress_message, str) and progress_message:
            blocks.append(RuntimeBlock(type="reasoning", text=progress_message))

        tool_call = getattr(action, "tool_call", None)
        if isinstance(tool_call, ToolCall):
            normalized_call = self._normalize_tool_call(tool_call)
            blocks.append(
                RuntimeBlock(
                    type="tool_call",
                    tool_name=normalized_call.name,
                    tool_arguments=normalized_call.arguments,
                    call_id=normalized_call.call_id or "",
                )
            )

        assistant_message = getattr(action, "assistant_message", None)
        if isinstance(assistant_message, str) and assistant_message:
            blocks.append(RuntimeBlock(type="text", text=assistant_message))

        items: tuple[RuntimeItem, ...] = ()
        if blocks:
            items = (RuntimeItem(role="assistant", blocks=tuple(blocks)),)

        return ModelTurnResult(
            items=items,
            done=bool(getattr(action, "done", False)),
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
        shape = self._request_shape_builder.build(
            config=self._config,
            contract=contract,
            tools=tools,
        )
        payload = shape.summary()
        self._trace_service.append(
            self._config.session_id,
            RuntimeTraceEvent(
                kind="request_shape",
                turn_id=turn_id,
                payload=payload,
            ),
        )
        self._workspace_log_service.log(
            level=LogLevel.INFO,
            event="request_shape_built",
            message="Built cache-first request shape",
            context={
                "session_id": self._config.session_id,
                "turn_id": turn_id,
                "system_hash": payload["system_hash"],
                "tool_schema_hash": payload["tool_schema_hash"],
                "tool_order_hash": payload["tool_order_hash"],
            },
        )
        return shape

    def _request_model_turn(
        self,
        *,
        runtime_items: list[RuntimeItem],
        legacy_messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
    ) -> tuple[ModelTurnResult, tuple[str, ...]]:
        stream_turn = getattr(self._model_adapter, "stream_turn", None)
        if callable(stream_turn):
            blocks: list[RuntimeBlock] = []
            streamed_chunks: list[str] = []
            response_id: str | None = None
            metadata: dict[str, object] = {}
            has_tool_call = False

            for event in stream_turn(items=runtime_items, tools=tools):
                if not isinstance(event, dict):
                    raise ModelResponseError("Model adapter stream_turn must yield dict events.")
                event_type = event.get("type")
                if event_type == "reasoning":
                    text = event.get("text")
                    if isinstance(text, str) and text:
                        blocks.append(RuntimeBlock(type="reasoning", text=text))
                    continue
                if event_type == "text_delta":
                    text = event.get("text")
                    if isinstance(text, str) and text:
                        blocks.append(RuntimeBlock(type="text", text=text))
                        streamed_chunks.append(text)
                    continue
                if event_type == "tool_call":
                    block = event.get("block")
                    if not isinstance(block, RuntimeBlock) or block.type != "tool_call":
                        raise ModelResponseError(
                            "Model adapter tool_call stream event must include tool_call RuntimeBlock."
                        )
                    blocks.append(block)
                    has_tool_call = True
                    continue
                if event_type == "completed":
                    raw_response_id = event.get("response_id")
                    if isinstance(raw_response_id, str) and raw_response_id:
                        response_id = raw_response_id
                    raw_metadata = event.get("metadata")
                    if isinstance(raw_metadata, dict):
                        metadata = raw_metadata
                    continue
                raise ModelResponseError(f"Unsupported model stream event type: {event_type!r}.")

            items: tuple[RuntimeItem, ...] = ()
            if blocks:
                items = (RuntimeItem(role="assistant", blocks=tuple(blocks)),)
            return (
                ModelTurnResult(
                    items=items,
                    done=not has_tool_call,
                    response_id=response_id,
                    metadata=metadata,
                ),
                tuple(streamed_chunks),
            )

        next_turn = getattr(self._model_adapter, "next_turn", None)
        if callable(next_turn):
            turn_result = next_turn(items=runtime_items, tools=tools)
            if isinstance(turn_result, ModelTurnResult):
                return turn_result, ()
            raise ModelResponseError("Model adapter next_turn must return ModelTurnResult.")

        action = self._model_adapter.next_action(
            messages=legacy_messages,
            tools=tools,
        )
        return self._legacy_action_to_turn_result(action), ()

    def _deepseek_reasoning_content_from_block(
        self,
        block: RuntimeBlock,
    ) -> str | None:
        deepseek_metadata = block.metadata.get("deepseek")
        if not isinstance(deepseek_metadata, dict):
            return None
        reasoning_content = deepseek_metadata.get("reasoning_content")
        if not isinstance(reasoning_content, str):
            return None
        stripped = reasoning_content.strip()
        if not stripped:
            return None
        return reasoning_content

    def _emit_visible_provider_reasoning(
        self,
        *,
        block: RuntimeBlock,
        turn_id: str,
        progress_updates: list[str],
        activity_events: list[ActivityEvent],
        turn_items: list[TurnItem],
    ) -> None:
        reasoning_content = self._deepseek_reasoning_content_from_block(block)
        if reasoning_content is None:
            return
        message = f"Thinking: {reasoning_content}"
        metadata = {
            "provider_id": block.provider_id,
            "provider": "deepseek",
            "source": "provider_reasoning_content",
            "deepseek": {"reasoning_content": reasoning_content},
        }
        progress_updates.append(reasoning_content)
        activity_events.append(ActivityEvent(kind="thinking", message=message))
        self._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.REASONING,
                text=message,
                metadata=metadata,
            ),
        )
        self._workspace_log_service.log(
            level=LogLevel.INFO,
            event="provider_reasoning_content",
            message="Exposed provider reasoning content",
            context={
                "session_id": self._config.session_id,
                "turn_id": turn_id,
                **metadata,
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
    ) -> tuple[
        PlanState,
        bool,
        list[str],
        tuple[TurnResponse, TurnStatus, StopReason] | None,
    ]:
        current_plan_state = plan_state
        turn_has_tool_call = False
        turn_text_chunks: list[str] = []
        for item in turn_result.items:
            if item.role != "assistant":
                continue
            pending_text_chunks: list[str] = []
            pending_text_block: RuntimeBlock | None = None
            tool_call_blocks = tuple(
                block for block in item.blocks if block.type == "tool_call"
            )
            tool_call_group_recorded = False

            def flush_pending_text(*, record_conversation: bool = True) -> None:
                nonlocal pending_text_chunks, pending_text_block
                if not pending_text_chunks or pending_text_block is None:
                    pending_text_chunks = []
                    pending_text_block = None
                    return
                combined_text = "".join(pending_text_chunks)
                combined_block = RuntimeBlock(
                    type="text",
                    text=combined_text,
                    provider_id=pending_text_block.provider_id,
                    metadata=dict(pending_text_block.metadata),
                )
                if record_conversation:
                    self._record_assistant_text_block(
                        conversation,
                        block=combined_block,
                        response_id=turn_result.response_id,
                    )
                turn_text_chunks.append(combined_text)
                self._append_turn_item(
                    turn_id=turn_id,
                    turn_items=turn_items,
                    item=TurnItem(
                        type=TurnItemType.ASSISTANT_MESSAGE,
                        text=combined_text,
                        metadata={"provider_id": combined_block.provider_id, **combined_block.metadata},
                    ),
                )
                pending_text_chunks = []
                pending_text_block = None

            def record_tool_call_group_once() -> None:
                nonlocal tool_call_group_recorded
                if tool_call_group_recorded or not tool_call_blocks:
                    return
                self._record_assistant_tool_calls(
                    conversation,
                    tool_calls=tuple(
                        self._tool_call_from_block(tool_block)
                        for tool_block in tool_call_blocks
                    ),
                    blocks=tuple(
                        replay_block
                        for replay_block in item.blocks
                        if replay_block.type in {"text", "tool_call"}
                    ),
                    response_id=turn_result.response_id,
                )
                tool_call_group_recorded = True

            for block in item.blocks:
                if block.type == "reasoning":
                    flush_pending_text(record_conversation=not tool_call_blocks)
                    if block.text:
                        progress_updates.append(block.text)
                        reasoning_message = (
                            f"Planning: {block.text}"
                            if "plan" in block.text.lower()
                            else f"Thinking: {block.text}"
                        )
                        activity_events.append(
                            ActivityEvent(
                                kind="planning" if "plan" in block.text.lower() else "thinking",
                                message=reasoning_message,
                            )
                        )
                        self._append_turn_item(
                            turn_id=turn_id,
                            turn_items=turn_items,
                            item=TurnItem(
                                type=TurnItemType.REASONING,
                                text=reasoning_message,
                                metadata={"provider_id": block.provider_id, **block.metadata},
                            ),
                        )
                    continue

                if block.type == "text":
                    if block.text:
                        pending_text_chunks.append(block.text)
                        pending_text_block = block
                    continue

                if block.type != "tool_call":
                    continue

                flush_pending_text(record_conversation=not tool_call_blocks)
                turn_has_tool_call = True
                tool_call = self._tool_call_from_block(block)
                self._emit_visible_provider_reasoning(
                    block=block,
                    turn_id=turn_id,
                    progress_updates=progress_updates,
                    activity_events=activity_events,
                    turn_items=turn_items,
                )
                if tool_call.name not in tool_exposure.callable_tool_names():
                    rendered_names = ", ".join(tool_exposure.callable_tool_names()) or "none"
                    warning_message = (
                        f"The model requested unsupported tool '{tool_call.name}' that is not exposed for this turn. "
                        f"Callable tools: {rendered_names}."
                    )
                    self._append_turn_item(
                        turn_id=turn_id,
                        turn_items=turn_items,
                        item=TurnItem(
                            type=TurnItemType.WARNING,
                            text=warning_message,
                            tool_name=tool_call.name,
                            call_id=tool_call.call_id,
                        ),
                    )
                    return (
                        current_plan_state,
                        turn_has_tool_call,
                        turn_text_chunks,
                        (
                            TurnResponse(
                                assistant_message=warning_message,
                                streamed_chunks=tuple(streamed_chunks),
                                progress_updates=tuple(progress_updates),
                            ),
                            TurnStatus.FAILED,
                            StopReason.MODEL_ERROR,
                        ),
                    )

                if self._session_service.is_command_allowed(
                    self._config.session_id,
                    getattr(
                        self._approval_service._safety_policy.evaluate(tool_call),
                        "command_pattern",
                        None,
                    ),
                ):
                    record_tool_call_group_once()
                    current_plan_state = self._execute_tool_call(
                        conversation=conversation,
                        call=tool_call,
                        tool_router=tool_router,
                        tool_exposure=tool_exposure,
                        plan_state=current_plan_state,
                        turn_id=turn_id,
                        activity_events=activity_events,
                        turn_items=turn_items,
                        provider_id=block.provider_id,
                        response_id=turn_result.response_id,
                        metadata=dict(block.metadata),
                        record_assistant_call=False,
                    )
                    continue

                if tool_call.name in {entry.name for entry in tool_exposure.dynamic}:
                    record_tool_call_group_once()
                    current_plan_state = self._execute_tool_call(
                        conversation=conversation,
                        call=tool_call,
                        tool_router=tool_router,
                        tool_exposure=tool_exposure,
                        plan_state=current_plan_state,
                        turn_id=turn_id,
                        activity_events=activity_events,
                        turn_items=turn_items,
                        provider_id=block.provider_id,
                        response_id=turn_result.response_id,
                        metadata=dict(block.metadata),
                        record_assistant_call=False,
                    )
                    continue

                approval = self._approval_service.evaluate(tool_call)
                if approval.denied_reason is not None:
                    warning_message = f"Denied: {approval.denied_reason}"
                    self._append_turn_item(
                        turn_id=turn_id,
                        turn_items=turn_items,
                        item=TurnItem(
                            type=TurnItemType.WARNING,
                            text=warning_message,
                            tool_name=tool_call.name,
                            call_id=tool_call.call_id,
                        ),
                    )
                    return (
                        current_plan_state,
                        turn_has_tool_call,
                        turn_text_chunks,
                        (
                            TurnResponse(
                                assistant_message=warning_message,
                                streamed_chunks=tuple(streamed_chunks),
                                progress_updates=tuple(progress_updates),
                            ),
                            TurnStatus.COMPLETED,
                            StopReason.ASSISTANT_COMPLETED,
                        ),
                    )

                if approval.pending_approval is not None:
                    record_tool_call_group_once()
                    pending_decision = self._pending_decision_from_approval(
                        approval.pending_approval
                    )
                    self._session_service.save_pending_decision(
                        self._config.session_id,
                        pending_decision,
                    )
                    self._session_service.save_suspended_turn(
                        self._config.session_id,
                        SuspendedTurn(
                            user_message=user_message,
                            conversation=tuple(conversation.messages),
                            plan_state=current_plan_state,
                            pending_approval=approval.pending_approval,
                        ),
                    )
                    waiting_message = f"Waiting approval: {pending_decision.preview}"
                    self._append_turn_item(
                        turn_id=turn_id,
                        turn_items=turn_items,
                        item=TurnItem(
                            type=TurnItemType.APPROVAL_REQUEST,
                            text=waiting_message,
                            tool_name=pending_decision.tool_call.name,
                            call_id=pending_decision.tool_call.call_id,
                            metadata={"preview": pending_decision.preview},
                        ),
                    )
                    return (
                        current_plan_state,
                        turn_has_tool_call,
                        turn_text_chunks,
                        (
                            TurnResponse(
                                assistant_message=(
                                    "A risky action is waiting for your decision. "
                                    "Choose 1 to approve once, 2 to reject, or 3 to allow for this session."
                                ),
                                activity_events=(
                                    *activity_events,
                                    ActivityEvent(
                                        kind="waiting_approval",
                                        message=waiting_message,
                                        tool_name=pending_decision.tool_call.name,
                                        preview=pending_decision.preview,
                                    ),
                                ),
                                streamed_chunks=tuple(streamed_chunks),
                                progress_updates=tuple(progress_updates),
                                pending_decision=pending_decision,
                            ),
                            TurnStatus.WAITING_APPROVAL,
                            StopReason.APPROVAL_REQUIRED,
                        ),
                    )

                record_tool_call_group_once()
                current_plan_state = self._execute_tool_call(
                    conversation=conversation,
                    call=tool_call,
                    tool_router=tool_router,
                    tool_exposure=tool_exposure,
                    plan_state=current_plan_state,
                    turn_id=turn_id,
                    activity_events=activity_events,
                    turn_items=turn_items,
                    provider_id=block.provider_id,
                    response_id=turn_result.response_id,
                    metadata=dict(block.metadata),
                    record_assistant_call=False,
                )

            flush_pending_text(record_conversation=not tool_call_blocks)

        return (
            current_plan_state,
            turn_has_tool_call,
            turn_text_chunks,
            None,
        )

    def _append_turn_item(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        item: TurnItem,
    ) -> None:
        turn_items.append(item)
        self._trace_service.append(
            self._config.session_id,
            RuntimeTraceEvent(
                kind="turn_item",
                turn_id=turn_id,
                payload=item.to_dict(),
            ),
        )

    def _timestamp(self) -> str:
        return datetime.now(UTC).isoformat()

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
        turn = TurnRecord(
            thread_id=self._config.session_id,
            turn_id=turn_id,
            status=status,
            started_at=started_at,
            completed_at=self._timestamp() if status is not TurnStatus.IN_PROGRESS else None,
            stop_reason=stop_reason,
            user_message=user_message,
            items=tuple(turn_items),
        )
        self._session_service.save_turn_record(self._config.session_id, turn)
        self._trace_service.append(
            self._config.session_id,
            RuntimeTraceEvent(
                kind="turn_state",
                turn_id=turn_id,
                payload={
                    "status": status.value,
                    "stop_reason": None if stop_reason is None else stop_reason.value,
                },
            ),
        )
        return turn

    def _history_item_type_for_turn_item(self, item: TurnItem) -> HistoryItemType:
        return HistoryItemType(item.type.value)

    def _history_items_from_turn(self, turn: TurnRecord) -> tuple[HistoryItem, ...]:
        history_items: list[HistoryItem] = []
        for index, item in enumerate(turn.items, start=1):
            history_items.append(
                HistoryItem(
                    id=f"{turn.turn_id}:item:{index}",
                    thread_id=turn.thread_id,
                    turn_id=turn.turn_id,
                    type=self._history_item_type_for_turn_item(item),
                    text=item.text,
                    tool_name=item.tool_name,
                    call_id=item.call_id,
                    metadata=dict(item.metadata),
                )
            )
            file_changes = item.metadata.get("file_changes")
            if not isinstance(file_changes, list):
                continue
            for change_index, change in enumerate(file_changes, start=1):
                if not isinstance(change, dict):
                    continue
                path = change.get("path") or change.get("destination")
                text = f"File change: {path}" if isinstance(path, str) else "File change recorded"
                history_items.append(
                    HistoryItem(
                        id=f"{turn.turn_id}:file-change:{index}:{change_index}",
                        thread_id=turn.thread_id,
                        turn_id=turn.turn_id,
                        type=HistoryItemType.FILE_CHANGE,
                        text=text,
                        tool_name=item.tool_name,
                        call_id=item.call_id,
                        metadata=dict(change),
                    )
                )
        return tuple(history_items)

    def _context_baseline_from_contract(
        self,
        contract: InstructionContract | None,
    ) -> ContextBaseline | None:
        if contract is None:
            return None

        excluded_kinds = {"conversation_context", "memory", "plan", "user_request"}
        fragments: list[BaselineFragment] = []
        for index, section in enumerate(contract.developer_sections, start=1):
            fragments.append(
                BaselineFragment(
                    id=f"developer:{index}",
                    kind=str(section.kind),
                    title=section.title,
                    content=section.content,
                    source=section.source,
                    metadata=dict(section.metadata),
                )
            )
        contextual_index = 0
        for section in contract.contextual_user_sections:
            if str(section.kind) in excluded_kinds:
                continue
            contextual_index += 1
            fragments.append(
                BaselineFragment(
                    id=f"contextual:{contextual_index}",
                    kind=str(section.kind),
                    title=section.title,
                    content=section.content,
                    source=section.source,
                    metadata=dict(section.metadata),
                )
            )
        if not fragments:
            return None
        return ContextBaseline(
            thread_id=self._config.session_id,
            fragments=tuple(fragments),
        )

    def _continuation_state_payload(self) -> dict[str, object]:
        getter = getattr(self._model_adapter, "get_continuation_state", None)
        if not callable(getter):
            return {}
        state = getter()
        if state is None:
            return {}
        if isinstance(state, ResponsesContinuationState):
            return state.to_dict()
        return {}

    def _persist_structured_runtime_state(
        self,
        *,
        turn: TurnRecord,
        started_at: str,
        context_baseline: ContextBaseline | None,
    ) -> None:
        history_items = self._history_items_from_turn(turn)
        if history_items:
            self._session_service.append_history_items(
                self._config.session_id,
                history_items,
            )

        previous_baseline = self._session_service.load_context_baseline(self._config.session_id)
        if context_baseline is not None and context_baseline != previous_baseline:
            self._session_service.save_context_baseline(
                self._config.session_id,
                context_baseline,
            )
            self._session_service.append_history_items(
                self._config.session_id,
                (
                    HistoryItem(
                        id=f"{turn.turn_id}:baseline",
                        thread_id=turn.thread_id,
                        turn_id=turn.turn_id,
                        type=HistoryItemType.CONTEXT_BASELINE_UPDATE,
                        text="Updated context baseline",
                        metadata={
                            "fragment_ids": [fragment.id for fragment in context_baseline.fragments],
                            "fragment_kinds": [fragment.kind for fragment in context_baseline.fragments],
                        },
                    ),
                ),
            )

        rollout_trace_events = self._trace_service.load_for_turn(
            self._config.session_id,
            turn.turn_id,
        )
        rollout = TurnRollout(
            thread_id=turn.thread_id,
            turn_id=turn.turn_id,
            status=turn.status,
            started_at=started_at,
            completed_at=turn.completed_at,
            stop_reason=turn.stop_reason,
            events=tuple(
                TurnRolloutEvent(
                    event_id=f"{turn.turn_id}:trace:{index}",
                    kind=event.kind,
                    created_at=turn.completed_at or started_at,
                    payload=event.payload,
                )
                for index, event in enumerate(rollout_trace_events, start=1)
            ),
            continuation_state=self._continuation_state_payload(),
        )
        self._session_service.append_turn_rollout(self._config.session_id, rollout)
        self._session_service.sync_conversation_view_from_history(self._config.session_id)

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
        activity_events = list(response.activity_events)
        if status is not TurnStatus.WAITING_APPROVAL:
            expired_events = self._dynamic_tool_registry.expire_turn_scoped()
            if expired_events:
                self._append_dynamic_tool_lifecycle_events(
                    turn_id=turn_id,
                    turn_items=turn_items,
                    activity_events=activity_events,
                    lifecycle_events=expired_events,
                )
        self._session_service.save_dynamic_tool_state(
            self._config.session_id,
            self._dynamic_tool_registry.snapshot(),
        )
        turn = self._persist_turn_record(
            turn_id=turn_id,
            user_message=user_message,
            started_at=started_at,
            status=status,
            stop_reason=stop_reason,
            turn_items=turn_items,
        )
        self._persist_structured_runtime_state(
            turn=turn,
            started_at=started_at,
            context_baseline=context_baseline,
        )
        return replace(response, turn=turn, activity_events=tuple(activity_events))

    def _policy_decision(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        step_index: int,
    ) -> tuple[int, ReasoningEffort, tuple[str, ...], dict[str, object], bool, str | None, TurnResponse | None]:
        decision = self._runtime_policy.evaluate(
            user_message=user_message,
            conversation=conversation,
            plan_state=plan_state,
            step_index=step_index,
            configured_max_steps=self._config.max_steps,
            configured_reasoning_effort=self._config.reasoning_effort,
        )
        stage_message = self._runtime_policy.decision_stage_message(
            user_message=user_message,
            conversation=conversation,
            force_answer=decision.force_answer,
        )
        early_response = None
        if decision.stop_reason is not None and decision.assistant_message:
            early_response = TurnResponse(assistant_message=decision.assistant_message)
        return (
            decision.max_steps,
            decision.reasoning_effort,
            decision.reminders,
            decision.policy_state,
            decision.force_answer,
            stage_message,
            early_response,
        )

    def _append_runtime_policy_activity(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        activity_events: list[ActivityEvent],
        policy_state: dict[str, object],
    ) -> None:
        if not policy_state:
            return
        profile_name = policy_state.get("profile_name", "general")
        evidence_status = policy_state.get("evidence_status", "unknown")
        path_bias = policy_state.get("path_bias", "balanced")
        planning_mode = policy_state.get("planning_mode", "plan_if_needed")
        plan_status = policy_state.get("plan_status", "none")
        text = (
            "Planning: runtime policy "
            f"profile={profile_name} path_bias={path_bias} evidence={evidence_status} "
            f"planning={planning_mode} plan={plan_status}"
        )
        if turn_items and turn_items[-1].type is TurnItemType.REASONING and turn_items[-1].text == text:
            return
        activity_events.append(ActivityEvent(kind="runtime_policy", message=text))
        self._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(type=TurnItemType.REASONING, text=text, metadata=dict(policy_state)),
        )
        self._trace_service.append(
            self._config.session_id,
            RuntimeTraceEvent(
                kind="runtime_policy",
                turn_id=turn_id,
                payload=dict(policy_state),
            ),
        )

    def _append_structured_repo_activity(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        activity_events: list[ActivityEvent],
        stage_message: str | None,
    ) -> None:
        if not stage_message:
            return
        text = f"Planning: {stage_message}"
        if turn_items and turn_items[-1].type is TurnItemType.REASONING and turn_items[-1].text == text:
            return
        activity_events.append(ActivityEvent(kind="planning", message=text))
        self._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(type=TurnItemType.REASONING, text=text),
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
        if call.name != "update_plan":
            return plan_state
        items = result_payload.get("items", [])
        if not isinstance(items, list):
            return plan_state
        next_plan = self._planning_service.replace(items)
        self._session_service.save_plan_state(self._config.session_id, next_plan)
        return next_plan

    def _complete_task_if_active(
        self,
        plan_state: PlanState,
        item_id: str | None,
    ) -> PlanState:
        if item_id is None:
            return plan_state
        current_item_id = plan_state.current_in_progress_item_id()
        if current_item_id != item_id:
            return plan_state
        return self._planning_service.mark_completed(plan_state, item_id)

    def _pending_decision_from_approval(
        self,
        approval: PendingApproval,
    ) -> PendingDecision:
        options = [DecisionAction.APPROVE_ONCE, DecisionAction.REJECT]
        if approval.command_pattern:
            options.append(DecisionAction.ALLOW_SESSION)
        return PendingDecision(
            tool_call=approval.tool_call,
            kind=self._approval_service._safety_policy.evaluate(approval.tool_call).kind,
            reason=approval.reason,
            preview=approval.preview,
            options=tuple(options),
            command_pattern=approval.command_pattern,
        )

    def _format_allowed_choices(self, options: tuple[DecisionAction, ...]) -> str:
        choice_to_action = {
            "1": DecisionAction.APPROVE_ONCE,
            "2": DecisionAction.REJECT,
            "3": DecisionAction.ALLOW_SESSION,
        }
        allowed_choices = tuple(
            key for key, action in choice_to_action.items() if action in options
        )
        if len(allowed_choices) == 1:
            return allowed_choices[0]
        if len(allowed_choices) == 2:
            return f"{allowed_choices[0]} or {allowed_choices[1]}"
        return ", ".join(allowed_choices[:-1]) + f", or {allowed_choices[-1]}"

    def handle_user_turn(self, user_message: str) -> TurnResponse:
        from mycli.application.runtime.turn_executor import TurnExecutor

        return TurnExecutor(self).execute_user_turn(user_message)

    def resolve_pending_approval(self, choice: str) -> TurnResponse:
        from mycli.application.runtime.turn_executor import TurnExecutor

        return TurnExecutor(self).resolve_pending_approval(choice)
