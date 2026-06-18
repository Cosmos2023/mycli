from __future__ import annotations

from mycli.services.hooks.types import HookAction, HookContext, HookPoint, HookResult


def post_tool_context(ctx: HookContext) -> HookResult:
    if ctx.hook_point is not HookPoint.POST_TOOL_USE:
        return HookResult(action=HookAction.ALLOW)
    if not ctx.tool_name:
        return HookResult(action=HookAction.ALLOW)
    if "success" not in ctx.metadata:
        return HookResult(action=HookAction.ALLOW)
    return HookResult(
        action=HookAction.ALLOW,
        additional_contexts=(
            (
                "The previous tool call has completed. Use its result above; "
                "do not repeat the same tool call unless the result is missing, "
                "stale, or insufficient for the current task."
            ),
        ),
    )
