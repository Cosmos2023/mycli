from __future__ import annotations

from pathlib import Path
from typing import Any, cast

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import (
    ContextBaseline,
    DecisionAction,
    DecisionKind,
    HistoryItem,
    HistoryItemType,
    PendingApproval,
    PendingDecision,
    PlanItem,
    PlanState,
    PlanStatus,
    RuntimeBlock,
    SessionCommandAllowance,
    SessionRuntimeSnapshot,
    SuspendedTurn,
    TurnRecord,
    TurnRollout,
    TurnStatus,
)
from mycli.domain.session_store import JsonArray, JsonObject, SessionOverview, SessionStore
from mycli.domain.tools import ToolCall
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore
from mycli.schemas.responses_protocol import ResponsesContinuationState


class SessionService:
    _KEY_ALLOWLIST = "command_allowances"
    _KEY_CONTEXT_BASELINE = "context_baseline"
    _KEY_DYNAMIC_TOOL_STATE = "dynamic_tool_state"
    _KEY_PENDING_DECISION = "pending_decision"
    _KEY_PLAN_STATE = "plan_state"
    _KEY_RESPONSES_CONTINUATION = "responses_continuation_state"
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

    def save_conversation(self, conversation: Conversation) -> None:
        self._store.replace_conversation(
            session_id=conversation.session_id,
            workspace_root=self._workspace_root,
            thread_id=conversation.session_id,
            messages=[self._serialize_message(message) for message in conversation.messages],
        )

    def load_conversation(self, session_id: str) -> Conversation:
        payload = self._store.load_conversation(session_id)
        conversation = Conversation(session_id=session_id)
        if payload is None:
            conversation.messages.extend(self._conversation_messages_from_history(session_id))
            return conversation
        for item in payload:
            conversation.append(self._deserialize_message(item))
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
        if (
            not history_items
            and context_baseline is None
            and not turn_rollouts
            and continuation_state is None
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
                call_id=self._optional_str(payload["tool_call"].get("call_id")),
            ),
            kind=DecisionKind(str(payload["kind"])),
            reason=str(payload["reason"]),
            preview=str(payload["preview"]),
            options=tuple(DecisionAction(str(option)) for option in payload["options"]),
            command_pattern=self._optional_str(payload.get("command_pattern")),
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
                }
                for item in plan_state.items
            ],
        )

    def load_plan_state(self, session_id: str) -> PlanState:
        payload = self._load_state_list(session_id, self._KEY_PLAN_STATE)
        return PlanState(
            items=tuple(
                PlanItem(
                    id=str(item["id"]),
                    content=str(item["content"]),
                    status=PlanStatus(str(item["status"])),
                )
                for item in payload
                if isinstance(item, dict)
            )
        )

    def clear_plan_state(self, session_id: str) -> None:
        self._store.delete_state(session_id, self._KEY_PLAN_STATE)

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
                "conversation": [self._serialize_message(message) for message in turn.conversation],
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
                    call_id=self._optional_str(tool_call_payload.get("call_id")),
                ),
                reason=str(pending_payload["reason"]),
                preview=str(pending_payload["preview"]),
                command_pattern=self._optional_str(pending_payload.get("command_pattern")),
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

        return SuspendedTurn(
            user_message=str(payload["user_message"]),
            conversation=tuple(
                self._deserialize_message(item)
                for item in conversation_payload
                if isinstance(item, dict)
            ),
            plan_state=PlanState(items=plan_items),
            pending_approval=pending_approval,
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

    def save_dynamic_tool_state(self, session_id: str, descriptors: list[dict[str, Any]]) -> None:
        self._save_state(
            session_id=session_id,
            thread_id=session_id,
            state_key=self._KEY_DYNAMIC_TOOL_STATE,
            payload=descriptors,
        )

    def load_dynamic_tool_state(self, session_id: str) -> list[dict[str, Any]]:
        payload = self._load_state_list(session_id, self._KEY_DYNAMIC_TOOL_STATE)
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

    def _serialize_message(self, message: Message) -> JsonObject:
        return {
            "role": message.role,
            "content": message.content,
            "tool_call_id": message.tool_call_id,
            "response_id": message.response_id,
            "blocks": [self._serialize_runtime_block(block) for block in message.blocks],
            "tool_calls": [
                {
                    "name": call.name,
                    "arguments": call.arguments,
                    "reason": call.reason,
                    "call_id": call.call_id,
                }
                for call in message.tool_calls
            ],
        }

    def _deserialize_message(self, payload: JsonObject) -> Message:
        blocks_payload = payload.get("blocks")
        if not isinstance(blocks_payload, list):
            blocks_payload = []
        blocks = tuple(
            self._deserialize_runtime_block(block_payload)
            for block_payload in blocks_payload
            if isinstance(block_payload, dict)
        )
        content = payload.get("content")
        if not isinstance(content, str):
            content = Message.text_content_from_blocks(blocks)

        tool_calls_payload = payload.get("tool_calls")
        if not isinstance(tool_calls_payload, list):
            tool_calls_payload = []

        return Message(
            role=cast(Any, str(payload["role"])),
            content=content,
            tool_call_id=self._optional_str(payload.get("tool_call_id")),
            tool_calls=tuple(
                ToolCall(
                    name=str(call["name"]),
                    arguments=dict(call["arguments"]),
                    reason=str(call["reason"]),
                    call_id=self._optional_str(call.get("call_id")),
                )
                for call in tool_calls_payload
                if isinstance(call, dict)
            ),
            blocks=blocks,
            response_id=self._optional_str(payload.get("response_id")),
        )

    def _serialize_runtime_block(self, block: RuntimeBlock) -> JsonObject:
        return {
            "type": block.type,
            "text": block.text,
            "tool_name": block.tool_name,
            "tool_arguments": block.tool_arguments,
            "call_id": block.call_id,
            "provider_id": block.provider_id,
            "metadata": block.metadata,
        }

    def _deserialize_runtime_block(self, payload: JsonObject) -> RuntimeBlock:
        metadata = payload.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}

        tool_arguments = payload.get("tool_arguments")
        if not isinstance(tool_arguments, dict):
            tool_arguments = None

        return RuntimeBlock(
            type=cast(Any, str(payload["type"])),
            text=self._optional_str(payload.get("text")),
            tool_name=self._optional_str(payload.get("tool_name")),
            tool_arguments=tool_arguments,
            call_id=self._optional_str(payload.get("call_id")),
            provider_id=self._optional_str(payload.get("provider_id")),
            metadata=metadata,
        )

    def _optional_str(self, value: object) -> str | None:
        if isinstance(value, str):
            return value
        return None

    def _conversation_messages_from_history(self, session_id: str) -> list[Message]:
        messages: list[Message] = []
        for item in self.load_history_items(session_id):
            if item.type is HistoryItemType.USER_MESSAGE:
                messages.append(Message(role="user", content=item.text or ""))
                continue
            if item.type is HistoryItemType.ASSISTANT_MESSAGE:
                provider_id = item.metadata.get("provider_id")
                text = item.text or ""
                messages.append(
                    Message(
                        role="assistant",
                        content=text,
                        blocks=(
                            ()
                            if not text
                            else (
                                RuntimeBlock(
                                    type="text",
                                    text=text,
                                    provider_id=provider_id if isinstance(provider_id, str) else None,
                                    metadata=dict(item.metadata),
                                ),
                            )
                        ),
                    )
                )
                continue
            if item.type is HistoryItemType.TOOL_CALL:
                arguments = item.metadata.get("arguments")
                tool_arguments = arguments if isinstance(arguments, dict) else {}
                provider_id = item.metadata.get("provider_id")
                messages.append(
                    Message(
                        role="assistant",
                        content=item.text or "",
                        tool_calls=(
                            ToolCall(
                                name=item.tool_name or "",
                                arguments=tool_arguments,
                                reason="model requested tool",
                                call_id=item.call_id,
                            ),
                        ),
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                text=item.text,
                                tool_name=item.tool_name,
                                tool_arguments=tool_arguments,
                                call_id=item.call_id,
                                provider_id=provider_id if isinstance(provider_id, str) else None,
                                metadata=dict(item.metadata),
                            ),
                        ),
                    )
                )
                continue
            if item.type is HistoryItemType.TOOL_RESULT:
                content = item.metadata.get("transcript_content")
                if not isinstance(content, str):
                    content = item.text or ""
                messages.append(
                    Message(
                        role="tool",
                        content=content,
                        tool_call_id=item.call_id,
                        blocks=(
                            RuntimeBlock(
                                type="tool_result",
                                text=content,
                                tool_name=item.tool_name,
                                call_id=item.call_id,
                                metadata=dict(item.metadata),
                            ),
                        ),
                    )
                )
        return messages

    def _history_thread_id(self, session_id: str, items: tuple[HistoryItem, ...]) -> str:
        if items:
            return items[-1].thread_id
        return session_id

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
