from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ToolInvocationContext:
    owner_session_id: str


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
    return fallback if context is None else context.owner_session_id


__all__ = [
    "ToolInvocationContext",
    "current_tool_owner_session_id",
    "tool_invocation_scope",
]
