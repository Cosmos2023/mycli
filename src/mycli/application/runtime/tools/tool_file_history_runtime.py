from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.exposure import ToolExposure
from mycli.services.file_history import FileHistoryService
from mycli.tools.base import ToolResult
from mycli.tools.routing.tool_router import ToolRouter

FILE_MUTATION_TOOLS = frozenset(
    {
        "Edit",
        "Patch",
        "Write",
        "edit_file",
        "patch_file",
        "write_file",
    }
)


@dataclass(slots=True)
class ToolFileHistoryRuntime:
    """Coordinates before/after file snapshots for mutating tool calls."""

    session_id: str
    file_history: FileHistoryService | None = None

    def set_session_id(self, session_id: str) -> None:
        self.session_id = session_id

    def snapshot_before_file_mutation(
        self,
        *,
        call: ToolCall,
        tool_router: ToolRouter,
        tool_exposure: ToolExposure,
        turn_id: str,
        turn_metadata: dict[str, object],
    ) -> list[str]:
        if self.file_history is None:
            return []
        try:
            paths = tool_router.mutation_targets(call, exposure=tool_exposure)
        except ValueError:
            return []
        if paths is None:
            paths = self._legacy_mutation_paths(call)
        if not paths:
            return []
        snapshot_ids: list[str] = []
        errors: list[str] = []
        for path in paths:
            snapshot = self.file_history.snapshot_path(
                session_id=self.session_id,
                turn_id=turn_id,
                raw_path=path,
                tool_name=call.name,
            )
            if snapshot.error:
                errors.append(snapshot.error)
                continue
            if not snapshot.retained or not snapshot.snapshot_id:
                continue
            snapshot_ids.append(snapshot.snapshot_id)
        if snapshot_ids:
            turn_metadata["file_history_snapshot_ids"] = snapshot_ids
        if errors:
            turn_metadata["file_history_errors"] = errors
        return snapshot_ids

    def finalize_file_history_snapshots(
        self,
        *,
        snapshot_ids: list[str],
        result: ToolResult,
        turn_metadata: dict[str, object],
    ) -> None:
        if self.file_history is None or not snapshot_ids:
            return
        if not result.success:
            for snapshot_id in snapshot_ids:
                self.file_history.discard_snapshot(
                    session_id=self.session_id,
                    snapshot_id=snapshot_id,
                )
            turn_metadata.pop("file_history_snapshot_ids", None)
            return
        retained_snapshot_ids: list[str] = []
        errors: list[str] = []
        for snapshot_id in snapshot_ids:
            finalized = self.file_history.finalize_snapshot(
                session_id=self.session_id,
                snapshot_id=snapshot_id,
            )
            if finalized.error:
                errors.append(finalized.error)
                continue
            if finalized.retained:
                retained_snapshot_ids.append(snapshot_id)
        if retained_snapshot_ids:
            turn_metadata["file_history_snapshot_ids"] = retained_snapshot_ids
        else:
            turn_metadata.pop("file_history_snapshot_ids", None)
        if errors:
            turn_metadata["file_history_errors"] = errors

    def _legacy_mutation_paths(self, call: ToolCall) -> tuple[str, ...]:
        if call.name not in FILE_MUTATION_TOOLS:
            return ()
        value = call.arguments.get("file_path") or call.arguments.get("path")
        if isinstance(value, str) and value:
            return (value,)
        return ()
