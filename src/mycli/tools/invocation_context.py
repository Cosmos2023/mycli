from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

from mycli.domain.runtime import RuntimeInterruptToken


@dataclass(frozen=True, slots=True)
class ToolInvocationContext:
    owner_session_id: str | None
    interrupt_token: RuntimeInterruptToken | None = None


_CURRENT_TOOL_INVOCATION: ContextVar[ToolInvocationContext | None] = ContextVar(
    "mycli_tool_invocation",
    default=None,
)


@contextmanager
def tool_invocation_scope(context: ToolInvocationContext | None) -> Iterator[None]:
    if context is None:
        yield
        return
    token = _CURRENT_TOOL_INVOCATION.set(context)
    try:
        yield
    finally:
        _CURRENT_TOOL_INVOCATION.reset(token)


def current_tool_owner_session_id(fallback: str) -> str:
    context = _CURRENT_TOOL_INVOCATION.get()
    return (
        fallback
        if context is None or context.owner_session_id is None
        else context.owner_session_id
    )


def current_tool_interrupt_token() -> RuntimeInterruptToken | None:
    context = _CURRENT_TOOL_INVOCATION.get()
    return None if context is None else context.interrupt_token


__all__ = [
    "ToolInvocationContext",
    "current_tool_interrupt_token",
    "current_tool_owner_session_id",
    "tool_invocation_scope",
]
