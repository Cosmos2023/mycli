from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any, cast

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import (
    AgentConfig,
    DecisionAction,
    HistoryItem,
    HistoryItemType,
    TurnResponse,
)
from mycli.services.context.instruction_contract_assembler import InstructionContractAssembler
from mycli.services.context.turn_context_assembler import TurnContextAssembler
from mycli.services.file_history import FileHistoryService
from mycli.memory.service import MemoryService
from mycli.services.observability import ObservabilityService
from mycli.services.session_service import SessionService
from mycli.services.skills import SkillRegistry
from mycli.services.tracing import TraceService


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
            ),
        )
        self._trace_service = getattr(
            runtime,
            "_trace_service",
            TraceService(home_dir=home_dir),
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

    def handle_user_turn(self, user_message: str) -> TurnResponse:
        runtime = self._runtime
        if runtime is None:
            raise RuntimeError("TurnService has no runtime.")
        return cast(TurnResponse, runtime.handle_user_turn(user_message))

    def resolve_pending_decision(self, choice: str) -> TurnResponse:
        runtime = self._runtime
        if runtime is None:
            raise RuntimeError("TurnService has no runtime.")
        return cast(TurnResponse, runtime.resolve_pending_approval(choice))

    def confirm_pending_action(self) -> TurnResponse:
        return self.resolve_pending_decision("1")

    def reject_pending_action(self) -> TurnResponse:
        return self.resolve_pending_decision("2")

    def inspect_plan(self) -> tuple[str, ...]:
        plan_state = self._session_service.load_plan_state(self._config.session_id)
        if not plan_state.items:
            return ("no active plan",)
        return tuple(f"{item.status.value}: {item.content}" for item in plan_state.items)

    def inspect_skills(self) -> tuple[str, ...]:
        lines: list[str] = []
        for name in self._skill_registry.list_names():
            metadata = self._skill_registry.get_metadata(name)
            if metadata is None:
                continue
            lines.append(f"{metadata.name}: {metadata.description}")
        return tuple(lines or ("no skills available",))

    def inspect_tools(self) -> tuple[str, ...]:
        specs = getattr(self._tool_registry, "specs", None)
        if not isinstance(specs, dict):
            return tuple(self._available_tool_names())
        return tuple(
            f"{spec.name} [{spec.risk_level}]: {spec.description}"
            for spec in specs.values()
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
            return (f"session not found: {target_session_id}",)
        self._backfill_history_from_conversation(conversation)
        self._activate_session(target_session_id)
        return (
            f"resumed {target_session_id}",
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
            return (str(exc),)
        self._backfill_history_from_conversation(conversation)
        self._activate_session(target)
        return (
            f"forked {source} -> {target}",
            f"fork_point={conversation.fork_point}",
            f"messages={len(conversation.messages)}",
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

            for key in ("scope", "state", "source"):
                value = event.payload.get(key)
                if isinstance(value, str) and value:
                    parts.append(f"{key}={value}")

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
