from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolEffectProfile, ToolResult

MAX_WRITE_DIAGNOSTICS = 20
WriteDiagnosticsRunner = Callable[[tuple[str, ...]], dict[str, object]]


@dataclass(slots=True)
class ToolWriteDiagnosticsRuntime:
    """Attaches bounded write diagnostics to successful mutating tool results."""

    runner: WriteDiagnosticsRunner | None = None

    def with_write_diagnostics_if_needed(
        self,
        *,
        call: ToolCall,
        result: ToolResult,
        effect_profile: ToolEffectProfile,
    ) -> ToolResult:
        if self.runner is None:
            return result
        if not result.success or effect_profile.filesystem != "write":
            return result
        paths = self._write_diagnostic_paths(call=call, result_payload=result.raw_payload)
        if not paths:
            return result
        diagnostics = self._run_write_diagnostics(paths)
        return ToolResult(
            success=result.success,
            summary=result.summary,
            artifacts=result.artifacts,
            raw_payload={**result.raw_payload, "write_diagnostics": diagnostics},
            evidence=result.evidence,
            error=result.error,
            model_output=result.model_output,
        )

    def _write_diagnostic_paths(
        self,
        *,
        call: ToolCall,
        result_payload: dict[str, object],
    ) -> tuple[str, ...]:
        if result_payload.get("status") == "unchanged":
            return ()
        raw_path = (
            result_payload.get("path")
            or call.arguments.get("file_path")
            or call.arguments.get("path")
        )
        if not isinstance(raw_path, str) or not raw_path:
            return ()
        return (raw_path,)

    def _run_write_diagnostics(self, paths: tuple[str, ...]) -> dict[str, object]:
        assert self.runner is not None
        try:
            payload = self.runner(paths)
        except Exception as exc:
            return {
                "diagnostics": [],
                "count": 0,
                "truncated": False,
                "error": str(exc),
            }
        return self._normalize_write_diagnostics(payload)

    def _normalize_write_diagnostics(
        self,
        payload: dict[str, object],
    ) -> dict[str, object]:
        raw_diagnostics = payload.get("diagnostics")
        diagnostics = raw_diagnostics if isinstance(raw_diagnostics, list) else []
        count = payload.get("count")
        normalized_count = count if isinstance(count, int) else len(diagnostics)
        truncated = bool(payload.get("truncated")) or len(diagnostics) > MAX_WRITE_DIAGNOSTICS
        normalized: dict[str, object] = {
            "diagnostics": diagnostics[:MAX_WRITE_DIAGNOSTICS],
            "count": normalized_count,
            "truncated": truncated,
        }
        error = payload.get("error")
        if isinstance(error, str) and error:
            normalized["error"] = error
        return normalized
