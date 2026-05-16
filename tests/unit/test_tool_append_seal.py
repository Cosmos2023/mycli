from __future__ import annotations

from mycli.application.runtime.tools.tool_execution_service import ToolExecutionService
from mycli.domain.conversation import Conversation
from mycli.services.context.context_manager import ContextManager
from mycli.services.tracing import TraceService


def test_record_tool_message_marks_appended_tool_message_append_only(tmp_path) -> None:
    service = ToolExecutionService(
        session_id="test",
        context_manager=ContextManager(),
        trace_service=TraceService(home_dir=tmp_path / "home"),
        append_turn_item=lambda **_: None,
        append_lifecycle_events=lambda **_: None,
        apply_tool_effects=lambda **kwargs: kwargs["plan_state"],
        normalize_tool_call=lambda call: call,
    )
    conversation = Conversation(session_id="test")

    service._record_tool_message(
        conversation,
        tool_name="Read",
        content="formatted result content",
        success=True,
        summary="Read file",
        error=None,
        raw_payload={"path": "/tmp/example.py"},
        tool_call_id="call_1",
    )

    message = conversation.messages[-1]
    assert message.role == "tool"
    assert message.metadata["tool_name"] == "Read"
    assert message.metadata["append_only"] is True
    assert "cache_frozen" not in message.metadata
    assert message.metadata["l1_truncated"] is True
