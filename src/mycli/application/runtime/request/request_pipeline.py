from __future__ import annotations

from mycli.domain.logging import LogLevel
from mycli.domain.runtime import (
    AgentConfig,
    ExecutionContext,
    InstructionContract,
    RequestShape,
    RuntimeItem,
    RuntimeTraceEvent,
    TurnContext,
)
from mycli.llms.adapters.base import ModelMessage, ModelToolDefinition
from mycli.prompts.react import build_react_prompt
from mycli.prompts.system import build_system_prompt
from mycli.application.runtime.request.cache_shape_diagnostics import CacheShapeDiagnostics
from mycli.application.runtime.request.cache_shape_diagnostics import RequestShapeDiagnostic
from mycli.application.runtime.request.request_shape_builder import RequestShapeBuilder
from mycli.application.runtime.request.request_shape_payload_formatter import (
    RequestShapePayloadFormatter,
)
from mycli.services.context.instruction_contract_assembler import InstructionContractAssembler
from mycli.services.tracing import TraceService
from mycli.utils.workspace_logger import WorkspaceLogService


class RequestPipeline:
    """Builds model requests and records request-shape diagnostics."""

    def __init__(
        self,
        *,
        config: AgentConfig,
        instruction_contract_assembler: InstructionContractAssembler,
        request_shape_builder: RequestShapeBuilder,
        request_shape_payload_formatter: RequestShapePayloadFormatter,
        trace_service: TraceService,
        workspace_log_service: WorkspaceLogService,
    ) -> None:
        self._config = config
        self._instruction_contract_assembler = instruction_contract_assembler
        self._request_shape_builder = request_shape_builder
        self._request_shape_payload_formatter = request_shape_payload_formatter
        self._trace_service = trace_service
        self._workspace_log_service = workspace_log_service
        self._cache_shape_diagnostics = CacheShapeDiagnostics()
        self._previous_request_shape: RequestShape | None = None

    def set_config(self, config: AgentConfig) -> None:
        self._config = config

    def runtime_items(self, *, request_shape: RequestShape) -> list[RuntimeItem]:
        return self._request_shape_payload_formatter.runtime_items(request_shape)

    def legacy_messages(self, *, request_shape: RequestShape) -> list[ModelMessage]:
        return self._request_shape_payload_formatter.legacy_messages(request_shape)

    def assemble_instruction_contract(
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
        stable_action_guidance = build_react_prompt()
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

    def build_and_trace_request_shape(
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

    def trace_cache_shape_diagnostic(
        self,
        *,
        turn_id: str,
        request_shape: RequestShape,
        usage: dict[str, object] | None,
    ) -> RequestShapeDiagnostic:
        diagnostic = self._cache_shape_diagnostics.build(
            current=request_shape,
            previous=self._previous_request_shape,
            usage=usage,
        )
        payload = diagnostic.to_dict()
        self._trace_service.append(
            self._config.session_id,
            RuntimeTraceEvent(
                kind="cache_shape_diagnostic",
                turn_id=turn_id,
                payload=payload,
            ),
        )
        self._workspace_log_service.log(
            level=LogLevel.INFO,
            event="cache_shape_diagnostic",
            message="Recorded cache shape diagnostic",
            context={
                "session_id": self._config.session_id,
                "turn_id": turn_id,
                "cache_hit_ratio": payload["cache_hit_ratio"],
                "first_changed_fragment_id": payload["first_changed_fragment_id"],
                "first_changed_provider_message_index": payload[
                    "first_changed_provider_message_index"
                ],
            },
        )
        self._previous_request_shape = request_shape
        return diagnostic
