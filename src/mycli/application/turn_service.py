from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
import json
from pathlib import Path
from typing import Any, cast

from mycli.domain.conversation import Conversation, Message
from mycli.domain.logging import LogLevel
from mycli.domain.runtime import (
    AgentConfig,
    DecisionAction,
    HistoryItem,
    HistoryItemType,
    RuntimeTraceEvent,
    RuntimeStreamEvent,
    TurnItemType,
    TurnResponse,
    ViewMode,
)
from mycli.domain.subagents import SubAgentRunSummary
from mycli.services.context.instruction_contract_assembler import InstructionContractAssembler
from mycli.services.context.turn_context_assembler import TurnContextAssembler
from mycli.services.file_history import FileHistoryService
from mycli.memory.service import MemoryService
from mycli.services.observability import ObservabilityService
from mycli.services.session_service import SessionService
from mycli.services.extensions import ExtensionManifestService
from mycli.services.skills import SkillRegistry
from mycli.services.tracing import TraceService


def format_subagent_summaries(summaries: tuple[SubAgentRunSummary, ...]) -> str:
    if not summaries:
        return "No sub-agent runs in this session."
    return "\n".join(
        (
            f"{summary.agent_type} {summary.status} tools={summary.tool_calls} "
            f"{summary.child_session_id} description={summary.description[:80]}"
        )
        for summary in summaries
    )


