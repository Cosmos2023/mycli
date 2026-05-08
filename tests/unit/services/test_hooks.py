from __future__ import annotations

from mycli.services.hooks.manager import HookManager
from mycli.services.hooks.types import HookAction, HookContext, HookPoint, HookResult


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
