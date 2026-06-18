from __future__ import annotations

from mycli.services.hooks.manager import HookManager
from mycli.services.hooks.types import (
    HookAction,
    HookContext,
    HookExecutionStatus,
    HookPoint,
    HookResult,
)
from mycli.services.hooks.builtin import post_tool_context


class TestHookManager:
    def test_register_and_execute(self) -> None:
        manager = HookManager()

        def my_hook(ctx: HookContext) -> HookResult:
            return HookResult(action=HookAction.ALLOW)

        manager.register(HookPoint.PRE_TOOL_USE, my_hook)
        results = manager.execute(
            HookPoint.PRE_TOOL_USE,
            HookContext(hook_point=HookPoint.PRE_TOOL_USE, tool_name="read_file"),
        )
        assert len(results) == 1
        assert results[0].action is HookAction.ALLOW

    def test_deny_stops_chain(self) -> None:
        manager = HookManager()
        second_called = False

        def deny_hook(ctx: HookContext) -> HookResult:
            return HookResult(action=HookAction.DENY, message="blocked")

        def second_hook(ctx: HookContext) -> HookResult:
            nonlocal second_called
            second_called = True
            return HookResult(action=HookAction.ALLOW)

        manager.register(HookPoint.PRE_TOOL_USE, deny_hook)
        manager.register(HookPoint.PRE_TOOL_USE, second_hook)
        results = manager.execute(
            HookPoint.PRE_TOOL_USE,
            HookContext(hook_point=HookPoint.PRE_TOOL_USE, tool_name="edit_file"),
        )
        assert len(results) == 1
        assert results[0].action is HookAction.DENY
        assert second_called is False

    def test_modify_passes_modified_args(self) -> None:
        manager = HookManager()

        def modify_hook(ctx: HookContext) -> HookResult:
            return HookResult(
                action=HookAction.MODIFY,
                modified_args={"content": "modified content"},
            )

        manager.register(HookPoint.PRE_TOOL_USE, modify_hook)
        results = manager.execute(
            HookPoint.PRE_TOOL_USE,
            HookContext(
                hook_point=HookPoint.PRE_TOOL_USE,
                tool_name="edit_file",
                tool_args={"file_path": "x.py", "content": "original"},
            ),
        )
        assert results[0].action is HookAction.MODIFY
        assert results[0].modified_args == {"content": "modified content"}

    def test_hook_exception_is_caught(self) -> None:
        manager = HookManager()

        def crashy(ctx: HookContext) -> HookResult:
            raise RuntimeError("boom")

        manager.register(HookPoint.PRE_TOOL_USE, crashy)
        results = manager.execute(
            HookPoint.PRE_TOOL_USE,
            HookContext(hook_point=HookPoint.PRE_TOOL_USE),
        )
        assert len(results) == 0

    def test_snapshot_records_execution_state(self) -> None:
        manager = HookManager()

        def allow_hook(ctx: HookContext) -> HookResult:
            return HookResult(action=HookAction.ALLOW, message="allowed")

        def modify_hook(ctx: HookContext) -> HookResult:
            return HookResult(action=HookAction.MODIFY, modified_args={"path": "new.md"})

        manager.register(HookPoint.PRE_TOOL_USE, allow_hook)
        manager.register(HookPoint.PRE_TOOL_USE, modify_hook)

        execution = manager.execute_with_summary(
            HookPoint.PRE_TOOL_USE,
            HookContext(hook_point=HookPoint.PRE_TOOL_USE, tool_name="Read"),
        )

        assert [result.action for result in execution.results] == [
            HookAction.ALLOW,
            HookAction.MODIFY,
        ]
        assert [summary.safe_payload()["hook_name"] for summary in execution.summaries] == [
            "allow_hook",
            "modify_hook",
        ]
        snapshot = manager.snapshot()
        assert [item.hook_name for item in snapshot] == ["allow_hook", "modify_hook"]
        assert snapshot[0].call_count == 1
        assert snapshot[0].last_status is HookExecutionStatus.OK
        assert snapshot[1].modify_count == 1

    def test_snapshot_records_error_without_leaking_message(self) -> None:
        manager = HookManager()

        def crashy(ctx: HookContext) -> HookResult:
            raise RuntimeError("token=sk-secret")

        manager.register(HookPoint.PRE_TOOL_USE, crashy)

        execution = manager.execute_with_summary(
            HookPoint.PRE_TOOL_USE,
            HookContext(hook_point=HookPoint.PRE_TOOL_USE),
        )

        assert execution.results == ()
        assert execution.summaries[0].status is HookExecutionStatus.ERROR
        assert execution.summaries[0].safe_payload()["message"] == "RuntimeError"
        snapshot = manager.snapshot()
        assert snapshot[0].error_count == 1
        assert "sk-secret" not in snapshot[0].safe_line()


def test_post_tool_context_hook_adds_context_only_after_tool_result() -> None:
    skipped = post_tool_context(
        HookContext(hook_point=HookPoint.PRE_TOOL_USE, tool_name="Read")
    )
    assert skipped.additional_contexts == ()

    result = post_tool_context(
        HookContext(
            hook_point=HookPoint.POST_TOOL_USE,
            tool_name="Read",
            metadata={"success": True},
        )
    )

    assert result.action is HookAction.ALLOW
    assert "do not repeat the same tool call" in result.additional_contexts[0]