class TurnService:
    def __init__(
        self,
        config: AgentConfig | None = None,
        home_dir: Path | None = None,
        runtime: Any | None = None,
    ) -> None:
        if config is None:
            raise ValueError("config is required")
        if home_dir is None:
            raise ValueError("home_dir is required")
        if runtime is None:
            raise ValueError("runtime is required")

        self._runtime = runtime
        self._tool_registry = getattr(runtime, "_tool_registry", None)
        self._model_client = getattr(runtime, "_model_adapter", None)
        self._safety_policy = getattr(runtime, "_approval_service", None)
        self._config = getattr(runtime, "_config", config)
        self._memory_service = getattr(
            runtime,
            "_memory_service",
            MemoryService(home_dir=home_dir, workspace_root=config.workspace_root),
        )
        self._session_service = getattr(
            runtime,
            "_session_service",
            SessionService(home_dir=home_dir),
        )
        self._context_window_service = None
        self._skill_registry = getattr(
            runtime,
            "_skill_registry",
            SkillRegistry(
                builtin_root=Path(__file__).resolve().parents[1] / "prompts" / "skills",
                user_root=home_dir / ".mycli" / "skills",
                repo_root=config.workspace_root / ".mycli" / "skills",
            ),
        )
        self._trace_service = getattr(
            runtime,
            "_trace_service",
            TraceService(home_dir=home_dir),
        )
        self._extension_manifest_service = getattr(
            runtime,
            "_extension_manifest_service",
            ExtensionManifestService(),
        )
        self._observability_service = getattr(
            runtime,
            "_observability_service",
            ObservabilityService(),
        )
        self._file_history_service = getattr(
            runtime,
            "_file_history_service",
            FileHistoryService(home_dir=home_dir, workspace_root=self._config.workspace_root),
        )
        self._turn_context_assembler = getattr(
            runtime,
            "_turn_context_assembler",
            TurnContextAssembler(),
        )
        self._instruction_contract_assembler = getattr(
            runtime,
            "_instruction_contract_assembler",
            InstructionContractAssembler(),
        )

    def _available_tool_names(self) -> tuple[str, ...]:
        assert self._tool_registry is not None
        return tuple(self._tool_registry.list_names())

    def close(self) -> None:
        close = getattr(self._runtime, "close", None)
        if callable(close):
            close()

    def inspect_logs(self) -> tuple[str, ...]:
        log_service = getattr(self._runtime, "_workspace_log_service", None)
        if log_service is None:
            return ("workspace log service is not configured",)
        return tuple(log_service.inspect_logs())

    def record_turn_interrupt_request(
        self,
        *,
        client_turn_id: str | None = None,
        source: str = "node_tui_gateway",
    ) -> None:
        turn_id = client_turn_id or "interrupt_request"
        payload = {
            "session_id": self._config.session_id,
            "client_turn_id": client_turn_id,
            "requested": True,
            "source": source,
        }
        self._trace_service.append(
            self._config.session_id,
            RuntimeTraceEvent(kind="turn_interrupt_requested", turn_id=turn_id, payload=payload),
        )
        log_service = getattr(self._runtime, "_workspace_log_service", None)
        if log_service is not None:
            log_service.log(
                level=LogLevel.WARNING,
                event="turn_interrupt_requested",
                message="Turn interrupt requested.",
                context=payload,
            )

    def _format_allowed_choices(self, options: tuple[DecisionAction, ...]) -> str:
        choice_to_action = {
            "1": DecisionAction.APPROVE_ONCE,
            "2": DecisionAction.REJECT,
            "3": DecisionAction.ALLOW_SESSION,
        }
        allowed_choices = tuple(
            key for key, action in choice_to_action.items()
            if action in options
        )
        if len(allowed_choices) == 1:
            return allowed_choices[0]
        if len(allowed_choices) == 2:
            return f"{allowed_choices[0]} or {allowed_choices[1]}"
        return ", ".join(allowed_choices[:-1]) + f", or {allowed_choices[-1]}"

    def handle_user_turn(
        self,
        user_message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        runtime = self._runtime
        if runtime is None:
            raise RuntimeError("TurnService has no runtime.")
        if stream_sink is None:
            return cast(TurnResponse, runtime.handle_user_turn(user_message))
        return cast(TurnResponse, runtime.handle_user_turn(user_message, stream_sink=stream_sink))

    def resolve_pending_decision(self, choice: str) -> TurnResponse:
        runtime = self._runtime
        if runtime is None:
            raise RuntimeError("TurnService has no runtime.")
        return cast(TurnResponse, runtime.resolve_pending_approval(choice))

    def resolve_pending_clarification(self, request_id: str, response: str) -> TurnResponse:
        runtime = self._runtime
        if runtime is None:
            raise RuntimeError("TurnService has no runtime.")
        return cast(
            TurnResponse,
            runtime.resolve_pending_clarification(
                request_id=request_id,
                response=response,
            ),
        )

    def confirm_pending_action(self) -> TurnResponse:
        return self.resolve_pending_decision("1")

    def reject_pending_action(self) -> TurnResponse:
        return self.resolve_pending_decision("2")

    def inspect_plan(self) -> tuple[str, ...]:
        plan_state = self._session_service.load_plan_state(self._config.session_id)
        if not plan_state.items:
            return ("no active plan",)
        return tuple(f"{item.status.value}: {item.content}" for item in plan_state.items)

    def inspect_subagents(self, child_session_id: str | None = None) -> tuple[str, ...]:
        if child_session_id:
            inspect = getattr(self._runtime, "inspect_subagent_transcript", None)
            if callable(inspect):
                return tuple(inspect(child_session_id))
            return (f"sub-agent transcript not found: {child_session_id}",)
        recent = getattr(self._runtime, "recent_subagents", None)
        if not callable(recent):
            return ("No sub-agent runs in this session.",)
        return tuple(format_subagent_summaries(recent()).splitlines())

    def inspect_skills(self) -> tuple[str, ...]:
        lines: list[str] = []
        for name in self._skill_registry.list_names():
            metadata = self._skill_registry.get_metadata(name)
            if metadata is None:
                continue
            lines.append(f"{metadata.name}: {metadata.description}")
        return tuple(lines or ("no skills available",))

    def inspect_tools(self) -> tuple[str, ...]:
        manifest = self.extension_manifest()
        tool_manifest = _mapping_value(manifest, "tool_manifest")
        tools = _list_value(tool_manifest, "tools")
        lines: list[str] = []
        for tool in tools:
            if not isinstance(tool, dict):
                continue
            name = _string_value(tool, "name", default="unknown")
            source = _string_value(tool, "source", default="unknown")
            toolset = _string_value(tool, "toolset", default="unknown")
            risk = _string_value(tool, "risk_level", default="unknown")
            approval = _string_value(tool, "approval_policy", default="unknown")
            availability = _mapping_value(tool, "availability")
            status = _string_value(availability, "status", default="unknown")
            lines.append(
                f"{name} source={source} toolset={toolset} "
                f"risk={risk} availability={status} approval={approval}"
            )
        return tuple(lines or ("no tools available",))

    def inspect_hooks(self) -> tuple[str, ...]:
        inspect = getattr(self._runtime, "inspect_hooks", None)
        if callable(inspect):
            return tuple(inspect())
        return ("hook diagnostics not available",)

    def inspect_toolsets(self) -> tuple[str, ...]:
        manifest = self.extension_manifest()
        toolset_manifest = _mapping_value(manifest, "toolset_manifest")
        toolsets = _list_value(toolset_manifest, "toolsets")
        conflicts = _list_value(toolset_manifest, "conflicts")
        lines: list[str] = []
        for toolset in toolsets:
            if not isinstance(toolset, dict):
                continue
            toolset_id = _string_value(toolset, "id", default="unknown")
            enabled = str(toolset.get("enabled") is True).lower()
            sources = ",".join(_string_items(_list_value(toolset, "sources"))) or "none"
            tools = ",".join(_string_items(_list_value(toolset, "tools"))) or "none"
            related_conflicts = [
                item for item in conflicts if _conflict_mentions_toolset(item, toolset_id)
            ]
            lines.append(
                f"{toolset_id} enabled={enabled} sources={sources} "
                f"tools={tools} conflicts={len(related_conflicts)}"
            )
        return tuple(lines or ("no toolsets available",))

    def inspect_bashes(self) -> tuple[str, ...]:
        from mycli.tools.shell_registry import SHELL_REGISTRY

        rows = SHELL_REGISTRY.list()
        if not rows:
            return ("no background shells",)
        return tuple(
            f"{row['shell_id']} {row['status']} exit={row['exit_code']} {row['command']}"
            for row in rows
        )

    def inspect_file_changes(self) -> tuple[str, ...]:
        rows = self._file_history_service.list_snapshots(
            session_id=self._config.session_id,
            limit=10,
        )
        if not rows:
            return ("no file changes",)
        return tuple(
            (
                f"{row['snapshot_id']} {row['turn_id']} "
                f"{row['tool_name']} {', '.join(cast('tuple[str, ...]', row['paths']))}"
            )
            for row in rows
        )

    def inspect_memory(self) -> tuple[str, ...]:
        records = self._memory_service.list_records(self._config.session_id)
        lines = [f"{record.kind.value} {record.key}={record.value}" for record in records[:10]]
        if not lines:
            return ("no memory stored",)
        return tuple(lines)

    def inspect_session(self) -> tuple[str, ...]:
        conversation = self._session_service.load_conversation(self._config.session_id)
        plan_state = self._session_service.load_plan_state(self._config.session_id)
        pending_decision = self._session_service.load_pending_decision(self._config.session_id)
        suspended = self._session_service.load_suspended_turn(self._config.session_id)
        allowances = self._session_service.load_command_allowances(self._config.session_id)
        return (
            f"session={self._config.session_id}",
            f"messages={len(conversation.messages)}",
            f"plan_items={len(plan_state.items)}",
            f"pending_decision={'yes' if pending_decision is not None else 'no'}",
            f"suspended_turn={'yes' if suspended is not None else 'no'}",
            f"allowances={len(allowances)}",
        )

    def resume_session(self, session_id: str | None = None) -> tuple[str, ...]:
        target_session_id = (session_id or self._config.session_id).strip() or self._config.session_id
        try:
            conversation = self._session_service.resume_conversation(target_session_id)
        except KeyError:
            self._trace_session_continuity(
                action="resume",
                result="not_found",
                requested_session_id=target_session_id,
                resolved_session_id=target_session_id,
                message_count=0,
                fork_point=None,
            )
            return (f"session not found: {target_session_id}",)
        self._backfill_history_from_conversation(conversation)
        resolved_session_id = conversation.session_id
        self._activate_session(resolved_session_id)
        self._trace_session_continuity(
            action="resume",
            result="resolved",
            requested_session_id=target_session_id,
            resolved_session_id=resolved_session_id,
            message_count=len(conversation.messages),
            fork_point=conversation.fork_point,
        )
        return (
            f"resumed {resolved_session_id}",
            f"messages={len(conversation.messages)}",
        )

    def fork_session(
        self,
        source_session_id: str | None = None,
        new_session_id: str | None = None,
        fork_point: int | None = None,
    ) -> tuple[str, ...]:
        source = (source_session_id or self._config.session_id).strip() or self._config.session_id
        target = (
            new_session_id.strip()
            if isinstance(new_session_id, str) and new_session_id.strip()
            else f"{source}-fork"
        )
        try:
            conversation = self._session_service.fork_conversation(
                source,
                target,
                fork_point=fork_point,
            )
        except (KeyError, ValueError) as exc:
            self._trace_session_continuity(
                action="fork",
                result="failed",
                requested_session_id=source,
                resolved_session_id=target,
                message_count=0,
                fork_point=fork_point,
            )
            return (str(exc),)
        self._backfill_history_from_conversation(conversation)
        self._activate_session(target)
        self._trace_session_continuity(
            action="fork",
            result="created",
            requested_session_id=source,
            resolved_session_id=target,
            message_count=len(conversation.messages),
            fork_point=conversation.fork_point,
        )
        return (
            f"forked {source} -> {target}",
            f"fork_point={conversation.fork_point}",
            f"messages={len(conversation.messages)}",
        )

    def _trace_session_continuity(
        self,
        *,
        action: str,
        result: str,
        requested_session_id: str,
        resolved_session_id: str,
        message_count: int,
        fork_point: int | None,
    ) -> None:
        pending_decision = self._session_service.load_pending_decision(resolved_session_id)
        suspended = self._session_service.load_suspended_turn(resolved_session_id)
        payload = {
            "action": action,
            "result": result,
            "requested_session_id": requested_session_id,
            "resolved_session_id": resolved_session_id,
            "lineage_switched": requested_session_id != resolved_session_id,
            "message_count": max(0, message_count),
            "fork_point": fork_point,
            "pending_decision": pending_decision is not None,
            "pending_clarification": bool(
                suspended is not None and suspended.pending_clarification is not None
            ),
        }
        self._trace_service.append(
            resolved_session_id,
            RuntimeTraceEvent(
                kind="session_continuity",
                turn_id=f"session_{action}",
                payload=payload,
            ),
        )

    def _activate_session(self, session_id: str) -> None:
        self._config = replace(self._config, session_id=session_id)
        if self._runtime is not None:
            self._runtime.rebind_session(self._config)

    def _backfill_history_from_conversation(self, conversation: Conversation) -> None:
        if self._session_service.load_history_items(conversation.session_id):
            return
        items: list[HistoryItem] = []
        turn_index = 0
        for message_index, message in enumerate(conversation.messages, start=1):
            item_type = _history_type_for_message(message)
            if item_type is None:
                continue
            if item_type is HistoryItemType.USER_MESSAGE:
                turn_index += 1
            turn_id = f"backfill_{turn_index or 1}"
            items.append(
                HistoryItem(
                    id=f"{turn_id}:message:{message_index}",
                    thread_id=conversation.session_id,
                    turn_id=turn_id,
                    type=item_type,
                    text=message.content,
                    tool_name=_tool_name_for_message(message),
                    call_id=message.tool_call_id,
                    metadata={},
                )
            )
        if items:
            self._session_service.append_history_items(
                conversation.session_id,
                tuple(items),
            )

    def inspect_sessions(self) -> tuple[str, ...]:
        overviews = self._session_service.list_sessions(limit=10)
        if not overviews:
            return ("no saved sessions",)
        lines: list[str] = []
        for overview in overviews:
            current_marker = "*" if overview.session_id == self._config.session_id else " "
            lines.append(
                f"{current_marker} {overview.session_id} {overview.status} "
                f"messages={overview.message_count} summaries={overview.summary_count}"
            )
        return tuple(lines)

    def inspect_session_maintenance(self) -> tuple[str, ...]:
        return self._session_service.inspect_session_maintenance()

    def apply_session_maintenance_empty_cleanup(self) -> tuple[str, ...]:
        return self._session_service.apply_session_maintenance_empty_cleanup()

    def apply_session_maintenance_orphan_cleanup(self) -> tuple[str, ...]:
        return self._session_service.apply_session_maintenance_orphan_cleanup()

    def apply_session_maintenance_vacuum(self) -> tuple[str, ...]:
        return self._session_service.apply_session_maintenance_vacuum()

    def search_sessions(self, query: str) -> tuple[str, ...]:
        return self._session_service.search_sessions(query)

    def inspect_stats(self) -> tuple[str, ...]:
        payload = self._observability_service.stats_payload()
        metrics = payload.get("metrics")
        alerts = payload.get("alerts")
        lines: list[str] = []
        if isinstance(metrics, dict):
            for key in (
                "cache_hit_rate",
                "compaction_ratio",
                "budget_curve",
                "consecutive_l4",
                "ptl_rate",
            ):
                if key in metrics:
                    lines.append(f"{key}={metrics[key]}")
        if isinstance(alerts, list) and alerts:
            for alert in alerts:
                if isinstance(alert, dict):
                    rule = alert.get("rule", "unknown")
                    severity = alert.get("severity", "info")
                    observed = alert.get("observed", "")
                    lines.append(f"alert {severity} {rule} observed={observed}")
        else:
            lines.append("alerts=none")
        return tuple(lines)

    def inspect_context(self) -> tuple[str, ...]:
        snapshot = self._observability_service.snapshot()
        context_window = snapshot.context_window
        has_budget = bool(snapshot.budget_curve)
        has_context = bool(context_window)
        has_compaction = bool(snapshot.compaction_levels)
        has_l4_state = snapshot.l4_last_decision is not None or snapshot.l4_last_source is not None
        if not has_budget and not has_context and not has_compaction and not has_l4_state:
            return ("no context metrics available",)

        lines: list[str] = []
        input_tokens = self._int_metric(context_window.get("input_tokens"))
        total_tokens = self._int_metric(context_window.get("total_tokens"))
        max_tokens = self._int_metric(context_window.get("max_tokens")) or self._config.max_prompt_tokens
        usage_ratio_metric = context_window.get("usage_ratio")
        usage_ratio = (
            float(usage_ratio_metric)
            if isinstance(usage_ratio_metric, (int, float)) and not isinstance(usage_ratio_metric, bool)
            else None
        )
        raw_source = context_window.get("source")
        source = str(raw_source) if isinstance(raw_source, str) and raw_source else "estimate"
        budget_label = "input_tokens"
        budget_tokens = input_tokens
        if budget_tokens <= 0 and total_tokens > 0:
            budget_label = "total_tokens"
            budget_tokens = total_tokens
        if budget_tokens <= 0 and snapshot.budget_curve:
            latest_ratio = snapshot.budget_curve[-1]
            budget_label = "total_tokens"
            budget_tokens = int(round(latest_ratio * max_tokens))
        if budget_tokens > 0 or has_budget or has_context:
            if usage_ratio is None:
                usage_ratio = budget_tokens / max_tokens if max_tokens > 0 else 0.0
            lines.append(
                "budget "
                f"{budget_label}={budget_tokens} "
                f"max_tokens={max_tokens} "
                f"usage_ratio={usage_ratio:.1%} "
                f"source={source}"
            )

        if context_window:
            lines.append(
                "context_window "
                f"fresh_tokens={self._int_metric(context_window.get('fresh_tokens'))} "
                f"tool_result_tokens={self._int_metric(context_window.get('tool_result_tokens'))} "
                f"duplicate_tool_result_tokens={self._int_metric(context_window.get('duplicate_tool_result_tokens'))} "
                f"evictable_tool_result_tokens={self._int_metric(context_window.get('evictable_tool_result_tokens'))}"
            )

        compaction_parts = [
            f"{level}={count}" for level, count in sorted(snapshot.compaction_levels.items())
        ]
        if compaction_parts:
            lines.append(
                "compaction "
                + " ".join(compaction_parts)
                + f" before_tokens={snapshot.compaction_before_tokens}"
                + f" after_tokens={snapshot.compaction_after_tokens}"
                + f" ratio={snapshot.compaction_ratio:.1%}"
                + f" last_decision={snapshot.l4_last_decision or 'none'}"
                + f" source={snapshot.l4_last_source or 'none'}"
            )
        elif has_l4_state:
            lines.append(
                f"l4 last_decision={snapshot.l4_last_decision or 'none'} "
                f"source={snapshot.l4_last_source or 'none'}"
            )
        return tuple(lines)

    def inspect_status(self) -> tuple[str, ...]:
        snapshot = self._observability_service.snapshot()
        context_window = snapshot.context_window
        input_tokens = self._int_metric(context_window.get("input_tokens"))
        total_tokens = self._int_metric(context_window.get("total_tokens"))
        max_tokens = self._int_metric(context_window.get("max_tokens"))
        max_tokens = max_tokens or self._config.max_prompt_tokens
        token_count = input_tokens if input_tokens > 0 else total_tokens
        usage_ratio = context_window.get("usage_ratio")
        context = "unknown"
        tokens = ""
        if isinstance(usage_ratio, (int, float)) and not isinstance(usage_ratio, bool):
            context = f"{float(usage_ratio):.1%}"
        elif token_count > 0 and max_tokens > 0:
            context = f"{(token_count / max_tokens):.1%}"
        if token_count > 0 and max_tokens > 0:
            tokens = f" tokens={token_count}/{max_tokens}"
        pending = self._session_service.load_pending_decision(self._config.session_id)
        suspended = self._session_service.load_suspended_turn(self._config.session_id)
        return (
            f"session={self._config.session_id} "
            f"model={self._config.model} "
            f"provider={self._config.provider.value}/{self._config.protocol.value} "
            f"context={context}"
            f"{tokens} "
            f"pending={'yes' if pending is not None else 'no'} "
            f"suspended={'yes' if suspended is not None else 'no'}",
        )

    def inspect_view(self) -> tuple[str, ...]:
        return (f"view_mode={self._config.view_mode.value}",)

    def set_view_mode(self, mode: str) -> tuple[str, ...]:
        try:
            view_mode = ViewMode(mode.strip().lower())
        except ValueError:
            allowed = ", ".join(item.value for item in ViewMode)
            return (f"unsupported view_mode={mode}; allowed={allowed}",)
        self._config = replace(self._config, view_mode=view_mode)
        if self._runtime is not None:
            self._runtime.rebind_session(self._config)
        return (f"view_mode={view_mode.value}",)

    def inspect_usage(self) -> tuple[str, ...]:
        turn_count = 0
        input_tokens = 0
        output_tokens = 0
        total_tokens = 0
        cache_read_tokens = 0
        cache_write_tokens = 0
        latest_usage_metadata: dict[str, object] | None = None

        for rollout in self._session_service.load_turn_rollouts(self._config.session_id):
            rollout_has_usage = False
            for event in rollout.events:
                if event.kind != "turn_item":
                    continue
                payload = event.payload
                if payload.get("type") != TurnItemType.MODEL_USAGE.value:
                    continue
                metadata = payload.get("metadata")
                if not isinstance(metadata, dict):
                    continue
                rollout_has_usage = True
                latest_usage_metadata = metadata
                input_tokens += self._int_metric(metadata.get("input_tokens"))
                output_tokens += self._int_metric(metadata.get("output_tokens"))
                total_tokens += self._int_metric(metadata.get("total_tokens"))
                cache_read_tokens += self._int_metric(metadata.get("cache_read_tokens"))
                cache_write_tokens += self._int_metric(metadata.get("cache_write_tokens"))
            if rollout_has_usage:
                turn_count += 1

        if total_tokens == 0:
            total_tokens = input_tokens + output_tokens

        estimated_cost = self._estimated_usage_cost(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_tokens=cache_read_tokens,
            cache_write_tokens=cache_write_tokens,
        )
        return (
            f"session={self._config.session_id}",
            f"turns={turn_count}",
            self._format_current_context_window_usage(latest_usage_metadata),
            "cumulative_usage input_tokens="
            f"{input_tokens} output_tokens={output_tokens} total_tokens={total_tokens} "
            f"cache_read_tokens={cache_read_tokens} cache_write_tokens={cache_write_tokens}",
            f"estimated_cost={estimated_cost}",
        )

    def current_context_window_metrics(self) -> dict[str, object]:
        latest_usage_metadata = self._latest_model_usage_metadata()
        if latest_usage_metadata is not None:
            return self._context_window_metrics_from_usage_metadata(latest_usage_metadata)
        return dict(self._observability_service.snapshot().context_window)

    def _latest_model_usage_metadata(self) -> dict[str, object] | None:
        for rollout in reversed(self._session_service.load_turn_rollouts(self._config.session_id)):
            for event in reversed(rollout.events):
                if event.kind != "turn_item":
                    continue
                payload = event.payload
                if payload.get("type") != TurnItemType.MODEL_USAGE.value:
                    continue
                metadata = payload.get("metadata")
                if isinstance(metadata, dict):
                    return metadata
        return None

    def _context_window_metrics_from_usage_metadata(
        self,
        metadata: dict[str, object],
    ) -> dict[str, object]:
        input_tokens = self._int_metric(metadata.get("input_tokens"))
        budget_input_tokens = self._int_metric(metadata.get("budget_input_tokens"))
        total_tokens = self._int_metric(metadata.get("total_tokens"))
        current_tokens = input_tokens or budget_input_tokens or total_tokens
        max_tokens = self._int_metric(metadata.get("max_tokens")) or self._config.max_prompt_tokens
        usage_ratio_metric = metadata.get("usage_ratio")
        if isinstance(usage_ratio_metric, bool):
            usage_ratio = 0.0
        elif isinstance(usage_ratio_metric, (int, float)):
            usage_ratio = float(usage_ratio_metric)
        else:
            usage_ratio = current_tokens / max_tokens if max_tokens > 0 else 0.0
        raw_source = metadata.get("source")
        if isinstance(raw_source, str) and raw_source:
            source = raw_source
        else:
            source = "provider" if input_tokens > 0 else "estimate"
        return {
            "input_tokens": current_tokens,
            "max_tokens": max_tokens,
            "usage_ratio": usage_ratio,
            "source": source,
        }

    def _format_current_context_window_usage(
        self,
        metadata: dict[str, object] | None,
    ) -> str:
        if metadata is None:
            return "current_context_window=unavailable"
        metrics = self._context_window_metrics_from_usage_metadata(metadata)
        usage_ratio_metric = metrics.get("usage_ratio")
        usage_ratio = (
            float(usage_ratio_metric)
            if isinstance(usage_ratio_metric, (int, float)) and not isinstance(usage_ratio_metric, bool)
            else 0.0
        )
        raw_source = metrics.get("source")
        source = raw_source if isinstance(raw_source, str) and raw_source else "estimate"
        return (
            "current_context_window "
            f"input_tokens={self._int_metric(metrics.get('input_tokens'))} "
            f"max_tokens={self._int_metric(metrics.get('max_tokens'))} "
            f"usage_ratio={usage_ratio:.1%} "
            f"source={source}"
        )

    @staticmethod
    def _int_metric(value: object) -> int:
        if isinstance(value, bool):
            return 0
        if isinstance(value, (int, float)):
            return int(value)
        return 0

    def _estimated_usage_cost(
        self,
        *,
        input_tokens: int,
        output_tokens: int,
        cache_read_tokens: int,
        cache_write_tokens: int,
    ) -> str:
        prices = (
            self._config.usage_input_cost_per_1k,
            self._config.usage_output_cost_per_1k,
            self._config.usage_cache_read_cost_per_1k,
            self._config.usage_cache_write_cost_per_1k,
        )
        if all(price == 0 for price in prices):
            return "unavailable"
        cost = (
            (input_tokens / 1000) * self._config.usage_input_cost_per_1k
            + (output_tokens / 1000) * self._config.usage_output_cost_per_1k
            + (cache_read_tokens / 1000) * self._config.usage_cache_read_cost_per_1k
            + (cache_write_tokens / 1000) * self._config.usage_cache_write_cost_per_1k
        )
        return f"{cost:.5f}"

    def inspect_trace(self) -> tuple[str, ...]:
        events = self._trace_service.load(self._config.session_id)
        if not events:
            return ("no trace events",)
        high_signal_events = tuple(event for event in events if event.kind != "turn_item")
        visible_events = high_signal_events[-10:] if high_signal_events else events[-10:]
        lines: list[str] = []
        for event in visible_events:
            parts = [event.kind]
            tool_name = event.payload.get("tool_name")
            if isinstance(tool_name, str) and tool_name:
                parts.append(tool_name)
            route_name = event.payload.get("route_name")
            if isinstance(route_name, str) and route_name and route_name not in parts:
                parts.append(route_name)

            arguments = event.payload.get("arguments")
            if isinstance(arguments, dict):
                args = arguments.get("args")
                if isinstance(args, list) and args and all(isinstance(item, str) for item in args):
                    parts.append(f"args={' '.join(args)}")

            for key in ("scope", "state", "source", "exit_reason", "stop_reason", "trigger"):
                value = event.payload.get(key)
                if isinstance(value, str) and value:
                    parts.append(f"{key}={value}")

            decision = event.payload.get("decision")
            if isinstance(decision, str) and decision:
                parts.append(f"decision={decision}")

            policy = event.payload.get("policy")
            if isinstance(policy, str) and policy:
                parts.append(f"policy={policy}")

            risk_level = event.payload.get("risk_level")
            if isinstance(risk_level, str) and risk_level:
                parts.append(f"risk={risk_level}")

            argument_count = event.payload.get("argument_count")
            argument_keys = event.payload.get("argument_keys")
            if isinstance(argument_count, int) and isinstance(argument_keys, list):
                keys = ",".join(
                    key for key in argument_keys if isinstance(key, str) and key
                )
                parts.append(f"args={argument_count}")
                if keys:
                    parts.append(f"keys={keys}")

            execpolicy_decision = event.payload.get("execpolicy_decision")
            execpolicy_source = event.payload.get("execpolicy_rule_source")
            execpolicy_rule = event.payload.get("execpolicy_rule_pattern_hash")
            if isinstance(execpolicy_decision, str) and execpolicy_decision:
                parts.append(f"execpolicy={execpolicy_decision}")
                if isinstance(execpolicy_source, str) and execpolicy_source:
                    parts.append(f"source={execpolicy_source}")
                if isinstance(execpolicy_rule, str) and execpolicy_rule:
                    parts.append(f"rule={execpolicy_rule}")

            sandbox = event.payload.get("sandbox")
            if isinstance(sandbox, dict):
                filesystem = sandbox.get("filesystem")
                network = sandbox.get("network")
                shell = sandbox.get("shell")
                sandbox_parts = []
                if isinstance(filesystem, str) and filesystem:
                    sandbox_parts.append(f"fs:{filesystem}")
                if isinstance(network, str) and network:
                    sandbox_parts.append(f"net:{network}")
                if isinstance(shell, str) and shell:
                    sandbox_parts.append(f"shell:{shell}")
                if sandbox_parts:
                    parts.append(f"sandbox={','.join(sandbox_parts)}")

            count = event.payload.get("count")
            if isinstance(count, int):
                parts.append(f"count={count}")

            path = event.payload.get("path")
            if isinstance(path, str) and path:
                parts.append(f"path={path}")

            error_kind = event.payload.get("error_kind")
            if isinstance(error_kind, str) and error_kind:
                parts.append(f"error_kind={error_kind}")

            status = event.payload.get("status")
            if isinstance(status, str) and status:
                parts.append(f"status={status}")

            duration_ms = event.payload.get("duration_ms")
            if isinstance(duration_ms, int | float):
                parts.append(f"duration_ms={int(duration_ms)}")

            filesystem_effect = event.payload.get("filesystem_effect")
            if isinstance(filesystem_effect, str) and filesystem_effect:
                parts.append(f"filesystem={filesystem_effect}")

            process_effect = event.payload.get("process_effect")
            if isinstance(process_effect, bool):
                parts.append(f"process={str(process_effect).lower()}")

            summary = event.payload.get("summary")
            if isinstance(summary, str) and summary:
                parts.append(f"summary={summary}")

            stdout_preview = event.payload.get("stdout_preview")
            if isinstance(stdout_preview, str) and stdout_preview:
                parts.append(f"stdout={stdout_preview}")

            stderr_preview = event.payload.get("stderr_preview")
            if isinstance(stderr_preview, str) and stderr_preview:
                parts.append(f"stderr={stderr_preview}")

            lines.append(" ".join(parts))
        return tuple(lines)

    def export_trace_jsonl(self, *, tail: int = 50) -> tuple[str, ...]:
        rows = self._trace_service.export_jsonl(self._config.session_id, tail=tail)
        if not rows:
            return ("",)
        return rows

    def extension_manifest(self) -> dict[str, object]:
        runtime_manifest = getattr(self._runtime, "extension_manifest", None)
        if callable(runtime_manifest):
            return cast(dict[str, object], runtime_manifest())
        return self._extension_manifest_service.manifest()

    def inspect_extensions(self) -> tuple[str, ...]:
        manifest = self.extension_manifest()
        agent = _mapping_value(manifest, "agent")
        agent_name = _string_value(agent, "name", default="unknown")
        schema_version = manifest.get("schema_version", "unknown")
        rpc_methods = _list_value(manifest, "rpc_methods")
        event_streams = _list_value(manifest, "event_streams")
        capabilities = _list_value(manifest, "capabilities")

        lines = [
            (
                f"agent={agent_name} schema={schema_version} "
                f"rpc_methods={len(rpc_methods)} event_streams={len(event_streams)}"
            )
        ]
        rpc_names = _named_entries(rpc_methods, key="name")
        for rpc_name in ("extension.manifest", "trace.export"):
            if rpc_name in rpc_names:
                lines.append(f"rpc {rpc_name}")

        capability_statuses = _capability_statuses(capabilities)
        for capability_id in (
            "runtime.trace.export",
            "extensions.lifecycle",
            "acp.server",
        ):
            status = capability_statuses.get(capability_id)
            if status is not None:
                lines.append(f"{capability_id} {status}")

        return tuple(lines)

    def inspect_plugin_commands(self) -> tuple[str, ...]:
        inspect = getattr(self._runtime, "inspect_plugin_commands", None)
        if callable(inspect):
            return tuple(inspect())
        return ("plugin command diagnostics not available",)

    def run_plugin_command(
        self,
        plugin_id: str,
        command_name: str,
        raw_args: str = "",
    ) -> tuple[str, ...]:
        arguments: dict[str, object] = {}
        if raw_args.strip():
            try:
                parsed = json.loads(raw_args)
            except json.JSONDecodeError:
                return ("plugin command arguments must be a JSON object",)
            if not isinstance(parsed, dict):
                return ("plugin command arguments must be a JSON object",)
            arguments = dict(parsed)
        run = getattr(self._runtime, "run_plugin_command", None)
        if not callable(run):
            return ("plugin command runtime not available",)
        result = cast(dict[str, object], run(plugin_id, command_name, arguments))
        ok = result.get("ok") is True
        summary = _string_value(result, "summary", default="plugin command completed")
        lines = [f"{'ok' if ok else 'error'} {plugin_id}:{command_name} {summary}"]
        content = _string_value(result, "content", default="")
        if content:
            lines.append(content)
        error = _string_value(result, "error", default="")
        if error:
            lines.append(f"error={error}")
        return tuple(lines)

    def undo_last_file_change(self) -> str:
        result = self._file_history_service.rewind_latest(
            session_id=self._config.session_id,
        )
        if result.error is not None:
            return result.error
        restored = [f"restored {path}" for path in result.restored_paths]
        deleted = [f"deleted {path}" for path in result.deleted_paths]
        changes = (*restored, *deleted)
        if not changes:
            return f"No file changes found in snapshot {result.snapshot_id}."
        return f"{result.snapshot_id}: " + ", ".join(changes)


def _history_type_for_message(message: Message) -> HistoryItemType | None:
    if message.role == "user":
        return HistoryItemType.USER_MESSAGE
    if message.role == "assistant":
        return HistoryItemType.ASSISTANT_MESSAGE
    if message.role == "tool":
        return HistoryItemType.TOOL_RESULT
    return None


def _tool_name_for_message(message: Message) -> str | None:
    for block in message.blocks:
        if block.type == "tool_result":
            value = block.metadata.get("tool_name")
            return value if isinstance(value, str) else None
    return None


def _mapping_value(source: dict[str, object], key: str) -> dict[str, object]:
    value = source.get(key)
    if isinstance(value, dict):
        return value
    return {}


def _string_value(source: dict[str, object], key: str, *, default: str = "") -> str:
    value = source.get(key)
    if isinstance(value, str):
        return value
    return default


def _list_value(source: dict[str, object], key: str) -> list[object]:
    value = source.get(key)
    if isinstance(value, list):
        return value
    return []


def _string_items(values: list[object]) -> tuple[str, ...]:
    return tuple(str(value) for value in values if isinstance(value, str) and value)


def _conflict_mentions_toolset(conflict: object, toolset_id: str) -> bool:
    if not isinstance(conflict, dict):
        return False
    toolsets = conflict.get("toolsets")
    return isinstance(toolsets, list) and toolset_id in _string_items(toolsets)


def _named_entries(entries: list[object], *, key: str) -> set[str]:
    names: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        value = entry.get(key)
        if isinstance(value, str):
            names.add(value)
    return names


def _capability_statuses(capabilities: list[object]) -> dict[str, str]:
    statuses: dict[str, str] = {}
    for capability in capabilities:
        if not isinstance(capability, dict):
            continue
        capability_id = capability.get("id")
        status = capability.get("status")
        if isinstance(capability_id, str) and isinstance(status, str):
            statuses[capability_id] = status
    return statuses
