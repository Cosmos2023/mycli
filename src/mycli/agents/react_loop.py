from __future__ import annotations

from pathlib import Path
from typing import Any

from mycli.application.turn_service import TurnService
from mycli.domain.conversation import Conversation
from mycli.domain.runtime import ExecutionContext, TurnResponse
from mycli.services.approval.approval_service import ApprovalService
from mycli.services.approval.safety_policy import SafetyPolicy


class ReactAgent:
    """Compatibility facade for the old ReAct agent entry point.

    Turn execution is intentionally delegated to `TurnService`, which now routes
    all work through `AgentRuntime` and `TurnExecutor`.
    """

    def __init__(
        self,
        model_client: Any,
        tool_registry: Any,
        safety_policy: SafetyPolicy | None = None,
    ) -> None:
        self._model_client = model_client
        self._tool_registry = tool_registry
        self._safety_policy = safety_policy or SafetyPolicy()

    def run(self, user_message: str, context: ExecutionContext) -> TurnResponse:
        home_dir = Path(context.config.workspace_root) / ".mycli-react-compat"
        service = TurnService(
            model_client=self._model_client,
            tool_registry=self._tool_registry,
            config=context.config,
            home_dir=home_dir,
            approval_service=ApprovalService(self._safety_policy),
        )
        if context.conversation_messages:
            service._session_service.save_conversation(
                Conversation(
                    session_id=context.config.session_id,
                    messages=list(context.conversation_messages),
                )
            )
        if context.plan_state.items:
            service._session_service.save_plan_state(
                context.config.session_id,
                context.plan_state,
            )
        return service.handle_user_turn(user_message)
