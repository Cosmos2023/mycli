from __future__ import annotations

from mycli.services.hooks.types import HookAction, HookContext, HookResult

HIGH_RISK_TOOLS = {"Shell", "Bash", "Edit", "Write"}


def permission_guard(ctx: HookContext) -> HookResult:
    tool_name = ctx.tool_name or ""
    if tool_name in HIGH_RISK_TOOLS:
        return HookResult(
            action=HookAction.ALLOW,
            message=f"High-risk tool {tool_name} requires user confirmation",
        )
    return HookResult(action=HookAction.ALLOW)
