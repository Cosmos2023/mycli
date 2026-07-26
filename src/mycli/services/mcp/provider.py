from __future__ import annotations

from dataclasses import dataclass, field

from mycli.domain.conversation import Conversation
from mycli.domain.runtime import PlanState, RuntimeInterruptToken
from mycli.domain.tooling.contributed_tools import ToolContributionRegistration
from mycli.services.mcp.tool_adapter import McpToolAdapter


@dataclass(slots=True)
class McpToolContributionProvider:
    """Supplies configured MCP tools through the runtime contribution path."""

    adapter: McpToolAdapter
    _registrations: tuple[ToolContributionRegistration, ...] | None = field(default=None)

    def provide(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> tuple[ToolContributionRegistration, ...]:
        del user_message, conversation, plan_state
        if interrupt_token is not None:
            interrupt_token.raise_if_interrupted()
        if self._registrations is None:
            self.adapter.list_tool_stubs(interrupt_token=interrupt_token)
            if interrupt_token is not None:
                interrupt_token.raise_if_interrupted()
            self._registrations = self.adapter.registrations_with_full_schema()
        return self._registrations
