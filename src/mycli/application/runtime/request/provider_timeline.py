from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING

from mycli.domain.conversation import Conversation, Message, Role
from mycli.domain.runtime import InstructionContract, InstructionFragment, stable_hash
from mycli.domain.session_store import JsonObject
from mycli.state.session_serialization import deserialize_message, serialize_message

if TYPE_CHECKING:
    from mycli.state.session_service import SessionService


@dataclass(slots=True, frozen=True)
class ProviderTimelineState:
    messages: tuple[Message, ...] = ()
    source_messages: tuple[Message, ...] = ()
    context_entries: dict[str, dict[str, str]] = field(default_factory=dict)
    reset_count: int = 0

    def to_dict(self) -> JsonObject:
        return {
            "messages": [serialize_message(message) for message in self.messages],
            "source_messages": [
                serialize_message(message) for message in self.source_messages
            ],
            "context_entries": {
                key: dict(value) for key, value in self.context_entries.items()
            },
            "reset_count": self.reset_count,
        }

    @classmethod
    def from_dict(cls, payload: JsonObject) -> ProviderTimelineState:
        raw_messages = payload.get("messages")
        raw_source_messages = payload.get("source_messages")
        raw_context_entries = payload.get("context_entries")
        raw_reset_count = payload.get("reset_count")
        return cls(
            messages=tuple(
                deserialize_message(item)
                for item in raw_messages
                if isinstance(item, dict)
            )
            if isinstance(raw_messages, list)
            else (),
            source_messages=tuple(
                deserialize_message(item)
                for item in raw_source_messages
                if isinstance(item, dict)
            )
            if isinstance(raw_source_messages, list)
            else (),
            context_entries={
                str(key): {
                    str(nested_key): str(nested_value)
                    for nested_key, nested_value in value.items()
                }
                for key, value in raw_context_entries.items()
                if isinstance(value, dict)
            }
            if isinstance(raw_context_entries, dict)
            else {},
            reset_count=raw_reset_count if isinstance(raw_reset_count, int) else 0,
        )


