"""Compatibility service exports with conversation tree helpers."""

from mycli.domain.conversation import Conversation
from mycli.services.conversation_tree import ConversationTree
from mycli.state.session_service import SessionService as StateSessionService


class SessionService(StateSessionService):
    def save_conversation(self, conversation: Conversation) -> None:
        super().save_conversation(conversation)
        self._save_conversation_tree_metadata(conversation)

    def load_conversation(self, session_id: str) -> Conversation:
        conversation = super().load_conversation(session_id)
        metadata = self._load_conversation_tree_metadata(session_id)
        if metadata is None:
            return conversation
        conversation.parent_id = _optional_str(metadata.get("parent_id"))
        conversation.fork_point = _optional_int(metadata.get("fork_point"))
        return conversation

    def resume_conversation(self, session_id: str) -> Conversation:
        return ConversationTree((self.load_conversation(session_id),)).resume(session_id)

    def rewind_conversation(self, session_id: str, fork_point: int) -> Conversation:
        tree = ConversationTree((self.load_conversation(session_id),))
        conversation = tree.rewind(session_id, fork_point)
        self.save_conversation(conversation)
        return conversation

    def fork_conversation(
        self,
        source_session_id: str,
        new_session_id: str,
        fork_point: int | None = None,
    ) -> Conversation:
        tree = ConversationTree((self.load_conversation(source_session_id),))
        forked = tree.fork(source_session_id, new_session_id, fork_point)
        self.save_conversation(forked)
        return forked

    def _save_conversation_tree_metadata(self, conversation: Conversation) -> None:
        self._store.save_conversation_tree(
            session_id=conversation.session_id,
            workspace_root=self._workspace_root,
            thread_id=conversation.session_id,
            parent_id=conversation.parent_id,
            fork_point=conversation.fork_point,
        )

    def _load_conversation_tree_metadata(self, session_id: str) -> dict[str, object] | None:
        return self._store.load_conversation_tree(session_id)


def _optional_str(value: object) -> str | None:
    if isinstance(value, str):
        return value
    return None


def _optional_int(value: object) -> int | None:
    if isinstance(value, int):
        return value
    return None

__all__ = ["SessionService"]
