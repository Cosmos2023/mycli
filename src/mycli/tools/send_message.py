from __future__ import annotations

from typing import Any, Protocol

from mycli.domain.subagents import SubAgentMessageResult
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolEffectProfile, ToolParameter, ToolResult, ToolSpec


class SupportsSendMessageService(Protocol):
    def send_message(self, child_session_id: str, message: str) -> SubAgentMessageResult:
        ...


class SendMessageTool:
    name = "SendMessage"
    spec = ToolSpec(
        name="SendMessage",
        description=(
            "Send additional instructions to a child sub-agent by child_session_id. "
            "Running children receive the message at the next model/tool round boundary; "
            "finished children resume in the background with their persisted context."
        ),
        parameters=(
            ToolParameter(
                name="child_session_id",
                type="string",
                required=True,
                description="Child session id returned by Task.",
            ),
            ToolParameter(
                name="message",
                type="string",
                required=True,
                description="Additional instruction for the child sub-agent.",
            ),
        ),
        risk_level="low",
    )

    def __init__(self, service: SupportsSendMessageService | None = None) -> None:
        self._service = service

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(filesystem="none")

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        child_session_id = str(arguments.get("child_session_id") or "").strip()
        if not child_session_id:
            return ToolResult(
                success=False,
                summary="Failed to send sub-agent message.",
                error="SendMessage requires child_session_id.",
                raw_payload={
                    "kind": "sub_agent_message",
                    "error_kind": "missing_child_session_id",
                },
            )
        message = str(arguments.get("message") or "").strip()
        if not message:
            return ToolResult(
                success=False,
                summary="Failed to send sub-agent message.",
                error="SendMessage requires a non-empty message.",
                raw_payload={
                    "kind": "sub_agent_message",
                    "child_session_id": child_session_id,
                    "error_kind": "missing_message",
                },
            )
        if self._service is None:
            return ToolResult(
                success=False,
                summary="SendMessage is unavailable until runtime binding completes.",
                error="SendMessage is not bound to a SubAgentService.",
                raw_payload={
                    "kind": "sub_agent_message",
                    "child_session_id": child_session_id,
                    "error_kind": "send_message_unbound",
                },
            )
        delivery = self._service.send_message(child_session_id, message)
        summary = {
            "queued": "Message queued for running sub-agent.",
            "resumed": "Sub-agent resumed with the new message.",
        }.get(delivery.delivery, "Failed to send sub-agent message.")
        return ToolResult(
            success=delivery.accepted,
            summary=summary,
            error=delivery.error,
            raw_payload={
                "kind": "sub_agent_message",
                "child_session_id": delivery.child_session_id,
                "delivery": delivery.delivery,
            },
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


__all__ = ["SendMessageTool", "SupportsSendMessageService"]
