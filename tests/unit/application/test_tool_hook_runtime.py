from __future__ import annotations

from mycli.application.runtime.tools.tool_hook_runtime import ToolHookRuntime
from mycli.domain.tooling.calls import ToolCall
from mycli.services.hooks import HookAction, HookManager, HookPoint, HookResult
from mycli.tools.base import ToolResult


def test_tool_hook_runtime_denies_pre_tool_use_with_policy_result() -> None:
    hook_manager = HookManager()
    hook_manager.register(
        HookPoint.PRE_TOOL_USE,
        lambda ctx: HookResult(action=HookAction.DENY, message="blocked"),
    )
    runtime = ToolHookRuntime(
        session_id="demo",
        hook_manager=hook_manager,
    )

    result = runtime.before_tool_use(
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        turn_id="turn_1",
    )

    assert result.call.arguments == {"path": "README.md"}
    assert result.denied_result is not None
    assert result.denied_result.summary == "Tool denied: blocked"
    assert result.denied_result.error == "blocked"
    assert result.denied_result.raw_payload == {
        "tool_name": "read_file",
        "arguments": {"path": "README.md"},
        "error_kind": "tool_denied_by_hook",
    }
    assert [summary.safe_payload() for summary in result.summaries] == [
        {
            "hook_point": "pre_tool_use",
            "hook_name": "<lambda>",
            "status": "ok",
            "action": "deny",
            "message": "blocked",
        }
    ]


def test_tool_hook_runtime_applies_pre_tool_use_modifications() -> None:
    hook_manager = HookManager()
    hook_manager.register(
        HookPoint.PRE_TOOL_USE,
        lambda ctx: HookResult(
            action=HookAction.MODIFY,
            modified_args={"path": "pyproject.toml"},
        ),
    )
    runtime = ToolHookRuntime(
        session_id="demo",
        hook_manager=hook_manager,
    )

    result = runtime.before_tool_use(
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        turn_id="turn_1",
    )

    assert result.denied_result is None
    assert result.call == ToolCall(
        name="read_file",
        arguments={"path": "pyproject.toml"},
        reason="inspect",
        call_id="call_read_1",
    )
    assert result.summaries[0].safe_payload()["action"] == "modify"


def test_tool_hook_runtime_applies_post_tool_modify_and_contexts() -> None:
    hook_manager = HookManager()
    hook_manager.register(
        HookPoint.POST_TOOL_USE,
        lambda ctx: HookResult(
            action=HookAction.MODIFY,
            modified_args={
                "summary": "post hook summary",
                "raw_payload": {"post_hook": "seen"},
            },
            additional_contexts=("Use this result.",),
        ),
        name="post_modifier",
    )
    runtime = ToolHookRuntime(
        session_id="demo",
        hook_manager=hook_manager,
    )

    result = runtime.after_tool_use(
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        turn_id="turn_1",
        result=ToolResult(
            success=True,
            summary="Read README.md",
            raw_payload={"path": "README.md"},
        ),
    )

    assert result.result.success is True
    assert result.result.summary == "post hook summary"
    assert result.result.raw_payload == {"path": "README.md", "post_hook": "seen"}
    assert result.additional_contexts == ("Use this result.",)
    assert [summary.safe_payload() for summary in result.summaries] == [
        {
            "hook_point": "post_tool_use",
            "hook_name": "post_modifier",
            "status": "ok",
            "action": "modify",
        }
    ]


def test_tool_hook_runtime_applies_post_tool_deny() -> None:
    hook_manager = HookManager()
    hook_manager.register(
        HookPoint.POST_TOOL_USE,
        lambda ctx: HookResult(action=HookAction.DENY, message="bad result"),
        name="post_deny",
    )
    runtime = ToolHookRuntime(
        session_id="demo",
        hook_manager=hook_manager,
    )

    result = runtime.after_tool_use(
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        turn_id="turn_1",
        result=ToolResult(
            success=True,
            summary="Read README.md",
            raw_payload={"path": "README.md"},
        ),
    )

    assert result.result.success is False
    assert result.result.summary == "Tool result denied by hook: bad result"
    assert result.result.error == "bad result"
    assert result.result.raw_payload == {
        "path": "README.md",
        "error_kind": "tool_denied_by_post_hook",
    }
