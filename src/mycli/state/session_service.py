from __future__ import annotations

from pathlib import Path
from typing import Any

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import (
    ContextBaseline,
    DecisionAction,
    DecisionKind,
    HistoryItem,
    HistoryItemType,
    InvokedSkillSnapshot,
    PendingApproval,
    PendingClarification,
    PendingDecision,
    PlanItem,
    PlanState,
    PlanStatus,
    SessionCommandAllowance,
    SessionRuntimeSnapshot,
    StopReason,
    SuspendedTurn,
    TurnRecord,
    TurnRollout,
    TurnStatus,
)
from mycli.domain.session_store import (
    JsonArray,
    JsonObject,
    SessionMaintenanceReport,
    SessionOverview,
    SessionStore,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore
from mycli.schemas.responses_protocol import ResponsesContinuationState
from mycli.services.context.context_manager import ContextManager
from mycli.services.session_snapshot import (
    SessionSnapshotContext,
    SessionSnapshotService,
)
from mycli.state.session_serialization import (
    deserialize_message,
    optional_str,
    serialize_message,
)


class SessionService:
    _KEY_ALLOWLIST = "command_allowances"
    _KEY_CONTEXT_BASELINE = "context_baseline"
    _KEY_CONTRIBUTED_TOOL_STATE = "contributed_tool_state"
    _KEY_INVOKED_SKILLS = "invoked_skills"
    _KEY_PENDING_DECISION = "pending_decision"
    _KEY_PLAN_STATE = "plan_state"
    _KEY_RESPONSES_CONTINUATION = "responses_continuation_state"
    _KEY_RUNTIME_ENVIRONMENT_CONTEXT = "runtime_environment_context"
    _KEY_SUSPENDED_TURN = "suspended_turn"
    _KEY_TURN_RECORD = "turn_record"

    def __init__(
        self,
        home_dir: Path,
        workspace_root: Path | None = None,
        session_store: SessionStore | None = None,
    ) -> None:
        self._workspace_root = workspace_root or Path.cwd()
        self._store = session_store or SQLiteSessionStore(home_dir / ".mycli" / "sessions.db")
        self._snapshot_service = SessionSnapshotService(home_dir=home_dir)

    def save_conversation(self, conversation: Conversation) -> None:
        self._store.replace_conversation(
            session_id=conversation.session_id,
            workspace_root=self._workspace_root,
            thread_id=conversation.session_id,
            messages=[serialize_message(message) for message in conversation.messages],
        )
        self._write_snapshot(conversation)
        self._snapshot_service.append_event(
            session_id=conversation.session_id,
            event_type="conversation.saved",
            payload={"message_count": len(conversation.messages)},
        )

    def load_conversation(self, session_id: str) -> Conversation:
        payload = self._store.load_conversation(session_id)
        conversation = Conversation(session_id=session_id)
        if payload is None:
            conversation.messages.extend(self._conversation_messages_from_history(session_id))
            return conversation
        for item in payload:
            conversation.append(deserialize_message(item))
        return conversation

    def append_history_items(
        self,
        session_id: str,
        items: tuple[HistoryItem, ...],
    ) -> None:
        self._store.append_history_items(
            session_id=session_id,
            workspace_root=self._workspace_root,
            thread_id=self._history_thread_id(session_id, items),
            items=[item.to_dict() for item in items],
        )
        self._refresh_snapshot(session_id)
        self._snapshot_service.append_event(
            session_id=session_id,
            event_type="history.appended",
            payload={
                "item_count": len(items),
                "turn_id": items[-1].turn_id if items else None,
            },
        )

    def load_history_items(self, session_id: str) -> tuple[HistoryItem, ...]:
        return tuple(
            HistoryItem.from_dict(item)
            for item in self._store.load_history_items(session_id)
        )

    def sync_conversation_view_from_history(self, session_id: str) -> None:
        conversation = Conversation(session_id=session_id)
        conversation.messages.extend(self._conversation_messages_from_history(session_id))
        self.save_conversation(conversation)

    def compact_history(
        self,
        session_id: str,
        *,
        replaced_item_ids: tuple[str, ...],
        compacted_item: HistoryItem,
    ) -> None:
        replaced = set(replaced_item_ids)
        remaining = [
            item.to_dict()
            for item in self.load_history_items(session_id)
            if item.id not in replaced
        ]
        remaining.append(compacted_item.to_dict())
        self._store.replace_history_items(
            session_id=session_id,
            workspace_root=self._workspace_root,
            thread_id=compacted_item.thread_id,
            items=remaining,
        )
        self._refresh_snapshot(session_id)
        self._snapshot_service.append_event(
            session_id=session_id,
            event_type="history.compacted",
            payload={"replaced_item_count": len(replaced_item_ids)},
        )

    def save_context_baseline(
        self,
        session_id: str,
        baseline: ContextBaseline,
    ) -> None:
        self._save_state(
            session_id=session_id,
            thread_id=baseline.thread_id,
            state_key=self._KEY_CONTEXT_BASELINE,
            payload=baseline.to_dict(),
        )

    def load_context_baseline(self, session_id: str) -> ContextBaseline | None:
        payload = self._load_state_object(session_id, self._KEY_CONTEXT_BASELINE)
        if payload is None:
            return None
        return ContextBaseline.from_dict(payload)

    def record_invoked_skill_snapshot(
        self,
        session_id: str,
        snapshot: InvokedSkillSnapshot,
    ) -> None:
        existing = {
            item.name: item
            for item in self.load_invoked_skill_snapshots(session_id)
        }
        existing[snapshot.name] = snapshot
        ordered = sorted(existing.values(), key=lambda item: item.invoked_at.isoformat())
        self._save_state(
            session_id=session_id,
            thread_id=session_id,
            state_key=self._KEY_INVOKED_SKILLS,
            payload=[item.to_dict() for item in ordered],
        )

    def load_invoked_skill_snapshots(
        self,
        session_id: str,
    ) -> tuple[InvokedSkillSnapshot, ...]:
        payload = self._load_state_list(session_id, self._KEY_INVOKED_SKILLS)
        return tuple(
            InvokedSkillSnapshot.from_dict(item)
            for item in payload
            if isinstance(item, dict)
        )

    def append_turn_rollout(
        self,
        session_id: str,
        rollout: TurnRollout,
    ) -> None:
        self._store.append_turn_rollout(
            session_id=session_id,
            workspace_root=self._workspace_root,
            thread_id=rollout.thread_id,
            rollout=rollout.to_dict(),
        )
        self._refresh_snapshot(session_id)
        self._snapshot_service.append_event(
            session_id=session_id,
            event_type="turn.rollout",
            payload={
                "turn_id": rollout.turn_id,
                "status": rollout.status.value,
                "stop_reason": None if rollout.stop_reason is None else rollout.stop_reason.value,
            },
        )

    def load_turn_rollouts(self, session_id: str) -> tuple[TurnRollout, ...]:
        return tuple(
            TurnRollout.from_dict(item)
            for item in self._store.load_turn_rollouts(session_id)
        )

    def load_runtime_snapshot(self, session_id: str) -> SessionRuntimeSnapshot | None:
        history_items = self.load_history_items(session_id)
        context_baseline = self.load_context_baseline(session_id)
        turn_rollouts = self.load_turn_rollouts(session_id)
        continuation_state = self.load_responses_continuation_state(session_id)
        invoked_skills = self.load_invoked_skill_snapshots(session_id)
        if (
            not history_items
            and context_baseline is None
            and not turn_rollouts
            and continuation_state is None
            and not invoked_skills
        ):
            return None
        thread_id = (
            history_items[-1].thread_id
            if history_items
            else (
                context_baseline.thread_id
                if context_baseline is not None
                else (turn_rollouts[-1].thread_id if turn_rollouts else session_id)
            )
        )
        return SessionRuntimeSnapshot(
            session_id=session_id,
            thread_id=thread_id,
            history_items=history_items,
            context_baseline=context_baseline,
            turn_rollouts=turn_rollouts,
            continuation_state={} if continuation_state is None else continuation_state.to_dict(),
            invoked_skills=invoked_skills,
        )

    def save_pending_decision(self, session_id: str, decision: PendingDecision) -> None:
        self._save_state(
            session_id=session_id,
            thread_id=session_id,
            state_key=self._KEY_PENDING_DECISION,
            payload={
                "tool_call": {
                    "name": decision.tool_call.name,
                    "arguments": decision.tool_call.arguments,
                    "reason": decision.tool_call.reason,
                    "call_id": decision.tool_call.call_id,
                },
                "kind": decision.kind.value,
                "reason": decision.reason,
                "preview": decision.preview,
                "options": [option.value for option in decision.options],
                "command_pattern": decision.command_pattern,
                "metadata": decision.metadata,
            },
        )

    def load_pending_decision(self, session_id: str) -> PendingDecision | None:
        payload = self._load_state_object(session_id, self._KEY_PENDING_DECISION)
        if payload is None:
            return None
        return PendingDecision(
            tool_call=ToolCall(
                name=str(payload["tool_call"]["name"]),
                arguments=dict(payload["tool_call"]["arguments"]),
                reason=str(payload["tool_call"]["reason"]),
                call_id=optional_str(payload["tool_call"].get("call_id")),
            ),
            kind=DecisionKind(str(payload["kind"])),
            reason=str(payload["reason"]),
            preview=str(payload["preview"]),
            options=tuple(DecisionAction(str(option)) for option in payload["options"]),
            command_pattern=optional_str(payload.get("command_pattern")),
            metadata=dict(payload.get("metadata") or {}),
        )

    def clear_pending_decision(self, session_id: str) -> None:
        self._store.delete_state(session_id, self._KEY_PENDING_DECISION)

    def add_command_allowance(self, session_id: str, allowance: SessionCommandAllowance) -> None:
        payload = list(self.load_command_allowances(session_id))
        if allowance.command_pattern not in payload:
            payload.append(allowance.command_pattern)
        self._save_state(
            session_id=session_id,
            thread_id=session_id,
            state_key=self._KEY_ALLOWLIST,
            payload=payload,
        )

    def save_plan_state(self, session_id: str, plan_state: PlanState) -> None:
        self._save_state(
            session_id=session_id,
            thread_id=session_id,
            state_key=self._KEY_PLAN_STATE,
            payload=[
                {
                    "id": item.id,
                    "content": item.content,
                    "status": item.status.value,
                    "evidence": list(item.evidence),
                }
                for item in plan_state.items
            ],
        )
        self._refresh_snapshot(session_id)
        self._snapshot_service.append_event(
            session_id=session_id,
            event_type="plan.updated",
            payload={"plan": self._plan_event_payload(plan_state)},
        )

    def load_plan_state(self, session_id: str) -> PlanState:
        payload = self._load_state_list(session_id, self._KEY_PLAN_STATE)
        return PlanState(
            items=tuple(
                PlanItem(
                    id=str(item["id"]),
                    content=str(item["content"]),
                    status=PlanStatus(str(item["status"])),
                    evidence=tuple(
                        str(entry)
                        for entry in item.get("evidence", ())
                        if isinstance(entry, str) and entry
                    ),
                )
                for item in payload
                if isinstance(item, dict)
            )
        )

    def clear_plan_state(self, session_id: str) -> None:
        self._store.delete_state(session_id, self._KEY_PLAN_STATE)

    def save_runtime_environment_context_state(
        self,
        session_id: str,
        *,
        content_hash: str,
        turn_id: str,
    ) -> None:
        self._save_state(
            session_id=session_id,
            thread_id=session_id,
            state_key=self._KEY_RUNTIME_ENVIRONMENT_CONTEXT,
            payload={
                "content_hash": content_hash,
                "turn_id": turn_id,
            },
        )

    def load_runtime_environment_context_state(
        self,
        session_id: str,
    ) -> dict[str, str] | None:
        payload = self._load_state_object(
            session_id,
            self._KEY_RUNTIME_ENVIRONMENT_CONTEXT,
        )
        if payload is None:
            return None
        content_hash = payload.get("content_hash")
        turn_id = payload.get("turn_id")
        if not isinstance(content_hash, str) or not content_hash:
            return None
        if not isinstance(turn_id, str):
            turn_id = ""
        return {"content_hash": content_hash, "turn_id": turn_id}

    def save_responses_continuation_state(
        self,
        session_id: str,
        state: ResponsesContinuationState | None,
    ) -> None:
        if state is None:
            self._store.delete_state(session_id, self._KEY_RESPONSES_CONTINUATION)
            return
        self._save_state(
            session_id=session_id,
            thread_id=session_id,
            state_key=self._KEY_RESPONSES_CONTINUATION,
            payload=state.to_dict(),
        )

    def load_responses_continuation_state(
        self,
        session_id: str,
    ) -> ResponsesContinuationState | None:
        payload = self._load_state_object(session_id, self._KEY_RESPONSES_CONTINUATION)
        if payload is None:
            rollouts = self.load_turn_rollouts(session_id)
            if rollouts:
                continuation_state = rollouts[-1].continuation_state
                if continuation_state:
                    return ResponsesContinuationState.from_dict(continuation_state)
            return None
        return ResponsesContinuationState.from_dict(payload)

    def save_suspended_turn(self, session_id: str, turn: SuspendedTurn) -> None:
        self._save_state(
            session_id=session_id,
            thread_id=session_id,
            state_key=self._KEY_SUSPENDED_TURN,
            payload={
                "user_message": turn.user_message,
                "conversation": [serialize_message(message) for message in turn.conversation],
                "suspend_reason": turn.suspend_reason.value,
                "plan_items": [
                    {
                        "id": item.id,
                        "content": item.content,
                        "status": item.status.value,
                    }
                    for item in turn.plan_state.items
                ],
                "pending_approval": None
                if turn.pending_approval is None
                else {
                    "tool_call": {
                        "name": turn.pending_approval.tool_call.name,
                        "arguments": turn.pending_approval.tool_call.arguments,
                        "reason": turn.pending_approval.tool_call.reason,
                        "call_id": turn.pending_approval.tool_call.call_id,
                    },
                    "reason": turn.pending_approval.reason,
                    "preview": turn.pending_approval.preview,
                    "command_pattern": turn.pending_approval.command_pattern,
                    "metadata": turn.pending_approval.metadata,
                },
                "pending_clarification": None
                if turn.pending_clarification is None
                else {
                    "request_id": turn.pending_clarification.request_id,
                    "tool_call": {
                        "name": turn.pending_clarification.tool_call.name,
                        "arguments": turn.pending_clarification.tool_call.arguments,
                        "reason": turn.pending_clarification.tool_call.reason,
                        "call_id": turn.pending_clarification.tool_call.call_id,
                    },
                    "question": turn.pending_clarification.question,
                    "options": list(turn.pending_clarification.options),
                    "header": turn.pending_clarification.header,
                    "multi_select": turn.pending_clarification.multi_select,
                },
            },
        )

    def load_suspended_turn(self, session_id: str) -> SuspendedTurn | None:
        payload = self._load_state_object(session_id, self._KEY_SUSPENDED_TURN)
        if payload is None:
            return None

        pending_payload = payload.get("pending_approval")
        pending_approval = None
        if isinstance(pending_payload, dict):
            tool_call_payload = pending_payload.get("tool_call")
            if not isinstance(tool_call_payload, dict):
                raise ValueError("Suspended turn pending approval must include a tool call object.")
            pending_approval = PendingApproval(
                tool_call=ToolCall(
                    name=str(tool_call_payload["name"]),
                    arguments=dict(tool_call_payload["arguments"]),
                    reason=str(tool_call_payload["reason"]),
                    call_id=optional_str(tool_call_payload.get("call_id")),
                ),
                reason=str(pending_payload["reason"]),
                preview=str(pending_payload["preview"]),
                command_pattern=optional_str(pending_payload.get("command_pattern")),
                metadata=dict(pending_payload.get("metadata") or {}),
            )

        clarification_payload = payload.get("pending_clarification")
        pending_clarification = None
        if isinstance(clarification_payload, dict):
            tool_call_payload = clarification_payload.get("tool_call")
            if not isinstance(tool_call_payload, dict):
                raise ValueError("Suspended turn pending clarification must include a tool call object.")
            raw_options = clarification_payload.get("options")
            options = tuple(
                dict(item)
                for item in raw_options
                if isinstance(item, dict)
            ) if isinstance(raw_options, list) else ()
            pending_clarification = PendingClarification(
                request_id=str(clarification_payload["request_id"]),
                tool_call=ToolCall(
                    name=str(tool_call_payload["name"]),
                    arguments=dict(tool_call_payload["arguments"]),
                    reason=str(tool_call_payload["reason"]),
                    call_id=optional_str(tool_call_payload.get("call_id")),
                ),
                question=str(clarification_payload["question"]),
                options=options,
                header=str(clarification_payload.get("header") or ""),
                multi_select=bool(clarification_payload.get("multi_select", False)),
            )

        plan_items_payload = payload.get("plan_items")
        if not isinstance(plan_items_payload, list):
            plan_items_payload = []
        plan_items = tuple(
            PlanItem(
                id=str(item["id"]),
                content=str(item["content"]),
                status=PlanStatus(str(item["status"])),
            )
            for item in plan_items_payload
            if isinstance(item, dict)
        )
        conversation_payload = payload.get("conversation")
        if not isinstance(conversation_payload, list):
            conversation_payload = []
        raw_suspend_reason = payload.get("suspend_reason")
        suspend_reason = (
            StopReason(str(raw_suspend_reason))
            if isinstance(raw_suspend_reason, str) and raw_suspend_reason
            else StopReason.INTERRUPTED
        )

        return SuspendedTurn(
            user_message=str(payload["user_message"]),
            conversation=tuple(
                deserialize_message(item)
                for item in conversation_payload
                if isinstance(item, dict)
            ),
            plan_state=PlanState(items=plan_items),
            pending_approval=pending_approval,
            pending_clarification=pending_clarification,
            suspend_reason=suspend_reason,
        )

    def reconstruct_suspended_turn(
        self,
        session_id: str,
        decision: PendingDecision,
    ) -> SuspendedTurn | None:
        snapshot = self.load_runtime_snapshot(session_id)
        if snapshot is None:
            return None

        turn_record = self.load_turn_record(session_id)
        waiting_turn_id: str | None = None
        user_message: str | None = None
        if turn_record is not None and turn_record.status is TurnStatus.WAITING_APPROVAL:
            waiting_turn_id = turn_record.turn_id
            user_message = turn_record.user_message
        else:
            for rollout in reversed(snapshot.turn_rollouts):
                if rollout.status is TurnStatus.WAITING_APPROVAL:
                    waiting_turn_id = rollout.turn_id
                    break
        if waiting_turn_id is None:
            return None

        if user_message is None:
            for item in reversed(snapshot.history_items):
                if item.turn_id != waiting_turn_id:
                    continue
                if item.type is HistoryItemType.USER_MESSAGE and item.text:
                    user_message = item.text
                    break
        if user_message is None:
            return None

        conversation = self.load_conversation(session_id)
        pending_approval = PendingApproval(
            tool_call=ToolCall(
                name=decision.tool_call.name,
                arguments=decision.tool_call.arguments,
                reason=decision.tool_call.reason,
                call_id=decision.tool_call.call_id,
            ),
            reason=decision.reason,
            preview=decision.preview,
            command_pattern=decision.command_pattern,
            metadata=dict(decision.metadata),
        )
        return SuspendedTurn(
            user_message=user_message,
            conversation=tuple(conversation.messages),
            plan_state=self.load_plan_state(session_id),
            pending_approval=pending_approval,
        )

    def clear_suspended_turn(self, session_id: str) -> None:
        self._store.delete_state(session_id, self._KEY_SUSPENDED_TURN)

    def save_turn_record(self, session_id: str, turn: TurnRecord) -> None:
        self._save_state(
            session_id=session_id,
            thread_id=turn.thread_id,
            state_key=self._KEY_TURN_RECORD,
            payload=turn.to_dict(),
        )

    def load_turn_record(self, session_id: str) -> TurnRecord | None:
        payload = self._load_state_object(session_id, self._KEY_TURN_RECORD)
        if payload is None:
            return None
        return TurnRecord.from_dict(payload)

    def clear_turn_record(self, session_id: str) -> None:
        self._store.delete_state(session_id, self._KEY_TURN_RECORD)

    def save_contributed_tool_state(self, session_id: str, descriptors: list[dict[str, Any]]) -> None:
        self._save_state(
            session_id=session_id,
            thread_id=session_id,
            state_key=self._KEY_CONTRIBUTED_TOOL_STATE,
            payload=descriptors,
        )

    def load_contributed_tool_state(self, session_id: str) -> list[dict[str, Any]]:
        payload = self._load_state_list(session_id, self._KEY_CONTRIBUTED_TOOL_STATE)
        return [item for item in payload if isinstance(item, dict)]

    def is_command_allowed(self, session_id: str, command_pattern: str | None) -> bool:
        if not command_pattern:
            return False
        return command_pattern in self.load_command_allowances(session_id)

    def load_command_allowances(self, session_id: str) -> tuple[str, ...]:
        payload = self._load_state_list(session_id, self._KEY_ALLOWLIST)
        allowances = [item for item in payload if isinstance(item, str)]
        return tuple(allowances)

    def list_sessions(self, limit: int = 20) -> tuple[SessionOverview, ...]:
        return self._store.list_sessions(workspace_root=self._workspace_root, limit=limit)

    def search_sessions(self, query: str, limit: int = 10) -> tuple[str, ...]:
        normalized = query.strip()
        if not normalized:
            return ("usage: /search <query>",)
        matches = self._store.search_messages(
            normalized,
            workspace_root=self._workspace_root,
            limit=limit,
        )
        if not matches:
            return ("no matches",)
        return tuple(
            f"{match.session_id}#{match.message_index} {match.role}: {match.snippet}"
            for match in matches
        )

    def session_maintenance_report(self) -> SessionMaintenanceReport:
        return self._store.session_maintenance_report(workspace_root=self._workspace_root)

    def inspect_session_maintenance(self) -> tuple[str, ...]:
        report = self.session_maintenance_report()
        lines = [
            f"dry_run={str(report.dry_run).lower()}",
            f"workspace_sessions={report.workspace_session_count}",
            f"empty_sessions={report.empty_session_count}",
            f"db_size_bytes={report.db_size_bytes}",
            f"page_count={report.page_count}",
            f"freelist_count={report.freelist_count}",
            f"page_size={report.page_size}",
        ]
        lines.extend(
            f"empty_candidate={candidate.session_id} "
            f"status={candidate.status} "
            f"last_active_at={candidate.last_active_at}"
            for candidate in report.empty_session_candidates
        )
        if report.empty_session_candidates_omitted:
            lines.append(f"empty_candidates_omitted={report.empty_session_candidates_omitted}")
        return tuple(lines)

    def apply_session_maintenance_empty_cleanup(self) -> tuple[str, ...]:
        result = self._store.apply_session_maintenance_empty_cleanup(
            workspace_root=self._workspace_root
        )
        lines = [
            f"dry_run={str(result.dry_run).lower()}",
            f"deleted_empty_sessions={len(result.deleted_empty_sessions)}",
        ]
        lines.extend(f"deleted_session={session_id}" for session_id in result.deleted_empty_sessions)
        lines.extend(
            [
                f"workspace_sessions={result.workspace_session_count}",
                f"empty_sessions_remaining={result.empty_session_count}",
                f"db_size_bytes={result.db_size_bytes}",
                f"page_count={result.page_count}",
                f"freelist_count={result.freelist_count}",
                f"page_size={result.page_size}",
            ]
        )
        if result.empty_session_candidates_omitted:
            lines.append(
                f"empty_candidates_omitted={result.empty_session_candidates_omitted}"
            )
        return tuple(lines)

    def apply_session_maintenance_orphan_cleanup(self) -> tuple[str, ...]:
        result = self._store.apply_session_maintenance_orphan_cleanup()
        lines = [
            f"dry_run={str(result.dry_run).lower()}",
            f"deleted_orphan_rows={result.total_deleted_rows}",
        ]
        lines.extend(
            f"deleted_orphan_table={table} rows={count}"
            for table, count in result.deleted_rows_by_table
        )
        return tuple(lines)

    def apply_session_maintenance_vacuum(self) -> tuple[str, ...]:
        result = self._store.apply_session_maintenance_vacuum()
        return (
            f"dry_run={str(result.dry_run).lower()}",
            f"before_db_size_bytes={result.before_db_size_bytes}",
            f"after_db_size_bytes={result.after_db_size_bytes}",
            f"before_page_count={result.before_page_count}",
            f"after_page_count={result.after_page_count}",
            f"before_freelist_count={result.before_freelist_count}",
            f"after_freelist_count={result.after_freelist_count}",
            f"page_size={result.page_size}",
        )

    def _conversation_messages_from_history(self, session_id: str) -> list[Message]:
        return list(
            ContextManager().messages_from_history(
                self.load_history_items(session_id),
                include_context_baseline_updates=False,
            )
        )

    def _history_thread_id(self, session_id: str, items: tuple[HistoryItem, ...]) -> str:
        if items:
            return items[-1].thread_id
        return session_id

    def _refresh_snapshot(self, session_id: str) -> None:
        conversation = self.load_conversation(session_id)
        self._write_snapshot(conversation)

    def _write_snapshot(self, conversation: Conversation) -> None:
        self._snapshot_service.write_conversation_snapshot(
            conversation=conversation,
            context=SessionSnapshotContext(
                workspace_root=self._workspace_root,
                plan_state=self.load_plan_state(conversation.session_id),
            ),
        )

    def write_subagent_snapshot(
        self,
        *,
        parent_session_id: str,
        child_session_id: str,
        parent_turn_id: str,
        agent_type: str,
        status: str,
        mode: str,
        description: str,
        report: str,
        tool_calls: int,
        error: str | None,
        started_at: str | None,
        completed_at: str | None,
        context_diagnostics: dict[str, object],
    ) -> None:
        entry = self._snapshot_service.write_subagent_snapshot(
            parent_session_id=parent_session_id,
            child_session_id=child_session_id,
            parent_turn_id=parent_turn_id,
            agent_type=agent_type,
            status=status,
            mode=mode,
            description=description,
            report=report,
            tool_calls=tool_calls,
            error=error,
            started_at=started_at,
            completed_at=completed_at,
            context_diagnostics=context_diagnostics,
            transcript_items=tuple(
                item.to_dict() for item in self.load_history_items(child_session_id)
            ),
        )
        self._refresh_snapshot(parent_session_id)
        self._snapshot_service.append_event(
            session_id=parent_session_id,
            event_type="subagent.updated",
            payload={"subagent": entry},
        )

    def _plan_event_payload(self, plan_state: PlanState) -> dict[str, object]:
        status = "active" if plan_state.current_in_progress_item_id() else "idle"
        return {
            "status": status,
            "items": [self._plan_event_item_payload(item) for item in plan_state.items],
        }

    def _plan_event_item_payload(self, item: PlanItem) -> dict[str, object]:
        payload: dict[str, object] = {
            "id": item.id,
            "text": item.content,
            "status": item.status.value,
        }
        if item.evidence:
            payload["evidence"] = list(item.evidence)
        return payload

    def _save_state(
        self,
        *,
        session_id: str,
        thread_id: str,
        state_key: str,
        payload: JsonObject | JsonArray,
    ) -> None:
        self._store.save_state(
            session_id=session_id,
            workspace_root=self._workspace_root,
            thread_id=thread_id,
            state_key=state_key,
            payload=payload,
        )

    def _load_state_object(self, session_id: str, state_key: str) -> JsonObject | None:
        payload = self._store.load_state(session_id, state_key)
        if payload is None:
            return None
        if not isinstance(payload, dict):
            raise ValueError(f"{state_key} must serialize to an object.")
        return payload

    def _load_state_list(self, session_id: str, state_key: str) -> list[object]:
        payload = self._store.load_state(session_id, state_key)
        if payload is None:
            return []
        if not isinstance(payload, list):
            raise ValueError(f"{state_key} must serialize to a list.")
        return payload
