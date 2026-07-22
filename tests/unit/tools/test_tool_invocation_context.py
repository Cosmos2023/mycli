from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from mycli.tools.invocation_context import (
    ToolInvocationContext,
    current_tool_owner_session_id,
    tool_invocation_scope,
)


def test_tool_invocation_scope_restores_owner_after_nested_failure() -> None:
    assert current_tool_owner_session_id("main") == "main"

    with tool_invocation_scope(ToolInvocationContext(owner_session_id="child-a")):
        assert current_tool_owner_session_id("main") == "child-a"
        with pytest.raises(RuntimeError, match="boom"):
            with tool_invocation_scope(
                ToolInvocationContext(owner_session_id="child-b")
            ):
                assert current_tool_owner_session_id("main") == "child-b"
                raise RuntimeError("boom")
        assert current_tool_owner_session_id("main") == "child-a"

    assert current_tool_owner_session_id("main") == "main"


def test_tool_invocation_scope_isolated_between_threads() -> None:
    barrier = Barrier(2)

    def resolve(owner_session_id: str) -> str:
        with tool_invocation_scope(ToolInvocationContext(owner_session_id=owner_session_id)):
            barrier.wait(timeout=2)
            return current_tool_owner_session_id("main")

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(resolve, "child-a")
        second = executor.submit(resolve, "child-b")

    assert {first.result(), second.result()} == {"child-a", "child-b"}
    assert current_tool_owner_session_id("main") == "main"