class ProviderTimelineProjector:
    def project(
        self,
        *,
        state: ProviderTimelineState,
        contract: InstructionContract,
        conversation: tuple[Message, ...],
        current_user_request: str,
    ) -> ProviderTimelineState:
        context_messages, context_entries = self._context_updates(
            contract=contract,
            previous=state.context_entries,
        )
        if not state.messages and not state.source_messages:
            return ProviderTimelineState(
                messages=(*context_messages, *self._timeline_messages(conversation)),
                source_messages=conversation,
                context_entries=context_entries,
                reset_count=state.reset_count,
            )

        unsynced = self._unsynced_messages(
            previous=state.source_messages,
            current=conversation,
        )
        if unsynced is None:
            return ProviderTimelineState(
                messages=(
                    *self._all_context_messages(contract),
                    *self._timeline_messages(conversation),
                ),
                source_messages=conversation,
                context_entries=context_entries,
                reset_count=state.reset_count + 1,
            )

        timeline_unsynced = self._timeline_messages(unsynced)
        current_user_index = self._current_user_index(
            timeline_unsynced,
            current_user_request=current_user_request,
        )
        if current_user_index is None:
            appended = (*timeline_unsynced, *context_messages)
        else:
            appended = (
                *timeline_unsynced[:current_user_index],
                *context_messages,
                *timeline_unsynced[current_user_index:],
            )
        return ProviderTimelineState(
            messages=(*state.messages, *appended),
            source_messages=conversation,
            context_entries=context_entries,
            reset_count=state.reset_count,
        )

    def _context_updates(
        self,
        *,
        contract: InstructionContract,
        previous: dict[str, dict[str, str]],
    ) -> tuple[tuple[Message, ...], dict[str, dict[str, str]]]:
        current = self._context_entries(contract)
        updates: list[Message] = []
        for role, section in self._context_sections(contract):
            key = self._context_key(role, section)
            entry = current[key]
            if previous.get(key, {}).get("hash") == entry["hash"]:
                continue
            updates.append(self._context_message(role, section, key, entry["hash"]))

        for key, entry in previous.items():
            if key in current:
                continue
            role = self._context_role(entry.get("role"))
            kind = entry.get("kind", "context")
            updates.append(
                Message(
                    role=role,
                    content=(
                        f'<context_update kind="{kind}" status="inactive">'
                        f"The previous {kind} context is no longer active."
                        "</context_update>"
                    ),
                    metadata={
                        "context_key": key,
                        "context_kind": kind,
                        "context_inactive": True,
                        "model_visible": True,
                        "provider_timeline": True,
                    },
                )
            )
        return tuple(updates), current

    def _all_context_messages(
        self,
        contract: InstructionContract,
    ) -> tuple[Message, ...]:
        entries = self._context_entries(contract)
        return tuple(
            self._context_message(
                role,
                section,
                self._context_key(role, section),
                entries[self._context_key(role, section)]["hash"],
            )
            for role, section in self._context_sections(contract)
        )

    def _context_entries(
        self,
        contract: InstructionContract,
    ) -> dict[str, dict[str, str]]:
        entries: dict[str, dict[str, str]] = {}
        for role, section in self._context_sections(contract):
            key = self._context_key(role, section)
            entries[key] = {
                "role": role,
                "kind": str(section.kind),
                "title": section.title,
                "source": section.source or "",
                "hash": stable_hash(section.content.strip()),
            }
        return entries

    def _context_sections(
        self,
        contract: InstructionContract,
    ) -> tuple[tuple[Role, InstructionFragment], ...]:
        sections: list[tuple[Role, InstructionFragment]] = []
        sections.extend(
            ("developer", section)
            for section in contract.developer_sections
            if self._section_is_model_visible(section)
        )
        sections.extend(
            ("user", section)
            for section in contract.contextual_user_sections
            if self._section_is_model_visible(section)
        )
        return tuple(sections)

    def _context_key(self, role: Role, section: InstructionFragment) -> str:
        return json.dumps(
            [role, str(section.kind), section.source or "", section.title],
            ensure_ascii=False,
            separators=(",", ":"),
        )

    def _context_message(
        self,
        role: Role,
        section: InstructionFragment,
        key: str,
        content_hash: str,
    ) -> Message:
        return Message(
            role=role,
            content=section.content.strip(),
            metadata={
                **section.metadata,
                "context_key": key,
                "context_kind": str(section.kind),
                "context_hash": content_hash,
                "model_visible": True,
                "provider_timeline": True,
            },
        )

    def _unsynced_messages(
        self,
        *,
        previous: tuple[Message, ...],
        current: tuple[Message, ...],
    ) -> tuple[Message, ...] | None:
        if len(previous) > len(current):
            return None
        previous_payload = tuple(self._cursor_payload(message) for message in previous)
        current_prefix = tuple(
            self._cursor_payload(message) for message in current[: len(previous)]
        )
        if previous_payload != current_prefix:
            return None
        return current[len(previous) :]

    def _cursor_payload(self, message: Message) -> tuple[object, ...]:
        return (
            message.role,
            message.content,
            message.tool_call_id,
            tuple(
                (call.name, call.arguments, call.call_id)
                for call in message.tool_calls
            ),
            tuple(
                (
                    block.type,
                    block.text,
                    block.tool_name,
                    block.tool_arguments,
                    block.call_id,
                )
                for block in message.blocks
            ),
        )

    def _timeline_messages(
        self,
        messages: tuple[Message, ...],
    ) -> tuple[Message, ...]:
        return tuple(self._timeline_message(message) for message in messages)

    def _timeline_message(self, message: Message) -> Message:
        if (
            message.role == "user"
            and message.metadata.get("event_kind") == "turn_aborted_marker"
        ):
            return replace(
                message,
                role="developer",
                metadata={**message.metadata, "model_role": "developer"},
            )
        return message

    def _current_user_index(
        self,
        messages: tuple[Message, ...],
        *,
        current_user_request: str,
    ) -> int | None:
        if not current_user_request:
            return None
        for index in range(len(messages) - 1, -1, -1):
            message = messages[index]
            if message.role == "user" and message.content == current_user_request:
                return index
        return None

    def _section_is_model_visible(self, section: InstructionFragment) -> bool:
        return bool(section.content.strip()) and section.metadata.get("model_visible") is not False

    def _context_role(self, value: object) -> Role:
        if value == "developer":
            return "developer"
        return "user"


class ProviderTimelineCoordinator:
    def __init__(
        self,
        *,
        session_id: str,
        session_service: SessionService,
        projector: ProviderTimelineProjector | None = None,
    ) -> None:
        self._session_id = session_id
        self._session_service = session_service
        self._projector = projector or ProviderTimelineProjector()

    def load_state(self) -> ProviderTimelineState:
        payload = self._session_service.load_provider_timeline_state(self._session_id)
        if payload is None:
            return ProviderTimelineState()
        return ProviderTimelineState.from_dict(payload)

    def project_and_persist(
        self,
        *,
        contract: InstructionContract,
        conversation: Conversation,
        current_user_request: str,
    ) -> InstructionContract:
        state = self._projector.project(
            state=self.load_state(),
            contract=contract,
            conversation=tuple(conversation.messages),
            current_user_request=current_user_request,
        )
        self._session_service.save_provider_timeline_state(
            self._session_id,
            state.to_dict(),
        )
        return replace(
            contract,
            developer_sections=(),
            contextual_user_sections=(),
            conversation_messages=state.messages,
            current_user_request="",
        )


__all__ = [
    "ProviderTimelineCoordinator",
    "ProviderTimelineProjector",
    "ProviderTimelineState",
]
