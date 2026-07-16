from __future__ import annotations

from mycli.domain.subagents import SubAgentMessageResult
from mycli.tools.send_message import SendMessageTool


class FakeSendMessageService:
    def __init__(self, *, accepted: bool = True, delivery: str = "queued") -> None:
        self.accepted = accepted
        self.delivery = delivery
        self.calls: list[tuple[str, str]] = []

    def send_message(self, child_session_id: str, message: str) -> SubAgentMessageResult:
        self.calls.append((child_session_id, message))
        return SubAgentMessageResult(
            child_session_id=child_session_id,
            accepted=self.accepted,
            delivery=self.delivery,
            error=None if self.accepted else "Sub-agent not found.",
        )


def test_send_message_tool_delegates_without_returning_transcript() -> None:
    service = FakeSendMessageService()
    tool = SendMessageTool(service=service)

    result = tool.execute(
        {
            "child_session_id": "demo:sub:turn_1:abcd",
            "message": "Inspect failing tests.",
        }
    )

    assert result.success is True
    assert result.summary == "Message queued for running sub-agent."
    assert result.raw_payload == {
        "kind": "sub_agent_message",
        "child_session_id": "demo:sub:turn_1:abcd",
        "delivery": "queued",
    }
    assert service.calls == [
        ("demo:sub:turn_1:abcd", "Inspect failing tests.")
    ]


def test_send_message_tool_reports_terminal_resume() -> None:
    result = SendMessageTool(
        service=FakeSendMessageService(delivery="resumed")
    ).execute(
        {
            "child_session_id": "demo:sub:turn_1:abcd",
            "message": "Continue.",
        }
    )

    assert result.success is True
    assert result.summary == "Sub-agent resumed with the new message."
    assert result.raw_payload["delivery"] == "resumed"


def test_send_message_tool_validates_required_arguments_and_binding() -> None:
    missing_target = SendMessageTool().execute({"message": "Continue."})
    missing_message = SendMessageTool().execute(
        {"child_session_id": "demo:sub:turn_1:abcd"}
    )
    unbound = SendMessageTool().execute(
        {
            "child_session_id": "demo:sub:turn_1:abcd",
            "message": "Continue.",
        }
    )

    assert missing_target.raw_payload["error_kind"] == "missing_child_session_id"
    assert missing_message.raw_payload["error_kind"] == "missing_message"
    assert unbound.raw_payload["error_kind"] == "send_message_unbound"


def test_send_message_tool_propagates_service_rejection() -> None:
    result = SendMessageTool(
        service=FakeSendMessageService(accepted=False, delivery="missing")
    ).execute(
        {
            "child_session_id": "missing-child",
            "message": "Continue.",
        }
    )

    assert result.success is False
    assert result.error == "Sub-agent not found."
    assert result.raw_payload["delivery"] == "missing"
