from __future__ import annotations

from mycli.domain.logging import LogLevel
from mycli.domain.runtime import (
    AgentConfig,
    ExecutionContext,
    InstructionContract,
    ProviderMessageShape,
    ProviderProjectionShape,
    ProviderRuntimeItemShape,
    RequestShape,
    RuntimeBlock,
    RuntimeItem,
    RuntimeTraceEvent,
    TurnContext,
    stable_hash,
)
from mycli.infrastructure.providers import resolve_provider_cache_policy_capability
from mycli.llms.adapters.base import ModelMessage, ModelToolDefinition
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
        self._previous_contextual_section_hashes: dict[str, str] = {}

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
        base_instructions: str,
    ) -> InstructionContract:
        contract = self._instruction_contract_assembler.assemble(
            turn_context=turn_context,
            base_instructions=base_instructions,
            conversation_messages=context.conversation_messages,
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
        self._trace_context_diagnostics(
            turn_id=turn_id,
            context=context,
            turn_context=turn_context,
        )
        return contract

    def _trace_context_diagnostics(
        self,
        *,
        turn_id: str,
        context: ExecutionContext,
        turn_context: TurnContext,
    ) -> None:
        enabled_sections = turn_context.enabled_sections()
        section_lengths = {
            section.type.value: len(section.content) for section in enabled_sections
        }
        cache_classes = {
            section.type.value: section.cache_class.value for section in enabled_sections
        }
        cache_boundary = "|".join(
            f"{section.type.value}:{section.cache_class.value}:{len(section.content)}"
            for section in enabled_sections
        )
        summary_count = sum(
            1
            for record in context.memory_records
            if getattr(record.kind, "value", str(record.kind)) == "session_summary"
        )
        payload = {
            "section_count": len(enabled_sections),
            "section_lengths": section_lengths,
            "cache_classes": cache_classes,
            "cache_zone_fingerprint": stable_hash(cache_boundary),
            "estimated_context_chars": sum(section_lengths.values()),
            "estimated_context_tokens": max(1, sum(section_lengths.values()) // 4),
            "context_file": _bounded_context_file_diagnostics(
                context.context_file_diagnostics
            ),
            "session_summary_count": summary_count,
        }
        self._trace_service.append(
            self._config.session_id,
            RuntimeTraceEvent(
                kind="context_diagnostics",
                turn_id=turn_id,
                payload=payload,
            ),
        )
    def build_and_trace_request_shape(
        self,
        *,
        turn_id: str,
        contract: InstructionContract,
        tools: list[ModelToolDefinition],
    ) -> RequestShape:
        cache_policy_capability = resolve_provider_cache_policy_capability(
            provider=self._config.provider,
            base_url=self._config.api_base_url,
            override=self._config.cache_policy_capability,
        )
        shape = self._request_shape_builder.build(
            config=self._config,
            contract=contract,
            tools=tools,
            cache_policy_capability=cache_policy_capability,
        )
        shape = self._apply_context_delta_projection(
            shape=shape,
            contract=contract,
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
        self._previous_contextual_section_hashes = self._contextual_section_hashes(
            request_shape
        )
        return diagnostic

    def _apply_context_delta_projection(
        self,
        *,
        shape: RequestShape,
        contract: InstructionContract,
    ) -> RequestShape:
        if not self._previous_contextual_section_hashes:
            return shape
        delta_context = self._delta_context_by_cache_class(contract)
        if delta_context is None:
            return shape
        messages = self._replace_contextual_messages(
            messages=shape.provider_messages,
            delta_context=delta_context,
        )
        runtime_items = self._replace_contextual_runtime_items(
            items=shape.provider_runtime_items,
            delta_context=delta_context,
        )
        return RequestShape(
            provider=shape.provider,
            protocol=shape.protocol,
            model=shape.model,
            stable_system=shape.stable_system,
            wire_instructions=shape.wire_instructions,
            tool_schema_hash=shape.tool_schema_hash,
            tool_order_hash=shape.tool_order_hash,
            fragments=shape.fragments,
            provider_messages=messages,
            provider_runtime_items=runtime_items,
            provider_projection=self._projection_with_counts(
                shape=shape,
                message_count=len(messages),
                runtime_item_count=len(runtime_items),
            ),
            provider_request_policy=shape.provider_request_policy,
        )

    def _projection_with_counts(
        self,
        *,
        shape: RequestShape,
        message_count: int,
        runtime_item_count: int,
    ) -> ProviderProjectionShape | None:
        projection = shape.provider_projection
        if projection is None:
            return None
        return ProviderProjectionShape(
            lane=projection.lane,
            message_count=message_count,
            runtime_item_count=runtime_item_count,
            cacheable_prefix_fragment_count=projection.cacheable_prefix_fragment_count,
            first_dynamic_fragment_index=projection.first_dynamic_fragment_index,
            first_ephemeral_fragment_index=projection.first_ephemeral_fragment_index,
            cache_hint=projection.cache_hint,
            wire_only_hints=projection.wire_only_hints,
        )

    def _delta_context_by_cache_class(
        self,
        contract: InstructionContract,
    ) -> dict[str, str] | None:
        previous = self._previous_contextual_section_hashes
        changed_sections = [
            section
            for section in contract.contextual_user_sections
            if self._contextual_section_key(section) not in previous
            or previous[self._contextual_section_key(section)]
            != stable_hash(section.content.strip())
        ]
        if len(changed_sections) == len(contract.contextual_user_sections):
            return None
        delta: dict[str, list[str]] = {"static": [], "dynamic": [], "ephemeral": []}
        for section in changed_sections:
            content = section.content.strip()
            if not content:
                continue
            delta.setdefault(self._cache_class(section), []).append(content)
        return {
            cache_class: "\n".join(parts)
            for cache_class, parts in delta.items()
            if parts
        }

    def _replace_contextual_messages(
        self,
        *,
        messages: tuple[ProviderMessageShape, ...],
        delta_context: dict[str, str],
    ) -> tuple[ProviderMessageShape, ...]:
        replaced: list[ProviderMessageShape] = []
        for message in messages:
            cache_class = self._context_message_cache_class(message)
            if cache_class is None:
                replaced.append(message)
                continue
            content = delta_context.get(cache_class, "")
            if content:
                replaced.append(
                    ProviderMessageShape(
                        role=message.role,
                        content=content,
                        metadata=message.metadata,
                    )
                )
        return tuple(replaced)

    def _replace_contextual_runtime_items(
        self,
        *,
        items: tuple[ProviderRuntimeItemShape, ...],
        delta_context: dict[str, str],
    ) -> tuple[ProviderRuntimeItemShape, ...]:
        replaced: list[ProviderRuntimeItemShape] = []
        for item in items:
            cache_class = self._context_item_cache_class(item)
            if cache_class is None:
                replaced.append(item)
                continue
            content = delta_context.get(cache_class, "")
            if content:
                replaced.append(
                    ProviderRuntimeItemShape(
                        role=item.role,
                        blocks=(RuntimeBlock(type="text", text=content),),
                        metadata=item.metadata,
                    )
                )
        return tuple(replaced)

    def _context_message_cache_class(self, message: ProviderMessageShape) -> str | None:
        if message.metadata.get("source") != "provider_context_projection":
            return None
        cache_class = message.metadata.get("cache_class")
        if isinstance(cache_class, str):
            return cache_class
        return None

    def _context_item_cache_class(self, item: ProviderRuntimeItemShape) -> str | None:
        if item.metadata.get("source") != "provider_context_projection":
            return None
        cache_class = item.metadata.get("cache_class")
        if isinstance(cache_class, str):
            return cache_class
        return None

    def _contextual_section_hashes(
        self,
        shape: RequestShape,
    ) -> dict[str, str]:
        hashes: dict[str, str] = {}
        for fragment in shape.fragments:
            kind = fragment.metadata.get("instruction_fragment_kind")
            if not kind:
                continue
            key = f"{kind}:{fragment.metadata.get('source') or ''}"
            hashes[key] = fragment.content_hash
        return hashes

    def _contextual_section_key(self, section: object) -> str:
        kind = str(getattr(section, "kind", ""))
        source = getattr(section, "source", None)
        return f"{kind}:{source or ''}"

    def _cache_class(self, section: object) -> str:
        metadata = getattr(section, "metadata", None)
        if isinstance(metadata, dict):
            value = metadata.get("cache_class")
            if isinstance(value, str) and value:
                return value
        return "dynamic"


def _bounded_context_file_diagnostics(value: dict[str, object]) -> dict[str, object]:
    return {
        "selected_source": value.get("selected_source"),
        "path_present": bool(value.get("path")),
        "truncated": value.get("truncated") is True,
        "blocked": value.get("blocked") is True,
        "original_length": value.get("original_length", 0),
        "rendered_length": value.get("rendered_length", 0),
        "issues": value.get("issues", ()),
    }
