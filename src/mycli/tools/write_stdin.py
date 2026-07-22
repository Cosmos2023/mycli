from __future__ import annotations

from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolEffectProfile, ToolParameter, ToolResult, ToolSpec
from mycli.tools.invocation_context import current_tool_owner_session_id
from mycli.tools.model_output import shell_model_output
from mycli.tools.shell_registry import (
    LEGACY_SHELL_OWNER,
    SHELL_REGISTRY,
    ShellProcessRegistry,
)


class WriteStdinTool:
    name = "WriteStdin"
    spec = ToolSpec(
        name=name,
        description=(
            "Wait for output from a running Shell session or write input to a PTY "
            "session."
        ),
        parameters=(
            ToolParameter(name="session_id", type="string", required=True),
            ToolParameter(name="chars", type="string", required=False),
            ToolParameter(name="yield_time_ms", type="integer", required=False),
            ToolParameter(name="max_output_tokens", type="integer", required=False),
        ),
        risk_level="low",
        model_output_adapter=shell_model_output,
    )

    def __init__(
        self,
        *,
        session_id: str = LEGACY_SHELL_OWNER,
        registry: ShellProcessRegistry | None = None,
    ) -> None:
        self._session_id = session_id
        self._registry = registry or SHELL_REGISTRY

    def configure_shell_session(self, session_id: str) -> None:
        self._session_id = session_id

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(process=True)

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        shell_id = str(
            arguments.get("session_id")
            or arguments.get("shell_id")
            or arguments.get("bash_id")
            or ""
        )
        if not shell_id:
            return self._error(
                "WriteStdin requires session_id.",
                error_kind="missing_shell_id",
            )
        chars = arguments.get("chars", "")
        if not isinstance(chars, str):
            return self._error(
                "WriteStdin chars must be a string.",
                error_kind="invalid_chars",
                shell_id=shell_id,
            )
        yield_time_ms = arguments.get("yield_time_ms", 250)
        if not _is_positive_int(yield_time_ms):
            return self._error(
                "WriteStdin yield_time_ms must be a positive integer.",
                error_kind="invalid_yield_time",
                shell_id=shell_id,
            )
        max_output_tokens = arguments.get("max_output_tokens", 10_000)
        if not _is_positive_int(max_output_tokens):
            return self._error(
                "WriteStdin max_output_tokens must be a positive integer.",
                error_kind="invalid_output_budget",
                shell_id=shell_id,
            )

        owner_session_id = current_tool_owner_session_id(self._session_id)
        payload = self._registry.interact(
            shell_id,
            owner_session_id=owner_session_id,
            chars=chars,
            yield_time_ms=yield_time_ms,
            max_output_tokens=max_output_tokens,
        )
        success = "error" not in payload
        return ToolResult(
            success=success,
            summary=(
                f"Continued shell {shell_id}"
                if success
                else f"Failed to continue shell {shell_id}"
            ),
            error=str(payload["error"]) if "error" in payload else None,
            raw_payload=payload,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)

    @staticmethod
    def _error(
        message: str,
        *,
        error_kind: str,
        shell_id: str = "",
    ) -> ToolResult:
        return ToolResult(
            success=False,
            summary="Failed to continue shell",
            error=message,
            raw_payload={
                "shell_id": shell_id,
                "error_kind": error_kind,
                "error": message,
            },
        )


def _is_positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


__all__ = ["WriteStdinTool"]
